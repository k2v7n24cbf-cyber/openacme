# @openacme/workflows

Workflow definition schemas and runtime seams for OpenAcme.

This package owns the workflow DSL, validation, deterministic runner, and
dispatcher orchestration contracts. It executes workflow control-flow and
builtin runtime semantics through explicit ports for persistence, events, MCP
tools, agent calls, and Python execution.

The package does not own OpenAcme server routing, SQLite schema definitions, UI
state, or concrete MCP/agent/Python adapters. Those live in the server, DB, and
web packages so the workflow core remains transport-independent and testable.
