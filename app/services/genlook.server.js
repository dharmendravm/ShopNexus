/**
 * Genlook API Virtual Try-On Service
 * Official integration using @genlook/api SDK.
 */

import { Genlook } from "@genlook/api";

export function getGenlookApiKey() {
  return (
    process.env.GENLOOK_API_KEY ||
    process.env["Genlook API"] ||
    process.env.PIXELAPI ||
    process.env.GENLOOK_KEY ||
    ""
  ).trim();
}

export function isGenlookConfigured() {
  return Boolean(getGenlookApiKey());
}

function cleanBase64Buffer(data) {
  if (!data || typeof data !== "string") return { buffer: null, mime: "image/jpeg" };
  const match = data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  const base64Str = match ? match[2].replace(/\s/g, "") : data.trim();
  const mime = match ? match[1] : "image/jpeg";
  return { buffer: Buffer.from(base64Str, "base64"), mime };
}

async function fetchUrlAsBuffer(url) {
  let fullUrl = url.trim();
  if (fullUrl.startsWith("//")) fullUrl = `https:${fullUrl}`;
  const response = await fetch(fullUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch product image (${response.status} ${response.statusText})`);
  }
  const mime = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mime };
}

/**
 * Main Genlook Virtual Try-On runner using official @genlook/api SDK
 * @param {Object} params
 * @param {string} params.personImageBase64
 * @param {string} [params.garmentImageUrl]
 * @param {string} [params.garmentImageBase64]
 * @param {string} [params.productId]
 * @param {string} [params.variantId]
 * @returns {Promise<{ success: boolean, imageUri?: string, provider?: string, error?: string }>}
 */
export async function generateGenlookVirtualTryOn({
  personImageBase64,
  garmentImageUrl,
  garmentImageBase64,
  productId,
  variantId,
}) {
  const apiKey = getGenlookApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: "Genlook API Key is missing. Please set GENLOOK_API_KEY in .env",
    };
  }

  console.log(`[Genlook SDK] Initializing client with key prefix ${apiKey.slice(0, 8)}...`);

  try {
    const client = new Genlook({ apiKey });

    // 1. Decode & upload person image
    const { buffer: personBuffer, mime: personMime } = cleanBase64Buffer(personImageBase64);
    if (!personBuffer || personBuffer.length === 0) {
      return { success: false, error: "Please upload a photo of yourself." };
    }

    console.log(`[Genlook SDK] Uploading person image (${personBuffer.length} bytes, ${personMime})...`);
    const { imageId } = await client.images.upload(personBuffer, {
      mimeType: personMime,
      filename: "person.jpg",
    });

    console.log(`[Genlook SDK] Person image uploaded successfully. Image ID: ${imageId}`);

    // 2. Prepare product garment image
    let productBuffer = garmentImageBase64 ? cleanBase64Buffer(garmentImageBase64).buffer : null;
    let productMime = garmentImageBase64 ? cleanBase64Buffer(garmentImageBase64).mime : "image/jpeg";

    if (!productBuffer && garmentImageUrl) {
      console.log(`[Genlook SDK] Downloading product image from ${garmentImageUrl}...`);
      const downloaded = await fetchUrlAsBuffer(garmentImageUrl);
      productBuffer = downloaded.buffer;
      productMime = downloaded.mime;
    }

    if (!productBuffer || productBuffer.length === 0) {
      return { success: false, error: "Product garment image is required for Virtual Try-On." };
    }

    // 3. Create try-on via createSync
    console.log(`[Genlook SDK] Requesting tryOn.createSync...`);
    const tryOnInput = {
      products: [
        {
          title: `Product_${productId || "item"}`,
          description: "Virtual try-on garment",
          images: [{ source: { fileKey: "productImage" } }],
        },
      ],
      person: { image: { source: { id: imageId } } },
      files: {
        productImage: {
          data: productBuffer,
          mimeType: productMime,
        },
      },
    };

    let result = await client.tryOn.createSync(tryOnInput);

    // 4. Poll if not completed instantly
    if (!result?.resultImageUrl && result?.generationId) {
      console.log(`[Genlook SDK] Polling generation ${result.generationId}...`);
      result = await client.generations.waitFor(result.generationId);
    }

    const finalImage = result?.resultImageUrl || result?.imageUrl || result?.output;

    if (finalImage) {
      console.log(`[Genlook SDK] Try-On SUCCESS! Result Image: ${finalImage.slice(0, 100)}...`);
      return {
        success: true,
        imageUri: finalImage,
        provider: "genlook",
      };
    }

    return {
      success: false,
      error: "Genlook API did not return a result image URL.",
    };
  } catch (error) {
    console.error("[Genlook SDK Exception]:", error);
    const message = error.body?.message || error.message || "Genlook Virtual Try-On failed.";
    return {
      success: false,
      error: `Genlook API Error: ${message}`,
    };
  }
}