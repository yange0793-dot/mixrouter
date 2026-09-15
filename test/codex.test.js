'use strict';
// v3.1 Codex 通路测试:OpenAI 端点(/v1/responses、/v1/chat/completions)、
// responses→chat 协议翻译、Codex 组路由与会话粘性、会话 API、日志分组
// mock 上游 + 临时数据目录,不触碰真实配置与真实上游
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');
const mock = createMockUpstream();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-codex-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '3';

const mod = require('../mixrouter.js');
const {
  sessionIdentity, sessionLabel, codexHeaderSessionId, codexBodySessionId, codexFirstUserText,
  responsesToChat, chatJsonToResponses, chatToolChoice, extractUsageOpenAI, extractUsageFor,
  classifyProxyRequest, wireOf, buildOpenAiHeaders, writeCodexConfig, switchCodexRouter, switchClaudeRouter,
  liveState, ROUTER_ID, ROUTER_URL, ROUTER_TOKEN, ROUTER_SECTION, normalizeRule, _state,
} = mod;

// 会吐工具调用的 chat 上游:验证响应方向的 function_call 翻译
function createToolCallUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const cs = [];
    req.on('data', c => cs.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(cs).toString('utf8') || '{}') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '先跑一下命令' } }] });
      sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] });
      sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] });
      sse({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, requests };
}
// 固定 5xx 的上游(失败转移用)
function createFailingUpstream(status) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'boom' } })); });
  });
  return { server };
}

let proxySrv, uiSrv, proxyPort, uiPort, mockPort, toolPort, failPort;

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

const CODEX_BODY = (model = 'gpt-5.6-sol') => ({
  model, instructions: 'You are a coding agent.', stream: true, store: false,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我看看这个仓库' }] }],
});
// 发一个带 Codex 会话头的 responses 请求,返回落到哪个渠道(看 mock 收到的 key)与响应
async function callCodex(sessionId, { model = 'gpt-5.6-sol', body = {}, headers = {}, path: reqPath = '/v1/responses' } = {}) {
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', reqPath, {
    headers: { 'Content-Type': 'application/json', 'session-id': sessionId, 'User-Agent': 'codex_exec/0.154.0', ...headers },
    body: { ...CODEX_BODY(model), ...body },
  });
  const got = mock.requests.length > before ? mock.requests.at(-1) : null;
  return { status: r.status, headers: r.headers, text: r.text, hit: got, key: got ? got.headers.authorization : null };
}
const lastLog = async () => JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text).logs[0];
const setRoutes = (rules, def = { provider: '', model: '' }) => {
  _state.routes = { rules: rules.map(normalizeRule), default: normalizeRule(def) };
  _state.resetPools();
};

test('setup:mock 上游(含工具调用/故障两组)+ 代理与控制台', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port; mock.server.unref();
  const tool = createToolCallUpstream();
  await new Promise(ok => tool.server.listen(0, '127.0.0.1', ok));
  toolPort = tool.server.address().port; tool.server.unref();
  const fail = createFailingUpstream(500);
  await new Promise(ok => fail.server.listen(0, '127.0.0.1', ok));
  failPort = fail.server.address().port; fail.server.unref();

  const base = `http://127.0.0.1:${mockPort}`;
  const provs = {
    claude: [{ id: 'p1', name: 'claude渠道', base_url: base, api_key: 'sk-claude', enabled: true, models: ['claude-opus-5'], slots: {} }],
    codex: [
      // 两个 responses 协议渠道 + 一个 chat 协议渠道(要翻译)+ 一个 chat 协议的工具调用渠道 + 一个故障渠道
      { id: 'k1', name: 'codex一', base_url: base, api_key: 'sk-k1', enabled: true, model: 'gpt-5.6-sol', wire_api: 'responses' },
      { id: 'k2', name: 'codex二', base_url: base, api_key: 'sk-k2', enabled: true, model: 'gpt-5.6-terra', wire_api: 'responses' },
      { id: 'k3', name: 'chat系', base_url: base, api_key: 'sk-k3', enabled: true, model: 'glm-5.3-flash', wire_api: 'chat' },
      { id: 'ktool', name: '工具渠道', base_url: `http://127.0.0.1:${toolPort}`, api_key: 'sk-tool', enabled: true, model: 'gpt-5.6-sol', wire_api: 'chat' },
      { id: 'kbad', name: '坏渠道', base_url: `http://127.0.0.1:${failPort}`, api_key: 'sk-bad', enabled: true, model: 'gpt-5.6-sol', wire_api: 'responses' },
      { id: 'kdead', name: '连不上', base_url: 'http://127.0.0.1:1', api_key: 'sk-dead', enabled: true, model: 'gpt-5.6-sol', wire_api: 'responses' },
    ],
  };
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, ...provs }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  _state.store = provs;
  _state.sessions.clear();
  _state.cooldowns = {};

  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

// ---------------------------------------------------------------- 纯函数:身份与翻译
test('Codex 会话身份:session-id 头 > prompt_cache_key > client_metadata > 内容指纹', () => {
  assert.strictEqual(codexHeaderSessionId({ headers: { 'session-id': 'u1' } }), 'u1');
  assert.strictEqual(codexHeaderSessionId({ headers: { 'thread-id': 't1' } }), 't1');
  assert.strictEqual(codexHeaderSessionId({ headers: { 'x-client-request-id': 'r1' } }), 'r1');
  assert.strictEqual(codexHeaderSessionId({ headers: { 'x-codex-turn-metadata': '{"session_id":"m1"}' } }), 'm1');
  assert.strictEqual(codexHeaderSessionId({ headers: {} }), '');
  assert.strictEqual(codexBodySessionId({ prompt_cache_key: 'p1' }), 'p1');
  assert.strictEqual(codexBodySessionId({ client_metadata: { session_id: 'c1' } }), 'c1');
  assert.strictEqual(codexBodySessionId({}), '');

  assert.deepStrictEqual(sessionIdentity({ headers: { 'session-id': 'u1' } }, {}, 'codex'), { key: 'cx:u1', kind: 'header' });
  assert.deepStrictEqual(sessionIdentity({ headers: {} }, { prompt_cache_key: 'p1' }, 'codex'), { key: 'cx:p1', kind: 'metadata' });
  const fp1 = sessionIdentity({ headers: {} }, CODEX_BODY(), 'codex');
  const fp2 = sessionIdentity({ headers: {} }, CODEX_BODY(), 'codex');
  const fp3 = sessionIdentity({ headers: {} }, { ...CODEX_BODY(), input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '另一个问题' }] }] }, 'codex');
  assert.strictEqual(fp1.kind, 'fingerprint');
  assert.strictEqual(fp1.key, fp2.key);
  assert.notStrictEqual(fp1.key, fp3.key);
  // 与 Claude 侧的键永不撞车
  assert.notStrictEqual(fp1.key, sessionIdentity({ headers: {} }, CODEX_BODY()).key);
  assert.deepStrictEqual(sessionIdentity({ headers: {} }, {}, 'codex'), { key: 'cx-anon', kind: 'anon' });
});

test('codexFirstUserText / sessionLabel(Codex):取 input 里首条人话', () => {
  const body = { instructions: 'sys', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '忽略我' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '  第一个   真问题 ' }] },
  ] };
  assert.strictEqual(codexFirstUserText(body), '  第一个   真问题 ');
  assert.strictEqual(sessionLabel(body, 'codex'), '第一个 真问题');
  assert.strictEqual(sessionLabel({ instructions: 'x', input: [] }, 'codex'), '');
});

test('responsesToChat:instructions→system、developer→system、工具调用/结果成对映射、reasoning 丢弃', () => {
  const cc = responsesToChat({
    model: 'glm-5.3-flash', instructions: '你是助手', stream: true, max_output_tokens: 4096, temperature: 0.3,
    tool_choice: 'auto', parallel_tool_calls: true,
    tools: [
      { type: 'function', name: 'exec_command', description: '跑命令', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'web_search' },
    ],
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '技能说明' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看看仓库' }] },
      { type: 'reasoning', summary: [] },
      { type: 'function_call', call_id: 'call_9', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_9', output: { content: [{ type: 'output_text', text: 'a.txt' }] } },
      { type: 'local_shell_call', action: {} },
    ],
  }, {});
  assert.strictEqual(cc.model, 'glm-5.3-flash');
  assert.strictEqual(cc.max_tokens, 4096);
  assert.strictEqual(cc.temperature, 0.3);
  assert.deepStrictEqual(cc.stream_options, { include_usage: true }, '翻译后必须主动要 usage');
  assert.deepStrictEqual(cc.messages.map(m => m.role), ['system', 'system', 'user', 'assistant', 'tool']);
  assert.strictEqual(cc.messages[3].tool_calls[0].function.name, 'exec_command');
  assert.strictEqual(cc.messages[3].tool_calls[0].id, 'call_9');
  assert.strictEqual(cc.messages[4].tool_call_id, 'call_9');
  assert.strictEqual(cc.messages[4].content, 'a.txt');
  assert.strictEqual(cc.tools.length, 1, '非 function 工具丢弃');
  assert.strictEqual(cc.tools[0].type, 'function');
  assert.strictEqual(cc.tools[0].function.parameters.properties.cmd.type, 'string');
  assert.strictEqual(cc.tool_choice, 'auto');
});

test('responsesToChat:图片默认转 image_url,渠道标记纯文本时换成说明文字', () => {
  const body = { model: 'm', input: [{ type: 'message', role: 'user', content: [
    { type: 'input_text', text: '这张图' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ] }] };
  const cc = responsesToChat(body, {});
  const parts = cc.messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.strictEqual(parts[0].type, 'text');
  assert.strictEqual(parts[1].type, 'image_url');
  assert.strictEqual(parts[1].image_url.url, 'data:image/png;base64,AAAA');

  const dropped = responsesToChat(body, { drop_images: true });
  assert.strictEqual(typeof dropped.messages[0].content, 'string');
  assert.ok(dropped.messages[0].content.includes('丢弃图片'), '要留一句说明而不是静默丢');
});

test('chatToolChoice 与 chatJsonToResponses', () => {
  assert.strictEqual(chatToolChoice('auto'), 'auto');
  assert.deepStrictEqual(chatToolChoice({ type: 'function', name: 'f' }), { type: 'function', function: { name: 'f' } });
  assert.strictEqual(chatToolChoice({ type: 'web_search' }), 'auto');
  const resp = chatJsonToResponses({ id: 'c1', choices: [{ message: { content: '好的', tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }, 'glm-5.3-flash');
  assert.strictEqual(resp.object, 'response');
  assert.strictEqual(resp.model, 'glm-5.3-flash');
  assert.strictEqual(resp.output.length, 2);
  assert.strictEqual(resp.output[0].content[0].text, '好的');
  assert.strictEqual(resp.output[1].type, 'function_call');
  assert.strictEqual(resp.output[1].call_id, 'call_1');
  assert.deepStrictEqual(resp.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
});

test('extractUsageOpenAI:两种协议、末尾取值、缓存读', () => {
  const r = extractUsageOpenAI('responses', 'data: {"type":"response.completed","response":{"usage":{"input_tokens":21,"input_tokens_details":{"cached_tokens":4},"output_tokens":13}}}');
  assert.deepStrictEqual(r, { in: 21, out: 13, cache_read: 4 });
  const c = extractUsageOpenAI('chat', 'data: {"usage":{"prompt_tokens":7,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}');
  assert.deepStrictEqual(c, { in: 7, out: 5, cache_read: 2 });
  assert.deepStrictEqual(extractUsageFor('chat', 'nothing'), { in: 0, out: 0, cache_read: 0 });
  // Claude 侧仍走老逻辑
  assert.deepStrictEqual(extractUsageFor('anthropic', '{"input_tokens":5,"output_tokens":6}'), { in: 5, out: 6, cache_read: 0 });
});

test('classifyProxyRequest / wireOf:端点与协议归属', () => {
  assert.deepStrictEqual(classifyProxyRequest({ url: '/v1/responses' }).app, 'codex');
  assert.deepStrictEqual(classifyProxyRequest({ url: '/v1/chat/completions' }).app, 'codex');
  assert.deepStrictEqual(classifyProxyRequest({ url: '/v1/messages?x=1' }).app, 'claude');
  assert.strictEqual(classifyProxyRequest({ url: '/v1/embeddings' }), null);
  assert.strictEqual(wireOf({ wire_api: 'chat' }, 'codex'), 'chat');
  assert.strictEqual(wireOf({}, 'codex'), 'responses');
  assert.strictEqual(wireOf({ wire_api: 'chat' }, 'claude'), 'chat');
  assert.strictEqual(wireOf({ wire_api: 'responses' }, 'claude'), 'responses');
  assert.strictEqual(wireOf({ wire_api: 'bogus' }, 'claude'), 'anthropic'); // 未知值按默认直连
});

test('buildOpenAiHeaders:带 Bearer 与客户端 UA,不撒 Anthropic 头,透传会话 id', () => {
  const h = buildOpenAiHeaders({ api_key: 'sk-1' }, { headers: { 'user-agent': 'codex_exec/0.154.0', 'session-id': 'u-9', 'anthropic-version': '2023-06-01' } }, true);
  assert.strictEqual(h.Authorization, 'Bearer sk-1');
  assert.strictEqual(h['User-Agent'], 'codex_exec/0.154.0');
  assert.strictEqual(h['session-id'], 'u-9');
  assert.strictEqual(h.Accept, 'text/event-stream');
  assert.strictEqual(h['x-api-key'], undefined);
  assert.strictEqual(h['anthropic-version'], undefined);
  assert.ok(buildOpenAiHeaders({ api_key: 'k' }, { headers: {} }, false)['User-Agent'].startsWith('codex_cli_rs/'));
});

// ---------------------------------------------------------------- 集成:responses 直通
test('responses 端点:落到 responses 协议渠道时原样转发,usage/模型/日志都对', async () => {
  setRoutes([{ id: 'rx', match: 'gpt', pool: ['k1'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  const r = await callCodex('resp-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.hit.url, '/v1/responses');
  assert.strictEqual(r.hit.headers.authorization, 'Bearer sk-k1');
  assert.strictEqual(r.hit.headers['x-api-key'], undefined, 'OpenAI 上游不该收到 Anthropic 鉴权头');
  assert.strictEqual(r.hit.headers['session-id'], 'resp-1', '会话 id 透传(上游侧缓存粘性用)');
  assert.strictEqual(r.hit.body.model, 'gpt-5.6-sol');
  assert.strictEqual(r.hit.body.instructions, 'You are a coding agent.');
  assert.strictEqual(r.hit.body.store, false, 'responses 协议原样透传,不做字段删改');
  assert.ok(r.text.includes('mock-echo:gpt-5.6-sol'));
  assert.strictEqual(r.headers['x-mixrouter-app'], 'codex');
  // 响应头只允许 latin-1,中文渠道名会被消洗成 ASCII 前缀(既有行为,这里钉住)
  assert.strictEqual(r.headers['x-mixrouter-provider'], 'codex');
  const log = await lastLog();
  assert.strictEqual(log.app, 'codex');
  assert.strictEqual(log.kind, 'responses');
  assert.strictEqual(log.wire, 'responses');
  assert.strictEqual(log.in, 21);
  assert.strictEqual(log.out, 13);
  assert.strictEqual(log.cache_read, 4);
});

test('responses 端点:非流式请求也照样工作', async () => {
  setRoutes([{ id: 'rn', match: 'gpt', pool: ['k2'], enabled: true }]);
  _state.sessions.clear();
  const r = await callCodex('resp-nostream', { body: { stream: false } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.hit.body.stream, false);
  assert.ok(r.text.includes('"object":"response"'));
  assert.strictEqual((await lastLog()).in, 21);
});

// ---------------------------------------------------------------- 集成:responses → chat 翻译
test('responses → chat 上游:请求被翻译成 chat,响应被翻译回 responses SSE', async () => {
  setRoutes([{ id: 'rc', match: 'glm', pool: ['k3'], enabled: true }]);
  _state.sessions.clear();
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/responses', {
    headers: { 'Content-Type': 'application/json', 'session-id': 'tr-1' },
    body: { ...CODEX_BODY('glm-5.3-flash'), instructions: '你是编码助手', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }] },
  });
  assert.strictEqual(r.status, 200);
  const hit = mock.requests.at(-1);
  assert.strictEqual(mock.requests.length, before + 1);
  assert.strictEqual(hit.url, '/v1/chat/completions', 'chat 协议渠道要打 chat 端点');
  assert.strictEqual(hit.body.model, 'glm-5.3-flash');
  assert.strictEqual(hit.body.messages[0].role, 'system');
  assert.strictEqual(hit.body.messages[0].content, '你是编码助手', 'instructions → system');
  assert.strictEqual(hit.body.messages[1].content, '帮我看看这个仓库');
  assert.strictEqual(hit.body.tools[0].function.name, 'exec_command');
  assert.deepStrictEqual(hit.body.stream_options, { include_usage: true });
  assert.strictEqual(hit.body.prompt_cache_key, undefined, 'chat 协议不认的字段要丢掉');
  assert.strictEqual(hit.body.instructions, undefined);

  // 响应:codex 能看的 responses SSE 事件序列
  assert.ok(r.text.includes('"type":"response.created"'));
  assert.ok(r.text.includes('"type":"response.output_item.added"'));
  assert.ok(r.text.includes('"type":"response.output_text.delta"'));
  assert.ok(r.text.includes('mock-echo:glm-5.3-flash'));
  assert.ok(r.text.includes('"type":"response.completed"'));
  const order = [r.text.indexOf('response.output_item.added'), r.text.indexOf('response.output_text.delta')];
  assert.ok(order[0] < order[1], '首个 delta 前必须先发 output_item.added(否则 codex 报错)');
  const log = await lastLog();
  assert.strictEqual(log.wire, 'chat');
  assert.strictEqual(log.app, 'codex');
  assert.strictEqual(log.in, 21, 'usage 要穿过翻译层记进日志');
  assert.strictEqual(log.out, 13);
  assert.strictEqual(log.cache_read, 4);
});

test('responses → chat 上游:上游吐工具调用时翻译出 function_call item', async () => {
  setRoutes([{ id: 'rt', match: 'gpt-5.6-sol', pool: ['ktool'], enabled: true }]);
  _state.sessions.clear();
  const r = await rawRequest(proxyPort, 'POST', '/v1/responses', {
    headers: { 'Content-Type': 'application/json', 'session-id': 'tr-tool' },
    body: CODEX_BODY('gpt-5.6-sol'),
  });
  assert.ok(r.text.includes('"type":"function_call"'));
  assert.ok(r.text.includes('"name":"exec_command"'));
  assert.ok(r.text.includes('{\\"cmd\\":\\"ls\\"}'), 'arguments 分片要拼回完整 JSON');
  assert.ok(r.text.includes('先跑一下命令'));
  assert.ok(r.text.includes('"type":"response.completed"'));
});

test('responses → chat 上游:上游无视 stream 整包回 JSON 时,代理自己摊成 responses SSE', async () => {
  setRoutes([{ id: 'rj', match: 'json-only', pool: [{ provider: 'k3', model: 'json-only-1' }], enabled: true }]);
  _state.sessions.clear();
  const r = await rawRequest(proxyPort, 'POST', '/v1/responses', {
    headers: { 'Content-Type': 'application/json', 'session-id': 'tr-json' },
    body: CODEX_BODY('json-only-1'),
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'), '客户端要流就给流');
  assert.ok(r.text.includes('"type":"response.output_item.added"'));
  assert.ok(r.text.includes('mock-echo:json-only-1'));
  assert.ok(r.text.includes('"type":"response.completed"'));
  assert.strictEqual((await lastLog()).out, 13, 'usage 仍要从整包 JSON 里抠出来');
});

// ---------------------------------------------------------------- 集成:chat 端点
test('chat/completions 端点:chat 协议渠道直通', async () => {
  setRoutes([{ id: 'rcc', match: 'glm', pool: ['k3'], enabled: true }]);
  _state.sessions.clear();
  const r = await rawRequest(proxyPort, 'POST', '/v1/chat/completions', {
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(mock.requests.at(-1).url, '/v1/chat/completions');
  assert.strictEqual(mock.requests.at(-1).body.messages[0].content, 'hi', 'chat 请求原样转发,不做翻译');
  assert.ok(r.text.includes('mock-echo:glm-5.3-flash'));
  assert.ok(r.text.includes('[DONE]'));
  assert.strictEqual((await lastLog()).kind, 'chat/completions');
});

test('chat/completions 端点:目标只会说 responses 时明确报错(不静默降级)', async () => {
  setRoutes([{ id: 'rmm', match: 'gpt', pool: ['k1'], enabled: true }]);
  _state.sessions.clear();
  const r = await rawRequest(proxyPort, 'POST', '/v1/chat/completions', {
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'gpt-5.6-sol', stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 400);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.error.code, 'wire_api_mismatch_error');
  assert.ok(j.error.message.includes('/v1/responses'));
});

// ---------------------------------------------------------------- 集成:路由与策略
test('Codex 池按会话粘性分流:三个对话落到不同渠道,对话内不换', async () => {
  setRoutes([{ id: 'rp', match: 'gpt', pool: ['k1', 'k2', 'kdead'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = {};
  const a = await callCodex('cx-a');
  const b = await callCodex('cx-b');
  assert.notStrictEqual(a.hit.headers.authorization, b.hit.headers.authorization, '两个对话应分到不同渠道');
  assert.strictEqual((await callCodex('cx-a')).hit.headers.authorization, a.hit.headers.authorization, '同一对话必须粘住');
  const log = await lastLog();
  assert.strictEqual(log.sticky, true);
  assert.strictEqual(log.pool, 3);
});

test('Codex 通路的失败转移:首选 5xx / 连不上都自动换下一个', async () => {
  setRoutes([{ id: 'rf', match: 'gpt', pool: ['kbad', 'k1'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = {};
  const r = await callCodex('cx-fail');
  assert.strictEqual(r.status, 200, '上游 5xx 不该把错误甩给 codex');
  assert.strictEqual(r.hit.headers.authorization, 'Bearer sk-k1');
  assert.strictEqual((await lastLog()).failover, true);
});

test('Codex 通路的错误体是 OpenAI 形状,且提示指向 Codex 组', async () => {
  setRoutes([{ id: 'rg', match: 'nowhere-model', pool: ['k1'], enabled: true }]);
  _state.sessions.clear();
  const r = await callCodex('cx-noroute', { model: 'gpt-unknown' });
  assert.strictEqual(r.status, 503);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.error.code, 'no_route_error');
  assert.ok(j.error.message.includes('Codex'));
  assert.strictEqual(j.type, undefined, '不该是 Anthropic 形状');
});

test('只绑 Claude 渠道的规则不会挡住 Codex 请求(继续往下匹配)', async () => {
  setRoutes([
    { id: 'claude-only', match: 'gpt', provider: 'p1', priority: 10, enabled: true },
    { id: 'codex-rule', match: 'gpt', pool: ['k2'], priority: 0, enabled: true },
  ]);
  _state.sessions.clear();
  const r = await callCodex('cx-skip');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.hit.headers.authorization, 'Bearer sk-k2');
  assert.strictEqual((await lastLog()).rule, 'codex-rule');
});

test('规则可显式声明适用分组(app),混组时互不干扰', async () => {
  setRoutes([
    { id: 'cx-only', match: 'sonnet', app: 'codex', pool: ['k1'], enabled: true },
    { id: 'cc-only', match: 'sonnet', app: 'claude', provider: 'p1', enabled: true },
  ]);
  _state.sessions.clear();
  // Codex 端点:cx-only 命中(虽然模型名一样)
  const cx = await callCodex('cx-app', { model: 'sonnet-x' });
  assert.strictEqual(cx.hit.headers.authorization, 'Bearer sk-k1');
  // Claude 端点:cc-only 命中
  const cc = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cc-app' },
    body: { model: 'sonnet-x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(cc.status, 200);
  assert.strictEqual(mock.requests.at(-1).url, '/v1/messages');
  assert.strictEqual(mock.requests.at(-1).headers['x-api-key'], 'sk-claude');
});

test('Codex 池支持成员级模型覆盖(codex 渠道自带模型名)', async () => {
  setRoutes([{ id: 'rov', match: 'gpt', pool: [{ provider: 'k2', model: 'gpt-5.6-sol-override' }], enabled: true }]);
  _state.sessions.clear();
  const r = await callCodex('cx-ov');
  assert.strictEqual(r.hit.body.model, 'gpt-5.6-sol-override');
  assert.strictEqual(r.headers['x-mixrouter-model'], 'gpt-5.6-sol-override');
});

test('Claude 通路不受影响:规则仍只认 Claude 组,模型改写真常', async () => {
  setRoutes([{ id: 'rcl', match: 'opus', provider: 'p1', model: 'claude-opus-5[1M]', enabled: true }]);
  _state.sessions.clear();
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cc-1' },
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(mock.requests.at(-1).body.model, 'claude-opus-5');
  assert.ok(mock.requests.at(-1).headers['anthropic-beta'].includes('context-1m'));
  assert.strictEqual(r.headers['x-mixrouter-app'], 'claude');
});

// ---------------------------------------------------------------- 会话 API / 日志 / 状态
test('会话 API:Codex 对话只能绑 Codex 组渠道', async () => {
  setRoutes([{ id: 'rs', match: 'gpt', pool: ['k1', 'k2'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  await callCodex('cx-api');
  const list = JSON.parse((await rawRequest(uiPort, 'GET', '/api/sessions')).text).sessions;
  const mine = list.find(s => s.key === 'cx:cx-api');
  assert.ok(mine, 'Codex 会话要出现在会话列表里');
  assert.strictEqual(mine.app, 'codex');
  assert.strictEqual(mine.pinned, false);
  assert.ok(!JSON.stringify(list).includes('sk-k1'), '会话数据不能带出密钥');

  const ok = await rawRequest(uiPort, 'POST', '/api/sessions/cx%3Acx-api/pin', { body: { provider: 'k2' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.text).session.provider_name, 'codex二');
  assert.strictEqual((await callCodex('cx-api')).hit.headers.authorization, 'Bearer sk-k2', '改绑后走新渠道');

  const cross = await rawRequest(uiPort, 'POST', '/api/sessions/cx%3Acx-api/pin', { body: { provider: 'p1' } });
  assert.strictEqual(cross.status, 404, '不能把 Codex 对话绑到 Claude 组渠道');
});

test('日志按 app 过滤:Codex 与 Claude 的请求分得开', async () => {
  setRoutes([{ id: 'rl', match: 'gpt', pool: ['k1'], enabled: true }]);
  _state.sessions.clear();
  await callCodex('cx-log');
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?app=codex&limit=50')).text).logs;
  assert.ok(logs.length >= 1);
  assert.ok(logs.every(l => l.app === 'codex'));
  const stats = JSON.parse((await rawRequest(uiPort, 'GET', '/api/stats')).text);
  assert.ok(stats.by_app.codex >= 1);
});

test('/api/state 暴露路由模式信息;HEAD 探活与 GET /v1/models 可用', async () => {
  const s = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.strictEqual(s.router.url, ROUTER_URL);
  assert.strictEqual(s.router.codex_base, ROUTER_URL + '/v1');
  assert.ok(s.router.endpoints.some(x => x.includes('/v1/responses')));

  const head = await rawRequest(proxyPort, 'HEAD', '/v1/responses');
  assert.strictEqual(head.status, 200);
  const models = JSON.parse((await rawRequest(proxyPort, 'GET', '/v1/models')).text);
  assert.strictEqual(models.object, 'list');
  assert.ok(models.data.some(m => m.id === 'glm-5.3-flash' && m.owned_by === 'chat系'));
});

// ---------------------------------------------------------------- 路由模式切换
test('路由模式(Codex):顶层 model_provider 换 mixr-router、model 与用户 section 不动', () => {
  const cfgFile = process.env.MIXR_CODEX_CONFIG;
  fs.writeFileSync(cfgFile, [
    'model_provider = "custom"', 'model = "gpt-6-astra"', 'approval_policy = "never"', '',
    '[model_providers.custom]', 'name = "custom"', 'base_url = "https://anyrouter.top/v1"', 'wire_api = "responses"', '',
    '[features]', 'goals = true', '',
  ].join('\n'));
  _state.current.codex = ROUTER_ID;
  switchCodexRouter();
  const text = fs.readFileSync(cfgFile, 'utf8');
  assert.ok(text.includes('model_provider = "mixr-router"'));
  assert.ok(text.includes('model = "gpt-6-astra"'), '路由模式不改模型名——路由规则就按它匹配');
  assert.ok(text.includes('[model_providers.custom]'), '用户自己的 section 一字不动');
  assert.ok(text.includes('base_url = "http://127.0.0.1:8787/v1"'));
  assert.ok(text.includes(`experimental_bearer_token = "${ROUTER_TOKEN}"`));
  assert.ok(text.includes('requires_openai_auth = false'));
  // 二次切换不产生重复 section
  switchCodexRouter();
  const again = fs.readFileSync(cfgFile, 'utf8');
  assert.strictEqual(again.split('[model_providers.mixr-router]').length, 2);
  assert.strictEqual(again.split('base_url = "https://anyrouter.top/v1"').length, 2, '用户 section 不该被复制');

  // liveState 认得出处在路由模式
  const live = liveState();
  assert.strictEqual(live.codex.provider, ROUTER_SECTION);
  assert.strictEqual(live.codex.router, true);
  assert.strictEqual(live.codex.match, true);
  assert.strictEqual(live.codex.model, 'gpt-6-astra');
});

test('路由模式(Claude):把 ANTHROPIC_BASE_URL 指向代理,模型与其余键保持', () => {
  const f = process.env.MIXR_CLAUDE_SETTINGS;
  fs.writeFileSync(f, JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-opus-5', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OTHER: 1 }, permissions: { allow: ['x'] } }, null, 2));
  _state.current.claude = ROUTER_ID;
  switchClaudeRouter();
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(cfg.env.ANTHROPIC_BASE_URL, ROUTER_URL);
  assert.strictEqual(cfg.env.ANTHROPIC_MODEL, 'claude-opus-5');
  assert.strictEqual(cfg.env.OTHER, 1);
  assert.deepStrictEqual(cfg.permissions, { allow: ['x'] }, '其余键原样保留');
  const live = liveState();
  assert.strictEqual(live.claude.router, true);
  assert.strictEqual(live.claude.match, true);
});

test('路由模式 API:库里没有该组渠道时拒绝切换', async () => {
  const saved = _state.store;
  _state.store = { claude: saved.claude, codex: [] };
  const r = await rawRequest(uiPort, 'POST', '/api/router/codex');
  assert.strictEqual(r.status, 400);
  assert.ok(JSON.parse(r.text).error.includes('Codex'));
  _state.store = saved;
  const ok = await rawRequest(uiPort, 'POST', '/api/router/claude');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.text).app, 'claude');
});

test('writeCodexConfig 全新文件:补顶层键并写 section(不再依赖旧函数)', () => {
  const f = process.env.MIXR_CODEX_CONFIG;
  fs.unlinkSync(f);
  writeCodexConfig({ section: 'mixr-t1', name: '测试', base_url: 'https://x.example.com/v1', api_key: 'sk-x', wire_api: 'responses', model: 'm1' });
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.startsWith('model = "m1"'));
  assert.ok(text.includes('model_provider = "mixr-t1"'));
  assert.ok(text.includes('[model_providers.mixr-t1]'));
  assert.strictEqual((fs.statSync(f).mode & 0o777), 0o600);
});
