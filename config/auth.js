import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { client, db } from "./db.js";
import { jwt } from "better-auth/plugins";
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
    role: {
      type: "string",
      required: false,
      defaultValue: "customer",
      input: false,
    },
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
  databaseHooks: {
    user: {
      create: { before: async (user) => ({ data: { ...user, image: safeImage(user.image) } }) },
      update: {
        before: async (data) => ("image" in data ? { data: { ...data, image: safeImage(data.image) } } : { data }),
      },
    },
  },
  plugins: [jwt()],
});

