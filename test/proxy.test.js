'use strict';
// 代理与控制台 API 集成测试:mock 上游 + proxyHandler/apiHandler 挂在临时端口,
// 运行时数据全部指向临时目录,不触碰真实配置
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');
const mock = createMockUpstream();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-proxy-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_BODY_LIMIT_MB = '1'; // 便于测 413(默认 64MB,不必真发大包)

const P1 = {
  id: 'p1', name: '测试渠道一', base_url: '', api_key: 'sk-test-p1', enabled: true,
  models: ['claude-opus-5'],
};
const BETA = 'context-1m-2025-08-07';

let mod, proxySrv, uiSrv, mockPort, proxyPort, uiPort;
const routesBackup = [];

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

test('setup:起 mock 上游与两个服务', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port;
  mock.server.unref();
  P1.base_url = `http://127.0.0.1:${mockPort}`;
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'p1', codex: null }, claude: [P1], codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [
      { id: 'r1', match: 'opus', provider: 'p1', model: 'routed-opus', enabled: true },
      { id: 'r2', match: 'sonnet', provider: 'p1', model: 'beta-target[1M]', enabled: true },
      { id: 'r3', match: 'dead', provider: 'p1', model: '', enabled: false },
    ],
    default: { provider: 'p1', model: '' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('GET /healthz 返回服务信息', async () => {
  const r = await rawRequest(proxyPort, 'GET', '/healthz');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.service, 'mixrouter');
});

test('非 messages 路径返回 404 Anthropic 错误结构', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/other', { body: '{}' });
  assert.strictEqual(r.status, 404);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.type, 'error');
  assert.strictEqual(j.error.type, 'not_found_error');
});

test('请求体非 JSON 返回 400', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', { body: 'not-json' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.text).error.type, 'invalid_request_error');
});

test('命中 opus 规则:转发改写后的模型,带鉴权头,响应附渠道标头', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-cli/9.9 (test)' },
  });
  assert.strictEqual(r.status, 200);
  const seen = mock.requests.at(-1);
  assert.strictEqual(seen.url, '/v1/messages');
  assert.strictEqual(seen.body.model, 'routed-opus');                       // 规则改写
  assert.strictEqual(seen.headers['x-api-key'], 'sk-test-p1');
  assert.strictEqual(seen.headers['authorization'], 'Bearer sk-test-p1');
  assert.strictEqual(seen.headers['user-agent'], 'claude-cli/9.9 (test)');  // 客户端 UA 透传
  // 响应标头经 safeHeader 消洗:纯中文渠道名 → 空串(不崩进程即目的)
  assert.strictEqual(r.headers['x-mixrouter-provider'], '');
  assert.ok(r.text.includes('mock-echo:routed-opus'));
});

test('sonnet 规则目标带 [1M]:剥离后缀,合并 beta 头', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-sonnet-5', max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-beta': 'feature-x' },
  });
  assert.strictEqual(r.status, 200);
  const seen = mock.requests.at(-1);
  assert.strictEqual(seen.body.model, 'beta-target');
  assert.ok(seen.headers['anthropic-beta'].includes('feature-x'));
  assert.ok(seen.headers['anthropic-beta'].includes(BETA));
});

test('客户端无 UA 时兜底 claude-cli UA', async () => {
  await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'user-agent': '' },
  });
  assert.strictEqual(mock.requests.at(-1).headers['user-agent'], 'claude-cli/2.1.219 (external, cli)');
  // 非 ASCII UA 在 http 客户端就发不出来(ERR_INVALID_CHAR);服务端消洗行为由 helpers 单测的 safeHeader 覆盖
});

test('流式请求:SSE 原样透传,usage 入日志', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/event-stream'));
  assert.ok(r.text.includes('event: message_start'));
  assert.ok(r.text.includes('mock-echo:routed-opus'));
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  const entry = logs.logs[0];
  assert.strictEqual(entry.stream, true);
  assert.strictEqual(entry.in, 17);
  assert.strictEqual(entry.out, 9);
  assert.strictEqual(entry.cache_read, 5);
  assert.strictEqual(entry.status, 200);
});

test('count_tokens:转发到上游专用路径,usage 数值类型正确', async () => {
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages/count_tokens', {
    body: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(mock.requests.at(-1).url.includes('/v1/messages/count_tokens'));
  assert.strictEqual(JSON.parse(r.text).input_tokens, 42);
  const logs = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs')).text);
  assert.strictEqual(logs.logs[0].kind, 'count_tokens');
  assert.strictEqual(logs.logs[0].in, 42); // 必须是 number 而非字符串
  assert.strictEqual(typeof logs.logs[0].in, 'number');
});

test('无命中且 default 无渠道时返回 503 + no_route_error', async () => {
  routesBackup.push(mod._state.routes);
  mod._state.routes = { rules: [{ id: 'rx', match: 'opus', provider: 'ghost', model: '', enabled: true }],
    default: { provider: '', model: '' } };
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.text).error.type, 'no_route_error');
  mod._state.routes = routesBackup.pop();
});

test('渠道停用时返回 503 + provider_disabled_error', async () => {
  mod._state.store.claude[0].enabled = false; // store 里的对象经 JSON 往返,须就地改
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  mod._state.store.claude[0].enabled = true;
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.text).error.type, 'provider_disabled_error');
  assert.ok(JSON.parse(r.text).error.message.includes('已停用'));
});

test('请求体超过上限返回 413 而非静默断连', async () => {
  // MIXR_BODY_LIMIT_MB=1,发 1.5MB 体
  const big = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'x'.repeat(1.5 * 1024 * 1024) }] });
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', { body: big });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(JSON.parse(r.text).error.type, 'invalid_request_error');
});

test('base_url 非法时保存被拒(POST 与 PUT 都拦)', async () => {
  const bad = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '坏渠道', base_url: 'not-a-url', api_key: '' },
  });
  assert.strictEqual(bad.status, 400);
  assert.ok(JSON.parse(bad.text).error.includes('base_url'));
  const badScheme = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '坏协议', base_url: 'ftp://x.example.com', api_key: '' },
  });
  assert.strictEqual(badScheme.status, 400);
  // PUT 同样拦截:先建合法渠道,再改坏
  const ok = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'claude', name: '好渠道', base_url: 'https://api.example.com', api_key: '' },
  });
  const id = JSON.parse(ok.text).id;
  const badPut = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { base_url: 'javascript:alert(1)' } });
  assert.strictEqual(badPut.status, 400);
  await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
});

test('上游拒绝连接时返回 502', async () => {
  mod._state.store.claude.push({ id: 'pdown', name: '死渠道', base_url: 'http://127.0.0.1:1', api_key: 'sk-x', enabled: true });
  routesBackup.push(mod._state.routes);
  mod._state.routes = { rules: [{ id: 'rd', match: 'downmodel', provider: 'pdown', model: '', enabled: true }],
    default: { provider: '', model: '' } };
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'downmodel-1', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  mod._state.routes = routesBackup.pop();
  mod._state.store.claude = mod._state.store.claude.filter(p => p.id !== 'pdown');
  assert.strictEqual(r.status, 502);
  assert.strictEqual(JSON.parse(r.text).error.type, 'api_error');
});

test('控制台 API:渠道 CRUD 全流程,key 不出网', async () => {
  // 创建 codex 渠道
  const created = await rawRequest(uiPort, 'POST', '/api/providers', {
    body: { app: 'codex', name: 'CRUD 渠道', base_url: 'https://api.example.com/', api_key: 'sk-crud-1234567890abcdef', model: 'gpt-5' },
  });
  assert.strictEqual(JSON.parse(created.text).ok, true);
  const id = JSON.parse(created.text).id;
  // state 里 key 必须是掩码,不能出现明文
  const state = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  const found = [...state.providers.claude, ...state.providers.codex].find(p => p.id === id);
  assert.ok(found);
  assert.strictEqual(found.api_key, undefined);
  assert.ok(found.key_masked.includes('…'));
  // 更新
  const upd = await rawRequest(uiPort, 'PUT', `/api/providers/${id}`, { body: { name: 'CRUD 渠道改' } });
  assert.strictEqual(JSON.parse(upd.text).ok, true);
  // 删除
  const del = await rawRequest(uiPort, 'DELETE', `/api/providers/${id}`);
  assert.strictEqual(JSON.parse(del.text).ok, true);
  const after = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.ok(![...after.providers.claude, ...after.providers.codex].some(p => p.id === id));
});

test('控制台 API:PUT /api/routes 持久化并生效', async () => {
  const fileRoutes = JSON.parse(fs.readFileSync(path.join(TMP, 'routes.json'), 'utf8')); // require 时装载的原始路由
  const put = await rawRequest(uiPort, 'PUT', '/api/routes', {
    body: { rules: [{ id: 'n1', match: 'tiny', provider: 'p1', model: 'tiny-target', enabled: true }], default: { provider: 'p1', model: '' } },
  });
  assert.strictEqual(JSON.parse(put.text).ok, true);
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    body: { model: 'a-tiny-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(mock.requests.at(-1).body.model, 'tiny-target');
  // 还原为文件初始路由,保证测试幂等
  const restore = await rawRequest(uiPort, 'PUT', '/api/routes', { body: fileRoutes });
  assert.strictEqual(JSON.parse(restore.text).ok, true);
});
