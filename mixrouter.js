#!/usr/bin/env node
// ============================================================================
// mixrouter v2.1 — 本地模型路由器 + cc-switch 式客户端配置切换
//   :8787  代理端口  Anthropic 协议 /v1/messages,按路由规则改写模型转发到渠道
//   :8788  控制台   渠道(Claude Code / Codex 两组,自由增删改 + 一键切换)/ 路由 / 日志
// 零依赖,Node >= 18。数据文件:providers.json、routes.json
// ============================================================================
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '2.1.0';
const ROOT = __dirname;
// 运行时数据(providers/routes/logs)目录可整体重定向(MIXR_DATA_DIR),测试用,避免碰真实配置
const DATA_DIR = process.env.MIXR_DATA_DIR || ROOT;
const PROXY_PORT = Number(process.env.MIXROUTER_PORT || 8787);
const UI_PORT = Number(process.env.MIXUI_PORT || 8788);
const HOST = '127.0.0.1';
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const ROUTES_FILE = path.join(DATA_DIR, 'routes.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'requests.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BODY_LIMIT = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600 * 1000;
const TEST_TIMEOUT_MS = 15 * 1000;
const BETA_1M = 'context-1m-2025-08-07';
// agentrouter 等网关校验 UA 形态,裸 curl 一律 401;客户端没带 UA 时用它兜底
const DEFAULT_UA = 'claude-cli/2.1.219 (external, cli)';
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const RING_SIZE = 500;
const BACKUP_KEEP = 5;
// 客户端真实配置(测试时可用环境变量重定向到临时目录)
const CLAUDE_SETTINGS = process.env.MIXR_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_CONFIG = process.env.MIXR_CODEX_CONFIG || path.join(os.homedir(), '.codex', 'config.toml');

// ---------------------------------------------------------------- 配置存取
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
// 渠道库:按应用分组。兼容 v2.0 的裸数组格式
function loadStore() {
  const raw = loadJson(PROVIDERS_FILE, null);
  if (Array.isArray(raw)) return { claude: raw, codex: [] };
  return { claude: (raw && raw.claude) || [], codex: (raw && raw.codex) || [] };
}
let store = loadStore();
let current = { claude: null, codex: null };
{ const raw = loadJson(PROVIDERS_FILE, null); if (raw && raw.current) current = { ...current, ...raw.current }; }

const saveStore = () => saveJson(PROVIDERS_FILE, { version: 2, current, claude: store.claude, codex: store.codex });
const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);

const defaultRoutes = () => ({
  rules: [
    { id: 'r1', match: 'opus, claude-3-opus', provider: '', model: '', enabled: true },
    { id: 'r2', match: 'sonnet',              provider: '', model: '', enabled: true },
    { id: 'r3', match: 'haiku',               provider: '', model: '', enabled: true },
    { id: 'r4', match: 'fable',               provider: '', model: '', enabled: true },
  ],
  default: { provider: '', model: '' },
});
let routes = loadJson(ROUTES_FILE, null);
if (!routes || !Array.isArray(routes.rules)) routes = defaultRoutes();
const saveRoutes = () => saveJson(ROUTES_FILE, routes);

// ---------------------------------------------------------------- 请求日志
const ring = [];
function logRequest(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_ROTATE_BYTES) {
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}
function todayStats() {
  const d = new Date(); const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  let reqs = 0, inTok = 0, outTok = 0;
  for (const e of ring) {
    const ed = new Date(e.ts); const eday = `${ed.getFullYear()}-${ed.getMonth() + 1}-${ed.getDate()}`;
    if (eday !== day) continue;
    reqs++; inTok += e.in || 0; outTok += e.out || 0;
  }
  return { reqs, inTok, outTok };
}

// ---------------------------------------------------------------- 路由解析
// match 为请求模型名的子串,逗号分隔多个,大小写不敏感;规则从上到下首个启用者生效
// 路由目标只能是 Claude Code 组的渠道(代理只说 Anthropic 协议)
function resolveRoute(modelIn) {
  const m = String(modelIn || '').toLowerCase();
  for (const r of routes.rules) {
    if (!r.enabled) continue;
    const hits = String(r.match || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (hits.length && hits.some(h => m.includes(h))) {
      return { rule: r, provider: store.claude.find(p => p.id === r.provider) || null, model: r.model || modelIn };
    }
  }
  return { rule: null, provider: store.claude.find(p => p.id === routes.default.provider) || null, model: routes.default.model || modelIn };
}

// 目标模型带 [1M] 后缀 → 去掉后缀并追加 1M beta 头
function applyModel(targetModel, headers) {
  let model = String(targetModel || '');
  if (/\[1m\]$/i.test(model)) {
    model = model.replace(/\[1m\]$/i, '');
    const beta = headers['anthropic-beta'];
    headers['anthropic-beta'] = beta ? (beta.includes(BETA_1M) ? beta : beta + ',' + BETA_1M) : BETA_1M;
  }
  return model;
}

function anthropicError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// HTTP 头只允许 latin-1:渠道名等注入头之前消洗掉非 ASCII,避免 ERR_INVALID_CHAR 打崩进程
const safeHeader = s => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim();

// 从 SSE/JSON 响应文本里尽力抠 usage(输入来自 message_start,输出来自 message_delta)
function extractUsage(text) {
  const u = { in: 0, out: 0, cache_read: 0 };
  const input = text.match(/"input_tokens"\s*:\s*(\d+)/); if (input) u.in = Number(input[1]);
  const out = text.match(/"output_tokens"\s*:\s*(\d+)/); if (out) u.out = Number(out[1]);
  const cr = text.match(/"cache_read_input_tokens"\s*:\s*(\d+)/); if (cr) u.cache_read = Number(cr[1]);
  return u;
}

// ---------------------------------------------------------------- 代理服务
function proxyHandler(req, res) {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'mixrouter', version: VERSION }));
  }
  const isMessages = req.method === 'POST' && /^\/v1\/messages\/?$/.test(req.url.split('?')[0]);
  const isCount = req.method === 'POST' && /^\/v1\/messages\/count_tokens\/?$/.test(req.url.split('?')[0]);
  if (!isMessages && !isCount) return anthropicError(res, 404, 'not_found_error', `mixrouter 只支持 POST /v1/messages (与 count_tokens),收到 ${req.method} ${req.url}`);

  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > BODY_LIMIT) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return anthropicError(res, 400, 'invalid_request_error', '请求体不是合法 JSON'); }

    const modelIn = body.model || '';
    const { provider, model: rawTarget } = resolveRoute(modelIn);
    if (!provider) return anthropicError(res, 503, 'api_error', `模型 "${modelIn}" 没有匹配的路由,或路由未绑定 Claude 渠道。请在控制台 http://127.0.0.1:${UI_PORT} 配置路由`);
    if (provider.enabled === false) return anthropicError(res, 503, 'api_error', `路由命中的渠道 "${provider.name}" 已停用`);

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': provider.api_key,
      'Authorization': 'Bearer ' + provider.api_key,
      'User-Agent': safeHeader(req.headers['user-agent']) || DEFAULT_UA,
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    const model = applyModel(rawTarget, headers);
    const outBody = JSON.stringify({ ...body, model });

    const started = Date.now();
    const entry = { ts: new Date().toISOString(), provider: provider.name, model_in: modelIn, model_out: model,
      in: 0, out: 0, cache_read: 0, ms: 0, status: 0, stream: !!body.stream, kind: isCount ? 'count_tokens' : 'messages', err: '' };

    const upstream = new URL(provider.base_url);
    const transport = upstream.protocol === 'https:' ? https : http;
    const creq = transport.request({
      protocol: upstream.protocol, hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: upstream.pathname.replace(/\/+$/, '') + (isCount ? '/v1/messages/count_tokens' : '/v1/messages'),
      method: 'POST', headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, cres => {
      entry.status = cres.statusCode;
      res.writeHead(cres.statusCode, {
        'Content-Type': cres.headers['content-type'] || 'application/json',
        'x-mixrouter-provider': safeHeader(provider.name),
        'x-mixrouter-model': safeHeader(model),
      });
      if (entry.stream && cres.headers['content-type'] && cres.headers['content-type'].includes('text/event-stream')) {
        let acc = '';
        cres.on('data', c => { if (acc.length < 1024 * 1024) acc += c.toString('utf8'); res.write(c); });
        cres.on('end', () => {
          entry.ms = Date.now() - started;
          const u = extractUsage(acc); entry.in = u.in; entry.out = u.out; entry.cache_read = u.cache_read;
          logRequest(entry); res.end();
        });
      } else {
        const parts = [];
        cres.on('data', c => { parts.push(c); res.write(c); });
        cres.on('end', () => {
          entry.ms = Date.now() - started;
          const text = Buffer.concat(parts).toString('utf8');
          const u = extractUsage(text); entry.in = u.in; entry.out = u.out; entry.cache_read = u.cache_read;
          if (isCount) entry.in = Number((text.match(/"input_tokens"\s*:\s*(\d+)/) || [0, 0])[1]);
          logRequest(entry); res.end();
        });
      }
    });
    creq.on('timeout', () => { entry.err = 'upstream timeout'; creq.destroy(new Error('timeout')); });
    creq.on('error', e => {
      entry.ms = Date.now() - started; entry.err = e.message; logRequest(entry);
      if (!res.headersSent) anthropicError(res, 502, 'api_error', `上游 ${provider.name} 请求失败: ${e.message}`);
      else res.end();
    });
    creq.end(outBody);
  });
}

// ---------------------------------------------------------------- 客户端配置切换(cc-switch 式)
function backupFile(file) {
  if (!fs.existsSync(file)) return;
  const ts = new Date(); const z = n => String(n).padStart(2, '0');
  const bak = `${file}.bak-mixui-${ts.getFullYear()}${z(ts.getMonth() + 1)}${z(ts.getDate())}-${z(ts.getHours())}${z(ts.getMinutes())}${z(ts.getSeconds())}`;
  fs.copyFileSync(file, bak);
  const dir = path.dirname(file); const base = path.basename(file);
  const olds = fs.readdirSync(dir).filter(f => f.startsWith(base + '.bak-mixui-')).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
}

function switchClaude(p) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}
  backupFile(CLAUDE_SETTINGS);
  cfg.env = cfg.env || {};
  cfg.env.ANTHROPIC_BASE_URL = p.base_url;
  cfg.env.ANTHROPIC_AUTH_TOKEN = p.api_key;
  if (p.models && p.models[0]) cfg.env.ANTHROPIC_MODEL = p.models[0];
  // 槽位模型:渠道里填了才写,没填保留现状(不清空用户已有值)
  if (p.slots) {
    if (p.slots.opus) cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL = p.slots.opus;
    if (p.slots.sonnet) cfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL = p.slots.sonnet;
    if (p.slots.haiku) cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = p.slots.haiku;
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  try { fs.chmodSync(CLAUDE_SETTINGS, 0o600); } catch {}
}

// TOML 基本字符串转义
const tomlStr = s => '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function switchCodex(p) {
  let text = '';
  try { text = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch {}
  backupFile(CODEX_CONFIG);
  const section = 'mixr-' + p.id;
  const lines = text.split('\n');

  // 1) 删掉我们以前写入的 mixr-* section(整段移除,用户自己的 section 一律不碰)
  const kept = []; let inMixr = false;
  for (const line of lines) {
    if (/^\s*\[model_providers\.mixr-/.test(line)) { inMixr = true; continue; }
    if (inMixr && /^\s*\[/.test(line)) inMixr = false;
    if (!inMixr) kept.push(line);
  }
  // 2) 顶层 model / model_provider 原位替换;没有就插到文件最前
  let sawSection = false, hasModel = false, hasProvider = false;
  const mainModel = p.model || (p.models && p.models[0]) || '';
  let out = kept.map(line => {
    if (/^\s*\[/.test(line)) sawSection = true;
    if (!sawSection && /^model\s*=/.test(line)) { hasModel = true; return `model = ${tomlStr(mainModel)}`; }
    if (!sawSection && /^model_provider\s*=/.test(line)) { hasProvider = true; return `model_provider = ${tomlStr(section)}`; }
    return line;
  });
  const head = [];
  if (!hasModel) head.push(`model = ${tomlStr(mainModel)}`);
  if (!hasProvider) head.push(`model_provider = ${tomlStr(section)}`);
  if (head.length) out = head.concat(out);
  // 3) 追加新 section(沿用本机已验证的 bearer-token 模式,不依赖 auth.json)
  out.push('', `[model_providers.${section}]`,
    `name = ${tomlStr(p.name)}`,
    `base_url = ${tomlStr(p.base_url)}`,
    `wire_api = ${tomlStr(p.wire_api || 'responses')}`,
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlStr(p.api_key)}`);
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG, out.join('\n').replace(/\n{3,}$/, '\n\n'));
  try { fs.chmodSync(CODEX_CONFIG, 0o600); } catch {}
}

// 读取客户端当前实际生效的上游(与渠道库比对,给 UI 显示"配置漂移"用)
function liveState() {
  const live = {};
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}
  const env = cfg.env || {};
  const claudeBase = env.ANTHROPIC_BASE_URL || '';
  const curClaude = current.claude ? findProvider(current.claude) : null;
  live.claude = { base_url: claudeBase, model: env.ANTHROPIC_MODEL || '',
    match: !!(curClaude && curClaude.base_url === claudeBase && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')) };

  let text = ''; try { text = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch {}
  const lines = text.split('\n');
  let provider = '', model = '', sawSection = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) { sawSection = true; continue; }
    if (!sawSection) {
      let m = line.match(/^model_provider\s*=\s*"([^"]*)"/); if (m) provider = m[1];
      m = line.match(/^model\s*=\s*"([^"]*)"/); if (m) model = m[1];
    }
  }
  let base = '', wire = '';
  const sec = text.match(new RegExp(`\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\[]*`));
  if (sec) { const b = sec[0].match(/base_url\s*=\s*"([^"]*)"/); base = b ? b[1] : ''; const w = sec[0].match(/wire_api\s*=\s*"([^"]*)"/); wire = w ? w[1] : ''; }
  const curCodex = current.codex ? findProvider(current.codex) : null;
  live.codex = { provider, model, base_url: base, wire_api: wire,
    match: !!(curCodex && provider === 'mixr-' + curCodex.id && curCodex.api_key && sec && sec[0].includes(tomlStr(curCodex.api_key))) };
  return live;
}

// ---------------------------------------------------------------- 渠道连通性测试
function testProvider(p) {
  if (!p.api_key) return Promise.resolve({ ok: false, error: '未配置 API Key' });
  const u = new URL(p.base_url);
  if (p.wire_api) { // codex(OpenAI 系):免费探活 GET <base>/models
    return new Promise(resolve => {
      const transport = u.protocol === 'https:' ? https : http;
      const creq = transport.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname.replace(/\/+$/, '') + '/models', method: 'GET', timeout: TEST_TIMEOUT_MS,
        headers: { 'Authorization': 'Bearer ' + p.api_key, 'User-Agent': DEFAULT_UA },
      }, cres => {
        const cs = []; cres.on('data', c => { if (cs.length < 64) cs.push(c); });
        cres.on('end', () => resolve({ ok: cres.statusCode >= 200 && cres.statusCode < 300, status: cres.statusCode,
          body: Buffer.concat(cs).toString('utf8').slice(0, 300) }));
      });
      creq.on('timeout', () => creq.destroy(new Error('timeout')));
      creq.on('error', e => resolve({ ok: false, error: e.message }));
      creq.end();
    });
  }
  // claude(Anthropic 系):最小 messages 请求
  const model = applyModel(p.models[0] || 'claude-opus-5', {});
  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  return new Promise(resolve => {
    const transport = u.protocol === 'https:' ? https : http;
    const creq = transport.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname.replace(/\/+$/, '') + '/v1/messages', method: 'POST', timeout: TEST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-api-key': p.api_key, 'Authorization': 'Bearer ' + p.api_key,
        'User-Agent': DEFAULT_UA, 'anthropic-version': '2023-06-01' },
    }, cres => {
      const cs = []; cres.on('data', c => { if (cs.length < 64) cs.push(c); });
      cres.on('end', () => resolve({ ok: cres.statusCode >= 200 && cres.statusCode < 300, status: cres.statusCode,
        body: Buffer.concat(cs).toString('utf8').slice(0, 300) }));
    });
    creq.on('timeout', () => creq.destroy(new Error('timeout')));
    creq.on('error', e => resolve({ ok: false, error: e.message }));
    creq.end(body);
  }).then(r => ({ ...r, model }));
}

// ---------------------------------------------------------------- 控制台
function maskKey(k) {
  if (!k) return '';
  return k.length > 12 ? k.slice(0, 6) + '…' + k.slice(-4) : '***';
}
function publicProvider(p) {
  const { api_key, ...rest } = p;
  return { ...rest, key_masked: maskKey(api_key), has_key: !!api_key };
}

function apiHandler(req, res) {
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
  const url = new URL(req.url, `http://${HOST}:${UI_PORT}`);
  const p = url.pathname;
  const readBody = () => new Promise((ok, bad) => {
    const cs = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > BODY_LIMIT) { req.destroy(); return bad(new Error('too large')); } cs.push(c); });
    req.on('end', () => ok(Buffer.concat(cs).toString('utf8')));
    req.on('error', bad);
  });

  Promise.resolve().then(async () => {
    // ---- 状态
    if (req.method === 'GET' && p === '/api/state') {
      return send(200, {
        version: VERSION, proxy_port: PROXY_PORT, ui_port: UI_PORT,
        uptime_s: Math.floor(process.uptime()), pid: process.pid,
        stats: todayStats(),
        providers: { claude: store.claude.map(publicProvider), codex: store.codex.map(publicProvider) },
        current, live: liveState(), routes,
      });
    }
    // ---- 日志
    if (req.method === 'GET' && p === '/api/logs') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), RING_SIZE);
      return send(200, { logs: ring.slice(-limit).reverse() });
    }
    // ---- 渠道 CRUD(app = claude | codex)
    if (req.method === 'POST' && p === '/api/providers') {
      const b = JSON.parse((await readBody()) || '{}');
      const app = b.app === 'codex' ? 'codex' : 'claude';
      if (!b.name || !b.base_url) return send(400, { error: 'name 与 base_url 必填' });
      if (app === 'codex' && !b.model) return send(400, { error: 'Codex 渠道必须填模型名' });
      const id = (app === 'codex' ? 'c' : 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const prov = { id, name: String(b.name), base_url: String(b.base_url).replace(/\/+$/, ''),
        api_key: String(b.api_key || ''), enabled: true,
        note: String(b.note || ''), created_at: new Date().toISOString() };
      if (app === 'claude') {
        prov.models = Array.isArray(b.models) ? b.models : String(b.models || '').split(',').map(s => s.trim()).filter(Boolean);
        prov.slots = { opus: String(b.slots?.opus || ''), sonnet: String(b.slots?.sonnet || ''), haiku: String(b.slots?.haiku || '') };
        prov.ua = String(b.ua || '');
      } else {
        prov.model = String(b.model || '');
        prov.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
      }
      store[app].push(prov);
      saveStore();
      return send(200, { ok: true, id });
    }
    let m = p.match(/^\/api\/providers\/([^/]+)$/);
    if (m) {
      const prov = findProvider(m[1]);
      if (!prov) return send(404, { error: '渠道不存在' });
      if (req.method === 'PUT') {
        const b = JSON.parse((await readBody()) || '{}');
        if (b.name !== undefined) prov.name = String(b.name);
        if (b.base_url !== undefined) prov.base_url = String(b.base_url).replace(/\/+$/, '');
        if (b.api_key) prov.api_key = String(b.api_key);          // 留空 = 不改动
        if (b.enabled !== undefined) prov.enabled = !!b.enabled;
        if (b.note !== undefined) prov.note = String(b.note);
        if (providerApp(prov.id) === 'claude') {
          if (b.models !== undefined) prov.models = Array.isArray(b.models) ? b.models : String(b.models).split(',').map(s => s.trim()).filter(Boolean);
          if (b.slots !== undefined) prov.slots = { opus: String(b.slots.opus || ''), sonnet: String(b.slots.sonnet || ''), haiku: String(b.slots.haiku || '') };
          if (b.ua !== undefined) prov.ua = String(b.ua);
        } else {
          if (b.model !== undefined) prov.model = String(b.model);
          if (b.wire_api !== undefined) prov.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
        }
        saveStore();
        return send(200, { ok: true });
      }
      if (req.method === 'DELETE') {
        const app = providerApp(prov.id);
        store[app] = store[app].filter(x => x.id !== prov.id);
        if (current[app] === prov.id) current[app] = null;
        saveStore();
        return send(200, { ok: true });
      }
    }
    // ---- 连通性测试
    m = p.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (req.method === 'POST' && m) {
      const prov = findProvider(m[1]);
      if (!prov) return send(404, { error: '渠道不存在' });
      const started = Date.now();
      const result = await testProvider(prov);
      return send(200, { ...result, ms: Date.now() - started });
    }
    // ---- 切换客户端配置(cc-switch 核心动作)
    m = p.match(/^\/api\/switch\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const prov = findProvider(m[1]);
      if (!prov) return send(404, { error: '渠道不存在' });
      const app = providerApp(prov.id);
      if (!prov.api_key) return send(400, { error: '渠道未配置 API Key,无法切换' });
      try {
        if (app === 'claude') switchClaude(prov); else switchCodex(prov);
      } catch (e) { return send(500, { error: '写入配置失败: ' + e.message }); }
      current[app] = prov.id;
      saveStore();
      return send(200, { ok: true, app, live: liveState()[app] });
    }

    // ---- 路由
    if (req.method === 'PUT' && p === '/api/routes') {
      const b = JSON.parse((await readBody()) || '{}');
      if (!Array.isArray(b.rules)) return send(400, { error: 'rules 必须是数组' });
      routes = { rules: b.rules, default: b.default || { provider: '', model: '' } };
      saveRoutes();
      return send(200, { ok: true });
    }

    // ---- 静态文件
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      try {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch { res.writeHead(500); return res.end('public/index.html 缺失'); }
    }
    if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    send(404, { error: 'not found' });
  }).catch(e => { try { send(500, { error: e.message }); } catch {} });
}

// ---------------------------------------------------------------- 启动
function listen(port, handler, label) {
  return new Promise((ok, bad) => {
    const srv = http.createServer(handler);
    srv.on('error', bad);
    srv.listen(port, HOST, () => ok(srv));
  });
}
// 被测试 require 时不自动起服务、不吞异常;只有直接运行才进入常驻模式
if (require.main === module) {
  process.title = 'mixrouter';
  Promise.all([listen(PROXY_PORT, proxyHandler, 'proxy'), listen(UI_PORT, apiHandler, 'ui')]).then(() => {
    console.log(`[mixrouter v${VERSION}] 代理 :${PROXY_PORT}  控制台 http://${HOST}:${UI_PORT}  渠道 claude ${store.claude.length} / codex ${store.codex.length}`);
  }).catch(e => {
    console.error(`启动失败: ${e.message}(端口 ${PROXY_PORT}/${UI_PORT} 是否被占用?)`);
    process.exit(1);
  });
  // 长驻进程兜底:单次请求内的意外异常只记日志,不退出
  process.on('uncaughtException', e => console.error(`[uncaught] ${new Date().toISOString()} ${e.stack || e}`));
  process.on('unhandledRejection', e => console.error(`[unhandled] ${new Date().toISOString()} ${e && (e.stack || e.message) || e}`));
}

// 供测试与脚本复用;store/routes/current 经 _state 存取以保持闭包绑定
module.exports = {
  VERSION, proxyHandler, apiHandler, listen,
  resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr,
  switchClaude, switchCodex, liveState, testProvider,
  _state: {
    get store() { return store; }, set store(v) { store = v; },
    get routes() { return routes; }, set routes(v) { routes = v; },
    get current() { return current; }, set current(v) { current = v; },
  },
};
