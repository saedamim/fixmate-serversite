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
const toService = ({ _id, ...rest }) => ({ id: _id.toString(), ...rest });

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getServices = async (req, res) => {
  const { search, category, mode, sort = "newest" } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 9, 1), 50);

  const filter = { status: "approved" };

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
        .findOne({ _id: new ObjectId(id), status: "approved" })
    : null;

  if (!service) {
    return res.status(404).json({ message: "Service not found" });
  }

  res.json(toService(service));
};
