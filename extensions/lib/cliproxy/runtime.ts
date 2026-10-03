import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";

/** Prefer the running CLI, then extension-local dependencies, then the CLI on PATH. */
export function resolveRuntimeRoot(): string {
  const candidates = [process.argv[1], fileURLToPath(import.meta.url),
    ...(process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "pi"))];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    let directory = dirname(realpathSync(candidate));
    while (true) {
      for (const root of [directory, join(directory, "node_modules", packageName)]) {
        const manifest = join(root, "package.json");
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === packageName) return root;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error("CLIProxy requires an installed Pi CLI on PATH or in the extension runtime.");
}

export const runtimeRoot = resolveRuntimeRoot();
export const runtimeRequire = createRequire(join(runtimeRoot, "package.json"));
export const runtimeVersion: string = runtimeRequire("./package.json").version;
if (!["0.99.1", "1.0.0"].includes(runtimeVersion)) {
  throw new Error(`CLIProxy transport has not been verified with Pi ${runtimeVersion}; supported: 0.99.1, 1.0.0.`);
}

/** Resolve from this Pi installation, not an unrelated global or extension dependency. */
export function runtimeModuleUrl(specifier: string): string {
  if (specifier === packageName) return pathToFileURL(join(runtimeRoot, "dist/index.js")).href;
  const match = /^(@earendil-works\/pi-ai)(?:\/(.*))?$/.exec(specifier);
  if (match) {
    let directory = runtimeRoot;
    while (true) {
      const root = join(directory, "node_modules", match[1]);
      if (existsSync(join(root, "package.json"))) {
        return pathToFileURL(join(root, "dist", match[2] ? `${match[2]}.js` : "index.js")).href;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error("The installed Pi runtime is missing pi-ai.");
  }
  return pathToFileURL(runtimeRequire.resolve(specifier)).href;
}

export function importRuntime(specifier: string): Promise<unknown> {
  return import(runtimeModuleUrl(specifier));
}
