'use strict';
// Chat Completions 转换层的终态与工具流完整性回归(mixrouter 的 claude 组 wire_api='chat' 线)。
// 每条都对应一条会被静默毁掉的行为,改坏了必须红:
//   - 上游断流被补成"正常结束"(答案被截断却标记成功)
//   - 截断(length)被工具块改写成 tool_use
//   - 并行工具的两个 index 参数串进同一个块
//   - [DONE] 之后不等上游关连接就直接挂住
//   - reasoning_content 漏进正文
//   - 200 里夹带的错误体被当成流解析
// 全部走内存桩,不连真实上游。
const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const wire = require('../lib/wire-chat.js');

const sse = o => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function upstreamFake(status = 200) {
  const up = new PassThrough();
  up.statusCode = status;
  return up;
}

// 只实现 relay 用到的那几个成员:writeHead / write / end / headersSent / writableEnded / destroyed
function sink() {
  return {
    headersSent: false, writableEnded: false, destroyed: false, statusCode: 0, headers: null, text: '',
    writeHead(status, headers) { this.headersSent = true; this.statusCode = status; this.headers = headers; },
    write(chunk) { this.text += String(chunk); return true; },
    end() { this.writableEnded = true; },
  };
}

function parseSse(text) {
  return text.split('\n\n').filter(raw => raw.trim()).map(raw => {
    const lines = raw.split('\n');
    const name = (lines.find(l => l.startsWith('event: ')) || '').slice(7);
    const data = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
    let json = null;
    try { json = JSON.parse(data); } catch {}
    return { name, json };
  });
}
const names = text => parseSse(text).map(e => e.name);
const relay = (up, res, opts) => wire.relayChatStream(up, res, 'glm-5.3-flash', opts);

// ---------------------------------------------------------------- 请求方向
test('请求:system 进首条,文本消息原样,恒流式且主动要 usage', () => {
  const out = wire.anthropicToChat({
    model: 'glm-5.3-flash', system: '你是助手', max_tokens: 100,
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.strictEqual(out.model, 'glm-5.3-flash');
  assert.strictEqual(out.stream, true, '上游恒流式:非流上游要等整篇生成才发头,大请求会撞首字节超时');
  assert.deepStrictEqual(out.stream_options, { include_usage: true }, '不要 usage,流式响应里就永远拿不到 token 统计');
  assert.deepStrictEqual(out.messages[0], { role: 'system', content: '你是助手' });
  assert.deepStrictEqual(out.messages[1], { role: 'user', content: '你好' });
});

test('请求:[1M] 后缀不发给上游', () => {
  const out = wire.anthropicToChat({ model: 'glm-5.3-flash[1M]', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(out.model, 'glm-5.3-flash');
});

test('请求:tool_use 变 assistant.tool_calls,同一条消息里的文本不丢', () => {
  const out = wire.anthropicToChat({
    model: 'm', messages: [
      { role: 'user', content: '几点?' },
      { role: 'assistant', content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'tu1', name: 'get_time', input: { tz: 'CST' } },
      ] },
    ],
  });
  const m = out.messages.at(-1);
  assert.strictEqual(m.role, 'assistant');
  assert.strictEqual(m.content, '我查一下');
  assert.strictEqual(m.tool_calls.length, 1);
  assert.strictEqual(m.tool_calls[0].id, 'tu1');
  assert.strictEqual(m.tool_calls[0].function.name, 'get_time');
  assert.strictEqual(m.tool_calls[0].function.arguments, '{"tz":"CST"}');
});

test('请求:tool_result 变独立 role:tool 消息,并排在用户补充文本前面', () => {
  const out = wire.anthropicToChat({
    model: 'm', messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: '现在是 12 点' },
        { type: 'text', text: '谢谢' },
      ] },
    ],
  });
  const roles = out.messages.map(m => m.role);
  assert.deepStrictEqual(roles, ['tool', 'user'], 'tool 必须紧跟 assistant(tool_calls),不能排在补充文本后面');
  assert.strictEqual(out.messages[0].tool_call_id, 'tu1');
  assert.strictEqual(out.messages[0].content, '现在是 12 点');
});

test('请求:tool_result 里的 tool_reference 如实降级为工具名(ToolSearch 场景)', () => {
  const out = wire.anthropicToChat({
    model: 'm', messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1',
        content: [{ type: 'tool_reference', tool_name: 'Bash' }, { type: 'tool_reference', tool_name: 'Read' }] }] },
    ],
  });
  assert.strictEqual(out.messages[0].content, 'Bash\nRead', '丢掉 tool_reference 会让模型以为没搜到工具而反复重搜');
});

test('请求:工具选择 none 不落成 auto,any 落成 required', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'T', input_schema: { type: 'object' } }] };
  assert.strictEqual(wire.anthropicToChat({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.strictEqual(wire.anthropicToChat({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.deepStrictEqual(wire.anthropicToChat({ ...base, tool_choice: { type: 'tool', name: 'T' } }).tool_choice,
    { type: 'function', function: { name: 'T' } });
  assert.strictEqual(wire.anthropicToChat(base).tools[0].function.name, 'T');
});

test('请求:顶层图片走 image_url data URI', () => {
  const out = wire.anthropicToChat({
    model: 'm', messages: [{ role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }],
  });
  const c = out.messages[0].content;
  assert.ok(Array.isArray(c), '有图时 content 用数组形状');
  assert.strictEqual(c[0].text, '看图');
  assert.strictEqual(c[1].image_url.url, 'data:image/png;base64,AAAA');
});

// ---------------------------------------------------------------- 非流响应
test('非流:文本 + usage 减掉缓存命中(Anthropic 口径)', () => {
  const msg = wire.chatToAnthropic({
    id: 'c1', model: 'glm-5.3-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 25, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 5 } },
  }, 'glm-5.3-flash');
  assert.strictEqual(msg.content[0].text, '好');
  assert.strictEqual(msg.stop_reason, 'end_turn');
  assert.strictEqual(msg.usage.input_tokens, 20, 'prompt_tokens 含缓存命中,不减掉就会按全价计');
  assert.strictEqual(msg.usage.output_tokens, 13);
  assert.strictEqual(msg.usage.cache_read_input_tokens, 5);
});

test('非流:tool_calls 变 tool_use 块,stop_reason=tool_use', () => {
  const msg = wire.chatToAnthropic({
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] } }],
  }, 'm');
  assert.strictEqual(msg.content.length, 1);
  assert.strictEqual(msg.content[0].type, 'tool_use');
  assert.deepStrictEqual(msg.content[0].input, { cmd: 'ls' });
  assert.strictEqual(msg.stop_reason, 'tool_use');
});

test('非流:finish_reason=length 如实表达截断,不被工具块改写', () => {
  const msg = wire.chatToAnthropic({
    choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '半句',
      tool_calls: [{ id: 'c1', function: { name: 'T', arguments: '{}' } }] } }],
  }, 'm');
  assert.strictEqual(msg.stop_reason, 'max_tokens');
});

test('非流:reasoning_content 变 thinking 块,在正文之前', () => {
  const msg = wire.chatToAnthropic({
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '好', reasoning_content: '先想一下' } }],
  }, 'm');
  assert.strictEqual(msg.content[0].type, 'thinking');
  assert.strictEqual(msg.content[0].thinking, '先想一下');
  assert.strictEqual(msg.content[0].signature, '');
  assert.strictEqual(msg.content[1].type, 'text');
  assert.strictEqual(msg.stop_reason, 'end_turn');
});

test('攒包路径:上游流式、客户端要非流时,思考内容也要攒进整包', () => {
  const wireResp = require('../lib/wire-responses.js');
  const text = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"glm-5.3-flash","content":[],"usage":{}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想了"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"一下"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":""}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"好"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":9}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const msg = wireResp.collectAnthropicMessage(text);
  assert.strictEqual(msg.content[0].type, 'thinking');
  assert.strictEqual(msg.content[0].thinking, '想了一下', '攒包路径丢思考的话,非流客户端又回到"看不到思考"');
  assert.strictEqual(msg.content[1].type, 'text');
  assert.strictEqual(msg.content[1].text, '好');
});

test('非流:200 里包着的 error 与残缺工具参数都要能拦下', () => {
  assert.ok(wire.chatErrorOf({ error: { message: '渠道池已满' } }));
  assert.strictEqual(wire.chatErrorOf({ choices: [{ finish_reason: 'stop', message: { content: '正常' } }] }), null);
  assert.ok(wire.chatErrorOf({ choices: [{ finish_reason: 'tool_calls',
    message: { tool_calls: [{ id: 'c1', function: { name: 'T', arguments: '{"a":' } }] } }] }),
  '参数是残缺 JSON 的 tool_call 不能当正常响应返回');
  assert.strictEqual(wire.chatErrorOf({ choices: [{ finish_reason: 'length',
    message: { tool_calls: [{ id: 'c1', function: { name: 'T', arguments: '{"a":' } }] } }] }), null,
  'length 截断本来就可能截在参数中间,交给 stop_reason 表达');
});

// ---------------------------------------------------------------- 流式:终态状态机
test('流式:文本流走完整事件序列,usage 取最后一次出现', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] }));
  up.write(sse({ id: 'c1', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { content: '好' } }] }));
  up.write(sse({ id: 'c1', model: 'glm-5.3-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 6 } } }));
  up.write(DONE);
  const r = await p;

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(names(res.text), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const evs = parseSse(res.text);
  const text = evs.filter(e => e.name === 'content_block_delta').map(e => e.json.delta.text).join('');
  assert.strictEqual(text, '你好', '中文多字节跨包不得被切坏');
  const md = evs.find(e => e.name === 'message_delta');
  assert.strictEqual(md.json.usage.input_tokens, 24, 'input 要减掉缓存命中');
  assert.strictEqual(md.json.usage.cache_read_input_tokens, 6);
  assert.strictEqual(r.usage.input_tokens, 24);
  assert.strictEqual(r.usage.output_tokens, 7);
  assert.strictEqual(r.aborted, false);
});

test('流式:[DONE] 到达即收尾,不等上游关连接', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '答案' } }] }));
  up.write(DONE);
  // 故意不 end:发完 [DONE] 还挂着 keep-alive 的站要能被这一条钉住
  const r = await p;
  assert.strictEqual(r.aborted, false);
  assert.ok(res.text.includes('event: message_stop'));
});

test('流式:有 finish_reason 但没 [DONE],上游关流时按正常终态收尾', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '好' } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  up.end();
  const r = await p;
  assert.strictEqual(r.aborted, false);
  assert.ok(res.text.includes('event: message_stop'));
});

test('流式:没有任何终态就断流,不得补 message_stop', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '半截答案' } }] }));
  up.destroy(new Error('socket hang up'));
  const r = await p;

  assert.ok(res.text.includes('半截答案'), '已经产出的内容要留给客户端');
  assert.ok(!res.text.includes('event: message_stop'), '断流不得伪造正常结束');
  assert.ok(!res.text.includes('"stop_reason":"end_turn"'), '断流不得给出正常 stop_reason');
  assert.ok(res.text.includes('event: error'), '要给出协议级 error');
  assert.strictEqual(r.aborted, true);
  assert.strictEqual(r.retryable, false);
});

test('流式:提交前夭折,一个字节都不下行,交给外层整条重试', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.destroy(new Error('ECONNRESET'));
  const r = await p;
  assert.strictEqual(res.headersSent, false, '可重试前提:还没给客户端写过头');
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(r.aborted, false);
});

test('流式:200 里夹带的裸 JSON 错误体在提交前被认出', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.write(JSON.stringify({ error: { message: '当前分组上游负载已饱和', type: 'bad_response_status_code' } }));
  up.end();
  const r = await p;
  assert.strictEqual(r.retryable, true, '一个字节都没下行,应当留给外层重试');
  assert.strictEqual(res.headersSent, false);
});

test('流式:200 里夹带的 HTML 错误页在提交前被认出', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write('<!doctype html><html><head><title>503 Service Unavailable</title></head></html>');
  up.end();
  const r = await p;
  assert.strictEqual(r.aborted, true);
  assert.ok(res.text.includes('event: error'));
});

test('流式:流里的 error 事件转成协议级 error', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '开' } }] }));
  up.write(sse({ error: { message: '上游推理服务 500', type: 'server_error' } }));
  up.end();
  const r = await p;
  assert.ok(res.text.includes('event: error'));
  assert.ok(res.text.includes('上游推理服务 500'));
  assert.strictEqual(r.aborted, true);
});

test('流式:finish_reason=length 收尾为 max_tokens', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '被砍了' } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }));
  up.write(DONE);
  const r = await p;
  const md = parseSse(res.text).find(e => e.name === 'message_delta');
  assert.strictEqual(md.json.delta.stop_reason, 'max_tokens');
});

// ---------------------------------------------------------------- 流式:工具
test('流式:工具参数增量攒齐后一次物化成 tool_use 块', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Bash', arguments: '' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  up.write(DONE);
  const r = await p;

  const evs = parseSse(res.text);
  const start = evs.find(e => e.name === 'content_block_start');
  assert.strictEqual(start.json.content_block.type, 'tool_use');
  assert.strictEqual(start.json.content_block.id, 'call_a');
  assert.strictEqual(start.json.content_block.name, 'Bash');
  const delta = evs.find(e => e.name === 'content_block_delta');
  assert.strictEqual(delta.json.delta.partial_json, '{"cmd":"ls"}', '参数分片要按到达顺序拼回完整 JSON');
  const md = evs.find(e => e.name === 'message_delta');
  assert.strictEqual(md.json.delta.stop_reason, 'tool_use');
  assert.strictEqual(r.aborted, false);
});

test('流式:两个并行工具的参数交错下发也不得串块', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'A', arguments: '{"x"' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'B', arguments: '{"y"' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ':2}' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  up.write(DONE);
  await p;

  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start');
  assert.strictEqual(starts.length, 2);
  const idx = starts.map(s => s.json.index);
  assert.deepStrictEqual(idx, [0, 1], '两个工具块必须各占一个序号且串行');
  // 每个块的参数只能来自自己的 index
  const forBlock = i => evs.filter(e => e.name === 'content_block_delta' && e.json.index === i)
    .map(e => e.json.delta.partial_json).join('');
  assert.strictEqual(forBlock(idx[0]), '{"x":1}');
  assert.strictEqual(forBlock(idx[1]), '{"y":2}');
  // 每个块都要有配对的 stop
  assert.deepStrictEqual(evs.filter(e => e.name === 'content_block_stop').map(e => e.json.index), [0, 1]);
});

test('流式:工具块必须等到参数完整才收尾,残缺参数不得伪装成功', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'A', arguments: '{"x":' } }] } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  up.write(DONE);
  const r = await p;
  assert.ok(res.text.includes('event: error'), '参数残缺的工具调用要以失败收场');
  assert.ok(!res.text.includes('"stop_reason":"tool_use"'), '不得把它当成功工具调用返回');
  assert.strictEqual(r.aborted, true);
});

// ---------------------------------------------------------------- 流式:杂项
test('流式:reasoning_content 转成 thinking 块(在正文之前),不漏进正文', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { reasoning_content: '让我想想…' } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '好' } }] }));
  up.write(DONE);
  await p;

  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start');
  assert.strictEqual(starts[0].json.content_block.type, 'thinking', '思考块必须在正文块之前');
  assert.strictEqual(starts[1].json.content_block.type, 'text');
  const thinking = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'thinking_delta')
    .map(e => e.json.delta.thinking).join('');
  assert.strictEqual(thinking, '让我想想…', '思考内容要完整转发(这是它们花钱买的能力)');
  // thinking 块以 signature_delta 收尾(占位空串),再 content_block_stop
  const sigs = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'signature_delta');
  assert.strictEqual(sigs.length, 1);
  assert.strictEqual(sigs[0].json.delta.signature, '');
  const text = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'text_delta')
    .map(e => e.json.delta.text).join('');
  assert.strictEqual(text, '好', '思考不得混进正文');
  assert.ok(!res.text.includes('"text":"让我想想'), '思考也不得作为正文下发');
});

test('流式:只有思考没有正文(全花在 reasoning)也要正常收尾', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { reasoning_content: '想不完…' } }] }));
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }));
  up.write(DONE);
  const r = await p;
  const evs = parseSse(res.text);
  assert.strictEqual(evs.filter(e => e.name === 'content_block_start')[0].json.content_block.type, 'thinking');
  assert.ok(evs.some(e => e.name === 'content_block_stop'), '思考块要被正常关闭');
  const md = evs.find(e => e.name === 'message_delta');
  assert.strictEqual(md.json.delta.stop_reason, 'max_tokens');
  assert.strictEqual(r.aborted, false);
});

test('流式:客户端断开后不再往上写(不炸)', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: 'a' } }] }));
  res.destroyed = true;
  res.writableEnded = true;
  up.write(sse({ id: 'c1', choices: [{ index: 0, delta: { content: 'b' } }] }));
  up.write(DONE);
  const r = await p;
  assert.strictEqual(r.aborted, false);
});

test('流式:上游把多字节中文切成两个 TCP 包也不得损坏', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  const frame = Buffer.from(sse({ id: 'c1', choices: [{ index: 0, delta: { content: '你好世界' } }] }) + DONE, 'utf8');
  // 在"你"的第二个字节中间切开
  const cut = frame.indexOf(Buffer.from('你', 'utf8')) + 1;
  up.write(frame.subarray(0, cut));
  up.write(frame.subarray(cut));
  await p;
  const text = parseSse(res.text).filter(e => e.name === 'content_block_delta').map(e => e.json.delta.text).join('');
  assert.strictEqual(text, '你好世界');
});

// ---------------------------------------------------------------- 端到端(mock 上游,不花真钱)
// 验证 mixrouter.js 的接线:claude 组 wire_api='chat' 的渠道,客户端说 Anthropic、
// 上游收 chat、响应翻回来;与会话/路由/日志的接缝也在这一段里。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createMockUpstream } = require('./mock-upstream.js');

const mock = createMockUpstream();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-wirechat-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
let mod, proxyPort, uiPort, proxySrv, uiSrv;

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

test('e2e setup:chat 型 Claude 渠道 + mock 上游', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  const upPort = mock.server.address().port;
  mock.server.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'p1', codex: null },
    claude: [{
      id: 'p1', name: 'tokenrhythm', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-tr-test',
      enabled: true, models: ['glm-5.3-flash'], wire_api: 'chat',
    }],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [{ id: 'r1', match: 'claude-opus', provider: 'p1', model: 'glm-5.3-flash', enabled: true }],
    default: { provider: 'p1', model: 'glm-5.3-flash' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  // 监听 handle 不 unref 会一直吊着事件循环,测试全绿了进程也不退出
  proxySrv.unref(); uiSrv.unref();
});

test('e2e 非流式:messages 翻成 chat 发上游,整包 JSON 翻回 Anthropic', async () => {
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] },
  });
  assert.strictEqual(r.status, 200);
  const seen = mock.requests[before];
  assert.strictEqual(seen.url, '/v1/chat/completions', '端点必须翻成 chat');
  assert.strictEqual(seen.body.model, 'glm-5.3-flash');
  assert.strictEqual(seen.body.stream, true, '上游恒流式:非流客户端由本进程攒整包回');
  assert.deepStrictEqual(seen.body.stream_options, { include_usage: true });
  assert.strictEqual(seen.headers['authorization'], 'Bearer sk-tr-test');
  assert.strictEqual(seen.headers['x-api-key'], undefined, '不给 OpenAI 系上游撒 Anthropic 头');
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'message');
  assert.strictEqual(j.content[0].text, 'mock-echo:glm-5.3-flash');
  assert.strictEqual(j.stop_reason, 'end_turn');
  assert.strictEqual(j.usage.input_tokens, 21 - 4, 'input 要扣掉缓存命中(Anthropic 口径)');
  assert.strictEqual(j.usage.cache_read_input_tokens, 4);
});

test('e2e 流式:客户端要流,收 Anthropic SSE 事件序列', async () => {
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '你好' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));
  assert.strictEqual(mock.requests[before].url, '/v1/chat/completions');
  const evs = parseSse(r.text);
  const ns = evs.map(e => e.name);
  assert.ok(ns.includes('message_start') && ns.includes('message_stop'), '必须是完整的 Anthropic 事件序列');
  assert.strictEqual(evs.filter(e => e.name === 'content_block_delta').map(e => e.json.delta.text).join(''), 'mock-echo:glm-5.3-flash');
  const md = evs.find(e => e.name === 'message_delta');
  assert.strictEqual(md.json.usage.input_tokens, 17);
});

test('e2e:count_tokens 在 chat 线上本地估算,不打上游', async () => {
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages/count_tokens', {
    body: { model: 'claude-opus-5', messages: [{ role: 'user', content: '数一下这段的 token' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(JSON.parse(r.text).input_tokens >= 1);
  assert.strictEqual(mock.requests.length, before, 'chat 上游没有 count_tokens 端点,不得打过去');
});

test('e2e:渠道 API 接受 claude 组的 wire_api=chat,并在 state 里可见', async () => {
  const st = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const p = st.providers.claude.find(x => x.id === 'p1');
  assert.strictEqual(p.wire_api, 'chat');
  assert.strictEqual(p.enabled, true);
});

test('e2e:测试探活走 /v1/models 而不是裸 /models', async () => {
  const r = await rawRequest(uiPort, 'POST', '/api/providers/p1/test', { body: {} });
  // 路径对不对由 mock 决定:mock 只认含 /models 的 GET;裸拼接会 404
  const j = JSON.parse(r.text);
  assert.strictEqual(j.ok, true, `探活应通过(mock 的 GET /v1/models 回 200): ${r.text.slice(0, 200)}`);
});
