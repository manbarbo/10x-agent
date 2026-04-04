import {
  StateGraph,
  Annotation,
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
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import {
  getSessionMessages,
  addMessage,
  createToolCall,
  updateToolCallStatus,
  findExistingPendingToolCall,
} from "@agents/db";
import { getCheckpointer } from "./checkpointer";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
});

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
    default:
      return `Se requiere confirmación para ejecutar "${toolId}" (riesgo: ${getToolRisk(toolId)}).`;
  }
}

const MAX_TOOL_ITERATIONS = 6;

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
  } = input;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubToken,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const results: BaseMessage[] = [];

    for (const tc of lastMsg.tool_calls) {
      const def = TOOL_CATALOG.find((t) => t.name === tc.name);
      const toolId = def?.id ?? tc.name;
      toolCallNames.push(tc.name);

      if (def && toolRequiresConfirmation(toolId)) {
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
      }

      // Execute the tool
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      if (matchingTool) {
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
    }

    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "agent");

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
    // New message — save it and invoke fresh
    await addMessage(db, sessionId, "user", message!);

    const history = await getSessionMessages(db, sessionId, 30);
    const priorMessages: BaseMessage[] = history
      .filter((m) => m.role !== "user" || m.content !== message)
      .map((m) => {
        if (m.role === "user") return new HumanMessage(m.content);
        if (m.role === "assistant") return new AIMessage(m.content);
        return new HumanMessage(m.content);
      });

    const initialMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...priorMessages,
      new HumanMessage(message!),
    ];

    finalState = await app.invoke(
      { messages: initialMessages, sessionId, userId, systemPrompt },
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
