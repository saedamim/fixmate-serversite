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
import verifyToken from "./middlewares/verifyToken.js";
import verifyRole from "./middlewares/verifyRole.js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

app.all("/api/auth/*splat", toNodeHandler(auth));

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

    // Payment lookups, plus only one pending payment per booking at a time
    const payments = db.collection("payments");
    await payments.createIndex({ tranId: 1 }, { unique: true, name: "unique_tran_id" });
    await payments.createIndex(
      { bookingId: 1 },
      { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_payment_per_booking" }
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

