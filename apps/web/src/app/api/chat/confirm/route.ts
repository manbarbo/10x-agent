import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getPendingToolCall,
  updateToolCallStatus,
  decrypt,
} from "@agents/db";
import { executeGitHubTool } from "@agents/agent";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = await request.json();
    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const db = createServerClient();
    const toolCall = await getPendingToolCall(db, toolCallId);

    if (!toolCall) {
      return NextResponse.json(
        { error: "Tool call not found or already resolved" },
        { status: 404 }
      );
    }

    const { data: session } = await supabase
      .from("agent_sessions")
      .select("user_id")
      .eq("id", toolCall.session_id)
      .single();

    if (session?.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (action === "reject") {
      await updateToolCallStatus(db, toolCallId, "rejected");
      return NextResponse.json({
        ok: true,
        message: "Acción cancelada.",
      });
    }

    await updateToolCallStatus(db, toolCallId, "approved");

    if (toolCall.tool_name.startsWith("github_")) {
      const { data: integration } = await db
        .from("user_integrations")
        .select("encrypted_tokens")
        .eq("user_id", user.id)
        .eq("provider", "github")
        .eq("status", "active")
        .single();

      if (!integration?.encrypted_tokens) {
        await updateToolCallStatus(db, toolCallId, "failed", {
          error: "GitHub not connected",
        });
        return NextResponse.json({
          ok: false,
          message: "GitHub no está conectado. Conecta tu cuenta desde Ajustes.",
        });
      }

      const token = decrypt(integration.encrypted_tokens);

      try {
        const result = await executeGitHubTool(
          toolCall.tool_name,
          toolCall.arguments_json,
          token
        );
        await updateToolCallStatus(db, toolCallId, "executed", result);
        return NextResponse.json({ ok: true, result });
      } catch (err) {
        const errResult = { error: String(err) };
        await updateToolCallStatus(db, toolCallId, "failed", errResult);
        return NextResponse.json({ ok: false, message: String(err) });
      }
    }

    return NextResponse.json({ ok: true, message: "Acción aprobada." });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
