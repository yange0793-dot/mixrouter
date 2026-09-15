#!/usr/bin/env node
// mock-upstream — 假上游,用于验证 mixrouter 转发链路(不花真钱)
//   独立运行: node test/mock-upstream.js  → 监听 127.0.0.1:18790
//   测试内用: const { createMockUpstream } = require('./mock-upstream')
//   支持 /v1/messages + count_tokens(Anthropic)与 /v1/responses + /v1/chat/completions(OpenAI);
//   回显收到的模型名;每个请求记录进 requests 数组(url / headers / body),供测试断言转发细节
'use strict';
const http = require('http');

function createMockUpstream() {
  const requests = [];
  let sseWrapped = null;                 // { status, message, times }:HTTP 4xx 却挂着 text/event-stream 皮
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
      // New API 系网关对 stream=true 的请求就这么回错:状态码是真错、content-type 却是 SSE、
      // body 是一坨 JSON。上游这么干时,不能当消息流去解析
      if (sseWrapped && sseWrapped.times > 0) {
        sseWrapped.times--;
        res.writeHead(sseWrapped.status, { 'Content-Type': 'text/event-stream' });
        return res.end(JSON.stringify({ error: { message: sseWrapped.message, type: 'bad_response_status_code' }, type: 'error' }));
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 42 }));
      }
      if (req.url.includes('/responses')) return responsesReply(res, body, model);
      if (req.url.includes('/chat/completions')) return chatReply(res, body, model);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = ev => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        // message_start 的 usage 给 0、真值全放 message_delta:贴近 glm-5.3 这类网关的真实形状,
        // 钉住"抠 usage 必须取最后一次出现"(首匹配会把 17/9/5 全抠成 0)
        send({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model, usage: { input_tokens: 0, output_tokens: 0 } } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `mock-echo:${model}` } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 5 } });
        send({ type: 'message_stop' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: `mock-echo:${model}` }],
        stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 5 } }));
    });
  });
  return { server, requests, setSseWrappedError: (status, message, times = 1) => { sseWrapped = { status, message, times }; } };
}

// /v1/responses —— codex 的母语,原样回一个最小可用的 responses 流
function responsesReply(res, body, model) {
  const text = `mock-echo:${model}`;
  const usage = { input_tokens: 21, output_tokens: 13, total_tokens: 34, input_tokens_details: { cached_tokens: 4 } };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const rid = 'resp_mock', mid = 'msg_mock';
    sse({ type: 'response.created', response: { id: rid, object: 'response', status: 'in_progress', model, output: [] } });
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', status: 'in_progress', content: [] } });
    sse({ type: 'response.output_text.delta', item_id: mid, output_index: 0, content_index: 0, delta: text });
    sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } });
    sse({ type: 'response.completed', response: { id: rid, object: 'response', status: 'completed', model, output: [], usage } });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'resp_mock', object: 'response', status: 'completed', model,
    output: [{ type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage }));
}

// /v1/chat/completions —— chat 系网关(usage 只在主动要的时候才给)
function chatReply(res, body, model) {
  const text = `mock-echo:${model}`;
  // json-only-* 模型:无视 stream 请求、永远整包回 JSON(真实网关里会遇到,验证代理兜底摊成 SSE)
  if (body.stream && !String(model).startsWith('json-only')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    sse({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] });
    if (body.stream_options && body.stream_options.include_usage) {
      sse({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [],
        usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34, prompt_tokens_details: { cached_tokens: 4 } } });
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 } }));
}

if (require.main === module) {
  createMockUpstream().server.listen(18790, '127.0.0.1', () => console.log('mock upstream on 127.0.0.1:18790'));
}

module.exports = { createMockUpstream };
