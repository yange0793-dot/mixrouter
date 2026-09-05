#!/usr/bin/env node
// mock-upstream — 假 Anthropic 上游,用于验证 mixrouter 转发链路(不花真钱)
//   独立运行: node test/mock-upstream.js  → 监听 127.0.0.1:18790
//   测试内用: const { createMockUpstream } = require('./mock-upstream')
//   支持 /v1/messages(流式/非流式)与 count_tokens;回显收到的模型名;
//   每个请求记录进 requests 数组(url / headers / body),供测试断言转发细节
'use strict';
const http = require('http');

function createMockUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    }
    if (req.method !== 'POST') { res.writeHead(404); return res.end('not found'); }
    const cs = [];
    req.on('data', c => cs.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch {}
      requests.push({ url: req.url, headers: req.headers, body });
      const model = body.model || '(none)';
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 42 }));
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = ev => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        send({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model, usage: { input_tokens: 17, cache_read_input_tokens: 5 } } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `mock-echo:${model}` } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
        send({ type: 'message_stop' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: `mock-echo:${model}` }],
        stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 5 } }));
    });
  });
  return { server, requests };
}

if (require.main === module) {
  createMockUpstream().server.listen(18790, '127.0.0.1', () => console.log('mock upstream on 127.0.0.1:18790'));
}

module.exports = { createMockUpstream };
