import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, revokeIntegration, decrypt } from "@agents/db";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const { data: row } = await db
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", user.id)
    .eq("provider", "google_calendar")
    .maybeSingle();

  if (row?.encrypted_tokens) {
    try {
      const raw = decrypt(row.encrypted_tokens as string);
      const bundle = JSON.parse(raw) as { access_token?: string };
      if (bundle.access_token) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: bundle.access_token }).toString(),
        }).catch(() => undefined);
      }
    } catch {
      // ignore revoke errors
    }
  }

  await revokeIntegration(db, user.id, "google_calendar");

  return NextResponse.json({ ok: true });
}
