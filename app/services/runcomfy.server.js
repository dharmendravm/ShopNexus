/**
 * =============================================================================
 * FILE: app/services/runcomfy.server.js
 * ROLE: Production RunComfy Serverless Provider Integration
 * =============================================================================
 *
 * Yeh file kya karti hai? (Overview):
 *   1. `submitTryOnJob`: RunComfy inference API ko async request bhejti hai (< 500ms return).
 *   2. `getTryOnJobStatus`: Fallback status check service (agar webhook delay ho jaye).
 *   3. `extractImageUriFromRunComfy`: Output JSON payload se generated CDN image URL extract karti hai.
 *   4. `resolveOutputImageUrl`: Multi-MB Base64 avoid karke direct CDN URL return karti hai.
 * =============================================================================
 */

/**
 * Environment configuration loader.
 * `.env` file se RunComfy API Key, Deployment ID, Node IDs aur Webhook Secret load karta hai.
 */
function getConfig() {
  return {
    apiKey: (process.env.RUNCOMFY_API_KEY || "").trim(),
    deploymentId: (process.env.RUNCOMFY_DEPLOYMENT_ID || "").trim(),
    personNodeId: (process.env.RUNCOMFY_PERSON_NODE_ID || "74").trim(),
    garmentNodeId: (process.env.RUNCOMFY_GARMENT_NODE_ID || "73").trim(),
    categoryNodeId: (process.env.RUNCOMFY_CATEGORY_NODE_ID || "79").trim(),
    webhookUrl: (process.env.RUNCOMFY_WEBHOOK_URL || "").trim(),
    webhookSecret: (process.env.RUNCOMFY_WEBHOOK_SECRET || "shop_nexus_vto_sec_key_2026").trim(),
    baseUrl: (process.env.RUNCOMFY_BASE_URL || "https://api.runcomfy.net").trim().replace(/\/$/, ""),
    timeoutMs: Number(process.env.RUNCOMFY_TIMEOUT_MS || 90_000),
  };
}

const POLL_INTERVAL_MS = 2000;

/**
 * Async Try-On Job Submitter (< 500ms response time).
 *
 * Yeh function RunComfy Cloud GPU ko image inputs (Person Node 74, Garment Node 73, Category Node 79)
 * + Webhook Callback URL ke saath queue request bhejta hai aur instant `{ requestId }` return karta hai.
 *
 * @param {Object} params
 * @param {string} params.userImageUrl - Customer uploaded photo (Data URI ya HTTPS URL)
 * @param {string} params.productImageUrl - Garment photo (Shopify CDN HTTPS URL)
 * @param {'tops'|'bottoms'|'one-pieces'} [params.category='tops'] - Clothes category
 * @param {string} [params.customWebhookUrl] - App ka public webhook URL override
 * @returns {Promise<{ success: boolean, requestId?: string, error?: string }>}
 */
export async function submitTryOnJob({
  userImageUrl,
  productImageUrl,
  category = "tops",
  customWebhookUrl = "",
}) {
  const config = getConfig();

  if (!userImageUrl) {
    return { success: false, error: "Please upload a photo of yourself." };
  }
  if (!productImageUrl) {
    return { success: false, error: "Product image is required for virtual try-on." };
  }
  if (!config.apiKey) {
    console.error("[RunComfy] RUNCOMFY_API_KEY is not configured in .env");
    return { success: false, error: "RunComfy API key is missing. Please configure RUNCOMFY_API_KEY in .env." };
  }
  if (!config.deploymentId) {
    console.error("[RunComfy] RUNCOMFY_DEPLOYMENT_ID is not configured in .env");
    return { success: false, error: "RunComfy Deployment ID is missing. Please configure RUNCOMFY_DEPLOYMENT_ID in .env." };
  }

  // Webhook URL ke aage secret key parameter attach karo (e.g. ?webhook=1&secret=xxxx)
  let activeWebhook = customWebhookUrl || config.webhookUrl;
  if (activeWebhook && config.webhookSecret && !activeWebhook.includes("secret=")) {
    const joinChar = activeWebhook.includes("?") ? "&" : "?";
    activeWebhook = `${activeWebhook}${joinChar}secret=${encodeURIComponent(config.webhookSecret)}`;
  }

  const inferenceUrl = `${config.baseUrl}/prod/v2/deployments/${config.deploymentId}/inference`;

  // Dynamic ComfyUI Node Overrides (Node 74 = Person, Node 73 = Garment, Node 79 = Category)
  const overrides = {
    [config.personNodeId]: {
      inputs: {
        image: userImageUrl,
      },
    },
    [config.garmentNodeId]: {
      inputs: {
        image: productImageUrl,
      },
    },
  };

  if (config.categoryNodeId) {
    overrides[config.categoryNodeId] = {
      inputs: {
        category: category || "tops",
      },
    };
  }

  const requestBody = { overrides };
  if (activeWebhook) {
    requestBody.webhook_url = activeWebhook;
  }

  console.log(`[RunComfy] Submitting async job for deployment=${config.deploymentId} category=${category} nodes=${config.personNodeId},${config.garmentNodeId},${config.categoryNodeId}`);

  try {
    const submitResponse = await fetch(inferenceUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const submitText = await submitResponse.text();
    let submitData = {};
    try {
      submitData = JSON.parse(submitText);
    } catch {
      console.error(`[RunComfy] Invalid submit response HTTP ${submitResponse.status}: ${submitText.slice(0, 200)}`);
      return { success: false, error: "RunComfy API returned an invalid response." };
    }

    if (!submitResponse.ok) {
      console.error(`[RunComfy] Submit rejected HTTP ${submitResponse.status}:`, submitData);
      return {
        success: false,
        error: submitData.message || submitData.error || "RunComfy rejected the try-on inference request.",
      };
    }

    console.log(`[RunComfy] Job successfully queued: request_id=${submitData.request_id}`);
    return {
      success: true,
      requestId: submitData.request_id,
    };
  } catch (error) {
    console.error("[RunComfy] Submit exception:", error);
    return {
      success: false,
      error: "Failed to communicate with RunComfy serverless API.",
    };
  }
}

/**
 * Fallback Status Check Service (RunComfy Remote API Query).
 *
 * Agar Webhook aane mein latency ho to yeh service direct RunComfy Cloud endpoints:
 *   - `/status` (queue status check)
 *   - `/result` (generation output retrieve)
 * ko query karke instant image URL / error parse karti hai.
 *
 * @param {string} requestId - Unique RunComfy Request ID
 * @returns {Promise<{ success: boolean, status: 'processing'|'completed'|'failed', imageUri?: string, tryOnImage?: string, error?: string }>}
 */
export async function getTryOnJobStatus(requestId) {
  if (!requestId) {
    return { success: false, status: "failed", error: "Missing requestId" };
  }

  const config = getConfig();
  const statusUrl = `${config.baseUrl}/prod/v2/deployments/${config.deploymentId}/requests/${requestId}/status`;
  const resultUrl = `${config.baseUrl}/prod/v2/deployments/${config.deploymentId}/requests/${requestId}/result`;

  try {
    const headers = { Authorization: `Bearer ${config.apiKey}` };

    let statusRes = await fetch(statusUrl, { headers });
    let statusData = {};

    if (statusRes.ok) {
      statusData = await statusRes.json().catch(() => ({}));
      const rawStatus = String(statusData.status || statusData.state || "").toUpperCase();
      console.log(`[RunComfy] Polled job ${requestId}: status=${rawStatus}`);

      if (rawStatus === "IN_QUEUE" || rawStatus === "IN_PROGRESS" || rawStatus === "RUNNING") {
        return { success: true, status: "processing" };
      }
    }

    const resultRes = await fetch(resultUrl, { headers });
    if (!resultRes.ok) {
      if (resultRes.status === 404 && !statusRes.ok) {
        return { success: false, status: "failed", error: "RunComfy job request not found or expired." };
      }
      return { success: true, status: "processing" };
    }

    const resultData = await resultRes.json().catch(() => ({}));
    const rawResultStatus = String(resultData.status || statusData.status || "").toUpperCase();

    if (rawResultStatus === "COMPLETED" || rawResultStatus === "SUCCEEDED" || rawResultStatus === "SUCCESS") {
      const rawImageUri = extractImageUriFromRunComfy(resultData, config.baseUrl);
      if (!rawImageUri) {
        return { success: false, status: "failed", error: "Output image not found in generation result." };
      }

      console.log(`[RunComfy] Job ${requestId} SUCCEEDED! Result URL: ${rawImageUri.slice(0, 100)}`);
      
      // Direct CDN URL return karo (Base64 conversion skip karke memory save karo)
      const imageUri = await resolveOutputImageUrl(rawImageUri, config.apiKey);

      return {
        success: true,
        status: "completed",
        imageUri,
        tryOnImage: imageUri,
        provider: "runcomfy-vton-1.5",
      };
    }

    if (rawResultStatus === "FAILED" || rawResultStatus === "CANCELLED" || rawResultStatus === "ERROR") {
      let errorDetail = "Virtual try-on workflow failed.";
      if (Array.isArray(resultData.error) && resultData.error.length > 0) {
        errorDetail = resultData.error[0].details || resultData.error[0].error || errorDetail;
      } else if (resultData.error) {
        errorDetail = typeof resultData.error === "string" ? resultData.error : JSON.stringify(resultData.error);
      }
      console.error(`[RunComfy] Job ${requestId} failed:`, errorDetail);
      return { success: false, status: "failed", error: errorDetail };
    }

    return { success: true, status: "processing" };
  } catch (err) {
    console.error("[RunComfy] Check status exception:", err);
    return { success: true, status: "processing" };
  }
}

/**
 * Legacy Synchronous Helper (Development / CLI testing ke liye).
 * Internal loop chala kar job finish hone tak wait karta hai.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function generateTryOn(params) {
  const submitRes = await submitTryOnJob(params);
  if (!submitRes.success || !submitRes.requestId) {
    return { success: false, error: submitRes.error || "Failed to start try-on job." };
  }

  const config = getConfig();
  const startTime = Date.now();
  while (Date.now() - startTime < config.timeoutMs) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    const statusRes = await getTryOnJobStatus(submitRes.requestId);

    if (statusRes.status === "completed") {
      return {
        success: true,
        imageUri: statusRes.imageUri,
        tryOnImage: statusRes.imageUri,
        provider: "runcomfy-vton-1.5",
      };
    }

    if (statusRes.status === "failed") {
      return {
        success: false,
        error: statusRes.error || "Virtual try-on generation failed.",
      };
    }
  }

  return {
    success: false,
    error: `RunComfy try-on request timed out after ${Math.round(config.timeoutMs / 1000)}s.`,
  };
}

/**
 * Image URL Resolver.
 * Agar HTTPS CDN URL hai (S3 / Cloudflare / R2) to as-is fast return karta hai.
 * Agar authentication waali local /view URL ho tabhi token lagakar stream / fetch karta hai.
 *
 * @param {string} imageUrl
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function resolveOutputImageUrl(imageUrl, apiKey) {
  if (!imageUrl || typeof imageUrl !== "string") return imageUrl;
  if (imageUrl.startsWith("data:image/")) return imageUrl;

  // Direct public CDN URL check (Zero server overhead)
  if (
    !imageUrl.includes("/view?") &&
    !imageUrl.includes("api.runcomfy.net")
  ) {
    return imageUrl;
  }

  // Internal view URL requiring bearer token
  try {
    const headers = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(imageUrl, { headers });
    if (!response.ok) {
      return imageUrl;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || "image/png";

    const base64Data = buffer.toString("base64");
    return `data:${contentType};base64,${base64Data}`;
  } catch (error) {
    console.warn("[RunComfy Image Resolve] Exception:", error);
    return imageUrl;
  }
}

/**
 * Universal RunComfy Output Image Parser.
 *
 * RunComfy multiple formats mein JSON response bhejta hai:
 *   1. Direct properties: `image_url`, `url`, `output_url`, `result_url`
 *   2. Array outputs: `outputs: ["https://..."]` ya `outputs: [{ url: "..." }]`
 *   3. Node map outputs: `outputs: { "9": { images: [{ filename: "...", subfolder: "..." }] }, "76": { images: [{ url: "https://..." }] } }`
 *
 * Pass 1: Direct HTTP/HTTPS CDN URL waale image nodes ko preference deta hai.
 * Pass 2: Fallback to /view filename url.
 *
 * @param {Object} data - RunComfy Result / Webhook Payload JSON
 * @param {string} [baseUrl='https://api.runcomfy.net'] - Base API Host
 * @returns {string|null} Output Image URL ya null
 */
export function extractImageUriFromRunComfy(data, baseUrl = "https://api.runcomfy.net") {
  if (!data || typeof data !== "object") return null;

  // Direct String fields check
  if (typeof data.image_url === "string" && data.image_url.trim()) return data.image_url.trim();
  if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  if (typeof data.output_url === "string" && data.output_url.trim()) return data.output_url.trim();
  if (typeof data.result_url === "string" && data.result_url.trim()) return data.result_url.trim();

  const outputs = data.outputs || data.output || data.results || data.result;

  // Array Output Format check
  if (Array.isArray(outputs)) {
    for (const item of outputs) {
      if (typeof item === "string" && item.trim()) return item.trim();
      if (item && typeof item === "object") {
        if (typeof item.url === "string" && item.url.trim()) return item.url.trim();
        if (typeof item.image_url === "string" && item.image_url.trim()) return item.image_url.trim();
      }
    }
  }

  // Object / Node Map Format check (ComfyUI Workflow Nodes)
  if (typeof outputs === "object" && outputs !== null) {
    // Pass 1: Prioritize image node that contains direct public HTTP/HTTPS CDN URL
    for (const nodeId of Object.keys(outputs)) {
      const nodeObj = outputs[nodeId];
      if (nodeObj && Array.isArray(nodeObj.images)) {
        for (const img of nodeObj.images) {
          if (img && typeof img.url === "string" && img.url.startsWith("http")) {
            return img.url.trim();
          }
          if (img && typeof img.image_url === "string" && img.image_url.startsWith("http")) {
            return img.image_url.trim();
          }
        }
      }
    }

    // Pass 2: Fallback to view URL if no direct URL found
    for (const nodeId of Object.keys(outputs)) {
      const nodeObj = outputs[nodeId];
      if (nodeObj && Array.isArray(nodeObj.images)) {
        for (const img of nodeObj.images) {
          if (typeof img === "string") return img.trim();
          if (img && typeof img.filename === "string" && typeof img.subfolder === "string") {
            return `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}`;
          }
        }
      }
    }
  }

  return null;
}



