import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  streamSimple,
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketDebugStats,
} from "./lib/cliproxy/responses.ts";

/** Scoped bearer-auth Responses transport, retaining native Pi conversion and session reuse. */
export function cliproxyStream(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (model.provider !== "cliproxy" || model.api !== "openai-codex-responses") {
    throw new Error("CLIProxy transport requires a CLIProxy Responses model");
  }
  return streamSimple(
    model as Model<"openai-codex-responses">,
    context,
    options,
  );
}

/** Register only CLIProxy; model IDs, defaults and credentials stay in existing configuration. */
export default function registerCLIProxyTransport(pi: ExtensionAPI): void {
  pi.registerProvider("cliproxy", {
    api: "openai-codex-responses",
    streamSimple: cliproxyStream,
  });
  let warned = false;
  pi.on("agent_start", () => {
    warned = false;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    closeOpenAICodexWebSocketSessions(sessionId);
    resetOpenAICodexWebSocketDebugStats(sessionId);
  });
  /** Surface the native diagnostic once per run, including non-start failures. */
  function notifyFallback(
    event: { message: unknown },
    ctx: ExtensionContext,
  ): void {
    const message = event.message as Partial<AssistantMessage> | undefined;
    if (message?.provider !== "cliproxy" || warned) return;
    if (
      message.diagnostics?.some(
        (d) =>
          d.type === "provider_transport_failure" &&
          d.details?.fallbackTransport === "sse",
      )
    ) {
      warned = true;
      ctx.ui.notify(
        "CLIProxy WebSocket unavailable; safely falling back to SSE before response output.",
        "warning",
      );
    }
  }
  pi.on("message_start", notifyFallback);
  pi.on("message_update", notifyFallback);
  pi.on("message_end", notifyFallback);
}
