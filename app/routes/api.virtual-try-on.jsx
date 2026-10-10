/**
 * =============================================================================
 * FILE: app/routes/api.virtual-try-on.jsx
 * ROLE: Virtual Try-On Backend API Endpoint (App Proxy + Webhooks + Status Checks)
 * =============================================================================
 *
 * Yeh file kya karti hai? (Overview):
 *   1. Storefront Widget se user ki photo + garment image accept karti hai.
 *   2. App Proxy HMAC Signature verify karti hai (Security guard).
 *   3. SHA-256 Idempotency Check chala kar duplicate GPU jobs + billing double charge rokti hai.
 *   4. RunComfy serverless queue mein async job submit karti hai (< 500ms return).
 *   5. Webhook callbacks (`?webhook=1&secret=...`) receive karke result DB mein save karti hai.
 *   6. Status Polling (`checkStatus: true`) direct PostgreSQL DB se ~2ms mein answer karti hai.
 * =============================================================================
 */

import crypto from "crypto";
import shopify from "../shopify.server";
import prisma from "../db.server";
import { generateTryOn as generateFashnTryOn } from "../services/fashn.server";
import {
  submitTryOnJob as submitRunComfyJob,
  getTryOnJobStatus as getRunComfyJobStatus,
  extractImageUriFromRunComfy,
} from "../services/runcomfy.server";
import {
  checkVirtualTryOnRateLimit,
  getRequestClientIp,
  normalizeGarmentCategory,
  toPublicErrorMessage,
  validateGarmentImageUrl,
  validatePersonImagePayload,
} from "../services/virtualTryOn.guards.server";

/**
 * Standard JSON Response Creator Helper.
 * Private try-on data ke liye Cache-Control: no-store standard apply karta hai.
 *
 * @param {object} data - Client ko bhejne wala JSON data
 * @param {{ status?: number, headers?: Record<string, string> }} [options]
 * @returns {Response} Fetch API Response Object
 */
function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/**
 * GET loader handler — Health Check & GET Status Lookup by requestId.
 *
 * Client jab `GET /apps/virtual-try-on?requestId=xxx` bhejta hai:
 *   Step 1: DB se check karta hai (~2ms).
 *   Step 2: Completed / Failed ho to instant result deta hai.
 *   Step 3: Pending/Processing agar < 12s purana ho to RunComfy API hit nahi karta (Rate Limit & Cost save).
 *
 * @param {{ request: Request }} args
 * @returns {Promise<Response>}
 */
export async function loader({ request }) {
  const url = new URL(request.url);
  const requestId = url.searchParams.get("requestId");

  // Agar request mein requestId query parameter hai → status look-up run karo
  if (requestId) {
    try {
      // -----------------------------------------------------------------------
      // STEP 1: PostgreSQL DB Fast Cache Lookup (~2ms)
      // -----------------------------------------------------------------------
      const cachedJob = await prisma.virtualTryOn.findUnique({
        where: { requestId },
      });

      if (cachedJob) {
        if (cachedJob.status === "COMPLETED" && cachedJob.generatedImageUrl) {
          return jsonResponse({
            success: true,
            status: "completed",
            tryOnImage: cachedJob.generatedImageUrl,
            provider: "runcomfy-vton-1.5",
          });
        }
        if (cachedJob.status === "FAILED") {
          return jsonResponse({
            success: false,
            status: "failed",
            error: cachedJob.error || "Try-on generation failed.",
          });
        }

        // Job abhi processing mein hai. Agar 12 sec se kam purana hai, to RunComfy hit mat karo
        const ageMs = Date.now() - new Date(cachedJob.createdAt).getTime();
        if (ageMs < 12_000) {
          return jsonResponse({
            success: true,
            status: "processing",
            requestId,
          });
        }
      }

      // -----------------------------------------------------------------------
      // STEP 2: Fallback — RunComfy API poll agar DB mein record na ho ya 12s+ purana ho
      // -----------------------------------------------------------------------
      const jobStatus = await getRunComfyJobStatus(requestId);
      if (jobStatus.status === "completed" && jobStatus.tryOnImage) {
        await prisma.virtualTryOn.updateMany({
          where: { requestId },
          data: {
            status: "COMPLETED",
            generatedImageUrl: jobStatus.tryOnImage,
            updatedAt: new Date(),
          },
        });
      } else if (jobStatus.status === "failed") {
        await prisma.virtualTryOn.updateMany({
          where: { requestId },
          data: {
            status: "FAILED",
            error: jobStatus.error || "Try-on workflow failed.",
            updatedAt: new Date(),
          },
        });
      }

      return jsonResponse(jobStatus);
    } catch (err) {
      console.error("[VirtualTryOn Loader] Status lookup exception:", err);
      return jsonResponse({ success: true, status: "processing", requestId });
    }
  }

  // Normal GET ping par App Proxy authentication check karo
  try {
    await shopify.authenticate.public.appProxy(request);
  } catch {
    return jsonResponse({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  return jsonResponse({
    success: true,
    message: "Virtual Try-On API is active.",
  });
}

/**
 * POST action handler — Main try-on submission, polling check, aur secure webhook processing.
 *
 * Flow Summary:
 *   1. Webhook Request Detection (`?webhook=1`): Webhook Secret verify -> DB update.
 *   2. App Proxy HMAC Verification: Direct non-Shopify hits ko 401 Block karo.
 *   3. DB Status Polling (`checkStatus: true`): Bypass rate limiter, query DB first.
 *   4. Rate Limit Guard: 8 requests/min per IP/Shop.
 *   5. Input Validation: Base64 image size + Garment URL security checks.
 *   6. SHA-256 Idempotency Guard: 60s window duplicate request return.
 *   7. RunComfy Async Job Submit: Return `{ requestId }` in < 500ms.
 *
 * @param {{ request: Request }} args
 * @returns {Promise<Response>}
 */
export async function action({ request }) {
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Method not allowed" },
      { status: 405 },
    );
  }

  const url = new URL(request.url);
  const isWebhook = url.searchParams.get("webhook") === "1" || url.pathname.endsWith("/webhook");

  // =========================================================================
  // HANDLER A: SECURE RUNCOMFY WEBHOOK CALLBACK
  // =========================================================================
  if (isWebhook) {
    try {
      const expectedSecret = (process.env.RUNCOMFY_WEBHOOK_SECRET || "shop_nexus_vto_sec_key_2026").trim();
      const providedSecret = (
        url.searchParams.get("secret") ||
        request.headers.get("x-webhook-secret") ||
        ""
      ).trim();

      // Webhook Secret Security Check — Block unauthorized external callers
      if (expectedSecret && providedSecret !== expectedSecret) {
        console.warn("[VirtualTryOn Webhook] Rejected unauthorized webhook call - secret mismatch");
        return jsonResponse({ success: false, error: "Unauthorized webhook caller" }, { status: 401 });
      }

      const webhookPayload = await request.json().catch(() => ({}));
      console.log("[VirtualTryOn Webhook] Received authenticated webhook payload:", JSON.stringify(webhookPayload).slice(0, 300));

      const webhookRequestId = webhookPayload.request_id || webhookPayload.requestId || webhookPayload.id;
      if (webhookRequestId) {
        const rawStatus = String(webhookPayload.status || webhookPayload.state || "").toUpperCase();
        const isFailed = rawStatus === "FAILED" || rawStatus === "ERROR" || rawStatus === "CANCELLED";

        // Multi-nested output parser (handles arrays, nodes, output_url, result_url)
        const outputImageUrl = extractImageUriFromRunComfy(webhookPayload);

        if (isFailed) {
          await prisma.virtualTryOn.updateMany({
            where: { requestId: webhookRequestId },
            data: {
              status: "FAILED",
              error: webhookPayload.error || "Generation failed via webhook update.",
              updatedAt: new Date(),
            },
          });
        } else if (outputImageUrl) {
          await prisma.virtualTryOn.updateMany({
            where: { requestId: webhookRequestId },
            data: {
              status: "COMPLETED",
              generatedImageUrl: outputImageUrl,
              updatedAt: new Date(),
            },
          });
          console.log(`[VirtualTryOn Webhook] Successfully updated job ${webhookRequestId} status to COMPLETED`);
        }
      }

      return jsonResponse({ received: true });
    } catch (whErr) {
      console.error("[VirtualTryOn Webhook] Error processing webhook:", whErr);
      return jsonResponse({ received: false, error: whErr.message }, { status: 400 });
    }
  }

  // =========================================================================
  // STEP 1: App Proxy HMAC Verification (Shopify Storefront Only)
  // =========================================================================
  let proxyContext;
  try {
    proxyContext = await shopify.authenticate.public.appProxy(request);
  } catch {
    return jsonResponse(
      {
        success: false,
        error: "Unauthorized. Requests must come through the Shopify App Proxy.",
      },
      { status: 401 },
    );
  }

  const shopDomain =
    proxyContext?.session?.shop ||
    url.searchParams.get("shop") ||
    "";
  const clientIp = getRequestClientIp(request);
  const rateLimitKey = `${shopDomain || "unknown-shop"}:${clientIp}`;

  try {
    // =========================================================================
    // STEP 2: Request Body Parsing
    // =========================================================================
    const contentType = request.headers.get("content-type") || "";
    let body;

    if (contentType.includes("application/json")) {
      body = await request.json();
    } else if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const formData = await request.formData();
      body = {
        checkStatus: formData.get("checkStatus"),
        requestId: formData.get("requestId"),
        personImage: formData.get("personImage"),
        garmentImageUrl: formData.get("garmentImageUrl"),
        productId: formData.get("productId"),
        variantId: formData.get("variantId"),
        category: formData.get("category"),
      };
    } else {
      return jsonResponse(
        {
          success: false,
          error: "Unsupported Content-Type. Please use application/json.",
        },
        { status: 400 },
      );
    }

    // =========================================================================
    // HANDLER B: DB-FIRST STATUS POLLING CHECK (Rate limit bypassed)
    // =========================================================================
    if (body?.checkStatus && body?.requestId) {
      const reqId = String(body.requestId).trim();

      // Fast DB query (~2ms)
      const dbJob = await prisma.virtualTryOn.findUnique({
        where: { requestId: reqId },
      });

      if (dbJob) {
        if (dbJob.status === "COMPLETED" && dbJob.generatedImageUrl) {
          return jsonResponse({
            success: true,
            status: "completed",
            tryOnImage: dbJob.generatedImageUrl,
            provider: "runcomfy-vton-1.5",
          });
        }
        if (dbJob.status === "FAILED") {
          return jsonResponse({
            success: false,
            status: "failed",
            error: dbJob.error || "Virtual Try-On generation failed.",
          });
        }

        // Job processing state mein hai. Agar 12s se chhota hai, return processing without hitting RunComfy
        const ageMs = Date.now() - new Date(dbJob.createdAt).getTime();
        if (ageMs < 12_000) {
          return jsonResponse({
            success: true,
            status: "processing",
            requestId: reqId,
          });
        }
      }

      // Fallback: poll RunComfy API if DB miss or 12s+ old
      const jobStatus = await getRunComfyJobStatus(reqId);
      if (jobStatus.status === "completed" && jobStatus.tryOnImage) {
        await prisma.virtualTryOn.updateMany({
          where: { requestId: reqId },
          data: {
            status: "COMPLETED",
            generatedImageUrl: jobStatus.tryOnImage,
            updatedAt: new Date(),
          },
        });
      } else if (jobStatus.status === "failed") {
        await prisma.virtualTryOn.updateMany({
          where: { requestId: reqId },
          data: {
            status: "FAILED",
            error: jobStatus.error || "Try-on workflow failed.",
            updatedAt: new Date(),
          },
        });
      }

      return jsonResponse(jobStatus);
    }

    // =========================================================================
    // STEP 3: Rate Limiting (Only for NEW Try-On Requests)
    // =========================================================================
    const rateLimit = checkVirtualTryOnRateLimit(rateLimitKey);
    if (!rateLimit.allowed) {
      return jsonResponse(
        {
          success: false,
          error: "Too many try-on requests. Please wait a minute and try again.",
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds || 60),
          },
        },
      );
    }

    const {
      personImage,
      garmentImageUrl,
      productId,
      variantId,
      category,
    } = body || {};

    // =========================================================================
    // STEP 4: Input Validation (Base64 + Garment HTTPS CDN check)
    // =========================================================================
    const personValidation = validatePersonImagePayload(personImage);
    if (!personValidation.ok) {
      return jsonResponse(
        { success: false, error: personValidation.error },
        { status: 400 },
      );
    }

    const garmentValidation = validateGarmentImageUrl(garmentImageUrl, shopDomain);
    if (!garmentValidation.ok) {
      return jsonResponse(
        { success: false, error: garmentValidation.error },
        { status: 400 },
      );
    }

    const garmentCategory = normalizeGarmentCategory(category);

    // =========================================================================
    // STEP 5: SHA-256 Idempotency Guard (Prevents double billing / duplicate jobs)
    // =========================================================================
    const personImageHash = crypto
      .createHash("sha256")
      .update(`${personValidation.base64}|${garmentValidation.url}`)
      .digest("hex");

    const existingJob = await prisma.virtualTryOn.findFirst({
      where: {
        shop: shopDomain,
        personImageHash,
        garmentImageUrl: garmentValidation.url,
        createdAt: { gte: new Date(Date.now() - 60_000) }, // 60 seconds TTL window
      },
      orderBy: { createdAt: "desc" },
    });

    if (existingJob) {
      console.log(`[VirtualTryOn API] Idempotency hit: existing job id=${existingJob.id} status=${existingJob.status}`);
      if (existingJob.status === "COMPLETED" && existingJob.generatedImageUrl) {
        return jsonResponse({
          success: true,
          status: "completed",
          tryOnImage: existingJob.generatedImageUrl,
          provider: "runcomfy-vton-1.5",
          cached: true,
        });
      }
      if (existingJob.status === "PROCESSING" || existingJob.status === "PENDING") {
        return jsonResponse({
          success: true,
          status: "processing",
          requestId: existingJob.requestId,
          cached: true,
        });
      }
    }

    console.log(
      `[VirtualTryOn API] New Job: shop=${shopDomain} product=${productId || "n/a"} variant=${variantId || "n/a"} category=${garmentCategory} personBytes≈${personValidation.estimatedBytes}`,
    );

    const personImageDataUri = `data:${personValidation.mime};base64,${personValidation.base64}`;
    const activeProviderName = (process.env.VTO_PROVIDER || "fashn").toLowerCase();

    // =========================================================================
    // STEP 6: Execute RunComfy Serverless Queue Provider
    // =========================================================================
    if (activeProviderName === "runcomfy" || activeProviderName === "comfyui") {
      // 1. Database pending record insert
      const dbJob = await prisma.virtualTryOn.create({
        data: {
          shop: shopDomain,
          productId: productId ? String(productId) : null,
          variantId: variantId ? String(variantId) : null,
          garmentCategory,
          garmentImageUrl: garmentValidation.url,
          personImageHash,
          status: "PENDING",
        },
      });

      // 2. Submit async job to RunComfy (< 500ms)
      const appHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
      const autoWebhookUrl = appHost ? `https://${appHost}/api/virtual-try-on?webhook=1` : undefined;

      const submitResult = await submitRunComfyJob({
        userImageUrl: personImageDataUri,
        productImageUrl: garmentValidation.url,
        category: garmentCategory,
        customWebhookUrl: autoWebhookUrl,
      });

      if (!submitResult.success || !submitResult.requestId) {
        console.error("[VirtualTryOn API] RunComfy submit failed:", submitResult.error);
        await prisma.virtualTryOn.update({
          where: { id: dbJob.id },
          data: { status: "FAILED", error: submitResult.error || "Submission rejected" },
        });

        return jsonResponse(
          {
            success: false,
            error: toPublicErrorMessage(
              { message: submitResult.error },
              "Failed to start try-on generation. Please try again.",
            ),
          },
          { status: 200 },
        );
      }

      // 3. Update DB record with requestId & status: PROCESSING
      await prisma.virtualTryOn.update({
        where: { id: dbJob.id },
        data: {
          requestId: submitResult.requestId,
          status: "PROCESSING",
        },
      });

      // 4. Instant Return to client (< 500ms)
      return jsonResponse({
        success: true,
        status: "processing",
        requestId: submitResult.requestId,
        provider: "runcomfy-vton-1.5",
        productId: productId ? String(productId) : null,
        variantId: variantId ? String(variantId) : null,
      });
    }

    // FASHN Synchronous Fallback
    const result = await generateFashnTryOn({
      userImageUrl: personImageDataUri,
      productImageUrl: garmentValidation.url,
      category: garmentCategory,
    });

    if (!result.success) {
      console.error("[VirtualTryOn API] Provider failed:", result.error);
      return jsonResponse(
        {
          success: false,
          error: toPublicErrorMessage(
            { message: result.error },
            "Failed to generate virtual try-on image. Please try again.",
          ),
        },
        { status: 200 },
      );
    }

    return jsonResponse({
      success: true,
      tryOnImage: result.imageUri,
      provider: result.provider || "fashn-vton-1.5",
      productId: productId ? String(productId) : null,
      variantId: variantId ? String(variantId) : null,
    });
  } catch (error) {
    console.error("[VirtualTryOn API] Unexpected error:", error);
    return jsonResponse(
      {
        success: false,
        error: "Something went wrong while generating your try-on. Please try again.",
      },
      { status: 200 },
    );
  }
}


