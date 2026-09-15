#!/usr/bin/env node
// ============================================================================
// mixrouter v3.2 — 本地模型路由器 + cc-switch 式客户端配置切换
//   :8787  代理端口  Claude 组:/v1/messages、count_tokens(Anthropic 协议)
//                   Codex  组:/v1/responses、/v1/chat/completions(OpenAI 协议)
//   :8788  控制台   渠道(Claude Code / Codex 两组)/ 路由 / 槽位 / 会话 / 日志
// 零依赖,Node >= 18。数据文件:providers.json、routes.json、slots.json、sessions.json
//
// v3 核心:同一个 Agent 的多个对话可以走不同渠道(key)
//   Claude Code 每个对话都带 x-claude-code-session-id(metadata.user_id 里也有),
//   Codex 0.154 每个请求都带 session-id / thread-id 头(body.prompt_cache_key 同值),
//   代理以它为"对话"身份,把渠道池里的成员按会话粘性分配——每个对话锁一个渠道,
//   对话内所有请求(含子代理、count_tokens)始终走同一个,不会中途换 key 打断缓存。
//   Codex 上游若是只开 chat/completions 的网关,代理自动翻译协议(responses ⇄ chat)。
// ============================================================================
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zcodeConfig = require('./lib/zcode-config');
const wireResponses = require('./lib/wire-responses');
const wireChat = require('./lib/wire-chat');
const { upstreamAgent } = require('./lib/upstream-proxy');
const imageRelay = require('./lib/image-relay');

const VERSION = '3.5.2';
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
// 识图中继开关(图片块落盘+换指路文本,MIXR_IMAGE_RELAY=off 关闭;只作用于 claude 入口)
const IMAGE_RELAY_ON = process.env.MIXR_IMAGE_RELAY !== 'off';
function envInt(name, fallback, min = 1, max = 2147483647) {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
// ---- 端到端超时预算 ----
// 客户端(Claude Code)默认 API_TIMEOUT_MS=300s 是整条请求的总预算,CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=120s
// 是"多久没收到字节就本地放弃"。本进程的三段超时必须**全部**落在客户端预算里面:
// 一旦反过来(以前三段都是 600s),客户端会先放弃并重发,我们还在替一条没人接收的响应占着
// 上游连接和渠道额度,日志也记成 499 client closed 而不是真实的 timeout。
// 所以:总 deadline 卡在最外层,三段各自再被它夹住,谁都超不出去。
const TOTAL_DEADLINE_MS = envInt('MIXR_TOTAL_DEADLINE_MS', 240000);
const FIRST_HEADER_TIMEOUT_MS = Math.min(envInt('MIXR_FIRST_HEADER_TIMEOUT_MS', 120000), TOTAL_DEADLINE_MS);
// 流式请求的上游一接受就会发响应头,迟迟等不到头基本就是死了,不必陪着耗到总预算
const STREAM_FIRST_HEADER_TIMEOUT_MS = Math.min(envInt('MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS', 60000), TOTAL_DEADLINE_MS);
const firstHeaderTimeoutFor = stream => (stream ? STREAM_FIRST_HEADER_TIMEOUT_MS : FIRST_HEADER_TIMEOUT_MS);
// 兼容监听:旧客户端把 BASE_URL 写死到别的端口(如切换器/本地转换代理的端口)时,
// 让本进程顺带在那个端口上也服务——接管时**正在跑**的会话不必重启。best-effort,占不到只告警。
function altPorts(primary, ui) {
  const ports = String(process.env.MIXROUTER_ALT_PORTS || '').split(',').map(s => Number(s.trim()))
    .filter(p => Number.isInteger(p) && p > 0 && p < 65536 && p !== primary && p !== ui);
  return [...new Set(ports)];
}
// 上游两次字节之间:必须 **小于** 客户端的字节流空闲超时,否则客户端先本地放弃,
// 我们"上游空闲中断 + 换渠道"的诊断根本来不及送到(这正是长上下文被连杀的表现)
const STREAM_IDLE_TIMEOUT_MS = Math.min(envInt('MIXR_STREAM_IDLE_TIMEOUT_MS', 90000), TOTAL_DEADLINE_MS);
const NONSTREAM_TOTAL_TIMEOUT_MS = Math.min(envInt('MIXR_NONSTREAM_TOTAL_TIMEOUT_MS', 180000), TOTAL_DEADLINE_MS);
// 已经提交给客户端的流式响应:每隔这么久补一行 SSE 注释,让客户端的字节流空闲计时器知道连接还活着
// (上游在慢慢推理时这条通道会一直沉默)。0 = 关掉。
const SSE_KEEPALIVE_MS = envInt('MIXR_SSE_KEEPALIVE_MS', 15000, 0);
const TEST_TIMEOUT_MS = 15 * 1000;
const BETA_1M = 'context-1m-2025-08-07';
// agentrouter 等网关校验 UA 形态,裸 curl 一律 401;客户端没带 UA 时用它兜底
const DEFAULT_UA = 'claude-cli/2.1.219 (external, cli)';
// OpenAI 协议端点的兜底 UA(codex 自己带 codex_exec/… 或 codex_cli_rs/…,这个只兜非 codex 客户端)
const DEFAULT_UA_CODEX = 'codex_cli_rs/0.154.0 (external, cli)';
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const RING_SIZE = 500;
const BACKUP_KEEP = 5;
// 路由模式的客户端配置指向(代理不校验 token,仅占位——Codex 的 experimental_bearer_token 不能为空)
const ROUTER_ID = '@router';
const ROUTER_URL = `http://${HOST}:${PROXY_PORT}`;
const ROUTER_TOKEN = 'mixrouter-local';
const ROUTER_SECTION = 'mixr-router';
// ---- v3 会话分发 ----
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
// ---- v3.2 子代理槽位 ----
const SLOTS_FILE = path.join(DATA_DIR, 'slots.json');
// 会话绑定空闲多久后失效(默认 12h);同一对话中途换渠道会打断 prompt 缓存,故给足
const SESSION_TTL_MS = Number(process.env.MIXR_SESSION_TTL_MIN || 720) * 60 * 1000;
const SESSION_MAX = Number(process.env.MIXR_SESSION_MAX || 1000);
// 上游 429/5xx/连不上时把该渠道打入冷却,冷却期内不再被会话选中
const COOLDOWN_MS = envInt('MIXR_COOLDOWN_SEC', 60, 0, 2147483) * 1000;
// MAX_ATTEMPTS also caps actual network attempts, including conversion retries.
const MAX_ATTEMPTS = envInt('MIXR_MAX_ATTEMPTS', 3, 1, 100);
const CONV_RETRIES = envInt('MIXR_CONV_RETRIES', 3, 0, 100);
const FAILURE_THRESHOLD = envInt('MIXR_BREAKER_FAILURE_THRESHOLD', 3, 1, 100);
const RECOVERY_THRESHOLD = envInt('MIXR_BREAKER_RECOVERY_THRESHOLD', 1, 1, 100);
const health = require('./lib/upstream-health').createHealth({ cooldownMs: COOLDOWN_MS,
  failureThreshold: FAILURE_THRESHOLD, recoveryThreshold: RECOVERY_THRESHOLD });

// Responses 型的 Codex 通道会用 prompt_cache_key 做渠道亲和(TTL 1 小时),坏渠道
// 一旦钉上就整小时失败。key 按会话稳定(拿得到上游 prompt cache),失败时 +1 代。
const convCacheGens = new Map();
const convCacheBase = (sessionKey, providerId) => (`${providerId}-${sessionKey || 'anon'}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'mixrouter');
const convCacheKey = (sessionKey, providerId, gen) => (gen ? `${convCacheBase(sessionKey, providerId)}-g${gen}` : convCacheBase(sessionKey, providerId));
function rotateConvCacheGen(sessionKey, providerId) {
  const k = providerId + '\u0000' + (sessionKey || 'anon');
  if (convCacheGens.size > SESSION_MAX) convCacheGens.clear();
  const gen = ((convCacheGens.get(k) || 0) + 1) % 50;
  convCacheGens.set(k, gen);
  return gen;
}
const convCacheGen = (sessionKey, providerId) => convCacheGens.get(providerId + '\u0000' + (sessionKey || 'anon')) || 0;
// 会话标签(从 system prompt 的工作目录 / 首条用户消息取,便于控制台认出是哪个对话);置 0 关闭
const SESSION_LABEL = process.env.MIXR_SESSION_LABEL !== '0';
const STRATEGIES = ['round_robin', 'weighted', 'least_used', 'random', 'priority'];
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
let current = { claude: null, codex: null, zcode: null };
{ const raw = loadJson(PROVIDERS_FILE, null); if (raw && raw.current) current = { ...current, ...raw.current }; }

const saveStore = () => saveJson(PROVIDERS_FILE, { version: 2, current, claude: store.claude, codex: store.codex });
const storeOf = app => (app === 'codex' ? store.codex : store.claude);
const findProvider = id => store.claude.find(p => p.id === id) || store.codex.find(p => p.id === id) || null;
const providerApp = id => store.claude.some(p => p.id === id) ? 'claude' : (store.codex.some(p => p.id === id) ? 'codex' : null);

// 规则字段:
//   match    请求模型名子串(逗号分隔多个,大小写不敏感)
//   provider 单一目标渠道;pool 非空时优先用池(会话粘性分发)
//   pool     渠道池,元素为渠道 id 或 {provider, model, weight}
//   strategy round_robin(默认) | weighted | least_used | random
//   priority 数值大者先匹配(默认 0);同值按数组顺序
//   app      适用客户端组 claude | codex;留空 = 两组通用(池成员按组自动取舍)
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

// ---------------------------------------------------------------- 子代理槽位(v3.2)
// 槽位 = 一个命名别名绑定「渠道 + 模型」,让客户端的子代理/后台任务各走各的上游:
//   Claude 组固定四个槽(main/opus/sonnet/haiku),别名 mixr-<槽名> 写进客户端 env;
//   Codex 组槽名自拟(如 worker/reviewer),codex exec -m mixr-<槽名> 即可选用。
// 请求模型名精确等于别名时按槽位分发,优先于一切路由规则;槽位目标不受会话粘性影响
// (粘性只在同一条规则的池内生效),渠道停用会给出明确的 provider_disabled_error。
const CLAUDE_SLOTS = ['main', 'opus', 'sonnet', 'fable', 'haiku', 'subagent'];
const CLAUDE_SLOT_ENV = {
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
};
const slotAlias = (app, name) => 'mixr-' + name;
// 渠道级模型映射(cc-switch 同款):直连「切换」时写入对应 env,值可带 [1M] 能力声明
const CLAUDE_SLOT_KEYS = ['opus', 'sonnet', 'fable', 'haiku', 'subagent'];
const normalizeChannelSlots = slots => {
  const src = (slots && typeof slots === 'object') ? slots : {};
  return Object.fromEntries(CLAUDE_SLOT_KEYS.map(k => [k, String(src[k] || '').trim()]));
};
const CODEX_SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

function loadSlots() {
  const raw = loadJson(SLOTS_FILE, null);
  return {
    claude: (raw && typeof raw.claude === 'object' && raw.claude) || {},
    codex: (raw && typeof raw.codex === 'object' && raw.codex) || {},
  };
}
let slotMap = loadSlots();
const saveSlots = () => saveJson(SLOTS_FILE, { version: 1, claude: slotMap.claude, codex: slotMap.codex });

// 请求模型名 → 命中的槽位。返回 null 表示不是槽位别名,继续走普通规则。
// model 落点:Claude 槽用绑定时选的模型(空串回退渠道第一个);Codex 渠道自带模型名。
function resolveSlot(app, modelIn) {
  const m = String(modelIn || '').trim().toLowerCase();
  if (!m.startsWith('mixr-')) return null;
  const reg = slotMap[app] || {};
  for (const name of Object.keys(reg)) {
    const s = reg[name];
    if (!s || !s.provider) continue;
    if (m !== slotAlias(app, name)) continue;
    const p = storeOf(app).find(x => x.id === s.provider) || null;
    const model = app === 'codex' ? ((p && p.model) || '')
      : (s.model || (p && Array.isArray(p.models) && p.models[0]) || '');
    return {
      name,
      provider: p,
      model,
      // rule.model 带上落点模型,poolMembers 才能把 Claude 槽的模型送进转发(空 = 透传别名)
      rule: {
        id: `slot:${app}/${name}`, match: slotAlias(app, name), provider: s.provider,
        model, pool: [], strategy: 'round_robin', priority: 1000, app, when: {}, enabled: true,
      },
    };
  }
  return null;
}

// 槽位写入校验:返回错误文案或 null。body 形如 {claude:{opus:{provider,model}|null}, codex:{...}}
function validateSlotPut(body) {
  for (const app of ['claude', 'codex']) {
    const patch = body[app];
    if (patch === undefined) continue;
    if (!zcodeConfig.isObject(patch)) return `${app} 槽位必须是对象`;
    for (const [name, val] of Object.entries(patch)) {
      if (app === 'claude' && !CLAUDE_SLOTS.includes(name))
        return `Claude 槽位只能是 ${CLAUDE_SLOTS.join(' / ')},收到 "${name}"`;
      if (app === 'codex' && !CODEX_SLOT_NAME_RE.test(name))
        return `Codex 槽位名只能用小写字母、数字、连字符(≤24 位),收到 "${name}"`;
      if (val === null) continue;
      if (!zcodeConfig.isObject(val) || !val.provider || typeof val.provider !== 'string')
        return `槽位 "${name}" 必须是 {provider, model} 或 null`;
      if (!findProvider(val.provider) || providerApp(val.provider) !== app)
        return `槽位 "${name}" 绑定的渠道不存在(须为 ${app === 'codex' ? 'Codex' : 'Claude'} 组渠道)`;
      if (app === 'claude' && val.model !== undefined && typeof val.model !== 'string')
        return `槽位 "${name}" 的 model 必须是字符串`;
    }
  }
  return null;
}

function claudeSplitPatch(body) {
  const bad = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  const target = (value, label) => {
    if (!zcodeConfig.isObject(value) || typeof value.provider !== 'string' ||
        typeof value.model !== 'string' || !value.model.trim()) bad(`${label} 必须指定 provider 和 model`);
    const provider = store.claude.find(p => p.id === value.provider);
    if (!provider || provider.enabled === false) bad(`${label} 必须选择已启用的 Claude 组渠道`);
    return { provider: provider.id, model: value.model.trim() };
  };
  if (body.apply !== undefined && typeof body.apply !== 'boolean') bad('apply 必须是布尔值');
  const subagent = target(body.subagent, '子代理');
  if (body.main === undefined) {
    const fixed = CLAUDE_SLOTS.filter(n => n !== 'subagent').map(n => slotMap.claude[n]);
    if (fixed.some(s => !s || !s.provider || !s.model) ||
        fixed.some(s => s.provider !== fixed[0].provider || s.model !== fixed[0].model))
      bad('请先指定 main 建立统一主槽，再单独切换 subagent');
    target(fixed[0], '主槽');
    return { subagent };
  }
  const main = target(body.main, '主槽');
  return Object.fromEntries(CLAUDE_SLOTS.map(n => [n, { ...(n === 'subagent' ? subagent : main) }]));
}

function configureClaudeSplit(body) {
  const patch = claudeSplitPatch(body);
  const previous = slotMap;
  slotMap = { ...slotMap, claude: { ...slotMap.claude, ...patch } };
  try { saveSlots(); } catch (e) { slotMap = previous; throw e; }
  // 路由先持久化,再改客户端;启动只读 slots.json,不自动回放客户端备份。
  if (body.apply) {
    switchClaudeRouter({ slots: true });
    current.claude = ROUTER_ID;
    saveStore();
  }
  return { ok: true, applied: !!body.apply, slots: slotsPublic().claude };
}

// 控制台用:槽位一览(带渠道名/落点模型/停用状态;不含密钥)
function slotsPublic() {
  const entry = (app, name) => {
    const s = (slotMap[app] || {})[name];
    const p = s && s.provider ? findProvider(s.provider) : null;
    const model = p ? (app === 'codex' ? (p.model || '') : (s.model || (Array.isArray(p.models) && p.models[0]) || '')) : (s && s.model) || '';
    return {
      name, alias: slotAlias(app, name), env: app === 'claude' ? CLAUDE_SLOT_ENV[name] : '',
      provider: s ? s.provider : '', provider_name: p ? p.name : '',
      enabled: !!p && p.enabled !== false, model,
    };
  };
  return {
    claude: CLAUDE_SLOTS.map(n => entry('claude', n)),
    codex: Object.keys(slotMap.codex || {}).filter(n => slotMap.codex[n]).map(n => entry('codex', n)),
  };
}

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
  for (const f of ['session', 'ua', 'token', 'body']) {
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
    app: src.app === 'codex' ? 'codex' : (src.app === 'claude' ? 'claude' : ''),
    when,
    enabled: src.enabled !== false,
  };
}

// ---------------------------------------------------------------- 会话身份
// "对话"= 一个客户端会话。优先用官方头,其次请求体里的会话字段,
// 都没有(自定义客户端)就用 system/instructions + 首条用户消息的内容指纹兜底。
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
// ---- Codex(OpenAI 协议)侧的会话身份 ----
// 实测 codex-cli 0.154:每个请求都带 session-id / thread-id / x-client-request-id(同一个 UUID),
// 请求体里 prompt_cache_key 同值,client_metadata.session_id 与 x-codex-turn-metadata 里也各有一份
function codexHeaderSessionId(req) {
  for (const h of ['session-id', 'thread-id', 'x-client-request-id']) {
    const v = String(req.headers[h] || '').trim();
    if (v) return v;
  }
  const tm = String(req.headers['x-codex-turn-metadata'] || '').trim();
  if (tm.startsWith('{')) { try { return String(JSON.parse(tm).session_id || '').trim(); } catch {} }
  return '';
}
function codexBodySessionId(body) {
  const direct = String((body && body.prompt_cache_key) || '').trim();
  if (direct) return direct;
  const cm = body && body.client_metadata;
  if (cm && typeof cm === 'object' && cm.session_id) return String(cm.session_id).trim();
  return '';
}
function codexSystemText(body) { return (body && typeof body.instructions === 'string') ? body.instructions : ''; }
// Codex 的 input 是 items 数组;把 role=user 的文本都取出来
function codexUserTexts(body) {
  const input = body && body.input;
  const out = [];
  if (typeof input === 'string') out.push(input);
  if (Array.isArray(input)) for (const it of input) {
    if (!it || it.type !== 'message' || it.role !== 'user') continue;
    const c = it.content;
    if (typeof c === 'string') { out.push(c); continue; }
    if (Array.isArray(c)) {
      const t = c.filter(b => b && (b.type === 'input_text' || b.type === 'text') && b.text).map(b => b.text).join('');
      if (t) out.push(t);
    }
  }
  return out;
}
// 指纹与标签都用首条用户文本(跨轮稳定):Codex 每轮把历史消息整体重发,首条不变
function codexFirstUserText(body) { return codexUserTexts(body)[0] || ''; }

// 返回 { key, kind }:kind 标明身份是怎么来的,便于日志排查。
// key 带来源前缀(cc/cx = 官方会话 id,fp/cxf = 内容指纹),两种客户端永不撞车
function sessionIdentity(req, body, app = 'claude') {
  if (app === 'codex') {
    const header = codexHeaderSessionId(req);
    if (header) return { key: 'cx:' + header, kind: 'header' };
    const meta = codexBodySessionId(body);
    if (meta) return { key: 'cx:' + meta, kind: 'metadata' };
    const chatSystem = (body.messages || []).filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const seed = (codexSystemText(body) || chatSystem) + '\u0000' + (codexFirstUserText(body) || firstUserText(body));
    if (!seed.replace(/\u0000/g, '').trim()) return { key: 'cx-anon', kind: 'anon' };
    return { key: 'cxf:' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16), kind: 'fingerprint' };
  }
  const header = parseSessionId(req.headers['x-claude-code-session-id']);
  if (header) return { key: 'cc:' + header, kind: 'header' };
  const meta = body && body.metadata && parseSessionId(body.metadata.user_id);
  if (meta) return { key: 'cc:' + meta, kind: 'metadata' };
  const seed = bodySystemText(body) + '\u0000' + firstUserText(body);
  if (!seed.replace(/\u0000/g, '').trim()) return { key: 'anon', kind: 'anon' };
  return { key: 'fp:' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16), kind: 'fingerprint' };
}
// 会话标签:优先 system prompt 里的工作目录(CC 的 <env> 块),否则首条用户消息
function sessionLabel(body, app = 'claude') {
  if (!SESSION_LABEL) return '';
  if (app === 'codex') {
    // Codex 会在用户消息前面塞 <environment_context> / <user_instructions> 这类注入块,
    // 标签要跳过它们,取第一句真人话;全是注入块时才退回第一块
    const texts = codexUserTexts(body);
    const human = texts.find(t => !/^\s*</.test(t)) || texts[0] || '';
    const t = human.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 60) : '';
  }
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
// 立即落盘。退出路径要走这个:写盘有 1s 去抖,进程一退,窗口内的绑定就丢了
function flushSessions() {
  if (sessionsTimer) { clearTimeout(sessionsTimer); sessionsTimer = null; }
  if (!sessionsDirty) return;
  sessionsDirty = false;
  const bindings = {};
  for (const [k, v] of sessions) bindings[k] = v;
  saveJson(SESSIONS_FILE, { version: 1, bindings });
}
function saveSessionsSoon() {
  sessionsDirty = true;
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(() => { sessionsTimer = null; flushSessions(); }, 1000);
  if (sessionsTimer.unref) sessionsTimer.unref();
}
// 日志/控制台里显示的短 id:去掉来源前缀再取前 8 位,和客户端自己显示的会话号对得上
const sessionKeyOf = k => String(k || '').replace(/^(?:cc|fp|cx|cxf):/, '').slice(0, 8);

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
const providerEligible = id => !inCooldown(id) && health.eligible(id);
const retryableStatus = status => status === 429 || status >= 500;
function errorClass(status, code = '') {
  if (code) return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code) ? code.toLowerCase() : 'network_error';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream_server';
  return status >= 400 ? 'upstream_request' : '';
}
function healthStatus() {
  return { settings: { total_deadline_ms: TOTAL_DEADLINE_MS, first_header_timeout_ms: FIRST_HEADER_TIMEOUT_MS,
    stream_first_header_timeout_ms: STREAM_FIRST_HEADER_TIMEOUT_MS,
    stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS, sse_keepalive_ms: SSE_KEEPALIVE_MS,
    nonstream_total_timeout_ms: NONSTREAM_TOTAL_TIMEOUT_MS, max_attempts: MAX_ATTEMPTS, conversion_retries: CONV_RETRIES,
    cooldown_ms: COOLDOWN_MS, failure_threshold: FAILURE_THRESHOLD, recovery_threshold: RECOVERY_THRESHOLD, half_open_max_probes: 1 },
  providers: ['claude', 'codex'].flatMap(app => storeOf(app).map(p => ({ provider: p.id, app,
    enabled: p.enabled !== false, ...health.view(p.id), cooldown_until: inCooldown(p.id) ? cooldowns[p.id] : 0,
    eligible: p.enabled !== false && providerEligible(p.id) }))) };
}

// 把规则的 pool 归一化成 [{provider, model, weight}],只取本组(app)的渠道
// 池成员里"不存在/已停用"的直接跳过(池的意义就是自动绕开不可用的);
// 但单一 provider 目标即使停用也保留成成员——好让调用方给出 provider_disabled_error
// 而不是含混的 no_route_error
function poolMembers(rule, app = 'claude') {
  const group = storeOf(app);
  const raw = (rule && Array.isArray(rule.pool)) ? rule.pool : [];
  const out = [];
  for (const m of raw) {
    const id = typeof m === 'string' ? m : (m && m.provider);
    if (!id) continue;
    const p = group.find(x => x.id === id);
    if (!p || p.enabled === false) continue;
    // Codex 渠道自己就带模型名,池成员/规则没写就用它;Claude 侧是"留空即透传请求模型"
    const model = (typeof m === 'object' && m && m.model) ? m.model
      : (app === 'codex' ? (rule.model || p.model || '') : (rule.model || ''));
    const weight = typeof m === 'object' && m && Number(m.weight) > 0 ? Number(m.weight) : 1;
    out.push({ provider: p, model, weight });
  }
  if (!out.length && rule && rule.provider) {
    const p = group.find(x => x.id === rule.provider);
    if (p) out.push({ provider: p, model: app === 'codex' ? (rule.model || p.model || '') : (rule.model || ''), weight: 1 });
  }
  return out;
}
// 规则是否属于这一组。显式声明了 app 的规则只在自己那组生效;
// 没声明时:Claude 通路保持原语义(命中的规则即使没绑定渠道也照旧报错,
// 好让控制台里"渠道被删了"这种情况有明确提示);Codex 通路则把"整条规则只绑了另一组渠道"
// 视为不命中,好让后面的 Codex 规则/默认路由接手,而不是被一条 Claude 规则挡住
function ruleBelongsToApp(rule, app) {
  if (rule && rule.app) return rule.app === app;
  if (app !== 'codex') return true;
  const ids = [rule && rule.provider, ...((rule && rule.pool) || []).map(m => typeof m === 'string' ? m : (m && m.provider))]
    .filter(Boolean);
  if (!ids.length) return true;
  return ids.some(id => providerApp(id) === null || providerApp(id) === app);
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

// 从池里给这个会话挑一个渠道:冷却/熔断中的成员不参与挑选;
// 全池都不可用时退回全量兜底(宁可再试冷却渠道也不死锁)
function pickMember(rule, members, key) {
  const cands = members.filter(m => providerEligible(m.provider.id));
  const pool = cands.length ? cands : members;
  if (pool.length === 1) return pool[0];
  const strat = strategyOf(rule);
  // priority(主备):永远取池序里第一个可用渠道,主渠道冷却中才落到下一个——失败降级语义
  if (strat === 'priority') return pool[0];
  if (strat === 'random') return pool[Math.floor(Math.random() * pool.length)];
  if (strat === 'least_used') {
    let best = pool[0];
    for (const m of pool) if (activeCount(m.provider.id) < activeCount(best.provider.id)) best = m;
    return best;
  }
  const rid = (rule && rule.id) || '_';
  pools[rid] = pools[rid] || 0;
  if (strat === 'weighted') {
    // 平滑加权轮询需要跨请求保留 current;按当前候选重建,冷却恢复/新增的渠道能重新进入轮转
    const wkey = '__w_' + rid;
    const prev = Array.isArray(pools[wkey]) ? pools[wkey] : [];
    const w = pool.map(m => {
      const old = prev.find(x => x.provider.id === m.provider.id);
      return old ? { ...m, current: old.current } : { ...m, current: 0 };
    });
    pools[wkey] = w;
    return pickWeighted(w) || pool[0];
  }
  // round_robin:按会话数轮转,新会话依次落到不同渠道
  const idx = (pools[rid]++) % pool.length;
  return pool[idx];
}

// 拿到本会话该走的渠道:已有绑定且渠道仍可用 → 复用(粘性);否则挑一个并绑定
// fallbackStrategy 仅供日志兜底无规则对象时使用(default 路由也能带上配置的策略)
function resolveSessionTarget(rule, members, key, label, kind, app = 'claude', fallbackStrategy) {
  const effectiveRule = rule || { id: 'default', strategy: fallbackStrategy };
  pruneSessions();
  const now = Date.now();
  const bound = sessions.get(key);
  const touch = () => { bound.lastUsed = now; applyLabel(bound, label); };
  // 槽位请求(别名 mixr-*)只代表"这一条请求"照槽位表走,不代表对话换了渠道:
  // 手动钉定不该劫持它,否则会把槽位渠道的落点模型发给被钉定的那个渠道(400 或记到错账号)
  const slotRequest = String((rule && rule.id) || '').startsWith('slot:');
  if (bound) {
    // 手动钉定压过策略:哪怕这个渠道不在池里也照走——钉定的意义就是"这个对话我要它走这里"
    if (bound.pinned && !slotRequest) {
      const p = storeOf(app).find(x => x.id === bound.providerId);
      if (p && p.enabled !== false && !inCooldown(bound.providerId)) {
        touch();
        return { member: { provider: p, model: bound.model || (rule && rule.model) || '', weight: 1 }, sticky: true, rebind: false };
      }
    }
    const m = members.find(x => x.provider.id === bound.providerId);
    if (m && providerEligible(bound.providerId)) {
      touch();
      return { member: m, sticky: true, rebind: false };
    }
  }
  const picked = pickMember(effectiveRule, members, key);
  return { member: picked, sticky: !!bound, rebind: true };
}

const sessionEntry = (key, kind, members, label, app = 'claude') => {
  let s = sessions.get(key);
  if (!s) {
    s = { app, providerId: '', model: '', ruleId: '', label: label || '', kind, created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false };
    sessions.set(key, s);
  }
  if (kind && s.kind !== kind) s.kind = kind;
  if (!s.app) s.app = app;
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
    out.push({ key: k, short: sessionKeyOf(k), app: v.app || 'claude', kind: v.kind || '', label: v.label || '',
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

// 内容分流(when.body)的匹配文本:system/instructions + 最后一条消息。
// 不用整包 body——历史每轮重发,对话里出现过的短语会永久劫持路由(实测:一条引用了规则原文的
// 子代理报告进来后,主槽请求全部被判给内容分流规则)。压缩类请求的指令就在最后一条消息里。
function bodyRouteText(body) {
  const b = body && typeof body === 'object' ? body : {};
  const parts = [];
  const sys = b.system ?? b.instructions;
  if (typeof sys === 'string') parts.push(sys);
  else if (Array.isArray(sys)) {
    for (const x of sys) {
      if (typeof x === 'string') parts.push(x);
      else if (x && x.type === 'text') parts.push(x.text || '');
    }
  }
  const msgs = Array.isArray(b.messages) ? b.messages : (Array.isArray(b.input) ? b.input : []);
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  if (last) {
    const c = last.content ?? last.text ?? '';
    parts.push(typeof c === 'string' ? c : JSON.stringify(c));
  }
  // 压缩指令拼在最后一条 user 消息里,其后可能还挂着 system 通告(如 ToolSearch 工具清单)——
  // 实测 2.1.270 每条主链请求末尾都带 system 通告,只看数组末尾会漏掉全部真实 Claude Code 请求。
  // 补上最后一条 user 消息;历史消息依旧不进匹配文本,防劫持边界不变。
  let lastUser = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { lastUser = msgs[i]; break; }
  }
  if (lastUser && lastUser !== last) {
    const c = lastUser.content ?? lastUser.text ?? '';
    parts.push(typeof c === 'string' ? c : JSON.stringify(c));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------- 路由解析
// match 为请求模型名的子串,逗号分隔多个,大小写不敏感
// 先按 priority 降序(同值保持数组顺序),命中首个启用且满足 when 的规则
// 路由目标来自哪一组由端点决定:Anthropic 端点取 Claude 组,OpenAI 端点取 Codex 组
function matchWhen(rule, ctx) {
  const w = (rule && rule.when) || {};
  for (const field of ['session', 'ua', 'token', 'body']) {
    const want = String(w[field] || '').trim().toLowerCase();
    if (!want) continue;
    // body 只在真有规则要匹配时才由调用方拼出来(压缩这类请求体可以到上百 KB)
    const have = field === 'body'
      ? (typeof ctx.bodyText === 'function' ? ctx.bodyText() : '')
      : (ctx && ctx[field]) || '';
    if (!String(have).toLowerCase().includes(want)) return false;
  }
  return true;
}
function resolveRoute(modelIn, ctx = {}, app = 'claude') {
  const m = String(modelIn || '').toLowerCase();
  const order = routes.rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((Number(b.r.priority) || 0) - (Number(a.r.priority) || 0)) || (a.i - b.i));
  // 内容分流:带 when.body 的规则按请求内容命中,先于槽位别名与普通规则评估。
  // 同一个模型名底下可能干着不同的事(Claude Code 的压缩请求走的还是主模型别名),
  // 只有请求体认得出来;match 留空 = 不限模型。
  for (const { r } of order) {
    if (!r.enabled || !String((r.when && r.when.body) || '').trim()) continue;
    if (!ruleBelongsToApp(r, app)) continue;
    if (!matchWhen(r, ctx)) continue;
    const hits = String(r.match || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (hits.length && !hits.some(h => m.includes(h))) continue;
    const members = poolMembers(r, app);
    return { rule: r, members, content: true,
      provider: members.length ? members[0].provider : null,
      model: (members.length ? members[0].model : r.model) || modelIn, strategy: strategyOf(r) };
  }
  // 槽位别名精确匹配,优先于一切规则(客户端槽位 env 写的就是别名,不能被子串规则截胡)
  const slot = resolveSlot(app, modelIn);
  if (slot) {
    const members = poolMembers(slot.rule, app);
    return { rule: slot.rule, members, slot: slot.name,
      provider: members.length ? members[0].provider : null,
      model: (members.length ? members[0].model : slot.model) || modelIn, strategy: 'round_robin' };
  }
  for (const { r } of order) {
    if (!r.enabled) continue;
    const hits = String(r.match || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!hits.length || !hits.some(h => m.includes(h))) continue;
    if (!ruleBelongsToApp(r, app)) continue;
    if (!matchWhen(r, ctx)) continue;
    const members = poolMembers(r, app);
    return { rule: r, members, provider: members.length ? members[0].provider : null,
      model: (members.length ? members[0].model : r.model) || modelIn, strategy: strategyOf(r) };
  }
  const d = routes.default || {};
  const members = poolMembers(d, app);
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

// OpenAI 端点(Codex)要 OpenAI 形状的错误体,回 Anthropic 形状它只会打印一句无法解析的报错
function openaiError(res, status, type, message) {
  const body = JSON.stringify({ error: { message, type: String(type).replace(/_error$/, ''), code: type } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
// 按端点协议选错误体
const protoError = (res, app, status, type, message) =>
  app === 'codex' ? openaiError(res, status, type, message) : anthropicError(res, status, type, message);

// HTTP 头只允许 latin-1:渠道名等注入头之前消洗掉非 ASCII,避免 ERR_INVALID_CHAR 打崩进程
const safeHeader = s => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim();

// base_url 必须是合法 http(s) URL;坏值存进库会埋雷到首次转发才炸
function validBaseUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

// 从 SSE/JSON 响应文本里尽力抠 usage(输入来自 message_start,输出来自 message_delta)
function extractUsage(text) {
  // 三个字段一律取最后一次出现:Anthropic 系网关的 message_start 常给 usage:0,真值在流末尾的
  // message_delta——首匹配抠到 0,glm-5.3 直通 677/692 条 in/out 全 0 就是这么丢的
  return {
    in: lastNum(text, /"input_tokens"\s*:\s*(\d+)/),
    out: lastNum(text, /"output_tokens"\s*:\s*(\d+)/),
    cache_read: lastNum(text, /"cache_read_input_tokens"\s*:\s*(\d+)/),
  };
}

// 取文本里该字段"最后一次"出现的值(OpenAI 系的 usage 在流的末尾才齐;中途事件可能带旧值)
function lastNum(text, re) {
  const g = new RegExp(re.source, 'g');
  let m, v = 0;
  while ((m = g.exec(text)) !== null) v = Number(m[1]);
  return v;
}
// OpenAI 两种协议的 usage 抽取(流式累积文本与整包 JSON 都适用)
//   responses: input_tokens / output_tokens / input_tokens_details.cached_tokens
//   chat:      prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
function extractUsageOpenAI(kind, text) {
  const u = kind === 'responses'
    ? { in: lastNum(text, /"input_tokens"\s*:\s*(\d+)/), out: lastNum(text, /"output_tokens"\s*:\s*(\d+)/) }
    : { in: lastNum(text, /"prompt_tokens"\s*:\s*(\d+)/), out: lastNum(text, /"completion_tokens"\s*:\s*(\d+)/) };
  u.cache_read = lastNum(text, /"cached_tokens"\s*:\s*(\d+)/);
  return u;
}
const extractUsageFor = (wire, text) => wire === 'anthropic' ? extractUsage(text) : extractUsageOpenAI(wire, text);

// ---------------------------------------------------------------- OpenAI 协议翻译(responses ⇄ chat)
// Codex 只说 /v1/responses;上游若只开 chat/completions(如 GLM 系网关),由代理现场翻译。
// 逻辑来自本机实战过的独立代理,踩过的坑照旧:首个文本 delta 之前必须先发 output_item.added,
// 否则 codex 报 "OutputTextDelta without active item";工具调用整包下发即可,分片增量非必需。
const randId = prefix => prefix + crypto.randomBytes(8).toString('hex');

function chatImagePart(b) {
  const url = b.image_url_data_url || b.image_url || b.url;
  if (typeof url !== 'string' || !url) return null;
  if (typeof b.image_url === 'object' && b.image_url && b.image_url.url) return { type: 'image_url', image_url: { url: b.image_url.url } };
  return { type: 'image_url', image_url: { url } };
}
// 一条 responses input item → 若干条 chat messages(就地 push)
function itemToChatMessages(item, messages, opts) {
  if (typeof item === 'string') { messages.push({ role: 'user', content: item }); return; }
  if (!item || typeof item !== 'object') return;
  switch (item.type) {
    case 'message': {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      const c = item.content;
      if (typeof c === 'string') { messages.push({ role, content: c }); return; }
      if (!Array.isArray(c)) { messages.push({ role, content: '' }); return; }
      const texts = [], images = [];
      for (const b of c) {
        if (typeof b === 'string') { texts.push(b); continue; }
        if (!b) continue;
        if (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') texts.push(b.text || '');
        else if (b.type === 'input_image' || b.type === 'image_url') {
          const part = chatImagePart(b);
          if (part && !opts.dropImages) images.push(part);
          else texts.push('[图片:该渠道按配置丢弃图片,模型看不到它]');
        }
      }
      const content = images.length
        ? [...(texts.length ? [{ type: 'text', text: texts.join('\n') }] : []), ...images]
        : texts.join('\n');
      messages.push({ role, content });
      return;
    }
    case 'function_call':
      // 助手上一轮的工具调用 → assistant.tool_calls
      messages.push({ role: 'assistant', content: '',
        tool_calls: [{ id: item.call_id || item.id || randId('call_'), type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' } }] });
      return;
    case 'function_call_output': {
      let out = item.output;
      // 个别客户端把 output 包成 {content:[{text}]} 对象
      if (out && typeof out === 'object' && Array.isArray(out.content)) out = out.content.map(b => (b && b.text) || '').join('\n');
      if (typeof out !== 'string') out = JSON.stringify(out === undefined ? '' : out);
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id || '', content: out });
      return;
    }
    case 'reasoning':
    case 'reasoning_summary':
      return;  // chat 协议不认 reasoning item,丢弃(模型每轮自行思考)
    default:
      return;  // 未知 item(local_shell_call / web_search_call / computer_call 等)忽略,避免上游 400
  }
}
// responses 工具选择 → chat 形状(Codex 默认发字符串 "auto")
function chatToolChoice(tc) {
  if (!tc || typeof tc !== 'object') return tc === undefined ? 'auto' : tc;
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'function' && tc.function) return tc;
  return 'auto';
}
// 请求方向:responses → chat/completions
function responsesToChat(body, provider) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (Array.isArray(input)) for (const it of input) itemToChatMessages(it, messages, { dropImages: !!(provider && provider.drop_images) });
  else if (typeof input === 'string') messages.push({ role: 'user', content: input });
  if (!messages.some(m => m.role === 'user')) messages.push({ role: 'user', content: '(empty request)' });

  const out = { model: body.model, messages, stream: body.stream !== false };
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (out.stream) out.stream_options = { include_usage: true };  // 统计需要 usage,得主动要
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools
      .filter(t => t && t.type === 'function' && t.name)
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
    if (tools.length) {
      out.tools = tools;
      if (body.tool_choice != null) out.tool_choice = chatToolChoice(body.tool_choice);
      if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls;
    }
  }
  return out;
}
const responsesUsage = u => {
  const cached = (u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: (u && u.prompt_tokens) || 0,
    output_tokens: (u && u.completion_tokens) || 0,
    total_tokens: (u && u.total_tokens) || 0,
    ...(cached ? { input_tokens_details: { cached_tokens: cached } } : {}),
  };
};
// 响应方向(非流式):chat JSON → responses JSON
function chatJsonToResponses(j, model) {
  const msg = ((j && j.choices && j.choices[0]) || {}).message || {};
  const output = [];
  if (msg.content) output.push({ type: 'message', id: randId('msg_'), role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: String(msg.content), annotations: [] }] });
  for (const [i, tc] of (msg.tool_calls || []).entries()) {
    output.push({ type: 'function_call', id: 'fc_' + i, call_id: tc.id || ('call_' + i),
      name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '{}', status: 'completed' });
  }
  return { id: (j && j.id) || randId('resp_'), object: 'response', status: 'completed', model, output, usage: responsesUsage(j && j.usage) };
}
// 把一个完整的 responses 对象摊成 SSE 事件序列(客户端要流式、上游却整包回了 JSON 时用)
function emitResponsesSse(res, resp, extraHeaders) {
  const sse = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
  // 注意顺序:extraHeaders 里带着上游的 Content-Type(可能是 application/json),必须让它先铺、再由我们盖掉
  res.writeHead(200, { ...(extraHeaders || {}), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sse({ type: 'response.created', response: { id: resp.id, object: 'response', status: 'in_progress', model: resp.model, output: [] } });
  (resp.output || []).forEach((item, i) => {
    sse({ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress', content: item.type === 'message' ? [] : undefined } });
    if (item.type === 'message') {
      const text = ((item.content || [])[0] || {}).text || '';
      sse({ type: 'response.content_part.added', item_id: item.id, output_index: i, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      if (text) sse({ type: 'response.output_text.delta', item_id: item.id, output_index: i, content_index: 0, delta: text });
      sse({ type: 'response.output_text.done', item_id: item.id, output_index: i, content_index: 0, text });
      sse({ type: 'response.content_part.done', item_id: item.id, output_index: i, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    }
    sse({ type: 'response.output_item.done', output_index: i, item });
  });
  sse({ type: 'response.completed', response: resp });
  try { res.end(); } catch {}
}
// 响应方向(流式):chat SSE → responses SSE。onUsage 收尾时回报 usage(给日志/统计)
function streamChatAsResponses(cres, res, model, onUsage, extraHeaders) {
  const sse = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
  // 注意顺序:extraHeaders 里带着上游的 Content-Type,必须让它先铺、再由我们盖掉
  res.writeHead(200, { ...(extraHeaders || {}), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const respId = randId('resp_'), itemId = randId('msg_');
  sse({ type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress', model, output: [] } });

  let text = '', buffer = '', usage = null, finished = false, itemSent = false;
  const toolCalls = new Map();  // index -> {id, name, args}

  const ensureItem = () => {
    if (itemSent) return;
    itemSent = true;
    sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] } });
    sse({ type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } });
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    const output = [];
    if (text) {
      ensureItem();
      sse({ type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text });
      sse({ type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text, annotations: [] } });
      const item = { type: 'message', id: itemId, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] };
      sse({ type: 'response.output_item.done', output_index: 0, item });
      output.push(item);
    }
    for (const [i, tc] of toolCalls) {
      const idx = output.length;
      const item = { type: 'function_call', id: 'fc_' + respId + '_' + i, call_id: tc.id || ('call_' + respId + '_' + i),
        name: tc.name, arguments: tc.args || '{}', status: 'completed' };
      sse({ type: 'response.output_item.added', output_index: idx, item: { ...item, status: 'in_progress' } });
      sse({ type: 'response.output_item.done', output_index: idx, item });
      output.push(item);
    }
    sse({ type: 'response.completed', response: { id: respId, object: 'response', status: 'completed', model, output, usage: responsesUsage(usage) } });
    if (onUsage) onUsage(responsesUsage(usage));
    try { res.end(); } catch {}
  };

  cres.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { finish(); return; }
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.usage) usage = data.usage;
      const delta = ((data.choices || [])[0] || {}).delta;
      if (!delta) continue;
      if (delta.content) {
        ensureItem();
        text += delta.content;
        sse({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: delta.content });
      }
      for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : [])) {
        const idx = tc.index ?? 0;
        const acc = toolCalls.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function && tc.function.name) acc.name = tc.function.name;
        if (tc.function && tc.function.arguments) acc.args += tc.function.arguments;
        toolCalls.set(idx, acc);
      }
    }
  });
  cres.on('end', finish);
  cres.on('error', finish);
}

// ---------------------------------------------------------------- 代理服务
// 端点 → 客户端组与协议:Claude 组说 Anthropic,Codex 组说 OpenAI
const ENDPOINTS = [
  { re: /^\/v1\/messages\/?$/, app: 'claude', kind: 'messages', path: '/v1/messages' },
  { re: /^\/v1\/messages\/count_tokens\/?$/, app: 'claude', kind: 'count_tokens', path: '/v1/messages/count_tokens' },
  { re: /^\/v1\/responses\/?$/, app: 'codex', kind: 'responses', path: '/v1/responses' },
  { re: /^\/v1\/chat\/completions\/?$/, app: 'codex', kind: 'chat/completions', path: '/v1/chat/completions' },
];
function classifyProxyRequest(req) {
  const p = String(req.url || '').split('?')[0];
  for (const e of ENDPOINTS) if (e.re.test(p)) return e;
  return null;
}
// 本渠道对这次请求该说哪种协议:Claude 组默认 Anthropic,标了 wire_api='responses' 或
// 'chat' 的渠道(只挂 Codex/OpenAI 型通道的模型,如 anyrouter 的 gpt-6-astra、tokenrhythm
// 的 glm-5.3-flash)由代理现场翻译;Codex 组按渠道的 wire_api(都是 responses:原样转发;
// chat:只开 completions 的网关,由代理现场翻译)
const wireOf = (provider, app) => app === 'claude'
  ? (provider.wire_api === 'responses' || provider.wire_api === 'chat' ? provider.wire_api : 'anthropic')
  : (provider.wire_api === 'chat' ? 'chat' : 'responses');
const upstreamPathOf = (wire, ep) => wire === 'anthropic' ? ep.path : (wire === 'chat' ? '/v1/chat/completions' : '/v1/responses');
// Channel bases may already end in /v1. Keep custom prefixes, append the version once.
const joinUpstreamPath = (pathname, endpoint) => pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + endpoint;

// GET /v1/models:只读清单(Codex 组渠道的模型 + 路由目标模型 + Codex 槽位别名),给会探模型的客户端用
function modelList() {
  const seen = new Set(), data = [];
  const add = (id, owner) => {
    const k = id + '\u0000' + owner;
    if (!id || seen.has(k)) return;
    seen.add(k);
    data.push({ id, object: 'model', owned_by: owner });
  };
  for (const p of store.codex) if (p.enabled !== false && p.model) add(p.model, p.name);
  for (const [name, s] of Object.entries(slotMap.codex || {})) {
    if (s && s.provider) add(slotAlias('codex', name), 'slot:' + name);
  }
  for (const r of [...(routes.rules || []), routes.default || {}]) {
    if (!r) continue;
    if (r.model) add(r.model, 'route');
    for (const m of r.pool || []) if (typeof m === 'object' && m && m.model) add(m.model, 'route');
  }
  return { object: 'list', data };
}

function proxyHandler(req, res) {
  const pathOnly = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && (pathOnly === '/healthz' || pathOnly === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'mixrouter', version: VERSION }));
  }
  // 客户端探活:HEAD 四个端点都回 200;GET /v1/models 给个只读模型清单
  if (req.method === 'HEAD' && ENDPOINTS.some(e => e.re.test(pathOnly))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end();
  }
  if (req.method === 'GET' && pathOnly === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(modelList()));
  }
  const ep = classifyProxyRequest(req);
  if (!ep) return protoError(res, 'claude', 404, 'not_found_error',
    `mixrouter 支持 POST /v1/messages、/v1/messages/count_tokens(Claude)与 /v1/responses、/v1/chat/completions(Codex),收到 ${req.method} ${req.url}`);

  const chunks = []; let size = 0; let rejected = false;
  const overLimit = () => {
    if (rejected) return;
    rejected = true;
    try { if (!res.headersSent) protoError(res, ep.app, 413, 'invalid_request_error', `请求体超过 ${Math.floor(BODY_LIMIT / 1024 / 1024)}MB 上限`); } catch {}
    // 不炸 socket:继续排水丢弃剩余数据,让 413 干净送达(炸连接会让客户端只看到 EPIPE)
    req.removeAllListeners('data');
    req.resume();
  };
  req.on('data', c => { size += c.length; if (size > BODY_LIMIT) return overLimit(); chunks.push(c); });
  req.on('end', () => {
    if (rejected) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return protoError(res, ep.app, 400, 'invalid_request_error', '请求体不是合法 JSON'); }

    const modelIn = body.model || '';
    const ident = sessionIdentity(req, body, ep.app);
    const label = sessionLabel(body, ep.app);
    // 内容分流(when.body)只看「system/instructions + 最后一条消息」,不看整段历史:
    // 整包 body 里带着全部对话,历史里偶然出现一次触发短语(比如把规则原文引用了一遍)
    // 就会让此后每条请求都改道,而且是永久性的——历史每轮都重发。实测踩过。
    // 压缩类请求的指令就在最后一条消息里,照旧命中。只在真有 when.body 规则时才拼。
    let routeLower;
    const bodyText = () => routeLower ?? (routeLower = bodyRouteText(body).toLowerCase());
    const resolved = resolveRoute(modelIn, {
      session: ident.key, ua: req.headers['user-agent'], token: clientToken(req), bodyText,
    }, ep.app);
    // 单一目标停用 → 明确分型(池会自动跳过停用成员,不会落到这)
    if (resolved.members.length === 1 && resolved.members[0].provider.enabled === false)
      return protoError(res, ep.app, 503, 'provider_disabled_error', `路由命中的渠道 "${resolved.members[0].provider.name}" 已停用`);
    // chat 协议客户端只能落到 chat 上游;responses 客户端两种上游都能落(chat 上游由代理翻译)
    let members = resolved.members;
    if (ep.kind === 'chat/completions' && members.length) {
      const chatOnly = members.filter(m => wireOf(m.provider, ep.app) === 'chat');
      if (!chatOnly.length) return protoError(res, ep.app, 400, 'wire_api_mismatch_error',
        '路由命中的 Codex 渠道都是 responses 协议,收不了 /v1/chat/completions;把渠道 wire_api 改成 chat,或让客户端改用 /v1/responses');
      members = chatOnly;
    }
    if (!members.length) return protoError(res, ep.app, 503, 'no_route_error', resolved.slot
      ? `槽位 "${resolved.slot}" 的别名 "${modelIn}" 已无可用渠道:绑定的渠道可能已被删除,请在控制台重新选择槽位目标`
      : ep.app === 'codex'
      ? `模型 "${modelIn}" 没有匹配的 Codex 渠道。请在控制台 http://127.0.0.1:${UI_PORT} 的「路由」页为它配目标(要选 Codex 组渠道)`
      : `模型 "${modelIn}" 没有匹配的路由,或路由未绑定 Claude 渠道。请在控制台 http://127.0.0.1:${UI_PORT} 配置路由`);

    // 本会话锁定的渠道优先,其余池成员依次作后备(只在还没给客户端写字节时才会换)
    // 内容分流命中的请求不参与会话粘性:它只代表"这一条请求"走那条路,不代表对话换了渠道
    const target = resolved.content
      ? { member: members[0], sticky: false, rebind: false }
      : resolveSessionTarget(resolved.rule, members, ident.key, label, ident.kind, ep.app, resolved.strategy);
    const sess = sessionEntry(ident.key, ident.kind, members, label, ep.app);
    const wasSticky = target.sticky && !target.rebind;
    const ordered = [target.member]
      .concat(members.filter(m => m.provider.id !== target.member.provider.id))
      .slice(0, Math.max(1, MAX_ATTEMPTS));

    // 识图中继:anthropic 直通上游收到 image 块直接 500,chat 桥不认图,模型没机会跑
    // grok-vision → 用户贴图=整轮报废。落盘换指路文本;responses 线原生转 input_image,不动。
    if (IMAGE_RELAY_ON && ep.app === 'claude' && wireOf(ordered[0].provider, ep.app) !== 'responses') {
      const relayed = imageRelay.rewrite(body);
      if (relayed) console.log(`[vision-relay] 替换 ${relayed} 张图片 → ${imageRelay.INBOX} (session ${sessionKeyOf(ident.key)})`);
    }

    const started = Date.now();
    const rawLen = chunks.reduce((n, c) => n + c.length, 0);
    // 转换到 responses 上游时,同一渠道内允许的轮换重试次数(见 CONV_RETRIES)
    let convRetries = 0;
    const entry = { ts: new Date().toISOString(), app: ep.app, provider: '', model_in: modelIn, model_out: '',
      session: sessionKeyOf(ident.key), session_kind: ident.kind, rule: (resolved.rule && resolved.rule.id) || 'default',
      pool: members.length, strategy: resolved.strategy, sticky: wasSticky, attempts: 0, failover: false,
      in: 0, out: 0, cache_read: 0, ms: 0, status: 0, stream: !!body.stream,
      kind: ep.kind, wire: '', err: '', err_class: '' };

    // 单次请求的收尾:计数入会话、写日志、收响应(所有终止路径都走这里,避免漏记)
    let finalized = false;
    // 已提交的 SSE 响应定期补一行注释:客户端按"多久没收到字节"判本地超时,上游慢慢推理时
    // 这条通道会一直沉默,补一行它就知道连接还活着(注释行是标准 SSE,客户端会跳过)。
    // **只在响应真的提交给客户端之后才启动**——提交前写哪怕一个字节,都会毁掉"一个字节都没写给
    // 客户端就整条重试"的前提。所以这里不做轮询判断(getHeader 在响应头发出后就取不到了),
    // 而是在每个提交点上显式 startKeepAlive()。
    let keepAliveTimer = null;
    const stopKeepAlive = () => { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } };
    const startKeepAlive = () => {
      if (!SSE_KEEPALIVE_MS || keepAliveTimer) return;
      keepAliveTimer = setInterval(() => {
        if (finalized || res.writableEnded || res.destroyed) return stopKeepAlive();
        try { res.write(': keep-alive\n\n'); } catch { stopKeepAlive(); }
      }, SSE_KEEPALIVE_MS);
      if (keepAliveTimer.unref) keepAliveTimer.unref(); // 兜底计时器不该成为进程退不出去的理由
    };
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      stopKeepAlive();
      sess.reqs = (sess.reqs || 0) + 1;
      sess.inTok = (sess.inTok || 0) + (entry.in || 0);
      sess.outTok = (sess.outTok || 0) + (entry.out || 0);
      sess.lastUsed = Date.now();
      saveSessionsSoon();
      logRequest(entry);
    };
    const sendErr = (status, type, message, errClass) => {
      entry.status = status;
      if (errClass) entry.err_class = errClass;
      if (!res.headersSent) protoError(res, ep.app, status, type, message);
      else { try { res.end(); } catch {} }
    };
    // 客户端断开(ESC 取消/进程退出):掐掉在途的上游请求并按取消收尾——
    // 不烧已无人接收的渠道额度,也不把客户端取消算成渠道失败;正常完成后 finalized 已置位,这里自然短路
    let clientClosed = false, activeReq = null, activeRes = null, releaseCurrent = null;
    // 端到端总预算已经用尽:后面的重试/换渠道都不许再打上游,收尾按 timeout 记
    let deadlineHit = false;
    // 当前这一次尝试的看门狗计时器。放弃本次尝试去重试时必须先清掉,否则它会在 240s 之后
    // 对一条早已收尾的请求开火,把好端端的成功条目改写成 timeout(还会钉住事件循环)。
    let activeTimers = null;
    const clearAttemptTimers = () => {
      if (!activeTimers) return;
      clearTimeout(activeTimers.bodyTimer); clearTimeout(activeTimers.deadlineTimer);
      activeTimers = null;
    };
    res.on('close', () => {
      // writableFinished=响应已正常写完,只是 close 事件走 nextTick 先到了(它比 promise
      // 微任务还早)。这里若不放行,每条转换流的成功都会被记成 499 client closed + usage 0
      if (finalized || res.writableFinished) return;
      clientClosed = true;
      clearAttemptTimers();
      if (releaseCurrent) releaseCurrent('cancelled');
      try { if (activeReq) activeReq.destroy(); } catch {}
      try { if (activeRes) activeRes.destroy(); } catch {}
      entry.status = entry.status || 499;
      entry.err = entry.err || 'client closed';
      entry.err_class = 'cancelled';
      entry.ms = Date.now() - started;
      finalize();
    });

    function tryCandidate(i) {
      // 端到端总预算已经用尽(客户端那条响应早已收尾):再打上游只是替没人要的请求烧额度
      if (deadlineHit) return;
      const member = ordered[i];
      const provider = member.provider;
      const wire = wireOf(provider, ep.app);
      // claude 客户端落到 responses/chat 型渠道:本进程内翻译
      // (lib/wire-responses.js 翻 Responses,lib/wire-chat.js 翻 Chat Completions)
      const conv = (wire === 'responses' || wire === 'chat') && ep.kind === 'messages';
      const sessKey = sessionKeyOf(ident.key);
      // 本次尝试的熔断许可:请求到达终态(成功/失败/取消)时归还,半开探测名额不泄漏
      const breaker = health.acquire(provider.id);
      const releaseBreaker = (outcome, error = '', status = 0) => {
        if (breaker) breaker(outcome, error, status);
      };
      releaseCurrent = releaseBreaker;
      // count_tokens 在 responses 线上没有对应端点,本地按体积估一个(与旧转换代理同口径)
      if (ep.kind === 'count_tokens' && wire !== 'anthropic') {
        releaseBreaker('success', '', 200);
        entry.attempts = i + 1; entry.provider = provider.name;
        entry.model_out = member.model || modelIn; entry.wire = wire; entry.status = 200;
        entry.in = Math.max(1, Math.ceil(rawLen / 4));
        finalize();
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'application/json', 'x-mixrouter-app': ep.app,
          'x-mixrouter-provider': safeHeader(provider.name), 'x-mixrouter-model': safeHeader(member.model || modelIn),
          'x-mixrouter-session': safeHeader(sessKey),
        });
        return res.end(JSON.stringify({ input_tokens: entry.in }));
      }
      // 发往上游的请求形状:anthropic 直通与两条翻译线(conv 在转换层写死、chat 桥在
      // responsesToChat 里写死)一律转成流式——非流上游要等整篇生成完才发响应头,大上下文
      // 压缩类请求(Claude Code 的 auto-compact 正是非流+全量历史)会稳定撞首字节超时再被
      // 客户端重试,而上游照常跑完照常扣费,requests.jsonl 里 123 发全挂在首字节超时就是这么
      // 来的。responses/chat 直通维持客户端原形状。
      const upstreamStream = ((wire === 'anthropic' && ep.kind === 'messages') || conv || (wire === 'chat' && ep.kind === 'responses')) ? true : !!body.stream;
      const headers = wire === 'anthropic' ? buildUpstreamHeaders(provider, req) : buildOpenAiHeaders(provider, req, upstreamStream);
      // [1M] 后缀与 beta 头只对 Anthropic 上游有意义;Responses 上游收的是裸名
      const model = wire === 'anthropic' ? applyModel(member.model || modelIn, headers) : wireResponses.stripModelSuffix(member.model || modelIn);
      // prompt_cache_key 的渠道亲和(new-api 系)只对 responses 线有意义,chat 线没有这个概念
      const convKey = conv && wire === 'responses' ? convCacheKey(sessKey, provider.id, convCacheGen(sessKey, provider.id)) : '';
      // 上游是 Codex 型通道时按 Codex 客户端的样子说话(claude-cli 的 UA 会被这类网关另眼看待);
      // chat 型网关走 buildOpenAiHeaders 的默认 UA,不需要这层伪装
      if (conv && wire === 'responses') headers['User-Agent'] = safeHeader(provider.ua) || DEFAULT_UA_CODEX;
      const outBody = (wire === 'chat' && ep.kind === 'responses')
        ? JSON.stringify(responsesToChat({ ...body, model }, provider))
        : (wire === 'chat' && ep.kind === 'messages')
        ? JSON.stringify(wireChat.anthropicToChat({ ...body, model }))
        : conv
        ? JSON.stringify(wireResponses.anthropicToResponses({ ...body, model }, { promptCacheKey: convKey }))
        : wire === 'anthropic' && ep.kind === 'messages'
        ? JSON.stringify({ ...body, model, stream: true }) // 见 upstreamStream 注释:非流客户端由响应侧攒整包回
        : JSON.stringify({ ...body, model });
      entry.attempts = i + 1;
      entry.provider = provider.name;
      entry.model_out = model;
      entry.wire = wire;

      const upstream = new URL(provider.base_url);
      const transport = upstream.protocol === 'https:' ? https : http;
      let done = false;
      // 本次尝试等响应头的预算:按发往上游的形状算(见 upstreamStream)——恒流式后上游一
      // 接受就发头,给短预算即可;「等整篇生成完才发头」的形状只剩 responses/chat 直通才有可能
      const firstHeaderMs = firstHeaderTimeoutFor(upstreamStream);
      // 还有后备渠道时,把这次失败记到冷却里再换下一个
      const nextOrFail = (reason, errMsg, errClass) => {
        // 客户端已断开:重试没有意义,也别把取消算成渠道失败
        if (clientClosed) {
          if (!finalized) {
            entry.status = 499; entry.err = errMsg || 'client closed'; entry.err_class = 'cancelled';
            entry.ms = Date.now() - started; finalize();
          }
          return;
        }
        markCooldown(provider.id, reason);
        releaseBreaker('failure', errMsg, reason || 0);
        entry.err_class = errClass || errorClass(reason || 0, '') || 'network_error';
        if (i + 1 < ordered.length) { entry.failover = true; return tryCandidate(i + 1); }
        entry.ms = Date.now() - started; entry.err = errMsg;
        entry.status = entry.status || 502;
        finalize();
        sendErr(entry.status, 'api_error', `上游 ${provider.name} 请求失败: ${errMsg}`, entry.err_class || 'upstream_server');
      };
      const creq = transport.request({
        protocol: upstream.protocol, hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: joinUpstreamPath(upstream.pathname, upstreamPathOf(wire, ep)),
        method: 'POST', headers,
        agent: upstreamAgent(upstream.protocol),
        // 首字节(响应头)超时;流式与非流式预算不同(见 firstHeaderTimeoutFor),
        // 之后再由空闲看门狗、非流式 body 计时和端到端总 deadline 兜住
        timeout: firstHeaderMs,
      }, cres => {
        if (done) return;
        activeRes = cres;
        // 上游整体性故障(5xx / 限流)时,趁还没给客户端写任何字节重来:
        // 转换场景先在同一个渠道里换一代 prompt_cache_key(坏上游渠道会被亲和钉住),
        // 次数用完再换池里的下一个渠道
        if ((cres.statusCode >= 500 || cres.statusCode === 429) && ((conv && convRetries < CONV_RETRIES) || i + 1 < ordered.length)) {
          done = true;
          cres.resume(); // 排水丢弃,避免占住 socket
          // 这次尝试作废,先拆掉它的看门狗再去打下一个渠道
          clearAttemptTimers();
          // 换 cache 代际只对 responses 线有意义(new-api 的渠道亲和);chat 线原样重打一次
          if (conv && convRetries < CONV_RETRIES) { convRetries++; if (wire === 'responses') rotateConvCacheGen(sessKey, provider.id); releaseBreaker('failure', `http ${cres.statusCode}`, cres.statusCode); return tryCandidate(i); }
          return nextOrFail(cres.statusCode, `HTTP ${cres.statusCode}`);
        }
        done = true;
        entry.status = cres.statusCode;
        // 非重试类 HTTP 错误证明渠道连通/鉴权在正常工作,记为失败冷却但熔断不累计
        if (cres.statusCode >= 400) {
          markCooldown(provider.id, cres.statusCode);
          entry.err_class = errorClass(cres.statusCode, '');
          releaseBreaker('rejected', '', cres.statusCode);
        } else {
          releaseBreaker('success', '', cres.statusCode);
        }
        entry.sticky = wasSticky && !entry.failover;
        // 落到这个渠道就把它记进会话(含失败转移后重新绑定),后续请求继续粘它。
        // 槽位请求例外:一条 haiku 起标题请求就把整个对话挪到槽位渠道的话,下一条主模型请求
        // 会跟着跑偏,同一对话内的 prompt 缓存被打断(与 README 的承诺相反)。
        if (cres.statusCode < 400 && !resolved.content && !resolved.slot && (sess.providerId !== provider.id || entry.failover)) {
          sess.providerId = provider.id; sess.model = model;
          sess.ruleId = (resolved.rule && resolved.rule.id) || 'default';
        }
        const ct = String(cres.headers['content-type'] || 'application/json');
        const isSse = ct.includes('text/event-stream');
        // 非流式总超时:从拿到响应头起算,整个 body 拖过上限就掐断
        const bodyTimer = !isSse && NONSTREAM_TOTAL_TIMEOUT_MS ? setTimeout(() => {
          try { cres.destroy(new Error('body timeout')); } catch {}
        }, NONSTREAM_TOTAL_TIMEOUT_MS) : null;
        // 端到端总 deadline:从客户端请求到达起算,**流式也一样管**。以前流式只有"字节间空闲"
        // 一条约束,慢慢滴的流能一直拖着;而客户端 300s 早就放弃了,我们还在替一条没人接收的
        // 响应占着上游连接和渠道额度。这里是整个预算的最外层。
        // 预算随请求体放大:大上下文压缩请求上游实测 224~286s 才跑完,固定 240s 掐断时上游
        // 照样计费(渠道面板实测每发 $0.94~0.99),等于白烧。按体积≈每 token 放 2ms、封顶
        // 再加 10 分钟;客户端真断开由 res.on('close') 立刻掐,放宽不会替没人接收的请求烧额度。
        const deadlineMs = TOTAL_DEADLINE_MS + Math.min(600000, Math.ceil(rawLen / 4) * 2);
        const deadlineTimer = deadlineMs ? setTimeout(() => {
          if (responseDone || convRetrying) return;
          deadlineHit = true;
          // 先把自己钉进日志:后面 relay / upstreamDead 的收尾都用 || 兜底,不会覆盖真实原因
          entry.err = entry.err || `超出端到端总预算(${Math.round(deadlineMs / 1000)}s)`;
          entry.err_class = entry.err_class || 'timeout';
          try { cres.destroy(new Error('timeout: 端到端总预算用尽')); } catch {}
          // 还没提交给客户端就直接给一条明确的 504,别让它耗到自己的本地超时
          if (!res.headersSent) {
            upstreamDead(entry.err, 'timeout', { status: 504, message: '超出端到端总预算' });
          }
        }, Math.max(1, deadlineMs - (Date.now() - started))) : null;
        // 看门狗只是兜底,不该成为"进程还不能退出"的理由(测试里漏清就会挂满整个总预算)
        if (bodyTimer && bodyTimer.unref) bodyTimer.unref();
        if (deadlineTimer && deadlineTimer.unref) deadlineTimer.unref();
        activeTimers = { bodyTimer, deadlineTimer };
        const finishEntry = u => {
          if (bodyTimer) clearTimeout(bodyTimer);
          if (deadlineTimer) clearTimeout(deadlineTimer);
          entry.ms = Date.now() - started;
          if (u) { entry.in = u.in || 0; entry.out = u.out || 0; entry.cache_read = u.cache_read || 0; }
          if (!entry.err_class && entry.status >= 400) entry.err_class = errorClass(entry.status, '');
          finalize();
        };
        const outHeaders = {
          'Content-Type': ct,
          'x-mixrouter-app': ep.app,
          'x-mixrouter-provider': safeHeader(provider.name),
          'x-mixrouter-model': safeHeader(model),
          'x-mixrouter-session': safeHeader(sessionKeyOf(ident.key)),
        };
        // 流式空闲看门狗:上游发完响应头后长时间不出数据就掐断,不让客户端干等
        let idleTimer = null;
        // 响应体是否已完整结束;上面的 done 只表示"本次尝试已归属",响应转发可以还没走完
        let responseDone = false;
        // 转换重试会主动销毁当前上游流,那不是夭折(见下方 conv 分支)
        let convRetrying = false;
        const armIdle = () => {
          if (!isSse || !STREAM_IDLE_TIMEOUT_MS) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (responseDone) return;
            try { cres.destroy(new Error('stream idle timeout')); } catch {}
          }, STREAM_IDLE_TIMEOUT_MS);
        };
        const disarmIdle = () => { clearTimeout(idleTimer); idleTimer = null; };
        // 上游响应中途夭折(空闲/总超时、连接重置):补记日志并掐断客户端响应,别让它干等
        const upstreamDead = (why, errClass, opts) => {
          if (responseDone || convRetrying) return;
          responseDone = true;
          entry.err = entry.err || String(why);
          entry.err_class = entry.err_class || errClass;
          finishEntry();
          const status = (opts && opts.status) || 502;
          const what = (opts && opts.message) || '响应中断';
          if (!res.headersSent) sendErr(status, 'api_error', `上游 ${provider.name} ${what}: ${why}`, errClass);
          else if (!res.writableEnded) { try { res.end(); } catch {} }
        };
        cres.on('data', armIdle);
        cres.on('end', () => { responseDone = true; disarmIdle(); });
        cres.on('close', () => {
          disarmIdle();
          // 转换重试的销毁:close 先于 promise 微任务里的重试标记到达,推到下一拍再判
          setImmediate(() => upstreamDead('连接中断', 'network_error'));
        });
        cres.on('error', e => {
          disarmIdle();
          const why = e.code || e.message;
          setImmediate(() => upstreamDead(why, e.code ? errorClass(0, e.code) : (/timeout/i.test(String(why)) ? 'timeout' : 'network_error')));
        });
        armIdle();

        // responses 客户端 + chat 上游 = 现场翻译(错误体已是 OpenAI 形状,原样透传)
        if (wire === 'chat' && ep.kind === 'responses') {
          if (cres.statusCode >= 400) {
            const parts = [];
            cres.on('data', c => parts.push(c));
            cres.on('end', () => {
              const text = Buffer.concat(parts).toString('utf8');
              finishEntry(extractUsageOpenAI('chat', text));
              if (!res.headersSent) { try { res.writeHead(cres.statusCode, outHeaders); res.end(text); } catch {} }
              else { try { res.end(); } catch {} }
            });
            return;
          }
          if (isSse) {
            streamChatAsResponses(cres, res, model, u => {
              entry.in = u.input_tokens || 0;
              entry.out = u.output_tokens || 0;
              entry.cache_read = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
            }, outHeaders);
            cres.on('end', () => finishEntry());
          } else {
            const parts = [];
            cres.on('data', c => parts.push(c));
            cres.on('end', () => {
              const text = Buffer.concat(parts).toString('utf8');
              let resp = null;
              try { resp = chatJsonToResponses(JSON.parse(text), model); } catch { /* 上游给了非 JSON,原样透传 */ }
              finishEntry(extractUsageOpenAI('chat', text));
              if (!res.headersSent) {
                try {
                  // 客户端要的是流、上游却整包回 JSON:摊成 SSE 序列发出去,别让 Codex 干等
                  if (resp && body.stream !== false) emitResponsesSse(res, resp, outHeaders);
                  else { res.writeHead(200, outHeaders); res.end(resp ? JSON.stringify(resp) : text); }
                } catch {}
              }
            });
          }
          return;
        }
        // claude 客户端 + chat 上游 = 现场翻译(响应/SSE 翻回 Anthropic,错误也翻成 Anthropic 形状)
        if (wire === 'chat' && ep.kind === 'messages') {
          if (cres.statusCode >= 400) {
            const parts = [];
            cres.on('data', c => parts.push(c));
            cres.on('end', () => {
              const text = Buffer.concat(parts).toString('utf8');
              finishEntry();
              if (res.headersSent) { try { res.end(); } catch {} return; }
              let msg = text;
              try {
                const j = JSON.parse(text);
                const e = j.error;
                msg = (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || j.message || text;
              } catch {}
              res.writeHead(cres.statusCode, { ...outHeaders, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(msg).slice(0, 400) } }));
            });
            return;
          }
          if (isSse) {
            // 客户端要非流:上游照发流式,收进内存攒成整包 JSON 再回(见 upstreamStream 注释)。
            // 心跳注释绝不能开:攒包期间真 res 还没写头,塞进一个字节就把非流响应毁了
            const sink = body.stream ? null : wireResponses.memorySink();
            wireChat.relayChatStream(cres, sink ? sink.res : res, model, {
              mayRetry: !res.headersSent && convRetries < CONV_RETRIES, headers: outHeaders,
              onCommit: body.stream ? startKeepAlive : null, // 真提交给客户端了,从这一刻起补心跳
            }).then(r => {
              // 客户端已经走了就别再重打一遍:那是在为没人接收的请求烧渠道额度
              if (r && r.retryable && !clientClosed && !res.destroyed && !deadlineHit) {
                convRetrying = true; convRetries++; entry.attempts = i + 1;
                clearAttemptTimers(); // 这一发上游已经交给别人的 res,别让它 240s 后再来改这条日志
                return tryCandidate(i);
              }
              // 终态已定,响应体和空闲看门狗都不该再判这一笔(否则夭折会被二次记成连接中断)
              responseDone = true; disarmIdle();
              // 客户端自己断的不算渠道的账(那是取消);上游真夭折才记这一笔
              if (r && r.aborted && !clientClosed) {
                entry.err = entry.err || r.detail || '上游流中断';
                entry.err_class = entry.err_class || 'stream_aborted';
              }
              const u = (r && r.usage) || {};
              let msg = null, parseError = null;
              if (sink && r && !r.aborted) {
                try { msg = wireResponses.collectAnthropicMessage(sink.text()); }
                catch (e) { parseError = e; }
              }
              if (sink && (parseError || (r && r.aborted))) {
                entry.status = 502;
                entry.err = entry.err || (parseError && parseError.message) || (r && r.detail) || '上游流中断';
                entry.err_class = entry.err_class || 'stream_aborted';
              }
              finishEntry({
                in: u.input_tokens || 0, out: u.output_tokens || 0,
                cache_read: u.cache_read_input_tokens || 0,
              });
              // 非流客户端:攒下的流只有在完整终态可重建时才回 200;断流、错误事件或损坏的
              // 工具参数统一回 502,不能把残缺 SSE 伪装成成功 JSON。
              if (sink && !res.headersSent && !clientClosed) {
                if (msg) {
                  res.writeHead(200, { ...outHeaders, 'Content-Type': 'application/json' });
                  try { return res.end(JSON.stringify(msg)); } catch { return; }
                }
                try {
                  res.writeHead(502, { ...outHeaders, 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: entry.err || '上游流中断' } }));
                } catch {}
              }
            });
            return;
          }
          const parts = [];
          cres.on('data', c => parts.push(c));
          cres.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8');
            let msg = null, rerr = null;
            try {
              const j = JSON.parse(text);
              // HTTP 200 里包着 error / 工具参数残缺:回 Anthropic error,
              // 不能翻成一条 content 为空的"正常消息"
              rerr = wireChat.chatErrorOf(j);
              if (!rerr) msg = wireChat.chatToAnthropic(j, model);
            } catch { /* 非 JSON 原样透传 */ }
            if (rerr) {
              entry.status = 502; // 记客户端真正拿到的状态:200 里包着的失败不是成功
              entry.err = rerr.message; entry.err_class = entry.err_class || 'upstream_server';
              finishEntry();
              if (res.headersSent) { try { res.end(); } catch {} return; }
              res.writeHead(502, { ...outHeaders, 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ type: 'error', error: rerr }));
            }
            const u = (msg && msg.usage) || {};
            finishEntry({ in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0 });
            if (res.headersSent) return;
            try {
              // 客户端要流、上游却整包回 JSON:摊成 Anthropic SSE,别让 Claude Code 干等
              if (msg && body.stream) wireResponses.emitAnthropicSse(res, msg, outHeaders, startKeepAlive);
              else { res.writeHead(200, { ...outHeaders, 'Content-Type': 'application/json' }); res.end(msg ? JSON.stringify(msg) : text); }
            } catch {}
          });
          return;
        }
        // claude 客户端 + responses 上游 = 现场翻译(响应/SSE 翻回 Anthropic,错误也翻成 Anthropic 形状)
        if (conv) {
          if (cres.statusCode >= 400) {
            const parts = [];
            cres.on('data', c => parts.push(c));
            cres.on('end', () => {
              const text = Buffer.concat(parts).toString('utf8');
              finishEntry();
              if (res.headersSent) { try { res.end(); } catch {} return; }
              let msg = text;
              try {
                const j = JSON.parse(text);
                const e = j.error;
                msg = (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || j.message || text;
              } catch {}
              res.writeHead(cres.statusCode, { ...outHeaders, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(msg).slice(0, 400) } }));
            });
            return;
          }
          if (isSse) {
            // 客户端要非流:上游照发流式,收进内存攒成整包 JSON 再回(见 upstreamStream 注释)。
            // 心跳注释绝不能开:攒包期间真 res 还没写头,塞进一个字节就把非流响应毁了
            const sink = body.stream ? null : wireResponses.memorySink();
            wireResponses.relayAnthropicStream(cres, sink ? sink.res : res, model, {
              mayRetry: !res.headersSent && convRetries < CONV_RETRIES, headers: outHeaders,
              onCommit: body.stream ? startKeepAlive : null, // 真提交给客户端了,从这一刻起补心跳
            }).then(r => {
              // 客户端已经走了就别再换 key 重打一遍:那是在为没人接收的请求烧渠道额度
              if (r && r.retryable && !clientClosed && !res.destroyed && !deadlineHit) {
                convRetrying = true; convRetries++; rotateConvCacheGen(sessKey, provider.id); entry.attempts = i + 1;
                clearAttemptTimers(); // 这一发上游已经交给别人的 res,别让它 240s 后再来改这条日志
                return tryCandidate(i);
              }
              // 终态已定,响应体和空闲看门狗都不该再判这一笔(否则夭折会被二次记成连接中断)
              responseDone = true; disarmIdle();
              // 客户端自己断的不算渠道的账(那是取消);上游真夭折才记这一笔
              if (r && r.aborted && !clientClosed) {
                entry.err = entry.err || r.detail || '上游流中断';
                entry.err_class = entry.err_class || 'stream_aborted';
              }
              const u = (r && r.usage) || {};
              let msg = null, parseError = null;
              if (sink && r && !r.aborted) {
                try { msg = wireResponses.collectAnthropicMessage(sink.text()); }
                catch (e) { parseError = e; }
              }
              if (sink && (parseError || (r && r.aborted))) {
                entry.status = 502;
                entry.err = entry.err || (parseError && parseError.message) || (r && r.detail) || '上游流中断';
                entry.err_class = entry.err_class || 'stream_aborted';
              }
              finishEntry({
                in: u.input_tokens || 0, out: u.output_tokens || 0,
                cache_read: u.cache_read_input_tokens || 0,
              });
              // 非流客户端:攒下的流只有在完整终态可重建时才回 200;断流、错误事件或损坏的
              // 工具参数统一回 502,不能把残缺 SSE 伪装成成功 JSON。
              if (sink && !res.headersSent && !clientClosed) {
                if (msg) {
                  res.writeHead(200, { ...outHeaders, 'Content-Type': 'application/json' });
                  try { return res.end(JSON.stringify(msg)); } catch { return; }
                }
                try {
                  res.writeHead(502, { ...outHeaders, 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: entry.err || '上游流中断' } }));
                } catch {}
              }
            });
            return;
          }
          const parts = [];
          cres.on('data', c => parts.push(c));
          cres.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8');
            let msg = null, rerr = null;
            try {
              const j = JSON.parse(text);
              // HTTP 200 里包着 error / status=failed / 工具参数残缺:回 Anthropic error,
              // 不能翻成一条 content 为空的"正常消息"
              rerr = wireResponses.responsesErrorOf(j);
              if (!rerr) msg = wireResponses.responsesToAnthropic(j, model);
            } catch { /* 非 JSON 原样透传 */ }
            if (rerr) {
              entry.status = 502; // 记客户端真正拿到的状态:200 里包着的失败不是成功
              entry.err = rerr.message; entry.err_class = entry.err_class || 'upstream_server';
              finishEntry();
              if (res.headersSent) { try { res.end(); } catch {} return; }
              res.writeHead(502, { ...outHeaders, 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ type: 'error', error: rerr }));
            }
            const u = (msg && msg.usage) || {};
            finishEntry({ in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0 });
            if (res.headersSent) return;
            try {
              // 客户端要流、上游却整包回 JSON:摊成 Anthropic SSE,别让 Claude Code 干等
              if (msg && body.stream) wireResponses.emitAnthropicSse(res, msg, outHeaders, startKeepAlive);
              else { res.writeHead(200, { ...outHeaders, 'Content-Type': 'application/json' }); res.end(msg ? JSON.stringify(msg) : text); }
            } catch {}
          });
          return;
        }
        // 同协议直通:Anthropic→Anthropic / responses→responses / chat→chat
        // anthropic 线上游恒流式(见 upstreamStream 注释):客户端要非流时收进内存攒成整包
        // JSON 再回,而不是把非流形状透传给上游吃那 120s 首字节死循环
        // Anthropic 线上游拿 SSE 皮回 4xx/5xx:New API 系网关对 stream=true 的请求就是这么回的
        // (实测 agentrouter.org 额池耗尽:HTTP 402 + content-type text/event-stream,body 却是一坨 JSON)。
        // 照消息流去解析只会得出「缺完整终态」,把真实状态码和上游原因一起吞掉,用户看到的是"接口断了"
        // 而不是"额池没了"。这里照 responses 转换分支的做法,直翻成 Anthropic 错误原样说明。
        if (wire === 'anthropic' && cres.statusCode >= 400) {
          const parts = [];
          cres.on('data', c => parts.push(c));
          cres.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8');
            finishEntry();
            if (res.headersSent) { try { res.end(); } catch {} return; }
            let detail = text;
            try {
              const j = JSON.parse(text);
              const e = j.error;
              detail = (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || j.message || text;
            } catch {}
            sendErr(cres.statusCode, 'api_error',
              `上游 ${provider.name} 返回 ${cres.statusCode}: ${String(detail).slice(0, 400).trim() || '(空响应体)'}`,
              entry.err_class);
          });
          return;
        }
        if (wire === 'anthropic' && !body.stream && isSse) {
          const sink = wireResponses.memorySink();
          cres.on('data', c => sink.res.write(c));
          cres.on('end', () => {
            let msg = null, parseError = null;
            try { msg = wireResponses.collectAnthropicMessage(sink.text()); }
            catch (e) { parseError = e; }
            const u = (msg && msg.usage) || {};
            if (parseError) {
              entry.status = 502;
              entry.err = parseError.message;
              entry.err_class = 'stream_aborted';
            }
            finishEntry({ in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0 });
            if (res.headersSent) return;
            if (msg) {
              res.writeHead(200, { ...outHeaders, 'Content-Type': 'application/json' });
              return res.end(JSON.stringify(msg));
            }
            sendErr(502, 'api_error', `上游 ${provider.name} 响应中断: ${entry.err || '缺少完整终态'}`, 'stream_aborted');
          });
          return;
        }
        res.writeHead(cres.statusCode, outHeaders);
        // 到这一步客户端那条响应已经提交,可以开始补心跳了
        if (isSse) startKeepAlive();
        if (isSse) {
          let acc = '';
          cres.on('data', c => { if (acc.length < 1024 * 1024) acc += c.toString('utf8'); res.write(c); });
          cres.on('end', () => { finishEntry(extractUsageFor(wire, acc)); try { res.end(); } catch {} });
        } else {
          const parts = [];
          cres.on('data', c => { parts.push(c); res.write(c); });
          cres.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8');
            const u = extractUsageFor(wire, text);
            // count_tokens 只有输入,别被响应体里别处的数字带偏
            if (ep.kind === 'count_tokens') u.in = Number((text.match(/"input_tokens"\s*:\s*(\d+)/) || [0, 0])[1]);
            finishEntry(u); try { res.end(); } catch {}
          });
        }
      });
      activeReq = creq;
      creq.on('timeout', () => {
        if (done) return;
        done = true;
        creq.destroy(new Error('timeout'));
        nextOrFail(0, `首字节超时(${firstHeaderMs >= 1000 ? Math.round(firstHeaderMs / 1000) + 's' : firstHeaderMs + 'ms'})`, 'timeout');
      });
      creq.on('error', e => {
        if (done) return;
        done = true;
        nextOrFail(0, e.code || e.message, e.code ? errorClass(0, e.code) : 'network_error');
      });
      creq.end(outBody);
    }
    tryCandidate(0);
  });
}

// 客户端带来的凭据(可当路由维度用:不同对话配不同 token 即可分流)
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

// 转发到 OpenAI 协议上游时的请求头:只带最小集合(不撒 Anthropic 的 x-api-key / anthropic-* 头)
function buildOpenAiHeaders(provider, req, stream) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'Authorization': 'Bearer ' + provider.api_key,
    'User-Agent': safeHeader(provider.ua) || safeHeader(req.headers['user-agent']) || DEFAULT_UA_CODEX,
  };
  if (req.headers.originator) headers['originator'] = safeHeader(req.headers.originator);
  // 会话 id 透传:个别网关按它做上游侧缓存粘性;带的是客户端自己的 id,不含本机信息
  const sid = codexHeaderSessionId(req);
  if (sid) headers['session-id'] = safeHeader(sid);
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
  // 标了 wire_api:'responses'/'chat' 的渠道只挂 Codex/OpenAI 型通道,上游根本没有 /v1/messages:
  // 直连写进去等于把客户端写坏(而且界面上还显示切换成功)。拒绝,让它走路由模式。
  if (wireOf(p, 'claude') !== 'anthropic')
    throw Object.assign(new Error(`该渠道标了 wire_api: ${wireOf(p, 'claude')}(模型只挂在 Codex/OpenAI 型通道上),直连后 Claude Code 的 /v1/messages 必然失败;请改用控制台的「路由模式」经本机代理转发`), { statusCode: 400 });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}
  backupFile(CLAUDE_SETTINGS);
  cfg.env = cfg.env || {};
  cfg.env.ANTHROPIC_BASE_URL = p.base_url;
  cfg.env.ANTHROPIC_AUTH_TOKEN = p.api_key;
  // 槽位模型:渠道里填了才写;没填的槽位若当前是控制台托管的 mixr- 别名,必须清掉——
  // 否则直连时客户端会把 mixr-haiku 当模型名发给真实上游(与路由模式的清理逻辑一致)
  for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
    const v = name === 'main' ? ((p.models && p.models[0]) || '') : ((p.slots && p.slots[name]) || '');
    if (v) cfg.env[envKey] = v;
    else if (String(cfg.env[envKey] || '').startsWith('mixr-')) delete cfg.env[envKey];
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  try { fs.chmodSync(CLAUDE_SETTINGS, 0o600); } catch {}
}

// TOML 基本字符串转义
const tomlStr = s => '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// 读 config.toml 的顶层键(第一个 [section] 之前的那些)
function codexTopLevel(text, key) {
  let sawSection = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*\[/.test(line)) sawSection = true;
    if (sawSection) continue;
    const m = line.match(new RegExp('^' + key + '\\s*=\\s*"([^"]*)"'));
    if (m) return m[1];
  }
  return '';
}

// 往 ~/.codex/config.toml 写一个渠道 section(外科手术):
//   1) 先整体删掉以前写入的 mixr-* section(用户自己的 section 一律不碰)
//   2) 顶层 model / model_provider 原位替换;没有就插到文件最前
//   3) 追加新 section(沿用本机已验证的 bearer-token 模式,不依赖 auth.json)
function writeCodexConfig({ section, name, base_url, api_key, wire_api, model, keepModel }) {
  let text = '';
  try { text = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch {}
  backupFile(CODEX_CONFIG);
  const kept = []; let inMixr = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[model_providers\.mixr-/.test(line)) { inMixr = true; continue; }
    if (inMixr && /^\s*\[/.test(line)) inMixr = false;
    if (!inMixr) kept.push(line);
  }
  let sawSection = false, hasModel = false, hasProvider = false, currentModel = '';
  let out = kept.map(line => {
    if (/^\s*\[/.test(line)) sawSection = true;
    if (!sawSection && /^model\s*=/.test(line)) {
      hasModel = true;
      currentModel = (line.match(/=\s*"([^"]*)"/) || [])[1] || '';
      // 路由模式不改动顶层模型名——路由规则就是按它匹配的
      return `model = ${tomlStr(keepModel && currentModel ? currentModel : model)}`;
    }
    if (!sawSection && /^model_provider\s*=/.test(line)) { hasProvider = true; return `model_provider = ${tomlStr(section)}`; }
    return line;
  });
  const head = [];
  if (!hasModel) head.push(`model = ${tomlStr(model)}`);
  if (!hasProvider) head.push(`model_provider = ${tomlStr(section)}`);
  if (head.length) out = head.concat(out);
  out.push('', `[model_providers.${section}]`,
    `name = ${tomlStr(name)}`,
    `base_url = ${tomlStr(base_url)}`,
    `wire_api = ${tomlStr(wire_api || 'responses')}`,
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlStr(api_key)}`);
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG, out.join('\n').replace(/\n{3,}$/, '\n\n'));
  try { fs.chmodSync(CODEX_CONFIG, 0o600); } catch {}
}

function switchCodex(p) {
  writeCodexConfig({ section: 'mixr-' + p.id, name: p.name, base_url: p.base_url,
    api_key: p.api_key, wire_api: p.wire_api || 'responses',
    model: p.model || (p.models && p.models[0]) || '' });
}

// 路由模式:把客户端指向本机代理,流量开始按路由规则分发
//   Claude Code → settings.json 的 env(模型名/槽位保持不动,路由就靠它匹配)
//   Codex      → config.toml 顶层 model_provider 换成 mixr-router,顶层 model 保持不动
// options.slots = true 时按当前槽位表同步 Claude 的槽位 env:
//   已配置的槽写别名(mixr-…),没配置的槽只清理以前写入过的别名残留,用户手设的真实模型名不动
function switchClaudeRouter(options = {}) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}
  backupFile(CLAUDE_SETTINGS);
  cfg.env = cfg.env || {};
  cfg.env.ANTHROPIC_BASE_URL = ROUTER_URL;
  cfg.env.ANTHROPIC_AUTH_TOKEN = ROUTER_TOKEN;
  if (options.slots) {
    for (const [name, envKey] of Object.entries(CLAUDE_SLOT_ENV)) {
      const s = (slotMap.claude || {})[name];
      if (s && s.provider) cfg.env[envKey] = slotAlias('claude', name);
      else if (String(cfg.env[envKey] || '').startsWith('mixr-')) delete cfg.env[envKey];
    }
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  try { fs.chmodSync(CLAUDE_SETTINGS, 0o600); } catch {}
}
function switchCodexRouter() {
  let text = ''; try { text = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch {}
  const cur = codexTopLevel(text, 'model');
  const fallback = (store.codex.find(p => p.enabled !== false && p.model) || {}).model || '';
  writeCodexConfig({ section: ROUTER_SECTION, name: `mixrouter(经 :${PROXY_PORT} 路由)`,
    base_url: ROUTER_URL + '/v1', api_key: ROUTER_TOKEN, wire_api: 'responses',
    model: cur || fallback, keepModel: true });
}
function switchRouter(app, options = {}) {
  if (app === 'zcode') return switchZcodeRouter(options);
  if (app === 'codex') return switchCodexRouter();
  if (app === 'claude') return switchClaudeRouter(options);
  throw zcodeConfig.invalid('未知客户端 app');
}

const zcodeModelsOf = p => [...new Set([
  ...(Array.isArray(p.models) ? p.models : []), p.model,
  ...Object.values(p.slots || {}),
].filter(m => typeof m === 'string' && m.trim()).map(m => m.trim()))];

function zcodeSpec(p) {
  const app = providerApp(p.id);
  if (!app) throw zcodeConfig.invalid('渠道不存在');
  if (p.enabled === false) throw zcodeConfig.invalid('渠道已停用，无法注册 ZCode');
  if (!p.api_key) throw zcodeConfig.invalid('渠道未配置 API Key');
  const models = zcodeModelsOf(p);
  if (!models.length) throw zcodeConfig.invalid('渠道没有可用模型，无法注册 ZCode');
  const wire = wireOf(p, app);
  return { target: p.id, base_url: zcodeConfig.baseURL(p.base_url, wire), api_key: p.api_key,
    wire_api: wire, models, model: models[0] };
}

function zcodeRouterSpec(options = {}) {
  if (!zcodeConfig.isObject(options)) throw zcodeConfig.invalid('请求体必须是 JSON 对象');
  const wire = options.wire_api === undefined ? 'anthropic' : options.wire_api;
  if (typeof wire !== 'string' || !Object.hasOwn(zcodeConfig.KINDS, wire)) throw zcodeConfig.invalid('wire_api 必须是 anthropic、responses 或 chat');
  if (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim()))
    throw zcodeConfig.invalid('model 必须是非空字符串');
  const app = wire === 'anthropic' ? 'claude' : 'codex';
  // Responses can use either OpenAI upstream via the existing responses→chat adapter.
  const usable = p => p && p.enabled !== false && p.api_key &&
    (wire !== 'chat' || wireOf(p, app) === 'chat');
  const models = new Set(storeOf(app).filter(usable).flatMap(zcodeModelsOf));
  // Explicit route/pool model overrides are real configured models too. Never
  // synthesize IDs from substring match patterns (e.g. "opus, sonnet").
  for (const r of [...routes.rules, routes.default || {}]) {
    if (r.enabled === false || !ruleBelongsToApp(r, app)) continue;
    for (const member of poolMembers(r, app)) {
      if (usable(member.provider) && typeof member.model === 'string' && member.model.trim()) models.add(member.model.trim());
    }
  }
  if (!models.size) throw zcodeConfig.invalid('对应协议没有已启用渠道的可用模型');
  const model = options.model === undefined ? [...models][0] : options.model.trim();
  if (!models.has(model)) throw zcodeConfig.invalid('model 不在对应协议的可用模型列表中');
  return { target: ROUTER_ID, base_url: zcodeConfig.baseURL(ROUTER_URL, wire), api_key: ROUTER_TOKEN,
    wire_api: wire, models: [...models], model };
}

function switchZcode(p) { zcodeConfig.writeConfig(zcodeSpec(p)); }
function switchZcodeRouter(options = {}) { zcodeConfig.writeConfig(zcodeRouterSpec(options)); }
function liveZcodeState() {
  return zcodeConfig.liveState(meta => {
    if (!current.zcode || current.zcode !== meta.target) return null;
    if (current.zcode === ROUTER_ID) return zcodeRouterSpec({ wire_api: meta.wire_api, model: meta.model });
    const p = findProvider(current.zcode);
    return p ? zcodeSpec(p) : null;
  }, ROUTER_URL);
}

// 读取客户端当前实际生效的上游(与渠道库比对,给 UI 显示"配置漂移"用)
const trimSlash = s => String(s || '').replace(/\/+$/, '');
function liveState() {
  const live = {};
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch {}
  const env = cfg.env || {};
  const claudeBase = env.ANTHROPIC_BASE_URL || '';
  const curClaude = current.claude && current.claude !== ROUTER_ID ? findProvider(current.claude) : null;
  const claudeRouter = trimSlash(claudeBase) === ROUTER_URL;
  live.claude = { base_url: claudeBase, model: env.ANTHROPIC_MODEL || '', router: claudeRouter,
    // 槽位 env 现值(控制台对比槽位表,提示漂移):别名 = 已托管,其他值 = 用户手设
    slots: Object.fromEntries(CLAUDE_SLOTS.map(n => [n, env[CLAUDE_SLOT_ENV[n]] || ''])),
    match: claudeRouter
      // 路由模式:current 记的是 "@router" 哨兵,或库里有渠道自己就指向代理
      ? (current.claude === ROUTER_ID
        || !!(curClaude && trimSlash(curClaude.base_url) === ROUTER_URL && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')))
      : !!(curClaude && curClaude.base_url === claudeBase && curClaude.api_key === (env.ANTHROPIC_AUTH_TOKEN || '')) };

  let text = ''; try { text = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch {}
  const provider = codexTopLevel(text, 'model_provider');
  const model = codexTopLevel(text, 'model');
  let base = '', wire = '';
  const sec = text.match(new RegExp(`\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\[]*`));
  if (sec) { const b = sec[0].match(/base_url\s*=\s*"([^"]*)"/); base = b ? b[1] : ''; const w = sec[0].match(/wire_api\s*=\s*"([^"]*)"/); wire = w ? w[1] : ''; }
  const curCodex = current.codex && current.codex !== ROUTER_ID ? findProvider(current.codex) : null;
  const codexRouter = provider === ROUTER_SECTION || trimSlash(base) === ROUTER_URL + '/v1' || trimSlash(base) === ROUTER_URL;
  live.codex = { provider, model, base_url: base, wire_api: wire, router: codexRouter,
    match: codexRouter
      ? (current.codex === ROUTER_ID
        || !!(curCodex && trimSlash(curCodex.base_url) === ROUTER_URL + '/v1' && curCodex.api_key && sec && sec[0].includes(tomlStr(curCodex.api_key))))
      : !!(curCodex && provider === 'mixr-' + curCodex.id && curCodex.api_key && sec && sec[0].includes(tomlStr(curCodex.api_key))) };
  live.zcode = liveZcodeState();
  return live;
}

// ---------------------------------------------------------------- 渠道连通性测试
function testProvider(p) {
  if (!p.api_key) return Promise.resolve({ ok: false, error: '未配置 API Key' });
  const u = new URL(p.base_url);
  // 配了出站代理时先探隧道:隧道不通的环境里直连探活报"通"会误导(生产流量并不直连)
  return upstreamProxyCheck(u).then(r => r || testProviderUpstream(p, u));
}

function upstreamProxyCheck(u) {
  if (!upstreamAgent(u.protocol)) return Promise.resolve();
  return new Promise(resolve => {
    const transport = u.protocol === 'https:' ? https : http;
    const creq = transport.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: '/', method: 'GET', agent: upstreamAgent(u.protocol), timeout: TEST_TIMEOUT_MS,
    }, cres => { cres.resume(); resolve(); });
    creq.on('timeout', () => creq.destroy(new Error('timeout')));
    creq.on('error', e => resolve({ ok: false, error: '出站代理不可用: ' + e.message }));
    creq.end();
  });
}

function testProviderUpstream(p, u) {
  if (p.wire_api) { // codex(OpenAI 系):免费探活 GET <base>/models
    return new Promise(resolve => {
      const transport = u.protocol === 'https:' ? https : http;
      const creq = transport.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        // 探活路径与真实转发同规则:base_url 裸域名也要落到 /v1/models(拼成 <裸域名>/models 会 404/503)
        path: joinUpstreamPath(u.pathname, '/v1/models'), method: 'GET', timeout: TEST_TIMEOUT_MS,
        agent: upstreamAgent(u.protocol),
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
  // claude(Anthropic 系):最小 messages 请求(路径复用 joinUpstreamPath,base_url 带 /v1 不会拼成 /v1/v1)
  const model = applyModel(p.models[0] || 'claude-opus-5', {});
  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  return new Promise(resolve => {
    const transport = u.protocol === 'https:' ? https : http;
    const creq = transport.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: joinUpstreamPath(u.pathname, '/v1/messages'), method: 'POST', timeout: TEST_TIMEOUT_MS,
      agent: upstreamAgent(u.protocol),
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
// 老式单 Key 渠道(只有 api_key、没有 keys 清单)在控制台里同样要看得见:给它合成一条固定
// id 的「账号1」。否则编辑弹窗的清单是空的,用户"再加一把"时服务端只看到新清单,老 Key 被整份替换掉
const LEGACY_KEY_ID = 'klegacy';
function ringOf(p) {
  if (Array.isArray(p.keys) && p.keys.length) return p.keys;
  return p.api_key ? [{ id: LEGACY_KEY_ID, label: '账号1', key: p.api_key }] : [];
}
function publicProvider(p) {
  const { api_key, keys, ...rest } = p;
  const ring = ringOf(p);
  return { ...rest, key_masked: maskKey(api_key), has_key: !!api_key,
    keys: ring.map(k => ({ id: k.id, label: k.label, key_masked: maskKey(k.key) })),
    active_key: ring.some(k => k.id === p.active_key) ? p.active_key : ((ring[0] || {}).id || '') };
}

// 同一渠道可存多把 Key(同 provider 多账号),切换 = 换生效 Key;api_key 始终等于生效那把,
// 这样转发、测试、切换客户端这些老路径一行都不用改
function normalizeKeys(input, prev = []) {
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim() || ('k' + Math.random().toString(36).slice(2, 8));
    const old = prev.find(x => x.id === id);
    const key = String(raw.key || '').trim() || (old ? old.key : '');
    if (!key) return { error: '每个 Key 都要有值（已有的留空表示不改）' };
    if (out.some(k => k.key === key)) continue;            // 同一个 Key 只留一条
    out.push({ id, label: String(raw.label || (old && old.label) || '').trim() || `账号${out.length + 1}`, key });
  }
  return { keys: out };
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

  const readObject = async () => {
    let body;
    try { body = JSON.parse((await readBody()) || '{}'); }
    catch { throw zcodeConfig.invalid('请求体不是合法 JSON'); }
    if (!zcodeConfig.isObject(body)) throw zcodeConfig.invalid('请求体必须是 JSON 对象');
    return body;
  };

  Promise.resolve().then(async () => {
    // ---- 状态
    if (req.method === 'GET' && p === '/api/state') {
      return send(200, {
        version: VERSION, proxy_port: PROXY_PORT, ui_port: UI_PORT,
        uptime_s: Math.floor(process.uptime()), pid: process.pid,
        stats: todayStats(),
        providers: { claude: store.claude.map(publicProvider), codex: store.codex.map(publicProvider) },
        current, live: liveState(), routes, slots: slotsPublic(),
        sessions: sessionList(),
        cooldowns: Object.entries(cooldowns).map(([id, until]) => ({ provider: id, until, name: (findProvider(id) || {}).name || id })),
        session_ttl_min: Math.round(SESSION_TTL_MS / 60000), cooldown_s: Math.round(COOLDOWN_MS / 1000),
        router: { id: ROUTER_ID, url: ROUTER_URL, token: ROUTER_TOKEN,
          claude_base: ROUTER_URL, codex_base: ROUTER_URL + '/v1', zcode_base: ROUTER_URL,
          endpoints: ENDPOINTS.map(e => `${e.app === 'claude' ? 'Anthropic' : 'OpenAI'} ${e.path}`) },
      });
    }
    // ---- 健康状态(只读:熔断器/冷却/超时与重试配置)
    if (req.method === 'GET' && p === '/api/health') {
      return send(200, healthStatus());
    }
    // ---- 日志(支持过滤:app / provider 模型子串 / model 子串 / status=ok|err|具体码 / limit)
    if (req.method === 'GET' && p === '/api/logs') {
      const q = url.searchParams;
      const limit = Math.min(Number(q.get('limit') || 200), RING_SIZE);
      const app = q.get('app') || '';
      const prov = (q.get('provider') || '').toLowerCase();
      const model = (q.get('model') || '').toLowerCase();
      const sess = (q.get('session') || '').toLowerCase();
      const status = q.get('status') || '';
      let items = ring;
      if (app) items = items.filter(e => (e.app || 'claude') === app);
      if (prov) items = items.filter(e => (e.provider || '').toLowerCase().includes(prov));
      if (model) items = items.filter(e => (e.model_in || '').toLowerCase().includes(model) || (e.model_out || '').toLowerCase().includes(model));
      if (sess) items = items.filter(e => (e.session || '').toLowerCase().includes(sess));
      if (status === 'ok') items = items.filter(e => e.status >= 200 && e.status < 400 && !e.err);
      else if (status === 'err') items = items.filter(e => e.status >= 400 || e.status === 0 || e.err);
      else if (status) items = items.filter(e => String(e.status) === status);
      return send(200, { logs: items.slice(-limit).reverse() });
    }
    // ---- 统计:ring 内存窗口内的全量聚合(总数/成功率/token/按组/按渠道/按模型)
    if (req.method === 'GET' && p === '/api/stats') {
      let reqs = 0, ok = 0, inTok = 0, outTok = 0, cache = 0;
      const byProvider = {}, byModel = {}, byApp = {};
      for (const e of ring) {
        reqs++;
        if (e.status >= 200 && e.status < 400 && !e.err) ok++;
        inTok += e.in || 0; outTok += e.out || 0; cache += e.cache_read || 0;
        const ay = e.app || 'claude';
        byApp[ay] = (byApp[ay] || 0) + 1;
        const pv = e.provider || '(未知)';
        byProvider[pv] = (byProvider[pv] || 0) + 1;
        const mk = e.model_out || e.model_in || '(?)';
        byModel[mk] = (byModel[mk] || 0) + 1;
      }
      return send(200, { reqs, ok, ok_rate: reqs ? Math.round(ok * 100 / reqs) : 100, inTok, outTok, cache, by_app: byApp, by_provider: byProvider, by_model: byModel });
    }
    // ---- 渠道 CRUD(app = claude | codex)
    if (req.method === 'POST' && p === '/api/providers') {
      const b = await readObject();
      if (b.app !== undefined && !['claude', 'codex'].includes(b.app)) return send(400, { error: '渠道 app 必须是 claude 或 codex' });
      const app = b.app || 'claude';
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return send(400, { error: 'enabled 必须是布尔值' });
      if (b.wire_api !== undefined && !(app === 'claude' ? ['anthropic', 'responses', 'chat'] : ['responses', 'chat']).includes(b.wire_api))
        return send(400, { error: app === 'claude' ? 'claude 渠道的 wire_api 必须是 anthropic、responses 或 chat' : 'wire_api 必须是 responses 或 chat' });
      if (!b.name || !b.base_url) return send(400, { error: 'name 与 base_url 必填' });
      if (!validBaseUrl(b.base_url)) return send(400, { error: 'base_url 必须是合法的 http(s) URL,如 https://api.example.com' });
      if (app === 'codex' && !b.model) return send(400, { error: 'Codex 渠道必须填模型名' });
      const id = (app === 'codex' ? 'c' : 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const prov = { id, name: String(b.name), base_url: String(b.base_url).replace(/\/+$/, ''),
        api_key: String(b.api_key || ''), enabled: b.enabled !== false,
        note: String(b.note || ''), created_at: new Date().toISOString() };
      if (app === 'claude') {
        prov.models = Array.isArray(b.models) ? b.models : String(b.models || '').split(',').map(s => s.trim()).filter(Boolean);
        prov.slots = normalizeChannelSlots(b.slots);
        prov.ua = String(b.ua || '');
        // responses/chat:该渠道的模型只挂在 Codex(Responses)/OpenAI(Chat)型通道上,由本进程翻译
        if (b.wire_api === 'responses' || b.wire_api === 'chat') prov.wire_api = b.wire_api;
      } else {
        prov.model = String(b.model || '');
        prov.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
        // 纯文本网关(GLM 一类):把 responses 里的图片换成一句说明,而不是让上游 400
        prov.drop_images = !!b.drop_images;
      }
      if (Array.isArray(b.keys) && b.keys.length) {
        const kr = normalizeKeys(b.keys, []);
        if (kr.error) return send(400, { error: kr.error });
        prov.keys = kr.keys;
        prov.active_key = prov.keys[0].id;
        prov.api_key = prov.keys[0].key;
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
        const b = await readObject();
        if (b.app !== undefined && b.app !== providerApp(prov.id)) return send(400, { error: '不能改变渠道所属协议组 app' });
        if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return send(400, { error: 'enabled 必须是布尔值' });
        if (b.wire_api !== undefined && !(providerApp(prov.id) === 'claude' ? ['anthropic', 'responses', 'chat'] : ['responses', 'chat']).includes(b.wire_api))
          return send(400, { error: providerApp(prov.id) === 'claude' ? 'claude 渠道的 wire_api 必须是 anthropic、responses 或 chat' : 'wire_api 必须是 responses 或 chat' });
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
          if (b.slots !== undefined) prov.slots = normalizeChannelSlots(b.slots);
          if (b.ua !== undefined) prov.ua = String(b.ua);
          if (b.wire_api !== undefined) { if (b.wire_api === 'responses' || b.wire_api === 'chat') prov.wire_api = b.wire_api; else delete prov.wire_api; }
        } else {
          if (b.model !== undefined) prov.model = String(b.model);
          if (b.wire_api !== undefined) prov.wire_api = b.wire_api === 'chat' ? 'chat' : 'responses';
          if (b.drop_images !== undefined) prov.drop_images = !!b.drop_images;
        }
        // 多 Key(同渠道多账号):keys 是清单,active_key 是当前生效那把,api_key 跟着它走
        if (b.keys !== undefined) {
          // 清单里留空的行按 prev 解析回原值;老式单 Key 渠道的现存 api_key 也算 prev 的一条,
          // 这样「再加一把」不会把老 Key 挤掉(丢 Key 的根因就在这)
          const kr = normalizeKeys(b.keys, ringOf(prov));
          if (kr.error) return send(400, { error: kr.error });
          if (kr.keys.length) prov.keys = kr.keys; else delete prov.keys;
        }
        if (b.active_key !== undefined) prov.active_key = String(b.active_key || '');
        if (Array.isArray(prov.keys) && prov.keys.length) {
          const act = prov.keys.find(k => k.id === prov.active_key) || prov.keys[0];
          if (b.api_key) act.key = String(b.api_key).trim();   // 编辑弹窗里改的那把就是当前生效那把
          prov.active_key = act.id;
          prov.api_key = act.key;
        } else delete prov.active_key;
        saveStore();
        return send(200, { ok: true });
      }
      if (req.method === 'DELETE') {
        const app = providerApp(prov.id);
        store[app] = store[app].filter(x => x.id !== prov.id);
        if (current[app] === prov.id) current[app] = null;
        if (current.zcode === prov.id) current.zcode = null;
        // 引用该渠道的槽位一并摘除,免得别名路由到不存在的渠道
        let slotChanged = false;
        for (const g of ['claude', 'codex']) {
          for (const [name, s] of Object.entries(slotMap[g])) {
            if (s && s.provider === prov.id) { delete slotMap[g][name]; slotChanged = true; }
          }
        }
        if (slotChanged) saveSlots();
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
      const b = await readObject();
      const group = providerApp(prov.id);
      if (b.app !== undefined && !['claude', 'codex', 'zcode'].includes(b.app)) return send(400, { error: '未知客户端 app' });
      const app = b.app === undefined ? group : b.app;
      if (app !== 'zcode' && app !== group) return send(400, { error: '客户端与渠道协议组不兼容' });
      if (!prov.api_key) return send(400, { error: '渠道未配置 API Key,无法切换' });
      try {
        if (app === 'zcode') switchZcode(prov);
        else if (app === 'claude') switchClaude(prov); else switchCodex(prov);
      } catch (e) { return send(e.statusCode || 500, { error: app === 'zcode' && !e.statusCode ? '写入 ZCode 配置失败，请检查配置格式、权限及自有 provider 冲突' : '写入配置失败: ' + e.message }); }
      current[app] = prov.id;
      saveStore();
      return send(200, { ok: true, app, live: liveState()[app] });
    }

    // ---- 路由模式:把客户端整体指向本机代理(此后流量按路由规则分发)
    //   body.slots = true(Claude)时同时按槽位表写入/清理槽位 env(子代理各走各的上游)
    m = p.match(/^\/api\/router\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const app = m[1];
      if (!['claude', 'codex', 'zcode'].includes(app)) return send(400, { error: '未知客户端 app' });
      const b = await readObject();
      if (b.app !== undefined && b.app !== app) return send(400, { error: 'app 与路径不一致' });
      if (b.slots !== undefined && typeof b.slots !== 'boolean') return send(400, { error: 'slots 必须是布尔值' });
      if (app === 'codex' && !store.codex.length) return send(400, { error: '还没有 Codex 组渠道,先添加渠道再切路由模式' });
      if (app === 'claude' && !store.claude.length) return send(400, { error: '还没有 Claude 组渠道,先添加渠道再切路由模式' });
      try { switchRouter(app, b); } catch (e) { return send(e.statusCode || 500, { error: app === 'zcode' && !e.statusCode ? '写入 ZCode 配置失败，请检查配置格式、权限及自有 provider 冲突' : '写入配置失败: ' + e.message }); }
      current[app] = ROUTER_ID;
      saveStore();
      return send(200, { ok: true, app, live: liveState()[app], ...(app === 'claude' && b.slots ? { slots: slotsPublic().claude } : {}) });
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
      const b = await readObject();
      const id = String(b.provider || '');
      if (id) {
        const group = storeOf(s.app || 'claude');
        const prov = group.find(x => x.id === id);
        if (!prov) return send(404, { error: `渠道不存在(该对话属于 ${s.app === 'codex' ? 'Codex' : 'Claude'} 组,只能绑本组渠道)` });
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
      const b = await readObject();
      if (!Array.isArray(b.rules)) return send(400, { error: 'rules 必须是数组' });
      if ([...b.rules, b.default || {}].some(r => r && r.app !== undefined && !['', 'claude', 'codex'].includes(r.app)))
        return send(400, { error: '路由 app 必须是 claude、codex 或留空，ZCode 复用协议组' });
      routes = { rules: b.rules.map(normalizeRule), default: normalizeRule(b.default || {}) };
      saveRoutes();
      pools = {}; // 规则变了,轮转游标作废
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/claude/split') {
      return send(200, configureClaudeSplit(await readObject()));
    }

    // ---- 子代理槽位:查 / 改(值 null = 删除该槽;按组部分更新)
    if (req.method === 'GET' && p === '/api/slots') {
      return send(200, { slots: slotsPublic() });
    }
    if (req.method === 'PUT' && p === '/api/slots') {
      const b = await readObject();
      const err = validateSlotPut(b);
      if (err) return send(400, { error: err });
      for (const app of ['claude', 'codex']) {
        const patch = b[app];
        if (!zcodeConfig.isObject(patch)) continue;
        for (const [name, val] of Object.entries(patch)) {
          if (val === null) { delete slotMap[app][name]; continue; }
          slotMap[app][name] = app === 'claude'
            ? { provider: val.provider, model: String(val.model || '').trim() }
            : { provider: val.provider };
        }
      }
      saveSlots();
      return send(200, { ok: true, slots: slotsPublic() });
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
  }).catch(e => { try { send(e.statusCode || 500, { error: e.message }); } catch {} });
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
  Promise.all([listen(PROXY_PORT, proxyHandler, 'proxy'), listen(UI_PORT, apiHandler, 'ui')]).then(async () => {
    console.log(`[mixrouter v${VERSION}] 代理 :${PROXY_PORT}(Claude /v1/messages · Codex /v1/responses)  控制台 http://${HOST}:${UI_PORT}  渠道 claude ${store.claude.length} / codex ${store.codex.length}`);
    for (const port of altPorts(PROXY_PORT, UI_PORT)) {
      try {
        await listen(port, proxyHandler, `proxy-alt`);
        console.log(`  兼容监听 :${port}(旧客户端指向的端口,同一份状态)`);
      } catch (e) {
        console.error(`  兼容监听 :${port} 未拿到(${e.code || e.message})——该端口上还有别的服务在跑,不影响主端口`);
      }
    }
  }).catch(e => {
    console.error(`启动失败: ${e.message}(端口 ${PROXY_PORT}/${UI_PORT} 是否被占用?)`);
    process.exit(1);
  });
  // 长驻进程兜底:单次请求内的意外异常只记日志,不退出
  process.on('uncaughtException', e => console.error(`[uncaught] ${new Date().toISOString()} ${e.stack || e}`));
  process.on('unhandledRejection', e => console.error(`[unhandled] ${new Date().toISOString()} ${e && (e.stack || e.message) || e}`));
  // 优雅退出:落盘运行时状态 + 以 0 退出。launchd 的 KeepAlive.SuccessfulExit=false 靠这个区分
  // 「mixctl stop / launchctl kickstart -k 的正常停止」与「真崩了」,前者不会被立刻重新拉起。
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    try { saveStore(); saveRoutes(); saveSlots(); flushSessions(); } catch {}
    process.exit(0);
  });
}

// 供测试与脚本复用;store/routes/current 经 _state 存取以保持闭包绑定
module.exports = {
  VERSION, proxyHandler, apiHandler, listen,
  resolveRoute, applyModel, safeHeader, extractUsage, maskKey, tomlStr, validBaseUrl,
  switchClaude, switchCodex, switchClaudeRouter, switchCodexRouter, switchRouter,
  switchZcode, switchZcodeRouter, zcodeSpec, zcodeRouterSpec, liveZcodeState, joinUpstreamPath,
  liveState, testProvider, codexTopLevel, writeCodexConfig,
  // v3 会话分发
  sessionIdentity, sessionLabel, parseSessionId, matchWhen, normalizeRule, poolMembers, ruleBelongsToApp, bodyRouteText,
  sessionList, buildUpstreamHeaders, clientToken, strategyOf, applyLabel,
  // v3.1 OpenAI 端点(Codex 组)
  ENDPOINTS, classifyProxyRequest, wireOf, upstreamPathOf, modelList, buildOpenAiHeaders,
  codexHeaderSessionId, codexBodySessionId, codexFirstUserText, codexUserTexts, extractUsageOpenAI, extractUsageFor,
  responsesToChat, chatJsonToResponses, streamChatAsResponses, chatToolChoice, itemToChatMessages,
  // claude 组 chat 上游翻译(lib/wire-chat.js)
  wireChat,
  // v3.2 子代理槽位
  slotAlias, resolveSlot, slotsPublic, validateSlotPut, CLAUDE_SLOTS, CLAUDE_SLOT_ENV,
  normalizeChannelSlots, CLAUDE_SLOT_KEYS, claudeSplitPatch, configureClaudeSplit, altPorts,
  // v3.2 渠道池主备策略
  pickMember, markCooldown, inCooldown,
  // v3.4 上游健康(熔断/冷却/超时)
  health, healthStatus, errorClass, providerEligible,
  ROUTER_ID, ROUTER_URL, ROUTER_TOKEN, ROUTER_SECTION,
  _state: {
    get store() { return store; }, set store(v) { store = v; },
    get routes() { return routes; }, set routes(v) { routes = v; },
    get current() { return current; }, set current(v) { current = v; },
    get sessions() { return sessions; }, set sessions(v) { sessions = v; },
    get cooldowns() { return cooldowns; }, set cooldowns(v) { cooldowns = v; },
    get slotMap() { return slotMap; }, set slotMap(v) { slotMap = v; },
    resetPools() { pools = {}; },
    resetHealth() { health.clear(); },
    bindSession(key, providerId, extra = {}) {
      sessions.set(key, { providerId, model: '', ruleId: '', label: '', kind: 'header',
        created: Date.now(), lastUsed: Date.now(), reqs: 0, inTok: 0, outTok: 0, pinned: false, ...extra });
      return sessions.get(key);
    },
  },
};
