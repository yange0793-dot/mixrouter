'use strict';
// v3.4 上游健康测试:熔断器(闭/开/半开)、错误分型、三段超时(首字节/流式空闲/非流式总)、
// 客户端断开收尾、4xx 冷却、default 路由策略、加权池冷却恢复、/api/health 视图。
// mock 上游 + 临时数据目录,不触碰真实配置与真实上游
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-health-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_COOLDOWN_SEC = '60';
process.env.MIXR_MAX_ATTEMPTS = '3';
process.env.MIXR_CONV_RETRIES = '3';
// 三段超时都压到亚秒级,让"上游发完头就装死"这类场景在测试里可复现
process.env.MIXR_FIRST_HEADER_TIMEOUT_MS = '1200';
process.env.MIXR_STREAM_IDLE_TIMEOUT_MS = '600';
process.env.MIXR_NONSTREAM_TOTAL_TIMEOUT_MS = '800';
process.env.MIXR_BREAKER_FAILURE_THRESHOLD = '3';

const { createHealth } = require('../lib/upstream-health.js');
const mod = require('../mixrouter.js');
const { sessionIdentity, errorClass, normalizeRule, _state } = mod;

// ---------------------------------------------------------------- 熔断器单元(假时钟)
test('熔断器:连败到阈值开路,期满后半开,探测成功闭合', () => {
  let now = 0;
  const h = createHealth({ cooldownMs: 1000, failureThreshold: 3, recoveryThreshold: 1, now: () => now });
  assert.strictEqual(h.eligible('p'), true, '初始应闭合可用');
  h.acquire('p')('failure', 'x', 500);
  h.acquire('p')('failure', 'x', 500);
  assert.strictEqual(h.view('p').state, 'closed', '两次失败未到阈值不开路');
  h.acquire('p')('failure', 'x', 500);
  assert.strictEqual(h.view('p').state, 'open', '第三次失败开路');
  assert.strictEqual(h.eligible('p'), false);
  now = 1001;
  assert.strictEqual(h.view('p').state, 'half-open', '期满进入半开');
  const probe = h.acquire('p');
  assert.ok(probe, '半开首个请求拿到探测名额');
  assert.strictEqual(h.acquire('p'), null, '探测在途时不再放行第二个');
  assert.strictEqual(h.eligible('p'), false);
  probe('success', '', 200);
  assert.strictEqual(h.view('p').state, 'closed', '探测成功闭合');
  assert.strictEqual(h.eligible('p'), true);
});

test('熔断器:半开探测失败立刻重新开路并重新计时', () => {
  let now = 0;
  const h = createHealth({ cooldownMs: 1000, failureThreshold: 2, recoveryThreshold: 1, now: () => now });
  h.acquire('p')('failure', 'x', 500);
  h.acquire('p')('failure', 'x', 500);
  assert.strictEqual(h.view('p').state, 'open');
  now = 1000;
  const probe = h.acquire('p');
  probe('failure', 'x', 500);
  assert.strictEqual(h.view('p').state, 'open');
  assert.strictEqual(h.view('p').openUntil, 2000, '从探测失败那刻重新计时');
});

test('熔断器:上一代的迟到成功不能闭合新开路的熔断器', () => {
  let now = 0;
  const h = createHealth({ cooldownMs: 1000, failureThreshold: 1, recoveryThreshold: 1, now: () => now });
  const first = h.acquire('p');
  h.acquire('p')('failure', 'x', 500);
  assert.strictEqual(h.view('p').state, 'open');
  first('success', '', 200);
  assert.strictEqual(h.view('p').state, 'open', '旧一代的成功不该把熔断器关上');
  now = 1000;
  h.acquire('p')('success', '', 200);
  assert.strictEqual(h.view('p').state, 'closed');
});

test('熔断器:4xx 拒绝证明连通,清零失败计数;客户端取消不改变计数', () => {
  const h = createHealth({ cooldownMs: 1000, failureThreshold: 2, recoveryThreshold: 1, now: () => 0 });
  h.acquire('p')('failure', 'x', 500);
  h.acquire('p')('rejected', '', 401);
  assert.strictEqual(h.view('p').failures, 0, '拒绝清零失败计数');
  assert.strictEqual(h.view('p').state, 'closed');
  assert.strictEqual(h.view('p').lastOutcome, 'rejected');
  h.acquire('p')('failure', 'x', 500);
  h.acquire('p')('cancelled');
  assert.strictEqual(h.view('p').failures, 1, '取消既不算成功也不算失败');
  assert.strictEqual(h.view('p').lastOutcome, 'cancelled');
});

// ---------------------------------------------------------------- 纯函数
test('errorClass:状态码与网络错误分型', () => {
  assert.strictEqual(errorClass(401), 'authentication');
  assert.strictEqual(errorClass(403), 'authentication');
  assert.strictEqual(errorClass(429), 'rate_limit');
  assert.strictEqual(errorClass(500), 'upstream_server');
  assert.strictEqual(errorClass(503), 'upstream_server');
  assert.strictEqual(errorClass(400), 'upstream_request');
  assert.strictEqual(errorClass(0, 'ECONNREFUSED'), 'econnrefused');
  assert.strictEqual(errorClass(0, 'ECONNRESET'), 'econnreset');
  assert.strictEqual(errorClass(0, 'ETIMEDOUT'), 'network_error');
  assert.strictEqual(errorClass(0, ''), '');
});

test('sessionIdentity:无头无 metadata 的 codex chat 请求按 system+首条用户消息指纹', () => {
  const req = { headers: {} };
  const mk = sys => ({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hello' }] });
  const a = sessionIdentity(req, mk('sys-a'), 'codex');
  assert.strictEqual(a.kind, 'fingerprint');
  assert.ok(a.key.startsWith('cxf:'), `key 应为指纹前缀,得到 ${a.key}`);
  assert.strictEqual(a.key, sessionIdentity(req, mk('sys-a'), 'codex').key, '同内容跨轮稳定');
  assert.notStrictEqual(a.key, sessionIdentity(req, mk('sys-b'), 'codex').key, '不同内容分开');
  assert.strictEqual(sessionIdentity(req, { messages: [] }, 'codex').key, 'cx-anon');
});

// ---------------------------------------------------------------- 集成:假上游们
const { createMockUpstream } = require('./mock-upstream.js');
const mock = createMockUpstream();

// 收下请求但永不回响应头(首字节超时用)
function createSilentUpstream() {
  const server = http.createServer(req => req.resume());
  return { server };
}
// 发 200 + SSE 头 + 首个事件后永远沉默(流式空闲超时用)
function createStalledSseUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    });
  });
  return { server };
}
// 发 200 + 半截 JSON 后沉默(非流式总超时用)
function createSlowBodyUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"id":"msg_partial","content":[');
    });
  });
  return { server };
}
// 固定状态码上游(4xx 冷却用)
function createStatusUpstream(status) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
    });
  });
  return { server };
}
// 慢速 SSE:每 200ms 一小段;客户端断开时上游能察觉(记录 aborted)
function createSlowSseUpstream() {
  const state = { aborted: false };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      let n = 0;
      const timer = setInterval(() => {
        n++;
        if (n > 20) { clearInterval(timer); res.end(); return; }
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
      }, 200);
      res.on('close', () => { clearInterval(timer); if (n <= 20) state.aborted = true; });
    });
  });
  return { server, state };
}
// 固定 500 上游(熔断用)
function createFailingUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"boom"}}'); });
  });
  return { server };
}

let proxySrv, uiSrv, proxyPort, uiPort;
const ports = {};

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
// 带看门狗的请求:响应迟迟不结束直接判负(防测试本身挂死)
function rawRequestGuarded(port, method, reqPath, opts, ms = 5000) {
  return Promise.race([
    rawRequest(port, method, reqPath, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`响应 ${ms}ms 未结束`)), ms)),
  ]);
}
const callWithSession = (sessionId, extra = {}) => rawRequestGuarded(proxyPort, 'POST', '/v1/messages', {
  headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': sessionId },
  body: { model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra.body },
});
const lastLog = async () => JSON.parse((await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text).logs[0];

function setRoutes(rules, def = { provider: '', model: '' }) {
  _state.routes = { rules: rules.map(normalizeRule), default: normalizeRule(def) };
  resetRouting();
}
function resetRouting() {
  _state.cooldowns = {};
  _state.resetPools();
  _state.resetHealth();
  _state.sessions.clear();
}

test('setup:三段超时 + 各类假上游', async () => {
  const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  await listen(mock.server);
  ports.mock = mock.server.address().port;
  const special = {
    silent: createSilentUpstream(), stalled: createStalledSseUpstream(),
    slowBody: createSlowBodyUpstream(), s401: createStatusUpstream(401),
    slowSse: createSlowSseUpstream(), fail: createFailingUpstream(),
  };
  for (const [k, v] of Object.entries(special)) {
    await listen(v.server);
    v.server.unref();
    ports[k] = v.server.address().port;
  }
  ports.slowSseState = special.slowSse.state;
  mock.server.unref();

  const p = (id, name, port) => ({ id, name, base_url: `http://127.0.0.1:${port}`, api_key: `sk-${id}`, enabled: true, models: ['claude-opus-5'], slots: {} });
  const provs = [
    p('pa', 'provA', ports.mock), p('pb', 'provB', ports.mock),
    p('psilent', 'silent', ports.silent), p('pstall', 'stalled', ports.stalled),
    p('pslow', 'slowbody', ports.slowBody), p('p401', 'auth401', ports.s401),
    p('pslowSse', 'slowSse', ports.slowSse), p('pbad', 'bad5xx', ports.fail),
    { id: 'pdead', name: 'dead', base_url: 'http://127.0.0.1:1', api_key: 'sk-dead', enabled: true, models: [] },
  ];
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ version: 2, current: { claude: null, codex: null }, claude: provs, codex: [] }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({ rules: [], default: { provider: '', model: '' } }));
  _state.store = { claude: provs, codex: [] };
  resetRouting();

  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('首字节超时:上游装死时换下一个渠道,不把请求打回客户端', async () => {
  setRoutes([{ id: 'rt', match: 'opus', pool: ['psilent', 'pa'], strategy: 'priority', enabled: true }]);
  const r = await callWithSession('fb-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-mixrouter-provider'], 'provA', '装死渠道超时后应转移到 pa');
  const log = await lastLog();
  assert.strictEqual(log.failover, true);
  assert.strictEqual(log.err_class, 'timeout', '转移原因留在 err_class(err 字段只记终态失败)');
  assert.strictEqual(log.err, '', '转移成功不算失败记录');
});

test('流式空闲超时:上游发完头就装死,客户端不会被晾到天荒地老', async () => {
  setRoutes([{ id: 'ri', match: 'opus', pool: ['pstall'], strategy: 'priority', enabled: true }]);
  const r = await callWithSession('idle-1', { body: { stream: true } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('message_start'), '已转发的部分应已送达');
  assert.ok(!r.text.includes('message_stop'), '上游装死,流不该完整');
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'timeout');
  assert.strictEqual(log.err, 'stream idle timeout');
});

test('非流式总超时:上游拖着半个 JSON 不结束,代理掐断并收尾', async () => {
  setRoutes([{ id: 'rn', match: 'opus', pool: ['pslow'], strategy: 'priority', enabled: true }]);
  const r = await callWithSession('body-1', { body: { stream: false } });
  assert.strictEqual(r.status, 200, '响应头已回给客户端,只能掐断而不是改状态码');
  assert.ok(r.text.startsWith('{"id":"msg_partial"'));
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'timeout');
  assert.strictEqual(log.err, 'body timeout');
});

test('客户端中途断开:掐掉上游、记一条 cancelled,不烧后台渠道额度', async () => {
  setRoutes([{ id: 'rc', match: 'opus', pool: ['pslowSse'], strategy: 'priority', enabled: true }]);
  const before = (await rawRequest(uiPort, 'GET', '/api/logs?limit=1')).text;
  const creq = http.request({
    hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cancel-1' },
  }, cres => { cres.once('data', () => creq.destroy()); });
  creq.end(JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  await new Promise(ok => setTimeout(ok, 800));
  assert.strictEqual(ports.slowSseState.aborted, true, '客户端断开后上游连接应被掐断');
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'cancelled');
  assert.ok(log.ms >= 0);
  assert.notStrictEqual(JSON.stringify(log), before, '取消也应有日志');
});

test('4xx 非重试错误:原样透传、进冷却、分型 authentication、熔断不累计', async () => {
  setRoutes([{ id: 'r4', match: 'opus', pool: ['p401', 'pa'], strategy: 'priority', enabled: true }]);
  const r = await callWithSession('auth-1');
  assert.strictEqual(r.status, 401, '401 应原样透传给客户端');
  const log = await lastLog();
  assert.strictEqual(log.err_class, 'authentication');
  assert.strictEqual(log.provider, 'auth401');
  const r2 = await callWithSession('auth-2');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.headers['x-mixrouter-provider'], 'provA', '401 渠道应进冷却,新会话落到 pa');
});

test('default 路由也吃配置的策略:priority 不再退回轮转', async () => {
  setRoutes([], { provider: '', model: '', pool: ['pa', 'pb'], strategy: 'priority' });
  const a = await callWithSession('def-1');
  const b = await callWithSession('def-2');
  assert.strictEqual(a.headers['x-mixrouter-provider'], 'provA');
  assert.strictEqual(b.headers['x-mixrouter-provider'], 'provA', 'priority 应总是取第一个可用渠道');
  _state.cooldowns = { pa: Date.now() + 60000 };
  const c = await callWithSession('def-3');
  assert.strictEqual(c.headers['x-mixrouter-provider'], 'provB', '首选进冷却后降级到下一个');
});

test('加权池:冷却中的成员退出轮转,恢复后能重新进轮转', async () => {
  setRoutes([{ id: 'rw', match: 'opus', pool: [{ provider: 'pa', weight: 3 }, { provider: 'pb', weight: 1 }], strategy: 'weighted', enabled: true }]);
  _state.cooldowns = { pa: Date.now() + 60 }; // 短冷却,很快过期
  const during = [];
  for (let i = 0; i < 4; i++) during.push((await callWithSession(`w-c-${i}`)).headers['x-mixrouter-provider']);
  assert.ok(during.every(x => x === 'provB'), '冷却期内全部落到 pb');
  await new Promise(ok => setTimeout(ok, 120));
  const after = [];
  for (let i = 0; i < 8; i++) after.push((await callWithSession(`w-r-${i}`)).headers['x-mixrouter-provider']);
  const nA = after.filter(x => x === 'provA').length;
  assert.ok(nA >= 1, `冷却过期后 pa 应重新参与轮转,实际 ${JSON.stringify(after)}`);
});

test('熔断器集成:连败开路后即使清掉冷却也不再选中该渠道', async () => {
  setRoutes([{ id: 'rb', match: 'opus', pool: ['pbad', 'pa'], strategy: 'priority', enabled: true }]);
  // 三轮:每轮 pbad 500 → 转移 pa。轮间清冷却但保留熔断状态,让 pbad 每轮都被优先选中
  for (let i = 0; i < 3; i++) {
    _state.cooldowns = {};
    const r = await callWithSession(`brk-${i}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await lastLog()).failover, true);
  }
  const h = JSON.parse((await rawRequest(uiPort, 'GET', '/api/health')).text);
  const bad = h.providers.find(p => p.provider === 'pbad');
  assert.strictEqual(bad.state, 'open', '三次失败应把熔断器打开');
  // 冷却已清、但熔断开着:priority 跳过 pbad,一次尝试直接落到 pa
  _state.cooldowns = {};
  const r = await callWithSession('brk-after');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-mixrouter-provider'], 'provA');
  assert.strictEqual((await lastLog()).attempts, 1, '熔断开路的渠道不该再被尝试');
});

test('/api/health:只读视图带超时/重试配置与各渠道可用性', async () => {
  setRoutes([{ id: 'rh', match: 'opus', pool: ['pa', 'pb'], strategy: 'round_robin', enabled: true }]);
  await callWithSession('health-1'); // 有一条成功记录
  const r = await rawRequest(uiPort, 'GET', '/api/health');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.text);
  assert.strictEqual(j.settings.first_header_timeout_ms, 1200);
  assert.strictEqual(j.settings.stream_idle_timeout_ms, 600);
  assert.strictEqual(j.settings.nonstream_total_timeout_ms, 800);
  assert.strictEqual(j.settings.cooldown_ms, 60000);
  assert.strictEqual(j.settings.max_attempts, 3);
  assert.strictEqual(j.settings.failure_threshold, 3);
  // ---- 端到端预算必须落在客户端(Claude Code)的预算里面 ----
  // CC 侧默认 API_TIMEOUT_MS=300s(整条请求)与 CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=120s(多久没收到字节)。
  // 本进程任何一段比它长,客户端都会先放弃并重发,我们还在替一条没人接收的响应占着上游连接和渠道额度,
  // 日志还会记成 499 client closed 而不是真实的 timeout(以前三段默认都是 600s,就是这个问题)。
  const CC_TOTAL_BUDGET_MS = 300000, CC_BYTE_IDLE_MS = 120000;
  assert.ok(j.settings.total_deadline_ms > 0 && j.settings.total_deadline_ms <= CC_TOTAL_BUDGET_MS,
    `总 deadline 必须存在且小于客户端的 ${CC_TOTAL_BUDGET_MS}ms,实际 ${j.settings.total_deadline_ms}`);
  assert.ok(j.settings.stream_first_header_timeout_ms > 0 && j.settings.stream_first_header_timeout_ms < CC_TOTAL_BUDGET_MS,
    '流式请求的上游一接受就发响应头,它的首字节预算必须比客户端总预算紧得多');
  assert.ok(j.settings.stream_idle_timeout_ms < CC_BYTE_IDLE_MS,
    '上游空闲看门狗必须早于客户端的字节流空闲超时,否则我们的诊断根本来不及送到');
  for (const k of ['first_header_timeout_ms', 'stream_first_header_timeout_ms', 'stream_idle_timeout_ms', 'nonstream_total_timeout_ms']) {
    assert.ok(j.settings[k] > 0 && j.settings[k] <= j.settings.total_deadline_ms,
      `${k} 必须被总 deadline 夹住,实际 ${j.settings[k]} > ${j.settings.total_deadline_ms}`);
  }
  const pa = j.providers.find(p => p.provider === 'pa');
  assert.ok(pa, 'providers 里应包含 pa');
  assert.strictEqual(pa.app, 'claude');
  assert.strictEqual(pa.enabled, true);
  assert.strictEqual(pa.eligible, true);
  assert.strictEqual(pa.state, 'closed');
  assert.strictEqual(pa.lastOutcome, 'success');
  const disabled = j.providers.find(p => p.provider === 'psilent');
  assert.strictEqual(disabled.cooldown_until, 0);
});

test('全池连不上:502 返回客户端,日志状态如实落盘', async () => {
  setRoutes([{ id: 'rd', match: 'opus', pool: ['pdead'], strategy: 'priority', enabled: true }]);
  const r = await callWithSession('dead-1');
  assert.strictEqual(r.status, 502);
  const log = await lastLog();
  assert.strictEqual(log.status, 502, '终态错误状态要写进日志(不能是 0)');
  assert.strictEqual(log.err_class, 'econnrefused');
  assert.ok(log.err);
});
