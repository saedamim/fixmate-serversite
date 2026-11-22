// Stripe payment tests. Stripe is MOCKED (checkout.sessions.create/retrieve), so no request reaches Stripe and no
// money moves. Webhook signatures use Stripe's own library with a fake secret, so real signature checking runs.
// Controllers run against the real database using temporary bookings that are removed afterwards.
// The HTTP checks need a running server with the latest code (API_URL, default BETTER_AUTH_URL).
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import Stripe from "stripe";
import { ObjectId } from "mongodb";
import connectDB, { client, db } from "../config/db.js";
import { useStripe } from "../config/stripe.js";
import { createCheckoutSession, verifyPayment, handleWebhook, getMyPayments } from "../controllers/payment.controller.js";
import { getTransactions, getStats } from "../controllers/admin.controller.js";

dotenv.config({ quiet: true });
process.env.STRIPE_SECRET_KEY = "sk_test_fm_dummy_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fm_test_secret";

const AUTH_URL = process.env.BETTER_AUTH_URL;
const API_URL = process.env.API_URL || AUTH_URL;
const ORIGIN = process.env.FRONTEND_URL;
const stamp = Date.now();
const CUSTOMER = { id: `fm-test-pay-cust-${stamp}`, name: "FM Pay Test", email: `fm-test-pay-${stamp}@example.test` };
const OTHER = { id: `fm-test-pay-other-${stamp}`, name: "FM Pay Other", email: `fm-test-pay-other-${stamp}@example.test` };
const mailbox = `fm-test-pay-http-${stamp}@example.test`;
const bookingIds = [];

// Offline Stripe object: only its webhook signature code is real
const stripeLib = new Stripe("sk_test_fm_dummy_key");
let created; // arguments of checkout.sessions.create calls
let remote; // what Stripe "knows": sessionId -> session object returned by retrieve
let counter = 0;
const mock = {
  checkout: {
    sessions: {
      create: async (params) => {
        const id = `cs_test_fm${stamp}x${++counter}`;
        created.push(params);
        remote[id] = { id, mode: "payment", currency: "usd", payment_status: "unpaid", amount_total: params.line_items[0].price_data.unit_amount, payment_intent: `pi_fm${counter}`, metadata: params.metadata };
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      },
      retrieve: async (id) => {
        if (!remote[id]) throw new Error("No such checkout.session");
        return remote[id];
      },
    },
  },
  webhooks: stripeLib.webhooks,
};

const run = async (handler, { user, body, query = {}, headers = {} } = {}) => {
  const out = { status: 200, body: undefined };
  const res = { status(c) { out.status = c; return res; }, json(p) { out.body = p; return res; } };
  await handler({ user, body, query, headers, params: {} }, res);
  return out;
};

const newBooking = async (overrides = {}) => {
  const { insertedId } = await db.collection("bookings").insertOne({
    customerId: CUSTOMER.id, serviceId: new ObjectId(), serviceTitle: "FM TEST pay service", category: "AC",
    technician: "Test Technician", technicianName: "Test Technician", technicianEmail: "fm-test-tech@example.test",
    status: "completed", isActive: false, paymentStatus: "unpaid", finalAmount: 75.5,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  });
  bookingIds.push(insertedId);
  return insertedId;
};
const checkout = (bookingId, user = CUSTOMER, extra = {}) =>
  run(createCheckoutSession, { user, body: { bookingId: bookingId.toString(), ...extra } });
const paymentFor = (bookingId) => db.collection("payments").findOne({ bookingId });
const booking = (id) => db.collection("bookings").findOne({ _id: id });
const verify = (sessionId, user = CUSTOMER) => run(verifyPayment, { user, query: { session_id: sessionId } });
const markPaidAtStripe = (sessionId, fields = {}) => { Object.assign(remote[sessionId], { payment_status: "paid" }, fields); };

// A webhook request signed with Stripe's own algorithm
const webhook = (event, { secret = process.env.STRIPE_WEBHOOK_SECRET, tamper = false } = {}) => {
  const payload = JSON.stringify(event);
  const signature = stripeLib.webhooks.generateTestHeaderString({ payload, secret });
  return run(handleWebhook, { body: Buffer.from(tamper ? payload.replace("checkout.session", "checkout.sessio_") : payload), headers: { "stripe-signature": signature } });
};
const sessionEvent = (type, sessionId) => ({ id: `evt_fm_${++counter}`, object: "event", type, data: { object: remote[sessionId] } });

before(async () => {
  await connectDB();
  useStripe(mock);
});
beforeEach(() => { created = []; remote = {}; });

after(async () => {
  useStripe(undefined);
  await db.collection("payments").deleteMany({ bookingId: { $in: bookingIds } });
  await db.collection("bookings").deleteMany({ _id: { $in: bookingIds } });
  await db.collection("session").deleteMany({ userId: mailbox });
  await db.collection("user").deleteOne({ email: mailbox });
  await client.close();
});

// ---- checkout creation ----

test("checkout: own completed unpaid booking; amount comes from the database, client values are ignored", async () => {
  const id = await newBooking({ finalAmount: 75.5 });
  const r = await checkout(id, CUSTOMER, { amount: 1, finalAmount: 1, currency: "eur", paymentStatus: "paid", status: "paid" });
  assert.equal(r.status, 201);
  assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);

  const params = created[0];
  assert.equal(params.mode, "payment");
  assert.equal(params.line_items[0].price_data.unit_amount, 7550); // 75.50 * 100, from the booking
  assert.equal(params.line_items[0].price_data.currency, "usd");
  assert.deepEqual(params.metadata, { bookingId: id.toString(), customerEmail: CUSTOMER.email });
  assert.equal(params.success_url, `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(params.cancel_url, `${process.env.FRONTEND_URL}/payment/cancel`);

  const saved = await paymentFor(id);
  assert.equal(saved.paymentStatus, "pending");
  assert.equal(saved.amount, 75.5);
  assert.equal(saved.stripeSessionId, r.body.sessionId);
  assert.equal((await booking(id)).paymentStatus, "unpaid");
});

test("checkout: another customer's booking is 'not found'; bad ids are rejected", async () => {
  const id = await newBooking();
  assert.equal((await checkout(id, OTHER)).status, 404);
  assert.equal((await run(createCheckoutSession, { user: CUSTOMER, body: { bookingId: { $ne: "x" } } })).status, 404);
  assert.equal((await run(createCheckoutSession, { user: CUSTOMER, body: {} })).status, 404);
  assert.equal(await paymentFor(id), null);
  assert.equal(created.length, 0);
});

test("checkout: only completed + unpaid bookings can be paid", async () => {
  for (const overrides of [{ status: "requested" }, { status: "accepted" }, { status: "in_progress" }, { status: "cancelled" }, { paymentStatus: "paid" }, { finalAmount: undefined }, { finalAmount: 0 }, { finalAmount: 0.2 }]) {
    const id = await newBooking(overrides);
    assert.equal((await checkout(id)).status, 409, JSON.stringify(overrides));
    assert.equal(await paymentFor(id), null);
  }
  assert.equal(created.length, 0);
});

test("checkout: duplicate attempts reuse the open session; a paid booking cannot be paid again", async () => {
  const id = await newBooking();
  const first = await checkout(id);
  const second = await checkout(id);
  assert.equal(second.status, 200);
  assert.equal(second.body.url, first.body.url);
  assert.equal(created.length, 1);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id }), 1);

  markPaidAtStripe(first.body.sessionId);
  assert.equal((await verify(first.body.sessionId)).status, 200);
  assert.equal((await checkout(id)).status, 409);
});

test("checkout: simultaneous requests create only one session", async () => {
  const id = await newBooking();
  const results = await Promise.all([checkout(id), checkout(id), checkout(id)]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.every((r) => [201, 200, 409].includes(r.status)));
  assert.equal(created.length, 1);
});

test("checkout: an expired open session is replaced; a failed Stripe call is recorded and can be retried", async () => {
  const id = await newBooking();
  const first = await checkout(id);
  await db.collection("payments").updateOne({ bookingId: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const second = await checkout(id);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.sessionId, first.body.sessionId);

  const id2 = await newBooking();
  const original = mock.checkout.sessions.create;
  mock.checkout.sessions.create = async () => { throw new Error("stripe down"); };
  assert.equal((await checkout(id2)).status, 502);
  assert.equal((await paymentFor(id2)).paymentStatus, "failed");
  mock.checkout.sessions.create = original;
  assert.equal((await checkout(id2)).status, 201);
});

test("checkout: refuses without a Stripe TEST key (live keys are never used)", async () => {
  const id = await newBooking();
  useStripe(undefined);
  const key = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_live_should_never_work";
  assert.equal((await checkout(id)).status, 503);
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await checkout(id)).status, 503);
  process.env.STRIPE_SECRET_KEY = key;
  useStripe(mock);
  assert.equal(created.length, 0);
});

// ---- verification ----

test("verify: a paid session marks the booking and payment paid, and keeps customer/service/technician details", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  markPaidAtStripe(body.sessionId);

  const r = await verify(body.sessionId);
  assert.equal(r.status, 200);
  const payment = await paymentFor(id);
  assert.equal(payment.paymentStatus, "paid");
  assert.equal(payment.transactionId, remote[body.sessionId].payment_intent);
  assert.equal(payment.stripeSessionId, body.sessionId);
  assert.equal(payment.amount, 75.5);
  assert.equal(payment.currency, "usd");
  assert.ok(payment.paidAt instanceof Date);
  assert.equal(payment.customerId, CUSTOMER.id);
  assert.equal(payment.customerEmail, CUSTOMER.email);
  assert.equal(payment.serviceTitle, "FM TEST pay service");
  assert.equal(payment.technicianEmail, "fm-test-tech@example.test");
  assert.equal(payment.technicianName, "Test Technician");
  assert.equal(payment.checkoutUrl, undefined);
  assert.equal((await booking(id)).paymentStatus, "paid");
  assert.equal(r.body.payment.status, "paid");
});

test("verify: repeating the verification is idempotent (one record, same paidAt)", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  markPaidAtStripe(body.sessionId);
  await verify(body.sessionId);
  const first = await paymentFor(id);
  const bookingPaidAt = (await booking(id)).paidAt;

  const again = await verify(body.sessionId);
  assert.equal(again.status, 200);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id }), 1);
  assert.deepEqual((await paymentFor(id)).paidAt, first.paidAt);
  assert.deepEqual((await booking(id)).paidAt, bookingPaidAt);
});

test("verify: unpaid sessions, invalid ids, other customers' sessions and Stripe errors change nothing", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);

  assert.equal((await verify(body.sessionId)).status, 402); // Stripe says "unpaid"
  assert.equal((await verify("not-a-session")).status, 400);
  assert.equal((await verify("cs_test_doesnotexist")).status, 404); // not one of our checkouts
  assert.equal((await run(verifyPayment, { user: CUSTOMER, query: {} })).status, 400);
  assert.equal((await run(verifyPayment, { user: CUSTOMER, query: { session_id: { $ne: "x" } } })).status, 400);

  markPaidAtStripe(body.sessionId);
  assert.equal((await verify(body.sessionId, OTHER)).status, 404); // someone else's session
  delete remote[body.sessionId]; // Stripe does not know it (or is unreachable)
  assert.equal((await verify(body.sessionId)).status, 502);

  assert.equal((await paymentFor(id)).paymentStatus, "pending");
  assert.equal((await booking(id)).paymentStatus, "unpaid");
});

test("verify: amount, currency, booking metadata, customer metadata and booking status must all match", async () => {
  const cases = [
    ["amount", { amount_total: 100 }],
    ["currency", { currency: "eur" }],
    ["booking metadata", { metadata: { bookingId: new ObjectId().toString(), customerEmail: CUSTOMER.email } }],
    ["customer metadata", { metadata: { customerEmail: "someone@else.test" } }],
    ["mode", { mode: "subscription" }],
    ["payment intent", { payment_intent: null }],
  ];
  for (const [name, change] of cases) {
    const id = await newBooking();
    const { body } = await checkout(id);
    markPaidAtStripe(body.sessionId, { ...change, metadata: { ...remote[body.sessionId].metadata, ...change.metadata } });
    assert.equal((await verify(body.sessionId)).status, 409, name);
    assert.equal((await paymentFor(id)).paymentStatus, "pending", name);
    assert.equal((await booking(id)).paymentStatus, "unpaid", name);
  }

  const id = await newBooking();
  const { body } = await checkout(id);
  await db.collection("bookings").updateOne({ _id: id }, { $set: { status: "in_progress" } });
  markPaidAtStripe(body.sessionId);
  assert.equal((await verify(body.sessionId)).status, 409);
  assert.equal((await booking(id)).paymentStatus, "unpaid");
});

test("verify: a second paid session for an already-paid booking is flagged for refund, not double-counted", async () => {
  const id = await newBooking();
  const first = (await checkout(id)).body;
  await db.collection("payments").updateOne({ stripeSessionId: first.sessionId }, { $set: { paymentStatus: "cancelled" } });
  const second = (await checkout(id)).body; // a customer who paid in two tabs
  markPaidAtStripe(second.sessionId);
  assert.equal((await verify(second.sessionId)).status, 200);

  markPaidAtStripe(first.sessionId);
  assert.equal((await verify(first.sessionId)).status, 409);
  const flagged = await db.collection("payments").findOne({ stripeSessionId: first.sessionId });
  assert.equal(flagged.paymentStatus, "failed");
  assert.equal(flagged.reviewRequired, true);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id, paymentStatus: "paid" }), 1);
});

// ---- webhook ----

test("webhook: a correctly signed paid event marks the booking paid; duplicate events change nothing", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  markPaidAtStripe(body.sessionId);
  const event = sessionEvent("checkout.session.completed", body.sessionId);

  assert.equal((await webhook(event)).status, 200);
  const paid = await paymentFor(id);
  assert.equal(paid.paymentStatus, "paid");
  assert.equal(paid.transactionId, remote[body.sessionId].payment_intent);
  assert.equal((await booking(id)).paymentStatus, "paid");

  assert.equal((await webhook(event)).status, 200); // Stripe redelivers
  assert.equal((await webhook(sessionEvent("checkout.session.async_payment_succeeded", body.sessionId))).status, 200);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id }), 1);
  assert.deepEqual((await paymentFor(id)).paidAt, paid.paidAt);

  // the redirect-based verification afterwards is also a no-op
  assert.equal((await verify(body.sessionId)).status, 200);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id }), 1);
});

test("webhook: missing, forged, wrong-secret and tampered signatures are rejected and change nothing", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  markPaidAtStripe(body.sessionId);
  const event = sessionEvent("checkout.session.completed", body.sessionId);
  const raw = Buffer.from(JSON.stringify(event));

  assert.equal((await run(handleWebhook, { body: raw, headers: {} })).status, 400);
  assert.equal((await run(handleWebhook, { body: raw, headers: { "stripe-signature": "t=1,v1=deadbeef" } })).status, 400);
  assert.equal((await webhook(event, { secret: "whsec_someone_else" })).status, 400);
  assert.equal((await webhook(event, { tamper: true })).status, 400);
  assert.equal((await run(handleWebhook, { body: event, headers: {} })).status, 400); // a parsed (non-raw) body

  assert.equal((await paymentFor(id)).paymentStatus, "pending");
  assert.equal((await booking(id)).paymentStatus, "unpaid");
});

test("webhook: events that are unpaid, unknown, or about a mismatching amount never mark a booking paid", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  // delayed payment method: completed but not yet paid
  assert.equal((await webhook(sessionEvent("checkout.session.completed", body.sessionId))).status, 200);
  assert.equal((await booking(id)).paymentStatus, "unpaid");

  // a signed event about a session that is not ours
  remote.cs_test_stranger = { id: "cs_test_stranger", mode: "payment", currency: "usd", payment_status: "paid", amount_total: 7550, payment_intent: "pi_x", metadata: { bookingId: id.toString(), customerEmail: CUSTOMER.email } };
  assert.equal((await webhook(sessionEvent("checkout.session.completed", "cs_test_stranger"))).status, 200);
  assert.equal((await booking(id)).paymentStatus, "unpaid");

  // our session, but the paid amount is wrong
  markPaidAtStripe(body.sessionId, { amount_total: 100 });
  assert.equal((await webhook(sessionEvent("checkout.session.completed", body.sessionId))).status, 200);
  assert.equal((await booking(id)).paymentStatus, "unpaid");
  assert.equal((await paymentFor(id)).paymentStatus, "pending");
});

test("webhook: expired and failed sessions close the attempt (never paid) and allow a new checkout", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  assert.equal((await webhook(sessionEvent("checkout.session.expired", body.sessionId))).status, 200);
  assert.equal((await paymentFor(id)).paymentStatus, "cancelled");
  assert.equal((await booking(id)).paymentStatus, "unpaid");
  assert.equal((await checkout(id)).status, 201);

  const id2 = await newBooking();
  const second = (await checkout(id2)).body;
  assert.equal((await webhook(sessionEvent("checkout.session.async_payment_failed", second.sessionId))).status, 200);
  assert.equal((await paymentFor(id2)).paymentStatus, "failed");
  assert.equal((await booking(id2)).paymentStatus, "unpaid");
});

test("webhook: not configured -> 503", async () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal((await run(handleWebhook, { body: Buffer.from("{}"), headers: {} })).status, 503);
  process.env.STRIPE_WEBHOOK_SECRET = secret;
});

// ---- history, admin, revenue ----

test("history: a customer sees only their own payments", async () => {
  const mine = await newBooking();
  const theirs = await newBooking({ customerId: OTHER.id });
  await checkout(mine);
  await checkout(theirs, OTHER);

  const r = await run(getMyPayments, { user: CUSTOMER });
  assert.equal(r.status, 200);
  assert.ok(r.body.payments.some((p) => p.bookingId === mine.toString()));
  assert.ok(r.body.payments.every((p) => p.bookingId !== theirs.toString()));
  for (const p of r.body.payments) assert.equal(p.checkoutUrl, undefined);
  const other = await run(getMyPayments, { user: OTHER });
  assert.ok(other.body.payments.every((p) => p.bookingId === theirs.toString()));
});

test("admin transactions: real payment records, filterable, without checkout links", async () => {
  const id = await newBooking();
  const { body } = await checkout(id);
  markPaidAtStripe(body.sessionId);
  await verify(body.sessionId);

  const r = await run(getTransactions, { user: { id: "fake-admin", role: "admin" }, query: { status: "paid", limit: "50" } });
  assert.equal(r.status, 200);
  const row = r.body.transactions.find((t) => t.bookingId === id.toString());
  assert.equal(row.paymentStatus, "paid");
  assert.equal(row.amount, 75.5);
  assert.equal(row.currency, "usd");
  assert.equal(row.transactionId, remote[body.sessionId].payment_intent);
  assert.equal(row.checkoutUrl, undefined);
  assert.ok(r.body.transactions.every((t) => t.paymentStatus === "paid"));
});

test("revenue: counts only genuinely paid payments, never unpaid completed bookings or open checkouts", async () => {
  const revenue = async () => (await run(getStats, { user: { id: "fake-admin", role: "admin" } })).body.revenue;
  const base = await revenue();

  const unpaid = await newBooking({ finalAmount: 7000 }); // completed but unpaid
  assert.equal(await revenue(), base);
  const open = (await checkout(unpaid)).body; // checkout started, not paid
  assert.equal(await revenue(), base);
  await webhook(sessionEvent("checkout.session.expired", open.sessionId));
  assert.equal(await revenue(), base);

  const other = await newBooking({ finalAmount: 20 });
  const { body } = await checkout(other);
  markPaidAtStripe(body.sessionId);
  await verify(body.sessionId);
  assert.equal(await revenue(), base + 20);
  await verify(body.sessionId); // repeating does not double count
  assert.equal(await revenue(), base + 20);
});

// ---- HTTP (needs the running server) ----

test("HTTP: payment and admin routes enforce authentication; the webhook works with the raw body", async () => {
  const ask = (method, path, token, body) =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(token && { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.status);

  const signUp = await fetch(`${AUTH_URL}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email: mailbox, password: "Test-pass-12345", name: "FM Pay Http" }),
  });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const userId = (await signUp.json().catch(() => null))?.user?.id;
  const { token } = await (await fetch(`${AUTH_URL}/api/auth/token`, { headers: { Cookie: cookie, Origin: ORIGIN } })).json();

  assert.equal(await ask("GET", "/api/admin/transactions"), 401);
  assert.equal(await ask("GET", "/api/admin/transactions", token), 403); // a customer is not an admin
  assert.equal(await ask("POST", "/api/payments/create-checkout-session", null, { bookingId: "x" }), 401);
  assert.equal(await ask("GET", "/api/payments/verify?session_id=cs_test_x"), 401);
  assert.equal(await ask("GET", "/api/payments/my"), 401);
  assert.equal(await ask("GET", "/api/payments/my", token), 200);

  // the webhook is public, but an unsigned request is refused (400 once Stripe is configured, 503 before)
  assert.ok([400, 503].includes(await ask("POST", "/api/payments/webhook", null, { type: "checkout.session.completed" })));

  // a correctly signed event for a session we do not know is acknowledged (200) when the server shares the
  // test secrets, which proves the raw body reaches the signature check intact
  const payload = JSON.stringify({ id: "evt_fm_http", object: "event", type: "checkout.session.expired", data: { object: { id: "cs_test_unknown" } } });
  const signed = await fetch(`${API_URL}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": stripeLib.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET }) },
    body: payload,
  });
  assert.ok([200, 400, 503].includes(signed.status));
  if (process.env.EXPECT_WEBHOOK_200) assert.equal(signed.status, 200);

  await db.collection("account").deleteMany({ userId: userId ?? mailbox });
});
