'use strict';
// All client configuration, data and upstream traffic are isolated from the user's files/network.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-zcode-'));
const CONFIG = path.join(TMP, 'zcode', 'config.json');
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_ZCODE_CONFIG = CONFIG;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'claude.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'codex.toml');
const mod = require('../mixrouter');
const zc = require('../lib/zcode-config');
let ui, proxy, upstream, base;
const hits = [];
const read = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const write = value => { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(value)); };
const provider = () => read().provider[zc.PROVIDER_ID];
const channel = id => [...mod._state.store.claude, ...mod._state.store.codex].find(p => p.id === id);
function request(url, method = 'POST', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: JSON.parse(text || '{}') }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const api = (route, body, method = 'POST') => request(`http://127.0.0.1:${ui.address().port}${route}`, method, body);
const switched = id => api(`/api/switch/${id}`, { app: 'zcode' });

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      hits.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', model: body.model, content: [], choices: [{ message: { content: 'ok' } }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${upstream.address().port}`;
  ui = await mod.listen(0, mod.apiHandler);
  proxy = await mod.listen(0, mod.proxyHandler);
});
beforeEach(() => {
  fs.rmSync(path.dirname(CONFIG), { recursive: true, force: true });
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, '{"env":{"ANTHROPIC_MODEL":"keep-claude"}}');
  fs.writeFileSync(process.env.MIXR_CODEX_CONFIG, 'model = "keep-codex"\n');
  mod._state.store = {
    claude: [{ id: 'a', name: 'Anthropic channel', base_url: base + '/v1', api_key: 'secret-anthropic-key', models: ['claude-real'], slots: { sonnet: 'claude-slot' }, enabled: true }],
    codex: [
      { id: 'r', name: 'Responses channel', base_url: base + '/v1', api_key: 'secret-responses-key', model: 'responses-real', wire_api: 'responses', enabled: true },
      { id: 'c', name: 'Chat channel', base_url: base + '/v1', api_key: 'secret-chat-key', model: 'chat-real', wire_api: 'chat', enabled: true },
      { id: 'off', name: 'Disabled', base_url: base, api_key: 'disabled-key', model: 'disabled-model', wire_api: 'chat', enabled: false },
    ],
  };
  mod._state.current = { claude: 'old-claude', codex: 'old-codex', zcode: null };
  mod._state.routes = { rules: [], default: mod.normalizeRule({}) };
  mod._state.sessions.clear(); mod._state.cooldowns = {}; mod._state.resetPools(); hits.length = 0;
});
after(async () => {
  await Promise.all([ui, proxy, upstream].map(s => new Promise(ok => s.close(ok))));
  // Session persistence is debounced; let the last scheduled write drain before cleanup.
  await new Promise(ok => setTimeout(ok, 400));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('unconfigured ZCode returns empty state without creating a config or third store', async () => {
  const result = await api('/api/state', undefined, 'GET');
  assert.deepEqual(result.data.live.zcode, { base_url: '', model: '', wire_api: '', provider: '', router: false, match: false });
  assert.equal(result.data.router.zcode_base, mod.ROUTER_URL);
  assert.deepEqual(Object.keys(result.data.providers), ['claude', 'codex']);
  assert.equal(fs.existsSync(CONFIG), false);
});

test('old providers.json objects and bare arrays load with independent current.zcode', () => {
  for (const old of [{ current: { claude: 'a', codex: 'r' }, claude: [], codex: [] }, []]) {
    fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify(old));
    const state = JSON.parse(execFileSync(process.execPath, ['-e', `const m=require(${JSON.stringify(path.resolve(__dirname, '../mixrouter.js'))});process.stdout.write(JSON.stringify({current:m._state.current,store:m._state.store}));`], { env: process.env, encoding: 'utf8' }));
    assert.equal(state.current.zcode, null);
    assert.equal(Object.hasOwn(state.store, 'zcode'), false);
  }
});

for (const [id, wire, kind, endpoint] of [['a', 'anthropic', 'anthropic', '/v1/messages'], ['r', 'responses', 'openai', '/responses'], ['c', 'chat', 'openai-compatible', '/chat/completions']]) {
  test(`${wire} direct registration: actual SDK URL shape, independent current and no keys in live`, async () => {
    const original = { model: 'user-provider/user-default', defaultModel: { keep: true }, provider: { custom: { kind: 'anthropic', options: { apiKey: 'user-secret' }, models: { mine: { name: 'mine' } } } }, unknown: { nested: [1, 2] } };
    write(original);
    const claudeBefore = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
    const codexBefore = fs.readFileSync(process.env.MIXR_CODEX_CONFIG, 'utf8');
    const result = await switched(id);
    assert.equal(result.status, 200, result.text);
    const p = provider();
    assert.equal(p.kind, kind); assert.equal(p.source, 'custom');
    assert.equal(p.options.apiKey, channel(id).api_key);
    assert.equal(p.options.apiKeyRequired, true);
    assert.equal(p.options.baseURL, wire === 'anthropic' ? base : base + '/v1');
    const model = result.data.live.model;
    assert.deepEqual(p.models[model], { name: `Mixrouter · ${model}` });
    assert.equal(result.data.live.match, true);
    assert.equal(result.data.live.provider, zc.PROVIDER_ID);
    assert.equal(result.data.live.wire_api, wire);
    assert.equal(result.text.includes('secret-'), false);
    const state = (await api('/api/state', undefined, 'GET')).data;
    assert.equal(JSON.stringify(state.live).includes('secret-'), false);
    assert.deepEqual(mod._state.current, { claude: 'old-claude', codex: 'old-codex', zcode: id });
    assert.deepEqual(read().provider.custom, original.provider.custom);
    assert.deepEqual(read().unknown, original.unknown);
    assert.equal(read().model, original.model);
    assert.deepEqual(read().defaultModel, original.defaultModel);
    assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), claudeBefore);
    assert.equal(fs.readFileSync(process.env.MIXR_CODEX_CONFIG, 'utf8'), codexBefore);
    const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8'));
    assert.equal(saved.current.zcode, id); assert.equal(Object.hasOwn(saved, 'zcode'), false);
    // Emulate the SDK endpoint suffix; no external SDK or real upstream is used.
    await request(p.options.baseURL + endpoint, 'POST', { model, stream: false, messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(hits.at(-1).path, wire === 'anthropic' ? '/v1/messages' : '/v1' + endpoint);
  });

  test(`${wire} router registration reuses existing routes and upstream /v1 appears once`, async () => {
    const group = wire === 'anthropic' ? 'claude' : 'codex';
    mod._state.routes = { rules: [mod.normalizeRule({ app: group, match: 'real', provider: id })], default: mod.normalizeRule({}) };
    const before = JSON.stringify(mod._state.routes);
    const model = wire === 'anthropic' ? 'claude-real' : `${wire}-real`;
    const result = await api('/api/router/zcode', { wire_api: wire, model });
    assert.equal(result.status, 200, result.text);
    const p = provider();
    assert.equal(p.kind, kind);
    assert.equal(p.options.baseURL, mod.ROUTER_URL + (wire === 'anthropic' ? '' : '/v1'));
    assert.equal(p.options.apiKey, mod.ROUTER_TOKEN);
    assert.equal(p.models['disabled-model'], undefined);
    assert.equal(result.data.live.router, true); assert.equal(result.data.live.match, true);
    assert.equal(mod._state.current.zcode, mod.ROUTER_ID);
    assert.equal(JSON.stringify(mod._state.routes), before, 'existing routes must not be rewritten');
    const localBase = p.options.baseURL.replace(mod.ROUTER_URL, `http://127.0.0.1:${proxy.address().port}`);
    const response = await request(localBase + endpoint, 'POST', { model, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], input: 'ping' });
    assert.equal(response.status, 200, response.text);
    assert.equal(hits.at(-1).path, wire === 'anthropic' ? '/v1/messages' : '/v1' + endpoint);
    assert.equal(hits.at(-1).body.model, model);
    assert.equal(hits.at(-1).headers.authorization, `Bearer ${channel(id).api_key}`);
  });
}

test('router models use enabled groups, slots and real route overrides, not match substrings', async () => {
  mod._state.routes = { rules: [
    mod.normalizeRule({ match: 'not-a-model', provider: 'a', model: 'real-route-model' }),
    mod.normalizeRule({ match: 'anything', pool: [{ provider: 'c', model: 'real-chat-override' }], app: 'codex' }),
    mod.normalizeRule({ match: 'off', provider: 'off', model: 'disabled-override' }),
    mod.normalizeRule({ match: 'offrule', provider: 'a', model: 'disabled-rule-model', enabled: false }),
  ], default: mod.normalizeRule({}) };
  assert.equal((await api('/api/router/zcode')).status, 200);
  assert.deepEqual(Object.keys(provider().models).sort(), ['claude-real', 'claude-slot', 'real-route-model']);
  assert.equal((await api('/api/router/zcode', { wire_api: 'chat' })).status, 200);
  assert.deepEqual(Object.keys(provider().models).sort(), ['chat-real', 'real-chat-override']);
  assert.equal((await api('/api/router/zcode', { wire_api: 'responses' })).status, 200);
  assert.deepEqual(Object.keys(provider().models).sort(), ['chat-real', 'real-chat-override', 'responses-real']);
});

test('no models or enabled channels returns 400 without creating configuration', async () => {
  channel('a').models = []; channel('a').slots = {};
  assert.equal((await switched('a')).status, 400);
  assert.equal((await api('/api/router/zcode')).status, 400);
  mod._state.store.codex.forEach(p => { p.enabled = false; });
  assert.equal((await api('/api/router/zcode', { wire_api: 'responses' })).status, 400);
  assert.equal((await api('/api/router/zcode', { wire_api: 'chat', model: 'invented' })).status, 400);
  assert.equal(fs.existsSync(CONFIG), false);
});

test('strict JSON/object validation and read errors never truncate or back up bad input', async () => {
  const inputs = ['{"apiKey":"hidden-secret",', '[]', 'null', '42', '{"provider":[]}', '{"provider":{"x":null}}', '{"provider":{"x":{"models":{"m":"wrong"}}}}'];
  for (const text of inputs) {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, text);
    const result = await switched('a');
    assert.equal(result.status, 500);
    assert.equal(result.text.includes('hidden-secret'), false);
    assert.equal(fs.readFileSync(CONFIG, 'utf8'), text);
    assert.equal(fs.readdirSync(path.dirname(CONFIG)).length, 1);
    const live = mod.liveZcodeState();
    assert.equal(live.match, false); assert.ok(live.error); assert.equal(JSON.stringify(live).includes('hidden-secret'), false);
    assert.equal(mod._state.current.zcode, null);
  }
  fs.unlinkSync(CONFIG); fs.mkdirSync(CONFIG);
  assert.equal((await switched('a')).status, 500, 'non-ENOENT read errors must refuse writes');
  assert.equal(fs.statSync(CONFIG).isDirectory(), true);
});

test('safe writes preserve defaults and unknown fields, make unique private backups, and replace atomically', async () => {
  write({ model: 'stay', provider: { mixrouter: { models: { mine: {} } } }, unknown: true });
  const first = fs.readFileSync(CONFIG, 'utf8');
  fs.chmodSync(CONFIG, 0o644);
  assert.equal((await switched('a')).status, 200);
  const firstBackup = fs.readdirSync(path.dirname(CONFIG)).find(f => f.includes('.bak-mixrouter-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(CONFIG), firstBackup), 'utf8'), first);
  const originalInode = fs.statSync(CONFIG).ino;
  const cfg = read();
  cfg.provider[zc.PROVIDER_ID].extra = { retain: true };
  cfg.provider[zc.PROVIDER_ID].options.extraOption = 'keep';
  cfg.provider[zc.PROVIDER_ID].models['claude-real'].extraModel = true;
  cfg.provider[zc.PROVIDER_ID].models['user-added'] = { name: 'do not delete' };
  write(cfg);
  for (let i = 0; i < 5; i++) assert.equal((await switched('a')).status, 200);
  assert.notEqual(fs.statSync(CONFIG).ino, originalInode);
  const files = fs.readdirSync(path.dirname(CONFIG));
  const backups = files.filter(f => f.includes('.bak-mixrouter-'));
  assert.equal(backups.length, 5);
  assert.ok(first.includes('stay'));
  for (const file of [...backups, 'config.json']) assert.equal(fs.statSync(path.join(path.dirname(CONFIG), file)).mode & 0o777, 0o600);
  assert.equal(files.some(f => f.includes('.tmp-')), false);
  assert.equal(read().model, 'stay'); assert.deepEqual(read().provider.mixrouter, { models: { mine: {} } });
  assert.deepEqual(provider().extra, { retain: true });
  assert.equal(provider().options.extraOption, 'keep');
  assert.equal(provider().models['claude-real'].extraModel, true);
  assert.deepEqual(provider().models['user-added'], { name: 'do not delete' });
  const before = fs.readFileSync(CONFIG, 'utf8');
  assert.equal((await switched('r')).status, 500, 'foreign models must not change protocol');
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), before);
});

test('managed ID conflicts and symlinks are rejected without touching foreign content', async () => {
  write({ provider: { [zc.PROVIDER_ID]: { kind: 'anthropic', options: { apiKey: 'foreign-secret' }, models: { m: {} } } } });
  const before = fs.readFileSync(CONFIG, 'utf8');
  assert.equal((await switched('a')).status, 500);
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), before);
  fs.unlinkSync(CONFIG);
  const target = path.join(TMP, 'foreign.json'); fs.writeFileSync(target, before); fs.symlinkSync(target, CONFIG);
  assert.equal((await switched('a')).status, 500);
  assert.equal(fs.readFileSync(target, 'utf8'), before); assert.equal(fs.lstatSync(CONFIG).isSymbolicLink(), true);
});

test('live match detects base, model, key, kind and enabled drift but ignores desktop selected model', async () => {
  await switched('a');
  const original = read();
  for (const mutate of [
    p => { p.options.baseURL = base + '/wrong'; },
    p => { p.options.apiKey = 'different-secret'; },
    p => { p.kind = 'openai'; },
    p => { delete p.models['claude-real']; },
    p => { p.models['claude-real'].id = 'different-model'; },
    p => { p.models['claude-real'].kind = 'openai'; },
    p => { p.models['claude-real'].kinds = ['openai']; },
    p => { p.models['claude-real'].defaultKind = 'openai'; },
    p => { p.models['claude-real'].zcode = { deleted: true }; },
    p => { p.models['claude-real'].options = { apiKey: 'different-secret' }; },
    p => { p.headers = { Authorization: 'Bearer different-secret' }; },
    p => { p.options.headers = { 'x-api-key': 'different-secret' }; },
    p => { p.apiFormat = 'openai-responses'; },
    p => { p.enabled = false; },
  ]) {
    const cfg = structuredClone(original); mutate(cfg.provider[zc.PROVIDER_ID]); write(cfg);
    assert.equal(mod.liveZcodeState().match, false);
    assert.equal(JSON.stringify(mod.liveZcodeState()).includes('different-secret'), false);
  }
  write({ ...original, model: 'desktop/something-else' });
  assert.equal(mod.liveZcodeState().match, true, 'registered integration is not desktop selection');
  await api('/api/router/zcode');
  const routerCfg = read(); routerCfg.provider[zc.PROVIDER_ID].options.apiKey = 'wrong-local-key'; write(routerCfg);
  assert.equal(mod.liveZcodeState().router, true); assert.equal(mod.liveZcodeState().match, false);
});

test('API rejects invalid app/body/wire/model and preserves enabled:false at channel creation', async () => {
  const invalid = [
    ['/api/switch/a', { app: 'typo' }], ['/api/switch/a', { app: null }], ['/api/switch/a', { app: 'codex' }],
    ['/api/switch/r', { app: 'claude' }], ['/api/router/typo', {}], ['/api/router/zcode', { app: 'claude' }],
    ['/api/router/zcode', { wire_api: 'openai' }], ['/api/router/zcode', { wire_api: null }],
    ['/api/router/zcode', { wire_api: ['anthropic'] }], ['/api/router/zcode', { wire_api: {} }],
    ['/api/router/zcode', { model: 42 }], ['/api/router/zcode', { model: '' }], ['/api/router/zcode', { model: 'not-registered' }],
    ['/api/providers', { app: 'zcode', name: 'bad', base_url: base }],
  ];
  for (const route of ['/api/switch/a', '/api/router/zcode', '/api/providers']) for (const body of ['{', '[]', 'null', '1']) invalid.push([route, body]);
  for (const [route, body] of invalid) assert.equal((await api(route, body)).status, 400, `${route} ${JSON.stringify(body)}`);
  assert.equal((await api('/api/providers/a', { app: 'zcode', name: 'must not change' }, 'PUT')).status, 400);
  assert.equal(channel('a').name, 'Anthropic channel');
  assert.equal((await api('/api/routes', { rules: [{ app: 'zcode' }] }, 'PUT')).status, 400);
  assert.equal((await api('/api/routes', { rules: [], default: { app: 'typo' } }, 'PUT')).status, 400);
  assert.equal(fs.existsSync(CONFIG), false);
  const created = await api('/api/providers', { app: 'claude', name: 'disabled', base_url: base, models: ['disabled-new'], enabled: false });
  assert.equal(created.status, 200); assert.equal(channel(created.data.id).enabled, false);
  assert.deepEqual(mod._state.current, { claude: 'old-claude', codex: 'old-codex', zcode: null });
});

test('omitted app retains legacy switch; provider deletion clears only associated client pointers', async () => {
  await switched('a');
  assert.equal((await api('/api/switch/r')).status, 200);
  assert.equal(mod._state.current.codex, 'r'); assert.equal(mod._state.current.zcode, 'a');
  assert.equal((await api('/api/switch/a')).status, 200);
  assert.equal(mod._state.current.claude, 'a');
  assert.equal((await api('/api/providers/a', undefined, 'DELETE')).status, 200);
  assert.deepEqual(mod._state.current, { claude: null, codex: 'r', zcode: null });
  assert.equal(mod.liveZcodeState().match, false);
});

test('base normalization preserves custom prefixes and rejects embedded secrets', () => {
  for (const wire of ['anthropic', 'responses', 'chat']) {
    const expected = wire === 'anthropic' ? 'https://example.test/gateway' : 'https://example.test/gateway/v1';
    for (const suffix of ['', '/', '/v1', '/v1/']) assert.equal(zc.baseURL('https://example.test/gateway' + suffix, wire), expected);
    assert.throws(() => zc.baseURL('https://user:secret@example.test', wire));
    assert.throws(() => zc.baseURL('https://example.test?key=secret', wire));
  }
  for (const pathname of ['/gateway', '/gateway/', '/gateway/v1', '/gateway/v1/']) {
    for (const endpoint of ['/v1/messages', '/v1/messages/count_tokens', '/v1/responses', '/v1/chat/completions'])
      assert.equal(mod.joinUpstreamPath(pathname, endpoint), '/gateway' + endpoint);
  }
});
