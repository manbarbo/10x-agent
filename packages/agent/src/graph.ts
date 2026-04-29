import {
  StateGraph,
  interrupt,
  Command,
  INTERRUPT,
} from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration, PendingConfirmation } from "@agents/types";
import {
  TOOL_CATALOG,
  toolRequiresConfirmation,
  getToolRisk,
} from "@agents/types";
import { createChatModel, createCompactionModel } from "./model";
import { GraphState } from "./state";
import { buildCompactionNode } from "./nodes/compaction_node";
import { buildMemoryInjectionNode } from "./nodes/memory_injection_node";
import { buildLangChainTools, TOOL_HANDLERS } from "./tools/adapters";
import type { ToolContext } from "./tools/adapters";
import {
  addMessage,
  createToolCall,
  updateToolCallStatus,
  findExistingPendingToolCall,
} from "@agents/db";
import { getCheckpointer } from "./checkpointer";

export interface AgentInput {
  message?: string;
  resumeDecision?: "approve" | "reject";
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  /** Skip HITL interrupts and auto-approve all tool calls. Use only for unattended runs (e.g. cron). */
  bypassConfirmation?: boolean;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation?: PendingConfirmation;
}

/** Confirmation message shown to the human for a given tool + args. */
function buildConfirmationMessage(
  toolId: string,
  args: Record<string, unknown>
): string {
  switch (toolId) {
    case "github_create_issue":
      return `Se requiere confirmación para crear el issue "${args.title}" en ${args.owner}/${args.repo}.`;
    case "github_create_repo":
      return `Se requiere confirmación para crear el repositorio "${args.name}"${args.isPrivate ? " (privado)" : ""}.`;
    case "calendar_create_event": {
      const startStr = String(args.start ?? "");
      let when: string;
      try {
        when = new Date(startStr).toLocaleString("es", { dateStyle: "full", timeStyle: "short" });
      } catch {
        when = startStr;
      }
      const mins = args.duration_minutes as number;
      const emails = (args.attendees as string[] | undefined)?.filter(Boolean) ?? [];
      const invite =
        emails.length > 0 ? `\nInvitados: ${emails.join(", ")}.` : "";
      return `Se requiere confirmación para crear la reunión "${args.title}" (${mins} min), inicio: ${when}.${invite}`;
    }
    case "calendar_cancel_event":
      return `Se requiere confirmación para eliminar del calendario el evento con id \`${args.event_id}\`. Esta acción no se puede deshacer desde el agente.`;
    case "calendar_reschedule_event": {
      const ns = String(args.new_start ?? "");
      let when: string;
      try {
        when = new Date(ns).toLocaleString("es", { dateStyle: "full", timeStyle: "short" });
      } catch {
        when = ns;
      }
      const dur =
        args.duration_minutes != null
          ? ` Duración indicada: ${args.duration_minutes} min.`
          : " Se conservará la duración actual del evento.";
      return `Se requiere confirmación para reagendar el evento \`${args.event_id}\` a: ${when}.${dur}`;
    }
    case "write_file": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const preview = content.length > 300 ? `${content.slice(0, 300)}…` : content;
      return `Se requiere confirmación para crear el archivo \`${path}\` con el siguiente contenido:\n\`\`\`\n${preview}\n\`\`\``;
    }
    case "edit_file": {
      const path = String(args.path ?? "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const oldPreview = oldStr.length > 200 ? `${oldStr.slice(0, 200)}…` : oldStr;
      const newPreview = newStr.length > 200 ? `${newStr.slice(0, 200)}…` : newStr;
      return `Se requiere confirmación para editar \`${path}\`.\n\n**Fragmento a reemplazar:**\n\`\`\`\n${oldPreview}\n\`\`\`\n\n**Nuevo contenido:**\n\`\`\`\n${newPreview}\n\`\`\``;
    }
    case "bash": {
      const prompt = String(args.prompt ?? "");
      const preview = prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt;
      const terminal = args.terminal ? ` en terminal "${args.terminal}"` : "";
      return `Se requiere confirmación para ejecutar el siguiente comando bash${terminal}:\n\`\`\`\n${preview}\n\`\`\``;
    }
    case "schedule_task": {
      const schedType = args.schedule_type === "recurring" ? "recurrente" : "una sola vez";
      const when =
        args.schedule_type === "one_time"
          ? `el ${new Date(args.run_at as string).toLocaleString("es")}`
          : `con expresión cron "${args.cron_expr}"`;
      return `Se requiere confirmación para programar una tarea (${schedType}) ${when}.\n\nPrompt: "${args.prompt}"`;
    }
    default:
      return `Se requiere confirmación para ejecutar "${toolId}" (riesgo: ${getToolRisk(toolId)}).`;
  }
}

const MAX_TOOL_ITERATIONS = 6;

/** Count assistant messages with tool_calls after the last HumanMessage (current user turn only). */
function assistantToolRoundsSinceLastHuman(messages: BaseMessage[]): number {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      lastHumanIdx = i;
      break;
    }
  }
  let count = 0;
  for (let i = lastHumanIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m instanceof AIMessage && m.tool_calls?.length) count += 1;
  }
  return count;
}

function snapshotHasPendingInterrupt(snapshot: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<unknown> }>;
}): boolean {
  return (snapshot.tasks ?? []).some(
    (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0
  );
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    resumeDecision,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    bypassConfirmation = false,
  } = input;

  const model = createChatModel();
  const compactionModel = createCompactionModel();
  const compactionNode = buildCompactionNode(compactionModel);
  const memoryInjectionNode = buildMemoryInjectionNode(db, userId);
  const toolCtx: ToolContext = { db, userId, sessionId, enabledTools, integrations, githubToken };
  const lcTools = buildLangChainTools(toolCtx);

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const currentDate = new Date().toLocaleString("es", {
      timeZone: "America/Bogota",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const systemPromptWithDate = `${state.systemPrompt}\n\nFecha y hora actual: ${currentDate} (hora Colombia).`;

    // Inject SystemMessage fresh so it is never accumulated in state.messages.
    const response = await modelWithTools.invoke([
      new SystemMessage(systemPromptWithDate),
      ...state.messages,
    ]);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const rounds = assistantToolRoundsSinceLastHuman(state.messages);
    if (rounds > MAX_TOOL_ITERATIONS) {
      const synthetic: BaseMessage[] = lastMsg.tool_calls.map(
        (tc) =>
          new ToolMessage({
            content: JSON.stringify({
              error: `Límite de ${MAX_TOOL_ITERATIONS} rondas de herramientas en este turno alcanzado.`,
            }),
            tool_call_id: tc.id!,
          })
      );
      return { messages: synthetic };
    }

    const results: BaseMessage[] = [];

    for (const tc of lastMsg.tool_calls) {
      const def = TOOL_CATALOG.find((t) => t.name === tc.name);
      const toolId = def?.id ?? tc.name;
      toolCallNames.push(tc.name);

      if (def && toolRequiresConfirmation(toolId)) {
        if (bypassConfirmation) {
          // Unattended run (e.g. cron): auto-approve without interrupting.
          const record = await createToolCall(db, sessionId, toolId, tc.args as Record<string, unknown>, true);
          await updateToolCallStatus(db, record.id, "approved");

          const autoHandler = TOOL_HANDLERS[toolId];
          try {
            const result = await autoHandler(tc.args as Record<string, unknown>, toolCtx);
            await updateToolCallStatus(db, record.id, "executed", result);
            results.push(new ToolMessage({ content: JSON.stringify(result), tool_call_id: tc.id! }));
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(db, record.id, "failed", errResult);
            results.push(new ToolMessage({ content: JSON.stringify(errResult), tool_call_id: tc.id! }));
          }
          continue;
        }

        // Idempotent: on graph replay after resume the record already exists.
        let record = await findExistingPendingToolCall(db, sessionId, toolId);
        if (!record) {
          record = await createToolCall(db, sessionId, toolId, tc.args as Record<string, unknown>, true);
        }

        const confirmMsg = buildConfirmationMessage(toolId, tc.args as Record<string, unknown>);

        // interrupt() pauses graph execution here on first pass.
        // On resume, it returns the decision value immediately.
        const decision = interrupt({
          tool_call_id: record.id,
          tool_name: toolId,
          message: confirmMsg,
          args: tc.args,
        }) as "approve" | "reject";

        if (decision !== "approve") {
          await updateToolCallStatus(db, record.id, "rejected");
          results.push(
            new ToolMessage({
              content: "Acción cancelada por el usuario.",
              tool_call_id: tc.id!,
            })
          );
          continue;
        }

        await updateToolCallStatus(db, record.id, "approved");

        // Call the handler directly to avoid withTracking creating a second DB record.
        const confirmedHandler = TOOL_HANDLERS[toolId];
        try {
          const result = await confirmedHandler(tc.args as Record<string, unknown>, toolCtx);
          await updateToolCallStatus(db, record.id, "executed", result);
          results.push(new ToolMessage({ content: JSON.stringify(result), tool_call_id: tc.id! }));
        } catch (err) {
          const errResult = { error: String(err) };
          await updateToolCallStatus(db, record.id, "failed", errResult);
          results.push(new ToolMessage({ content: JSON.stringify(errResult), tool_call_id: tc.id! }));
        }
        continue;
      }

      // Execute non-confirmed tools (withTracking handles DB record creation).
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      if (!matchingTool) {
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: `Tool '${tc.name}' not available` }),
            tool_call_id: tc.id!,
          })
        );
        continue;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResult = await (matchingTool as any).invoke(tc.args);
        results.push(
          new ToolMessage({ content: String(rawResult), tool_call_id: tc.id! })
        );
      } catch (err) {
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: String(err) }),
            tool_call_id: tc.id!,
          })
        );
      }
    }

    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("memory_injection", memoryInjectionNode)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "memory_injection")
    .addEdge("memory_injection", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });

  const config = { configurable: { thread_id: sessionId } };

  let finalState: typeof GraphState.State & { [INTERRUPT]?: unknown[] };

  if (resumeDecision) {
    // Resume interrupted graph with human decision
    finalState = await app.invoke(
      new Command({ resume: resumeDecision }),
      config
    );
  } else {
    // If the thread is paused on HITL interrupt, appending a HumanMessage would leave
    // an AIMessage with tool_calls without ToolMessages and OpenAI returns 400.
    const snapshot = await app.getState(config);
    if (snapshotHasPendingInterrupt(snapshot)) {
      return {
        response:
          "Hay una acción pendiente de confirmación en esta conversación. Usa Aprobar o Cancelar en el mensaje anterior antes de escribir otra cosa.",
        toolCalls: [],
      };
    }

    // New message — persist to DB (audit log) then append to checkpointer state.
    // The checkpointer is the sole source of truth for message history; we never
    // reconstruct from DB to avoid duplicating messages across invocations.
    await addMessage(db, sessionId, "user", message!);

    finalState = await app.invoke(
      { messages: [new HumanMessage(message!)], sessionId, userId, systemPrompt },
      config
    );
  }

  // Check if the graph is paused at an interrupt
  const interrupts = (finalState as Record<string, unknown>)[INTERRUPT] as
    | Array<{ value: unknown }>
    | undefined;

  if (interrupts?.length) {
    const interruptValue = interrupts[0].value as {
      tool_call_id: string;
      tool_name: string;
      message: string;
      args: Record<string, unknown>;
    };

    const pendingConfirmation: PendingConfirmation = {
      tool_call_id: interruptValue.tool_call_id,
      tool_name: interruptValue.tool_name,
      message: interruptValue.message,
      args: interruptValue.args,
    };

    // Persist the pending confirmation so it survives page refresh.
    await addMessage(db, sessionId, "assistant", interruptValue.message, {
      structured_payload: {
        type: "pending_confirmation",
        ...pendingConfirmation,
      },
    });

    return {
      response: interruptValue.message,
      toolCalls: toolCallNames,
      pendingConfirmation,
    };
  }

  // Normal completion
  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  await addMessage(db, sessionId, "assistant", responseText);

  return {
    response: responseText,
    toolCalls: toolCallNames,
  };
}
