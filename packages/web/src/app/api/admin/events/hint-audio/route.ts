import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase-admin";

const MAX_BYTES = 5 * 1024 * 1024; // 5MiB, matches the bucket's file_size_limit
const ALLOWED_MIME_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

/** Uploads a hint audio clip and returns its storage object key. */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const extension = ALLOWED_MIME_TYPES[file.type];
  if (!extension) {
    return NextResponse.json(
      { error: `Unsupported audio type: ${file.type}` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File exceeds 5MiB limit" },
      { status: 400 },
    );
  }

  const audioKey = `${randomUUID()}.${extension}`;
  const admin = createAdminClient();

  const { error } = await admin.storage
    .from("hint-audio")
    .upload(audioKey, file, { contentType: file.type });

  if (error) {
    return NextResponse.json(
      { error: "Failed to upload audio" },
      { status: 500 },
    );
  }

  return NextResponse.json({ audioKey }, { status: 201 });
}
