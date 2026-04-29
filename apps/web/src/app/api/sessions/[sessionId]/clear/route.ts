import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, clearSessionMessages } from "@agents/db";
import { flushMemory } from "@agents/agent";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: session } = await supabase
    .from("agent_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .single();

  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = createServerClient();
  // Debe completarse antes de borrar mensajes (flush lee agent_messages).
  await flushMemory({ db, userId: user.id, sessionId });
  await clearSessionMessages(db, sessionId);

  return NextResponse.json({ ok: true });
}
