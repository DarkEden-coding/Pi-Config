# Extension regression checks

These checks use the installed Pi SDK and local fake providers. They do not send paid model requests. Verified runtimes are Pi 0.99.1, 1.0.0 and 1.0.1.

```sh
node --experimental-strip-types --loader ~/.pi/agent/extensions/lib/tests/runtime-loader.mjs --test ~/.pi/agent/extensions/lib/tests/runtime-loader.test.ts ~/.pi/agent/extensions/lib/tests/parallel-agent-*.test.ts ~/.pi/agent/extensions/lib/tests/todo.test.ts
node --experimental-strip-types ~/.pi/agent/extensions/lib/search.test.mjs
node --experimental-strip-types ~/.pi/agent/extensions/cliproxy-transport.test.mjs
```

The loader reproduces Pi's extension package aliases for plain Node. Runtime discovery prefers the running CLI, then extension-local dependencies, then Pi on PATH. CLIProxy's transport rejects versions outside these verified versions; review the extraction before adding support for a newer Pi version.
