import Stripe from "stripe";

/** Server-side Stripe client. Never expose the secret key to the client. */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Missing STRIPE_SECRET_KEY env var");
  }
  return new Stripe(key);
}
