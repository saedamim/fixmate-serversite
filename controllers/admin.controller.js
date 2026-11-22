import { ObjectId } from "mongodb";
import { db } from "../config/db.js";
import { toBooking, countByStatus } from "./booking.controller.js";
import { toService } from "./service.controller.js";

const ROLES = ["customer", "technician", "admin"];
const SERVICE_STATUSES = ["pending", "approved", "rejected"];
const BOOKING_STATUSES = ["requested", "accepted", "in_progress", "completed", "cancelled", "rejected"];
const PAYMENT_STATUSES = ["pending", "paid", "failed", "cancelled"];
const ID_PATTERN = /^[a-f\d]{24}$/i;

// page / limit from the query string (limit is capped at 50)
export const paging = (query) => ({
  page: Math.max(parseInt(query.page) || 1, 1),
  limit: Math.min(Math.max(parseInt(query.limit) || 10, 1), 50),
});

// Number of documents per value of `field`, as { value: count } (always includes `values`, even at 0)
const countBy = async (collection, field, values) => {
  const grouped = await db
    .collection(collection)
    .aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }])
    .toArray();

  const counts = Object.fromEntries(values.map((value) => [value, 0]));
  for (const { _id, count } of grouped) if (values.includes(_id)) counts[_id] = count;
  return counts;
};

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

export const getStats = async (req, res) => {
  const [users, services, bookings, revenue] = await Promise.all([
    countBy("user", "role", ROLES),
    countBy("services", "status", SERVICE_STATUSES),
    countByStatus({}),
    // Revenue is only money that SSLCommerz validated (payments marked "paid"), never completed-but-unpaid work
    db
      .collection("payments")
      .aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }])
      .toArray(),
  ]);

  res.json({
    users: { total: sum(users), ...users },
    services: { total: sum(services), ...services },
    bookings,
    revenue: revenue[0]?.total ?? 0,
  });
};

// Read-only list of accounts. Only safe fields are returned (no passwords or sessions).
export const getUsers = async (req, res) => {
  const { page, limit } = paging(req.query);
  const filter = ROLES.includes(req.query.role) ? { role: req.query.role } : {};

  const users = db.collection("user");
  const [items, total] = await Promise.all([
    users
      .find(filter)
      .project({ name: 1, email: 1, role: 1, emailVerified: 1, createdAt: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    users.countDocuments(filter),
  ]);

  res.json({
    users: items.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
};

// All services whatever their status (the public API only shows approved ones)
export const getAllServices = async (req, res) => {
  const { page, limit } = paging(req.query);
  const filter = SERVICE_STATUSES.includes(req.query.status) ? { status: req.query.status } : {};

  const services = db.collection("services");
  const [items, total] = await Promise.all([
    services
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    services.countDocuments(filter),
  ]);

  res.json({
    services: items.map(toService),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
};

// Approve, reject or move a service back to pending
export const updateServiceStatus = async (req, res) => {
  const { id } = req.params;
  const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";

  if (!ID_PATTERN.test(id)) return res.status(404).json({ message: "Service not found" });
  if (!SERVICE_STATUSES.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${SERVICE_STATUSES.join(", ")}` });
  }

  const updated = await db
    .collection("services")
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { status } }, { returnDocument: "after" });

  if (!updated) return res.status(404).json({ message: "Service not found" });

  res.json({ message: `Service ${status}`, service: toService(updated) });
};

export const getAllBookings = async (req, res) => {
  const { page, limit } = paging(req.query);
  const filter = BOOKING_STATUSES.includes(req.query.status) ? { status: req.query.status } : {};

  const bookings = db.collection("bookings");
  const [items, total] = await Promise.all([
    bookings
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    bookings.countDocuments(filter),
  ]);

  res.json({
    bookings: items.map(toBooking),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
};

// Real payment records (not bookings). Safe fields only: no session key, validation id or provider data.
export const getTransactions = async (req, res) => {
  const { page, limit } = paging(req.query);
  const filter = PAYMENT_STATUSES.includes(req.query.status) ? { status: req.query.status } : {};

  const payments = db.collection("payments");
  const [items, total] = await Promise.all([
    payments
      .find(filter, { projection: { sessionKey: 0, valId: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    payments.countDocuments(filter),
  ]);

  res.json({
    transactions: items.map(({ _id, bookingId, ...payment }) => ({ id: _id.toString(), bookingId: bookingId.toString(), ...payment })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
};
