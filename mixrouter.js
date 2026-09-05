#!/usr/bin/env node
// ============================================================================
// mixrouter v2 — 本地 Anthropic 协议模型路由器
//   :8787  代理端口  接收 /v1/messages,按路由规则改写模型并转发到渠道 <base>/v1/messages
//   :8788  控制台   Web UI + 控制 API
// 零依赖,Node >= 18。数据文件:providers.json(渠道)、routes.json(路由)
// ============================================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION = '2.0.0';
const ROOT = __dirname;
const PROXY_PORT = Number(process.env.MIXROUTER_PORT || 8787);
const UI_PORT = Number(process.env.MIXUI_PORT || 8788);
const HOST = '127.0.0.1';
const PROVIDERS_FILE = path.join(ROOT, 'providers.json');
const ROUTES_FILE = path.join(ROOT, 'routes.json');
const LOG_FILE = path.join(ROOT, 'logs', 'requests.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BODY_LIMIT = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600 * 1000;
const TEST_TIMEOUT_MS = 15 * 1000;
const BETA_1M = 'context-1m-2025-08-07';
// agentrouter 等网关校验 UA 形态,裸 curl 一律 401;客户端没带 UA 时用它兜底
const DEFAULT_UA = 'claude-cli/2.1.219 (external, cli)';
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const RING_SIZE = 500;

process.title = 'mixrouter';

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
let providers = loadJson(PROVIDERS_FILE, []);
if (!Array.isArray(providers)) providers = [];

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

const saveProviders = () => saveJson(PROVIDERS_FILE, providers);
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
function resolveRoute(modelIn) {
  const m = String(modelIn || '').toLowerCase();
  for (const r of routes.rules) {
    if (!r.enabled) continue;
    const hits = String(r.match || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (hits.length && hits.some(h => m.includes(h))) {
      return { rule: r, provider: findProvider(r.provider), model: r.model || modelIn };
    }
  }
  return { rule: null, provider: findProvider(routes.default.provider), model: routes.default.model || modelIn };
}
const findProvider = id => providers.find(p => p.id === id) || null;

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
    if (!provider) return anthropicError(res, 503, 'api_error', `模型 "${modelIn}" 没有匹配的路由,或路由未绑定渠道。请在控制台 http://127.0.0.1:${UI_PORT} 配置路由`);
    if (!provider.enabled) return anthropicError(res, 503, 'api_error', `路由命中的渠道 "${provider.name}" 已停用`);

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': provider.api_key,
      'Authorization': 'Bearer ' + provider.api_key,
      'User-Agent': safeHeader(req.headers['user-agent']) || provider.ua || DEFAULT_UA,
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    const model = applyModel(rawTarget, headers);
    const outBody = JSON.stringify({ ...body, model });

    const started = Date.now();
    const entry = { ts: new Date().toISOString(), provider: provider.name, model_in: modelIn, model_out: model,
      in: 0, out: 0, cache_read: 0, ms: 0, status: 0, stream: !!body.stream, kind: isCount ? 'count_tokens' : 'messages', err: '' };

    const upstream = new URL(provider.base_url);
    const creq = http.request({
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
          if (isCount) entry.in = (text.match(/"input_tokens"\s*:\s*(\d+)/) || [0, 0])[1];
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
        providers: providers.map(publicProvider),
        routes,
      });
    }
    // ---- 日志
    if (req.method === 'GET' && p === '/api/logs') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), RING_SIZE);
      return send(200, { logs: ring.slice(-limit).reverse() });
    }
    // ---- 渠道 CRUD
    if (req.method === 'POST' && p === '/api/providers') {
      const b = JSON.parse((await readBody()) || '{}');
      if (!b.name || !b.base_url) return send(400, { error: 'name 与 base_url 必填' });
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      providers.push({
        id, name: String(b.name), base_url: String(b.base_url).replace(/\/+$/, ''),
        api_key: String(b.api_key || ''), models: Array.isArray(b.models) ? b.models : String(b.models || '').split(',').map(s => s.trim()).filter(Boolean),
        enabled: b.enabled !== false, ua: String(b.ua || ''), note: String(b.note || ''),
        created_at: new Date().toISOString(),
      });
      saveProviders();
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
        if (b.models !== undefined) prov.models = Array.isArray(b.models) ? b.models : String(b.models).split(',').map(s => s.trim()).filter(Boolean);
        if (b.enabled !== undefined) prov.enabled = !!b.enabled;
        if (b.ua !== undefined) prov.ua = String(b.ua);
        if (b.note !== undefined) prov.note = String(b.note);
        saveProviders();
        return send(200, { ok: true });
      }
      if (req.method === 'DELETE') {
        providers = providers.filter(x => x.id !== prov.id);
        saveProviders();
        return send(200, { ok: true });
      }
    }
    // ---- 渠道连通性测试:向上游发一条 max_tokens=1 的最小请求
    m = p.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (req.method === 'POST' && m) {
      const prov = findProvider(m[1]);
      if (!prov) return send(404, { error: '渠道不存在' });
      if (!prov.api_key) return send(200, { ok: false, error: '未配置 API Key' });
      const model = applyModel(prov.models[0] || 'claude-opus-5', {});
      const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
      const u = new URL(prov.base_url);
      const started = Date.now();
      const result = await new Promise(resolve => {
        const creq = http.request({
          protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname.replace(/\/+$/, '') + '/v1/messages', method: 'POST', timeout: TEST_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            'x-api-key': prov.api_key, 'Authorization': 'Bearer ' + prov.api_key,
            'User-Agent': prov.ua || DEFAULT_UA, 'anthropic-version': '2023-06-01' },
        }, cres => {
          const cs = [];
          cres.on('data', c => { if (cs.length < 64) cs.push(c); });
          cres.on('end', () => resolve({ ok: cres.statusCode >= 200 && cres.statusCode < 300, status: cres.statusCode, body: Buffer.concat(cs).toString('utf8').slice(0, 300) }));
        });
        creq.on('timeout', () => creq.destroy(new Error('timeout')));
        creq.on('error', e => resolve({ ok: false, error: e.message }));
        creq.end(body);
      });
      return send(200, { ...result, ms: Date.now() - started, model });
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
Promise.all([listen(PROXY_PORT, proxyHandler, 'proxy'), listen(UI_PORT, apiHandler, 'ui')]).then(() => {
  console.log(`[mixrouter v${VERSION}] 代理 :${PROXY_PORT}  控制台 http://${HOST}:${UI_PORT}  渠道 ${providers.length} 个`);
}).catch(e => {
  console.error(`启动失败: ${e.message}(端口 ${PROXY_PORT}/${UI_PORT} 是否被占用?)`);
  process.exit(1);
});
// 长驻进程兜底:单次请求内的意外异常只记日志,不退出
process.on('uncaughtException', e => console.error(`[uncaught] ${new Date().toISOString()} ${e.stack || e}`));
process.on('unhandledRejection', e => console.error(`[unhandled] ${new Date().toISOString()} ${e && (e.stack || e.message) || e}`));
