# Local Langfuse For OpenAcme Test

This Docker Compose stack is for local OpenAcme observability testing only. It is isolated from `~/.openacme`; generated secrets and OpenAcme test env wiring live under `~/.openacme-test`.

## Files

- `docker-compose.yml` - Langfuse v3 web/worker, Postgres, ClickHouse, Redis, and MinIO.
- `setup-env.mjs` - generates local-only secrets and updates `~/.openacme-test/.env` with Langfuse connection keys.

## Start

```bash
node ops/langfuse-local/setup-env.mjs
docker compose --env-file ~/.openacme-test/langfuse/.env -f ops/langfuse-local/docker-compose.yml up -d
```

Langfuse UI:

```text
http://localhost:3000
```

The initial login email is written by `setup-env.mjs`; the password is stored in `~/.openacme-test/langfuse/.env` as `LANGFUSE_INIT_USER_PASSWORD`.

## OpenAcme Test Integration

`setup-env.mjs` sets these keys in `~/.openacme-test/.env`:

```bash
OPENACME_E2E_LANGFUSE=1
OPENACME_OBSERVABILITY=langfuse
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
```

The isolated OpenAcme test daemon should run on its own port so it does not
conflict with the default `~/.openacme` daemon:

```bash
pnpm agent start -d ~/.openacme-test --no-service --no-browser
```

Current local test convention:

```text
~/.openacme-test -> http://localhost:3457
~/.openacme      -> http://localhost:3456
```

Run the visibility canary:

```bash
pnpm test:e2e:langfuse
```

## Stop

```bash
docker compose --env-file ~/.openacme-test/langfuse/.env -f ops/langfuse-local/docker-compose.yml down
```

Remove local Langfuse Docker volumes:

```bash
docker compose --env-file ~/.openacme-test/langfuse/.env -f ops/langfuse-local/docker-compose.yml down -v
```
