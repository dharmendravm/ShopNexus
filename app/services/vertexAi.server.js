import { generateGenlookVirtualTryOn, isGenlookConfigured } from "./genlook.server";

/**
 * Free virtual try-on via public IDM-VTON Hugging Face Space & Genlook API.
 */

const SPACE_URL = (
  process.env.HF_TRYON_SPACE_URL || "https://yisol-idm-vton.hf.space"
).replace(/\/$/, "");

const TRYON_TIMEOUT_MS = Number(process.env.HF_TRYON_TIMEOUT_MS || 180000);

function cleanBase64(data) {
  if (!data || typeof data !== "string") return { base64: "", mime: "image/jpeg" };
  const match = data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (match) {
    return { mime: match[1], base64: match[2].replace(/\s/g, "") };
  }
  return { mime: "image/jpeg", base64: data.trim() };
}

function extensionForMime(mime) {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (process.env.HF_TOKEN) {
    headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  }
  return headers;
}

async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) throw new Error("garmentImageUrl is empty");
  let fullUrl = imageUrl.trim();
  if (fullUrl.startsWith("//")) fullUrl = `https:${fullUrl}`;

  const response = await fetch(fullUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch garment image (${response.status} ${response.statusText})`
    );
  }
  const mime = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { mime, base64: buffer.toString("base64") };
}

async function uploadToSpace(base64, mime, filename) {
  const bytes = Buffer.from(base64, "base64");
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: mime }), filename);

  const response = await fetch(`${SPACE_URL}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Image upload failed (${response.status}): ${raw.slice(0, 200)}`);
  }

  const uploaded = JSON.parse(raw);
  const path = Array.isArray(uploaded) ? uploaded[0] : uploaded?.path;
  if (!path) throw new Error("Hugging Face did not return an uploaded file path.");

  return {
    path,
    url: `${SPACE_URL}/file=${path}`,
    orig_name: filename,
    meta: { _type: "gradio.FileData" },
  };
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const dataText = dataLines.join("\n");
  let data = dataText;
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }
  }
  return { event, data };
}

async function waitForTryOn(eventId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRYON_TIMEOUT_MS);

  try {
    const response = await fetch(`${SPACE_URL}/call/tryon/${eventId}`, {
      headers: authHeaders(),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const raw = await response.text();
      throw new Error(`Try-on stream failed (${response.status}): ${raw.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        if (!block.trim()) continue;
        const { event, data } = parseSseBlock(block);
        if (event === "error") {
          const message =
            typeof data === "string" ? data : data?.message || "";
          throw new Error(
            message && message !== "null"
              ? message
              : "The try-on model could not process these photos. Use a clear front-facing photo and a product image of the garment."
          );
        }
        if (event === "complete") return data;
      }
    }

    throw new Error("Try-on finished without an image. The free GPU queue may be full.");
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Try-on timed out. The free Hugging Face GPU queue is busy. Try again in a minute."
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function imageResultToDataUrl(output) {
  const file = Array.isArray(output) ? output[0] : output;
  const url =
    (typeof file === "string" && file) ||
    file?.url ||
    (file?.path ? `${SPACE_URL}/file=${file.path}` : "");

  if (!url) throw new Error("Try-on response did not include an image.");
  if (url.startsWith("data:")) return url;

  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`Could not download try-on image (${response.status}).`);
  }
  const mime = response.headers.get("content-type")?.split(";")[0] || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * @param {Object} params
 * @param {string} params.personImageBase64
 * @param {string} [params.garmentImageBase64]
 * @param {string} [params.garmentImageUrl]
 * @param {string} [params.productId]
 * @param {string} [params.variantId]
 * @returns {Promise<{ success: boolean, imageUri?: string, provider?: string, error?: string }>}
 */
export async function generateVirtualTryOn({
  personImageBase64,
  garmentImageBase64,
  garmentImageUrl,
  productId,
  variantId,
}) {
  console.log("[TryOn] Running Virtual Try-On exclusively via Genlook API...");
  return await generateGenlookVirtualTryOn({
    personImageBase64,
    garmentImageUrl,
    garmentImageBase64,
    productId,
    variantId,
  });
  const person = cleanBase64(personImageBase64);
  if (!person.base64) {
    return { success: false, error: "Please upload a photo of yourself." };
  }
  if (person.base64.length > 9500000) {
    return { success: false, error: "Customer image exceeds the 7MB limit." };
  }

  let garment = garmentImageBase64 ? cleanBase64(garmentImageBase64) : null;
  if (!garment?.base64 && garmentImageUrl) {
    try {
      garment = await fetchImageAsBase64(garmentImageUrl);
    } catch (error) {
      return {
        success: false,
        error: `Could not download the product image. ${error.message}`,
      };
    }
  }
  if (!garment?.base64) {
    return { success: false, error: "Product image is required for virtual try-on." };
  }

  try {
    console.log(`[TryOn] Uploading images to ${SPACE_URL}`);
    const personFile = await uploadToSpace(
      person.base64,
      person.mime,
      `person.${extensionForMime(person.mime)}`
    );
    const garmentFile = await uploadToSpace(
      garment.base64,
      garment.mime,
      `garment.${extensionForMime(garment.mime)}`
    );

    const submit = await fetch(`${SPACE_URL}/call/tryon`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        data: [
          { background: personFile, layers: [], composite: null },
          garmentFile,
          "clothing item",
          true,
          false,
          20,
          42,
        ],
      }),
    });

    const submitText = await submit.text();
    if (!submit.ok) {
      return {
        success: false,
        error: `Free try-on service rejected the request (${submit.status}). ${submitText.slice(0, 180)}`,
      };
    }

    const { event_id: eventId } = JSON.parse(submitText);
    if (!eventId) {
      return { success: false, error: "Free try-on service did not accept the job." };
    }

    console.log(`[TryOn] Waiting for IDM-VTON result ${eventId}`);
    const result = await waitForTryOn(eventId);
    const imageUri = await imageResultToDataUrl(result);
    return { success: true, imageUri };
  } catch (error) {
    console.error("[TryOn] IDM-VTON error:", error);
    const message = error.message || "Virtual try-on failed.";
    const quota =
      /quota|gpu|zerogpu|rate limit|busy/i.test(message)
        ? " The free daily GPU quota may be used up. Add an HF_TOKEN or try again later."
        : "";
    return { success: false, error: `${message}${quota}` };
  }
}
