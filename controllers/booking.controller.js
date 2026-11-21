import { ObjectId } from "mongodb";
import { db } from "../config/db.js";

const bookings = () => db.collection("bookings");

const TIME_SLOTS = ["09:00-12:00", "12:00-15:00", "15:00-18:00"];
const STATUSES = ["pending", "accepted", "in_progress", "completed", "cancelled", "rejected"];
const ID_PATTERN = /^[a-f\d]{24}$/i;

// Match the frontend style: expose `_id` as `id`, ObjectIds as strings.
const toBooking = ({ _id, serviceId, ...rest }) => ({
  id: _id.toString(),
  serviceId: serviceId.toString(),
  ...rest,
});

// Only plain strings are accepted (blocks objects like { $gt: "" } from the body).
const text = (value) => (typeof value === "string" ? value.trim() : "");

// True only for real calendar dates. Date.parse() is not enough because it rolls
// impossible dates forward (2026-02-31 becomes March 3), so the parts are compared.
const isRealDate = (value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

// Returns an error message, or null when the request body is valid.
const validateBooking = (body, service) => {
  if (!ID_PATTERN.test(text(body.serviceId))) return "A valid service is required";

  const date = text(body.preferredDate);
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Preferred date must be in YYYY-MM-DD format";
  if (!isRealDate(date)) return "Preferred date must be a real calendar date";
  if (date < today) return "Preferred date cannot be in the past";

  if (!TIME_SLOTS.includes(text(body.preferredTime))) {
    return `Preferred time must be one of: ${TIME_SLOTS.join(", ")}`;
  }
  if (!/^\+?[\d\s-]{7,20}$/.test(text(body.phone))) return "A valid phone number is required";

  const problem = text(body.problemDescription);
  if (problem.length < 10 || problem.length > 1000) {
    return "Problem description must be 10 to 1000 characters";
  }

  // The customer's address is only needed when the technician visits or collects the device
  const address = text(body.address);
  if (service && service.mode !== "In-shop" && (address.length < 5 || address.length > 300)) {
    return "Address is required (5 to 300 characters) for this service";
  }

  return null;
};

export const createBooking = async (req, res) => {
  const body = req.body ?? {};

  // 1. Format checks that do not need the service (service id, date, time, phone, description)
  const formatError = validateBooking(body, null);
  if (formatError) return res.status(400).json({ message: formatError });

  // 2. The service must exist, be approved and be available
  const service = await db.collection("services").findOne({ _id: new ObjectId(text(body.serviceId)) });
  if (!service || service.status !== "approved") {
    return res.status(404).json({ message: "Service not found" });
  }
  if (!service.available) {
    return res.status(409).json({ message: "This service is currently unavailable" });
  }

  // 3. Full validation (address depends on the service mode)
  const error = validateBooking(body, service);
  if (error) return res.status(400).json({ message: error });

  // Identity, price, title, technician and status come from the token and the database, never the request body
  const now = new Date();
  const booking = {
    customerId: req.user.id,
    customerName: req.user.name,
    customerEmail: req.user.email,
    serviceId: service._id,
    serviceTitle: service.title,
    category: service.category,
    mode: service.mode,
    price: service.price,
    technician: service.technician,
    preferredDate: text(body.preferredDate),
    preferredTime: text(body.preferredTime),
    phone: text(body.phone),
    address: service.mode === "In-shop" ? "" : text(body.address),
    problemDescription: text(body.problemDescription),
    status: "pending",
    isActive: true,
    paymentStatus: "unpaid",
    createdAt: now,
    updatedAt: now,
  };

  try {
    const { insertedId } = await bookings().insertOne(booking);
    res.status(201).json({ message: "Booking created", booking: toBooking({ _id: insertedId, ...booking }) });
  } catch (error) {
    // The unique partial index allows only one active booking per customer and service
    if (error.code === 11000) {
      return res.status(409).json({ message: "You already have an active booking for this service" });
    }
    throw error;
  }
};

export const getMyBookings = async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);

  const filter = { customerId: req.user.id };
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    bookings()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    bookings().countDocuments(filter),
  ]);

  res.json({
    bookings: items.map(toBooking),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
};

export const getBookingById = async (req, res) => {
  const { id } = req.params;

  // Filtering by customerId means other customers' bookings look like "not found"
  const booking = ID_PATTERN.test(id)
    ? await bookings().findOne({ _id: new ObjectId(id), customerId: req.user.id })
    : null;

  if (!booking) return res.status(404).json({ message: "Booking not found" });

  res.json(toBooking(booking));
};

export const cancelBooking = async (req, res) => {
  const { id } = req.params;
  if (!ID_PATTERN.test(id)) return res.status(404).json({ message: "Booking not found" });

  const filter = { _id: new ObjectId(id), customerId: req.user.id };
  const now = new Date();

  // Atomic: only a pending booking that belongs to this customer can be cancelled
  const cancelled = await bookings().findOneAndUpdate(
    { ...filter, status: "pending" },
    { $set: { status: "cancelled", isActive: false, cancelledAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );

  if (cancelled) return res.json({ message: "Booking cancelled", booking: toBooking(cancelled) });

  const exists = await bookings().countDocuments(filter);
  if (!exists) return res.status(404).json({ message: "Booking not found" });

  res.status(409).json({ message: "Only pending bookings can be cancelled" });
};
