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
