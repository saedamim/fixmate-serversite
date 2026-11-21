import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  createBooking,
  getMyBookings,
  getBookingById,
  cancelBooking,
} from "../controllers/booking.controller.js";

const router = express.Router();

// Customer booking flow: every route needs a valid token and the "customer" role
router.use(verifyToken, verifyRole("customer"));

router.post("/", createBooking);
router.get("/my", getMyBookings); // must stay above "/:id"
router.get("/:id", getBookingById);
router.patch("/:id/cancel", cancelBooking);

export default router;
