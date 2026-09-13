# Mixrouter

[![CI](https://github.com/yange0793-dot/mixrouter/actions/workflows/ci.yml/badge.svg)](https://github.com/yange0793-dot/mixrouter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)

本地模型路由器 + 客户端配置切换器,一个进程同时吃两种协议:

- **Claude Code(Anthropic 协议)`/v1/messages` + Codex(OpenAI 协议)`/v1/responses`**
  都由 :8787 统一路由;chat 系网关(`/v1/chat/completions`)由代理自动翻译
- **同一个 Agent 的多个对话可以走不同渠道(key)**:Claude Code 带 `x-claude-code-session-id`,
  Codex 带 `session-id`/`thread-id`(body 里是 `prompt_cache_key`),代理以它为「对话」身份,
  把渠道池的成员按会话粘性分配——开三个对话就是三个渠道的 key 在并发,
  且一个对话内不会中途换渠道打断 prompt 缓存
- **Agent 支持 Claude Code / Codex / ZCode**。渠道按 Anthropic / OpenAI 两组复用，无需为 ZCode 重复保存 Key；
  **「切换」**让 Claude Code / Codex 直连渠道，**「接入 ZCode」**注册模型，**「路由模式」**指向本地代理（写入前自动备份）。
- **路由核心**:按模型名匹配规则,目标可绑单一渠道,也可绑**渠道池**(按策略分发);
  规则可用 `app` 限定只对某一组生效
- **子代理槽位(v3.2)**:给每个槽位(opus/sonnet/haiku/主模型,或 Codex 自拟槽名)绑定
  「渠道 @ 模型」,客户端用别名 `mixr-<槽名>` 发请求即按槽位落点分发,优先于路由规则——
  后台任务走便宜渠道、子代理走指定渠道,由你自由路由
- **失败转移**:池里首选渠道 429/5xx/连不上时,趁还没给客户端写字节自动换下一个,并把该渠道打入冷却
- **响应式控制台**：Agent 选择、概览统计、渠道搜索与启停筛选、直连/路由状态与配置漂移提示；
  会话列表可手动改绑，路由编辑器支持渠道池、策略、优先级和匹配条件，请求日志支持多条件筛选。
  支持键盘操作和窄屏布局；连接中断会明确显示离线，路由草稿不会被后台轮询覆盖。

```
~/mixrouter/
├── mixrouter.js              # 核心:零依赖 Node 单进程(代理 + 控制台 API)
├── mixctl                    # 管理命令(含 sessions / slots / route)
├── public/index.html         # Web 控制台(渠道 / 路由 / 槽位 / 会话 / 请求日志)
├── providers.json            # 渠道(含 key,0600,勿提交;模板见 providers.example.json)
├── routes.json               # 路由规则(本地运行时状态,勿提交;模板见 routes.example.json)
├── sessions.json             # 会话→渠道绑定(运行时状态,含对话标签,勿提交)
├── slots.json                # 子代理槽位(运行时状态,勿提交)
├── logs/                     # server.log + requests.jsonl(5MB 轮转)
├── scripts/import-ccswitch.js# 从 cc-switch 备份库导入渠道(claude + codex 两组)
├── test/                     # node --test 套件:纯函数单测 + 切换夹具 + 代理/会话/翻译全链路集成
└── .github/workflows/        # CI(Node 18/22/24 矩阵)与 tag 发版(测试不过不发版)
```

## 运行

```bash
npm start                     # 或 ./mixctl start(后台常驻 + .run/mixrouter.pid)
./mixctl stop
./mixctl status|ls|sessions|slots|logs [n]|route <claude|codex|zcode> [--slots]|open
```

- **代理端口 8787**,按端点自动分派到对应渠道组:

  | 端点 | 协议 | 渠道组 |
  | --- | --- | --- |
  | `POST /v1/messages`、`/v1/messages/count_tokens` | Anthropic | Claude Code |
  | `POST /v1/responses` | OpenAI responses(Codex 母语) | Codex |
  | `POST /v1/chat/completions` | OpenAI chat | Codex(`wire_api=chat` 的渠道) |
  | `GET /v1/models` | 只读模型清单 | Codex 组 + 路由目标 |
  | `HEAD <上面任意端点>` | 探活(供客户端探测) | — |

  响应头带 `x-mixrouter-app` / `x-mixrouter-provider` / `x-mixrouter-model` / `x-mixrouter-session` 便于排查。
- **控制台 8788**：顶部可选 Claude Code / Codex / ZCode；渠道支持搜索、筛选、测试、编辑、删除及客户端接入。
  配置状态与库内记录不一致时显示漂移告警；另有路由编辑、会话列表与实时请求日志。
- **切换(Claude Code)**:只改 `~/.claude/settings.json` 的 env 里 `ANTHROPIC_BASE_URL /
  AUTH_TOKEN / MODEL`(+ 可选槽位 `ANTHROPIC_DEFAULT_*_MODEL`,渠道没填就不动),其余键原样保留。
- **切换(Codex)**:对 `~/.codex/config.toml` 做外科手术——顶层 `model / model_provider`
  原位替换,追加 `[model_providers.mixr-*]` section(沿用本机已验证的
  `experimental_bearer_token` 模式,不依赖 auth.json),用户自己的 section 一律不碰;
  二次切换会清掉旧的 mixr section 不留垃圾。
- **Claude.app 桌面端的配置永远不碰**(见旧训)。

## 路由模式(让客户端走代理)

渠道列表右上角的 **⇄ 路由模式** 按钮把客户端整体指到本机代理,此后请求按「路由」页的规则分发到不同渠道;
想改回直连某一家的 key,点那家渠道卡片上的「切换」即可。

```bash
./mixctl route claude     # 等价于手改:ANTHROPIC_BASE_URL=http://127.0.0.1:8787
./mixctl route codex      # config.toml 顶层 model_provider 换成 mixr-router
```

- Claude Code:`ANTHROPIC_BASE_URL` → `http://127.0.0.1:8787`,
  `ANTHROPIC_AUTH_TOKEN` 填任意占位值(代理不校验,**模型名与槽位保持不动**——路由规则就按它匹配)。
- Codex:`base_url` → `http://127.0.0.1:8787/v1`,`wire_api = "responses"`,
  `experimental_bearer_token = "mixrouter-local"`(占位),**顶层 `model` 保持不动**。
- 真实 key 全部留在 `providers.json` 里,代理转发时才注入;客户端配置里不再有上游 key。

## ZCode 接入

1. 控制台选择 **ZCode**，再选 Anthropic、OpenAI Responses 或 OpenAI Chat 协议。
2. 复用对应组的渠道，点击 **接入 ZCode** 注册直连配置；也可点击 **接入路由** 注册本地代理配置。
3. 在 ZCode 的模型选择器中选择 **Mixrouter · …** 模型。如新条目未出现，请重启客户端并新建会话。

只写入桌面端 `~/.zcode/v2/config.json` 的自有 provider 条目，**不会修改默认模型、已有会话、其它服务商或 CLI 扩展配置**。
控制台显示的是“已注册的接入配置”，不是正在运行的 ZCode 会话所选模型。原文件损坏或自有名称发生冲突时拒绝覆盖；写入使用自动备份与原子替换。

| 接入协议 | ZCode provider kind | 复用渠道组 |
| --- | --- | --- |
| Anthropic | `anthropic` | Claude / Anthropic |
| OpenAI Responses | `openai` | Codex / OpenAI |
| OpenAI Chat | `openai-compatible` | Codex / OpenAI 中的 chat 渠道 |

ZCode 流量在路由、会话、日志中按所选协议归组，不单独冒充第三种协议。
路由接入需要对应组至少有一个启用且已填写模型的渠道，真实上游 Key 仍留在 Mixrouter 中。

```bash
./mixctl route zcode                 # 默认 Anthropic
./mixctl route zcode responses       # OpenAI Responses
./mixctl route zcode chat            # OpenAI Chat
```

## 子代理槽位(v3.2)

想让 Claude Code 的后台任务走便宜渠道、子代理走指定模型,或给 Codex 的多角色 worker 各配各的上游?
给槽位绑定「渠道 @ 模型」,客户端拿别名当模型名发请求,代理按槽位精确分发,**优先于一切路由规则**:

- **Claude Code 四个固定槽**:`main`(写 `ANTHROPIC_MODEL`)/ `opus` / `sonnet` / `haiku`
  (写对应 `ANTHROPIC_DEFAULT_*_MODEL`)。在控制台「渠道」页配置后点**「应用槽位到客户端」**,
  env 写入别名(`mixr-opus` 等,自动备份;未配置槽的旧 `mixr-` 别名会被清掉,手设的真实模型名不动)。
  此后 CC 的 Haiku 槽请求(标题生成、后台小任务、子代理)就会落到你选的渠道+模型上。
- **Codex 自拟槽名**:如 `worker`、`reviewer`。客户端处于路由模式后直接用:
  `codex exec -m mixr-worker` 或 `codex --model mixr-reviewer`;`GET /v1/models` 也会列出这些别名。
- 落点模型:Claude 槽绑定时选定;Codex 槽用渠道自带模型名。槽位请求不走会话粘性、不进渠道池,
  渠道停用/删除会得到明确的 `provider_disabled_error` / `no_route_error`。

```bash
./mixctl slots               # 查看槽位表(别名 → 渠道 @ 模型)
./mixctl route claude --slots   # 切路由模式并同时写入槽位 env
```

## 会话级渠道分发(v3 核心)

想让同一个 Agent 里**不同的对话用不同渠道的 key**(比如 A 对话烧 AgentRouter、B 对话烧另一个中转),
不用多开客户端,也不用改配置:把路由规则的目标设成**渠道池**即可。

**对话是怎么认出来的**——按可靠性依次兜底:

| 客户端 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| Claude Code | `x-claude-code-session-id` 头 | body `metadata.user_id` 里的 `session_id` | 内容指纹 |
| Codex | `session-id` / `thread-id` / `x-client-request-id` 头 | body `prompt_cache_key`、`client_metadata.session_id` | 内容指纹 |

实测 codex-cli 0.154.0 每个请求都带 `session-id`(与 `prompt_cache_key` 同值),`resume` 续聊保持同一个 id。
都没有(自定义客户端)就用「system/instructions + 首条用户消息」做 sha1 内容指纹,同内容即同对话;
两种客户端的会话键互不串味(`cc:` / `cx:` 前缀)。

同一个对话里的所有请求——包括子代理、`count_tokens`、标题生成——都共享这个身份,
所以它们始终落在同一个渠道上,不会因为中途换 key 打断 prompt 缓存。

**分发策略**(规则里的 `strategy`):

| 策略 | 行为 | 适合 |
| --- | --- | --- |
| `round_robin`(默认) | 新对话依次落到下一个成员 | 均摊额度,最好预料 |
| `weighted` | 平滑加权轮询(nginx 式),按成员 `weight` 比例 | 主力渠道多分点 |
| `least_used` | 优先给当前挂载对话最少的成员 | 成员额度不等、想动态均衡 |
| `random` | 随机 | 无特殊要求 |

**手动改绑**:控制台「会话」页列出所有活跃对话(分组 / 短 id / 对话标签 / 当前渠道 / 请求数),
可以直接下拉改绑某个对话到本组的指定渠道——手动指定**压过**策略,且允许指定池外的渠道;
「日志」按钮跳到该对话的请求日志;「解绑」让它下次请求重新按策略分配。

**失败转移**:池里选中的渠道返回 429/5xx 或连不上时,代理会在**尚未向客户端写任何字节**之前
换下一个成员重试(默认最多试 3 个),并把坏渠道打入冷却(默认 60 秒,冷却期内不再被选中),
同时把该对话重新绑到成功的渠道。全部失败才回 502。

**会话绑定会落盘**(`sessions.json`)并在重启后恢复,避免代理重启导致对话中途换渠道;
空闲 12 小时(可调)自动过期。

相关环境变量:`MIXR_SESSION_TTL_MIN`(默认 720)、`MIXR_SESSION_MAX`(1000)、
`MIXR_COOLDOWN_SEC`(60)、`MIXR_MAX_ATTEMPTS`(3)、`MIXR_SESSION_LABEL=0`(关掉对话标签采集)。

> 对话标签取自 Claude 的 system prompt 工作目录 / Codex 的首条用户消息(跳过
> `<environment_context>` 一类注入块),**只存在内存里,不写进请求日志**;不需要可用 `MIXR_SESSION_LABEL=0` 关闭。

## Codex 走代理(v3.1)

Codex 只说 `/v1/responses`(0.153 起 `wire_api = "chat"` 已被上游客户端移除),所以代理做两件事:

- **`wire_api=responses` 的渠道**:请求原样转发,只替换模型名;响应(流式/非流式)整包透传。
- **`wire_api=chat` 的渠道**(只开 `/v1/chat/completions` 的网关,如 GLM 系):
  代理现场翻译协议。请求方向 `instructions→system`、`developer→system`、
  `function_call→assistant.tool_calls`、`function_call_output→role:tool`、`reasoning` item 丢弃、
  工具定义从 responses 顶层字段包成 chat 的 `function` 包装,并自动加
  `stream_options.include_usage`(统计要 usage);响应方向把 chat SSE 译回 responses SSE——
  **首个文本 delta 之前先发 `response.output_item.added`**(否则 Codex 报
  `OutputTextDelta without active item`,这是本机独立代理时代踩过的坑),工具调用整包下发 `function_call` item。
- 图片:`input_image` 默认转成 chat 的 `image_url`;纯文本网关可在渠道上开
  **纯文本渠道(丢弃图片)**,代理会把它换成一句说明而不是让上游 400。
- `/v1/chat/completions` 端点也开着:chat 协议的客户端能直接用 chat 协议渠道;
  若路由命中的全是 responses 协议渠道,会明确回 `wire_api_mismatch_error`,不做静默降级。

## 路由规则

- 匹配 = 请求模型名的**子串**(逗号分隔多个,大小写不敏感);`priority` 数值大的先匹配,
  同优先级按数组顺序,首个启用且满足 `when` 的规则生效;都不命中走默认路由。
- **`app`** = 这条规则只对哪一组生效:`claude`(Anthropic 端点)/ `codex`(OpenAI 端点)/ 留空 = 两组通用。
  没写 `app` 的规则,若整条只绑了另一组渠道,那组请求会**跳过它继续往下匹配**(不会被一条 Claude 规则挡住);
  显式写了 `app` 的规则则严格只在自己那组生效。
- 目标可以是**单一渠道**(`provider`),也可以是**渠道池**(`pool`);池成员写成字符串即用规则的目标模型,
  写成对象可各自指定目标模型与权重:`[{"provider":"p1","model":"claude-opus-5","weight":2},{"provider":"p2"}]`。
  Codex 渠道自带模型名(`provider.model`),池成员/规则没写目标模型时就用它。
- `when` 附加匹配条件(**全部**满足才命中,均为子串):`session`(会话 id)、`ua`(客户端 UA)、
  `token`(客户端带来的凭据)。例:给某几个对话开小灶,或让不同工具走不同渠道。
- 目标模型留空 = 透传请求模型;带 `[1M]` 后缀 = 自动剥离并附加
  `anthropic-beta: context-1m-2025-08-07` 头(仅 Claude 通路)。
- 渠道可配自定义 UA(优先级:渠道 UA > 客户端 UA > 兜底);
  Claude 通路客户端未带 UA 时兜底 `claude-cli/…`,Codex 通路兜底 `codex_cli_rs/…`
  (agentrouter 一类网关校验 UA 形态,裸 curl 会 401)。

## 导入渠道(待用户确认后再执行)

```bash
node ~/mixrouter/scripts/import-ccswitch.js ~/cc-switch-backup-20260801-002805/cc-switch.db
```

导入 claude / codex 两组渠道(自动去重、剔除客户端自引用与无 key 条目;key 已失效的
AgentRouter copy 默认停用)。providers.json 含明文 key,权限 0600,已被 .gitignore 排除。

## 已验证

- **自动化测试**（`npm test`，Node ≥ 18，CI 在 18/22/24 三档跑）：
  - 纯函数:模型改写与 `[1M]` beta 头合并、header 消洗、SSE/JSON usage 抽取(三种协议)、key 脱敏、
    TOML 转义、路由解析(优先级/停用/默认兜底/分组)、会话身份识别(Claude 三级 + Codex 四级)、
    `when` 条件、规则归一化、UA 优先级、responses⇄chat 请求翻译、`chatJsonToResponses`。
  - 配置切换(夹具经环境变量重定向):claude 组保留 settings.json 其余键 + 自动备份 + 0600;
    codex 组 mixr-* section 幂等替换、用户自定义 section 一字不动、live 漂移比对;两种路由模式的写入与识别。
  - 代理全链路(mock 上游 + 临时端口):Claude 非流式/流式转发、模型改写、鉴权头、UA 兜底、count_tokens、
    503 分型(no_route_error / provider_disabled_error)、413 超限体面拒绝、base_url 保存校验、
    日志过滤(分组/渠道/模型/会话/状态)与 /api/stats 聚合一致性、控制台 CRUD 与 key 不出网掩码。
  - 会话分发 v3:池的四种策略(轮询逐对话分流、加权 3:1 比例、最少会话优先)、会话粘性、
    池成员独立目标模型、失败转移(连不上 / 5xx)与重绑、冷却与全冷却兜底、手动钉定压过策略、
    `priority` 与 `when.session/ua/token`、default 配池、会话 API(列表/改绑/解绑)、
    向后兼容老格式规则、密钥不出现在会话数据里。
  - **Codex 通路 v3.1**:responses 直通(路径/鉴权/UA/会话 id 透传/usage)、responses→chat 翻译
    (请求形状、SSE 事件顺序、工具调用翻译、usage 穿过翻译层)、chat 端点直通与 `wire_api_mismatch_error`、
    Codex 池会话粘性、失败转移、OpenAI 形状错误体、分组规则互不干扰、Codex 会话只能绑 Codex 组渠道、
    日志按分组过滤、`/v1/models` 与 HEAD 探活。
- **真机端到端**(2026-09-10,真实 `claude` CLI 2.1.267 打本地 mock 上游,零成本):
  三个独立对话分别落到三个渠道的三个不同 key;`--continue` 续聊保持同一会话 id 与原渠道;
  手动改绑后下一个请求立即改道。
- **真机端到端**(2026-09-11,真实 `codex` CLI 0.154.0 打本地 mock 上游,零成本):
  两个 `codex exec` 对话分别落到两个 responses 渠道;`codex exec resume --last` 续聊保持同一
  session id 与原渠道(sticky);`-m glm-5.3-flash` 命中 chat 协议渠道,代理翻译后 Codex 正常收流
  (token 计数与 usage 对得上),请求/用量照常进日志与会话统计。

## 开发

```bash
npm test                 # node --test test/*.test.js
```

- 测试不依赖任何安装步骤(零依赖),运行时数据经 `MIXR_DATA_DIR`、
  `MIXR_CLAUDE_SETTINGS`、`MIXR_CODEX_CONFIG`、`MIXR_ZCODE_CONFIG` 环境变量重定向到临时目录，**永不触碰真实配置**。
- `mixrouter.js` 被 require 时不自动起服务、不注册异常兜底(便于测试);直接 `node mixrouter.js` 才进入常驻模式。
- 改完 UI 记得确认控制台还能开:`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/`。
- 发版:推 `v*` tag → Release 工作流先跑测试,通过后打源码包并创建 GitHub Release。

## Roadmap

- [x] [v2.1.x 稳定性](https://github.com/yange0793-dot/mixrouter/milestone/1) — v2.1.1 已发:413 体面拒绝、base_url 校验、503 分型
- [x] [v2.2 路由与可观测性](https://github.com/yange0793-dot/mixrouter/milestone/2) — v2.2.0 已发:日志过滤 + /api/stats 聚合、控制台 UI 对齐 cc-switch
- [x] **v3.0 会话级渠道分发** — 同一 Agent 的多对话走不同渠道 key:会话身份识别、
  渠道池四策略 + 会话粘性、失败转移与冷却、priority/when 路由条件、会话视图与手动改绑
- [x] [v3.1 Codex 组走代理](https://github.com/yange0793-dot/mixrouter/issues/5) — OpenAI 端点
  (`/v1/responses`、`/v1/chat/completions`)、Codex 会话粘性、responses⇄chat 协议翻译、一键路由模式
- [ ] 跨组翻译(Codex 请求 → Claude 组渠道,反向亦然):让两组渠道互为备份,尚未实现

## License

[MIT](LICENSE)

## 已知环境坑

- 本机代理为 fake-IP 模式(198.18.0.0/15):不存在的域名会被劫持,TLS 直接重置——
  测试渠道时用真实域名,「TLS 断连」多数是域名不存在而非网络故障。
- 响应头的值只能是 latin-1:渠道名里的非 ASCII 字符在 `x-mixrouter-*` 头里会被消洗(日志/控制台不受影响)。
