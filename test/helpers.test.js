'use strict';
// 纯函数单测:模型改写 / beta 头 / header 消洗 / usage 抽取 / key 脱敏 / TOML 转义 / 路由解析
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离运行时数据目录,避免读到(更不能写到)仓库里的真实配置
process.env.MIXR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-helpers-'));
const {
  VERSION, resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr, validBaseUrl, _state,
} = require('../mixrouter.js');

test('applyModel 无 [1M] 后缀时原样返回且不动 headers', () => {
  const headers = {};
  assert.strictEqual(applyModel('claude-opus-5', headers), 'claude-opus-5');
  assert.strictEqual(headers['anthropic-beta'], undefined);
});

test('applyModel 剥离 [1M] 后缀并追加 context-1m beta 头', () => {
  const headers = {};
  assert.strictEqual(applyModel('Claude-Opus-5[1m]', headers), 'Claude-Opus-5');
  assert.strictEqual(headers['anthropic-beta'], 'context-1m-2025-08-07');
});

test('applyModel 已有 beta 头时合并且不重复', () => {
  const h1 = { 'anthropic-beta': 'other-beta' };
  applyModel('m[1M]', h1);
  assert.strictEqual(h1['anthropic-beta'], 'other-beta,context-1m-2025-08-07');
  const h2 = { 'anthropic-beta': 'context-1m-2025-08-07,x' };
  applyModel('m[1M]', h2);
  assert.strictEqual(h2['anthropic-beta'], 'context-1m-2025-08-07,x');
});

test('safeHeader 消洗非 ASCII 并 trim,空值返回空串', () => {
  assert.strictEqual(safeHeader('  渠道①名 ok '), 'ok');
  assert.strictEqual(safeHeader('claude-cli/1.0'), 'claude-cli/1.0');
  assert.strictEqual(safeHeader(null), '');
  assert.strictEqual(safeHeader(undefined), '');
});

test('extractUsage 从非流式 JSON 抽取 usage', () => {
  const u = extractUsage(JSON.stringify({ usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 } }));
  assert.deepStrictEqual(u, { in: 11, out: 7, cache_read: 3 });
});

test('extractUsage 从 SSE 累积文本抽取:输入取 message_start,输出取 message_delta', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":17,"cache_read_input_tokens":5}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":9}}',
    '',
  ].join('\n');
  const u = extractUsage(sse);
  assert.deepStrictEqual(u, { in: 17, out: 9, cache_read: 5 });
});

test('extractUsage 无 usage 时返回零值', () => {
  assert.deepStrictEqual(extractUsage('nothing here'), { in: 0, out: 0, cache_read: 0 });
});

test('maskKey 长 key 掐头去尾,短 key 全掩码', () => {
  assert.strictEqual(maskKey('sk-abcdefghijklmnop'), 'sk-abc…mnop');
  assert.strictEqual(maskKey('short'), '***');
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey(undefined), '');
});

test('tomlStr 转义反斜杠与双引号', () => {
  assert.strictEqual(tomlStr('a"b\\c'), '"a\\"b\\\\c"');
  assert.strictEqual(tomlStr(null), '""');
});

test('resolveRoute 首个启用且命中的规则生效,大小写不敏感', () => {
  _state.store = { claude: [{ id: 'p1' }, { id: 'p2' }], codex: [] };
  _state.routes = { rules: [
    { id: 'r1', match: 'opus, claude-3-opus', provider: 'p1', model: 'routed-opus', enabled: false },
    { id: 'r2', match: 'opus', provider: 'p2', model: '', enabled: true },
  ], default: { provider: '', model: '' } };
  const r = resolveRoute('Claude-OPUS-5');
  assert.strictEqual(r.rule.id, 'r2');          // r1 停用被跳过
  assert.strictEqual(r.provider.id, 'p2');
  assert.strictEqual(r.model, 'Claude-OPUS-5'); // r.model 为空 → 透传请求模型
});

test('resolveRoute 规则指向不存在的渠道时 provider 为 null', () => {
  _state.routes = { rules: [{ id: 'r1', match: 'opus', provider: 'ghost', model: '', enabled: true }], default: { provider: '', model: '' } };
  const r = resolveRoute('claude-opus-5');
  assert.strictEqual(r.rule.id, 'r1');
  assert.strictEqual(r.provider, null);
});

test('resolveRoute 无命中时走 default,可覆盖模型', () => {
  _state.routes = { rules: [{ id: 'r1', match: 'opus', provider: 'p1', model: '', enabled: true }],
    default: { provider: 'p2', model: 'fallback-model' } };
  const r = resolveRoute('claude-sonnet-5');
  assert.strictEqual(r.rule, null);
  assert.strictEqual(r.provider.id, 'p2');
  assert.strictEqual(r.model, 'fallback-model');
});

test('resolveRoute when.body 内容分流:先于普通规则,不限模型也能命中', () => {
  _state.store = { claude: [{ id: 'p1' }, { id: 'p2' }], codex: [] };
  _state.routes = { rules: [
    { id: 'r1', match: 'main', provider: 'p1', model: 'normal-model', enabled: true },
    { id: 'r2', match: '', provider: 'p2', model: 'sol-model', when: { body: 'detailed summary of the conversation' }, enabled: true },
  ], default: { provider: '', model: '' } };
  const hit = resolveRoute('mixr-main', { bodyText: () => 'x create a detailed summary of the conversation so far y' });
  assert.strictEqual(hit.rule.id, 'r2');
  assert.strictEqual(hit.provider.id, 'p2');
  assert.strictEqual(hit.model, 'sol-model');
  assert.strictEqual(hit.content, true);
  // 请求体没那段文本 → 内容规则不命中,照走普通规则
  const miss = resolveRoute('mixr-main', { bodyText: () => 'a normal turn' });
  assert.strictEqual(miss.rule.id, 'r1');
  assert.strictEqual(miss.content, undefined);
  // match 有值时按模型名限定:换个模型名就不再命中这条内容规则
  _state.routes = { rules: [
    { id: 'r3', match: 'mixr-main', provider: 'p2', model: 'limited-model', when: { body: 'detailed summary' }, enabled: true },
  ], default: { provider: 'p1', model: 'fallback' } };
  assert.strictEqual(resolveRoute('mixr-main', { bodyText: () => 'detailed summary' }).rule.id, 'r3');
  assert.strictEqual(resolveRoute('mixr-haiku', { bodyText: () => 'detailed summary' }).rule, null);
});

test('resolveRoute when.body 支持主备池且保留策略', () => {
  _state.store = { claude: [{ id: 'p1' }, { id: 'p2' }], codex: [] };
  _state.routes = { rules: [
    { id: 'r1', match: '', strategy: 'priority', when: { body: 'summary of the conversation' }, enabled: true,
      pool: [{ provider: 'p1', model: 'primary' }, { provider: 'p2', model: 'backup' }] },
  ], default: { provider: '', model: '' } };
  const hit = resolveRoute('anything', { bodyText: () => 'summary of the conversation' });
  assert.strictEqual(hit.content, true);
  assert.strictEqual(hit.strategy, 'priority');
  assert.deepStrictEqual(hit.members.map(m => [m.provider.id, m.model]), [['p1', 'primary'], ['p2', 'backup']]);
});

test('validBaseUrl 只收 http(s) URL', () => {
  assert.strictEqual(validBaseUrl('https://api.example.com'), true);
  assert.strictEqual(validBaseUrl('http://127.0.0.1:8787'), true);
  assert.strictEqual(validBaseUrl('not-a-url'), false);
  assert.strictEqual(validBaseUrl('ftp://x.example.com'), false);
  assert.strictEqual(validBaseUrl('javascript:alert(1)'), false);
  assert.strictEqual(validBaseUrl(''), false);
  assert.strictEqual(validBaseUrl(null), false);
});

test('导出的 VERSION 与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(VERSION, pkg.version);
});

test('priority 主备策略:永远取池序第一个可用渠道,主冷却才降级', () => {
  const { pickMember, markCooldown } = require('../mixrouter.js');
  const rule = { id: 't-pri', strategy: 'priority', pool: [] };
  const pa = { id: 'pa', name: '主', base_url: 'https://a.example', enabled: true };
  const pb = { id: 'pb', name: '备', base_url: 'https://b.example', enabled: true };
  const members = [{ provider: pa, model: 'm1', weight: 1 }, { provider: pb, model: 'm2', weight: 1 }];
  assert.strictEqual(pickMember(rule, members, 'k1').provider.id, 'pa');
  assert.strictEqual(pickMember(rule, members, 'k2').provider.id, 'pa', '不做轮询,始终主渠道');
  markCooldown('pa', 500);
  assert.strictEqual(pickMember(rule, members, 'k3').provider.id, 'pb', '主冷却中 → 备渠道');
  assert.strictEqual(pickMember(rule, members, 'k4').provider.id, 'pb');
  // 全冷却时回到池序首位(现有兜底语义)
  markCooldown('pb', 500);
  assert.strictEqual(pickMember(rule, members, 'k5').provider.id, 'pa');
  // 未知策略回落轮询,不受影响
  const rr = pickMember({ id: 't-rr', strategy: 'bogus', pool: [] }, members, 'k6');
  assert.ok([pa, pb].some(p => p.id === rr.provider.id));
});
