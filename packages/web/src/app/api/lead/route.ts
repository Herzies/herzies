import { NextResponse } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

const MAILERLITE_ENDPOINT = "https://connect.mailerlite.com/api/subscribers";

export async function POST(req: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    const json = await req.json();
    parsed = bodySchema.parse(json);
  } catch {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const apiKey = process.env.MAILERLITE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Mailing list is not configured" },
      { status: 500 },
    );
  }

  const groupId = process.env.MAILERLITE_GROUP_ID;
  const payload: { email: string; groups?: string[] } = { email: parsed.email };
  if (groupId) payload.groups = [groupId];

  let mlRes: Response;
  try {
    mlRes = await fetch(MAILERLITE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach mailing list" },
      { status: 502 },
    );
  }

  if (mlRes.status !== 200 && mlRes.status !== 201) {
    return NextResponse.json(
      { error: "Mailing list rejected the request" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
