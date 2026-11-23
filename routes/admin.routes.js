import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  getStats,
  getUsers,
  updateUserRole,
  getAllServices,
  updateServiceStatus,
  getAllBookings,
  getTransactions,
  getRevenueByDay,
} from "../controllers/admin.controller.js";

const router = express.Router();

// Every admin route needs a valid token AND the "admin" role
router.use(verifyToken, verifyRole("admin"));

router.get("/stats", getStats);
router.get("/users", getUsers);
router.patch("/users/:id/role", updateUserRole);
router.get("/services", getAllServices);
router.patch("/services/:id/status", updateServiceStatus);
router.get("/bookings", getAllBookings);
router.get("/transactions", getTransactions);
router.get("/revenue-by-day", getRevenueByDay);

export default router;
