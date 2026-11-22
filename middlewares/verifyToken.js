
import { createRemoteJWKSet, jwtVerify } from "jose";

// Built on first use, so a missing BETTER_AUTH_URL cannot crash the server when this file is imported.
// Trailing slashes are removed so the address is never "https://host//api/auth/jwks".
let JWKS;
const getJwks = () => {
  const base = (process.env.BETTER_AUTH_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("BETTER_AUTH_URL is not set");
  return (JWKS ??= createRemoteJWKSet(new URL(`${base}/api/auth/jwks`)));
};

const verifyToken = async (req, res, next) => {
  try {
   const authHeader = req.headers.authorization;

if (!authHeader?.startsWith("Bearer ")) {
  return res.status(401).json({
    success: false,
    message: "Unauthorized access",
  });
}

    const token = authHeader.split(" ")[1];

    const { payload } = await jwtVerify(token, getJwks());

    req.user = {
      id: payload.sub,
      ...payload,
    };

    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

export default verifyToken;


