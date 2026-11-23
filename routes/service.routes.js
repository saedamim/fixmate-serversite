import express from "express";
import verifyToken from "../middlewares/verifyToken.js";
import verifyRole from "../middlewares/verifyRole.js";
import {
  getServices,
  getServiceById,
  getMyServices,
  createService,
  updateService,
  deleteService,
  setAvailability,
} from "../controllers/service.controller.js";

const router = express.Router();

// Public: only approved and available services
router.get("/", getServices);

// Technician only (declared before "/:id" so "/mine" is not read as an id)
const technicianOnly = [verifyToken, verifyRole("technician")];
router.get("/mine", technicianOnly, getMyServices);
router.post("/", technicianOnly, createService);
router.put("/:id", technicianOnly, updateService);
router.delete("/:id", technicianOnly, deleteService);
router.patch("/:id/availability", technicianOnly, setAvailability);

router.get("/:id", getServiceById);

export default router;
