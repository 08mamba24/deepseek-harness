# Agent Note: ACP initialize waits for the Loader tree to settle

Status: implemented

English | [中文](2026-09-03-acp-initialize-waits-for-loader-tree.zh.md)

## Problem

A cold-started ACP process mounts its stdio transport as soon as the plugin applies, but a client may drive `initialize → session/new → session/prompt` immediately, while root-sibling entries — MCP clients in particular — are still inside their connect→listTools window. `boot()` eventually awaits the whole Loader tree, yet the transport already serves requests before that await completes, so the first model request ships a partial tool inventory. Observed on a production host: the first request/header carried 19 built-in tools and 0 MCP tools, the following header 139 tools including 120 MCP schemas; the model, missing its structured tools, then probed for a CLI over the shell, adding latency on top of the correctness gap.

## Decision

The bridge captures the owning Loader service once at `apply` (`ctx.get('loader')`) and every `initialize` handler awaits `loader.await()` before advertising anything. `await()` settles only when every configured entry has activated, so required MCP tool registration precedes the first session and prompt; a settled entry failure rejects `initialize` with the failing cause chain (fail-closed, matching `failOnStartupError`). Loader-less apps see no `loader` service and run unchanged.

## Alternatives considered

**A fixed startup sleep.** Rejected: a time delay proves nothing about readiness — on a slow machine, a cold cache, or after an MCP server's tool count grows, the same race returns, and every fast start pays the delay.

**Owning the MCP clients inside the ACP demo app.** Rejected: it moves composition responsibility into one example app and only covers MCP. The Loader-hosted barrier protects every sibling kind (any late-registering root entry) without changing apps that compose no MCP servers.

**Gating at `session/new` or the first prompt instead of `initialize`.** Rejected: `initialize` is the first readiness edge the client observes; a client may legitimately reject or branch on the advertised agent before creating a session, and any later gate still lets a half-ready agent be advertised.

## Consequences

Cold-start `initialize` now takes as long as the slowest required entry — real readiness instead of a partial inventory that silently heals one turn later. A configuration that used to degrade quietly (missing MCP tools, shell workarounds) now fails closed at `initialize` with the server name and original cause, which is the desired surfacing.

Coverage, in widening scope: bridge-level gate unit tests (`packages/acp/acp/tests/bridge.spec.ts`) pin the pend/fail/re-check semantics deterministically; `startup-readiness.e2e.ts` drives the real bin over stdio with a fixture MCP server whose connect→listTools window is delayed and asserts the first persisted `request/header` already contains `mcp__fixture__ready_probe`, fails closed on an unstartable server, and settles a pending `initialize` when the client disposes during readiness; the `mcp-readiness` scenario in the owning ACP snapshot suite (`examples/acp-agent/tests/acp.snapshot.ts`) replays keylessly through the same root-sibling composition and pins the `mcp__fixture__*` schemas in the first request/header, so the race stays guarded in the default keyless tier, not only in the e2e tier.
