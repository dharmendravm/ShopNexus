/**
 * =============================================================================
 * FILE: app/services/fashn.server.js
 * ROLE: FASHN VTON 1.5 GPU provider (external HTTP API wrapper)
 * =============================================================================
 *
 * Yeh file kya karti hai?
 *   Hamara Shopify app server → FASHN / RunComfy-compatible GPU server ko
 *   HTTP POST bhejta hai, response se result image nikaalta hai.
 *
 * Kaun call karta hai?
 *   app/routes/api.virtual-try-on.jsx → `generateTryOn({...})`
 *
 * Provider swap karna ho (production tip):
 *   Is file jaisa naya provider banao (e.g. `otherAi.server.js`) jisme
 *   SAME return shape ho:
 *     { success: true, imageUri, provider }
 *     { success: false, error }
 *   Phir API route mein sirf import badlo — frontend change nahi chahiye.
 *
 * .env variables (production mein zaroor set karo):
 *   FASHN_VM_URL=https://your-gpu-host          (required)
 *   FASHN_API_KEY=your-secret-token             (strongly recommended)
 *   FASHN_TIMEOUT_MS=120000                     (optional, default 2 min)
 *   FASHN_NUM_INFERENCE_STEPS=30                (optional; kam = tez, zyada = quality)
 *
 * Request jo GPU ko jaata hai:
 *   POST {FASHN_VM_URL}/v1/try-on   (agar path pehle se na ho)
 *   Body:
 *     {
 *       model_image: <person dataURI/url>,
 *       garment_image: <product url>,
 *       category: "tops"|"bottoms"|"one-pieces",
 *       num_inference_steps: 30,
 *       num_samples: 1
 *     }
 *
 * Response se image kaise nikalte hain?
 *   Alag vendors alag fields use karte hain — `extractResultImageUri()`
 *   common shapes try karta hai (image_url, images[0], output, ...).
 * =============================================================================
 */

/** @type {string} GPU server base URL ya full inference path (.env se) */
const FASHN_VM_URL = (process.env.FASHN_VM_URL || "").trim();

/** @type {string} Bearer token — production mein empty mat chhodo */
const FASHN_API_KEY = (process.env.FASHN_API_KEY || "").trim();

/** @type {number} Fetch timeout ms — GPU slow ho sakta hai */
const FASHN_TIMEOUT_MS = Number(process.env.FASHN_TIMEOUT_MS || 120_000);

/** @type {number} Default diffusion / inference steps */
const DEFAULT_INFERENCE_STEPS = Number(process.env.FASHN_NUM_INFERENCE_STEPS || 30);

/** Allowed garment categories for this model */
const VALID_CATEGORIES = new Set(["tops", "bottoms", "one-pieces"]);

/**
 * FASHN GPU par virtual try-on chalao aur result image URI return karo.
 *
 * Ye function THROW nahi karti — hamesha `{ success, ... }` object deti hai.
 * Isliye API route ko try/catch provider errors ke liye alag se nahi chahiye
 * (phir bhi route pe outer try/catch unexpected crashes ke liye hai).
 *
 * Andar ka flow:
 *   1. Inputs + env validate
 *   2. Endpoint URL banao (base URL ho to `/v1/try-on` append)
 *   3. AbortController se timeout set
 *   4. POST JSON to GPU
 *   5. Response parse → image field extract
 *   6. Success / safe error return
 *
 * @param {Object} params
 * @param {string} params.userImageUrl
 *   Customer / model photo — HTTPS URL YA data URI (`data:image/...;base64,...`)
 * @param {string} params.productImageUrl
 *   Product garment photo — usually Shopify CDN HTTPS URL
 * @param {'tops'|'bottoms'|'one-pieces'} [params.category='tops']
 *   Kapde ki category — galat category = bekar fit result
 * @param {number} [params.numInferenceSteps]
 *   Zyada steps = better quality, slow; kam = fast demo
 * @param {number} [params.numSamples=1]
 *   Kitni images generate karni hain (1 usually enough)
 * @returns {Promise<{ success: boolean, imageUri?: string, provider?: string, error?: string }>}
 *
 * @example
 *   const result = await generateTryOn({
 *     userImageUrl: "data:image/jpeg;base64,...",
 *     productImageUrl: "https://cdn.shopify.com/...",
 *     category: "tops",
 *   });
 *   if (result.success) console.log(result.imageUri);
 */
export async function generateTryOn({
  userImageUrl,
  productImageUrl,
  category = "tops",
  numInferenceSteps = DEFAULT_INFERENCE_STEPS,
  numSamples = 1,
}) {
  if (!userImageUrl) {
    return { success: false, error: "Please upload a photo of yourself." };
  }
  if (!productImageUrl) {
    return { success: false, error: "Product image is required for virtual try-on." };
  }

  if (!FASHN_VM_URL) {
    console.error("[FASHN] FASHN_VM_URL is not configured");
    return {
      success: false,
      error: "Virtual try-on service is not configured.",
    };
  }

  if (!FASHN_API_KEY) {
    // Production warning: key empty = GPU endpoint open (agar network se reachable ho)
    console.warn(
      "[FASHN] FASHN_API_KEY is empty — GPU endpoint is called without Authorization",
    );
  }

  const normalizedCategory = String(category || "tops").toLowerCase();
  const finalCategory = VALID_CATEGORIES.has(normalizedCategory)
    ? normalizedCategory
    : "tops";

  // Steps/samples ko safe range mein clamp — crazy values GPU hang na kare
  const steps = clampInteger(numInferenceSteps, 1, 50, DEFAULT_INFERENCE_STEPS);
  const samples = clampInteger(numSamples, 1, 4, 1);

  /**
   * Endpoint resolve:
   *   - Agar .env mein pehle se full path hai (/v1/... ya /deployments/...) to use as-is
   *   - Agar sirf host diya (`http://localhost:8000`) to default `/v1/try-on` jodo
   */
  let endpoint = FASHN_VM_URL.replace(/\/$/, "");
  if (
    !endpoint.includes("/v1/") &&
    !endpoint.includes("/deployments/") &&
    !endpoint.includes("/inference")
  ) {
    endpoint = `${endpoint}/v1/try-on`;
  }

  // Timeout: request forever hang na kare (Node process busy na rahe)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FASHN_TIMEOUT_MS);

  try {
    const headers = { "Content-Type": "application/json" };
    if (FASHN_API_KEY) {
      headers.Authorization = `Bearer ${FASHN_API_KEY}`;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model_image: userImageUrl, // person wearing the clothes
        garment_image: productImageUrl, // clothing item photo
        category: finalCategory,
        num_inference_steps: steps,
        num_samples: samples,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      // GPU ne HTML/text bheja — JSON nahi; neeche generic error
      data = {};
    }

    if (!response.ok) {
      // Raw body sirf server logs — client ko mat bhejo (info leak)
      console.error(`[FASHN] GPU status=${response.status} body=${rawText.slice(0, 240)}`);
      return {
        success: false,
        error: "FASHN GPU server rejected the try-on request. Please try again.",
      };
    }

    const resultImage = extractResultImageUri(data);
    if (!resultImage) {
      console.error("[FASHN] Response missing image field:", Object.keys(data || {}));
      return {
        success: false,
        error: "FASHN GPU server response did not include a generated image.",
      };
    }

    return {
      success: true,
      imageUri: resultImage,
      provider: "fashn-vton-1.5",
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error(`[FASHN] Timed out after ${FASHN_TIMEOUT_MS}ms`);
      return {
        success: false,
        error: "FASHN GPU server request timed out. Please try again in a moment.",
      };
    }

    console.error("[FASHN] Provider exception:", error);
    return {
      success: false,
      error: "Virtual try-on failed while contacting the GPU service.",
    };
  } finally {
    // Memory leak / dangling timer avoid
    clearTimeout(timer);
  }
}

/**
 * GPU JSON response se pehli valid image URL / data URI nikaalo.
 *
 * Kyun itne shapes?
 *   Custom VM, RunComfy, alag wrappers — har kisi ka response thoda alag hota hai.
 *   Production mein naya provider aaye to yahan naya field add kar dena.
 *
 * Supported shapes:
 *   - { image_url: "..." }
 *   - { result_url: "..." }
 *   - { image: "..." }
 *   - { images: ["..."] } ya { images: [{ url: "..." }] }
 *   - { output: "..." } ya { output: ["..."] }
 *
 * @param {unknown} data - `JSON.parse` ke baad ka object
 * @returns {string|null} image URI, ya null agar kuch na mile
 */
function extractResultImageUri(data) {
  if (!data || typeof data !== "object") return null;

  const candidates = [
    data.image_url,
    data.result_url,
    data.image,
    Array.isArray(data.images)
      ? typeof data.images[0] === "string"
        ? data.images[0]
        : data.images[0]?.url
      : null,
    Array.isArray(data.output)
      ? typeof data.output[0] === "string"
        ? data.output[0]
        : data.output[0]?.url
      : null,
    typeof data.output === "string" ? data.output : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Number ko min..max range mein rakho.
 * Invalid / NaN aaye to `fallback` use karo.
 *
 * @param {unknown} value - jo number aaya (env / args se)
 * @param {number} min - minimum allowed
 * @param {number} max - maximum allowed
 * @param {number} fallback - agar value invalid ho
 * @returns {number} clamped integer
 *
 * @example
 *   clampInteger(999, 1, 50, 30) // → 50
 *   clampInteger("abc", 1, 50, 30) // → 30
 */
function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
