// Integration test: a new booking takes technicianName/technicianEmail from the service.
// Needs a running server with the latest code (API_URL, default BETTER_AUTH_URL).
// Creates one temporary customer + one temporary service and removes only those afterwards.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import connectDB, { client, db } from "../config/db.js";

dotenv.config({ quiet: true });

const AUTH_URL = process.env.BETTER_AUTH_URL;
const API_URL = process.env.API_URL || AUTH_URL;
const ORIGIN = process.env.FRONTEND_URL;
const email = `fm-test-booking-${Date.now()}@example.test`;

let token, userId, serviceId;
const techEmail = "fm-test-tech@example.test"; // matches the test service's technicianEmail
const otherTechEmail = "fm-test-other-tech@example.test";
const extraEmails = [techEmail, otherTechEmail];
const bookingBody = () => ({
  serviceId: serviceId.toString(),
  preferredDate: "2030-01-15",
  preferredTime: "09:00-12:00",
  phone: "01700000000",
  problemDescription: "Automated test booking, please ignore.",
});
const createBooking = (body) =>
  fetch(`${API_URL}/api/bookings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await connectDB();

  const signUp = await fetch(`${AUTH_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password: "Test-pass-12345", name: "FM Test" }),
  });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  userId = (await signUp.json()).user.id;
  ({ token } = await (await fetch(`${AUTH_URL}/api/auth/token`, { headers: { Cookie: cookie, Origin: ORIGIN } })).json());

  ({ insertedId: serviceId } = await db.collection("services").insertOne({
    title: "FM TEST booking service", description: "test", category: "AC", mode: "In-shop", price: 10,
    technician: "Test Technician", technicianEmail: "fm-test-tech@example.test",
    imageUrl: null, status: "approved", available: true, featured: false, createdAt: "2026-01-01",
  }));
});

after(async () => {
  await db.collection("bookings").deleteMany({ customerId: userId });
  await db.collection("services").deleteOne({ _id: serviceId });
  await db.collection("session").deleteMany({ userId });
  await db.collection("account").deleteMany({ userId });
  await db.collection("user").deleteOne({ email });
  // Technician test users (their bookings belong to the customer above, already removed)
  const techUsers = await db.collection("user").find({ email: { $in: extraEmails } }).toArray();
  const techIds = techUsers.map((u) => u._id.toString());
  await db.collection("session").deleteMany({ userId: { $in: techIds } });
  await db.collection("account").deleteMany({ userId: { $in: techIds } });
  await db.collection("user").deleteMany({ email: { $in: extraEmails } });
  await client.close();
});

test("booking stores technicianName and technicianEmail from the service, ignoring the request body", async () => {
  const { status, body } = await createBooking({
    ...bookingBody(),
    technicianName: "Attacker",
    technicianEmail: "attacker@example.test",
    technician: "Attacker",
  });
  assert.equal(status, 201);

  const saved = await db.collection("bookings").findOne({ _id: new ObjectId(body.booking.id) });
  assert.equal(saved.technicianName, "Test Technician");
  assert.equal(saved.technician, "Test Technician");
  assert.equal(saved.technicianEmail, "fm-test-tech@example.test");
  assert.equal(body.booking.technicianName, "Test Technician");
  assert.equal(saved.status, "requested");
  assert.equal(saved.customerId, userId);
});

test("duplicate active booking for the same service is still rejected", async () => {
  const { status } = await createBooking(bookingBody());
  assert.equal(status, 409);
});

// ---- Technician dashboard endpoints ----

// Creates a user with the given role and returns a fresh JWT for it
const makeUser = async (userEmail, role) => {
  const signUp = await fetch(`${AUTH_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email: userEmail, password: "Test-pass-12345", name: "FM Test Tech" }),
  });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await db.collection("user").updateOne({ email: userEmail }, { $set: { role } });
  const result = await (await fetch(`${AUTH_URL}/api/auth/token`, { headers: { Cookie: cookie, Origin: ORIGIN } })).json();
  return result.token;
};

const call = (method, path, authToken, body) =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

let techToken, otherTechToken, bookingId;

test("technician list returns only own bookings, with counts that ignore the status filter", async () => {
  techToken = await makeUser(techEmail, "technician");
  otherTechToken = await makeUser(otherTechEmail, "technician");

  const all = await call("GET", "/api/bookings/technician", techToken);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 1);
  assert.equal(all.body.bookings[0].technicianEmail, techEmail);
  bookingId = all.body.bookings[0].id;
  assert.deepEqual(all.body.counts, { total: 1, requested: 1, accepted: 0, in_progress: 0, completed: 0, cancelled: 0, rejected: 0 });

  // A filter changes the list and "total", but not the counts
  const filtered = await call("GET", "/api/bookings/technician?status=completed", techToken);
  assert.equal(filtered.body.total, 0);
  assert.equal(filtered.body.bookings.length, 0);
  assert.equal(filtered.body.counts.total, 1);
  assert.equal(filtered.body.counts.requested, 1);

  // Another technician sees nothing and has all-zero counts
  const other = await call("GET", "/api/bookings/technician", otherTechToken);
  assert.equal(other.body.total, 0);
  assert.equal(other.body.counts.total, 0);
});

test("customers cannot use technician routes and technicians cannot use customer routes", async () => {
  assert.equal((await call("GET", "/api/bookings/technician", token)).status, 403);
  assert.equal((await call("PATCH", `/api/bookings/technician/${bookingId}/status`, token, { status: "accepted" })).status, 403);
  assert.equal((await call("GET", "/api/bookings/my", techToken)).status, 403);
  assert.equal((await fetch(`${API_URL}/api/bookings/technician`)).status, 401);
});

test("another technician cannot update this booking (404), and it stays requested", async () => {
  const res = await call("PATCH", `/api/bookings/technician/${bookingId}/status`, otherTechToken, { status: "accepted" });
  assert.equal(res.status, 404);
  assert.equal((await db.collection("bookings").findOne({ _id: new ObjectId(bookingId) })).status, "requested");
});

test("status moves follow the allowed order and completing needs a positive finalAmount", async () => {
  const move = (status, extra) => call("PATCH", `/api/bookings/technician/${bookingId}/status`, techToken, { status, ...extra });

  assert.equal((await move("in_progress")).status, 409); // cannot skip "accepted"
  assert.equal((await move("bogus")).status, 400);
  assert.equal((await move("accepted")).status, 200);
  assert.equal((await move("rejected")).status, 409); // too late to reject
  assert.equal((await move("in_progress")).status, 200);

  assert.equal((await move("completed")).status, 400); // no finalAmount
  assert.equal((await move("completed", { finalAmount: 0 })).status, 400);
  assert.equal((await move("completed", { finalAmount: "50" })).status, 400);

  const done = await move("completed", { finalAmount: 55 });
  assert.equal(done.status, 200);
  assert.equal(done.body.booking.finalAmount, 55);
  assert.equal(done.body.booking.isActive, false);

  const list = await call("GET", "/api/bookings/technician", techToken);
  assert.deepEqual(list.body.counts, { total: 1, requested: 0, accepted: 0, in_progress: 0, completed: 1, cancelled: 0, rejected: 0 });
});
