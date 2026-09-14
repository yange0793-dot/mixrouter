'use strict';
// Responses 转换层的**终态与工具流完整性**回归。
// 这里每一条都对应一个实测复现过的缺陷(审查块1/1续/6/6续/7),改坏了必须红:
//   - 上游断流被补成"正常结束"(答案被截断却标记成功)
//   - 截断(incomplete)被工具块改写成 tool_use/end_turn
//   - 中文多字节跨 TCP 包被切坏、CRLF 分帧整条丢
//   - 两个 function_call 的增量参数拼进同一个块
//   - 工具参数残缺仍以 tool_use 正常收尾
//   - "先 res.end 再异步结算 usage"导致成功被记成 client closed
// 全部走内存桩,不连真实上游。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PassThrough } = require('node:stream');

const wire = require('../lib/wire-responses.js');

const EOL = '\n';
const sse = (o, eol = EOL) => `event: ${o.type}${eol}data: ${JSON.stringify(o)}${eol}${eol}`;

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
const relay = (up, res, opts) => wire.relayAnthropicStream(up, res, 'gpt-6-astra', opts);

// ---------------------------------------------------------------- 终态状态机
test('断流:上游中断后不得补 message_stop,只发协议级 error', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '半截答案' }));
  up.destroy(new Error('socket hang up'));
  const r = await p;

  assert.ok(res.text.includes('半截答案'), '已经产出的内容要留给客户端');
  assert.ok(!res.text.includes('event: message_stop'), '断流不得伪造正常结束');
  assert.ok(!res.text.includes('"stop_reason":"end_turn"'), '断流不得给出正常 stop_reason');
  assert.ok(res.text.includes('event: error'), '要给出协议级 error');
  assert.strictEqual(r.aborted, true, '外层要能知道这是夭折,好记日志');
  assert.strictEqual(r.retryable, false);
});

test('EOF 但没给终态:同样不算成功', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '只有半句' }));
  up.end();
  const r = await p;
  assert.ok(!res.text.includes('event: message_stop'));
  assert.ok(res.text.includes('event: error'));
  assert.strictEqual(r.aborted, true);
});

test('提交前夭折:一个字节都不下行,交给外层整条重试', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
  up.destroy(new Error('ECONNRESET'));
  const r = await p;
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(res.headersSent, false, '重试前提是还没给客户端写过字节');
  assert.strictEqual(res.text, '');
  assert.strictEqual(res.writableEnded, false, '这条 res 还要留给下一次尝试,不能 end 掉');
});

test('200 里夹带的错误体:提交前整条重试,同样不许 end 下游', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: true });
  up.write('data: {"type":"error","error":{"message":"上游渠道池打满"}}\n\n');
  const r = await p;
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(res.headersSent, false);
  assert.strictEqual(res.writableEnded, false, '重试要用同一条 res,提前 end 会让下一次什么都写不进去');
});

test('completed:当场结算并结束下游,不枯等上游 EOF', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } }));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '答案' }));
  up.write(sse({
    type: 'response.completed',
    response: { id: 'r1', status: 'completed', model: 'gpt-6-astra', usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 10 } } },
  }));
  // 故意不 end 上游:旧实现要等上游 end/close 才 resolve,下游与日志都被晾着
  let timer = null;
  const guard = new Promise((_, bad) => { timer = setTimeout(() => bad(new Error('给了终态却还在等上游 EOF')), 800); });
  if (timer.unref) timer.unref();
  const r = await Promise.race([p, guard]);
  clearTimeout(timer);

  assert.strictEqual(res.writableEnded, true, '终态一到就该结束下游');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
  assert.strictEqual(r.aborted, false);
  // 交回外层的 usage 是 Anthropic 口径:input 已扣掉缓存命中(30-10),缓存另计
  assert.strictEqual(r.usage.input_tokens, 20);
  assert.strictEqual(r.usage.output_tokens, 9);
  assert.strictEqual(r.usage.cache_read_input_tokens, 10);
  assert.ok(res.text.includes('"input_tokens":20'), `message_delta 的 input 应为 30-10,实际:${res.text}`);
  assert.ok(res.text.includes('"cache_read_input_tokens":10'));
});

test('下游 close 早于结算回调时,writableFinished 能把它和真取消区分开', async () => {
  // 真机形态:close 走 nextTick,比 promise 微任务还早,光靠 resolve 顺序压不住。
  // 外层(mixrouter.js 的 res.on('close'))据此放行,不再把成功记成 client closed。
  const seen = [];
  const server = http.createServer((req, res) => {
    let finalized = false;
    res.on('close', () => { seen.push({ ev: 'close', writableFinished: res.writableFinished, finalized }); });
    const up = upstreamFake();
    relay(up, res, {}).then(() => { finalized = true; seen.push({ ev: 'settled' }); });
    up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  server.unref();
  await new Promise((ok, bad) => {
    const creq = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/messages', headers: { connection: 'close' } }, cres => {
      cres.resume();
      cres.on('end', ok);
    });
    creq.on('error', bad);
    creq.end();
  });
  await new Promise(ok => setTimeout(ok, 50));

  const close = seen.find(s => s.ev === 'close');
  assert.ok(close, '正常写完也会收到 close 事件');
  assert.strictEqual(close.writableFinished, true, 'close 时刻响应必须已 finished,外层才能据此放行');
});

test('incomplete:stop_reason 必须是 max_tokens,不能被工具块改写成 tool_use', async () => {
  for (const terminal of [
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    { type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  ]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: false });
    up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
    up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"a.txt","content":"写到一' }));
    up.write(sse(terminal));
    await p;
    const evs = parseSse(res.text);
    const delta = evs.find(e => e.name === 'message_delta');
    assert.ok(delta, '应给出 message_delta');
    assert.strictEqual(delta.json.delta.stop_reason, 'max_tokens', `${terminal.type} 被截断必须如实表达`);
    assert.ok(res.text.includes('event: message_stop'), '截断仍是上游给出的终态,可以正常收尾');
    assert.ok(!res.text.includes('event: error'));
  }
});

test('completed 里带 status=failed / error 事件:不发 message_stop', async () => {
  for (const ev of [
    { type: 'response.completed', response: { status: 'failed', error: { message: '渠道池打满' } } },
    { type: 'response.failed', response: { status: 'failed', error: { message: '渠道池打满' } } },
    { type: 'error', error: { message: '渠道池打满' } },
  ]) {
    const up = upstreamFake(); const res = sink();
    const p = relay(up, res, { mayRetry: false });
    up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'x' }));
    up.write(sse(ev));
    const r = await p;
    assert.ok(!res.text.includes('event: message_stop'), `${ev.type} 不得以正常结束收尾`);
    assert.ok(res.text.includes('渠道池打满'), '原始错误要带给客户端');
    assert.strictEqual(r.aborted, true);
  }
});

// ---------------------------------------------------------------- 工具流完整性
test('多工具交错:两个 function_call 各自成块,参数不串', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'Write' } }));
  up.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'Edit' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"p":"a"}' }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"p":"b"}' }));
  up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'Write' } }));
  up.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'Edit' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } }));
  await p;

  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start');
  assert.deepStrictEqual(starts.map(s => [s.json.index, s.json.content_block.id, s.json.content_block.name]),
    [[0, 'a', 'Write'], [1, 'b', 'Edit']], '每个工具调用一个块,id/name 归属正确');
  const args = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'input_json_delta');
  assert.deepStrictEqual(args.map(a => [a.json.index, JSON.parse(a.json.delta.partial_json)]),
    [[0, { p: 'a' }], [1, { p: 'b' }]], '参数不许拼成一个');
  const delta = evs.find(e => e.name === 'message_delta');
  assert.strictEqual(delta.json.delta.stop_reason, 'tool_use');
});

test('零参数工具调用也要有 tool_use 块', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c9', name: 'Bash' } }));
  up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c9', name: 'Bash' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  const evs = parseSse(res.text);
  const start = evs.find(e => e.name === 'content_block_start');
  assert.strictEqual(start.json.content_block.type, 'tool_use');
  assert.strictEqual(start.json.content_block.id, 'c9');
  assert.deepStrictEqual(start.json.content_block.input, {});
  assert.strictEqual(evs.find(e => e.name === 'message_delta').json.delta.stop_reason, 'tool_use');
});

test('工具参数残缺却报 completed:按失败处理,不当成可执行调用', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"a.tx' }));
  up.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'Write' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  const r = await p;
  assert.ok(!res.text.includes('event: message_stop'));
  assert.ok(res.text.includes('event: error'));
  assert.strictEqual(r.aborted, true);
});

// ---------------------------------------------------------------- 增量解码
test('中文跨 TCP 包:多字节字符被切开也不许出现替换符', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  const frame = Buffer.from(sse({ type: 'response.output_text.delta', output_index: 0, delta: '中文答案' }), 'utf8');
  const cut = frame.indexOf(Buffer.from('中')) + 1; // 切在「中」的三个字节中间
  up.write(frame.subarray(0, cut));
  up.write(frame.subarray(cut));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  assert.ok(res.text.includes('中文答案'), `实际收到:${res.text}`);
  assert.ok(!res.text.includes('�'), '不许出现 U+FFFD 替换符');
});

test('CRLF 分帧的合法 SSE 也要认', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } }, '\r\n'));
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'CRLF 也要通' }, '\r\n'));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: { output_tokens: 3 } } }, '\r\n'));
  await p;
  assert.ok(res.text.includes('CRLF 也要通'), '只认 \\n\\n 会把 CRLF 流整条丢掉');
  assert.ok(res.text.includes('event: message_stop'));
});

test('注释行(上游心跳)不干扰分帧', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(': keep-alive\n\n');
  up.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'ok' }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  assert.ok(res.text.includes('ok'));
  assert.ok(res.text.includes('event: message_stop'));
});

test('上游不发 output_index:增量要归到同一个块,不能每个 delta 开一块', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_text.delta', delta: '甲' }));
  up.write(sse({ type: 'response.output_text.delta', delta: '乙' }));
  up.write(sse({ type: 'response.output_text.delta', delta: '丙' }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  const evs = parseSse(res.text);
  assert.strictEqual(evs.filter(e => e.name === 'content_block_start').length, 1, '应只有一个文本块');
  const text = evs.filter(e => e.name === 'content_block_delta' && e.json.delta.type === 'text_delta')
    .map(e => e.json.delta.text).join('');
  assert.strictEqual(text, '甲乙丙');
});

test('工具事件换称呼(只带 id / 只带 index)也算同一次调用', async () => {
  const up = upstreamFake(); const res = sink();
  const p = relay(up, res, { mayRetry: false });
  up.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read' } }));
  up.write(sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"p":1}' }));
  up.write(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', name: 'Read' } }));
  up.write(sse({ type: 'response.completed', response: { status: 'completed', usage: {} } }));
  await p;
  const evs = parseSse(res.text);
  const starts = evs.filter(e => e.name === 'content_block_start' && e.json.content_block.type === 'tool_use');
  assert.strictEqual(starts.length, 1, '一次工具调用只能出一个块');
  const args = evs.find(e => e.name === 'content_block_delta' && e.json.delta.type === 'input_json_delta');
  assert.strictEqual(args.json.delta.partial_json, '{"p":1}', '增量要落到它自己的调用上');
  assert.strictEqual(evs.find(e => e.name === 'message_delta').json.delta.stop_reason, 'tool_use');
});

// ---------------------------------------------------------------- 非流式路径
test('responsesErrorOf:三种"200 但其实失败"都要认出来', () => {
  assert.ok(wire.responsesErrorOf({ status: 'failed', error: { message: 'mock failure' } }));
  assert.ok(wire.responsesErrorOf({ error: { message: '渠道池打满' } }));
  assert.ok(wire.responsesErrorOf({
    status: 'completed',
    output: [{ type: 'function_call', call_id: 'c1', name: 'Write', arguments: '{"file_path":"a.tx' }],
  }), 'completed 带着残缺工具参数同样是失败');
  assert.strictEqual(wire.responsesErrorOf({ status: 'completed', output: [{ type: 'message', content: [] }] }), null);
  assert.strictEqual(wire.responsesErrorOf({ status: 'incomplete', output: [] }), null, '截断不是错误');
});

test('responsesToAnthropic:截断与缓存计数的映射', () => {
  const cut = wire.responsesToAnthropic({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '半句' }] }] }, 'm');
  assert.strictEqual(cut.stop_reason, 'max_tokens');
  const withCache = wire.responsesToAnthropic({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    usage: { input_tokens: 200, output_tokens: 5, input_tokens_details: { cached_tokens: 150 } },
  }, 'm');
  assert.strictEqual(withCache.usage.input_tokens, 50, '缓存命中要从 input 里减掉(Anthropic 语义)');
  assert.strictEqual(withCache.usage.cache_read_input_tokens, 150);
});

test('tool_choice:none 原样传 none,不许变成 auto', () => {
  const base = { model: 'm', messages: [], tools: [{ name: 'T', input_schema: { type: 'object', properties: {} } }] };
  assert.strictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.strictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'auto' } }).tool_choice, 'auto');
  assert.strictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.deepStrictEqual(wire.anthropicToResponses({ ...base, tool_choice: { type: 'tool', name: 'T' } }).tool_choice, { type: 'function', name: 'T' });
});
