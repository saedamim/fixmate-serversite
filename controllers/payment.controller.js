import { ObjectId } from "mongodb";
import { client, db } from "../config/db.js";
import { getStripe, isConfigured } from "../config/stripe.js";
import { text } from "./booking.controller.js";
import { paging } from "./admin.controller.js";

const CURRENCY = "usd";
const PAYMENT_STATUSES = ["pending", "paid", "failed", "cancelled"];
const ID_PATTERN = /^[a-f\d]{24}$/i;
const SESSION_ID = /^cs_test_[A-Za-z0-9_]+$/;
// Stripe needs a Checkout Session to live at least 30 minutes; also the minimum card charge is $0.50
const SESSION_MINUTES = 31;
const MIN_CENTS = 50;

const payments = () => db.collection("payments");
const bookings = () => db.collection("bookings");
const toCents = (dollars) => Math.round(dollars * 100);

// Safe public shape. `status`, `tranId` and `provider` repeat the fields the dashboard already reads.
export const toPayment = ({ _id, bookingId, ...p }) => ({
  id: _id.toString(),
  bookingId: bookingId.toString(),
  serviceTitle: p.serviceTitle,
  amount: p.amount,
  currency: p.currency,
  provider: "Stripe",
  paymentStatus: p.paymentStatus,
  status: p.paymentStatus,
  transactionId: p.transactionId ?? null,
  tranId: p.transactionId ?? p.stripeSessionId ?? null,
  stripeSessionId: p.stripeSessionId ?? null,
  createdAt: p.createdAt,
  paidAt: p.paidAt ?? null,
});

class Rollback extends Error {}

// POST /api/payments/create-checkout-session  { bookingId }. The amount is read from the booking, never the client.
export const createCheckoutSession = async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Online payment is not available right now" });

  const bookingId = text(req.body?.bookingId);
  if (!ID_PATTERN.test(bookingId)) return res.status(404).json({ message: "Booking not found" });

  const booking = await bookings().findOne({ _id: new ObjectId(bookingId), customerId: req.user.id });
  if (!booking) return res.status(404).json({ message: "Booking not found" });

  const payable =
    booking.status === "completed" &&
    booking.paymentStatus === "unpaid" &&
    typeof booking.finalAmount === "number" &&
    toCents(booking.finalAmount) >= MIN_CENTS;
  if (!payable) return res.status(409).json({ message: "This booking is not ready for payment" });

  const now = new Date();
  await payments().updateMany(
    { bookingId: booking._id, paymentStatus: "pending", expiresAt: { $lt: now } },
    { $set: { paymentStatus: "cancelled", failureReason: "Checkout session expired", updatedAt: now } }
  );

  // One open checkout per booking: hand back the existing one instead of creating a second
  const open = await payments().findOne({ bookingId: booking._id, paymentStatus: "pending" });
  if (open) {
    if (!open.checkoutUrl) return res.status(409).json({ message: "A payment for this booking is already starting" });
    return res.json({ url: open.checkoutUrl, sessionId: open.stripeSessionId, reused: true });
  }

  const payment = {
    bookingId: booking._id,
    customerId: req.user.id,
    customerName: req.user.name ?? "",
    customerEmail: req.user.email ?? "",
    serviceId: booking.serviceId,
    serviceTitle: booking.serviceTitle,
    technicianName: booking.technicianName ?? booking.technician ?? null,
    technicianEmail: booking.technicianEmail ?? null,
    amount: booking.finalAmount,
    currency: CURRENCY,
    paymentStatus: "pending",
    expiresAt: new Date(now.getTime() + SESSION_MINUTES * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  };

  // The unique partial index allows only one pending payment per booking, even for simultaneous requests
  let insertedId;
  try {
    ({ insertedId } = await payments().insertOne(payment));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A payment for this booking is already starting" });
    }
    throw error;
  }

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      customer_email: payment.customerEmail || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: toCents(booking.finalAmount),
            product_data: { name: booking.serviceTitle },
          },
        },
      ],
      metadata: { bookingId: booking._id.toString(), customerEmail: payment.customerEmail },
      expires_at: Math.floor(payment.expiresAt.getTime() / 1000),
      success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
    });

    await payments().updateOne(
      { _id: insertedId },
      { $set: { stripeSessionId: session.id, checkoutUrl: session.url, updatedAt: new Date() } }
    );
    res.status(201).json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("Stripe checkout session error:", error.message);
    await payments().updateOne(
      { _id: insertedId, paymentStatus: "pending" },
      { $set: { paymentStatus: "failed", failureReason: "Could not start the checkout", updatedAt: new Date() } }
    );
    res.status(502).json({ message: "Could not start the payment. Please try again." });
  }
};

// Shared by the verify endpoint and the webhook. Marks the payment and booking paid only when the Stripe session
// (always fetched from, or signed by, Stripe) agrees with our own records. Safe to repeat.
// Returns { ok: true, payment } or { ok: false, unpaid?: true, reason }.
export const settleSession = async (session) => {
  const payment = await payments().findOne({ stripeSessionId: session.id });
  if (!payment) return { ok: false, reason: "unknown session" };
  if (payment.paymentStatus === "paid") return { ok: true, payment };
  if (session.payment_status !== "paid") return { ok: false, unpaid: true, reason: "not paid" };

  const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const booking = await bookings().findOne({ _id: payment.bookingId, customerId: payment.customerId });

  const problem =
    (session.mode !== "payment" && "mode") ||
    (session.currency !== CURRENCY && "currency") ||
    (!intentId && "payment intent") ||
    (session.metadata?.bookingId !== payment.bookingId.toString() && "booking metadata") ||
    (session.metadata?.customerEmail !== payment.customerEmail && "customer metadata") ||
    (!booking && "booking") ||
    (booking.status !== "completed" && "booking status") ||
    (session.amount_total !== toCents(booking.finalAmount) && "amount") ||
    (session.amount_total !== toCents(payment.amount) && "payment amount");
  if (problem) {
    console.error(`Stripe session ${session.id} rejected: ${problem} mismatch`);
    return { ok: false, reason: problem };
  }

  // Atomic: the booking and the payment both change, or neither does
  const dbSession = client.startSession();
  let paidAt;
  try {
    await dbSession.withTransaction(async () => {
      paidAt = new Date();
      const updatedBooking = await bookings().updateOne(
        { _id: payment.bookingId, customerId: payment.customerId, paymentStatus: "unpaid" },
        { $set: { paymentStatus: "paid", paidAt, updatedAt: paidAt } },
        { session: dbSession }
      );
      if (!updatedBooking.matchedCount) throw new Rollback("booking");

      const updatedPayment = await payments().updateOne(
        { stripeSessionId: session.id, paymentStatus: { $in: ["pending", "cancelled", "failed"] } },
        { $set: { paymentStatus: "paid", transactionId: intentId, paidAt, updatedAt: paidAt, failureReason: null }, $unset: { checkoutUrl: "" } },
        { session: dbSession }
      );
      if (!updatedPayment.matchedCount) throw new Rollback("payment");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    const latest = await payments().findOne({ stripeSessionId: session.id });
    if (latest.paymentStatus === "paid") return { ok: true, payment: latest }; // another request finished first

    // The booking was already paid through another session: keep a flagged record so the extra charge can be refunded
    await payments().updateOne(
      { stripeSessionId: session.id, paymentStatus: { $ne: "paid" } },
      { $set: { paymentStatus: "failed", transactionId: intentId, reviewRequired: true, failureReason: "Duplicate payment: the booking was already paid. Refund required.", updatedAt: new Date() }, $unset: { checkoutUrl: "" } }
    );
    return { ok: false, reason: "booking already paid" };
  } finally {
    await dbSession.endSession();
  }

  return { ok: true, payment: await payments().findOne({ stripeSessionId: session.id }) };
};

// GET /api/payments/verify?session_id=...  (customer). Retrieves the session from Stripe itself.
export const verifyPayment = async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Online payment is not available right now" });

  const sessionId = text(req.query.session_id);
  if (!SESSION_ID.test(sessionId)) return res.status(400).json({ message: "Invalid payment session" });

  // Only the customer who started this checkout can verify it
  const own = await payments().findOne({ stripeSessionId: sessionId, customerId: req.user.id });
  if (!own) return res.status(404).json({ message: "Payment session not found" });

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (error) {
    console.error("Stripe retrieve error:", error.message);
    return res.status(502).json({ message: "Could not verify the payment. Please try again." });
  }

  const result = await settleSession(session);
  if (result.unpaid) return res.status(402).json({ message: "Payment has not been completed", paymentStatus: session.payment_status });
  if (!result.ok) return res.status(409).json({ message: "Payment could not be verified" });

  res.json({ message: "Payment verified", payment: toPayment(result.payment) });
};

// POST /api/payments/webhook (public). Needs the RAW body (see index.js); trusted only after Stripe's signature check.
export const handleWebhook = async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!isConfigured() || !secret) return res.status(503).json({ message: "Webhook is not configured" });

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch {
    return res.status(400).json({ message: "Invalid webhook signature" });
  }

  const session = event.data?.object;
  const closeAttempt = (paymentStatus, failureReason) =>
    payments().updateOne(
      { stripeSessionId: session.id, paymentStatus: "pending" },
      { $set: { paymentStatus, failureReason, updatedAt: new Date() }, $unset: { checkoutUrl: "" } }
    );

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      // A completed session that is not "paid" yet (delayed payment methods) is ignored until it succeeds
      if (session.payment_status === "paid") await settleSession(session);
      break;
    case "checkout.session.expired":
      await closeAttempt("cancelled", "Checkout session expired");
      break;
    case "checkout.session.async_payment_failed":
      await closeAttempt("failed", "Payment failed");
      break;
  }

  res.json({ received: true });
};

export const getMyPayments = async (req, res) => {
  const { page, limit } = paging(req.query);
  const filter = { customerId: req.user.id };
  if (PAYMENT_STATUSES.includes(req.query.status)) filter.paymentStatus = req.query.status;

  const [items, total] = await Promise.all([
    payments()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    payments().countDocuments(filter),
  ]);

  res.json({ payments: items.map(toPayment), total, page, limit, totalPages: Math.ceil(total / limit) });
};
