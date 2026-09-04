# Agent Note: ACP initialize 等待 Loader 树 settle

Status: implemented

[English](2026-09-03-acp-initialize-waits-for-loader-tree.md) | 中文

## Problem

冷启动的 ACP 进程在插件 apply 时就挂载 stdio transport，但客户端可以立刻驱动 `initialize → session/new → session/prompt`，此时根级兄弟条目——尤其是 MCP 客户端——仍处于 connect→listTools 窗口内。`boot()` 最终会 await 整个 Loader 树，但 transport 在该 await 完成之前就已开始服务请求，于是首个模型请求携带残缺的工具清单。生产宿主上的实测：第一条 request/header 只带 19 个内置工具、0 个 MCP 工具，下一条 header 才是 139 个工具（含 120 个 MCP schema）；模型因缺少结构化工具转而用 shell 探测 CLI，在正确性缺口之上又叠加了延迟。

## Decision

桥接层在 `apply` 时一次性捕获所属 Loader 服务（`ctx.get('loader')`），每个 `initialize` 处理器在广播任何能力之前先 `await loader.await()`。`await()` 只有在全部配置条目激活后才 settle，因此 required MCP 工具注册先于第一个会话与提示词；settle 失败会携带失败原因链拒绝 `initialize`（fail-closed，与 `failOnStartupError` 语义一致）。无 Loader 的应用看不到 `loader` 服务，行为不变。

## Alternatives considered

**固定启动延时。** 否决：时间延迟证明不了 readiness——慢机器、冷缓存或 MCP server 工具数增长后同一竞态复现，且每次快速启动都要白付这段延时。

**由 ACP demo 应用自己持有 MCP 客户端。** 否决：这把组合职责移进单个示例应用，且只覆盖 MCP。Loader 托管的 barrier 保护所有兄弟类型（任何晚注册的根级条目），不改变未组合 MCP server 的应用。

**把闸门放在 `session/new` 或首个提示词而不是 `initialize`。** 否决：`initialize` 是客户端观察到的第一个 readiness 边缘；客户端可能在建会话之前就基于广播的 agent 信息做分支，任何更晚的闸门都放任一个半就绪的 agent 被广播出去。

## Consequences

冷启动 `initialize` 现在要等最慢的 required 条目——换来真实的 readiness，而不是一个轮之后才静默自愈的残缺清单。过去会静默降级的配置（缺 MCP 工具、shell 绕路）现在在 `initialize` 处 fail closed 并给出 server 名称与原始原因，这正是期望的暴露方式。

覆盖面由窄到宽：桥接层 gate 单测（`packages/acp/acp/tests/bridge.spec.ts`）确定性地锁定 pending／失败／重复检查语义；`startup-readiness.e2e.ts` 经 stdio 驱动真实 bin，fixture MCP server 的 connect→listTools 窗口被延时，断言首条持久化 `request/header` 已含 `mcp__fixture__ready_probe`、无法启动的 server 会 fail closed、就绪期间客户端断开会 settle 挂起的 `initialize`；归属 ACP snapshot 套件的 `mcp-readiness` 场景（`examples/acp-agent/tests/acp.snapshot.ts`）以同样的根级兄弟组合做 keyless 回放，并在首条 request/header 中锁定 `mcp__fixture__*` schema——竞态由此进入默认的 keyless 层保护，而不只依赖 e2e 层。
