import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  getStats,
  getUsers,
  getAllServices,
  updateServiceStatus,
  getAllBookings,
  getTransactions,
} from "../controllers/admin.controller.js";

const router = express.Router();

// Every admin route needs a valid token AND the "admin" role
router.use(verifyToken, verifyRole("admin"));

router.get("/stats", getStats);
router.get("/users", getUsers);
router.get("/services", getAllServices);
router.patch("/services/:id/status", updateServiceStatus);
router.get("/bookings", getAllBookings);
router.get("/transactions", getTransactions);

export default router;
