/**
 * =============================================================================
 * FILE: app/services/fashn.server.js
 * ROLE: FASHN VTON provider — local free v1.5 (default) + optional cloud API
 * =============================================================================
 *
 * LOCAL FREE (default — FASHN VTON v1.5 open-source):
 *   POST {FASHN_VM_URL}/v1/try-on
 *   Body: { model_image, garment_image, category, num_inference_steps, num_samples }
 *   Run local server: scripts/fashn-vton-local/server.py
 *
 * CLOUD (paid, optional):
 *   Set FASHN_API_MODE=cloud and FASHN_VM_URL=https://api.fashn.ai
 *   Uses /v1/run + /v1/status/{id} polling
 *
 * .env:
 *   FASHN_VM_URL=http://127.0.0.1:8000
 *   FASHN_API_MODE=sync                 (local) | cloud
 *   FASHN_API_KEY=                      (optional for local; required for cloud)
 *   FASHN_TIMEOUT_MS=300000             (local can be slow on CPU)
 *   FASHN_NUM_INFERENCE_STEPS=30
 * =============================================================================
 */

const FASHN_VM_URL = (process.env.FASHN_VM_URL || "http://127.0.0.1:8000").trim();
const FASHN_API_KEY = (process.env.FASHN_API_KEY || "").trim();
const FASHN_TIMEOUT_MS = Number(process.env.FASHN_TIMEOUT_MS || 300_000);
const FASHN_MODEL_NAME = (process.env.FASHN_MODEL_NAME || "tryon-v1.6").trim();
const FASHN_MODE = (process.env.FASHN_MODE || "balanced").trim();
const DEFAULT_INFERENCE_STEPS = Number(process.env.FASHN_NUM_INFERENCE_STEPS || 30);
const POLL_INTERVAL_MS = Number(process.env.FASHN_POLL_INTERVAL_MS || 2_000);

const VALID_CATEGORIES = new Set(["auto", "tops", "bottoms", "one-pieces"]);

/**
 * @param {Object} params
 * @param {string} params.userImageUrl - person photo (data URI or HTTPS URL)
 * @param {string} params.productImageUrl - garment photo (HTTPS URL)
 * @param {'tops'|'bottoms'|'one-pieces'|'auto'} [params.category='tops']
 * @param {number} [params.numInferenceSteps]
 * @param {number} [params.numSamples=1]
 * @returns {Promise<{ success: boolean, imageUri?: string, provider?: string, error?: string }>}
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

  const baseUrl = FASHN_VM_URL.replace(/\/$/, "");
  const useCloudApi = shouldUseCloudApi(baseUrl);

  if (useCloudApi && !FASHN_API_KEY) {
    console.error("[FASHN] FASHN_API_KEY is required for api.fashn.ai");
    return {
      success: false,
      error: "Virtual try-on is not configured (missing FASHN_API_KEY).",
    };
  }

  const normalizedCategory = String(category || "tops").toLowerCase();
  const finalCategory = VALID_CATEGORIES.has(normalizedCategory)
    ? normalizedCategory
    : "tops";
  const steps = clampInteger(numInferenceSteps, 1, 50, DEFAULT_INFERENCE_STEPS);
  const samples = clampInteger(numSamples, 1, 4, 1);

  console.log(
    `[FASHN] mode=${useCloudApi ? "cloud" : "local-sync"} url=${baseUrl} category=${finalCategory} steps=${steps}`,
  );

  if (useCloudApi) {
    return runCloudTryOn({
      baseUrl,
      userImageUrl,
      productImageUrl,
      category: finalCategory,
      numSamples: samples,
    });
  }

  return runSyncVmTryOn({
    baseUrl,
    userImageUrl,
    productImageUrl,
    category: finalCategory,
    numInferenceSteps: steps,
    numSamples: samples,
  });
}

/**
 * Official FASHN cloud: POST /v1/run then poll /v1/status/{id}.
 */
async function runCloudTryOn({
  baseUrl,
  userImageUrl,
  productImageUrl,
  category,
  numSamples,
}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${FASHN_API_KEY}`,
  };

  const runEndpoint = resolveCloudRunEndpoint(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FASHN_TIMEOUT_MS);

  try {
    const runResponse = await fetch(runEndpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model_name: FASHN_MODEL_NAME,
        inputs: {
          model_image: userImageUrl,
          garment_image: productImageUrl,
          category,
          num_samples: numSamples,
          mode: FASHN_MODE,
          output_format: "jpeg",
          return_base64: true,
        },
      }),
    });

    const runRaw = await runResponse.text();
    let runData = {};
    try {
      runData = JSON.parse(runRaw);
    } catch {
      runData = {};
    }

    if (!runResponse.ok) {
      console.error(
        `[FASHN] /v1/run status=${runResponse.status} body=${runRaw.slice(0, 240)}`,
      );
      return {
        success: false,
        error: "FASHN rejected the try-on request. Check API key and credits.",
      };
    }

    if (runData.error && !runData.id) {
      console.error("[FASHN] /v1/run error:", runData.error, runData.message);
      return {
        success: false,
        error: "FASHN rejected the try-on request. Please try again.",
      };
    }

    const predictionId = runData.id;
    if (!predictionId) {
      const syncImage = extractResultImageUri(runData);
      if (syncImage && !isEchoOfInput(syncImage, userImageUrl, productImageUrl)) {
        return {
          success: true,
          imageUri: syncImage,
          provider: "fashn-cloud",
        };
      }
      console.error("[FASHN] /v1/run missing prediction id:", Object.keys(runData));
      return {
        success: false,
        error: "FASHN did not return a prediction id.",
      };
    }

    const apiRoot = baseUrl.replace(/\/v1\/?$/, "");
    const statusEndpoint = `${apiRoot}/v1/status/${predictionId}`;
    const deadline = Date.now() + FASHN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (controller.signal.aborted) {
        return {
          success: false,
          error: "FASHN request timed out. Please try again in a moment.",
        };
      }

      await sleep(POLL_INTERVAL_MS, controller.signal);

      const statusResponse = await fetch(statusEndpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      const statusRaw = await statusResponse.text();
      let statusData = {};
      try {
        statusData = JSON.parse(statusRaw);
      } catch {
        statusData = {};
      }

      if (!statusResponse.ok) {
        console.error(
          `[FASHN] /v1/status status=${statusResponse.status} body=${statusRaw.slice(0, 240)}`,
        );
        return {
          success: false,
          error: "FASHN status check failed. Please try again.",
        };
      }

      const status = String(statusData.status || "").toLowerCase();

      if (status === "completed") {
        const resultImage = extractResultImageUri(statusData);
        if (!resultImage) {
          console.error("[FASHN] completed but no output:", Object.keys(statusData));
          return {
            success: false,
            error: "FASHN completed without a generated image.",
          };
        }
        if (isEchoOfInput(resultImage, userImageUrl, productImageUrl)) {
          console.error("[FASHN] Provider echoed input image — refusing fake result");
          return {
            success: false,
            error:
              "Virtual try-on returned the original photo instead of a result. Check your local GPU server.",
          };
        }
        return {
          success: true,
          imageUri: resultImage,
          provider: `fashn-${FASHN_MODEL_NAME}`,
        };
      }

      if (status === "failed") {
        const errMsg =
          statusData.error?.message ||
          statusData.error?.name ||
          statusData.message ||
          "generation failed";
        console.error("[FASHN] prediction failed:", errMsg);
        return {
          success: false,
          error: `FASHN try-on failed: ${errMsg}`,
        };
      }

      console.log(`[FASHN] prediction=${predictionId} status=${status || "unknown"}`);
    }

    return {
      success: false,
      error: "FASHN request timed out. Please try again in a moment.",
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error(`[FASHN] Timed out after ${FASHN_TIMEOUT_MS}ms`);
      return {
        success: false,
        error: "FASHN request timed out. Please try again in a moment.",
      };
    }
    console.error("[FASHN] Provider exception:", error);
    return {
      success: false,
      error: "Virtual try-on failed while contacting FASHN.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Local free FASHN VTON v1.5 (or compatible sync GPU): POST /v1/try-on
 */
async function runSyncVmTryOn({
  baseUrl,
  userImageUrl,
  productImageUrl,
  category,
  numInferenceSteps,
  numSamples,
}) {
  let endpoint = baseUrl;
  if (
    !endpoint.includes("/v1/") &&
    !endpoint.includes("/deployments/") &&
    !endpoint.includes("/inference")
  ) {
    endpoint = `${endpoint}/v1/try-on`;
  }

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
        model_image: userImageUrl,
        garment_image: productImageUrl,
        category,
        num_inference_steps: numInferenceSteps,
        num_timesteps: numInferenceSteps,
        num_samples: numSamples,
        garment_photo_type: "auto",
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      data = {};
    }

    if (!response.ok) {
      console.error(`[FASHN] local GPU status=${response.status} body=${rawText.slice(0, 240)}`);
      return {
        success: false,
        error: "FASHN local GPU rejected the try-on request. Is the VTON server running?",
      };
    }

    const resultImage = extractResultImageUri(data);
    if (!resultImage) {
      console.error("[FASHN] Response missing image field:", Object.keys(data || {}));
      return {
        success: false,
        error: "FASHN local GPU response did not include a generated image.",
      };
    }

    if (isEchoOfInput(resultImage, userImageUrl, productImageUrl)) {
      console.error(
        "[FASHN] Local server echoed input image — stop the mock_gpu_server and run scripts/fashn-vton-local/server.py",
      );
      return {
        success: false,
        error:
          "Virtual try-on mock detected (returned your upload unchanged). Start the real local VTON server: scripts/fashn-vton-local/server.py",
      };
    }

    return {
      success: true,
      imageUri: resultImage,
      provider: "fashn-vton-1.5-local",
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error(`[FASHN] Timed out after ${FASHN_TIMEOUT_MS}ms`);
      return {
        success: false,
        error: "FASHN local GPU timed out. Try fewer steps or a CUDA GPU.",
      };
    }
    console.error("[FASHN] Provider exception:", error);
    return {
      success: false,
      error:
        "Virtual try-on could not reach the local GPU. Start scripts/fashn-vton-local/server.py on FASHN_VM_URL.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cloud only when explicitly requested or URL is api.fashn.ai.
 * Localhost / custom hosts default to sync (local free VTON 1.5).
 */
function shouldUseCloudApi(baseUrl) {
  const mode = (process.env.FASHN_API_MODE || "").trim().toLowerCase();
  if (mode === "cloud") return true;
  if (mode === "sync" || mode === "local") return false;
  return /api\.fashn\.ai/i.test(baseUrl);
}

function resolveCloudRunEndpoint(baseUrl) {
  if (/\/v1\/run\/?$/i.test(baseUrl)) return baseUrl;
  if (/\/v1\/?$/i.test(baseUrl)) return `${baseUrl.replace(/\/$/, "")}/run`;
  return `${baseUrl.replace(/\/$/, "")}/v1/run`;
}

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

/** Reject mock servers that echo model_image / garment_image as the "result". */
function isEchoOfInput(resultImage, userImageUrl, productImageUrl) {
  if (!resultImage || typeof resultImage !== "string") return false;
  const result = resultImage.trim();
  if (userImageUrl && result === String(userImageUrl).trim()) return true;
  if (productImageUrl && result === String(productImageUrl).trim()) return true;
  return false;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const id = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
