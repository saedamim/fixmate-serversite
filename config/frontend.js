// The deployed frontend's address, from the FRONTEND_URL variable, without a trailing slash.
// CORS, Better Auth trusted origins and the Stripe return URLs must all match the browser's Origin exactly.
import "dotenv/config";

export const FRONTEND_URL = (process.env.FRONTEND_URL ?? "").trim().replace(/\/+$/, "");
