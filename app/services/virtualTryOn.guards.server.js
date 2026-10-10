/**
 * =============================================================================
 * FILE: app/services/virtualTryOn.guards.server.js
 * ROLE: Security + validation helpers (server-side only)
 * =============================================================================
 *
 * Yeh file kyun alag hai?
 *   API route thin rakhne ke liye. Saare "check / reject" rules yahan central hain.
 *   Production app mein bhi yahi pattern follow karo:
 *     route = orchestration (steps call karo)
 *     guards = validation / abuse control
 *     provider = external GPU/API call
 *
 * Kaun use karta hai?
 *   app/routes/api.virtual-try-on.jsx  → in functions ko import karta hai
 *
 * Exports (quick map):
 *   checkVirtualTryOnRateLimit(key)     → kitni requests allow
 *   getRequestClientIp(request)         → IP nikaalo (rate limit key)
 *   validatePersonImagePayload(img)     → customer photo OK?
 *   validateGarmentImageUrl(url, shop)  → product image URL safe?
 *   normalizeGarmentCategory(cat)       → tops/bottoms/one-pieces
 *   normalizeShopifyVariantId(id)       → GID → number
 *   toPublicErrorMessage(err)           → safe error text for client
 *
 * Env (optional — .env mein set kar sakte ho):
 *   VTO_RATE_LIMIT_WINDOW_MS=60000   // 1 minute window
 *   VTO_RATE_LIMIT_MAX=8             // us window mein max 8 try-on
 *
 * Production tip:
 *   Abhi rate limit in-memory Map mein hai (ek Node process).
 *   Agar multiple servers / containers chalaye to Redis / Upstash use karo,
 *   warna har instance alag counter rakhega.
 * =============================================================================
 */

/**
 * Customer photo decode hone ke baad max size = 5 MB.
 * Frontend bhi 5 MB check karta hai — dono sync rakhna.
 * @constant {number}
 */
export const MAX_PERSON_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * JSON body mein data-URI / base64 string ki max length.
 * Kyun alag? Base64 binary se ~33% bada hota hai.
 * 5 MB binary ≈ 6.7 MB base64 → 1.4x buffer + thoda overhead.
 * @constant {number}
 */
export const MAX_PERSON_IMAGE_STRING_LENGTH = Math.ceil(MAX_PERSON_IMAGE_BYTES * 1.4) + 64;

/**
 * Rate limit window (milliseconds). Default 60 seconds.
 * @constant {number}
 */
const RATE_LIMIT_WINDOW_MS = Number(process.env.VTO_RATE_LIMIT_WINDOW_MS || 60_000);

/**
 * Ek window mein max allowed try-on requests (per shop+IP key).
 * @constant {number}
 */
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.VTO_RATE_LIMIT_MAX || 8);

/**
 * In-memory rate limit store.
 * Shape: Map< key, { count: number, windowStartedAt: number } >
 * Key example: "my-shop.myshopify.com:203.0.113.10"
 *
 * @type {Map<string, { count: number, windowStartedAt: number }>}
 */
const rateLimitBuckets = new Map();

/**
 * Garment image URL ke allowed host suffixes.
 * Is list ke bahar koi URL aaye to reject (SSRF protection).
 * Production mein agar custom CDN use ho to yahan add karo — carefully.
 * @constant {string[]}
 */
const ALLOWED_GARMENT_HOST_SUFFIXES = [
  "cdn.shopify.com",
  "cdn.shopifycdn.net",
  "shopifycdn.com",
  "shopify.com",
  "myshopify.com",
];

/**
 * FASHN model jo categories samajhta hai.
 * Liquid block setting se yahi values aati hain.
 * @constant {Set<string>}
 */
const VALID_GARMENT_CATEGORIES = new Set(["tops", "bottoms", "one-pieces"]);

/**
 * Shop + IP ke hisaab se sliding-window rate limit.
 *
 * Logic simple hai:
 *   - Pehli request / window expire → naya bucket, count=1, allow
 *   - Same window mein count >= MAX → block + retryAfterSeconds
 *   - Warna count++ aur allow
 *
 * @param {string} key - usually `${shopDomain}:${clientIp}`
 * @returns {{ allowed: boolean, retryAfterSeconds?: number }}
 *   allowed=false hone par API 429 return kare
 *
 * @example
 *   const r = checkVirtualTryOnRateLimit("shop.myshopify.com:1.2.3.4");
 *   if (!r.allowed) return jsonResponse(..., { status: 429 });
 */
export function checkVirtualTryOnRateLimit(key) {
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);

  // Nayi window shuru karo
  if (!existing || now - existing.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(key, { count: 1, windowStartedAt: now });
    return { allowed: true };
  }

  // Limit cross — client ko kitne seconds wait karna hai batao
  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - existing.windowStartedAt);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true };
}

/**
 * Request se client IP nikaalo (best-effort).
 *
 * Priority:
 *   1. x-forwarded-for (pehla value = original client)
 *   2. cf-connecting-ip (Cloudflare)
 *   3. x-real-ip
 *   4. "unknown"
 *
 * Rate limit key banane ke liye use hota hai — logging mein bhi useful.
 *
 * @param {Request} request - incoming HTTP request
 * @returns {string} IP string ya "unknown"
 */
export function getRequestClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Header format: "client, proxy1, proxy2"
    return forwarded.split(",")[0].trim() || "unknown";
  }
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Internal helper: value non-empty string hai ya nahi.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Customer photo payload validate karo (data URI ya raw base64).
 *
 * Ye checks karta hai (order mein):
 *   1. Empty to nahi?
 *   2. String length bahut badi to nahi? (memory bomb)
 *   3. MIME type jpg/png/webp hai?
 *   4. Base64 alphabet roughly valid?
 *   5. Decoded size ≤ 5 MB?
 *
 * Success par clean `{ mime, base64, estimatedBytes }` milta hai —
 * API route isi se fresh data URI rebuild karti hai.
 *
 * @param {string} personImage - frontend se aaya `personImage` field
 * @returns {{ ok: true, mime: string, base64: string, estimatedBytes: number } | { ok: false, error: string }}
 *
 * @example
 *   const v = validatePersonImagePayload(body.personImage);
 *   if (!v.ok) return jsonResponse({ error: v.error }, { status: 400 });
 */
export function validatePersonImagePayload(personImage) {
  if (!isNonEmptyString(personImage)) {
    return { ok: false, error: "Please upload a photo of yourself." };
  }

  if (personImage.length > MAX_PERSON_IMAGE_STRING_LENGTH) {
    return {
      ok: false,
      error: "Customer photo is too large. Please upload an image under 5MB.",
    };
  }

  // Standard data URI: data:image/jpeg;base64,/9j/4AAQ...
  const dataUriMatch = personImage.match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/,
  );

  const rawMime = (dataUriMatch?.[1] || "image/jpeg").toLowerCase();
  const mime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  const base64 = (dataUriMatch?.[2] || personImage).replace(/\s/g, "");

  const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowedMimes.has(mime)) {
    return { ok: false, error: "Please upload a valid JPG, PNG, or WebP image." };
  }

  // Quick sanity — poora decode mehnga hai, pehle alphabet check
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64.slice(0, 200)) || base64.length < 32) {
    return { ok: false, error: "Uploaded photo data is invalid." };
  }

  // Approx decoded bytes = (base64Length * 3) / 4
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_PERSON_IMAGE_BYTES) {
    return {
      ok: false,
      error: "Customer photo is too large. Please upload an image under 5MB.",
    };
  }

  return { ok: true, mime, base64, estimatedBytes };
}

/**
 * Product (garment) image URL validate + normalize.
 *
 * SSRF kya hota hai (short):
 *   Attacker koi internal URL bhej de (e.g. cloud metadata IP) aur server
 *   usko fetch kare → private data leak. Isliye sirf trusted hosts allow.
 *
 * Rules:
 *   - non-empty
 *   - `//cdn...` ho to `https:` prepend
 *   - protocol sirf https
 *   - host Shopify CDN list mein YA current shop domain
 *
 * @param {string} garmentImageUrl - frontend / Liquid se aayi product image URL
 * @param {string} [shopDomain] - e.g. `cool-store.myshopify.com` (App Proxy se)
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateGarmentImageUrl(garmentImageUrl, shopDomain = "") {
  if (!isNonEmptyString(garmentImageUrl)) {
    return { ok: false, error: "Product image is required for virtual try-on." };
  }

  // Liquid aksar protocol-relative deta hai: //cdn.shopify.com/s/files/...
  let normalized = garmentImageUrl.trim();
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "Product image URL is invalid." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Product image URL must use HTTPS." };
  }

  const hostname = parsed.hostname.toLowerCase();
  const shopHost = String(shopDomain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];

  const hostAllowed =
    ALLOWED_GARMENT_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    ) || (shopHost && (hostname === shopHost || hostname.endsWith(`.${shopHost}`)));

  if (!hostAllowed) {
    return {
      ok: false,
      error: "Product image must come from the Shopify store CDN.",
    };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * AI / FASHN ko sahi garment category do.
 * Unknown / typo values → default `"tops"` (crash mat hone do).
 *
 * @param {unknown} category - frontend / Liquid se aaya value
 * @returns {'tops'|'bottoms'|'one-pieces'}
 */
export function normalizeGarmentCategory(category) {
  const value = String(category || "tops").toLowerCase().trim();
  return VALID_GARMENT_CATEGORIES.has(value) ? value : "tops";
}

/**
 * Shopify variant id normalize.
 * Ajax Cart API numeric id chahti hai; GraphQL GID bhi aa sakti hai.
 *
 * Examples:
 *   "gid://shopify/ProductVariant/123" → "123"
 *   "123" → "123"
 *   "abc" → null
 *
 * @param {unknown} variantId
 * @returns {string|null} numeric string ya null
 */
export function normalizeShopifyVariantId(variantId) {
  if (variantId == null) return null;
  const raw = String(variantId).trim();
  if (!raw) return null;

  const gidMatch = raw.match(/ProductVariant\/(\d+)/);
  if (gidMatch) return gidMatch[1];

  if (/^\d+$/.test(raw)) return raw;
  return null;
}

/**
 * Client ko dikhane layak safe error message banao.
 *
 * Kyun zaroori?
 *   Raw `error.message` mein kabhi file path, API key hint, internal URL
 *   aa sakta hai. Production mein yeh leak mat karo.
 *
 * Rule: sirf known user-facing prefixes allow; baaki sab fallback.
 *
 * @param {unknown} error - Error object ya { message: string }
 * @param {string} [fallback="Virtual try-on failed. Please try again."]
 * @returns {string} customer-safe message
 */
export function toPublicErrorMessage(
  error,
  fallback = "Virtual try-on failed. Please try again.",
) {
  if (!error || typeof error !== "object") return fallback;
  const message =
    "message" in error && typeof error.message === "string" ? error.message : "";

  if (
    message.startsWith("Please ") ||
    message.startsWith("Product image") ||
    message.startsWith("Customer photo") ||
    message.startsWith("FASHN") ||
    message.startsWith("Virtual try-on")
  ) {
    return message;
  }

  return fallback;
}
