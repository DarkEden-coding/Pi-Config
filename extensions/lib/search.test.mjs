// Run: node --experimental-strip-types ~/.pi/agent/extensions/lib/search.test.mjs
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { runtimeRoot: root } = await import('./cliproxy/runtime.ts');
const require = createRequire(`${root}/package.json`);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': `${root}/dist/index.js`,
  '@earendil-works/pi-ai': `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  '@earendil-works/pi-tui': `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
} });
const { default: register, BACKENDS } = await jiti.import('../search.ts');
const { Type } = await jiti.import(`${root}/node_modules/@earendil-works/pi-ai/dist/index.js`);
const { Value } = await jiti.import(`${root}/node_modules/typebox/build/value/index.mjs`);
let tool, hook;
register({ registerTool(t) { tool = t; }, on(name, fn) { assert.equal(name, 'before_agent_start'); hook = fn; } });
const fields = {
 fffind: { pattern: Type.String(), path: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) },
 ffgrep: { pattern: Type.String(), caseSensitive: Type.Optional(Type.Boolean()) },
 brave_llm_search: { queries: Type.Array(Type.String()), freshness: Type.Optional(Type.String()) },
 exa_web_search: { query: Type.String(), numResults: Type.Optional(Type.Integer({ minimum: 1 })) },
 context7_search_library: { libraryName: Type.String(), queries: Type.Array(Type.String()) },
 context7_get_context: { libraryId: Type.String(), queries: Type.Array(Type.String()), type: Type.Optional(Type.String()) },
};
const tools = BACKENDS.map(name => ({ name, parameters: Type.Object(fields[name]) }));
const calls = [];
let large = false;
const ctx = { tools, async executeTool(name, args, { signal }) {
 calls.push({ name, args, signal });
 const isError = !Value.Check(tools.find(t => t.name === name).parameters, args) || signal?.aborted === true;
 return { toolCall: { id: 'search/1', name, arguments: args, type: 'toolCall' }, isError, result: { content: [{ type: 'text', text: large ? 'x'.repeat(40000) : 'src/search.ts:7:search' }], details: { cursor: 'next-page-42', libraryId: '/vercel/next.js', refId: 'source-17' } } };
} };
async function run(args, signal) {
 assert.equal(Value.Check(tool.parameters, args), true);
 const result = await tool.execute('search', args, signal, undefined, ctx);
 assert.equal(Value.Check(tool.outputSchema, result.structuredContent), true);
 return result;
}
await run({ operation: 'paths', query: 'search', options: { path: 'src/', cursor: 'page', limit: 2 } });
assert.deepEqual(calls.at(-1).args, { pattern: 'search', path: 'src/', cursor: 'page', limit: 2 });
await run({ operation: 'content', query: 'executeTool', options: { caseSensitive: true } });
await run({ operation: 'web', provider: 'brave', queries: ['q'], options: { freshness: 'pw' } });
await run({ operation: 'web', provider: 'exa', queries: ['a', 'b'], options: { numResults: 2 } });
assert.deepEqual(calls.slice(-2).map(c => c.args.query), ['a', 'b']);
await run({ operation: 'docs', action: 'discover', libraryName: 'next', queries: ['routing'] });
await run({ operation: 'docs', action: 'retrieve', libraryId: '/vercel/next.js', queries: ['routing'], options: { type: 'txt' } });
assert.equal((await run({ operation: 'web', provider: 'exa', queries: ['a'], options: { numResults: 'bad' } })).isError, true);
await assert.rejects(run({ operation: 'paths', query: 'a', options: { bogus: 1 } }), /Unknown/);
await assert.rejects(run({ operation: 'paths', query: 'a', options: { pattern: 'b' } }), /query fields/);
const abort = new AbortController(); abort.abort();
assert.equal((await run({ operation: 'content', query: 'a' }, abort.signal)).isError, true);
assert.equal(calls.at(-1).signal, abort.signal);
assert.equal(Value.Check(tool.parameters, { operation: 'web', queries: ['a'] }), false);
const loadout = tool.prepareLoadout({ callable: tools, declared: tools });
assert.deepEqual(loadout.hiddenDeclarations, BACKENDS);
assert.match(loadout.descriptions.search, /cursor:string/);
const prompt = { cwd: '/tmp', selectedTools: ['search', 'bash', ...BACKENDS], toolSnippets: { exa_web_search: 'old' }, toolGuidelines: { fffind: ['old'], bash: ['Never delete files without permission'] }, promptGuidelines: [], sections: {} };
hook({ systemPromptOptions: prompt });
assert.equal(prompt.sections.rules.includes('Use bash for file operations'), false);
assert.match(prompt.sections.rules, /Never delete/);
assert.equal(prompt.toolSnippets.exa_web_search, undefined);
large = true;
const result = await run({ operation: 'paths', query: 'search' });
assert.equal(result.structuredContent.truncated, true);
assert.ok(Buffer.byteLength(result.content[0].text) <= 24 * 1024);
assert.equal(result.structuredContent.results[0].details.cursor, 'next-page-42');
const full = JSON.parse(await readFile(result.structuredContent.fullOutputPath, 'utf8'));
assert.equal(full.results[0].content[0].text.length, 40000);
await rm(new URL('.', `file://${result.structuredContent.fullOutputPath}`).pathname, { recursive: true });
console.log('search: routing, nested validation/errors, cancellation, exposure, prompt rules, bounded output and preserved metadata passed');
