'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-split-'));
process.env.MIXR_DATA_DIR = tmp;
process.env.MIXR_CLAUDE_SETTINGS = path.join(tmp, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(tmp, 'config.toml');
const mod = require('../mixrouter');
const call = (port, route, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST',
    headers: { 'content-type': 'application/json', ...headers } }, res => {
    let text = ''; res.on('data', c => text += c);
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject); req.end(JSON.stringify(body));
});

test('双路配置:两协议完整 SSE、独立密钥、子代理热切换、重载不回放旧备份', async t => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let text = ''; req.on('data', c => text += c);
    req.on('end', () => {
      const body = JSON.parse(text);
      hits.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (req.url === '/v1/responses') {
        event({ type: 'response.created', response: { id: 'resp_split', model: body.model } });
        event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_split' } });
        event({ type: 'response.output_text.delta', delta: 'ASTRA' });
        event({ type: 'response.output_item.done', item: { type: 'message' } });
        event({ type: 'response.completed', response: { id: 'resp_split', status: 'completed', model: body.model, usage: { input_tokens: 1, output_tokens: 1 } } });
      } else {
        event({ type: 'message_start', message: { id: 'msg_ds', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DEEPSEEK' } });
        event({ type: 'content_block_stop', index: 0 });
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
        event({ type: 'message_stop' });
      }
      res.end();
    });
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  const ui = await mod.listen(0, mod.apiHandler);
  const proxy = await mod.listen(0, mod.proxyHandler);
  t.after(async () => {
    await Promise.all([upstream, ui, proxy].map(s => new Promise(ok => s.close(ok))));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  mod._state.store = { claude: [
    { id: 'ds', name: 'DeepSeek', base_url: base, api_key: 'secret-ds', models: ['deepseek-v4-flash'], enabled: true },
    { id: 'astra-a', name: 'Astra A', base_url: base, api_key: 'secret-a', models: ['gpt-6-astra'], wire_api: 'responses', enabled: true },
    { id: 'astra-b', name: 'Astra B', base_url: base, api_key: 'secret-b', models: ['gpt-6-astra'], wire_api: 'responses', enabled: true },
    { id: 'disabled', enabled: false },
  ], codex: [] };
  mod._state.slotMap = { claude: {}, codex: { worker: { provider: 'untouched' } } };
  mod._state.routes = { rules: [], default: {} };
  fs.writeFileSync(process.env.MIXR_CLAUDE_SETTINGS, JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'old-model' }, permissions: { allow: ['Read'] } }));
  const original = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  const post = b => call(ui.address().port, '/api/claude/split', b);
  const main = { provider: 'ds', model: 'deepseek-v4-flash[1M]' };
  const subagent = { provider: 'astra-a', model: 'gpt-6-astra[1M]' };
  for (const bad of [{ subagent }, { main, subagent: { provider: 'disabled', model: 'x' } }, { main, subagent, apply: 'true' }, { main, subagent: { provider: 'ds' } }]) {
    assert.equal((await post(bad)).status, 400);
    assert.deepEqual(mod._state.slotMap.claude, {});
  }
  let r = await post({ main, subagent });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), original);
  assert.equal(r.text.includes('secret-'), false);
  assert.deepEqual(mod._state.slotMap.codex, { worker: { provider: 'untouched' } });
  r = await post({ main, subagent, apply: true });
  assert.equal(r.status, 200);
  const live = JSON.parse(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'));
  assert.deepEqual(live.permissions, { allow: ['Read'] });
  for (const [name, key] of Object.entries(mod.CLAUDE_SLOT_ENV)) assert.equal(live.env[key], `mixr-${name}`);
  const requestSlot = model => call(proxy.address().port, '/v1/messages', {
    model, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }],
  }, { authorization: 'Bearer PROXY_MANAGED', 'x-api-key': 'client-not-upstream', 'x-claude-code-session-id': 'same-session' });
  for (const name of ['main', 'opus', 'sonnet', 'fable', 'haiku', 'subagent']) {
    r = await requestSlot(`mixr-${name}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /event: message_stop/);
    const hit = hits.at(-1);
    const isSub = name === 'subagent';
    assert.equal(hit.url, isSub ? '/v1/responses' : '/v1/messages');
    assert.equal(hit.body.model, isSub ? 'gpt-6-astra' : 'deepseek-v4-flash');
    assert.equal(hit.headers.authorization, `Bearer ${isSub ? 'secret-a' : 'secret-ds'}`);
    assert.notEqual(hit.headers['x-api-key'], 'client-not-upstream');
    if (isSub) {
      assert.deepEqual(hit.body.include, ['reasoning.encrypted_content']);
      assert.ok(hit.body.prompt_cache_key);
      assert.match(r.text, /ASTRA/);
    } else assert.match(r.text, /DEEPSEEK/);
  }
  const before = JSON.parse(JSON.stringify(mod._state.slotMap.claude));
  const liveBefore = fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8');
  assert.equal((await post({ subagent: { ...subagent, provider: 'astra-b' } })).status, 200);
  for (const name of Object.keys(before).filter(n => n !== 'subagent')) assert.deepEqual(mod._state.slotMap.claude[name], before[name]);
  await requestSlot('mixr-subagent');
  assert.equal(hits.at(-1).headers.authorization, 'Bearer secret-b');
  await requestSlot('mixr-main');
  assert.equal(hits.at(-1).headers.authorization, 'Bearer secret-ds');
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), liveBefore);
  const child = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(path.resolve(__dirname, '../mixrouter.js'))});
    console.log(JSON.stringify({main:m.resolveSlot('claude','mixr-main').provider.id, sub:m.resolveSlot('claude','mixr-subagent').provider.id}));
  `], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { main: 'ds', sub: 'astra-b' });
  assert.equal(fs.readFileSync(process.env.MIXR_CLAUDE_SETTINGS, 'utf8'), liveBefore);
  assert.ok(fs.readdirSync(tmp).some(f => f.includes('.bak-mixui-')));
});
