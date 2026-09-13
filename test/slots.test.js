'use strict';
// 子代理槽位:别名解析 / 槽位 CRUD / 客户端 env 同步 / 代理转发落点 / 错误分型。
// 所有客户端配置、数据与上游流量均与真实文件和网络隔离。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-slots-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex', 'config.toml');
const mod = require('../mixrouter');
let ui, proxy, upstream, base;
const hits = [];

function request(url, method = 'POST', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: JSON.parse(text || '{}'), headers: res.headers }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const uiPort = () => ui.address().port;
const proxyPort = () => proxy.address().port;
const api = (route, body, method = 'POST') => request(`http://127.0.0.1:${uiPort()}${route}`, method, body);
const claudeSettings = () => JSON.parse(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'));

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      hits.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 2 } }));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(process.env.MIXR_CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: { ANTHROPIC_MODEL: 'keep-me-real' } }));
  mod._state.store = {
    claude: [
      { id: 'pa', name: '大渠道', base_url: base, api_key: 'key-a', models: ['glm-5.3', 'deepseek-v4-flash'], enabled: true },
      { id: 'pb', name: '停用渠道', base_url: base, api_key: 'key-b', models: ['m-off'], enabled: false },
    ],
    codex: [
      { id: 'ca', name: 'CodexA', base_url: base + '/v1', api_key: 'key-c', model: 'gpt-6', wire_api: 'responses', enabled: true },
    ],
  };
  mod._state.slotMap = { claude: {}, codex: {} };
  mod._state.current = { claude: null, codex: null, zcode: null };
});

test('槽位 CRUD:校验、部分更新、null 删除、落盘 slots.json', async () => {
  let r = await api('/api/slots', { claude: { foo: { provider: 'pa' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /Claude 槽位只能是/);
  r = await api('/api/slots', { codex: { Bad_Name: { provider: 'ca' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /小写字母/);
  r = await api('/api/slots', { claude: { haiku: { provider: 'nope' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /渠道不存在/);
  r = await api('/api/slots', { codex: { worker: { provider: 'pa' } } }, 'PUT');
  assert.equal(r.status, 400); assert.match(r.data.error, /渠道不存在/);

  r = await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' } }, codex: { worker: { provider: 'ca' } } }, 'PUT');
  assert.equal(r.status, 200);
  const haiku = r.data.slots.claude.find(s => s.name === 'haiku');
  assert.equal(haiku.alias, 'mixr-haiku');
  assert.equal(haiku.provider_name, '大渠道');
  assert.equal(haiku.model, 'deepseek-v4-flash');
  const worker = r.data.slots.codex.find(s => s.name === 'worker');
  assert.equal(worker.alias, 'mixr-worker');
  assert.equal(worker.model, 'gpt-6'); // Codex 槽落点 = 渠道自带模型
  assert.ok(fs.existsSync(path.join(TMP, 'slots.json')), 'slots.json 已落盘');

  // 部分更新:同组其它槽不受影响;null 删除
  await api('/api/slots', { claude: { opus: { provider: 'pa', model: 'glm-5.3' } } }, 'PUT');
  r = await api('/api/slots', null, 'GET');
  assert.equal(r.data.slots.claude.filter(s => s.provider).length, 2);
  r = await api('/api/slots', { claude: { opus: null } }, 'PUT');
  assert.equal(r.data.slots.claude.filter(s => s.provider).length, 1);
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'slots.json'), 'utf8'));
  assert.equal(st.version, 1);
  assert.ok(st.claude.haiku && !st.claude.opus);
});

test('别名解析:精确命中、优先于规则、未知别名落回普通路由', () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' } }, codex: {} };
  const r = mod.resolveRoute('mixr-haiku', {}, 'claude');
  assert.equal(r.slot, 'haiku');
  assert.equal(r.model, 'deepseek-v4-flash');
  assert.equal(r.rule.id, 'slot:claude/haiku');
  assert.equal(r.members.length, 1);
  // 子串不含:别名必须精确,槽位层不命中(resolveSlot 返回 null,由普通规则接手)
  assert.equal(mod.resolveSlot('claude', 'claude-mixr-haiku-x'), null);
  assert.equal(mod.resolveSlot('claude', 'mixr-haiku-x'), null);
  // 其它 app 的同名别名不串组(槽位层不命中;resolveRoute 层会按普通规则匹配,这符合预期)
  assert.equal(mod.resolveSlot('codex', 'mixr-haiku'), null);
  // 未配置的槽位别名 → 不命中槽位,落回规则/默认
  const miss = mod.resolveRoute('mixr-opus', {}, 'claude');
  assert.equal(miss.slot, undefined);
});

test('代理转发:haiku 槽别名按槽位落点送达上游', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' } }, codex: { worker: { provider: 'ca' } } };
  hits.length = 0;
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(hits[0].body.model, 'deepseek-v4-flash');
  assert.equal(r.headers['x-mixrouter-model'], 'deepseek-v4-flash');
  // Codex responses 端点走 worker 槽
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/responses`, 'POST', { model: 'mixr-worker', input: 'hi' });
  assert.equal(r.status, 200);
  assert.equal(hits[1].body.model, 'gpt-6');
  // /v1/models 列出 Codex 槽位别名
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/models`, 'GET');
  assert.ok(r.data.data.some(x => x.id === 'mixr-worker' && x.owned_by === 'slot:worker'));
});

test('内容分流:when.body 规则把压缩请求从槽位别名上分走,普通请求不受影响', async () => {
  mod._state.slotMap = { claude: { main: { provider: 'pa', model: 'gpt-6-astra' } }, codex: {} };
  mod._state.routes = { rules: [
    { id: 'rcompact', match: '', strategy: 'priority', when: { body: 'detailed summary of the conversation' }, enabled: true,
      pool: [{ provider: 'pa', model: 'gpt-5.6-sol' }] },
  ], default: { provider: '', model: '' } };
  hits.length = 0;
  // 普通请求:槽位别名照旧落到槽位落点
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(hits[0].body.model, 'gpt-6-astra');
  // 压缩请求(请求体带摘要提示词):绕过槽位别名走内容规则
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'Your task is to create a detailed summary of the conversation so far' }] });
  assert.equal(r.status, 200);
  assert.equal(hits[1].body.model, 'gpt-5.6-sol');
  assert.equal(r.headers['x-mixrouter-model'], 'gpt-5.6-sol');
});

test('槽位渠道停用/删除:provider_disabled_error 与 no_route_error 分型', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pb', model: 'm-off' } }, codex: {} };
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.type, 'provider_disabled_error');
  mod._state.slotMap = { claude: { haiku: { provider: 'gone', model: 'x' } }, codex: {} };
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.type, 'no_route_error');
  assert.match(r.data.error.message, /槽位/);
});

test('路由模式 + 槽位同步:写别名、清残留、不碰手设值、留备份', async () => {
  mod._state.slotMap = { claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' }, main: { provider: 'pa', model: 'glm-5.3' } }, codex: {} };
  let r = await api('/api/router/claude', { slots: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.filter(s => s.provider).length, 2);
  let env = claudeSettings().env;
  assert.equal(env.ANTHROPIC_BASE_URL, mod.ROUTER_URL);
  assert.equal(env.ANTHROPIC_MODEL, 'mixr-main');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'mixr-haiku');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  // 残留清理:曾写入过的别名槽位被移除后,再次应用应清掉;手设的真实模型名保留
  await api('/api/slots', { claude: { haiku: null, sonnet: { provider: 'pa', model: 'glm-5.3' } } }, 'PUT');
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: mod.ROUTER_URL, ANTHROPIC_AUTH_TOKEN: mod.ROUTER_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mixr-haiku', ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-own-model' } }));
  r = await api('/api/router/claude', { slots: true });
  assert.equal(r.status, 200);
  env = claudeSettings().env;
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, '残留别名已清');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'my-own-model', '手设值不动');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'mixr-sonnet');
  assert.ok(fs.readdirSync(path.dirname(process.env.MIXR_CLAUDE_SETTINGS)).some(f => f.includes('.bak-mixui-')), '自动备份');
  // liveState 反映槽位 env 现值
  const live = mod.liveState().claude;
  assert.equal(live.slots.main, 'mixr-main');
  assert.equal(live.slots.haiku, '');
  assert.equal(live.slots.opus, 'my-own-model');
});

test('槽位请求不受会话粘性劫持:同会话先后走不同槽,各自落点正确', async () => {
  mod._state.slotMap = {
    claude: { haiku: { provider: 'pa', model: 'deepseek-v4-flash' }, main: { provider: 'pb', model: 'm-off' } },
    codex: {},
  };
  // main 槽指向停用渠道会明确报错,不静默换渠道
  const headers = { 'x-claude-code-session-id': 'sess-slot-1' };
  let r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-main', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(r.status, 503);
  assert.equal(r.data.error.type, 'provider_disabled_error');
  // 同一会话的 haiku 槽照常按自己的落点走
  r = await request(`http://127.0.0.1:${proxyPort()}/v1/messages`, 'POST',
    { model: 'mixr-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(r.status, 200);
  assert.equal(hits[hits.length - 1].body.model, 'deepseek-v4-flash');
});

test('删除渠道自动摘除引用它的槽位', async () => {
  await api('/api/slots', { claude: { haiku: { provider: 'pa', model: 'glm-5.3' } }, codex: { worker: { provider: 'ca' } } }, 'PUT');
  const r = await api('/api/providers/pa', null, 'DELETE');
  assert.equal(r.status, 200);
  const slots = (await api('/api/slots', null, 'GET')).data.slots;
  assert.ok(!slots.claude.some(s => s.provider === 'pa'));
  assert.ok(slots.codex.some(s => s.provider === 'ca'), '只摘被删渠道的槽');
});

after(async () => {
  await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok))));
});
