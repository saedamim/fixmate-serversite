import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { client, db } from "./db.js";
import { jwt } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { FRONTEND_URL } from "./frontend.js";

// Profile pictures may only point at our image host (ImgBB) or Google, so nobody can store an arbitrary link
const AVATAR_HOSTS = ["i.ibb.co", "lh3.googleusercontent.com"];
const safeImage = (value) => {
  if (value == null || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && AVATAR_HOSTS.includes(url.hostname) && value.length <= 500 ? value : null;
  } catch {
    return null;
  }
};

export const auth = betterAuth({
  database: mongodbAdapter(db, { client }),

  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,

  trustedOrigins: [FRONTEND_URL],

  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      // Sign-up may ask for "technician"; the create hook below turns everything else into "customer".
      role: { type: "string", required: false, defaultValue: "customer", input: true },
      phone: { type: "string", required: false },
      area: { type: "string", required: false },
      bio: { type: "string", required: false },
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Google returns to the FRONTEND domain, which forwards /api/auth/* to this API (next.config.ts rewrite), so the
      // OAuth state cookie is set and read on the same domain. FRONTEND_URL has no trailing slash (config/frontend.js).
      // Register exactly this address under "Authorized redirect URIs" in Google Cloud Console.
      redirectURI: `${FRONTEND_URL}/api/auth/callback/google`,
    },
  },
  // "role" accepts input so a sign-up can pick technician, so the profile update endpoint must refuse it
  // (a database hook cannot remove a field: its result is merged over the original data).
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/update-user" && ctx.body && "role" in ctx.body) {
        throw new APIError("BAD_REQUEST", { message: "The role cannot be changed here" });
      }
    }),
  },
  databaseHooks: {
    user: {
      // Only "technician" is accepted from a sign-up; nobody can create an admin (or any other role) this way.
      // Google sign-ins send no role, so they become customers.
      create: {
        before: async (user) => ({
          data: { ...user, role: user.role === "technician" ? "technician" : "customer", image: safeImage(user.image) },
        }),
      },
      update: {
        before: async (data) => ("image" in data ? { data: { ...data, image: safeImage(data.image) } } : { data }),
      },
    },
  },
  plugins: [jwt()],
});

