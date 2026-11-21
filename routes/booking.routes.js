import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  createBooking,
  getMyBookings,
  getBookingById,
  cancelBooking,
  getTechnicianBookings,
  updateBookingStatus,
} from "../controllers/booking.controller.js";

const router = express.Router();

router.use(verifyToken);

// Technician routes (declared first so "/technician" is not read as an id)
router.get("/technician", verifyRole("technician"), getTechnicianBookings);
router.patch("/technician/:id/status", verifyRole("technician"), updateBookingStatus);

// Customer booking flow: everything below needs the "customer" role
router.use(verifyRole("customer"));

router.post("/", createBooking);
router.get("/my", getMyBookings); // must stay above "/:id"
router.get("/:id", getBookingById);
router.patch("/:id/cancel", cancelBooking);

export default router;
