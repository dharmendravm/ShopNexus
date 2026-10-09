/**
 * =============================================================================
 * FILE: app/routes/api.virtual-try-on.jsx
 * ROLE: Backend API endpoint (React Router server route)
 * =============================================================================
 *
 * Yeh file kya karti hai?
 *   Storefront se aayi try-on request receive karti hai, security checks
 *   chalati hai, FASHN GPU provider ko call karti hai, result image wapas bhejti hai.
 *
 * URL mapping (bahut important — production mein yahi configure karna):
 *   shopify.app.toml → [app_proxy]
 *     prefix  = "apps"
 *     subpath = "virtual-try-on"
 *     url     = "https://YOUR_APP_HOST/api/virtual-try-on"
 *
 *   Matlab:
 *     Customer browser:  POST https://{shop}/apps/virtual-try-on
 *     Shopify forward →  POST https://YOUR_APP_HOST/api/virtual-try-on  ← YE FILE
 *
 * Related files:
 *   - virtualTryOn.guards.server.js  → validation, rate limit, URL allowlist
 *   - fashn.server.js                → GPU HTTP call
 *   - extensions/.../virtual-try-on.js → frontend jo is API ko hit karta hai
 *
 * Request body (JSON) — frontend yahi bhejta hai:
 *   {
 *     personImage:     "data:image/jpeg;base64,...",   // customer photo (required)
 *     garmentImageUrl: "https://cdn.shopify.com/...",  // product image (required)
 *     productId:       "123",                          // optional (logs)
 *     variantId:       "456",                          // optional (echo)
 *     category:        "tops" | "bottoms" | "one-pieces"
 *   }
 *
 * Success response (200):
 *   { success: true, tryOnImage, provider, productId, variantId }
 *
 * Error status codes (yaad rakhna):
 *   401 → App Proxy HMAC fail (direct hit / wrong signature)
 *   400 → bad input (photo/url/content-type)
 *   429 → rate limit (bahut requests)
 *   502 → GPU provider fail
 *   500 → unexpected server exception
 *
 * Security pipeline (ORDER MAT BADALNA):
 *   1. App Proxy HMAC auth
 *   2. Rate limit (shop + IP)
 *   3. Parse body
 *   4. Validate person photo + garment URL
 *   5. Call generateTryOn() (FASHN)
 *   6. Safe JSON response (internal errors leak mat karo)
 *
 * Production checklist:
 *   [ ] App Proxy toml + deploy
 *   [ ] FASHN_VM_URL + FASHN_API_KEY set
 *   [ ] VTO_RATE_LIMIT_* tune (traffic ke hisaab se)
 *   [ ] Multi-instance ho to rate limit Redis pe le jao
 *   [ ] Seedha curl se test mat expect karo — 401 aayega (yeh feature hai)
 * =============================================================================
 */

import shopify from "../shopify.server";
import { generateTryOn } from "../services/fashn.server";
import {
  checkVirtualTryOnRateLimit,
  getRequestClientIp,
  normalizeGarmentCategory,
  toPublicErrorMessage,
  validateGarmentImageUrl,
  validatePersonImagePayload,
} from "../services/virtualTryOn.guards.server";

/**
 * JSON response banane ka chhota helper.
 * Hamesha Content-Type JSON + Cache-Control no-store (try-on private data).
 *
 * @param {object} data - jo object client ko bhejna hai
 * @param {{ status?: number, headers?: Record<string, string> }} [options]
 * @returns {Response} Web Fetch API Response
 *
 * @example
 *   return jsonResponse({ success: true }, { status: 200 });
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
 * GET loader — health / "API alive?" check.
 *
 * React Router mein:
 *   - `loader`  → GET requests
 *   - `action`  → POST/PUT/DELETE etc.
 *
 * App Proxy auth yahan bhi mandatory hai — warna koi bhi status ping kar sakta hai.
 *
 * @param {{ request: Request }} args - Remix/React Router loader args
 * @returns {Promise<Response>}
 */
export async function loader({ request }) {
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
 * POST action — asal Virtual Try-On generation yahi hoti hai.
 *
 * Frontend `virtual-try-on.js` → fetch POST → yahan aata hai (proxy ke through).
 *
 * @param {{ request: Request }} args - Remix/React Router action args
 * @returns {Promise<Response>} JSON success ya error
 */
export async function action({ request }) {
  // Sirf POST allow — kel aur methods block
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Method not allowed" },
      { status: 405 },
    );
  }

  // -------------------------------------------------------------------------
  // STEP 1: App Proxy HMAC verify
  // Shopify request forward karte waqt signature query params add karta hai.
  // Agar koi seedha tumhara app URL hit kare (bina proxy) → throw → 401.
  // Production tip: is catch ko kabhi "ignore and continue" mat banao.
  // -------------------------------------------------------------------------
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

  // Shop domain: rate-limit key + garment URL allowlist dono ke liye chahiye
  const shopDomain =
    proxyContext?.session?.shop ||
    new URL(request.url).searchParams.get("shop") ||
    "";
  const clientIp = getRequestClientIp(request);
  const rateLimitKey = `${shopDomain || "unknown-shop"}:${clientIp}`;

  // -------------------------------------------------------------------------
  // STEP 2: Rate limit
  // GPU call mehngi / slow hoti hai. Ek IP se flood = bill + downtime.
  // 429 + Retry-After header → browser/client thoda wait kare.
  // -------------------------------------------------------------------------
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

  try {
    // -------------------------------------------------------------------------
    // STEP 3: Body parse
    // Normal path: application/json (frontend yahi bhejta hai)
    // Extra: multipart/form-data bhi support (Postman / future forms)
    // -------------------------------------------------------------------------
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

    const {
      personImage,
      garmentImageUrl,
      productId,
      variantId,
      category,
    } = body || {};

    // -------------------------------------------------------------------------
    // STEP 4: Validate inputs (details guards file mein)
    // - personImage: type, size, base64 sanity
    // - garmentImageUrl: HTTPS + Shopify CDN / shop host only (SSRF guard)
    // -------------------------------------------------------------------------
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

    // Logs mein photo base64 MAT likho — sirf size / ids
    console.log(
      `[VirtualTryOn API] shop=${shopDomain} product=${productId || "n/a"} variant=${variantId || "n/a"} category=${garmentCategory} personBytes≈${personValidation.estimatedBytes}`,
    );

    // Clean data URI rebuild — whitespace / odd prefix hata kar safe format
    const personImageDataUri = `data:${personValidation.mime};base64,${personValidation.base64}`;

    // -------------------------------------------------------------------------
    // STEP 5: GPU provider (FASHN)
    // generateTryOn hamesha { success, imageUri?, error? } return karta hai —
    // throw nahi karta (provider andar catch karta hai).
    // -------------------------------------------------------------------------
    const result = await generateTryOn({
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
        { status: 502 },
      );
    }

    // -------------------------------------------------------------------------
    // STEP 6: Success — tryOnImage URL ya data URI frontend <img src> mein lagata hai
    // -------------------------------------------------------------------------
    return jsonResponse({
      success: true,
      tryOnImage: result.imageUri,
      provider: result.provider || "fashn-vton-1.5",
      productId: productId ? String(productId) : null,
      variantId: variantId ? String(variantId) : null,
    });
  } catch (error) {
    // Unexpected crash — client ko kabhi bhi error.message / stack mat bhejo
    console.error("[VirtualTryOn API] Unexpected error:", error);
    return jsonResponse(
      {
        success: false,
        error: "Something went wrong while generating your try-on. Please try again.",
      },
      { status: 500 },
    );
  }
}
