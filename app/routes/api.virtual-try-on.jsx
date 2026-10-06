import shopify from "../shopify.server";
import { generateVirtualTryOn } from "../services/vertexAi.server";

// Helper headers to enable CORS for Storefront requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

export async function loader({ request }) {
  try {
    await shopify.authenticate.public.appProxy(request);
  } catch (e) {
    // Ignore auth check error for simple status loaders
  }
  return jsonResponse({ message: "Virtual Try-On API is active." });
}

export async function action({ request }) {
  console.log(`[TryOn API] Received ${request.method} request to /api/virtual-try-on`);

  // Handle preflight OPTIONS request
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  // Attempt optional Shopify App Proxy signature verification
  try {
    const proxyAuth = await shopify.authenticate.public.appProxy(request);
    if (proxyAuth) {
      console.log("[TryOn API] Authenticated Shopify App Proxy HMAC request");
    }
  } catch (authErr) {
    // If not authenticated via App Proxy HMAC (e.g. direct CORS request), log and proceed safely
    console.log("[TryOn API] Processing request (unauthenticated or direct request)");
  }

  try {
    let body;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      body = await request.json();
    } else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      body = {
        personImage: formData.get("personImage"),
        garmentImageUrl: formData.get("garmentImageUrl"),
        garmentImageBase64: formData.get("garmentImageBase64"),
        productId: formData.get("productId"),
        variantId: formData.get("variantId"),
      };
    } else {
      console.warn("[TryOn API] Unsupported Content-Type:", contentType);
      return jsonResponse(
        { success: false, error: "Unsupported Content-Type. Please use application/json." },
        { status: 400 }
      );
    }

    const { personImage, garmentImageUrl, garmentImageBase64, productId, variantId } = body || {};

    console.log(`[TryOn API] Processing request: Product=${productId}, Variant=${variantId}, GarmentURL=${garmentImageUrl}`);

    if (!personImage) {
      return jsonResponse(
        { success: false, error: "Please upload a photo of yourself." },
        { status: 400 }
      );
    }

    if (!garmentImageUrl && !garmentImageBase64) {
      return jsonResponse(
        { success: false, error: "Product image is required for virtual try-on." },
        { status: 400 }
      );
    }

    // Call Google Cloud Vertex AI virtual-try-on-001 service
    const result = await generateVirtualTryOn({
      personImageBase64: personImage,
      garmentImageBase64: garmentImageBase64 || null,
      garmentImageUrl: garmentImageUrl || null,
    });

    console.log(`[TryOn API] Vertex AI call result success=${result.success}`);
    if (!result.success) {
      console.error(`[TryOn API] Vertex AI Error:`, result.error);
      return jsonResponse(
        { success: false, error: result.error || "Failed to generate virtual try-on image." },
        { status: 500 }
      );
    }

    return jsonResponse({
      success: true,
      tryOnImage: result.imageUri,
      productId,
      variantId,
    });
  } catch (err) {
    console.error("[TryOn API] Action Exception:", err);
    return jsonResponse(
      { success: false, error: `Server Exception: ${err.message}` },
      { status: 500 }
    );
  }
}
