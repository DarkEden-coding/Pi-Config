import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveRuntimeRoot, runtimeRoot, runtimeModuleUrl, runtimeVersion } from "../cliproxy/runtime.ts";

test("runtime resolves the running bundled CLI and a symlinked CLI on PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const originalArg = process.argv[1];
  const originalPath = process.env.PATH;
  try {
    const root = join(directory, ".local/lib/node_modules/@earendil-works/pi-coding-agent");
    const cli = join(root, "dist/bundle/cli.js");
    const bin = join(directory, "bin");
    mkdirSync(join(root, "dist/bundle"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }));
    writeFileSync(cli, "");
    symlinkSync(cli, join(bin, "pi"));
    process.argv[1] = cli;
    assert.equal(resolveRuntimeRoot(), realpathSync(root));
    process.argv[1] = join(directory, "absent-test.ts");
    process.env.PATH = bin;
    assert.equal(resolveRuntimeRoot(), realpathSync(root));
    process.env.PATH = "";
    assert.throws(resolveRuntimeRoot, /installed Pi CLI/);
  } finally {
    process.argv[1] = originalArg;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loader imports SDK and native helpers from the selected runtime", async () => {
  assert.ok(["0.99.1", "1.0.0"].includes(runtimeVersion));
  assert.equal(runtimeModuleUrl("@earendil-works/pi-coding-agent"), pathToFileURL(join(runtimeRoot, "dist/index.js")).href);
  const native = await import(runtimeModuleUrl("@earendil-works/pi-ai/utils/event-stream"));
  assert.equal(typeof native.AssistantMessageEventStream, "function");
  const { resolve } = await import("./runtime-loader.mjs");
  assert.deepEqual(resolve("@earendil-works/pi-ai", {}, () => assert.fail("alias missed")), {
    url: runtimeModuleUrl("@earendil-works/pi-ai"), shortCircuit: true,
  });
  assert.equal(resolve("node:fs", {}, () => "passthrough"), "passthrough");
});
