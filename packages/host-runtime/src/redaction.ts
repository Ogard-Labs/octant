import { HostRuntimeOwnershipError } from "./owner";
import { HostRuntimePathError } from "./paths";

const SENSITIVE_ASSIGNMENT =
  /((?:"|')?(?:authorization|bridge[_-]?secret|control[_-]?nonce|api[_-]?key|credential|password|passphrase|prompt|content|payload|provider[_-]?payload|secret|token|private[_-]?key)(?:"|')?\s*[:=]\s*)(?:Bearer\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;

export function redactHostRuntimeText(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, (match: string, prefix: string) => {
      const assignedValue = match.slice(prefix.length).trimStart();
      const quote = assignedValue[0] === '"' || assignedValue[0] === "'" ? assignedValue[0] : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .slice(0, 8_192);
}

const SENSITIVE_KEY =
  /(?:authorization|bridge[_-]?secret|control[_-]?nonce|api[_-]?key|credential|password|passphrase|prompt|content|payload|provider[_-]?payload|secret|token|private[_-]?key)/i;

export function redactHostRuntimeValue(value: unknown): unknown {
  if (typeof value === "string") return redactHostRuntimeText(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactHostRuntimeValue(item));
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key.slice(0, 96)] = redactHostRuntimeValue(item);
  }
  return output;
}

export function formatHostRuntimeError(error: unknown): string {
  if (error instanceof HostRuntimePathError) {
    return `Octant host path validation failed (${error.code}).`;
  }
  if (error instanceof HostRuntimeOwnershipError) {
    return `Octant host ownership failed (${error.code}).`;
  }
  return redactHostRuntimeText(error instanceof Error ? error.message : String(error));
}
