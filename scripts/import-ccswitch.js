#!/usr/bin/env node
// 从 cc-switch 备份库导入 Anthropic 协议渠道到 providers.json
// 用法: node import-ccswitch.js <cc-switch.db> [输出文件]
// 依赖系统 sqlite3 命令读取数据库
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const db = process.argv[2] || '/Users/tufu/cc-switch-backup-20260801-002805/cc-switch.db';
const out = process.argv[3] || path.join(__dirname, '..', 'providers.json');

const rows = JSON.parse(execFileSync('sqlite3', ['-json', db,
  "SELECT id, app_type, name, settings_config, notes FROM providers WHERE app_type IN ('claude','claude-desktop');"], { maxBuffer: 64 * 1024 * 1024 }));

// 已知停用原因(来自旧记忆 agentrouter-ua-check:2026-08-01 实测令牌在 anyrouter.top 无效)
const knownDead = base => /anyrouter\.top/.test(base);

const seen = new Set();
const providers = [];
let n = 0;
for (const r of rows) {
  let env = {};
  try { env = JSON.parse(r.settings_config).env || {}; } catch {}
  const base = env.ANTHROPIC_BASE_URL || '';
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  // 客户端自引用(mixrouter 自己)或无 key 的空壳不作为上游导入
  if (!base || base.includes('127.0.0.1:8787') || !key) continue;
  // 跨 app_type 去重:base+key 相同视为同一渠道
  const fp = base + '|' + key;
  if (seen.has(fp)) continue;
  seen.add(fp);
  const models = [...new Set([env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter(Boolean))];
  providers.push({
    id: 'p' + (++n),
    name: r.name,
    base_url: base.replace(/\/+$/, ''),
    api_key: key,
    models,
    enabled: !knownDead(base),
    note: (r.notes || '').trim() || (knownDead(base) ? '2026-08-01 实测令牌无效,导入时默认停用' : ''),
    created_at: new Date().toISOString(),
  });
}

// 追加 DeepSeek 官方 Anthropic 兼容端点(key 取自 cc-switch 库 opencode 条目)
const dkey = JSON.parse(execFileSync('sqlite3', ['-json', db,
  "SELECT settings_config FROM providers WHERE app_type='opencode' AND name='DeepSeek' LIMIT 1;"]))[0];
if (dkey) {
  const k = (JSON.parse(dkey.settings_config).options || {}).apiKey;
  if (k) providers.push({ id: 'p' + (++n), name: 'DeepSeek 官方', base_url: 'https://api.deepseek.com/anthropic',
    api_key: k, models: ['deepseek-chat', 'deepseek-reasoner'], enabled: true, note: 'Anthropic 兼容端点', created_at: new Date().toISOString() });
}

fs.writeFileSync(out, JSON.stringify(providers, null, 2), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`导入 ${providers.length} 个渠道 -> ${out}`);
for (const p of providers) console.log(`  [${p.enabled ? '启用' : '停用'}] ${p.name}  ${p.base_url}  ${p.models.join(', ') || '(未配模型)'}`);
