'use strict';
// 客户端配置切换测试:真实配置经环境变量重定向到临时目录,验证写入内容、
// 备份保留、既有键不动、mixr-* section 幂等替换、用户自己的 section 不碰
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-switch-'));
const CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
const CODEX_CONFIG = path.join(TMP, 'config.toml');
process.env.MIXR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-switch-data-'));
process.env.MIXR_CLAUDE_SETTINGS = CLAUDE_SETTINGS;
process.env.MIXR_CODEX_CONFIG = CODEX_CONFIG;

fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({
  permissions: { allow: ['Bash(ls:*)'] },
  env: { ANTHROPIC_MODEL: 'keep-model', CUSTOM_KEY: 'keep-me' },
}, null, 2) + '\n');
fs.writeFileSync(CODEX_CONFIG, [
  'model = "gpt-5"',
  'model_provider = "old-provider"',
  '',
  '# 用户自己的配置',
  '[model_providers.custom]',
  'name = "user-provider"',
  'base_url = "https://user.example.com"',
  '',
].join('\n'));

const { switchClaude, switchCodex, liveState } = require('../mixrouter.js');

const CLAUDE_CHANNEL = {
  id: 'p1', name: '测试-渠道"引号"\\反斜杠', base_url: 'http://127.0.0.1:8787', api_key: 'sk-test-claude',
  models: ['claude-opus-5'], slots: { opus: 'slot-opus', sonnet: '', haiku: '' },
};
const CODEX_CHANNEL = {
  id: 'c1', name: '测试 Codex', base_url: 'http://127.0.0.1:9/', api_key: 'sk-test-codex', model: 'gpt-5-codex', wire_api: 'responses',
};

test('switchClaude 写入 ANTHROPIC_* 且保留既有键、生成备份、权限 0600', () => {
  switchClaude(CLAUDE_CHANNEL);
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  assert.strictEqual(cfg.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
  assert.strictEqual(cfg.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-claude');
  assert.strictEqual(cfg.env.ANTHROPIC_MODEL, 'claude-opus-5');        // models[0] 覆盖
  assert.strictEqual(cfg.env.CUSTOM_KEY, 'keep-me');                    // 无关键保留
  assert.deepStrictEqual(cfg.permissions, { allow: ['Bash(ls:*)'] });   // env 之外的整块保留
  assert.strictEqual((fs.statSync(CLAUDE_SETTINGS).mode & 0o777), 0o600);
  const dir = fs.readdirSync(TMP).filter(f => f.startsWith('settings.json.bak-mixui-'));
  assert.strictEqual(dir.length, 1);                                    // 切换前有备份
});

test('switchClaude 槽位模型只写非空槽,空槽保留现状', () => {
  switchClaude(CLAUDE_CHANNEL);
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  assert.strictEqual(cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'slot-opus');
  assert.strictEqual(cfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
});

test('switchCodex 全新文件:写顶层 model/model_provider 与 mixr-* section', () => {
  switchCodex(CODEX_CHANNEL);
  const text = fs.readFileSync(CODEX_CONFIG, 'utf8');
  assert.ok(text.includes('model = "gpt-5-codex"'));
  assert.ok(text.includes('model_provider = "mixr-c1"'));
  assert.ok(text.includes('[model_providers.mixr-c1]'));
  assert.ok(text.includes('experimental_bearer_token = "sk-test-codex"'));
  assert.ok(text.includes('wire_api = "responses"'));
  assert.strictEqual((fs.statSync(CODEX_CONFIG).mode & 0o777), 0o600);
});

test('switchCodex 二次切换:mixr-* 幂等替换,用户 section 原样保留', () => {
  const before = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const norm = s => s.match(/\[model_providers\.custom\][^[]*/)[0].replace(/\n+$/, '\n');
  const customBefore = norm(before);
  const ch2 = { ...CODEX_CHANNEL, id: 'c2', model: 'gpt-5.1' };
  switchCodex(ch2);
  const text = fs.readFileSync(CODEX_CONFIG, 'utf8');
  assert.strictEqual(text.match(/\[model_providers\.mixr-/g).length, 1); // 旧 mixr-c1 整段移除
  assert.ok(text.includes('[model_providers.mixr-c2]'));
  assert.ok(!text.includes('mixr-c1'));
  assert.strictEqual(norm(text), customBefore); // 用户段内容一字不动(分隔空行归一化)
  assert.ok(text.includes('model = "gpt-5.1"'));
  assert.strictEqual(text.match(/^model\s*=/gm).length, 1);               // 顶层 model 原位替换不重复
  assert.strictEqual(text.match(/^model_provider\s*=/gm).length, 1);
});

test('switchCodex TOML 基本字符串转义渠道名', () => {
  switchCodex({ ...CODEX_CHANNEL, id: 'c3', name: '含"引号"和\\反斜杠' });
  const text = fs.readFileSync(CODEX_CONFIG, 'utf8');
  assert.ok(text.includes('name = "含\\"引号\\"和\\\\反斜杠"'));
});

test('liveState:切换后 match 为 true,人工改动后漂移为 false', () => {
  switchClaude(CLAUDE_CHANNEL);
  switchCodex(CODEX_CHANNEL); // 上面用例把配置切到了 c2/c3,这里切回 c1 使文件与指针一致
  const mod = require('../mixrouter.js');
  mod._state.store = { claude: [CLAUDE_CHANNEL], codex: [CODEX_CHANNEL] };
  mod._state.current = { claude: 'p1', codex: 'c1' };
  const live = liveState();
  assert.strictEqual(live.claude.match, true);
  assert.strictEqual(live.codex.match, true);
  // 人工改动 base_url → 漂移
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  cfg.env.ANTHROPIC_BASE_URL = 'http://drifted.example.com';
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg));
  assert.strictEqual(liveState().claude.match, false);
});
