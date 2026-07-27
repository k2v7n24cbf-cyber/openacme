import { describe, expect, it } from "vitest";
import { serviceEnvironmentPassthrough } from "../src/lifecycle/common.js";

describe("service environment passthrough", () => {
  it("persists observability and forensic toggles needed by daemon restarts", () => {
    expect(
      serviceEnvironmentPassthrough({
        OPENACME_OBSERVABILITY: "langfuse",
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: "/tmp/openacme-forensics",
        LANGFUSE_BASE_URL: "http://127.0.0.1:3000",
        LANGFUSE_PUBLIC_KEY: "pk_test",
      })
    ).toEqual([
      ["OPENACME_OBSERVABILITY", "langfuse"],
      ["OPENACME_AI_FORENSICS", "1"],
      ["OPENACME_AI_FORENSICS_CAPTURE_RAW", "1"],
      ["OPENACME_AI_FORENSICS_DIR", "/tmp/openacme-forensics"],
      ["LANGFUSE_BASE_URL", "http://127.0.0.1:3000"],
      ["LANGFUSE_PUBLIC_KEY", "pk_test"],
    ]);
  });

  it("does not persist secret observability credentials into service files", () => {
    expect(
      serviceEnvironmentPassthrough({
        LANGFUSE_SECRET_KEY: "sk_secret",
        LOGFIRE_TOKEN: "lf_secret",
        OPENACME_OTLP_HEADERS: "authorization=secret",
      })
    ).toEqual([]);
  });
});
