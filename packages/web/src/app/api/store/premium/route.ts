import { getItem } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";

/**
 * Premium goods: catalog items sold for real money rather than coins.
 *
 * Stripe is the source of truth for *what is on sale and what it costs*; the
 * bundled item catalog is the source of truth for *what it looks like*. The
 * two are joined by the Stripe product's `metadata.item_id`, so adding a
 * premium item is a Dashboard action — no migration, no deploy, no app
 * release. (Stripe only lets a custom product id be set through the API, not
 * the Dashboard, which is why the join lives in metadata instead.)
 *
 * Deliberately returns no name, art or description. The client already has
 * all of that in its own catalog under the same id, and echoing it here would
 * create a second copy to drift — the mistake coin prices already made by
 * living in both the catalog and the items table.
 *
 * Authenticated, unlike the coin-pack listing beside it, because every call
 * costs a Stripe API request.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  // No Stripe configured: an empty premium list, not an error. The store's
  // coin-priced items are unaffected and should still render.
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ items: [] });
  }

  const stripe = getStripe();

  let products: import("stripe").Stripe.ApiList<
    import("stripe").Stripe.Product
  >;
  try {
    products = await stripe.products.list({
      active: true,
      expand: ["data.default_price"],
      limit: 100,
    });
  } catch {
    // Stripe being down shouldn't take the whole store with it.
    return NextResponse.json({ items: [] });
  }

  const items = products.data.flatMap((product) => {
    const itemId = product.metadata?.item_id;
    // `metadata.item_id` is free text typed into the Stripe Dashboard, so
    // treat it as untrusted: a typo here would otherwise list a card the
    // client cannot render, and — worse — sell it. Same posture as
    // filterDroppablePool takes with the items table.
    if (!itemId || !getItem(itemId)) return [];

    const price = product.default_price;
    if (!price || typeof price === "string") return [];
    if (!price.active || price.unit_amount == null) return [];

    return [
      {
        itemId,
        priceId: price.id,
        // Minor units and an ISO currency code, straight from Stripe. Nothing
        // here assumes NOK — the client formats whatever currency comes back,
        // so changing it is a Stripe-side change.
        amount: price.unit_amount,
        currency: price.currency,
      },
    ];
  });

  return NextResponse.json({ items });
}
