# Server Test Support

This directory contains helper code for server tests and deployed smoke
scripts. It is not server runtime source.

## Boundaries

- `hosted-tools/` owns hosted-tool dogfood and agent-behavior analysis helpers.
- `integration-hub/` owns historical parity helpers that compare hosted tools
  with the legacy `integration-hub` MCP surface.
- `e2e/support/` under `packages/server/test/e2e` owns browser/server harness
  helpers for end-to-end tests.

Provider-family runtime source must stay in external package repositories such
as sibling `openacme-hosted-tools-*` directories, or be supplied through explicit
environment variables:

- `OPENACME_QUALYS_HOSTED_PACKAGE_ROOT`
- `OPENACME_MSGRAPH_HOSTED_PACKAGE_ROOT`
- `OPENACME_MICROSOFT_DEFENDER_HOSTED_PACKAGE_ROOT`
- `OPENACME_SPLUNK_HOSTED_PACKAGE_ROOT`

Do not add machine-specific absolute paths as defaults. Tests may use repo
sibling defaults and should skip with clear diagnostics when an optional
external package is unavailable.

Live, parity, and dogfood scripts may read external package artifacts and legacy
MCP config as test inputs. They must not move integration-hub code into server
runtime, hosted runtime packages, or platform source directories.
