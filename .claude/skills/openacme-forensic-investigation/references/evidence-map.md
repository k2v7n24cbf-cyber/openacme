# OpenAcme AI Forensic Evidence Map

This file is the navigation index for detailed OpenAcme AI forensic
investigations. Use the narrower references below instead of relying on memory.

## Reference Files

- `source-surfaces.md`: data directories, source-of-truth surfaces, API
  endpoints, read-only SQL, logs, observability backend routing, and
  correlation fields.
- `evidence-resolution.md`: `evidenceRef` parsing, deterministic lookup,
  local archive layout, timeline filtering, backend-visible attributes, and
  raw-file conventions.
- `token-spike-analysis.md`: 4M-token style investigations, provider request
  growth, tool-output inflation, compression/history compaction, helper usage,
  memory events, title generation, subagents, and autonomous dispatcher events.
- `tool-outcomes.md`: tool wrapper failures versus logical result failures,
  shell/process/filesystem classification, MCP/custom tool expectations, and
  exact tool evidence lookup.
- `reporting-and-safety.md`: chat-safe reporting, prohibited raw content,
  blind spots, failure modes, and report templates.

## Minimum Loading Rule

For a forensic-grade answer, read `source-surfaces.md` and
`evidence-resolution.md` first. Then read the reference that matches the
suspected cause. Read `reporting-and-safety.md` before presenting findings.
