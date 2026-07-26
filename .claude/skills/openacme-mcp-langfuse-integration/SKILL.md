---
name: openacme-mcp-langfuse-integration
description: Build, review, or modify OpenAcme MCP tools and MCP adapter code so tool results are correctly classified in Langfuse, OpenTelemetry, session timelines, and local AI forensics. Use when working on MCP server tools, MCP result envelopes, `mcp_*` tool registration, `@openacme/mcp-client`, stdio/HTTP MCP routing, `ToolEntry.classifyResult`, or forensic visibility for MCP tool success, failure, timeout, auth, rate-limit, and protocol outcomes.
---

# OpenAcme MCP Langfuse Integration

## Core Rules

- Default to the test runtime and test fixtures. Do not read, restart, or
  mutate `~/.openacme` unless the user explicitly asks for production.
- Treat Langfuse as the correlation UI, not the raw evidence store.
- Keep OpenAcme responsible for telemetry, evidence locators, local forensic
  files, and span status. MCP servers should return clear result semantics, not
  Langfuse-specific implementation details.
- Do not leak prompts, raw provider bodies, raw tool output bodies, absolute
  local paths, OAuth tokens, API keys, cookies, or customer data in telemetry.
- Preserve model-facing behavior unless the task explicitly changes the MCP
  tool contract.

## Workflow

1. Identify the MCP path:
   - HTTP/SSE MCP tools are registered by `@openacme/mcp-client`.
   - stdio MCP tools are discovered in the tool-host worker and mirrored as
     daemon-side proxy entries.
   - All MCP tools must still pass through `ToolRegistry` and
     `openacme.tool.execute`.

2. Read the target code before editing:
   - `packages/mcp-client/src/client.ts`
   - `packages/server/src/agent-manager.ts`
   - `packages/tool-host/src/worker.ts`
   - `packages/tools/src/registry.ts`
   - `packages/tools/src/outcome.ts`
   - `docs/ai-forensics.md`

3. Apply the result contract:
   - For OpenAcme-owned MCP tools, return a structured result envelope with
     bounded fields such as `success`, `error`, `failureKind`, `status`,
     `resultCount`, and domain facts.
   - For OpenAcme MCP adapter work, preserve native MCP semantics such as
     `isError`, content types, structured content, timeout, disconnected
     server, and protocol errors.
   - Do not classify "empty but valid" results as failures. Examples: no search
     matches, zero records, or an intentionally empty list.

4. Add or update classification:
   - Prefer a tool-owned or domain-owned classifier over central hard-coding.
   - MCP-specific classification should report `resultClassifier="mcp"` or a
     narrower classifier when the domain is known.
   - The registry should emit `executionStatus`, `resultStatus`,
     `failureKind`, `failureMessage`, and bounded MCP facts to local forensics
     and Langfuse-visible span attributes.

5. Test the behavior:
   - Add failing tests first for the exact MCP result shape being changed.
   - Cover success, logical failure, native MCP `isError`, timeout,
     disconnected server, malformed/protocol error, and empty success where
     relevant.
   - Test both HTTP/SSE MCP registration and stdio worker proxy behavior when
     the change affects both paths.

6. Verify observability:
   - Confirm `tool.start` and `tool.finish` or `tool.error` exist locally.
   - Confirm `openacme.tool.execute` carries outcome attributes.
   - Confirm failed MCP outcomes are visible as `resultStatus=failure` and, if
     applicable, timeline `status="error"`.
   - Use live Langfuse checks only against `~/.openacme-test`.

## Detailed Contract

Read `references/mcp-observability-contract.md` when implementing or reviewing
MCP result envelopes, classifiers, adapter behavior, tests, or Langfuse/local
forensic validation.
