#!/usr/bin/env node
// ============================================================================
// mixrouter v3.0 — 本地模型路由器 + cc-switch 式客户端配置切换
//   :8787  代理端口  Anthropic 协议 /v1/messages,按路由规则改写模型转发到渠道
//   :8788  控制台   渠道(Claude Code / Codex 两组)/ 路由 / 会话 / 日志
// 零依赖,Node >= 18。数据文件:providers.json、routes.json、sessions.json
//
// v3 核心:同一个 Agent 的多个对话可以走不同渠道(key)
//   Claude Code 每个对话都带 x-claude-code-session-id(metadata.user_id 里也有),
//   代理以它为"对话"身份,把渠道池里的成员按会话粘性分配——每个对话锁一个渠道,
//   对话内所有请求(含子代理、count_tokens)始终走同一个,不会中途换 key 打断缓存。
// ============================================================================
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VERSION = '3.0.0';
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
// 请求体上限可用环境变量调小(测试用),默认 64MB
const BODY_LIMIT = Number(process.env.MIXR_BODY_LIMIT_MB || 64) * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600 * 1000;
const TEST_TIMEOUT_MS = 15 * 1000;
const BETA_1M = 'context-1m-2025-08-07';
// agentrouter 等网关校验 UA 形态,裸 curl 一律 401;客户端没带 UA 时用它兜底
const DEFAULT_UA = 'claude-cli/2.1.219 (external, cli)';
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const RING_SIZE = 500;
const BACKUP_KEEP = 5;
// ---- v3 会话分发 ----
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
// 会话绑定空闲多久后失效(默认 12h);同一对话中途换渠道会打断 prompt 缓存,故给足
const SESSION_TTL_MS = Number(process.env.MIXR_SESSION_TTL_MIN || 720) * 60 * 1000;
const SESSION_MAX = Number(process.env.MIXR_SESSION_MAX || 1000);
// 上游 429/5xx/连不上时把该渠道打入冷却,冷却期内不再被会话选中
const COOLDOWN_MS = Number(process.env.MIXR_COOLDOWN_SEC || 60) * 1000;
// 单次请求最多尝试几个渠道(池很大时兜住尾延迟)
const MAX_ATTEMPTS = Number(process.env.MIXR_MAX_ATTEMPTS || 3);
// 会话标签(从 system prompt 的工作目录 / 首条用户消息取,便于控制台认出是哪个对话);置 0 关闭
const SESSION_LABEL = process.env.MIXR_SESSION_LABEL !== '0';
const STRATEGIES = ['round_robin', 'weighted', 'least_used', 'random'];
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

// 规则字段:
//   match    请求模型名子串(逗号分隔多个,大小写不敏感)
//   provider 单一目标渠道;pool 非空时优先用池(会话粘性分发)
//   pool     渠道池,元素为渠道 id 或 {provider, model, weight}
//   strategy round_robin(默认) | weighted | least_used | random
//   priority 数值大者先匹配(默认 0);同值按数组顺序
//   when     附加匹配条件,全部满足才命中:{ session, ua, token } 均为子串
const defaultRoutes = () => ({
  rules: [
    { id: 'r1', match: 'opus, claude-3-opus', provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
    { id: 'r2', match: 'sonnet',              provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
    { id: 'r3', match: 'haiku',               provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
    { id: 'r4', match: 'fable',               provider: '', model: '', pool: [], strategy: 'round_robin', priority: 0, when: {}, enabled: true },
  ],
  default: { provider: '', model: '', pool: [], strategy: 'round_robin' },
});
let routes = loadJson(ROUTES_FILE, null);
if (!routes || !Array.isArray(routes.rules)) routes = defaultRoutes();
else routes = { rules: routes.rules.map(normalizeRule), default: normalizeRule(routes.default || {}) };
const saveRoutes = () => saveJson(ROUTES_FILE, routes);

// 从控制台存进来的规则一律过一遍这里:字段类型收敛,免得坏数据埋到转发时才炸
function normalizeRule(r) {
  const src = (r && typeof r === 'object') ? r : {};
  const pool = (Array.isArray(src.pool) ? src.pool : [])
    .map(m => {
      if (typeof m === 'string') return m.trim() ? m.trim() : null;
      if (!m || typeof m !== 'object' || !m.provider) return null;
      const o = { provider: String(m.provider).trim() };
      if (m.model) o.model = String(m.model);
      const w = Number(m.weight);
      if (Number.isFinite(w) && w > 0) o.weight = w;
      return o;
    })
    .filter(Boolean);
  const when = {};
  for (const f of ['session', 'ua', 'token']) {
    if (src.when && src.when[f]) when[f] = String(src.when[f]).trim();
  }
  const p = Number(src.priority);
  return {
    id: String(src.id || 'r' + Math.random().toString(36).slice(2, 8)),
    match: String(src.match || ''),
    provider: String(src.provider || ''),
    model: String(src.model || ''),
    pool,
    strategy: STRATEGIES.includes(src.strategy) ? src.strategy : 'round_robin',
    priority: Number.isFinite(p) ? p : 0,
    when,
    enabled: src.enabled !== false,
  };
}

// ---------------------------------------------------------------- 会话身份
// "对话"= 一个 Claude Code 会话。优先用官方头,其次 metadata.user_id 里的 session_id,
// 都没有(非 CC 客户端)就用 system + 首条用户消息的内容指纹兜底,保证同一对话稳定归组。
function parseSessionId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // CC 个别版本把 metadata.user_id 塞成 JSON 字符串,里面才是 session_id
  if (s.startsWith('{')) { try { return String(JSON.parse(s).session_id || '').trim(); } catch { return ''; } }
  return s;
}
function bodySystemText(body) {
  const sys = body && body.system;
  if (!sys) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.map(b => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  return '';
}
function firstUserText(body) {
  const msgs = (body && body.messages) || [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      // 跳过 CC 注入的 <system-reminder> 块,取真正的人话
      for (const b of c) {
        if (b && b.type === 'text' && b.text && !/^\s*<system-reminder>/.test(b.text)) return b.text;
      }
    }
  }
  return '';
}
// 返回 { key, kind }:kind 标明身份是怎么来的,便于日志排查
function sessionIdentity(req, body) {
  const header = parseSessionId(req.headers['x-claude-code-session-id']);
  if (header) return { key: 'cc:' + header, kind: 'header' };
  const meta = body && body.metadata && parseSessionId(body.metadata.user_id);
  if (meta) return { key: 'cc:' + meta, kind: 'metadata' };
  const seed = bodySystemText(body) + '\u0000' + firstUserText(body);
  if (!seed.replace(/\u0000/g, '').trim()) return { key: 'anon', kind: 'anon' };
  return { key: 'fp:' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16), kind: 'fingerprint' };
}
// 会话标签:优先 system prompt 里的工作目录(CC 的 <env> 块),否则首条用户消息
function sessionLabel(body) {
  if (!SESSION_LABEL) return '';
  const sys = bodySystemText(body);
  const wd = sys.match(/Working directory:\s*(\S+)/) || sys.match(/<cwd>([^<]+)<\/cwd>/);
  if (wd) return wd[1].replace(/^\/(?:Users|home)\/[^/]+/, '~');
  const t = firstUserText(body).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 60) : '';
}
// CC 会为同一会话再发一次"起标题"之类的内部请求,它的首条消息不是用户真正说的话。
// 标签只在会话里还没标签、或现有标签是这种内部文案时才更新,免得把有用的标签覆盖掉。
const looksInternal = s => /^\s*</.test(s) || /Write the title/i.test(s);
function applyLabel(s, label) {
  if (!label || !SESSION_LABEL) return;
  if (!s.label || (looksInternal(s.label) && !looksInternal(label))) s.label = label;
}

// ---------------------------------------------------------------- 会话绑定与渠道池
// key -> { providerId, model, ruleId, label, kind, created, lastUsed, reqs, pinned }
let sessions = new Map();
let pools = {};      // ruleId -> 轮转游标(round_robin / weighted 用)
let cooldowns = {};  // providerId -> 冷却截止时间戳
let rrCounter = 0;   // 无规则归属时的全局游标

function loadSessions() {
  const raw = loadJson(SESSIONS_FILE, null);
  const list = (raw && raw.bindings) || {};
  sessions = new Map(Object.entries(list));
}
let sessionsDirty = false, sessionsTimer = null;
function saveSessionsSoon() {
  sessionsDirty = true;
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(() => {
    sessionsTimer = null;
    if (!sessionsDirty) return;
    sessionsDirty = false;
    const bindings = {};
    for (const [k, v] of sessions) bindings[k] = v;
    saveJson(SESSIONS_FILE, { version: 1, bindings });
  }, 1000);
  if (sessionsTimer.unref) sessionsTimer.unref();
}
// 日志/控制台里显示的短 id:去掉来源前缀再取前 8 位,和 Claude Code 自己显示的会话号对得上
const sessionKeyOf = k => String(k || '').replace(/^(cc|fp):/, '').slice(0, 8);

function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - (v.lastUsed || 0) > SESSION_TTL_MS) sessions.delete(k);
  while (sessions.size > SESSION_MAX) {
    let oldestK = null, oldest = Infinity;
    for (const [k, v] of sessions) if ((v.lastUsed || 0) < oldest) { oldest = v.lastUsed || 0; oldestK = k; }
    if (oldestK === null) break;
    sessions.delete(oldestK);
  }
  for (const [id, until] of Object.entries(cooldowns)) if (until <= now) delete cooldowns[id];
}

function markCooldown(providerId, status) {
  if (!providerId) return;
  cooldowns[providerId] = Date.now() + COOLDOWN_MS;
}
const inCooldown = id => (cooldowns[id] || 0) > Date.now();

// 把规则的 pool 归一化成 [{provider, model, weight}]
// 池成员里"不存在/已停用"的直接跳过(池的意义就是自动绕开不可用的);
// 但单一 provider 目标即使停用也保留成成员——好让调用方给出 provider_disabled_error
// 而不是含混的 no_route_error
function poolMembers(rule) {
  const raw = (rule && Array.isArray(rule.pool)) ? rule.pool : [];
  const out = [];
  for (const m of raw) {
    const id = typeof m === 'string' ? m : (m && m.provider);
    if (!id) continue;
    const p = store.claude.find(x => x.id === id);
    if (!p || p.enabled === false) continue;
    const model = typeof m === 'object' && m && m.model ? m.model : (rule.model || '');
    const weight = typeof m === 'object' && m && Number(m.weight) > 0 ? Number(m.weight) : 1;
    out.push({ provider: p, model, weight });
  }
  if (!out.length && rule && rule.provider) {
    const p = store.claude.find(x => x.id === rule.provider);
    if (p) out.push({ provider: p, model: rule.model || '', weight: 1 });
  }
  return out;
}
const strategyOf = rule => STRATEGIES.includes(rule && rule.strategy) ? rule.strategy : 'round_robin';

// 某渠道当前挂了几个活跃会话(least_used 用)
function activeCount(providerId) {
  let n = 0;
  for (const v of sessions.values()) if (v.providerId === providerId) n++;
  return n;
}

// 平滑加权轮询(nginx 式):无需按权重展开数组,长期比例精确。m.current 是跨请求累积的余量
function pickWeighted(members) {
  if (!members.length) return null;
  let total = 0, best = null;
  for (const m of members) {
    m.current = (m.current || 0) + m.weight;
    total += m.weight;
    if (!best || m.current > best.current) best = m;
  }
  best.current -= total;
  return best;
}

// 从池里给这个会话挑一个渠道;available 已排除冷却中的成员(除非全都在冷却)
function pickMember(rule, members, key) {
  const usable = members.filter(m => !inCooldown(m.provider.id));
  const cands = usable.length ? usable : members;
  if (cands.length === 1) return cands[0];
  const strat = strategyOf(rule);
  if (strat === 'random') return cands[Math.floor(Math.random() * cands.length)];
  if (strat === 'least_used') {
    let best = cands[0];
    for (const m of cands) if (activeCount(m.provider.id) < activeCount(best.provider.id)) best = m;
    return best;
  }
  const rid = (rule && rule.id) || '_';
  pools[rid] = pools[rid] || 0;
  if (strat === 'weighted') {
    // 平滑加权轮询需要跨请求保留 current,按规则缓存一份可变副本
    pools['__w_' + rid] = pools['__w_' + rid] || cands.map(m => ({ ...m, current: 0 }));
    const w = pools['__w_' + rid];
    for (const m of w) {
      const src = cands.find(c => c.provider.id === m.provider.id);
      m.weight = src ? src.weight : 1;
    }
    const alive = w.filter(m => cands.some(c => c.provider.id === m.provider.id));
    if (!alive.length) return cands[0];
    const chosen = pickWeighted(alive);
    return (chosen && cands.find(c => c.provider.id === chosen.provider.id)) || cands[0];
  }
  // round_robin:按会话数轮转,新会话依次落到不同渠道
  const idx = (pools[rid]++) % cands.length;
  return cands[idx];
}

// 拿到本会话该走的渠道:已有绑定且渠道仍可用 → 复用(粘性);否则挑一个并绑定
function resolveSessionTarget(rule, members, key, label, kind) {
  pruneSessions();
  const now = Date.now();
  const bound = sessions.get(key);
  const touch = () => { bound.lastUsed = now; applyLabel(bound, label); };
  if (bound) {
    // 手动钉定压过策略:哪怕这个渠道不在池里也照走——钉定的意义就是"这个对话我要它走这里"
    if (bound.pinned) {
      const p = store.claude.find(x => x.id === bound.providerId);
      if (p && p.enabled !== false && !inCooldown(bound.providerId)) {
        touch();
        return { member: { provider: p, model: bound.model || (rule && rule.model) || '', weight: 1 }, sticky: true, rebind: false };
      }
    }
    const m = members.find(x => x.provider.id === bound.providerId);
    if (m && !inCooldown(bound.providerId)) {
      touch();
      return { member: m, sticky: true, rebind: false };
    }
  }
  const picked = pickMember(rule, members, key);
  return { member: picked, sticky: !!bound, rebind: true };
}

const sessionEntry = (key, kind, members, label) => {
  let s = sessions.get(key);
  if (!s) {
    s = { providerId: '', model: '', ruleId: '', label: label || '', kind, created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false };
    sessions.set(key, s);
  }
  if (kind && s.kind !== kind) s.kind = kind;
  applyLabel(s, label);
  return s;
};

loadSessions();

// 控制台用:当前活跃会话一览(不含任何密钥;key 只给短 id 便于对照日志)
function sessionList() {
  pruneSessions();
  const out = [];
  for (const [k, v] of sessions) {
    const p = v.providerId ? findProvider(v.providerId) : null;
    out.push({ key: k, short: sessionKeyOf(k), kind: v.kind || '', label: v.label || '',
      provider: v.providerId || '', provider_name: p ? p.name : '', model: v.model || '',
      rule: v.ruleId || '', reqs: v.reqs || 0, inTok: v.inTok || 0, outTok: v.outTok || 0,
      created: v.created || 0, lastUsed: v.lastUsed || 0, pinned: !!v.pinned,
      cooldown: !!v.providerId && inCooldown(v.providerId) });
  }
  return out.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

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
// match 为请求模型名的子串,逗号分隔多个,大小写不敏感
// 先按 priority 降序(同值保持数组顺序),命中首个启用且满足 when 的规则
// 路由目标只能是 Claude Code 组的渠道(代理只说 Anthropic 协议)
function matchWhen(rule, ctx) {
  const w = (rule && rule.when) || {};
  for (const field of ['session', 'ua', 'token']) {
    const want = String(w[field] || '').trim().toLowerCase();
    if (!want) continue;
    if (!String((ctx && ctx[field]) || '').toLowerCase().includes(want)) return false;
  }
  return true;
}
function resolveRoute(modelIn, ctx = {}) {
  const m = String(modelIn || '').toLowerCase();
  const order = routes.rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((Number(b.r.priority) || 0) - (Number(a.r.priority) || 0)) || (a.i - b.i));
  for (const { r } of order) {
    if (!r.enabled) continue;
    const hits = String(r.match || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!hits.length || !hits.some(h => m.includes(h))) continue;
    if (!matchWhen(r, ctx)) continue;
    const members = poolMembers(r);
    return { rule: r, members, provider: members.length ? members[0].provider : null,
      model: (members.length ? members[0].model : r.model) || modelIn, strategy: strategyOf(r) };
  }
  const d = routes.default || {};
  const members = poolMembers(d);
  return { rule: null, members, provider: members.length ? members[0].provider : null,
    model: (members.length ? members[0].model : d.model) || modelIn, strategy: strategyOf(d) };
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

// base_url 必须是合法 http(s) URL;坏值存进库会埋雷到首次转发才炸
function validBaseUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

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

  const chunks = []; let size = 0; let rejected = false;
  const overLimit = () => {
    if (rejected) return;
    rejected = true;
    try { if (!res.headersSent) anthropicError(res, 413, 'invalid_request_error', `请求体超过 ${Math.floor(BODY_LIMIT / 1024 / 1024)}MB 上限`); } catch {}
    // 不炸 socket:继续排水丢弃剩余数据,让 413 干净送达(炸连接会让客户端只看到 EPIPE)
    req.removeAllListeners('data');
    req.resume();
  };
  req.on('data', c => { size += c.length; if (size > BODY_LIMIT) return overLimit(); chunks.push(c); });
  req.on('end', () => {
    if (rejected) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return anthropicError(res, 400, 'invalid_request_error', '请求体不是合法 JSON'); }

    const modelIn = body.model || '';
    const ident = sessionIdentity(req, body);
    const label = sessionLabel(body);
    const resolved = resolveRoute(modelIn, {
      session: ident.key, ua: req.headers['user-agent'], token: clientToken(req),
    });
    const members = resolved.members;
    if (!members.length) return anthropicError(res, 503, 'no_route_error', `模型 "${modelIn}" 没有匹配的路由,或路由未绑定 Claude 渠道。请在控制台 http://127.0.0.1:${UI_PORT} 配置路由`);
    // 单一目标停用 → 明确分型(池会自动跳过停用成员,不会落到这)
    if (members.length === 1 && members[0].provider.enabled === false)
      return anthropicError(res, 503, 'provider_disabled_error', `路由命中的渠道 "${members[0].provider.name}" 已停用`);

    // 本会话锁定的渠道优先,其余池成员依次作后备(只在还没给客户端写字节时才会换)
    const target = resolveSessionTarget(resolved.rule, members, ident.key, label, ident.kind);
    const sess = sessionEntry(ident.key, ident.kind, members, label);
    const wasSticky = target.sticky && !target.rebind;
    const ordered = [target.member]
      .concat(members.filter(m => m.provider.id !== target.member.provider.id))
      .slice(0, Math.max(1, MAX_ATTEMPTS));

    const started = Date.now();
    const entry = { ts: new Date().toISOString(), provider: '', model_in: modelIn, model_out: '',
      session: sessionKeyOf(ident.key), session_kind: ident.kind, rule: (resolved.rule && resolved.rule.id) || 'default',
      pool: members.length, strategy: resolved.strategy, sticky: wasSticky, attempts: 0, failover: false,
      in: 0, out: 0, cache_read: 0, ms: 0, status: 0, stream: !!body.stream,
      kind: isCount ? 'count_tokens' : 'messages', err: '' };

    // 单次请求的收尾:计数入会话、写日志、收响应(所有终止路径都走这里,避免漏记)
    const finalize = () => {
      sess.reqs = (sess.reqs || 0) + 1;
      sess.inTok = (sess.inTok || 0) + (entry.in || 0);
      sess.outTok = (sess.outTok || 0) + (entry.out || 0);
      sess.lastUsed = Date.now();
      saveSessionsSoon();
      logRequest(entry);
    };
    const sendErr = (status, type, message) => {
      entry.status = status;
      if (!res.headersSent) anthropicError(res, status, type, message);
      else { try { res.end(); } catch {} }
    };

    function tryCandidate(i) {
      const member = ordered[i];
      const provider = member.provider;
      const headers = buildUpstreamHeaders(provider, req);
      const model = applyModel(member.model || modelIn, headers);
      const outBody = JSON.stringify({ ...body, model });
      entry.attempts = i + 1;
      entry.provider = provider.name;
      entry.model_out = model;

      const upstream = new URL(provider.base_url);
      const transport = upstream.protocol === 'https:' ? https : http;
      let done = false;
      // 还有后备渠道时,把这次失败记到冷却里再换下一个
      const nextOrFail = (reason, errMsg) => {
        markCooldown(provider.id, reason);
        if (i + 1 < ordered.length) { entry.failover = true; return tryCandidate(i + 1); }
        entry.ms = Date.now() - started; entry.err = errMsg; finalize();
        sendErr(502, 'api_error', `上游 ${provider.name} 请求失败: ${errMsg}`);
      };
      const creq = transport.request({
        protocol: upstream.protocol, hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname.replace(/\/+$/, '') + (isCount ? '/v1/messages/count_tokens' : '/v1/messages'),
        method: 'POST', headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      }, cres => {
        if (done) return;
        // 上游整体性故障(5xx / 限流)时,趁还没给客户端写任何字节,换下一个渠道
        if ((cres.statusCode >= 500 || cres.statusCode === 429) && i + 1 < ordered.length) {
          done = true;
          cres.resume(); // 排水丢弃,避免占住 socket
          return nextOrFail(cres.statusCode, '');
        }
        done = true;
        entry.status = cres.statusCode;
        entry.sticky = wasSticky && !entry.failover;
        // 落到这个渠道就把它记进会话(含失败转移后重新绑定),后续请求继续粘它
        if (sess.providerId !== provider.id || entry.failover) {
          sess.providerId = provider.id; sess.model = model;
          sess.ruleId = (resolved.rule && resolved.rule.id) || 'default';
        }
        res.writeHead(cres.statusCode, {
          'Content-Type': cres.headers['content-type'] || 'application/json',
          'x-mixrouter-provider': safeHeader(provider.name),
          'x-mixrouter-model': safeHeader(model),
          'x-mixrouter-session': safeHeader(sessionKeyOf(ident.key)),
        });
        if (entry.stream && cres.headers['content-type'] && cres.headers['content-type'].includes('text/event-stream')) {
          let acc = '';
          cres.on('data', c => { if (acc.length < 1024 * 1024) acc += c.toString('utf8'); res.write(c); });
          cres.on('end', () => {
            entry.ms = Date.now() - started;
            const u = extractUsage(acc); entry.in = u.in; entry.out = u.out; entry.cache_read = u.cache_read;
            finalize(); res.end();
          });
        } else {
          const parts = [];
          cres.on('data', c => { parts.push(c); res.write(c); });
          cres.on('end', () => {
            entry.ms = Date.now() - started;
            const text = Buffer.concat(parts).toString('utf8');
            const u = extractUsage(text); entry.in = u.in; entry.out = u.out; entry.cache_read = u.cache_read;
            if (isCount) entry.in = Number((text.match(/"input_tokens"\s*:\s*(\d+)/) || [0, 0])[1]);
            finalize(); res.end();
          });
        }
      });
      creq.on('timeout', () => {
        if (done) return;
        done = true;
        creq.destroy(new Error('timeout'));
        nextOrFail(0, 'upstream timeout');
      });
      creq.on('error', e => {
        if (done) return;
        done = true;
        nextOrFail(0, e.message);
      });
      creq.end(outBody);
    }
    tryCandidate(0);
  });
}

// 客户端带来的凭据(可当路由维度用:不同对话配不同 ANTHROPIC_AUTH_TOKEN 即可分流)
function clientToken(req) {
  const a = String(req.headers['authorization'] || '');
  if (a) return a.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

// 转发到上游时的请求头:渠道自定义 UA 优先,其次客户端 UA,最后兜底 claude-cli UA
function buildUpstreamHeaders(provider, req) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.api_key,
    'Authorization': 'Bearer ' + provider.api_key,
    'User-Agent': safeHeader(provider.ua) || safeHeader(req.headers['user-agent']) || DEFAULT_UA,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  return headers;
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
        sessions: sessionList(),
        cooldowns: Object.entries(cooldowns).map(([id, until]) => ({ provider: id, until, name: (findProvider(id) || {}).name || id })),
        session_ttl_min: Math.round(SESSION_TTL_MS / 60000), cooldown_s: Math.round(COOLDOWN_MS / 1000),
      });
    }
    // ---- 日志(支持过滤:provider 模型子串 / model 子串 / status=ok|err|具体码 / limit)
    if (req.method === 'GET' && p === '/api/logs') {
      const q = url.searchParams;
      const limit = Math.min(Number(q.get('limit') || 200), RING_SIZE);
      const prov = (q.get('provider') || '').toLowerCase();
      const model = (q.get('model') || '').toLowerCase();
      const sess = (q.get('session') || '').toLowerCase();
      const status = q.get('status') || '';
      let items = ring;
      if (prov) items = items.filter(e => (e.provider || '').toLowerCase().includes(prov));
      if (model) items = items.filter(e => (e.model_in || '').toLowerCase().includes(model) || (e.model_out || '').toLowerCase().includes(model));
      if (sess) items = items.filter(e => (e.session || '').toLowerCase().includes(sess));
      if (status === 'ok') items = items.filter(e => e.status >= 200 && e.status < 400 && !e.err);
      else if (status === 'err') items = items.filter(e => e.status >= 400 || e.status === 0 || e.err);
      else if (status) items = items.filter(e => String(e.status) === status);
      return send(200, { logs: items.slice(-limit).reverse() });
    }
    // ---- 统计:ring 内存窗口内的全量聚合(总数/成功率/token/按渠道/按模型)
    if (req.method === 'GET' && p === '/api/stats') {
      let reqs = 0, ok = 0, inTok = 0, outTok = 0, cache = 0;
      const byProvider = {}, byModel = {};
      for (const e of ring) {
        reqs++;
        if (e.status >= 200 && e.status < 400 && !e.err) ok++;
        inTok += e.in || 0; outTok += e.out || 0; cache += e.cache_read || 0;
        const pv = e.provider || '(未知)';
        byProvider[pv] = (byProvider[pv] || 0) + 1;
        const mk = e.model_out || e.model_in || '(?)';
        byModel[mk] = (byModel[mk] || 0) + 1;
      }
      return send(200, { reqs, ok, ok_rate: reqs ? Math.round(ok * 100 / reqs) : 100, inTok, outTok, cache, by_provider: byProvider, by_model: byModel });
    }
    // ---- 渠道 CRUD(app = claude | codex)
    if (req.method === 'POST' && p === '/api/providers') {
      const b = JSON.parse((await readBody()) || '{}');
      const app = b.app === 'codex' ? 'codex' : 'claude';
      if (!b.name || !b.base_url) return send(400, { error: 'name 与 base_url 必填' });
      if (!validBaseUrl(b.base_url)) return send(400, { error: 'base_url 必须是合法的 http(s) URL,如 https://api.example.com' });
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
        if (b.base_url !== undefined) {
          if (!validBaseUrl(b.base_url)) return send(400, { error: 'base_url 必须是合法的 http(s) URL,如 https://api.example.com' });
          prov.base_url = String(b.base_url).replace(/\/+$/, '');
        }
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

    // ---- 会话:列表 / 手动改绑(把某个对话钉到指定渠道)/ 解绑
    if (req.method === 'GET' && p === '/api/sessions') {
      return send(200, { sessions: sessionList() });
    }
    if (req.method === 'DELETE' && p === '/api/sessions') {
      sessions.clear(); saveSessionsSoon();
      return send(200, { ok: true, cleared: true });
    }
    let ms = p.match(/^\/api\/sessions\/([^/]+)\/pin$/);
    if (req.method === 'POST' && ms) {
      const key = decodeURIComponent(ms[1]);
      const s = sessions.get(key);
      if (!s) return send(404, { error: '会话不存在(可能已过期)' });
      const b = JSON.parse((await readBody()) || '{}');
      const id = String(b.provider || '');
      if (id) {
        const prov = store.claude.find(x => x.id === id);
        if (!prov) return send(404, { error: '渠道不存在(会话只能绑 Claude 组的渠道)' });
        if (prov.enabled === false) return send(400, { error: `渠道 "${prov.name}" 已停用,不能绑定` });
        s.providerId = id;
        s.pinned = true;
        if (b.model !== undefined) s.model = String(b.model || '');
        delete cooldowns[id]; // 手动指定即视为"这个渠道我要用",清掉冷却
      } else {
        s.pinned = false; // 置空 = 解除钉定,下次请求重新按策略分配
        s.providerId = '';
      }
      saveSessionsSoon();
      return send(200, { ok: true, session: sessionList().find(x => x.key === key) || null });
    }
    ms = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'DELETE' && ms) {
      const key = decodeURIComponent(ms[1]);
      if (!sessions.has(key)) return send(404, { error: '会话不存在(可能已过期)' });
      sessions.delete(key); saveSessionsSoon();
      return send(200, { ok: true });
    }

    // ---- 路由
    if (req.method === 'PUT' && p === '/api/routes') {
      const b = JSON.parse((await readBody()) || '{}');
      if (!Array.isArray(b.rules)) return send(400, { error: 'rules 必须是数组' });
      routes = { rules: b.rules.map(normalizeRule), default: normalizeRule(b.default || {}) };
      saveRoutes();
      pools = {}; // 规则变了,轮转游标作废
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
  resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr, validBaseUrl,
  switchClaude, switchCodex, liveState, testProvider,
  // v3 会话分发
  sessionIdentity, sessionLabel, parseSessionId, matchWhen, normalizeRule, poolMembers,
  sessionList, buildUpstreamHeaders, clientToken, strategyOf, applyLabel,
  _state: {
    get store() { return store; }, set store(v) { store = v; },
    get routes() { return routes; }, set routes(v) { routes = v; },
    get current() { return current; }, set current(v) { current = v; },
    get sessions() { return sessions; }, set sessions(v) { sessions = v; },
    get cooldowns() { return cooldowns; }, set cooldowns(v) { cooldowns = v; },
    resetPools() { pools = {}; },
    bindSession(key, providerId, extra = {}) {
      sessions.set(key, { providerId, model: '', ruleId: '', label: '', kind: 'header',
        created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false, ...extra });
      return sessions.get(key);
    },
  },
};
