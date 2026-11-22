import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  initiatePayment,
  getMyPayments,
  handleIpn,
  redirectToFrontend,
} from "../controllers/payment.controller.js";

const router = express.Router();

// Public: called by SSLCommerz (form-encoded). The IPN is verified with the Order Validation API.
router.post("/ipn", express.urlencoded({ extended: false }), handleIpn);
// Public: the customer's browser coming back from the gateway page (redirect only, changes nothing)
router.all("/success", redirectToFrontend("success"));
router.all("/fail", redirectToFrontend("failed"));
router.all("/cancel", redirectToFrontend("cancelled"));

// Customer routes
router.use(verifyToken, verifyRole("customer"));
router.post("/initiate", initiatePayment);
router.get("/my", getMyPayments);

export default router;
