import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { client, db } from "../config/db.js";
import { CURRENCY, backendUrl, createSession, isConfigured, validateTransaction, verifyIpnSignature } from "../config/sslcommerz.js";
import { text } from "./booking.controller.js";
import { paging } from "./admin.controller.js";

const PAYMENT_STATUSES = ["pending", "paid", "failed", "cancelled"];
const ID_PATTERN = /^[a-f\d]{24}$/i;
// A pending attempt older than this is treated as abandoned so the customer can try again
const STALE_AFTER_MS = 30 * 60 * 1000;

const payments = () => db.collection("payments");
const bookings = () => db.collection("bookings");
const money = (value) => Number(value).toFixed(2);

// Safe public shape: never includes the session key, validation id or raw provider data
export const toPayment = ({ _id, bookingId, ...payment }) => ({
  id: _id.toString(),
  bookingId: bookingId.toString(),
  tranId: payment.tranId,
  serviceTitle: payment.serviceTitle,
  amount: payment.amount,
  currency: payment.currency,
  provider: payment.provider,
  status: payment.status,
  createdAt: payment.createdAt,
  paidAt: payment.paidAt ?? null,
});

// Thrown inside the transaction to roll it back
class Rollback extends Error {}

// POST /api/payments/initiate  { bookingId }  (customer). Amount and currency come only from the database.
export const initiatePayment = async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: "Online payment is not available right now" });

  const bookingId = text(req.body?.bookingId);
  if (!ID_PATTERN.test(bookingId)) return res.status(404).json({ message: "Booking not found" });

  const booking = await bookings().findOne({ _id: new ObjectId(bookingId), customerId: req.user.id });
  if (!booking) return res.status(404).json({ message: "Booking not found" });

  const payable =
    booking.status === "completed" &&
    booking.paymentStatus === "unpaid" &&
    typeof booking.finalAmount === "number" &&
    booking.finalAmount > 0;
  if (!payable) return res.status(409).json({ message: "This booking is not ready for payment" });

  const now = new Date();
  await payments().updateMany(
    { bookingId: booking._id, status: "pending", createdAt: { $lt: new Date(now - STALE_AFTER_MS) } },
    { $set: { status: "cancelled", failureReason: "Payment attempt expired", updatedAt: now } }
  );

  const payment = {
    tranId: `FM-${randomUUID()}`,
    bookingId: booking._id,
    customerId: req.user.id,
    customerName: req.user.name ?? "",
    customerEmail: req.user.email ?? "",
    technicianEmail: booking.technicianEmail ?? null,
    serviceTitle: booking.serviceTitle,
    amount: booking.finalAmount,
    currency: CURRENCY,
    provider: "SSLCommerz",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  // The unique partial index allows only one pending payment per booking
  let insertedId;
  try {
    ({ insertedId } = await payments().insertOne(payment));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A payment for this booking is already in progress" });
    }
    throw error;
  }

  try {
    const api = backendUrl();
    const { gatewayUrl, sessionKey } = await createSession({
      total_amount: money(payment.amount),
      tran_id: payment.tranId,
      success_url: `${api}/api/payments/success`,
      fail_url: `${api}/api/payments/fail`,
      cancel_url: `${api}/api/payments/cancel`,
      ipn_url: `${api}/api/payments/ipn`,
      product_name: booking.serviceTitle,
      product_category: booking.category || "Repair service",
      cus_name: payment.customerName || "Customer",
      cus_email: payment.customerEmail,
      cus_add1: booking.address || "N/A",
      cus_city: "Dhaka",
      cus_country: "Bangladesh",
      cus_phone: booking.phone,
    });

    await payments().updateOne({ _id: insertedId }, { $set: { sessionKey, updatedAt: new Date() } });
    res.status(201).json({ paymentId: insertedId.toString(), tranId: payment.tranId, gatewayUrl });
  } catch (error) {
    console.error("SSLCommerz session error:", error.message);
    await payments().updateOne(
      { _id: insertedId, status: "pending" },
      { $set: { status: "failed", failureReason: "Could not start the payment session", updatedAt: new Date() } }
    );
    res.status(502).json({ message: "Could not start the payment. Please try again." });
  }
};

export const getMyPayments = async (req, res) => {
  const { page, limit } = paging(req.query);
  const filter = { customerId: req.user.id };
  if (PAYMENT_STATUSES.includes(req.query.status)) filter.status = req.query.status;

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

// POST /api/payments/ipn (public, called by SSLCommerz). The only place a payment can become "paid",
// and only after the Order Validation API confirms it. The IPN's own status and amount are never trusted.
export const handleIpn = async (req, res) => {
  const body = req.body ?? {};
  if (!isConfigured()) return res.status(503).json({ message: "Online payment is not available right now" });

  // Step 1: integrity check of the notification itself (verify_sign / verify_key)
  if (!verifyIpnSignature(body)) {
    console.error("SSLCommerz IPN rejected: missing or invalid signature");
    return res.status(400).json({ message: "Invalid notification" });
  }

  const tranId = text(body.tran_id);
  const ipnStatus = text(body.status).toUpperCase();

  const payment = tranId ? await payments().findOne({ tranId }) : null;
  if (!payment) return res.status(400).json({ message: "Unknown transaction" });

  // Repeated notifications change nothing
  if (payment.status === "paid") return res.json({ message: "Already processed" });

  // Failed / cancelled notifications only close a pending attempt; they can never mark anything paid
  const closing = { FAILED: "failed", EXPIRED: "failed", CANCELLED: "cancelled" }[ipnStatus];
  if (closing) {
    await payments().updateOne(
      { tranId, status: "pending" },
      { $set: { status: closing, failureReason: `Gateway reported ${ipnStatus}`, updatedAt: new Date() } }
    );
    return res.json({ message: "Recorded" });
  }
  if (ipnStatus !== "VALID" && ipnStatus !== "VALIDATED") return res.json({ message: "Ignored" });

  // Server-side validation with the val_id
  const valId = text(body.val_id);
  if (!valId) return res.status(400).json({ message: "Missing validation id" });

  let result;
  try {
    result = await validateTransaction(valId);
  } catch (error) {
    console.error("SSLCommerz validation error:", error.message);
    return res.status(502).json({ message: "Could not validate the transaction" });
  }

  // Step 2: Order Validation API. `currency_type` is the currency we sent at initiation and `currency` is the
  // currency of `amount`; both must be BDT, and `amount` must equal the stored amount.
  const problem =
    (result.status !== "VALID" && result.status !== "VALIDATED" && "validation status") ||
    (result.tran_id !== payment.tranId && "transaction id") ||
    (result.val_id !== valId && "validation id") ||
    (money(result.amount) !== money(payment.amount) && "amount") ||
    (result.currency_type !== payment.currency && "currency type") ||
    (result.currency !== payment.currency && "currency");
  if (problem) {
    console.error(`SSLCommerz validation rejected for ${payment.tranId}: ${problem} mismatch`);
    return res.status(400).json({ message: "Transaction could not be verified" });
  }

  const details = {
    valId,
    bankTranId: result.bank_tran_id ?? null,
    cardType: result.card_type ?? null,
    riskLevel: Number(result.risk_level),
    updatedAt: new Date(),
  };

  // Anything other than an explicit risk level 0 is held for manual review, never auto-paid
  if (details.riskLevel !== 0) {
    await payments().updateOne({ tranId, status: "pending" }, { $set: { ...details, reviewRequired: true } });
    return res.json({ message: "Held for review" });
  }

  // Atomic: the booking and the payment both change, or neither does
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const booking = await bookings().updateOne(
        { _id: payment.bookingId, customerId: payment.customerId, paymentStatus: "unpaid" },
        { $set: { paymentStatus: "paid", paidAt: now, updatedAt: now } },
        { session }
      );
      if (!booking.matchedCount) throw new Rollback();

      const paid = await payments().updateOne(
        { tranId, status: { $in: ["pending", "failed", "cancelled"] } },
        { $set: { ...details, status: "paid", reviewRequired: false, failureReason: null, paidAt: now } },
        { session }
      );
      if (!paid.matchedCount) throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    // Already paid (a repeated IPN) or the booking was settled another way: nothing was changed
    console.error(`SSLCommerz payment ${payment.tranId} not applied: booking already paid or payment already processed`);
    return res.json({ message: "Already processed" });
  } finally {
    await session.endSession();
  }

  res.json({ message: "Payment recorded" });
};

// Browser redirects from SSLCommerz. They only send the customer back to the site; they never change data.
export const redirectToFrontend = (outcome) => (req, res) => {
  res.redirect(303, `${process.env.FRONTEND_URL}/dashboard/my-bookings?payment=${outcome}`);
};
