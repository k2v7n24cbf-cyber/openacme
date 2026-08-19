# Hosted Integrations Test Support

This directory contains fixtures and source evidence used by hosted integration
tests. It is not deployable hosted-family source.

`integration-hub/` captures historical legacy MCP replacement fixtures and
source-backed test material. These files are allowed as test evidence for
parity, inventory, schema, and migration checks, but hosted provider-family
packages must remain outside the platform repo as external source packages.

When tests need a deployable family package, prefer an explicit environment
variable or a repo sibling `openacme-hosted-tools-*` directory. Do not add
machine-specific absolute paths as defaults.
