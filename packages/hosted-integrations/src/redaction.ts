const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|passwd|pwd|credential|api[_-]?key|authorization)/i;
const SENSITIVE_KEY_TEXT_PATTERN =
  /\b(?:secret|token|password|passwd|pwd|credential|api[_-]?key|authorization)\b/gi;
const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+|raw-token[^\s'",\\\]}]*|super-secret[^\s'",\\\]}]*)/gi;

export function sanitizeHostedToolControlPlaneResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeHostedToolControlPlaneResult);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isSensitiveHostedToolKey(key)
          ? REDACTED
          : sanitizeHostedToolControlPlaneResult(child),
      ]),
    );
  }
  if (typeof value === "string") {
    return sanitizeHostedToolControlPlaneString(value);
  }
  return value;
}

export function sanitizeHostedToolControlPlaneString(message: string): string {
  return message
    .replace(SENSITIVE_VALUE_PATTERN, REDACTED)
    .replace(SENSITIVE_KEY_TEXT_PATTERN, REDACTED);
}

function isSensitiveHostedToolKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
