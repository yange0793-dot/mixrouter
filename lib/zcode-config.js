'use strict';
// ZCode is a client of the existing protocol groups, not a third channel store.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROVIDER_ID = 'mixrouter-managed';
const META = 'x-mixrouter';
const KINDS = { anthropic: 'anthropic', responses: 'openai', chat: 'openai-compatible' };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const configPath = () => process.env.MIXR_ZCODE_CONFIG || path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const owns = provider => isObject(provider?.[META]) && provider[META].owner === 'mixrouter' && provider[META].version === 1;
const authHeaders = headers => isObject(headers) && Object.keys(headers).some(key => /^(authorization|x-api-key|api-key|host)$/i.test(key));
function overridesConnection(value, kind, modelId) {
  if (!isObject(value)) return false;
  return (value.kind !== undefined && value.kind !== kind) ||
    (value.defaultKind !== undefined && value.defaultKind !== kind) ||
    (value.kinds !== undefined && (!Array.isArray(value.kinds) || !value.kinds.includes(kind))) ||
    (modelId && value.modelIdByKind?.[kind] !== undefined && value.modelIdByKind[kind] !== modelId) ||
    value.deleted === true || !!value.disabledReason || authHeaders(value.headers) ||
    (isObject(value.options) && (value.options.baseURL !== undefined || value.options.apiKey !== undefined || authHeaders(value.options.headers))) ||
    overridesConnection(value.zcode, kind, modelId);
}

function readConfig(file = configPath()) {
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { config: {}, text: null };
    // Never include JSON fragments, credentials, or OS error details in the API.
    throw new Error('无法读取 ZCode 配置，拒绝覆盖');
  }
  let config;
  try { config = JSON.parse(text); } catch { throw new Error('ZCode 配置不是合法 JSON，拒绝覆盖'); }
  if (!isObject(config) || (config.provider !== undefined && !isObject(config.provider)))
    throw new Error('ZCode 配置及 provider 必须是 JSON 对象，拒绝覆盖');
  for (const provider of Object.values(config.provider || {})) {
    if (!isObject(provider) || (provider.options !== undefined && !isObject(provider.options)) ||
        (provider.models !== undefined && (!isObject(provider.models) || Object.values(provider.models).some(m => !isObject(m)))))
      throw new Error('ZCode provider/options/models 必须是 JSON 对象，拒绝覆盖');
  }
  return { config, text };
}

// Anthropic SDK appends /v1/messages; OpenAI SDK appends /responses or /chat/completions.
function baseURL(base, wire) {
  if (typeof wire !== 'string' || !Object.hasOwn(KINDS, wire)) throw invalid('wire_api 必须是 anthropic、responses 或 chat');
  let url;
  try { url = new URL(base); } catch { throw invalid('ZCode base_url 必须是合法的 http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw invalid('ZCode base_url 不能包含凭据、查询参数或片段');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (wire === 'anthropic') pathname = pathname.replace(/\/v1$/, '');
  else if (!pathname.endsWith('/v1')) pathname += '/v1';
  url.pathname = pathname || '/';
  return url.toString().replace(/\/+$/, '');
}

function writeConfig(spec, file = configPath()) {
  const { config, text } = readConfig(file);
  const old = config.provider?.[PROVIDER_ID];
  if (old !== undefined && !owns(old)) throw new Error('ZCode provider ID mixrouter-managed 已被非本集成占用，拒绝覆盖');
  const models = { ...(old?.models || {}) };
  const previouslyOwned = new Set(Array.isArray(old?.[META]?.models) ? old[META].models : []);
  const foreign = Object.keys(models).filter(id => !previouslyOwned.has(id));
  if (old && foreign.length && (old.kind !== KINDS[spec.wire_api] ||
      old.options?.baseURL !== baseURL(spec.base_url, spec.wire_api) || old.options?.apiKey !== spec.api_key))
    throw new Error('自有 provider 中存在其它模型，拒绝改变其协议或上游');
  for (const id of spec.models) {
    if (Object.hasOwn(models, id) && !previouslyOwned.has(id)) throw new Error('自有 provider 中模型 ID 已被其它配置占用，拒绝覆盖');
  }
  for (const id of previouslyOwned) if (!spec.models.includes(id)) delete models[id];
  for (const id of spec.models) {
    // 不推断模型能力；未填写的能力由客户端默认。
    Object.defineProperty(models, id, { value: { ...models[id], name: `Mixrouter · ${id}` }, enumerable: true, writable: true, configurable: true });
  }
  const provider = {
    ...old, name: 'Mixrouter', kind: KINDS[spec.wire_api], source: 'custom', enabled: true,
    options: { ...old?.options, apiKey: spec.api_key, baseURL: baseURL(spec.base_url, spec.wire_api), apiKeyRequired: true },
    models,
    [META]: { ...old?.[META], owner: 'mixrouter', version: 1, target: spec.target,
      wire_api: spec.wire_api, model: spec.model, models: spec.models },
  };
  config.provider = { ...config.provider, [PROVIDER_ID]: provider };
  const output = JSON.stringify(config, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  if (text !== null) fs.writeFileSync(`${file}.bak-mixrouter-${suffix}`, text, { flag: 'wx', mode: 0o600 });
  const tmp = `${file}.tmp-mixrouter-${suffix}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, output); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const prefix = path.basename(file) + '.bak-mixrouter-';
    const backups = fs.readdirSync(path.dirname(file))
      .filter(name => name.startsWith(prefix) && /^\d{13}-[a-f0-9]{16}$/.test(name.slice(prefix.length)))
      .sort();
    for (const name of backups.slice(0, -5)) {
      // Only our uniquely named backups are subject to retention.
      try { fs.unlinkSync(path.join(path.dirname(file), name)); } catch {}
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// Reports only the registered integration, never the desktop's selected session.
function liveState(expected, routerURL, file = configPath()) {
  const empty = { base_url: '', model: '', wire_api: '', provider: '', router: false, match: false };
  try {
    const { config } = readConfig(file);
    const p = config.provider?.[PROVIDER_ID];
    if (!p) return empty;
    if (!owns(p)) return { ...empty, error: 'ZCode provider ID mixrouter-managed 已被非本集成占用' };
    const meta = p[META];
    const wire = Object.keys(KINDS).find(key => KINDS[key] === p.kind) || '';
    // Even a manually edited URL may contain a key in userinfo/query. Never expose it.
    let base = '';
    try { base = baseURL(p.options?.baseURL, wire); } catch {}
    const live = { ...empty, base_url: base, model: typeof meta.model === 'string' ? meta.model : '',
      wire_api: wire, provider: PROVIDER_ID,
      router: !!wire && base === baseURL(routerURL, wire) };
    let spec;
    try { spec = expected(meta); } catch { return live; }
    live.match = !!(spec && meta.target === spec.target && meta.wire_api === spec.wire_api &&
      p.kind === KINDS[spec.wire_api] && p.source === 'custom' && p.enabled !== false && !p.systemDisabledReason &&
      (!p.id || p.id === PROVIDER_ID) && !authHeaders(p.headers) && !authHeaders(p.options?.headers) &&
      !overridesConnection(p.zcode, p.kind) &&
      (p.defaultKind === undefined || p.defaultKind === p.kind) &&
      (p.apiFormat === undefined || p.apiFormat === ({ anthropic: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-chat-completions' })[spec.wire_api]) &&
      p.options?.baseURL === baseURL(spec.base_url, spec.wire_api) &&
      p.options.apiKey === spec.api_key && p.options.apiKeyRequired === true &&
      meta.model === spec.model && spec.models.every(id => {
        const model = p.models?.[id];
        return isObject(model) && (!model.id || model.id === id) && !overridesConnection(model, p.kind, id);
      }));
    return live;
  } catch (e) { return { ...empty, error: e.message }; }
}

module.exports = { PROVIDER_ID, KINDS, isObject, invalid, configPath, readConfig, baseURL, writeConfig, liveState };
