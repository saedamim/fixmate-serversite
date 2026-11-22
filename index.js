// Load .env before any other module: verifyToken.js reads BETTER_AUTH_URL when it is imported
import "dotenv/config";
import uploadRoutes from "./routes/upload.routes.js";
import serviceRoutes from "./routes/service.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { toNodeHandler } from "better-auth/node";
import connectDB, { db } from "./config/db.js";
import { auth } from "./config/auth.js";
import { FRONTEND_URL } from "./config/frontend.js";
import verifyToken from "./middlewares/verifyToken.js";
import verifyRole from "./middlewares/verifyRole.js";

dotenv.config();

const app = express();

// Behind Vercel's proxy: lets req.ip be the real client address (used by the upload rate limit)
app.set("trust proxy", 1);

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.all("/api/auth/*splat", toNodeHandler(auth));

// Stripe signs the exact bytes it sends, so the webhook needs the raw body (this must stay before express.json)
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use("/api/upload", uploadRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentRoutes);
app.get(
  "/api/test/customer",
  verifyToken,
  verifyRole("customer"),
  (req, res) => {
    res.json({
      success: true,
      message: "Customer access granted!",
      user: req.user,
    });
  }
);
app.get("/", (req, res) => {
  res.send("FixMate API is running!");
});

// Unknown routes and unexpected errors answer with JSON (never an HTML page or a stack trace)
app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ success: false, message: "Something went wrong on the server" });
});

const PORT = process.env.PORT || 8000;

const startServer = async () => {
  try {
    await connectDB();

    // One active booking per customer and service (safe to run on every start)
    await db.collection("bookings").createIndex(
      { customerId: 1, serviceId: 1 },
      {
        unique: true,
        partialFilterExpression: { isActive: true },
        name: "one_active_booking_per_customer_service",
      }
    );

    // Payments: drop the indexes of the removed SSLCommerz integration (the collection holds no records), then
    // allow one pending and one paid payment per booking and a unique Stripe session
    const payments = db.collection("payments");
    for (const name of ["unique_tran_id", "one_pending_payment_per_booking"]) {
      await payments.dropIndex(name).catch((error) => {
        if (!["IndexNotFound", "NamespaceNotFound"].includes(error.codeName)) throw error;
      });
    }
    await payments.createIndex(
      { stripeSessionId: 1 },
      { unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } }, name: "unique_stripe_session" }
    );
    await payments.createIndex(
      { bookingId: 1 },
      { unique: true, partialFilterExpression: { paymentStatus: "pending" }, name: "one_pending_checkout_per_booking" }
    );
    await payments.createIndex(
      { bookingId: 1 },
      { unique: true, partialFilterExpression: { paymentStatus: "paid" }, name: "one_paid_payment_per_booking" }
    );
    await payments.createIndex({ customerId: 1, createdAt: -1 }, { name: "payments_by_customer" });

    app.listen(PORT, () => {
      console.log(`FixMate server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server error:", error);
  }
};

startServer();

