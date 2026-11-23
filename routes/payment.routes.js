import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  createCheckoutSession,
  verifyPayment,
  getMyPayments,
  handleWebhook,
  getTechnicianEarnings,
} from "../controllers/payment.controller.js";

const router = express.Router();

// Public: called by Stripe. Its raw body is read in index.js, and the Stripe signature is checked in the handler.
router.post("/webhook", handleWebhook);

// Technician route (declared before the customer-only guard below)
router.get("/earnings", verifyToken, verifyRole("technician"), getTechnicianEarnings);

// Customer routes
router.use(verifyToken, verifyRole("customer"));
router.post("/create-checkout-session", createCheckoutSession);
router.get("/verify", verifyPayment);
router.get("/my", getMyPayments);

export default router;
