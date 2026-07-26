#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const targetDir = resolve(
  process.argv[2] ?? join(homedir(), ".openacme-test", "langfuse"),
);
const openAcmeEnvPath = resolve(
  process.argv[3] ?? join(homedir(), ".openacme-test", ".env"),
);
const langfuseEnvPath = join(targetDir, ".env");

mkdirSync(targetDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(openAcmeEnvPath), { recursive: true, mode: 0o700 });

const currentLangfuseEnv = readEnvFile(langfuseEnvPath);
const langfuseEnv = new Map(currentLangfuseEnv);

setDefault(langfuseEnv, "LANGFUSE_WEB_PORT", "3000");
setDefault(langfuseEnv, "MINIO_API_PORT", "9090");
setDefault(langfuseEnv, "MINIO_CONSOLE_PORT", "9091");
setDefault(langfuseEnv, "POSTGRES_VERSION", "17");
setDefault(langfuseEnv, "POSTGRES_USER", "postgres");
setDefault(langfuseEnv, "POSTGRES_DB", "postgres");
setDefault(langfuseEnv, "CLICKHOUSE_USER", "clickhouse");
setDefault(langfuseEnv, "MINIO_ROOT_USER", "minio");
setDefault(langfuseEnv, "AUTH_DISABLE_SIGNUP", "true");
setDefault(langfuseEnv, "TELEMETRY_ENABLED", "false");
setDefault(langfuseEnv, "LANGFUSE_INIT_ORG_ID", "openacme-test");
setDefault(langfuseEnv, "LANGFUSE_INIT_ORG_NAME", "OpenAcme Test");
setDefault(langfuseEnv, "LANGFUSE_INIT_PROJECT_ID", "openacme-ai-forensics");
setDefault(langfuseEnv, "LANGFUSE_INIT_PROJECT_NAME", "OpenAcme AI Forensics");
setDefault(
  langfuseEnv,
  "LANGFUSE_INIT_USER_EMAIL",
  "openacme-test@example.local",
);
setDefault(langfuseEnv, "LANGFUSE_INIT_USER_NAME", "OpenAcme Test");

setSecret(langfuseEnv, "POSTGRES_PASSWORD", 24);
setSecret(langfuseEnv, "CLICKHOUSE_PASSWORD", 24);
setSecret(langfuseEnv, "MINIO_ROOT_PASSWORD", 24);
setSecret(langfuseEnv, "REDIS_AUTH", 24);
setSecret(langfuseEnv, "NEXTAUTH_SECRET", 32);
setSecret(langfuseEnv, "SALT", 16);
setSecret(langfuseEnv, "LANGFUSE_INIT_USER_PASSWORD", 24);
setDefault(langfuseEnv, "ENCRYPTION_KEY", randomHex(32));
setDefault(
  langfuseEnv,
  "LANGFUSE_INIT_PROJECT_PUBLIC_KEY",
  `lf_pk_${randomHex(16)}`,
);
setDefault(
  langfuseEnv,
  "LANGFUSE_INIT_PROJECT_SECRET_KEY",
  `lf_sk_${randomHex(32)}`,
);

const webPort = langfuseEnv.get("LANGFUSE_WEB_PORT") ?? "3000";
setDefault(langfuseEnv, "NEXTAUTH_URL", `http://localhost:${webPort}`);
setDefault(
  langfuseEnv,
  "DATABASE_URL",
  `postgresql://${langfuseEnv.get("POSTGRES_USER")}:${langfuseEnv.get("POSTGRES_PASSWORD")}@postgres:5432/${langfuseEnv.get("POSTGRES_DB")}`,
);
setDefault(
  langfuseEnv,
  "LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY",
  langfuseEnv.get("MINIO_ROOT_PASSWORD") ?? "",
);
setDefault(
  langfuseEnv,
  "LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY",
  langfuseEnv.get("MINIO_ROOT_PASSWORD") ?? "",
);
setDefault(
  langfuseEnv,
  "LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY",
  langfuseEnv.get("MINIO_ROOT_PASSWORD") ?? "",
);
setDefault(
  langfuseEnv,
  "LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT",
  `http://localhost:${langfuseEnv.get("MINIO_API_PORT") ?? "9090"}`,
);
setDefault(
  langfuseEnv,
  "LANGFUSE_S3_BATCH_EXPORT_EXTERNAL_ENDPOINT",
  `http://localhost:${langfuseEnv.get("MINIO_API_PORT") ?? "9090"}`,
);

writeEnvFile(
  langfuseEnvPath,
  "OpenAcme local Langfuse test deployment. Do not commit this file.",
  langfuseEnv,
);

const openAcmeEnv = new Map(readEnvFile(openAcmeEnvPath));
openAcmeEnv.set("OPENACME_E2E_LANGFUSE", "1");
openAcmeEnv.set("OPENACME_OBSERVABILITY", "langfuse");
openAcmeEnv.set("LANGFUSE_BASE_URL", `http://localhost:${webPort}`);
openAcmeEnv.set(
  "LANGFUSE_PUBLIC_KEY",
  langfuseEnv.get("LANGFUSE_INIT_PROJECT_PUBLIC_KEY") ?? "",
);
openAcmeEnv.set(
  "LANGFUSE_SECRET_KEY",
  langfuseEnv.get("LANGFUSE_INIT_PROJECT_SECRET_KEY") ?? "",
);
writeEnvFile(
  openAcmeEnvPath,
  "OpenAcme test environment. Managed Langfuse keys are local-test only.",
  openAcmeEnv,
);

console.log(`langfuse_env=${langfuseEnvPath}`);
console.log(`openacme_test_env=${openAcmeEnvPath}`);
console.log(`langfuse_url=http://localhost:${webPort}`);
console.log(`langfuse_user=${langfuseEnv.get("LANGFUSE_INIT_USER_EMAIL")}`);

function readEnvFile(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq <= 0) return null;
      return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
    })
    .filter(Boolean);
}

function writeEnvFile(file, header, env) {
  const lines = [`# ${header}`];
  for (const [key, value] of [...env.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`${key}=${value}`);
  }
  writeFileSync(file, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(file, 0o600);
}

function setDefault(env, key, value) {
  if (!env.get(key)) env.set(key, value);
}

function setSecret(env, key, bytes) {
  setDefault(env, key, randomHex(bytes));
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}
