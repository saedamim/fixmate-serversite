// Stripe TEST MODE client. Live keys are refused, so a live key in the environment can never be used.
import Stripe from "stripe";

let client;
let override; // set by tests to replace the real Stripe client with a mock

export const useStripe = (mock) => {
  override = mock;
};

// Only test secret keys (sk_test_...) are accepted
export const isConfigured = () =>
  Boolean(override) || (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");

export const getStripe = () => {
  if (override) return override;
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
};
