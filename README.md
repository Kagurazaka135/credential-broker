# credential-broker

> 一个跑在本机的凭证代理：**API 钥匙只活一份，客户端永远只拿「本地地址 + 假 key」。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 问题

API key 散落在各处——项目配置、代理脚本、测试脚本、shell 历史、IDE 设置……

任何一个文件被 push、截图、分享，或者写进日志，钥匙就出去了。而**一旦进了 git 历史，就再也删不干净**。

常见的做法是加各种 pre-commit 扫描、`.gitignore` 规则、泄漏检测——但它们都是**事后拦截**，永远有漏网的路径。

## 解法

换个方向：**让钥匙从一开始就不进入客户端。**

```
                     ┌──────────────────────────────────────┐
   任何客户端 ────────→│   broker（本机）                      │
   baseUrl = 127.0.0.1 │                                      │
   apiKey  = 假 key     │   按【路径格式 × 模型名】选上游        │
                     │   替换成真钥匙后转发                   │
                     └───────────────┬──────────────────────┘
                                     │ 只读
                                     ▼
                            secrets.json   ← 唯一一份真钥匙
```

客户端配置里合法的东西只剩 `127.0.0.1` 和一个假 key。于是：

- **push 出去的代码结构上不可能带真钥匙**
- 项目里出现 `sk-...` **在定义上就是手滑**——不用判断、没有假阳性、不需要维护白名单
- 「不小心把 API 打出去」变成不可能

> 这不是"把钥匙藏起来"，而是**把钥匙从客户端代码里彻底移出去**。

---

## 特性

- **零协议转换**：上游原生支持 Anthropic 与 OpenAI 两套端点，broker 只做「按路径分流」，不做格式翻译
  → **不破坏 prompt caching**（这对 Claude Code 这类长会话工具是刚需）
- **一个端口说两种格式**：`/v1/messages`（Anthropic）与 `/v1/chat/completions`（OpenAI）
- **按模型名路由**：不同前缀走不同上游（DeepSeek / 小米 MiMo / OpenRouter）
- **钉供给方**：`or/` 路由可加 `@tag` 后缀，把同一个模型钉到指定供应商（`allow_fallbacks:false`，钉不住就报错，绝不偷偷换一家）
- **用量记账**：每个完成的转发追加一行 JSON（模型 / 输入 / 输出 / 缓存 token），可用自带脚本汇总——**只记数字与模型名，不记内容**
- **降级不崩**：读不到钥匙文件 → 记 WARN + 透传，进程不死
- **加钥匙免重启**：钥匙文件改动 **10 秒内自动重读**
- **日志不含敏感信息**：从不记录请求体 / 响应体 / 请求头
- **零依赖**：单个 `.cjs` 文件，只用 Node 内置模块

---

## 快速开始

### 1. 写钥匙文件

默认路径 `~/.claude/secrets.json`（可用环境变量 `BROKER_SECRETS_PATH` 覆盖）：

```jsonc
{
  "accept_token": "local-broker",
  "upstreams": {
    "deepseek":   { "anthropic_key": "sk-...", "openai_key": "sk-..." },
    "xiaomi":     { "anthropic_key": "sk-...", "openai_key": "sk-..." },
    "openrouter": { "openai_key": "sk-or-..." }
  },
  "v2ray": { "host": "127.0.0.1", "port": 10809 }
}
```

> `v2ray` 段是可选的：只有当你要用需要出海的 `or/` 路由时才需要。

### 2. 起代理

```bash
node broker.cjs --port 9999
```

### 3. 客户端这么调

```bash
curl http://127.0.0.1:9999/v1/chat/completions \
  -H "authorization: Bearer local-broker" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-flash","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

**换模型只改 `model` 字段**，别的一律不动。见下方路由表。

---

## 路由

按 **路径格式 × 模型名前缀** 选上游，零转换：

| 模型名前缀 | 上游 | 说明 |
|---|---|---|
| `or/*` | OpenRouter（`/api`，**经 v2ray 隧道出海**） | 剥掉 `or/` 前缀转给 OR；可在 OR 上测任意厂商模型 |
| `mimo*` | 小米 MiMo（`api.xiaomimimo.com`，**直连不经隧道**） | 与 OR 同名、不加前缀；上游在途并发上限 ≈100 |
| `glm*` | **400 拒绝** | 见下「关于 GLM」 |
| 其他 | DeepSeek（`/anthropic`） | 默认落点 |

两种格式（`/v1/messages` 与 `/v1/chat/completions`）各自拼各自的上游路径（如 DeepSeek 的 `/anthropic` vs `/v1`），**不做任何格式翻译**。

### `or/` 前缀约定

`or/anthropic/claude-opus-4.7` → 剥掉 `or/` 后转给 OpenRouter。用它可以在 OpenRouter 上测任意厂商的模型，而钥匙只存一份。

### 关于 GLM

GLM 走 **OpenRouter**，用 OR 全名 + `@tag` 后缀钉供给方：

```
or/z-ai/glm-5.3@zai     # 钉智谱官方（Z.AI）
or/z-ai/glm-5.3@ali     # 钉阿里（Alibaba）
or/z-ai/glm-5.3         # 不带后缀 = OR 自选
```

> **为什么要 `@tag`**：同一个 `z-ai/glm-5.3` 背后 OR 上挂了几十个供给方，不钉选就乱飘（可能落到
> 意料外的供应商）。`@zai`/`@zhipu` → `Z.AI`，`@ali`/`@alibaba` → `Alibaba`，其余 → 400。
> 钉供给方时 broker 注入 OR 原生 `provider` 字段并设 `allow_fallbacks:false`——**钉不住就响亮报错，绝不静默换一家**。
>
> 裸 `glm*`（无 `or/` 前缀）现在 **400 拒绝**——旧的阿里百炼直连路已移除，请用上面的 OR 全名。

### 路由表在哪

`broker.cjs` 顶部的 `UPSTREAMS`（上游端点）与 `routeFor()`（前缀规则）两个常量/函数，改起来是几行的事。

---

## 配置参考

### 命令行 / 环境变量

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `BROKER_PORT` | `9999` | 监听端口 |
| `--host` | `BROKER_HOST` | `127.0.0.1` | 监听地址（**强烈建议保持本地**） |
| — | `BROKER_SECRETS_PATH` | `~/.claude/secrets.json` | 钥匙文件路径 |
| — | `BROKER_LOG` | `./broker-<port>.log` | 日志路径 |
| — | `BROKER_USAGE` | `./usage-<port>.jsonl` | 用量记录路径 |

### 健康检查

```bash
curl http://127.0.0.1:9999/healthz
# {"ok":true,"service":"credential-broker","port":9999,"listen":"127.0.0.1","secrets":"ok"}
```

`"secrets":"degraded"` 表示钥匙文件读不到，此时 broker 处于**透传模式**（不崩，但不会注入钥匙）。

### 双认（安全切换用）

| 客户端发的 key | broker 行为 |
|---|---|
| `local-broker`（或你在 `accept_token` 里指定的） | 替换成真钥匙 |
| 其他任何值 | **透传**（原样转发） |

这让「客户端从真钥匙切换到假钥匙」这一步**没有断线窗口**——换前换后都能工作。

---

## 用量记账

每个**成功完成**的转发会往 `usage-<port>.jsonl` 追加一行 JSON（`BROKER_USAGE` 可覆盖；超 32MB 轮转为 `.1`）：

```json
{"ts":"2026-10-01T13:45:16.938Z","port":9999,"route":"deepseek","reqModel":"deepseek-flash","upModel":null,"served":"deepseek-flash","kind":"A","stream":false,"status":200,"ms":688,"input":34,"output":20,"cacheRead":0,"cacheWrite":0}
```

- `kind`：`A` = Anthropic 格式，`O` = OpenAI 格式；`served` = 上游返回的模型名
- 字段：输入 / 输出 / 缓存读 / 缓存写 token 分开计
- **只记数字与模型名**——body / header / key 一概不记（同日志原则）；错误响应（如 `glm*` 的 400）不落记录
- OpenAI 流式会自动注入标准的 `stream_options.include_usage=true`，让末块带上用量（唯一一处会碰请求体的地方）

### 汇总脚本

仓库自带一个只读的汇总脚本，按 **天 × 模型** 聚合：

```bash
node tools/token-stats.js                 # 默认读 ./usage-*.jsonl
node tools/token-stats.js --dir <目录>     # 指定目录
node tools/token-stats.js --days 14        # 只看最近 14 天
node tools/token-stats.js --since 2026-10-01
node tools/token-stats.js --json           # 输出 JSON，给别的工具/面板读
```

---

## 安全建议

1. **锁本地**：默认只监听 `127.0.0.1`，不要改成 `0.0.0.0`（否则同局域网可访问）
2. **钥匙文件别进 git**：加进 `.gitignore`
3. **收紧文件权限**：
   ```powershell
   # Windows：只留当前用户
   icacls "$env:USERPROFILE\.claude\secrets.json" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
   ```
   ```bash
   # Unix
   chmod 600 ~/.claude/secrets.json
   ```
4. **日志 / 用量记录已脱敏**：broker 不记录 body / header / key，可安全保留

---

## 和网关类项目有什么不同？

如果你想要的是「把 key 分发给团队、限额度、看用量」，那应该用 [LiteLLM](https://github.com/BerriAI/litellm) / [new-api](https://github.com/Calcium-Ion/new-api) 这类**网关**——它们功能齐全，但钥匙存在自己的数据库和 Web UI 里。

这个项目解决的是**另一个问题**：单人/单机的场景下，怎么让钥匙**根本不进入客户端**。

| | 网关（LiteLLM / new-api） | credential-broker |
|---|---|---|
| 目标 | 分发、限流、计费、多租户 | 钥匙不出本机 |
| 协议转换 | 有（OpenAI ⇄ Anthropic 互转） | **无**（上游原生双端点） |
| prompt caching | 转换层可能破坏 | **完全保留** |
| 钥匙存放 | 网关的数据库 + UI | 本地单个文件 |
| 依赖 | 数据库 / Docker | **零依赖** |

> 简单说：**要治理选网关，要"钥匙别飞出去"选这个。**

---

## 示例

`examples/` 里有两个可直接跑的脚本：

| 脚本 | 用途 |
|---|---|
| `ask.js` | 换模型名就能问任意模型（顶部改 `MODEL` 和 `QUESTIONS`） |
| `live-test-broker.js` | 冒烟：多端口 × 双格式 × 各路由 |

```bash
node examples/ask.js            # 默认走 9999
node examples/ask.js 9997       # 指定端口
```

---

## 并发能力

broker **不设并发闸**——每个请求独立转发，没有队列，也没有连接池。

本机实测（直连上游、机器空载、短补全 `max_tokens=250`）：

| 并发 | 结果 | 墙钟 | 延迟 p50 |
|---|---|---|---|
| 100 | 100/100 | ~1.3s | 841ms |
| 200 | 200/200 | ~1.5s | 866ms |
| 300 | 300/300 | ~16.7s | 743ms |

100 与 200 的墙钟几乎一样（1.3s vs 1.5s）⇒ 确实是并行处理，没有排队。

**但别把这些数字当成"上限"读。** 同一台机器、同样的 300 并发，在连续压测过几轮之后再跑，
只能过 228/300（失败形态是 `502 upstream error` 和建连超时）。那不是 broker 加了闸——而是它
**不重用连接**（见「已知限制」）：每一轮都在本机堆 `TIME_WAIT`，实测能堆到 1000+，于是越跑越差。
等套接字排干（Windows 默认约 2 分钟）再跑，又回到 300/300。

**结论：broker 本身没有并发上限；实测数字取决于本机套接字状态和各自上游，不是一个固定值。**

具体到某条路由，还要看两个 broker 管不着的因素：

- **上游自己的在途并发上限** —— 实测有上游在 200 并发时半数返回 `429`（上限 ≈100）。这是上游的策略，broker 不介入也解决不了。
- **HTTP CONNECT 代理** —— 要经代理出海的路由，上限取决于那个代理，实测明显低于直连（本机 200 并发时只过 174~199，失败形态是 TLS 握手超时）。

---

## 已知限制

- **请求不重用连接** —— 每条请求新建一条到上游的 TLS 连接（没有 keepAlive agent）。低频无感；持续高并发会累积本机 `TIME_WAIT`，表现为"连续跑几轮后成功数递减"。可在客户端侧复用连接缓解，或给 `broker.cjs` 的上游请求挂一个 keepAlive agent。
- **日志轮转是"启动时"检查的** —— 进程若长期不重启，日志会持续增长。生产环境建议外部轮转（如 `logrotate`）或在代码里改成按大小实时检查。
- **路由表是硬编码的** —— 加新上游需要改 `UPSTREAMS`。
- **钥匙池轮询未实现** —— 结构上可以扩展（同上游多个 key 轮换），当前只取第一个。
- 面向本机单用户场景；不是多用户网关。

---

## License

[MIT](./LICENSE)
