// Admin API tests. Needs a running server with the latest code (API_URL, default BETTER_AUTH_URL).
//
// 1. Authorization over real HTTP: no token -> 401, customer / technician token -> 403 on every admin route.
//    (No admin account is created or needed for this.)
// 2. The admin controllers are called directly with a fake request, because no admin account exists to
//    sign in with. They run against the real database, using one temporary service that is removed afterwards.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import connectDB, { client, db } from "../config/db.js";
import {
  getStats,
  getUsers,
  getAllServices,
  updateServiceStatus,
  getAllBookings,
} from "../controllers/admin.controller.js";

dotenv.config({ quiet: true });

const AUTH_URL = process.env.BETTER_AUTH_URL;
const API_URL = process.env.API_URL || AUTH_URL;
const ORIGIN = process.env.FRONTEND_URL;
const emails = { customer: `fm-test-admin-cust-${Date.now()}@example.test`, technician: `fm-test-admin-tech-${Date.now()}@example.test` };
const tokens = {};
let serviceId;

// Creates a temporary user with the given (non-admin) role and returns a fresh JWT for it
const makeUser = async (email, role) => {
  const signUp = await fetch(`${AUTH_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password: "Test-pass-12345", name: "FM Admin Test" }),
  });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await db.collection("user").updateOne({ email }, { $set: { role } });
  const { token } = await (await fetch(`${AUTH_URL}/api/auth/token`, { headers: { Cookie: cookie, Origin: ORIGIN } })).json();
  return token;
};

const call = (method, path, token, body) =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  }).then((r) => r.status);

// Runs a controller with a fake request and returns { status, body }
const run = async (handler, { query = {}, params = {}, body } = {}) => {
  const out = { status: 200, body: undefined };
  const res = {
    status(code) { out.status = code; return res; },
    json(payload) { out.body = payload; return res; },
  };
  await handler({ query, params, body, user: { id: "fake-admin", role: "admin" } }, res);
  return out;
};

before(async () => {
  await connectDB();
  tokens.customer = await makeUser(emails.customer, "customer");
  tokens.technician = await makeUser(emails.technician, "technician");

  ({ insertedId: serviceId } = await db.collection("services").insertOne({
    title: "FM ADMIN TEST pending service", description: "test", category: "AC", mode: "On-site", price: 10,
    technician: "Test Technician", technicianEmail: "fm-test-admin-tech2@example.test",
    imageUrl: null, status: "pending", available: true, featured: false, createdAt: "2030-01-01",
  }));
});

after(async () => {
  await db.collection("services").deleteOne({ _id: serviceId });
  const users = await db.collection("user").find({ email: { $in: Object.values(emails) } }).toArray();
  const ids = users.map((u) => u._id.toString());
  await db.collection("session").deleteMany({ userId: { $in: ids } });
  await db.collection("account").deleteMany({ userId: { $in: ids } });
  await db.collection("user").deleteMany({ email: { $in: Object.values(emails) } });
  await client.close();
});

// ---- 1. authorization (real HTTP) ----

const routes = [
  ["GET", "/api/admin/stats"],
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/services"],
  ["GET", "/api/admin/bookings"],
  ["PATCH", `/api/admin/services/${new ObjectId()}/status`],
];

test("admin routes reject requests without a token (401)", async () => {
  for (const [method, path] of routes) assert.equal(await call(method, path, null, { status: "approved" }), 401, `${method} ${path}`);
});

test("admin routes reject customer and technician tokens (403)", async () => {
  for (const role of ["customer", "technician"]) {
    for (const [method, path] of routes) {
      assert.equal(await call(method, path, tokens[role], { status: "approved" }), 403, `${role} ${method} ${path}`);
    }
  }
});

test("a denied service update does not change the service", async () => {
  assert.equal(await call("PATCH", `/api/admin/services/${serviceId}/status`, tokens.customer, { status: "approved" }), 403);
  assert.equal((await db.collection("services").findOne({ _id: serviceId })).status, "pending");
});

// ---- 2. controllers (real database) ----

test("stats match the database", async () => {
  const { body } = await run(getStats);
  const count = (coll, q = {}) => db.collection(coll).countDocuments(q);

  assert.equal(body.users.total, await count("user"));
  assert.equal(body.users.customer, await count("user", { role: "customer" }));
  assert.equal(body.users.technician, await count("user", { role: "technician" }));
  assert.equal(body.users.admin, await count("user", { role: "admin" }));
  assert.equal(body.services.total, await count("services"));
  assert.equal(body.services.pending, await count("services", { status: "pending" }));
  assert.equal(body.services.approved, await count("services", { status: "approved" }));
  assert.equal(body.bookings.total, await count("bookings"));
  assert.equal(body.bookings.completed, await count("bookings", { status: "completed" }));

  const completed = await db.collection("bookings").find({ status: "completed" }).toArray();
  assert.equal(body.revenue, completed.reduce((total, b) => total + (b.finalAmount ?? 0), 0));
});

test("users list is paginated, filterable and never exposes secrets", async () => {
  const all = (await run(getUsers, { query: { limit: "50" } })).body;
  assert.equal(all.total, await db.collection("user").countDocuments());
  for (const user of all.users) {
    assert.deepEqual(Object.keys(user).filter((k) => !["id", "name", "email", "role", "emailVerified", "createdAt"].includes(k)), []);
  }

  const customers = (await run(getUsers, { query: { role: "customer", limit: "1" } })).body;
  assert.equal(customers.users.length, 1);
  assert.equal(customers.users[0].role, "customer");
  assert.equal(customers.limit, 1);
  assert.equal(customers.totalPages, customers.total);
});

test("services list shows every status and filters by status", async () => {
  const pending = (await run(getAllServices, { query: { status: "pending", limit: "50" } })).body;
  assert.ok(pending.services.every((s) => s.status === "pending"));
  assert.ok(pending.services.some((s) => s.id === serviceId.toString()), "the pending test service is listed");

  const all = (await run(getAllServices, { query: { limit: "50" } })).body;
  assert.equal(all.total, await db.collection("services").countDocuments());
});

test("service status can be approved, rejected and set back, with validation", async () => {
  const update = (id, status) => run(updateServiceStatus, { params: { id }, body: { status } });

  const approved = await update(serviceId.toString(), "approved");
  assert.equal(approved.status, 200);
  assert.equal(approved.body.service.status, "approved");
  assert.equal((await db.collection("services").findOne({ _id: serviceId })).status, "approved");

  assert.equal((await update(serviceId.toString(), "rejected")).body.service.status, "rejected");
  assert.equal((await update(serviceId.toString(), "pending")).body.service.status, "pending");

  assert.equal((await update(serviceId.toString(), "published")).status, 400);
  assert.equal((await update(serviceId.toString(), { $ne: "x" })).status, 400);
  assert.equal((await update("not-an-id", "approved")).status, 404);
  assert.equal((await update(new ObjectId().toString(), "approved")).status, 404);
  assert.equal((await db.collection("services").findOne({ _id: serviceId })).status, "pending"); // invalid calls changed nothing
});

test("bookings list covers all bookings and filters by status", async () => {
  const all = (await run(getAllBookings, { query: { limit: "50" } })).body;
  assert.equal(all.total, await db.collection("bookings").countDocuments());

  const cancelled = (await run(getAllBookings, { query: { status: "cancelled" } })).body;
  assert.ok(cancelled.bookings.every((b) => b.status === "cancelled"));
  assert.equal(cancelled.total, await db.collection("bookings").countDocuments({ status: "cancelled" }));
});
