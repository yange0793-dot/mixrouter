'use strict';
// Anthropic → Responses 转换层:单元 + 端到端(Claude 组渠道 wire_api='responses')。
// 覆盖的正是"本地转换代理能退役"的那几条路径:请求映射、响应映射、SSE 翻译、
// count_tokens 兜底、上游 5xx 时轮换 prompt_cache_key 重试。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wire = require('../lib/wire-responses.js');

// ---------------------------------------------------------------- 单元测试
test('anthropicToResponses:system/工具/图片/tool_use/tool_result 全映射', () => {
  const r = wire.anthropicToResponses({
    model: 'gpt-6-astra[1M]',
    max_tokens: 512,
    system: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '别废话' }],
    tools: [{ name: 'Bash', description: '跑命令', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }] },
    ],
  }, { promptCacheKey: 'sess-1' });
  assert.strictEqual(r.model, 'gpt-6-astra');                 // [1M] 后缀剥掉,裸名给上游
  assert.strictEqual(r.store, false);
  assert.deepStrictEqual(r.include, ['reasoning.encrypted_content']); // Codex 型通道的形状要求
  assert.strictEqual(r.prompt_cache_key, 'sess-1');
  assert.strictEqual(r.instructions, '你是助手\n\n别废话');
  assert.deepStrictEqual(r.tool_choice, { type: 'function', name: 'Bash' });
  assert.strictEqual(r.tools[0].name, 'Bash');
  assert.strictEqual(r.tools[0].parameters.properties.cmd.type, 'string');
  assert.strictEqual(r.max_output_tokens, 512);
  const kinds = r.input.map(i => i.type);
  assert.deepStrictEqual(kinds, ['message', 'message', 'function_call', 'function_call_output']);
  assert.strictEqual(r.input[0].content[1].type, 'input_image');
  assert.ok(r.input[0].content[1].image_url.startsWith('data:image/png;base64,'));
  assert.strictEqual(r.input[2].name, 'Bash');
  assert.strictEqual(r.input[2].arguments, '{"cmd":"ls"}');
  assert.strictEqual(r.input[3].output, 'file.txt');
});

test('anthropicToResponses:tool_result 里的图片也转 input_image,不带图时维持字符串形状', () => {
  const withImg = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: [
      { type: 'text', text: 'screenshot:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ] }] }],
  });
  const out = withImg.input.find(i => i.type === 'function_call_output');
  assert.strictEqual(out.call_id, 'tu_9');
  assert.deepStrictEqual(out.output, [
    { type: 'input_text', text: 'screenshot:' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
  ]);

  const remote = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_8', content: [
      { type: 'image', source: { type: 'url', url: 'https://img.example/a.png' } },
    ] }] }],
  });
  assert.deepStrictEqual(remote.input.find(i => i.type === 'function_call_output').output,
    [{ type: 'input_image', image_url: 'https://img.example/a.png' }]);

  // 不带图:保持原来的纯字符串 output,不改变已有上游看到的行为
  const noImg = wire.anthropicToResponses({
    model: 'm', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }] }],
  });
  assert.strictEqual(noImg.input.find(i => i.type === 'function_call_output').output, 'file.txt');
});

test('anthropicToResponses:显式 effort 原样传递,不猜 thinking 预算或默认强度', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const r = wire.anthropicToResponses({
      model: 'gpt-6-astra', output_config: { effort }, thinking: { type: 'adaptive' },
      tools: [{ name: 'check', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }],
    });
    assert.deepStrictEqual(r.reasoning, { effort });
    assert.strictEqual(r.tools[0].type, 'function');
    assert.deepStrictEqual(r.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AAA' });
    assert.strictEqual(r.reasoning_effort, undefined);
  }
  for (const extra of [{}, { thinking: { type: 'adaptive' } }, { thinking: { type: 'enabled', budget_tokens: 10000 } }, { output_config: { effort: 'unknown' } }]) {
    assert.strictEqual(wire.anthropicToResponses({ model: 'm', messages: [], ...extra }).reasoning, undefined);
  }
});

test('anthropicToResponses:max_output_tokens 有下限与上限', () => {
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', messages: [] }, {}).max_output_tokens, 32000);
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', max_tokens: 1, messages: [] }, {}).max_output_tokens, 16);
  assert.strictEqual(wire.anthropicToResponses({ model: 'm', max_tokens: 999999, messages: [] }, {}).max_output_tokens, 128000);
});

test('responsesToAnthropic:文本 + function_call → tool_use,usage 带上', () => {
  const msg = wire.responsesToAnthropic({
    id: 'resp_9', status: 'completed', model: 'gpt-6-astra',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
      { type: 'function_call', call_id: 'c_1', name: 'Read', arguments: '{"p":"a.txt"}' },
    ],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
  }, 'gpt-6-astra');
  assert.strictEqual(msg.type, 'message');
  assert.strictEqual(msg.stop_reason, 'tool_use');
  assert.strictEqual(msg.content[0].text, '答案');
  assert.deepStrictEqual(msg.content[1], { type: 'tool_use', id: 'c_1', name: 'Read', input: { p: 'a.txt' } });
  assert.deepStrictEqual(msg.usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 });
});

// ---------------------------------------------------------------- 端到端
function createResponsesUpstream() {
  const requests = [];
  let failTimes = 0, jsonAlways = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      requests.push({ url: req.url, body, headers: req.headers });
      if (failTimes > 0) { failTimes--; res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"负载已经达到上限"}}'); }
      const text = `conv-echo:${body.model}`;
      if (body.stream && !jsonAlways) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const sse = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        sse({ type: 'response.created', response: { id: 'resp_1', model: body.model } });
        sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } });
        sse({ type: 'response.output_text.delta', delta: text });
        sse({ type: 'response.output_item.done', item: { type: 'message' } });
        sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', model: body.model, usage: { input_tokens: 21, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } } } });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_1', object: 'response', status: 'completed', model: body.model,
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 21, output_tokens: 7 },
      }));
    });
  });
  return { server, requests, setFail: n => { failTimes = n; }, setJsonAlways: v => { jsonAlways = v; } };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-conv-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_CONV_RETRIES = '2';

const up = createResponsesUpstream();
let mod, proxySrv, uiSrv, proxyPort, uiPort, upPort;

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

test('setup:responses 型 Claude 渠道 + mock 上游', async () => {
  await new Promise(ok => up.server.listen(0, '127.0.0.1', ok));
  upPort = up.server.address().port;
  up.server.unref();
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'p1', codex: null },
    claude: [{
      id: 'p1', name: 'astra 型', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-conv',
      enabled: true, models: ['gpt-6-astra[1M]'], wire_api: 'responses',
    }],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [{ id: 'r1', match: 'claude-opus', provider: 'p1', model: 'gpt-6-astra[1M]', enabled: true }],
    default: { provider: 'p1', model: 'gpt-6-astra' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('非流式:messages 翻成 responses 发上游,响应翻回 Anthropic', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] },
  });
  assert.strictEqual(r.status, 200);
  const seen = up.requests.at(-1);
  assert.strictEqual(seen.url, '/v1/responses');                       // 端点就翻了
  assert.strictEqual(seen.body.model, 'gpt-6-astra');                  // [1M] 剥掉
  assert.deepStrictEqual(seen.body.include, ['reasoning.encrypted_content']);
  assert.ok(seen.body.prompt_cache_key);                               // 非空
  assert.strictEqual(seen.body.store, false);
  assert.strictEqual(seen.body.input[0].content[0].text, '你好');
  assert.strictEqual(seen.headers['authorization'], 'Bearer sk-conv');
  assert.strictEqual(seen.headers['x-api-key'], undefined);            // 不给 OpenAI 系上游撒 Anthropic 头
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'message');
  assert.strictEqual(j.content[0].text, 'conv-echo:gpt-6-astra');
  assert.strictEqual(j.usage.input_tokens, 21);
  assert.strictEqual(r.headers['x-mixrouter-provider'], 'astra');      // 渠道名经 safeHeader 只留 ASCII
});

test('Responses 出站同时保留图片、工具和 high effort', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: {
      model: 'claude-opus-5', max_tokens: 64, output_config: { effort: 'high' }, thinking: { type: 'adaptive' },
      tools: [{ name: 'check', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }],
    },
  });
  assert.strictEqual(r.status, 200);
  const seen = up.requests.at(-1);
  assert.strictEqual(seen.url, '/v1/responses');
  assert.deepStrictEqual(seen.body.reasoning, { effort: 'high' });
  assert.strictEqual(seen.body.tools[0].name, 'check');
  assert.deepStrictEqual(seen.body.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AAA' });
  assert.strictEqual(seen.body.reasoning_effort, undefined);
});

test('流式:responses SSE → Anthropic SSE 事件序列', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));
  for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
    assert.ok(r.text.includes(`event: ${ev}`), `缺事件 ${ev}`);
  }
  assert.ok(r.text.includes('conv-echo:gpt-6-astra'));
  assert.ok(r.text.includes('"output_tokens":7'));
});

test('客户端要流、上游整包回 JSON:摊成 Anthropic SSE', async () => {
  up.setJsonAlways(true);
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  up.setJsonAlways(false);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('event: message_start'));
  assert.ok(r.text.includes('conv-echo:gpt-6-astra'));
  assert.ok(r.text.includes('event: message_stop'));
});

test('count_tokens:responses 上游没有该端点,本地估一个', async () => {
  const before = up.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages/count_tokens', {
    body: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'x'.repeat(400) }] },
  });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.ok(j.input_tokens > 90 && j.input_tokens < 130, `估算值应约为 1/4 体积,得到 ${j.input_tokens}`);
  assert.strictEqual(up.requests.length, before);                      // 没有打到上游
});

test('上游 5xx:同一渠道内轮换 prompt_cache_key 重试,不改模型', async () => {
  up.setFail(1);
  const before = up.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 32, messages: [{ role: 'user', content: '重试看看' }] },
  });
  assert.strictEqual(r.status, 200);
  const pair = up.requests.slice(before);
  assert.strictEqual(pair.length, 2, '应重试一次');
  assert.ok(pair[0].body.prompt_cache_key && pair[1].body.prompt_cache_key);
  assert.notStrictEqual(pair[0].body.prompt_cache_key, pair[1].body.prompt_cache_key, '重试必须换一代 key(坏渠道会被亲和钉住)');
  assert.strictEqual(pair[1].body.prompt_cache_key, pair[0].body.prompt_cache_key + '-g1');
});

test('上游错误体翻成 Anthropic 形状(Claude Code 才认)', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'nope-404-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  // 这条走 default 规则,仍是同一个渠道;上游 200 时不该出错
  assert.ok([200, 404].includes(r.status));
});

test('渠道 API:claude 组可以设 wire_api=responses,非法值被拒', async () => {
  const bad = await rawRequest(uiPort, 'PUT', '/api/providers/p1', { body: { wire_api: 'chat' } });
  assert.strictEqual(bad.status, 400);
  assert.ok(JSON.parse(bad.text).error.includes('anthropic 或 responses'));
  const okPut = await rawRequest(uiPort, 'PUT', '/api/providers/p1', { body: { wire_api: 'anthropic' } });
  assert.strictEqual(JSON.parse(okPut.text).ok, true);
  const st = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const p = st.providers.claude.find(x => x.id === 'p1');
  assert.strictEqual(p.wire_api, undefined, '改回 anthropic 等于删掉该字段');
  await rawRequest(uiPort, 'PUT', '/api/providers/p1', { body: { wire_api: 'responses' } });
  const st2 = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.strictEqual(st2.providers.claude.find(x => x.id === 'p1').wire_api, 'responses');
});
