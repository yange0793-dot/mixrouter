# Mixrouter v2

本地 Anthropic 协议模型路由器(2026-09-05 重写版)。把 Claude 系客户端发来的请求按
**模型名路由规则**改写并转发到不同上游渠道,控制台 UI 仿 cc-switch 的卡片式布局。

```
~/mixrouter/
├── mixrouter.js              # 核心:零依赖 Node 单进程
├── mixctl                    # 管理命令
├── public/index.html         # Web 控制台(渠道 / 路由 / 请求日志)
├── providers.json            # 渠道(含 key,0600,勿提交)
├── routes.json               # 路由规则
├── logs/                     # server.log + requests.jsonl(5MB 轮转)
├── scripts/import-ccswitch.js# 从 cc-switch 备份库导入渠道
└── test/mock-upstream.js     # 假上游,验证链路用
```

## 运行

```bash
~/mixrouter/mixctl start      # 代理 :8787,控制台 http://127.0.0.1:8788
~/mixrouter/mixctl stop
~/mixrouter/mixctl status|ls|logs [n]|open
```

- **代理端口 8787**:只实现 Anthropic 协议 `POST /v1/messages` 与 `count_tokens`,
  兼容流式 SSE。响应头带 `x-mixrouter-provider` / `x-mixrouter-model` 便于排查。
- **控制台 8788**:渠道卡片(测试/编辑/启停/删除)、路由规则编辑、实时请求日志。
- mixrouter **只服务 CLI 类 Anthropic 客户端**;不支持 OpenAI `responses`/`chat/completions`,
  所以 codex 走不了它(与 v1 一致)。**Claude.app 桌面端的配置永远不碰**(见旧训)。

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

会导入 Anthropic 协议渠道(自动去重、剔除客户端自引用与无 key 条目;key 已失效的
AgentRouter copy 默认停用)。providers.json 含明文 key,权限 0600。

## 已验证(mock 上游,2026-09-05)

非流式/流式转发、模型改写、count_tokens、默认路由兜底、`[1M]` 剥离 + beta 头、
渠道连通性测试、请求日志(含 tokens/耗时/状态)、上游断连返回 Anthropic 风格 502、
控制台静态校验(元素 id / 事件函数 / JS 语法)。
