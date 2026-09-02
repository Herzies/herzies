import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET() {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("store_products")
    .select("id, name, description, currency_amount, price_usd_cents")
    .eq("active", true);

  if (error) {
    return NextResponse.json(
      { error: "Failed to load products" },
      { status: 500 },
    );
  }

  const products = (data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    currencyAmount: p.currency_amount,
    priceUsdCents: p.price_usd_cents,
  }));

  return NextResponse.json({ products });
}
