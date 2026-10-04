import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

/** Exercise nested routing after before_agent_start applies the real tool loadout. */
test(
  "SDK keeps search backends callable but hides their declarations across turns",
  { timeout: 10000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "search-sdk-"));
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      initTheme("dark", false);
      const settingsManager = SettingsManager.inMemory({});
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        additionalExtensionPaths: [
          new URL("../../search.ts", import.meta.url).pathname,
        ],
        extensionFactories: [
          (pi) => {
            pi.registerTool({
              name: "fffind",
              label: "Paths",
              description: "Offline path backend",
              parameters: Type.Object({ pattern: Type.String() }),
              async execute(_id, args) {
                return {
                  content: [{ type: "text", text: args.pattern }],
                  details: { cursor: "next-page" },
                };
              },
            });
            pi.registerProvider("search-sdk-test", {
              baseUrl: "https://unused.invalid",
              apiKey: "offline",
              api: "openai-completions",
              models: [
                {
                  id: "offline",
                  name: "offline",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32000,
                  maxTokens: 1000,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            });
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: join(root, "models.json"),
        refreshOnCreate: false,
      });
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        settingsManager,
        resourceLoader: loader,
        modelRuntime,
        sessionManager: SessionManager.inMemory(root),
        tools: ["search", "fffind"],
      }));
      await session.bindExtensions({ mode: "print" });
      await session.setModel(
        modelRuntime.getModel("search-sdk-test", "offline")!,
      );
      let turn = 0;
      session.agent.streamFunction = (model, context) => {
        const declared = new Set<string>();
        for (const message of context.messages)
          if (message.role === "system") {
            for (const tool of message.toolsAdded ?? [])
              declared.add(tool.name);
            for (const tool of message.toolsRemoved ?? [])
              declared.delete(tool.name);
          }
        assert.ok(declared.has("search"));
        assert.ok(
          !declared.has("fffind"),
          "Nested backend must not be declared",
        );
        const stream = createAssistantMessageEventStream();
        const call = turn++ % 2 === 0;
        const message: AssistantMessage = {
          role: "assistant",
          content: call
            ? [
                {
                  type: "toolCall",
                  id: `search-${turn}`,
                  name: "search",
                  arguments: { operation: "paths", query: "sentinel" },
                },
              ]
            : [{ type: "text", text: "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: call ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: message.stopReason as "stop" | "toolUse",
            message,
          });
          stream.end();
        });
        return stream;
      };
      await session.prompt("First offline search");
      await session.prompt("Second offline search");
      const results = session.agent.state.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.isError, false);
        const payload = JSON.parse(
          result.content.find((part) => part.type === "text")!.text!,
        );
        assert.equal(payload.results[0].isError, false);
        assert.equal(payload.results[0].content[0].text, "sentinel");
        assert.equal(payload.results[0].details.cursor, "next-page");
      }
      assert.ok(session.getCallableToolNames().includes("fffind"));
    } finally {
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
