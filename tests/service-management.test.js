// Technician service management + public service visibility, over real HTTP.
// Needs a running server with the latest code (API_URL, default BETTER_AUTH_URL).
// Creates temporary users (customer + two technicians) and temporary services, and removes only those.
// No admin account is created: "approval" is simulated by updating the temporary service directly.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import connectDB, { client, db } from "../config/db.js";

dotenv.config({ quiet: true });

const AUTH_URL = process.env.BETTER_AUTH_URL;
const API_URL = process.env.API_URL || AUTH_URL;
const ORIGIN = process.env.FRONTEND_URL;
const stamp = Date.now();
const emails = {
  customer: `fm-test-svc-cust-${stamp}@example.test`,
  techA: `fm-test-svc-a-${stamp}@example.test`,
  techB: `fm-test-svc-b-${stamp}@example.test`,
};
const tokens = {};
const created = []; // ids of temporary services, removed in after()

const makeUser = async (email, role, name) => {
  const signUp = await fetch(`${AUTH_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password: "Test-pass-12345", name }),
  });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await db.collection("user").updateOne({ email }, { $set: { role } }); // temporary test account only
  const { token } = await (await fetch(`${AUTH_URL}/api/auth/token`, { headers: { Cookie: cookie, Origin: ORIGIN } })).json();
  return token;
};

const call = (method, path, token, body) =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const valid = (extra = {}) => ({
  title: "FM TEST Screen Repair",
  description: "Temporary test service used by the automated tests.",
  category: "Smartphone",
  mode: "In-shop",
  price: 25,
  ...extra,
});
const inDb = (id) => db.collection("services").findOne({ _id: new ObjectId(id) });

before(async () => {
  await connectDB();
  tokens.customer = await makeUser(emails.customer, "customer", "FM Svc Customer");
  tokens.techA = await makeUser(emails.techA, "technician", "FM Tech A");
  tokens.techB = await makeUser(emails.techB, "technician", "FM Tech B");
});

after(async () => {
  await db.collection("bookings").deleteMany({ customerId: "fm-test-svc-customer" });
  await db.collection("services").deleteMany({ _id: { $in: created.map((id) => new ObjectId(id)) } });
  await db.collection("services").deleteMany({ title: /^FM TEST/ });
  const users = await db.collection("user").find({ email: { $in: Object.values(emails) } }).toArray();
  const ids = users.map((u) => u._id.toString());
  await db.collection("session").deleteMany({ userId: { $in: ids } });
  await db.collection("account").deleteMany({ userId: { $in: ids } });
  await db.collection("user").deleteMany({ email: { $in: Object.values(emails) } });
  await client.close();
});

let serviceId;

test("technician routes need a token (401) and the technician role (403)", async () => {
  const id = new ObjectId().toString();
  const routes = [["GET", "/api/services/mine"], ["POST", "/api/services"], ["PUT", `/api/services/${id}`], ["DELETE", `/api/services/${id}`]];
  for (const [method, path] of routes) {
    assert.equal((await call(method, path, null, valid())).status, 401, `no token ${method} ${path}`);
    assert.equal((await call(method, path, tokens.customer, valid())).status, 403, `customer ${method} ${path}`);
  }
  assert.equal((await call("GET", "/api/services")).status, 200); // the public list needs no login
});

test("a technician can create a service: it starts as pending and belongs to them", async () => {
  const { status, body } = await call("POST", "/api/services", tokens.techA, valid({
    status: "approved", featured: true, technician: "Attacker", technicianEmail: "attacker@example.test", // all ignored
  }));
  assert.equal(status, 201);
  serviceId = body.service.id;
  created.push(serviceId);

  const saved = await inDb(serviceId);
  assert.equal(saved.status, "pending");
  assert.equal(saved.featured, false);
  assert.equal(saved.available, true);
  assert.equal(saved.technicianEmail, emails.techA);
  assert.equal(saved.technician, "FM Tech A");
  assert.equal(saved.imageUrl, null);
});

test("invalid service data is rejected (400) and nothing is saved", async () => {
  const before = await db.collection("services").countDocuments({ technicianEmail: emails.techA });
  const bad = [
    { title: "ab" }, { title: "x".repeat(101) }, { title: undefined }, { title: { $gt: "" } },
    { description: "short" }, { category: "Cars" }, { category: undefined }, { mode: "Remote" },
    { price: 0 }, { price: -5 }, { price: "20" }, { price: null }, { price: 100001 },
    { imageUrl: "http://insecure.test/a.png" }, { imageUrl: "javascript:alert(1)" }, { available: "yes" },
  ];
  for (const change of bad) {
    const res = await call("POST", "/api/services", tokens.techA, valid(change));
    assert.equal(res.status, 400, JSON.stringify(change));
  }
  assert.equal(await db.collection("services").countDocuments({ technicianEmail: emails.techA }), before);
});

test("a pending service is hidden from the public API", async () => {
  assert.equal((await call("GET", `/api/services/${serviceId}`)).status, 404);
  const list = await call("GET", "/api/services?search=FM%20TEST&limit=50");
  assert.equal(list.body.services.some((s) => s.id === serviceId), false);
});

test("public APIs return only approved AND available services", async () => {
  // approve it (what an admin would do), then make it unavailable, then available again
  await db.collection("services").updateOne({ _id: new ObjectId(serviceId) }, { $set: { status: "approved" } });
  assert.equal((await call("GET", `/api/services/${serviceId}`)).status, 200);
  assert.equal((await call("GET", "/api/services?search=FM%20TEST&limit=50")).body.services.some((s) => s.id === serviceId), true);

  await db.collection("services").updateOne({ _id: new ObjectId(serviceId) }, { $set: { available: false } });
  assert.equal((await call("GET", `/api/services/${serviceId}`)).status, 404);
  assert.equal((await call("GET", "/api/services?search=FM%20TEST&limit=50")).body.services.some((s) => s.id === serviceId), false);

  // every service the public list returns is approved and available
  const all = (await call("GET", "/api/services?limit=50")).body.services;
  assert.ok(all.every((s) => s.status === "approved" && s.available === true));
  const total = (await call("GET", "/api/services")).body.total;
  assert.equal(total, await db.collection("services").countDocuments({ status: "approved", available: true }));

  await db.collection("services").updateOne({ _id: new ObjectId(serviceId) }, { $set: { available: true } });
});

test("a technician sees only their own services, with counts", async () => {
  const mine = await call("GET", "/api/services/mine", tokens.techA);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.services.every((s) => s.technicianEmail === emails.techA));
  assert.ok(mine.body.services.some((s) => s.id === serviceId));
  assert.deepEqual(mine.body.counts, { total: 1, pending: 0, approved: 1, rejected: 0 });

  const other = await call("GET", "/api/services/mine", tokens.techB);
  assert.equal(other.body.total, 0);
  assert.deepEqual(other.body.counts, { total: 0, pending: 0, approved: 0, rejected: 0 });

  const filtered = await call("GET", "/api/services/mine?status=rejected", tokens.techA);
  assert.equal(filtered.body.total, 0);
  assert.equal(filtered.body.counts.approved, 1); // counts ignore the filter
});

test("editing resets approval to pending, hides the service, and ignores forbidden fields", async () => {
  const { status, body } = await call("PUT", `/api/services/${serviceId}`, tokens.techA, valid({
    title: "FM TEST Screen Repair EDITED", price: 30, available: false,
    status: "approved", featured: true, technicianEmail: "attacker@example.test", technician: "Attacker",
  }));
  assert.equal(status, 200);
  assert.equal(body.service.status, "pending");

  const saved = await inDb(serviceId);
  assert.equal(saved.title, "FM TEST Screen Repair EDITED");
  assert.equal(saved.price, 30);
  assert.equal(saved.available, false);
  assert.equal(saved.status, "pending");
  assert.equal(saved.featured, false);
  assert.equal(saved.technicianEmail, emails.techA);
  assert.equal(saved.technician, "FM Tech A");

  assert.equal((await call("GET", `/api/services/${serviceId}`)).status, 404); // hidden until approved again
  assert.equal((await call("PUT", `/api/services/${serviceId}`, tokens.techA, valid({ price: 0 }))).status, 400);
  assert.equal((await inDb(serviceId)).price, 30); // a rejected edit changed nothing
  assert.equal((await call("PUT", `/api/services/${new ObjectId()}`, tokens.techA, valid())).status, 404);
  assert.equal((await call("PUT", "/api/services/not-an-id", tokens.techA, valid())).status, 404);
});

test("another technician cannot edit or delete someone else's service (404) and nothing changes", async () => {
  await db.collection("services").updateOne({ _id: new ObjectId(serviceId) }, { $set: { status: "approved" } });
  const snapshot = JSON.stringify(await inDb(serviceId));

  assert.equal((await call("PUT", `/api/services/${serviceId}`, tokens.techB, valid({ title: "FM TEST Hijacked" }))).status, 404);
  assert.equal((await call("DELETE", `/api/services/${serviceId}`, tokens.techB)).status, 404);
  assert.equal(JSON.stringify(await inDb(serviceId)), snapshot);
});

test("a service with active bookings cannot be deleted", async () => {
  const { insertedId } = await db.collection("bookings").insertOne({
    customerId: "fm-test-svc-customer", customerEmail: "x@example.test", serviceId: new ObjectId(serviceId),
    technicianEmail: emails.techA, status: "requested", isActive: true,
  });
  const res = await call("DELETE", `/api/services/${serviceId}`, tokens.techA);
  assert.equal(res.status, 409);
  assert.ok(await inDb(serviceId));

  await db.collection("bookings").deleteOne({ _id: insertedId });
});

test("a technician can delete their own service, once", async () => {
  const res = await call("DELETE", `/api/services/${serviceId}`, tokens.techA);
  assert.equal(res.status, 200);
  assert.equal(await inDb(serviceId), null);
  assert.equal((await call("DELETE", `/api/services/${serviceId}`, tokens.techA)).status, 404);
  assert.equal((await call("DELETE", "/api/services/not-an-id", tokens.techA)).status, 404);
});
