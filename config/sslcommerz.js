// SSLCommerz SANDBOX client. Only the sandbox host exists in this file, so live mode can never be reached.
// Docs: https://developer.sslcommerz.com/doc/v4/
import { createHash, timingSafeEqual } from "node:crypto";

const BASE_URL = "https://sandbox.sslcommerz.com";

export const CURRENCY = "BDT";

// Credentials come from the environment; SSLCOMMERZ_SANDBOX must be exactly "true"
export const isConfigured = () =>
  Boolean(process.env.SSLCOMMERZ_STORE_ID && process.env.SSLCOMMERZ_STORE_PASSWORD) &&
  process.env.SSLCOMMERZ_SANDBOX === "true";

// Public base URL SSLCommerz can reach (the IPN must be reachable from the internet)
export const backendUrl = () => process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8000}`;

// Fields the IPN signature must cover, so a signed notification cannot be reused with other values
const REQUIRED_SIGNED_FIELDS = ["tran_id", "val_id", "status", "amount"];

// IPN integrity check, as implemented by SSLCommerz's official PHP library (SslCommerzNotification.php):
// take the fields named in `verify_key`, add md5(store password) as `store_passwd`, sort by key, join as
// key=value&key=value, and compare md5(string) with `verify_sign`. This only proves the notification came
// from SSLCommerz; the Order Validation API is still required before anything is marked paid.
export const verifyIpnSignature = (body) => {
  const { verify_sign: sign, verify_key: key } = body ?? {};
  if (typeof sign !== "string" || typeof key !== "string" || !sign || !key) return false;

  const names = key.split(",");
  if (!REQUIRED_SIGNED_FIELDS.every((name) => names.includes(name))) return false;

  const signed = { store_passwd: createHash("md5").update(process.env.SSLCOMMERZ_STORE_PASSWORD).digest("hex") };
  for (const name of names) if (typeof body[name] === "string") signed[name] = body[name];

  const text = Object.keys(signed)
    .sort()
    .map((name) => `${name}=${signed[name]}`)
    .join("&");
  const expected = Buffer.from(createHash("md5").update(text).digest("hex"));
  const received = Buffer.from(sign.toLowerCase());

  return expected.length === received.length && timingSafeEqual(expected, received);
};

// Errors are rethrown without the URL or response body so credentials never reach the logs
const request = async (url, options) => {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("SSLCommerz request failed");
  }
  if (!response.ok) throw new Error(`SSLCommerz responded with HTTP ${response.status}`);
  return response.json();
};

// Session API: returns { gatewayUrl, sessionKey }
export const createSession = async (fields) => {
  const body = new URLSearchParams({
    store_id: process.env.SSLCOMMERZ_STORE_ID,
    store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
    currency: CURRENCY,
    shipping_method: "NO",
    product_profile: "general",
    ...fields,
  });

  const result = await request(`${BASE_URL}/gwprocess/v4/api.php`, { method: "POST", body });
  if (result.status !== "SUCCESS" || !result.GatewayPageURL) {
    throw new Error(`SSLCommerz session failed: ${result.failedreason || "unknown reason"}`);
  }
  return { gatewayUrl: result.GatewayPageURL, sessionKey: result.sessionkey ?? null };
};

// Order Validation API: the only trusted source of a transaction's real status and amount
export const validateTransaction = (valId) => {
  const query = new URLSearchParams({
    val_id: valId,
    store_id: process.env.SSLCOMMERZ_STORE_ID,
    store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
    format: "json",
  });
  return request(`${BASE_URL}/validator/api/validationserverAPI.php?${query}`);
};
