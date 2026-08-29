import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATUS_KEY = "swath:create-agent-tab";
const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Adds Swath's independent-agent tab launcher when Pi is embedded by Swath. */
export default function swathAgentTabs(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "create_agent_tab",
    label: "Create Agent Tab",
    description:
      "Open an independent full Pi agent in a new Swath tab. Use only when the user asks for or approves a separate agent tab; otherwise use the regular sub-agent tools. The new agent receives only this task plus normal project instructions, never this conversation. It cannot report back here.",
    parameters: Type.Object({
      task: Type.String({
        description: "The new agent's complete task prompt.",
      }),
      title: Type.Optional(Type.String({ description: "Optional tab title." })),
      model: Type.Optional(
        Type.String({
          description:
            "Optional provider/model override. Defaults to this agent's model.",
        }),
      ),
      reasoningLevel: Type.Optional(
        Type.Union(
          thinkingLevels.map((level) => Type.Literal(level)),
          {
            description:
              "Optional reasoning-level override. Defaults to this agent's setting.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (process.env.SWATH_PI_AGENT !== "1" || ctx.mode !== "rpc") {
        return {
          content: [
            {
              type: "text",
              text: "Agent tabs are available only inside Swath.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      const model =
        params.model ??
        (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      await ctx.ui.setStatus(
        STATUS_KEY,
        JSON.stringify({
          task: params.task,
          title: params.title,
          model,
          reasoningLevel: params.reasoningLevel ?? ctx.thinkingLevel,
        }),
      );
      return {
        content: [
          { type: "text", text: "Opened an independent agent tab in Swath." },
        ],
        details: {},
      };
    },
  });
}
