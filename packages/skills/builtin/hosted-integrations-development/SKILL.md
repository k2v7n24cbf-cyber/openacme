---
name: hosted-integrations-development
description: Lifecycle guide for the Tool Developer Agent when developing, validating, promoting, debugging, and repairing OpenAcme hosted integration tool families.
tags:
  - openacme
  - hosted-integrations
  - tool-development
---

Use this skill when working on hosted integration tool families through the `hosted_integration_*` management tools.

This initial skill is intentionally compact. The full lifecycle playbook is expanded in the next implementation slice.

Core rules:

- Use hosted integration management tools instead of direct filesystem access.
- Acquire a family lock before editing a draft.
- Register examples before promotion; every promoted tool needs at least one example.
- Run safe examples before promoting non-destructive changes.
- Never read, request, or return secret values. Treat config-scope secret metadata as the only agent-visible secret surface.
- For destructive promotion, stop at the approval boundary and return the target that needs human approval.
- For failures, inspect sanitized run logs and artifacts, bucket the failure when the platform surface exists, and add regression evidence before closing the repair loop.
