import { ObjectId } from "mongodb";
import { db } from "../config/db.js";

const bookings = () => db.collection("bookings");

const TIME_SLOTS = ["09:00-12:00", "12:00-15:00", "15:00-18:00"];
const STATUSES = ["requested", "accepted", "in_progress", "completed", "cancelled", "rejected"];
const ID_PATTERN = /^[a-f\d]{24}$/i;

// Technician status updates: new status -> the only status it may move from.
const TRANSITIONS = {
  accepted: "requested",
  rejected: "requested",
  in_progress: "accepted",
  completed: "in_progress",
};

// Match the frontend style: expose `_id` as `id`, ObjectIds as strings.
export const toBooking = ({ _id, serviceId, ...rest }) => ({
  id: _id.toString(),
  serviceId: serviceId.toString(),
  ...rest,
});

// Number of bookings per status (plus a total) for one person, ignoring any filter or page
export const countByStatus = async (match) => {
  const grouped = await bookings()
    .aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }])
    .toArray();

  const counts = { total: 0, ...Object.fromEntries(STATUSES.map((s) => [s, 0])) };
  for (const { _id, count } of grouped) {
    counts.total += count;
    if (STATUSES.includes(_id)) counts[_id] = count;
  }
  return counts;
};


export const text = (value) => (typeof value === "string" ? value.trim() : "");

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
    // `technician` is kept because the customer dashboard already reads it.
    technician: service.technician,
    technicianName: service.technician,
    // Both come only from the service record, never the request body.
    // Services without a technicianEmail produce bookings no technician can see or update.
    technicianEmail: text(service.technicianEmail).toLowerCase() || null,
    preferredDate: text(body.preferredDate),
    preferredTime: text(body.preferredTime),
    phone: text(body.phone),
    address: service.mode === "In-shop" ? "" : text(body.address),
    problemDescription: text(body.problemDescription),
    status: "requested",
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

  const [items, total, counts] = await Promise.all([
    bookings()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    bookings().countDocuments(filter),
    countByStatus({ customerId: req.user.id }),
  ]);

  res.json({
    bookings: items.map(toBooking),
    total,
    counts,
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

  // Atomic: only a requested booking that belongs to this customer can be cancelled
  const cancelled = await bookings().findOneAndUpdate(
    { ...filter, status: "requested" },
    { $set: { status: "cancelled", isActive: false, cancelledAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );

  if (cancelled) return res.json({ message: "Booking cancelled", booking: toBooking(cancelled) });

  const exists = await bookings().countDocuments(filter);
  if (!exists) return res.status(404).json({ message: "Booking not found" });

  res.status(409).json({ message: "Only requested bookings can be cancelled" });
};

// Technician: bookings assigned to the authenticated technician's email
export const getTechnicianBookings = async (req, res) => {
  const email = text(req.user.email).toLowerCase();
  if (!email) return res.status(403).json({ message: "Access forbidden" });

  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);

  const filter = { technicianEmail: email };
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const [items, total, counts] = await Promise.all([
    bookings()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    bookings().countDocuments(filter),
    countByStatus({ technicianEmail: email }),
  ]);

  res.json({
    bookings: items.map(toBooking),
    total,
    counts,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
};

// Technician: move an assigned booking through requested -> accepted/rejected -> in_progress -> completed
export const updateBookingStatus = async (req, res) => {
  const { id } = req.params;
  const email = text(req.user.email).toLowerCase();
  const body = req.body ?? {};
  const status = text(body.status);

  if (!email || !ID_PATTERN.test(id)) return res.status(404).json({ message: "Booking not found" });
  if (!TRANSITIONS[status]) {
    return res.status(400).json({ message: `Status must be one of: ${Object.keys(TRANSITIONS).join(", ")}` });
  }

  const set = { status, updatedAt: new Date() };

  if (status === "completed") {
    const { finalAmount } = body;
    if (typeof finalAmount !== "number" || !Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ message: "finalAmount must be a positive number" });
    }
    set.finalAmount = finalAmount;
    set.completedAt = set.updatedAt;
  }
  // A rejected or completed booking no longer blocks the customer from booking again
  if (status === "rejected" || status === "completed") set.isActive = false;

  const filter = { _id: new ObjectId(id), technicianEmail: email };

  // Atomic: assigned to this technician AND currently in the required previous status
  const updated = await bookings().findOneAndUpdate(
    { ...filter, status: TRANSITIONS[status] },
    { $set: set },
    { returnDocument: "after" }
  );

  if (updated) return res.json({ message: `Booking ${status}`, booking: toBooking(updated) });

  const exists = await bookings().countDocuments(filter);
  if (!exists) return res.status(404).json({ message: "Booking not found" });

  res.status(409).json({ message: `Booking cannot move to "${status}" from its current status` });
};
