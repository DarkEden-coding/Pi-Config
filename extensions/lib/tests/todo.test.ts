import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Exercise the real extension with only schema/UI imports stubbed.
const source = readFileSync(new URL("../../todo.ts", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace(
    /class TodoWebComponent \{[\s\S]*?\nfunction renderTodoWebLines/,
    "function renderTodoWebLines",
  )
  .replace("export default function todoExtension", "function todoExtension");
const load = new Function(
  "Type",
  "StringEnum",
  `${stripTypeScriptTypes(source)}; return todoExtension;`,
);
const schema = new Proxy({}, { get: () => () => ({}) });

function harness() {
  let branch: any[] = [];
  let tool: any;
  const hooks: Record<string, any> = {};
  let serial = 0;
  const ctx = { sessionManager: { getBranch: () => branch } };
  load(schema, () => ({}))({
    on: (name: string, handler: any) => {
      hooks[name] = handler;
    },
    registerTool: (value: any) => {
      tool = value;
    },
    registerCommand: () => {},
    appendEntry: (customType: string, data: any) =>
      branch.push({ type: "custom", customType, data, id: String(++serial) }),
    sendMessage: (message: any, options: any) => {
      assert.equal(options.triggerTurn, false);
      branch.push({ type: "custom_message", ...message, id: String(++serial) });
    },
  });
  return {
    hooks,
    ctx,
    run: (params: any) => tool.execute("call", params),
    branch: () => branch,
    restore: (entries: any[]) => {
      branch = entries;
    },
  };
}

const web = {
  title: "Work",
  tasks: [
    {
      id: "a",
      title: "First",
      description: "Start",
      acceptanceCriteria: ["first criterion"],
    },
    {
      id: "b",
      title: "Second",
      description: "Finish",
      dependencies: ["a"],
      acceptanceCriteria: ["second criterion"],
    },
    {
      id: "c",
      title: "Third",
      description: "Verify",
      dependencies: ["b"],
      acceptanceCriteria: ["third criterion"],
    },
  ],
};

test("concise deltas retain full details and durable branch-local state", async () => {
  const h = harness();
  const set = await h.run({ action: "set", web });
  assert.doesNotMatch(set.content[0].text, /first criterion|Start|Full todo/);
  assert.equal(
    set.details.web.tasks[1].acceptanceCriteria[0],
    "second criterion",
  );
  const initial = [...h.branch()];
  const invalid = await h.run({ action: "complete", taskId: "b" });
  assert.match(invalid.content[0].text, /still blocked/);
  assert.equal(h.branch().length, 1);
  const completed = await h.run({ action: "complete", taskId: "a" });
  assert.match(completed.content[0].text, /completed: a; newly unblocked: b/);
  assert.match(completed.content[0].text, /blockers: c<-b/);
  assert.doesNotMatch(completed.content[0].text, /criterion|Full todo|Next:/);
  assert.equal(set.details.web.tasks[0].status, "pending");
  assert.equal(completed.details.newlyUnblocked[0].id, "b");
  const progressed = [...h.branch()];
  await h.run({ action: "clear" });
  await h.hooks.session_start({}, h.ctx);
  assert.equal((await h.run({ action: "get" })).details.web, undefined);
  h.restore(initial);
  await h.hooks.session_tree({}, h.ctx);
  assert.equal(
    (await h.run({ action: "get" })).details.web.tasks[0].status,
    "pending",
  );
  h.restore(progressed);
  await h.hooks.session_start({}, h.ctx);
  assert.equal(
    (await h.run({ action: "get" })).details.web.tasks[0].status,
    "completed",
  );
});

test("checkpoint projects active IDs, blockers and criteria once without waking", async () => {
  const h = harness();
  await h.run({ action: "set", web });
  await h.run({ action: "complete", taskId: "a" });
  h.branch().push({ type: "compaction", id: "checkpoint" });
  await h.hooks.session_compact({}, h.ctx);
  const snapshot = h.branch().at(-1);
  assert.equal(snapshot.customType, "todo-web-snapshot");
  assert.match(snapshot.content, /b: Second \[pending; unblocked\]/);
  assert.match(snapshot.content, /c: Third \[pending; blocked by b\]/);
  assert.match(snapshot.content, /second criterion/);
  assert.match(snapshot.content, /third criterion/);
  assert.doesNotMatch(snapshot.content, /a: First|first criterion/);
  const count = h.branch().length;
  await h.hooks.session_start({}, h.ctx);
  await h.hooks.session_tree({}, h.ctx);
  assert.equal(h.branch().length, count);
  h.branch().push({ type: "compaction", id: "next-checkpoint" });
  await h.hooks.session_compact({}, h.ctx);
  assert.equal(h.branch().length, count + 2);
});
