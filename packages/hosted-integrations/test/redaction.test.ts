import { describe, expect, it } from "vitest";
import {
  sanitizeHostedToolControlPlaneResult,
  sanitizeHostedToolControlPlaneString,
} from "../src/index.js";

describe("hosted tool control-plane redaction", () => {
  it("redacts sensitive object values while preserving response shape", () => {
    const result = sanitizeHostedToolControlPlaneResult({
      environmentConfig: {
        id: "qualys-prod",
        secrets: { apiToken: { configured: true } },
        nested: { password: "super-secret-value" },
        note: "bearer raw-token-123",
      },
    });

    expect(JSON.stringify(result)).not.toContain("apiToken");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("raw-token-123");
    expect(result).toEqual({
      environmentConfig: {
        id: "qualys-prod",
        secrets: "[REDACTED]",
        nested: { password: "[REDACTED]" },
        note: "[REDACTED]",
      },
    });
  });

  it("redacts token-like values and sensitive keys embedded in error strings", () => {
    expect(
      sanitizeHostedToolControlPlaneString(
        'Unrecognized keys: "raw-token-route-leak", "api_key"; Authorization: Bearer raw-token-123',
      ),
    ).toBe(
      'Unrecognized keys: "[REDACTED]", "[REDACTED]"; [REDACTED]: [REDACTED]',
    );
  });
});
