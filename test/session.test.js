'use strict';
// v3 会话级渠道分发测试:身份识别 / 渠道池策略 / 会话粘性 / 失败转移 / 优先级 / when 条件 / 会话 API
// mock 上游 + 临时数据目录,不触碰真实配置与真实上游
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockUpstream } = require('./mock-upstream.js');
const mock = createMockUpstream();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-session-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '3';

const mod = require('../mixrouter.js');
const {
  sessionIdentity, sessionLabel, parseSessionId, matchWhen, normalizeRule,
  strategyOf, buildUpstreamHeaders, clientToken, applyLabel, _state,
} = mod;

// 用来模拟"上游 5xx"的假上游
function createFailingUpstream(status) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const cs = [];
    req.on('data', c => cs.push(c));
    req.on('end', () => {
      seen.push(req.url);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }));
    });
  });
  return { server, seen };
}

const DEAD = { id: 'pdead', name: 'dead', base_url: 'http://127.0.0.1:1', api_key: 'sk-dead', enabled: true, models: [] };

let proxySrv, uiSrv, proxyPort, uiPort, mockPort, failSrv, failPort;

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

// 发一个带会话身份的代理请求,返回本次用掉的 x-api-key(即落到哪个渠道)
// sessionId 传"裸"会话 id(就是 Claude Code 会带上来的那个);内部键是 'cc:' + id
const keyOf = id => 'cc:' + id;
const shortOf = id => id.slice(0, 8);
async function callWithSession(sessionId, { model = 'claude-opus-5', headers = {}, body = {} } = {}) {
  const before = mock.requests.length;
  const r = await rawRequest(proxyPort, 'POST', '/v1/messages', {
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': sessionId, ...headers },
    body: { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...body },
  });
  const used = mock.requests.length > before ? mock.requests.at(-1).headers['x-api-key'] : null;
  return { status: r.status, key: used, provider: r.headers['x-mixrouter-provider'], text: r.text };
}
const lastLog = async () => JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text).logs[0];

function setRoutes(rules, def = { provider: '', model: '' }) {
  _state.routes = { rules: rules.map(normalizeRule), default: normalizeRule(def) };
  _state.resetPools();
}

test('setup:mock 上游 + 代理/控制台', async () => {
  await new Promise(ok => mock.server.listen(0, '127.0.0.1', ok));
  mockPort = mock.server.address().port;
  mock.server.unref();
  const fail = createFailingUpstream(500);
  await new Promise(ok => fail.server.listen(0, '127.0.0.1', ok));
  failSrv = fail.server; failPort = fail.server.address().port;
  failSrv.unref();

  const base = `http://127.0.0.1:${mockPort}`;
  const provs = [
    { id: 'pa', name: 'provA', base_url: base, api_key: 'sk-a', enabled: true, models: ['claude-opus-5'], slots: {} },
    { id: 'pb', name: 'provB', base_url: base, api_key: 'sk-b', enabled: true, models: ['claude-opus-5'], slots: {} },
    { id: 'pc', name: 'provC', base_url: base, api_key: 'sk-c', enabled: true, models: ['claude-opus-5'], slots: {} },
    DEAD,
    { id: 'pbad', name: 'bad5xx', base_url: `http://127.0.0.1:${failPort}`, api_key: 'sk-bad', enabled: true, models: [] },
  ];
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, claude: provs, codex: [] }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  // 强制重新装载 store(require 已完成,这里直接改内存态)
  _state.store = { claude: provs, codex: [] };
  _state.sessions.clear();
  _state.cooldowns = {};

  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

// ---------------------------------------------------------------- 纯函数
test('parseSessionId 支持裸 id 与 JSON 字符串两种形态', () => {
  assert.strictEqual(parseSessionId('abc-123'), 'abc-123');
  assert.strictEqual(parseSessionId('{"device_id":"d","session_id":"sess-9"}'), 'sess-9');
  assert.strictEqual(parseSessionId('{"device_id":"d"}'), '');
  assert.strictEqual(parseSessionId('   '), '');
  assert.strictEqual(parseSessionId(null), '');
});

test('sessionIdentity 三级识别:官方头 > metadata > 内容指纹,全无则 anon', () => {
  const H = { headers: { 'x-claude-code-session-id': 'uuid-1' } };
  assert.deepStrictEqual(sessionIdentity(H, { metadata: { user_id: 'other' } }), { key: 'cc:uuid-1', kind: 'header' });

  const onlyMeta = { headers: {} };
  assert.deepStrictEqual(sessionIdentity(onlyMeta, { metadata: { user_id: '{"session_id":"uuid-2"}' } }), { key: 'cc:uuid-2', kind: 'metadata' });

  const bare = { headers: {} };
  assert.deepStrictEqual(sessionIdentity(bare, { metadata: { user_id: 'uuid-3' } }), { key: 'cc:uuid-3', kind: 'metadata' });

  // 非 CC 客户端:同内容两次 → 同一指纹;不同内容 → 不同指纹
  const bodyA = { system: 'be helpful', messages: [{ role: 'user', content: 'first question' }] };
  const bodyB = { system: 'be helpful', messages: [{ role: 'user', content: 'another question' }] };
  const a1 = sessionIdentity({ headers: {} }, bodyA);
  const a2 = sessionIdentity({ headers: {} }, bodyA);
  const b1 = sessionIdentity({ headers: {} }, bodyB);
  assert.strictEqual(a1.kind, 'fingerprint');
  assert.strictEqual(a1.key, a2.key, '同内容必须归到同一会话');
  assert.notStrictEqual(a1.key, b1.key, '不同内容必须是不同会话');

  assert.deepStrictEqual(sessionIdentity({ headers: {} }, {}), { key: 'anon', kind: 'anon' });
});

test('sessionLabel 取 system 里的工作目录,否则退回首条用户消息(跳过 system-reminder)', () => {
  const withCwd = { system: [{ type: 'text', text: '<env>\nWorking directory: /Users/dev/proj/app\n</env>' }] };
  assert.strictEqual(sessionLabel(withCwd), '~/proj/app');
  const linux = { system: [{ type: 'text', text: '<env>\nWorking directory: /home/dev/work\n</env>' }] };
  assert.strictEqual(sessionLabel(linux), '~/work');

  const withMsg = { messages: [{ role: 'user', content: [
    { type: 'text', text: '<system-reminder>\nnoise\n</system-reminder>' },
    { type: 'text', text: '  帮我看下这个   路由问题 ' },
  ] }] };
  assert.strictEqual(sessionLabel(withMsg), '帮我看下这个 路由问题');

  assert.strictEqual(sessionLabel({}), '');
});

test('applyLabel:内部文案(起标题请求)不覆盖真正的对话标签', () => {
  const s = { label: '' };
  applyLabel(s, '帮我看下路由');
  assert.strictEqual(s.label, '帮我看下路由');
  applyLabel(s, '别的对话内容');
  assert.strictEqual(s.label, '帮我看下路由', '已有正常标签不该被后续请求改写');
  // 先被内部文案占位 → 之后来了正常标签要顶掉它
  const t = { label: '' };
  applyLabel(t, '<session> hi </session> Write the title in the language');
  applyLabel(t, '真正的问题');
  assert.strictEqual(t.label, '真正的问题');
  // 空标签不写入
  const u = { label: '' };
  applyLabel(u, '');
  assert.strictEqual(u.label, '');
});

test('matchWhen:空条件恒真,条件为子串且大小写不敏感', () => {
  assert.strictEqual(matchWhen({}, { session: 'x', ua: 'y', token: 'z' }), true);
  assert.strictEqual(matchWhen({ when: {} }, {}), true);
  assert.strictEqual(matchWhen({ when: { session: 'special' } }, { session: 'cc:special-1' }), true);
  assert.strictEqual(matchWhen({ when: { session: 'special' } }, { session: 'cc:normal' }), false);
  assert.strictEqual(matchWhen({ when: { ua: 'CLAUDE-CLI' } }, { ua: 'claude-cli/2.1' }), true);
  // 多个条件必须同时满足
  assert.strictEqual(matchWhen({ when: { ua: 'claude-cli', token: 'tk1' } }, { ua: 'claude-cli/2', token: 'tk2' }), false);
  // body 条件从 ctx.bodyText() 取文本(没有该函数就当空串,不抛错)
  assert.strictEqual(matchWhen({ when: { body: 'DETAILED SUMMARY' } }, { bodyText: () => 'create a detailed summary of the conversation' }), true);
  assert.strictEqual(matchWhen({ when: { body: 'detailed summary' } }, { bodyText: () => 'nothing here' }), false);
  assert.strictEqual(matchWhen({ when: { body: 'x' } }, {}), false);
  // body 与其它条件同时给出时为「与」
  assert.strictEqual(matchWhen({ when: { body: 'summary', ua: 'claude-cli' } }, { ua: 'curl/8', bodyText: () => 'summary' }), false);
});

test('normalizeRule:补默认值、剔除坏池成员、收敛枚举与类型', () => {
  const r = normalizeRule({
    match: 'opus', pool: ['pa', '', { provider: 'pb', model: 'm1', weight: 3 }, { provider: '' }, 42, { provider: 'pc', weight: -1 }, 'pdead'],
    strategy: 'nonsense', priority: '7', when: { session: ' s1 ', ua: '', junk: 'x', body: ' detailed summary ' }, enabled: undefined,
  });
  assert.strictEqual(r.strategy, 'round_robin');            // 非法策略回落默认
  assert.strictEqual(r.priority, 7);
  assert.strictEqual(r.enabled, true);
  assert.deepStrictEqual(r.pool, ['pa', { provider: 'pb', model: 'm1', weight: 3 }, { provider: 'pc' }, 'pdead']);
  assert.deepStrictEqual(r.when, { session: 's1', body: 'detailed summary' });  // 只留认识的字段,值 trim
  const empty = normalizeRule(null);
  assert.strictEqual(empty.match, '');
  assert.deepStrictEqual(empty.pool, []);
  assert.ok(empty.id);
});

test('strategyOf 只认白名单', () => {
  assert.strictEqual(strategyOf({ strategy: 'weighted' }), 'weighted');
  assert.strictEqual(strategyOf({ strategy: 'least_used' }), 'least_used');
  assert.strictEqual(strategyOf({ strategy: 'bogus' }), 'round_robin');
  assert.strictEqual(strategyOf(null), 'round_robin');
});

test('buildUpstreamHeaders:渠道自定义 UA 优先于客户端 UA,最后兜底', () => {
  const req = { headers: { 'user-agent': 'client/1.0', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'b1' } };
  const custom = buildUpstreamHeaders({ api_key: 'k', ua: 'custom-ua/9' }, req);
  assert.strictEqual(custom['User-Agent'], 'custom-ua/9');
  assert.strictEqual(custom['Authorization'], 'Bearer k');
  assert.strictEqual(custom['anthropic-beta'], 'b1');
  const noUa = buildUpstreamHeaders({ api_key: 'k' }, req);
  assert.strictEqual(noUa['User-Agent'], 'client/1.0');
  const noClientUa = buildUpstreamHeaders({ api_key: 'k' }, { headers: {} });
  assert.ok(noClientUa['User-Agent'].startsWith('claude-cli/'));
});

test('clientToken 从 Authorization / x-api-key 取客户端凭据', () => {
  assert.strictEqual(clientToken({ headers: { authorization: 'Bearer tok-1' } }), 'tok-1');
  assert.strictEqual(clientToken({ headers: { 'x-api-key': 'tok-2' } }), 'tok-2');
  assert.strictEqual(clientToken({ headers: {} }), '');
});

// ---------------------------------------------------------------- 渠道池与会话粘性
test('round_robin:新会话依次落到不同渠道,同一会话始终粘一个', async () => {
  setRoutes([{ id: 'r1', match: 'opus', pool: ['pa', 'pb', 'pc'], strategy: 'round_robin', enabled: true }]);
  const a = await callWithSession('sess-a');
  const b = await callWithSession('sess-b');
  const c = await callWithSession('sess-c');
  assert.deepStrictEqual([a.key, b.key, c.key], ['sk-a', 'sk-b', 'sk-c'], '三个新对话应分到三个渠道');

  // 粘性:每个会话再问两次,还是原来那个渠道
  assert.strictEqual((await callWithSession('sess-a')).key, 'sk-a');
  assert.strictEqual((await callWithSession('sess-b')).key, 'sk-b');
  assert.strictEqual((await callWithSession('sess-a')).key, 'sk-a');

  const log = await lastLog();
  assert.strictEqual(log.session, 'sess-a');
  assert.strictEqual(log.sticky, true, '复用绑定应标记 sticky');
  assert.strictEqual(log.attempts, 1);
  assert.strictEqual(log.failover, false);
});

test('least_used:优先分给当前挂载会话最少的渠道', async () => {
  setRoutes([{ id: 'rl', match: 'opus', pool: ['pa', 'pb'], strategy: 'least_used', enabled: true }]);
  _state.sessions.clear();
  _state.bindSession('cc:busy-1', 'pa');
  _state.bindSession('cc:busy-2', 'pa');
  const r = await callWithSession('sess-free');
  assert.strictEqual(r.key, 'sk-b', 'pa 已挂 2 个会话,pb 空闲应被选中');
});

test('weighted:按权重比例分配(3:1 在 8 个新会话上呈现 6:2)', async () => {
  setRoutes([{ id: 'rw', match: 'opus', pool: [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }], strategy: 'weighted', enabled: true }]);
  _state.sessions.clear();
  const got = [];
  for (let i = 0; i < 8; i++) got.push((await callWithSession(`w-sess-${i}`)).key);
  const count = k => got.filter(x => x === k).length;
  assert.strictEqual(count('sk-a'), 6);
  assert.strictEqual(count('sk-b'), 2);
});

test('池成员带独立目标模型:各成员用自己的模型名', async () => {
  setRoutes([{ id: 'rm', match: 'opus', pool: [{ provider: 'pa', model: 'model-for-a' }, { provider: 'pb', model: 'model-for-b' }], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  await callWithSession('m-1');
  await callWithSession('m-2');
  const b1 = mock.requests.at(-2).body.model;
  const b2 = mock.requests.at(-1).body.model;
  assert.deepStrictEqual([b1, b2].sort(), ['model-for-a', 'model-for-b']);
});

test('max_attempts 限制一次请求最多试几个渠道', async () => {
  setRoutes([{ id: 'ra', match: 'opus', pool: ['pdead', 'pbad', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = {};
  const r = await callWithSession('at-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.key, 'sk-b', '两个坏渠道后落到 pb');
  assert.strictEqual((await lastLog()).attempts, 3);
});

// ---------------------------------------------------------------- 失败转移与冷却
test('失败转移:池首选连不上时自动换下一个,并把会话重新绑到可用渠道', async () => {
  setRoutes([{ id: 'rf', match: 'opus', pool: ['pdead', 'pa'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = {};
  const first = await callWithSession('fo-1');
  assert.strictEqual(first.status, 200, '首选渠道挂了也不该把请求打回客户端');
  assert.strictEqual(first.key, 'sk-a', '应转移到 pa');
  const log = await lastLog();
  assert.strictEqual(log.failover, true);
  assert.strictEqual(log.attempts, 2);
  assert.strictEqual(log.provider, 'provA');

  // 会话已被重绑到 pa:下一个请求直接成功,不再试死渠道
  const second = await callWithSession('fo-1');
  assert.strictEqual(second.key, 'sk-a');
  const log2 = await lastLog();
  assert.strictEqual(log2.attempts, 1);
  assert.strictEqual(log2.failover, false);
  assert.strictEqual(log2.sticky, true);
});

test('5xx 上游也触发转移(趁还没给客户端写字节)', async () => {
  setRoutes([{ id: 'r5', match: 'opus', pool: ['pbad', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = {};
  const r = await callWithSession('f5-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.key, 'sk-b');
  assert.strictEqual((await lastLog()).failover, true);
});

test('冷却:被打入冷却的渠道不会再被新会话选中', async () => {
  setRoutes([{ id: 'rc', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = { pa: Date.now() + 60000 }; // 手动把 pa 打进冷却
  const r = await callWithSession('co-1');
  assert.strictEqual(r.key, 'sk-b', '唯一可用成员是 pb');
  assert.strictEqual((await lastLog()).attempts, 1, '冷却成员不应被尝试');
});

test('全部成员都在冷却时仍会用冷却成员兜底(不死锁)', async () => {
  setRoutes([{ id: 'rall', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = { pa: Date.now() + 60000, pb: Date.now() + 60000 };
  const r = await callWithSession('all-1');
  assert.strictEqual(r.status, 200);
  assert.ok(['sk-a', 'sk-b'].includes(r.key));
});

test('池里的代理全挂时返回 502,并带上最后一条错误', async () => {
  setRoutes([{ id: 'rd', match: 'opus', pool: ['pdead'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  _state.cooldowns = {};
  const r = await callWithSession('dead-1');
  assert.strictEqual(r.status, 502);
  assert.strictEqual(JSON.parse(r.text).error.type, 'api_error');
  assert.strictEqual((await lastLog()).failover, false, '没有后备可选时不算转移');
});

// ---------------------------------------------------------------- 路由策略优化
test('priority:数值大的规则先匹配,压过数组顺序', async () => {
  setRoutes([
    { id: 'low', match: 'opus', provider: 'pa', priority: 0, enabled: true },
    { id: 'high', match: 'opus', provider: 'pb', priority: 10, enabled: true },
  ]);
  _state.sessions.clear();
  assert.strictEqual((await callWithSession('pr-1')).key, 'sk-b');
  assert.strictEqual((await lastLog()).rule, 'high');
});

test('同优先级时保持数组顺序(稳定)', async () => {
  setRoutes([
    { id: 'first', match: 'opus', provider: 'pa', priority: 5, enabled: true },
    { id: 'second', match: 'opus', provider: 'pb', priority: 5, enabled: true },
  ]);
  _state.sessions.clear();
  assert.strictEqual((await callWithSession('pr-2')).key, 'sk-a');
});

test('when.session:按会话把请求分流到指定渠道', async () => {
  setRoutes([
    { id: 'special', match: 'opus', provider: 'pc', priority: 5, when: { session: 'vip' }, enabled: true },
    { id: 'rest', match: 'opus', provider: 'pa', priority: 0, enabled: true },
  ]);
  _state.sessions.clear();
  assert.strictEqual((await callWithSession('vip-1')).key, 'sk-c');
  assert.strictEqual((await callWithSession('plain-1')).key, 'sk-a');
});

test('when.ua / when.token:按客户端类型或携带的凭据分流', async () => {
  setRoutes([
    { id: 'byua', match: 'opus', provider: 'pb', priority: 5, when: { ua: 'my-fork' }, enabled: true },
    { id: 'bytok', match: 'opus', provider: 'pc', priority: 4, when: { token: 'tok-team' }, enabled: true },
    { id: 'rest', match: 'opus', provider: 'pa', priority: 0, enabled: true },
  ]);
  _state.sessions.clear();
  assert.strictEqual((await callWithSession('ua-1', { headers: { 'User-Agent': 'my-fork/1.0' } })).key, 'sk-b');
  assert.strictEqual((await callWithSession('tk-1', { headers: { Authorization: 'Bearer tok-team' } })).key, 'sk-c');
  assert.strictEqual((await callWithSession('tk-2')).key, 'sk-a');
});

test('default 也能配池:未命中任何规则时按池分发', async () => {
  setRoutes([], { pool: ['pa', 'pb'], strategy: 'round_robin' });
  _state.sessions.clear();
  const r1 = await callWithSession('dflt-1', { model: 'claude-unknown-9' });
  const r2 = await callWithSession('dflt-2', { model: 'claude-unknown-9' });
  assert.deepStrictEqual([r1.key, r2.key], ['sk-a', 'sk-b']);
  assert.strictEqual((await lastLog()).rule, 'default');
});

// ---------------------------------------------------------------- 会话 API
test('会话 API:列表可见、可手动改绑、可解绑', async () => {
  setRoutes([{ id: 'rs', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  const key = keyOf('api-sess-1');
  await callWithSession('api-sess-1');
  const listed = JSON.parse((await rawRequest(uiPort, 'GET', '/api/sessions')).text).sessions;
  const mine = listed.find(s => s.key === key);
  assert.ok(mine, '会话应出现在列表里');
  assert.strictEqual(mine.short, 'api-sess');
  assert.strictEqual(mine.provider_name, 'provA');
  assert.strictEqual(mine.reqs, 1);
  assert.strictEqual(mine.pinned, false);

  // 手动改绑到 pc
  const pin = await rawRequest(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: 'pc' } });
  assert.strictEqual(pin.status, 200);
  assert.strictEqual(JSON.parse(pin.text).session.provider_name, 'provC');
  assert.strictEqual((await callWithSession('api-sess-1')).key, 'sk-c', '改绑后该对话应走 pc');

  // 绑一个不存在的渠道 → 404
  const bad = await rawRequest(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: 'ghost' } });
  assert.strictEqual(bad.status, 404);

  // 解绑 → 下次请求重新按策略分配
  assert.strictEqual((await rawRequest(uiPort, 'DELETE', `/api/sessions/${encodeURIComponent(key)}`)).status, 200);
  const after = JSON.parse((await rawRequest(uiPort, 'GET', '/api/sessions')).text).sessions;
  assert.ok(!after.some(s => s.key === key));
  assert.strictEqual((await rawRequest(uiPort, 'DELETE', `/api/sessions/${encodeURIComponent(key)}`)).status, 404);
});

test('会话 API:置空 provider 表示解除钉定,渠道停用时拒绝绑定', async () => {
  setRoutes([{ id: 'rs2', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  const key = keyOf('api-sess-2');
  await callWithSession('api-sess-2');

  _state.store.claude.find(p => p.id === 'pa').enabled = false;
  const refused = await rawRequest(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: 'pa' } });
  assert.strictEqual(refused.status, 400);
  assert.ok(JSON.parse(refused.text).error.includes('停用'));

  const cleared = await rawRequest(uiPort, 'POST', `/api/sessions/${encodeURIComponent(key)}/pin`, { body: { provider: '' } });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(JSON.parse(cleared.text).session.pinned, false);
  _state.store.claude.find(p => p.id === 'pa').enabled = true;
});

test('日志按会话过滤:只留该对话的请求', async () => {
  setRoutes([{ id: 'rf2', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  await callWithSession('log-one');
  await callWithSession('log-two');
  const got = JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?session=' + encodeURIComponent('log-one'))).text).logs;
  assert.ok(got.length >= 1);
  assert.ok(got.every(l => l.session === 'log-one'));
  assert.ok(got.every(l => l.session_kind === 'header'));
});

test('/api/state 暴露会话数、冷却表与 TTL 参数', async () => {
  const s = JSON.parse((await rawRequest(uiPort, 'GET', '/api/state')).text);
  assert.ok(Array.isArray(s.sessions));
  assert.ok(Array.isArray(s.cooldowns));
  assert.strictEqual(typeof s.cooldown_s, 'number');
  assert.strictEqual(typeof s.session_ttl_min, 'number');
  // 会话数据绝不能带出密钥
  const blob = JSON.stringify(s.sessions);
  assert.ok(!blob.includes('sk-a') && !blob.includes('sk-b') && !blob.includes('sk-c'));
});

test('IP/敏感面:会话标签不落盘到请求日志', async () => {
  setRoutes([{ id: 'rl2', match: 'opus', pool: ['pa'], strategy: 'round_robin', enabled: true }]);
  _state.sessions.clear();
  await callWithSession('label-check', { body: { messages: [{ role: 'user', content: '这是我的私密提问内容' }] } });
  const log = await lastLog();
  assert.ok(!JSON.stringify(log).includes('私密提问'), '请求日志只应记会话短 id,不应记对话内容');
});

test('向后兼容:老格式规则(只有 provider,无 pool/priority/when)照常工作', async () => {
  _state.routes = { rules: [{ id: 'legacy', match: 'opus', provider: 'pa', model: 'legacy-target', enabled: true }],
    default: { provider: '', model: '' } };
  _state.resetPools();
  _state.sessions.clear();
  const r = await callWithSession('legacy-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.key, 'sk-a');
  assert.strictEqual(mock.requests.at(-1).body.model, 'legacy-target');
  assert.strictEqual((await lastLog()).pool, 1);
});

test('停用的单一目标渠道仍报 provider_disabled_error(池才自动跳过)', async () => {
  _state.routes = { rules: [{ id: 'dis', match: 'opus', provider: 'pa', model: '', enabled: true }],
    default: { provider: '', model: '' } };
  _state.store.claude.find(p => p.id === 'pa').enabled = false;
  const r = await callWithSession('dis-1');
  _state.store.claude.find(p => p.id === 'pa').enabled = true;
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.text).error.type, 'provider_disabled_error');
});

test('池成员全被停用时报 no_route_error', async () => {
  setRoutes([{ id: 'pd', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  const save = _state.store.claude.filter(p => p.id === 'pa' || p.id === 'pb').map(p => p.enabled);
  _state.store.claude.filter(p => p.id === 'pa' || p.id === 'pb').forEach(p => { p.enabled = false; });
  const r = await callWithSession('pd-1');
  _state.store.claude.filter(p => p.id === 'pa' || p.id === 'pb').forEach((p, i) => { p.enabled = save[i]; });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.text).error.type, 'no_route_error');
});
