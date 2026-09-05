#!/usr/bin/env node
// 从 cc-switch 备份库导入渠道到 providers.json(v2.1 分组格式)
// 用法: node import-ccswitch.js <cc-switch.db> [输出文件]
// 依赖系统 sqlite3 命令读取数据库
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const db = process.argv[2] || '/Users/tufu/cc-switch-backup-20260801-002805/cc-switch.db';
const out = process.argv[3] || path.join(__dirname, '..', 'providers.json');

const rows = JSON.parse(execFileSync('sqlite3', ['-json', db,
  "SELECT id, app_type, name, settings_config, notes FROM providers;"], { maxBuffer: 64 * 1024 * 1024 }));

// 已知停用原因(来自旧记忆 agentrouter-ua-check:2026-08-01 实测令牌在 anyrouter.top 无效)
const knownDead = base => /anyrouter\.top/.test(base);

const seen = new Set();
const store = { version: 2, current: { claude: null, codex: null }, claude: [], codex: [] };
let n = 0;
for (const r of rows) {
  let sc = {};
  try { sc = JSON.parse(r.settings_config); } catch {}
  const env = sc.env || {};

  if (r.app_type === 'claude' || r.app_type === 'claude-desktop') {
    const base = env.ANTHROPIC_BASE_URL || '';
    const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    // 客户端自引用(mixrouter 自己)或无 key 的空壳不作为上游导入
    if (!base || base.includes('127.0.0.1:8787') || !key) continue;
    const fp = base + '|' + key;
    if (seen.has(fp)) continue;
    seen.add(fp);
    store.claude.push({
      id: 'p' + (++n), name: r.name, base_url: base.replace(/\/+$/, ''), api_key: key,
      models: [...new Set([env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter(Boolean))],
      slots: { opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '', sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '', haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '' },
      enabled: !knownDead(base),
      note: (r.notes || '').trim() || (knownDead(base) ? '2026-08-01 实测令牌无效,导入时默认停用' : ''),
      created_at: new Date().toISOString(),
    });
  } else if (r.app_type === 'codex') {
    // cc-switch 的 codex 条目:{auth:{OPENAI_API_KEY}, config:"TOML 字符串"}
    const key = (sc.auth && sc.auth.OPENAI_API_KEY) || '';
    const toml = sc.config || '';
    const model = (toml.match(/^model\s*=\s*"([^"]+)"/m) || [])[1] || '';
    const mprov = (toml.match(/^model_provider\s*=\s*"([^"]+)"/m) || [])[1] || '';
    const sec = mprov && toml.match(new RegExp(`\\[model_providers\\.${mprov.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\[]*`));
    const base = sec ? ((sec[0].match(/base_url\s*=\s*"([^"]*)"/) || [])[1] || '') : '';
    const wire = sec ? ((sec[0].match(/wire_api\s*=\s*"([^"]*)"/) || [])[1] || 'responses') : 'responses';
    if (!base || !key || !model) continue;
    const fp = base + '|' + key;
    if (seen.has(fp)) continue;
    seen.add(fp);
    store.codex.push({
      id: 'c' + (++n), name: r.name, base_url: base.replace(/\/+$/, ''), api_key: key,
      model, wire_api: wire === 'chat' ? 'chat' : 'responses', enabled: !knownDead(base),
      note: (r.notes || '').trim(), created_at: new Date().toISOString(),
    });
  }
}

// 追加 DeepSeek 官方 Anthropic 兼容端点(key 取自 cc-switch 库 opencode 条目)
try {
  const dkey = JSON.parse(execFileSync('sqlite3', ['-json', db,
    "SELECT settings_config FROM providers WHERE app_type='opencode' AND name='DeepSeek' LIMIT 1;"]))[0];
  const k = (JSON.parse(dkey.settings_config).options || {}).apiKey;
  if (k) store.claude.push({ id: 'p' + (++n), name: 'DeepSeek 官方', base_url: 'https://api.deepseek.com/anthropic',
    api_key: k, models: ['deepseek-chat', 'deepseek-reasoner'], slots: { opus: '', sonnet: '', haiku: '' },
    enabled: true, note: 'Anthropic 兼容端点', created_at: new Date().toISOString() });
} catch {}

fs.writeFileSync(out, JSON.stringify(store, null, 2), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`导入 claude ${store.claude.length} 个 / codex ${store.codex.length} 个 -> ${out}`);
for (const p of store.claude) console.log(`  [claude][${p.enabled ? '启用' : '停用'}] ${p.name}  ${p.base_url}  ${p.models.join(', ') || '(未配模型)'}`);
for (const p of store.codex) console.log(`  [codex ][${p.enabled ? '启用' : '停用'}] ${p.name}  ${p.base_url}  ${p.model} (${p.wire_api})`);
