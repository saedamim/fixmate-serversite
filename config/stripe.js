// Stripe TEST MODE client. Live keys are refused, so a live key in the environment can never be used.
import Stripe from "stripe";

let client;
let override; // set by tests to replace the real Stripe client with a mock

export const useStripe = (mock) => {
  override = mock;
};

// Only TEST keys are accepted: a secret key (sk_test_...) or a restricted key (rk_test_...). Live keys are refused.
const TEST_KEY = /^(sk|rk)_test_/;
export const isConfigured = () => Boolean(override) || TEST_KEY.test(process.env.STRIPE_SECRET_KEY ?? "");

export const getStripe = () => {
  if (override) return override;
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
};
