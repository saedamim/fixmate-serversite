// Payment tests. SSLCommerz is MOCKED (global fetch is replaced), so no real request or transaction happens.
// Controllers run directly against the real database using temporary bookings that are removed afterwards.
// The HTTP checks (401/403) need a running server with the latest code (API_URL, default BETTER_AUTH_URL).
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import connectDB, { client, db } from "../config/db.js";
import { createHash } from "node:crypto";
import { initiatePayment, getMyPayments, handleIpn } from "../controllers/payment.controller.js";
import { getTransactions, getStats } from "../controllers/admin.controller.js";

dotenv.config({ quiet: true });
// Placeholder sandbox settings: the real credentials are never needed because fetch is mocked
process.env.SSLCOMMERZ_STORE_ID = "fm_test_store";
process.env.SSLCOMMERZ_STORE_PASSWORD = "fm_test_password";
process.env.SSLCOMMERZ_SANDBOX = "true";

const AUTH_URL = process.env.BETTER_AUTH_URL;
const API_URL = process.env.API_URL || AUTH_URL;
const ORIGIN = process.env.FRONTEND_URL;
const realFetch = globalThis.fetch;
const stamp = Date.now();
const CUSTOMER = { id: `fm-test-pay-cust-${stamp}`, name: "FM Pay Test", email: `fm-test-pay-${stamp}@example.test` };
const OTHER = { id: `fm-test-pay-other-${stamp}`, name: "FM Pay Other", email: `fm-test-pay-other-${stamp}@example.test` };
const bookingIds = [];
const mailbox = `fm-test-pay-http-${stamp}@example.test`;
let calls; // provider requests captured by the mock
let validationReply; // what the mocked Order Validation API returns

// Mock of the two SSLCommerz endpoints; any other URL fails the test
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (!href.startsWith("https://sandbox.sslcommerz.com/")) return realFetch(url, options);
  calls.push({ url: href, body: options.body ? Object.fromEntries(options.body) : null });
  const json = href.includes("/gwprocess/")
    ? { status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.com/gw/test-session", sessionkey: "KEY123" }
    : validationReply;
  return { ok: true, status: 200, json: async () => json };
};

const run = async (handler, { user, body, query = {} } = {}) => {
  const out = { status: 200, body: undefined };
  const res = { status(c) { out.status = c; return res; }, json(p) { out.body = p; return res; } };
  await handler({ user, body, query, params: {} }, res);
  return out;
};

const newBooking = async (overrides = {}) => {
  const { insertedId } = await db.collection("bookings").insertOne({
    customerId: CUSTOMER.id, serviceId: new ObjectId(), serviceTitle: "FM TEST pay service", category: "AC",
    technicianEmail: "fm-test-tech@example.test", phone: "01700000000", address: "", status: "completed",
    isActive: false, paymentStatus: "unpaid", finalAmount: 1500, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  });
  bookingIds.push(insertedId);
  return insertedId;
};
const initiate = async (bookingId, extra = {}, user = CUSTOMER) =>
  run(initiatePayment, { user, body: { bookingId: bookingId.toString(), ...extra } });
const paymentFor = (bookingId) => db.collection("payments").findOne({ bookingId });
const booking = (id) => db.collection("bookings").findOne({ _id: id });
// Builds an IPN body signed the way SSLCommerz documents it (verify_key fields + md5(store password), sorted, md5)
const sign = (fields, password = process.env.SSLCOMMERZ_STORE_PASSWORD) => {
  const names = Object.keys(fields).sort();
  const signed = { ...fields, store_passwd: createHash("md5").update(password).digest("hex") };
  const text = Object.keys(signed).sort().map((k) => `${k}=${signed[k]}`).join("&");
  return { ...fields, verify_key: names.join(","), verify_sign: createHash("md5").update(text).digest("hex") };
};
const ipnBody = (payment, fields = {}) =>
  sign({ tran_id: payment.tranId, val_id: "VAL1", status: "VALID", amount: payment.amount.toFixed(2), currency: "BDT", ...fields });
const ipn = (payment, fields = {}) => run(handleIpn, { body: ipnBody(payment, fields) });
const goodValidation = (payment, fields = {}) => {
  validationReply = {
    status: "VALID", tran_id: payment.tranId, val_id: "VAL1", amount: payment.amount.toFixed(2),
    currency_type: "BDT", currency: "BDT", risk_level: "0", bank_tran_id: "BANK1", card_type: "VISA-Dutch Bangla", ...fields,
  };
};

before(async () => {
  await connectDB();
  await db.collection("payments").createIndex({ tranId: 1 }, { unique: true, name: "unique_tran_id" });
  await db.collection("payments").createIndex(
    { bookingId: 1 },
    { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_payment_per_booking" }
  );
});
beforeEach(() => { calls = []; validationReply = null; });

after(async () => {
  await db.collection("payments").deleteMany({ bookingId: { $in: bookingIds } });
  await db.collection("bookings").deleteMany({ _id: { $in: bookingIds } });
  await db.collection("session").deleteMany({ userId: mailbox });
  await db.collection("user").deleteOne({ email: mailbox });
  globalThis.fetch = realFetch;
  await client.close();
});

test("initiation: own completed unpaid booking works; amount/status/currency from the client are ignored", async () => {
  const id = await newBooking({ finalAmount: 1500 });
  const r = await initiate(id, { amount: 1, finalAmount: 1, currency: "USD", paymentStatus: "paid", status: "paid" });
  assert.equal(r.status, 201);
  assert.equal(r.body.gatewayUrl, "https://sandbox.sslcommerz.com/gw/test-session");
  assert.deepEqual(Object.keys(r.body).sort(), ["gatewayUrl", "paymentId", "tranId"]);

  const saved = await paymentFor(id);
  assert.equal(saved.amount, 1500);
  assert.equal(saved.currency, "BDT");
  assert.equal(saved.status, "pending");
  assert.equal(saved.customerId, CUSTOMER.id);
  assert.equal((await booking(id)).paymentStatus, "unpaid");

  const sent = calls[0].body;
  assert.equal(sent.total_amount, "1500.00");
  assert.equal(sent.currency, "BDT");
  assert.equal(sent.tran_id, saved.tranId);
  assert.match(sent.ipn_url, /\/api\/payments\/ipn$/);
});

test("initiation: another customer's booking looks like 'not found'", async () => {
  const id = await newBooking();
  const r = await initiate(id, {}, OTHER);
  assert.equal(r.status, 404);
  assert.equal(await paymentFor(id), null);
  assert.equal(calls.length, 0);
});

test("initiation: ineligible bookings are rejected (not completed, already paid, no finalAmount, bad id)", async () => {
  for (const overrides of [{ status: "in_progress" }, { status: "requested" }, { paymentStatus: "paid" }, { finalAmount: undefined }, { finalAmount: 0 }]) {
    const id = await newBooking(overrides);
    assert.equal((await initiate(id)).status, 409, JSON.stringify(overrides));
    assert.equal(await paymentFor(id), null);
  }
  assert.equal((await run(initiatePayment, { user: CUSTOMER, body: { bookingId: { $ne: "x" } } })).status, 404);
  assert.equal(calls.length, 0);
});

test("initiation: a second active attempt for the same booking is prevented", async () => {
  const id = await newBooking();
  assert.equal((await initiate(id)).status, 201);
  assert.equal((await initiate(id)).status, 409);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id }), 1);
});

test("initiation: stays closed when the sandbox settings are missing or not sandbox", async () => {
  const id = await newBooking();
  process.env.SSLCOMMERZ_SANDBOX = "false";
  assert.equal((await initiate(id)).status, 503);
  process.env.SSLCOMMERZ_SANDBOX = "true";
  assert.equal(calls.length, 0);
});

test("IPN: a valid, validated transaction marks the payment and the booking paid, once", async () => {
  const id = await newBooking();
  await initiate(id);
  const payment = await paymentFor(id);
  goodValidation(payment);

  const first = await ipn(payment);
  assert.equal(first.status, 200);
  const paid = await paymentFor(id);
  assert.equal(paid.status, "paid");
  assert.equal(paid.bankTranId, "BANK1");
  assert.equal((await booking(id)).paymentStatus, "paid");
  assert.ok(calls.some((c) => c.url.includes("validationserverAPI.php") && c.url.includes("val_id=VAL1")));
  const paidAt = paid.paidAt;
  const bookingPaidAt = (await booking(id)).paidAt;

  // repeated IPN: no second validation call, nothing changes
  const callsBefore = calls.length;
  const again = await ipn(payment);
  assert.equal(again.status, 200);
  assert.equal(calls.length, callsBefore);
  assert.deepEqual((await paymentFor(id)).paidAt, paidAt);
  assert.deepEqual((await booking(id)).paidAt, bookingPaidAt);
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id }), 1);
});

test("IPN: wrong transaction id, amount, currency or validation status is rejected", async () => {
  const cases = [
    ["transaction id", { tran_id: "FM-someone-else" }],
    ["amount", { amount: "1.00" }],
    ["currency type", { currency_type: "USD" }],
    ["currency", { currency: "USD" }],
    ["missing currency_type", { currency_type: undefined }],
    ["validation id", { val_id: "SOMETHING-ELSE" }],
    ["validation status", { status: "INVALID_TRANSACTION" }],
    ["validation status", { status: "FAILED" }],
  ];
  for (const [name, fields] of cases) {
    const id = await newBooking();
    await initiate(id);
    const payment = await paymentFor(id);
    goodValidation(payment, fields);
    const r = await ipn(payment);
    assert.equal(r.status, 400, name);
    assert.equal((await paymentFor(id)).status, "pending", name);
    assert.equal((await booking(id)).paymentStatus, "unpaid", name);
  }
});

test("IPN: unknown transaction and a forged 'VALID' status without real validation are rejected", async () => {
  assert.equal((await run(handleIpn, { body: { tran_id: "FM-does-not-exist", val_id: "X", status: "VALID" } })).status, 400);
  assert.equal((await run(handleIpn, { body: {} })).status, 400);

  const id = await newBooking();
  await initiate(id);
  const payment = await paymentFor(id);
  goodValidation(payment, { status: "INVALID_TRANSACTION" }); // the gateway says it is not real
  assert.equal((await ipn(payment, { amount: "1500.00", currency: "BDT" })).status, 400);
  assert.equal((await booking(id)).paymentStatus, "unpaid");
});

test("IPN: a risky transaction is held for review, never paid automatically", async () => {
  for (const risk of ["1", undefined]) {
    const id = await newBooking();
    await initiate(id);
    const payment = await paymentFor(id);
    goodValidation(payment, { risk_level: risk });
    const r = await ipn(payment);
    assert.equal(r.status, 200);
    const held = await paymentFor(id);
    assert.equal(held.status, "pending");
    assert.equal(held.reviewRequired, true);
    assert.equal((await booking(id)).paymentStatus, "unpaid");
  }
});

test("IPN: failed / cancelled notifications never mark the booking paid", async () => {
  for (const [ipnStatus, expected] of [["FAILED", "failed"], ["CANCELLED", "cancelled"], ["EXPIRED", "failed"]]) {
    const id = await newBooking();
    await initiate(id);
    const payment = await paymentFor(id);
    const r = await ipn(payment, { status: ipnStatus });
    assert.equal(r.status, 200);
    assert.equal((await paymentFor(id)).status, expected);
    assert.equal((await booking(id)).paymentStatus, "unpaid");
    assert.ok(!calls.some((c) => c.url.includes("validationserverAPI.php")));
    // a closed attempt lets the customer try again
    assert.equal((await initiate(id)).status, 201);
  }
});

test("IPN: a paid booking cannot be paid twice", async () => {
  const id = await newBooking();
  await initiate(id);
  const first = await paymentFor(id);
  await db.collection("payments").updateOne({ _id: first._id }, { $set: { status: "failed" } }); // allow a second attempt
  await initiate(id);
  const second = await db.collection("payments").findOne({ bookingId: id, status: "pending" });

  goodValidation(second);
  await ipn(second);
  assert.equal((await booking(id)).paymentStatus, "paid");

  goodValidation(first);
  const late = await ipn(first);
  assert.equal(late.status, 200);
  assert.equal((await db.collection("payments").findOne({ _id: first._id })).status, "failed");
  assert.equal(await db.collection("payments").countDocuments({ bookingId: id, status: "paid" }), 1);
});

test("history: a customer sees only their own payments, with safe fields", async () => {
  const mine = await newBooking();
  const theirs = await newBooking({ customerId: OTHER.id });
  await initiate(mine);
  await initiate(theirs, {}, OTHER);

  const r = await run(getMyPayments, { user: CUSTOMER });
  assert.equal(r.status, 200);
  assert.ok(r.body.payments.length > 0);
  assert.ok(r.body.payments.every((p) => p.bookingId !== theirs.toString()));
  assert.ok(r.body.payments.some((p) => p.bookingId === mine.toString()));
  for (const p of r.body.payments) {
    assert.deepEqual(Object.keys(p).sort(), ["amount", "bookingId", "createdAt", "currency", "id", "paidAt", "provider", "serviceTitle", "status", "tranId"]);
  }
  const otherList = await run(getMyPayments, { user: OTHER });
  assert.ok(otherList.body.payments.every((p) => p.bookingId === theirs.toString()));
});

test("admin transactions: read real payment records without secrets", async () => {
  const id = await newBooking();
  await initiate(id);
  const payment = await paymentFor(id);
  goodValidation(payment);
  await ipn(payment);

  const r = await run(getTransactions, { user: { id: "fake-admin", role: "admin" }, query: { status: "paid", limit: "50" } });
  assert.equal(r.status, 200);
  const row = r.body.transactions.find((t) => t.bookingId === id.toString());
  assert.equal(row.status, "paid");
  assert.equal(row.amount, 1500);
  assert.equal(row.currency, "BDT");
  assert.equal(row.valId, undefined);
  assert.equal(row.sessionKey, undefined);
  assert.ok(r.body.transactions.every((t) => t.status === "paid"));
});

test("HTTP: admin transactions need an admin; payment routes need a customer token", async () => {
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
  const { token } = await (await fetch(`${AUTH_URL}/api/auth/token`, { headers: { Cookie: cookie, Origin: ORIGIN } })).json();
  const userId = (await signUp.json().catch(() => null))?.user?.id;

  assert.equal(await ask("GET", "/api/admin/transactions"), 401);
  assert.equal(await ask("GET", "/api/admin/transactions", token), 403); // customer, not admin
  assert.equal(await ask("GET", "/api/payments/my"), 401);
  assert.equal(await ask("POST", "/api/payments/initiate", null, { bookingId: "x" }), 401);
  assert.equal(await ask("GET", "/api/payments/my", token), 200); // a customer sees their (empty) history

  // the IPN is public but unsigned notifications are refused, and browser redirects change nothing
  // (503 when the server has no SSLCommerz settings, 400 when it does: unsigned notifications never succeed)
  assert.ok([400, 503].includes(await ask("POST", "/api/payments/ipn", null, { tran_id: "FM-none" })));
  const redirect = await fetch(`${API_URL}/api/payments/success`, { method: "POST", redirect: "manual" });
  assert.equal(redirect.status, 303);
  assert.match(redirect.headers.get("location"), /payment=success$/);
  await db.collection("account").deleteMany({ userId: userId ?? mailbox });
});

// ---- IPN integrity (verify_sign / verify_key) ----

test("IPN integrity: a correctly signed notification is accepted; the signature alone never marks paid", async () => {
  const id = await newBooking();
  await initiate(id);
  const payment = await paymentFor(id);

  // Valid signature, but the Order Validation API says no -> still unpaid
  goodValidation(payment, { status: "INVALID_TRANSACTION" });
  assert.equal((await ipn(payment)).status, 400);
  assert.equal((await booking(id)).paymentStatus, "unpaid");

  // Valid signature AND valid Order Validation -> paid
  goodValidation(payment);
  assert.equal((await ipn(payment)).status, 200);
  assert.equal((await booking(id)).paymentStatus, "paid");
});

test("IPN integrity: missing, forged, wrong-password or tampered signatures are rejected without side effects", async () => {
  const id = await newBooking();
  await initiate(id);
  const payment = await paymentFor(id);
  goodValidation(payment);
  const good = ipnBody(payment);
  const bad = {
    "no signature": (({ verify_sign, ...rest }) => rest)(good),
    "no verify_key": (({ verify_key, ...rest }) => rest)(good),
    "forged signature": { ...good, verify_sign: "0".repeat(32) },
    "wrong store password": ipnBody(payment) && sign({ tran_id: payment.tranId, val_id: "VAL1", status: "VALID", amount: "1500.00", currency: "BDT" }, "not-the-password"),
    "amount changed after signing": { ...good, amount: "1.00" },
    "tran_id changed after signing": { ...good, tran_id: "FM-other" },
    "signature does not cover tran_id": sign({ val_id: "VAL1", status: "VALID", amount: "1500.00" }),
    "not strings": { ...good, verify_sign: { $ne: "x" } },
  };
  for (const [name, body] of Object.entries(bad)) {
    const r = await run(handleIpn, { body: { ...body, tran_id: body.tran_id ?? payment.tranId } });
    assert.equal(r.status, 400, name);
  }
  assert.equal((await run(handleIpn, { body: undefined })).status, 400);
  assert.equal((await paymentFor(id)).status, "pending");
  assert.equal((await booking(id)).paymentStatus, "unpaid");
  assert.ok(!calls.some((c) => c.url.includes("validationserverAPI.php")), "no validation call for an unsigned notification");

  // an unsigned FAILED notification must not close the attempt either
  const unsigned = await run(handleIpn, { body: { tran_id: payment.tranId, status: "CANCELLED" } });
  assert.equal(unsigned.status, 400);
  assert.equal((await paymentFor(id)).status, "pending");
});

test("IPN integrity: the signature follows the documented algorithm (fixed vector)", async () => {
  const { verifyIpnSignature } = await import("../config/sslcommerz.js");
  const fields = { tran_id: "T1", val_id: "V1", status: "VALID", amount: "10.00" };
  const text = `amount=10.00&status=VALID&store_passwd=${createHash("md5").update("fm_test_password").digest("hex")}&tran_id=T1&val_id=V1`;
  const body = { ...fields, verify_key: "tran_id,val_id,status,amount", verify_sign: createHash("md5").update(text).digest("hex") };
  assert.equal(verifyIpnSignature(body), true);
  assert.equal(verifyIpnSignature({ ...body, amount: "11.00" }), false);
});

// ---- Revenue ----

test("revenue: counts verified paid payments only, never completed-but-unpaid bookings", async () => {
  const revenue = async () => (await run(getStats, { user: { id: "fake-admin", role: "admin" } })).body.revenue;
  const base = await revenue();

  // completed, unpaid booking with a large finalAmount: no revenue
  const unpaid = await newBooking({ finalAmount: 7000 });
  assert.equal(await revenue(), base);

  // pending, failed and risky payments: no revenue
  await initiate(unpaid);
  assert.equal(await revenue(), base);
  const pending = await paymentFor(unpaid);
  goodValidation(pending, { risk_level: "1" });
  await ipn(pending);
  assert.equal(await revenue(), base);
  await ipn(pending, { status: "FAILED" });
  assert.equal(await revenue(), base);

  // a verified paid payment: revenue grows by exactly its amount
  const other = await newBooking({ finalAmount: 1250 });
  await initiate(other);
  const payment = await paymentFor(other);
  goodValidation(payment);
  await ipn(payment);
  assert.equal(await revenue(), base + 1250);

  // repeating the IPN does not double count
  await ipn(payment);
  assert.equal(await revenue(), base + 1250);
});
