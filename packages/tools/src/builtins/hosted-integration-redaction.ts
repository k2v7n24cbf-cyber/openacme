const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|passwd|pwd|credential|api[_-]?key|authorization)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+|raw-token|super-secret[^\s",}]*)/gi;

export function sanitizeHostedToolControlPlaneResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeHostedToolControlPlaneResult);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key)
          ? REDACTED
          : sanitizeHostedToolControlPlaneResult(child),
      ]),
    );
  }
  if (typeof value === "string") {
    return value.replace(SENSITIVE_VALUE_PATTERN, REDACTED);
  }
  return value;
}
