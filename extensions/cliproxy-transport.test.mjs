// Run: node ~/.pi/agent/extensions/cliproxy-transport.test.mjs. Local mocks only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { runtimeRequire as require } from './lib/cliproxy/runtime.ts';
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url);
const originalWS = globalThis.WebSocket;
const extension = await jiti.import('./cliproxy-transport.ts');
const transport = await jiti.import('./lib/cliproxy/responses.ts');
const handlers = new Map(), notices = [];
extension.default({ registerProvider() {}, on(name, handler) { handlers.set(name, handler); } });
assert.equal(globalThis.WebSocket, originalWS);
const { WebSocketServer } = require('ws');
let mode = 'success', posts = 0, sockets = 0, upgrades = 0;
const payloads = [];
const reasoning = { type: 'reasoning', id: 'rs_local', summary: [], encrypted_content: 'opaque-local-ciphertext' };
const tool = { type: 'function_call', id: 'fc_local', call_id: 'call_local', name: 'lookup', arguments: '{"q":"local"}', status: 'completed' };
const completion = { type: 'response.completed', response: { id: 'resp_local', status: 'completed', output: [reasoning, tool], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } };
function auth(req) {
  assert.equal(req.url, '/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer local-test-key');
  assert.equal(req.headers['chatgpt-account-id'], undefined);
}
function events(ws) {
  for (const item of [reasoning, tool]) {
    ws.send(JSON.stringify({ type: 'response.output_item.added', output_index: item === reasoning ? 0 : 1, item: { ...item, ...(item === tool ? { arguments: '' } : {}) } }));
    ws.send(JSON.stringify({ type: 'response.output_item.done', output_index: item === reasoning ? 0 : 1, item }));
  }
  ws.send(JSON.stringify(completion));
}
const server = http.createServer(async (req, res) => {
  auth(req); for await (const chunk of req) { /* drain compressed or plain request */ }
  posts++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ ...completion, response: { ...completion.response, output: [] } })}\n\n`);
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  auth(req); upgrades++;
  if (mode === 'reject' || mode === 'reject-once') {
    if (mode === 'reject-once') mode = 'success';
    return socket.end('HTTP/1.1 503 Unavailable\r\n\r\n');
  }
  sockets++;
  wss.handleUpgrade(req, socket, head, ws => ws.on('message', raw => {
    const payload = JSON.parse(String(raw)); payloads.push(payload);
    assert.equal(payload.type, 'response.create');
    if (mode === 'partial' || mode === 'partial-missing') {
      ws.send(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_local', role: 'assistant', content: [] } }));
      ws.send(JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_local', output_index: 0, content_index: 0, delta: 'partial' }));
      if (mode === 'partial-missing') ws.send(JSON.stringify({ type: 'error', code: 'previous_response_not_found', message: 'missing' }));
      else setTimeout(() => ws.close(1011, 'local failure'), 10);
    } else events(ws);
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const model = { id: 'gpt-6.1-sol', name: 'local', api: 'openai-codex-responses', provider: 'cliproxy', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: true, input: ['text'], contextWindow: 272000, maxTokens: 128000, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 } };
const user = { role: 'user', content: 'local test', timestamp: 1 };
async function run(sessionId, messages = [user], extra = {}) {
  const stream = extension.cliproxyStream(model, { messages }, { apiKey: 'local-test-key', transport: 'auto', sessionId, reasoning: 'high', timeoutMs: 1000, ...extra });
  for await (const event of stream) handlers.get('message_update')({ message: event.partial ?? event.message ?? event.error }, { ui: { notify(text) { notices.push(text); } } });
  return stream.result();
}
try {
  const first = await run('reuse');
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  assert.equal(first.usage.input, 7); assert.equal(first.usage.cacheRead, 3); assert.equal(first.usage.output, 4);
  assert.equal(JSON.parse(first.content[0].thinkingSignature).encrypted_content, reasoning.encrypted_content);
  assert.equal(first.content[1].id, 'call_local|fc_local');
  assert.deepEqual(first.content[1].arguments, { q: 'local' });
  const history = [user, first, { role: 'toolResult', toolCallId: first.content[1].id, toolName: 'lookup', content: [{ type: 'text', text: 'found' }], isError: false, timestamp: 2 }];
  const second = await run('reuse', history);
  assert.equal(second.stopReason, 'toolUse', second.errorMessage);
  assert.equal(sockets, 1); assert.equal(payloads[1].previous_response_id, 'resp_local');
  assert.equal(payloads[1].input[0].type, 'function_call_output');
  await run('roundtrip', history, { transport: 'websocket' });
  assert.equal(payloads[2].input.find(item => item.type === 'reasoning').encrypted_content, reasoning.encrypted_content);
  assert.equal(payloads[2].input.find(item => item.type === 'function_call').id, 'fc_local');
  assert.equal(payloads[2].reasoning.effort, 'high');
  // Disposing one SDK child must not close another child's cached connection.
  handlers.get('session_shutdown')({}, { sessionManager: { getSessionId: () => 'roundtrip' } });
  const socketsBefore = sockets;
  await run('reuse', history);
  assert.equal(sockets, socketsBefore);
  mode = 'reject-once';
  const reconnectBefore = upgrades;
  const reconnected = await run('reconnect');
  assert.equal(reconnected.stopReason, 'toolUse', reconnected.errorMessage);
  assert.equal(upgrades - reconnectBefore, 2); assert.equal(posts, 0);
  mode = 'reject';
  const before = upgrades;
  const fallback = await run('fallback');
  assert.equal(fallback.stopReason, 'stop', fallback.errorMessage);
  assert.equal(upgrades - before, 2); assert.equal(posts, 1); assert.equal(notices.length, 1);
  for (const failure of ['partial', 'partial-missing']) {
    mode = failure; const requests = payloads.length;
    const failed = await run(failure);
    assert.equal(failed.stopReason, 'error');
    assert.equal(failed.content[0].text, 'partial');
    assert.equal(payloads.length - requests, 1); assert.equal(posts, 1);
    assert.ok(!failed.diagnostics?.some(d => d.details?.fallbackTransport === 'sse'));
  }
  assert.equal(globalThis.WebSocket, originalWS);
  console.log('PASS socket reuse + continuation; encrypted reasoning/tool ID/usage/effort roundtrip; safe reconnect; visible SSE fallback; no retry after partial output or missing continuation error');
} finally {
  transport.closeOpenAICodexWebSocketSessions();
  for (const client of wss.clients) client.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
