import { ObjectId } from "mongodb";
import { db } from "../config/db.js";

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  "price-low-to-high": { price: 1, _id: -1 },
  "price-high-to-low": { price: -1, _id: -1 },
  price_asc: { price: 1, _id: -1 },
  price_desc: { price: -1, _id: -1 },
};

// Match the frontend `Service` type: expose `_id` as `id`.
export const toService = ({ _id, ...rest }) => ({ id: _id.toString(), ...rest });

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getServices = async (req, res) => {
  const { search, category, mode, sort = "newest" } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 9, 1), 50);

  // The public API only shows services that are approved AND available
  const filter = { status: "approved", available: true };

  if (typeof category === "string" && category) filter.category = category;
  if (typeof mode === "string" && mode) filter.mode = mode;
  if (typeof search === "string" && search.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ title: regex }, { description: regex }, { technician: regex }];
  }

  const services = db.collection("services");
  const [items, total] = await Promise.all([
    services
      .find(filter)
      .sort(SORTS[sort] || SORTS.newest)
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

export const getServiceById = async (req, res) => {
  const { id } = req.params;
  const service = ObjectId.isValid(id)
    ? await db
        .collection("services")
        .findOne({ _id: new ObjectId(id), status: "approved", available: true })
    : null;

  if (!service) {
    return res.status(404).json({ message: "Service not found" });
  }

  res.json(toService(service));
};

// ---------------------------------------------------------------------------
// Technician service management. The technician is always taken from the token,
// never from the request body, and every query is limited to the technician's own services.
// ---------------------------------------------------------------------------

const CATEGORIES = ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"];
const MODES = ["On-site", "In-shop", "Pickup & Drop"];
const SERVICE_STATUSES = ["pending", "approved", "rejected"];
const ID_PATTERN = /^[a-f\d]{24}$/i;

// Only plain strings are accepted (blocks objects like { $gt: "" } from the body).
const text = (value) => (typeof value === "string" ? value.trim() : "");

// Returns { error } or { data } with only the fields a technician may set.
// status, featured, technician and technicianEmail in the body are ignored.
const validateService = (body = {}) => {
  const title = text(body.title);
  const description = text(body.description);
  const { price } = body;
  const imageUrl = text(body.imageUrl) || null;

  if (title.length < 3 || title.length > 100) return { error: "Title must be 3 to 100 characters" };
  if (description.length < 10 || description.length > 1000) return { error: "Description must be 10 to 1000 characters" };
  if (!CATEGORIES.includes(body.category)) return { error: `Category must be one of: ${CATEGORIES.join(", ")}` };
  if (!MODES.includes(body.mode)) return { error: `Mode must be one of: ${MODES.join(", ")}` };
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 100000) {
    return { error: "Price must be a number greater than 0" };
  }
  if (imageUrl && (!/^https:\/\/\S+$/.test(imageUrl) || imageUrl.length > 500)) {
    return { error: "Image must be an https link" };
  }
  if (body.available !== undefined && typeof body.available !== "boolean") {
    return { error: "Available must be true or false" };
  }

  return {
    data: { title, description, category: body.category, mode: body.mode, price, imageUrl, available: body.available ?? true },
  };
};

const technicianEmail = (req) => text(req.user.email).toLowerCase();

export const createService = async (req, res) => {
  const email = technicianEmail(req);
  if (!email) return res.status(403).json({ message: "Access forbidden" });

  const { error, data } = validateService(req.body);
  if (error) return res.status(400).json({ message: error });

  const now = new Date().toISOString();
  const service = {
    ...data,
    technician: req.user.name,
    technicianEmail: email,
    status: "pending", // an admin has to approve it before customers can see it
    featured: false,
    createdAt: now,
    updatedAt: now,
  };

  const { insertedId } = await db.collection("services").insertOne(service);
  res.status(201).json({ message: "Service created and sent for approval", service: toService({ _id: insertedId, ...service }) });
};

export const getMyServices = async (req, res) => {
  const email = technicianEmail(req);
  if (!email) return res.status(403).json({ message: "Access forbidden" });

  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 9, 1), 50);

  const filter = { technicianEmail: email };
  if (SERVICE_STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const services = db.collection("services");
  const [items, total, grouped] = await Promise.all([
    services
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    services.countDocuments(filter),
    // Counts cover all of this technician's services, whatever the status filter or page
    services.aggregate([{ $match: { technicianEmail: email } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
  ]);

  const counts = { total: 0, ...Object.fromEntries(SERVICE_STATUSES.map((s) => [s, 0])) };
  for (const { _id, count } of grouped) {
    counts.total += count;
    if (SERVICE_STATUSES.includes(_id)) counts[_id] = count;
  }

  res.json({ services: items.map(toService), total, counts, page, limit, totalPages: Math.ceil(total / limit) });
};

export const updateService = async (req, res) => {
  const { id } = req.params;
  const email = technicianEmail(req);
  if (!email || !ID_PATTERN.test(id)) return res.status(404).json({ message: "Service not found" });

  const { error, data } = validateService(req.body);
  if (error) return res.status(400).json({ message: error });

  // Atomic and limited to this technician's own service. Any edit sends it back for approval.
  const updated = await db
    .collection("services")
    .findOneAndUpdate(
      { _id: new ObjectId(id), technicianEmail: email },
      { $set: { ...data, status: "pending", updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );

  // Someone else's service looks exactly like a missing one
  if (!updated) return res.status(404).json({ message: "Service not found" });

  res.json({ message: "Service updated and sent for approval again", service: toService(updated) });
};

export const deleteService = async (req, res) => {
  const { id } = req.params;
  const email = technicianEmail(req);
  if (!email || !ID_PATTERN.test(id)) return res.status(404).json({ message: "Service not found" });

  const filter = { _id: new ObjectId(id), technicianEmail: email };
  const service = await db.collection("services").findOne(filter);
  if (!service) return res.status(404).json({ message: "Service not found" });

  // Customers with an open booking still depend on this service
  const openBookings = await db.collection("bookings").countDocuments({ serviceId: service._id, isActive: true });
  if (openBookings > 0) {
    return res.status(409).json({ message: "This service has active bookings and cannot be deleted yet" });
  }

  const { deletedCount } = await db.collection("services").deleteOne(filter);
  if (!deletedCount) return res.status(404).json({ message: "Service not found" });

  res.json({ message: "Service deleted" });
};
