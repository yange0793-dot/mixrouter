# Mixrouter

[![CI](https://github.com/yange0793-dot/mixrouter/actions/workflows/ci.yml/badge.svg)](https://github.com/yange0793-dot/mixrouter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)

本地模型路由器 + 客户端配置切换器(2026-09-05 重写,核心是 Anthropic 协议路由代理,其余向 cc-switch 看齐):

- **渠道分 Claude Code / Codex 两组**,自由增删改查,一键「切换」写入客户端真实配置(自动备份,保留原文件其余内容)
- **路由核心**:经 :8787 的请求按模型名规则改写并转发到不同上游(仅 Claude 组渠道为目标)
- **控制台 UI 对齐 cc-switch 视觉语言**:软色状态徽章(当前/配置漂移/停用)、当前渠道
  翠绿描边发光、漂移琥珀警告横幅、虚线空态、右上角滑入 toast、请求日志统计条 + 渠道/模型/状态筛选

```
~/mixrouter/
├── mixrouter.js              # 核心:零依赖 Node 单进程
├── mixctl                    # 管理命令
├── public/index.html         # Web 控制台(渠道 / 路由 / 请求日志)
├── providers.json            # 渠道(含 key,0600,勿提交;模板见 providers.example.json)
├── routes.json               # 路由规则(本地运行时状态,勿提交;模板见 routes.example.json)
├── logs/                     # server.log + requests.jsonl(5MB 轮转)
├── scripts/import-ccswitch.js# 从 cc-switch 备份库导入渠道(claude + codex 两组)
├── test/                     # node --test 套件:纯函数单测 + 切换夹具 + 代理全链路集成
└── .github/workflows/        # CI(Node 18/22/24 矩阵)与 tag 发版(测试不过不发版)
```

## 运行

```bash
~/mixrouter/mixctl start      # 代理 :8787,控制台 http://127.0.0.1:8788
~/mixrouter/mixctl stop
~/mixrouter/mixctl status|ls|logs [n]|open
```

- **代理端口 8787**:只实现 Anthropic 协议 `POST /v1/messages` 与 `count_tokens`,
  兼容流式 SSE。响应头带 `x-mixrouter-provider` / `x-mixrouter-model` 便于排查。
- **控制台 8788**:顶部 Claude Code / Codex 应用切换(仿 cc-switch);渠道卡片支持
  测试 / 编辑 / 删除 / **切换**;「当前」渠道与客户端真实配置不一致时显示"配置漂移"告警;
  路由规则编辑与实时请求日志。
- **切换(Claude Code)**:只改 `~/.claude/settings.json` 的 env 里 `ANTHROPIC_BASE_URL /
  AUTH_TOKEN / MODEL`(+ 可选槽位 `ANTHROPIC_DEFAULT_*_MODEL`,渠道没填就不动),其余键原样保留。
- **切换(Codex)**:对 `~/.codex/config.toml` 做外科手术——顶层 `model / model_provider`
  原位替换,追加 `[model_providers.mixr-*]` section(沿用本机已验证的
  `experimental_bearer_token` 模式,不依赖 auth.json),用户自己的 section 一律不碰;
  二次切换会清掉旧的 mixr section 不留垃圾。
- **路由器只说 Anthropic 协议**,Codex 渠道切换后是直连上游、不经过 :8787
  (与 v1 结论一致:codex 走不了 mixrouter)。**Claude.app 桌面端的配置永远不碰**(见旧训)。

## 把 Claude CLI 指过来

`~/.claude/settings.json` 的 env:

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
"ANTHROPIC_AUTH_TOKEN": "本地随意,不校验",
"ANTHROPIC_MODEL": "claude-opus-5"
```

## 路由规则

- 匹配 = 请求模型名的**子串**(逗号分隔多个,大小写不敏感),自上而下首个启用规则生效;
  都不命中走默认路由,默认路由未绑渠道则回 503。
- 目标模型留空 = 透传请求模型;带 `[1M]` 后缀 = 自动剥离并附加
  `anthropic-beta: context-1m-2025-08-07` 头。
- 渠道可配自定义 UA;客户端未带 UA 时用 `claude-cli/…` 兜底
  (agentrouter 一类网关校验 UA,裸 curl 会 401)。

## 导入渠道(待用户确认后再执行)

```bash
node ~/mixrouter/scripts/import-ccswitch.js ~/cc-switch-backup-20260801-002805/cc-switch.db
```

导入 claude / codex 两组渠道(自动去重、剔除客户端自引用与无 key 条目;key 已失效的
AgentRouter copy 默认停用)。providers.json 含明文 key,权限 0600,已被 .gitignore 排除。

## 已验证(2026-09-05,v2.1)

- **自动化测试 37 条全绿**(`npm test`,Node ≥ 18,CI 在 18/22/24 三档跑):
  - 纯函数:模型改写与 `[1M]` beta 头合并、header 消洗、SSE/JSON usage 抽取、key 脱敏、TOML 转义、路由解析(优先级/停用/默认兜底)。
  - 配置切换(夹具经环境变量重定向):claude 组保留 settings.json 其余键 + 自动备份 + 0600;codex 组 mixr-* section 幂等替换、用户自定义 section 一字不动、live 漂移比对。
  - 代理全链路(mock 上游 + 临时端口):非流式/流式转发、模型改写、鉴权头、UA 兜底、count_tokens、503 分型(no_route_error / provider_disabled_error)、413 超限体面拒绝、base_url 保存校验、日志过滤(provider/model/status)与 /api/stats 聚合一致性、控制台 CRUD 与 key 不出网掩码。
- 真实环境手测:https 上游(对 agentrouter.org 实测,上游 401 原样透传)。

## 开发

```bash
npm test                 # node --test test/*.test.js
```

- 测试不依赖任何安装步骤(零依赖),运行时数据经 `MIXR_DATA_DIR`、
  `MIXR_CLAUDE_SETTINGS`、`MIXR_CODEX_CONFIG` 环境变量重定向到临时目录,**永不触碰真实配置**。
- `mixrouter.js` 被 require 时不自动起服务、不注册异常兜底(便于测试);直接 `node mixrouter.js` 才进入常驻模式。
- 发版:推 `v*` tag → Release 工作流先跑测试,通过后打源码包并创建 GitHub Release。

## Roadmap

- [x] [v2.1.x 稳定性](https://github.com/yange0793-dot/mixrouter/milestone/1) — v2.1.1 已发:413 体面拒绝、base_url 校验、503 分型
- [x] [v2.2 路由与可观测性](https://github.com/yange0793-dot/mixrouter/milestone/2) — v2.2.0 已发:日志过滤 + /api/stats 聚合、控制台 UI 对齐 cc-switch
- [ ] [v3 Codex 组走代理](https://github.com/yange0793-dot/mixrouter/milestone/3):Codex 渠道经 :8787 统一路由

## License

[MIT](LICENSE)

## 已知环境坑

- 本机代理为 fake-IP 模式(198.18.0.0/15):不存在的域名会被劫持,TLS 直接重置——
  测试渠道时用真实域名,「TLS 断连」多数是域名不存在而非网络故障。
