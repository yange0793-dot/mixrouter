# Mixrouter

[![CI](https://github.com/yange0793-dot/mixrouter/actions/workflows/ci.yml/badge.svg)](https://github.com/yange0793-dot/mixrouter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)

本地模型路由器 + 客户端配置切换器(核心是 Anthropic 协议路由代理,其余向 cc-switch 看齐):

- **同一个 Agent 的多个对话可以走不同渠道(key)**:Claude Code 每个对话都带
  `x-claude-code-session-id`,代理以它为「对话」身份,把渠道池的成员按会话粘性分配——
  开三个对话就是三个渠道的 key 在并发,且一个对话内不会中途换渠道打断 prompt 缓存
- **渠道分 Claude Code / Codex 两组**,自由增删改查,一键「切换」写入客户端真实配置(自动备份,保留原文件其余内容)
- **路由核心**:经 :8787 的请求按模型名规则改写并转发;目标可绑单一渠道,也可绑**渠道池**(按策略分发)
- **失败转移**:池里首选渠道 429/5xx/连不上时,趁还没给客户端写字节自动换下一个,并把该渠道打入冷却
- **控制台 UI 对齐 cc-switch 视觉语言**:软色状态徽章、当前渠道翠绿描边发光、漂移琥珀警告横幅、
  虚线空态、右上角滑入 toast;**会话视图**(看每个对话落在哪个渠道并手动改绑)、
  路由编辑器(池/策略/优先级/匹配条件)、请求日志统计条 + 渠道/模型/会话/状态筛选

```
~/mixrouter/
├── mixrouter.js              # 核心:零依赖 Node 单进程
├── mixctl                    # 管理命令(含 sessions)
├── public/index.html         # Web 控制台(渠道 / 路由 / 会话 / 请求日志)
├── providers.json            # 渠道(含 key,0600,勿提交;模板见 providers.example.json)
├── routes.json               # 路由规则(本地运行时状态,勿提交;模板见 routes.example.json)
├── sessions.json             # 会话→渠道绑定(运行时状态,含对话标签,勿提交)
├── logs/                     # server.log + requests.jsonl(5MB 轮转)
├── scripts/import-ccswitch.js# 从 cc-switch 备份库导入渠道(claude + codex 两组)
├── test/                     # node --test 套件:纯函数单测 + 切换夹具 + 代理/会话全链路集成
└── .github/workflows/        # CI(Node 18/22/24 矩阵)与 tag 发版(测试不过不发版)
```

## 运行

```bash
~/mixrouter/mixctl start      # 代理 :8787,控制台 http://127.0.0.1:8788
~/mixrouter/mixctl stop
~/mixrouter/mixctl status|ls|sessions|logs [n]|open
```

- **代理端口 8787**:只实现 Anthropic 协议 `POST /v1/messages` 与 `count_tokens`,
  兼容流式 SSE。响应头带 `x-mixrouter-provider` / `x-mixrouter-model` / `x-mixrouter-session` 便于排查。
- **控制台 8788**:顶部 Claude Code / Codex 应用切换(仿 cc-switch);渠道卡片支持
  测试 / 编辑 / 删除 / **切换**;「当前」渠道与客户端真实配置不一致时显示"配置漂移"告警;
  路由编辑、会话列表与实时请求日志。
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

## 会话级渠道分发(v3 核心)

想让同一个 Claude Code 里**不同的对话用不同渠道的 key**(比如 A 对话烧 AgentRouter、
B 对话烧另一个中转),不用多开客户端,也不用改配置:把路由规则的目标设成**渠道池**即可。

**对话是怎么认出来的**——按可靠性依次兜底:

1. `x-claude-code-session-id` 请求头(Claude Code 2.1.x 每个请求都带,`--continue` 续聊保持同一个)
2. 请求体 `metadata.user_id` 里的 `session_id`(个别版本这里才是真身,且是 JSON 字符串)
3. 都没有(非 CC 客户端)就用「system prompt + 首条用户消息」做 sha1 内容指纹,同内容即同对话

同一个对话里的所有请求——包括子代理、`count_tokens`、标题生成——都共享这个身份,
所以它们始终落在同一个渠道上,不会因为中途换 key 打断 prompt 缓存。

**分发策略**(规则里的 `strategy`):

| 策略 | 行为 | 适合 |
| --- | --- | --- |
| `round_robin`(默认) | 新对话依次落到下一个成员 | 均摊额度,最好预料 |
| `weighted` | 平滑加权轮询(nginx 式),按成员 `weight` 比例 | 主力渠道多分点 |
| `least_used` | 优先给当前挂载对话最少的成员 | 成员额度不等、想动态均衡 |
| `random` | 随机 | 无特殊要求 |

**手动改绑**:控制台「会话」页列出所有活跃对话(短 id + 对话标签 + 当前渠道 + 请求数),
可以直接下拉改绑某个对话到指定渠道——手动指定**压过**策略,且允许指定池外的渠道。
「日志」按钮会跳到该对话的请求日志;「解绑」让它下次请求重新按策略分配。

**失败转移**:池里选中的渠道返回 429/5xx 或连不上时,代理会在**尚未向客户端写任何字节**之前
换下一个成员重试(默认最多试 3 个),并把坏渠道打入冷却(默认 60 秒,冷却期内不再被选中),
同时把该对话重新绑到成功的渠道。全部失败才回 502。

**会话绑定会落盘**(`sessions.json`)并在重启后恢复,避免代理重启导致对话中途换渠道;
空闲 12 小时(可调)自动过期。

相关环境变量:`MIXR_SESSION_TTL_MIN`(默认 720)、`MIXR_SESSION_MAX`(1000)、
`MIXR_COOLDOWN_SEC`(60)、`MIXR_MAX_ATTEMPTS`(3)、`MIXR_SESSION_LABEL=0`(关掉对话标签采集)。

> 对话标签取自 system prompt 里的工作目录,否则取首条用户消息前 60 字,
> **只存在内存里,不写进请求日志**;不需要可用 `MIXR_SESSION_LABEL=0` 关闭。

## 路由规则

- 匹配 = 请求模型名的**子串**(逗号分隔多个,大小写不敏感);`priority` 数值大的先匹配,
  同优先级按数组顺序,首个启用且满足 `when` 的规则生效;都不命中走默认路由。
- 目标可以是**单一渠道**(`provider`),也可以是**渠道池**(`pool`);池成员写成字符串即用规则的目标模型,
  写成对象可各自指定目标模型与权重:`[{"provider":"p1","model":"claude-opus-5","weight":2},{"provider":"p2"}]`。
- `when` 附加匹配条件(**全部**满足才命中,均为子串):`session`(会话 id)、`ua`(客户端 UA)、
  `token`(客户端带来的凭据)。例:给某几个对话开小灶,或让不同工具走不同渠道。
- 目标模型留空 = 透传请求模型;带 `[1M]` 后缀 = 自动剥离并附加
  `anthropic-beta: context-1m-2025-08-07` 头。
- 渠道可配自定义 UA(优先级:渠道 UA > 客户端 UA > `claude-cli/…` 兜底);
  客户端未带 UA 时用 `claude-cli/…` 兜底(agentrouter 一类网关校验 UA,裸 curl 会 401)。

## 导入渠道(待用户确认后再执行)

```bash
node ~/mixrouter/scripts/import-ccswitch.js ~/cc-switch-backup-20260801-002805/cc-switch.db
```

导入 claude / codex 两组渠道(自动去重、剔除客户端自引用与无 key 条目;key 已失效的
AgentRouter copy 默认停用)。providers.json 含明文 key,权限 0600,已被 .gitignore 排除。

## 已验证

- **自动化测试 70 条全绿**(`npm test`,Node ≥ 18,CI 在 18/22/24 三档跑):
  - 纯函数:模型改写与 `[1M]` beta 头合并、header 消洗、SSE/JSON usage 抽取、key 脱敏、TOML 转义、
    路由解析(优先级/停用/默认兜底)、会话身份三级识别、`when` 条件、规则归一化、UA 优先级。
  - 配置切换(夹具经环境变量重定向):claude 组保留 settings.json 其余键 + 自动备份 + 0600;
    codex 组 mixr-* section 幂等替换、用户自定义 section 一字不动、live 漂移比对。
  - 代理全链路(mock 上游 + 临时端口):非流式/流式转发、模型改写、鉴权头、UA 兜底、count_tokens、
    503 分型(no_route_error / provider_disabled_error)、413 超限体面拒绝、base_url 保存校验、
    日志过滤(provider/model/session/status)与 /api/stats 聚合一致性、控制台 CRUD 与 key 不出网掩码。
  - 会话分发 v3:池的四种策略(轮询逐对话分流、加权 3:1 比例、最少会话优先)、会话粘性、
    池成员独立目标模型、失败转移(连不上 / 5xx)与重绑、冷却与全冷却兜底、手动钉定压过策略、
    `priority` 与 `when.session/ua/token`、default 配池、会话 API(列表/改绑/解绑)、
    向后兼容老格式规则、密钥不出现在会话数据里。
- **真机端到端**(2026-09-10,真实 `claude` CLI 2.1.267 打本地 mock 上游,零成本):
  三个独立对话分别落到三个渠道的三个不同 key;`--continue` 续聊保持同一会话 id 与原渠道;
  手动改绑后下一个请求立即改道。脚本见 issue #5。

## 开发

```bash
npm test                 # node --test test/*.test.js
```

- 测试不依赖任何安装步骤(零依赖),运行时数据经 `MIXR_DATA_DIR`、
  `MIXR_CLAUDE_SETTINGS`、`MIXR_CODEX_CONFIG` 环境变量重定向到临时目录,**永不触碰真实配置**。
- `mixrouter.js` 被 require 时不自动起服务、不注册异常兜底(便于测试);直接 `node mixrouter.js` 才进入常驻模式。
- 改完 UI 记得确认控制台还能开:`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/`。
- 发版:推 `v*` tag → Release 工作流先跑测试,通过后打源码包并创建 GitHub Release。

## Roadmap

- [x] [v2.1.x 稳定性](https://github.com/yange0793-dot/mixrouter/milestone/1) — v2.1.1 已发:413 体面拒绝、base_url 校验、503 分型
- [x] [v2.2 路由与可观测性](https://github.com/yange0793-dot/mixrouter/milestone/2) — v2.2.0 已发:日志过滤 + /api/stats 聚合、控制台 UI 对齐 cc-switch
- [x] **v3.0 会话级渠道分发** — 同一 Agent 的多对话走不同渠道 key:会话身份识别、
  渠道池四策略 + 会话粘性、失败转移与冷却、priority/when 路由条件、会话视图与手动改绑
- [ ] [v3.x Codex 组走代理](https://github.com/yange0793-dot/mixrouter/milestone/3):Codex 渠道经 :8787 统一路由

## License

[MIT](LICENSE)

## 已知环境坑

- 本机代理为 fake-IP 模式(198.18.0.0/15):不存在的域名会被劫持,TLS 直接重置——
  测试渠道时用真实域名,「TLS 断连」多数是域名不存在而非网络故障。
