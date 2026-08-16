import {
  decodeCursorAcpConnectionCheckRequest,
  decodeCursorAcpConnectionCheckResult,
  type CursorAcpConnectionCheckResult,
} from "@octant/contracts/cursor-acp";

export const CURSOR_ACP_NO_GO_RESIDUAL_ID = "cursor-acp-no-go" as const;

export type CursorAcpDenialCode =
  | "malformed-request"
  | "production-blocked"
  | "prompt-forbidden"
  | "secret-forbidden";

export class CursorAcpPolicyRejected extends Error {
  override readonly name = "CursorAcpPolicyRejected";
  constructor(
    readonly denialCode: CursorAcpDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CursorAcpDenialCode, message: string): never {
  throw new CursorAcpPolicyRejected(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Connection Check remains fail-closed under the compatibility-probe NO-GO residual.
 * Policy-specific true flags are classified first, then the full request is
 * strictly decoded so malformed/secret-bearing envelopes cannot bypass contracts.
 */
export function runCursorAcpConnectionCheck(input: {
  readonly request: unknown;
}): CursorAcpConnectionCheckResult {
  let requestRecord: Record<string, unknown>;
  let config: Record<string, unknown> | undefined;
  try {
    if (!isRecord(input.request)) {
      reject("malformed-request", "Cursor ACP connection check request is malformed.");
    }
    requestRecord = input.request;
    const rawConfig = requestRecord.config;
    config = isRecord(rawConfig) ? rawConfig : undefined;
    if (requestRecord.sendPrompt === true) {
      reject("prompt-forbidden", "Cursor ACP connection check must not send a prompt.");
    }
    if (config?.productionEnabled === true) {
      reject("production-blocked", "Cursor ACP production enablement is fail-closed.");
    }
    if (config) {
      assertCursorAcpConfigIsNonSecret(config);
    }
  } catch (error) {
    if (error instanceof CursorAcpPolicyRejected) throw error;
    reject("malformed-request", "Cursor ACP connection check request is malformed.");
  }

  let request;
  try {
    request = decodeCursorAcpConnectionCheckRequest(input.request);
  } catch {
    reject("malformed-request", "Cursor ACP connection check request is malformed.");
  }

  if (request.sendPrompt !== false) {
    reject("prompt-forbidden", "Cursor ACP connection check must not send a prompt.");
  }
  if (request.config.productionEnabled !== false) {
    reject("production-blocked", "Cursor ACP production enablement is fail-closed.");
  }

  return decodeCursorAcpConnectionCheckResult({
    schemaVersion: 1,
    kind: "cursor-acp-connection-check-result",
    status: "blocked",
    capabilities: [],
    residualPacketId: CURSOR_ACP_NO_GO_RESIDUAL_ID,
    message:
      "Cursor ACP remains fail-closed after the compatibility-probe NO-GO residual (exact-root load/resume/cancel unavailable).",
  });
}

const CURSOR_ACP_SECRET_SCAN_MAX_DEPTH = 8;
const CURSOR_ACP_SECRET_SCAN_MAX_ENTRIES = 256;

export function assertCursorAcpConfigIsNonSecret(config: Record<string, unknown>): void {
  assertCursorAcpValueIsNonSecret(config, "config", {
    depth: 0,
    entries: { count: 0 },
    seen: new WeakSet<object>(),
  });
}

function assertCursorAcpValueIsNonSecret(
  value: unknown,
  fieldPath: string,
  state: { depth: number; entries: { count: number }; seen: WeakSet<object> },
): void {
  if (
    state.depth > CURSOR_ACP_SECRET_SCAN_MAX_DEPTH ||
    state.entries.count > CURSOR_ACP_SECRET_SCAN_MAX_ENTRIES
  ) {
    reject("malformed-request", `Cursor ACP config field ${fieldPath} exceeds secret-scan bounds.`);
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      reject("malformed-request", `Cursor ACP config field ${fieldPath} contains a cyclic value.`);
    }
    state.seen.add(value);
    for (const [index, element] of value.entries()) {
      state.entries.count += 1;
      assertCursorAcpValueIsNonSecret(element, `${fieldPath}[${index}]`, {
        depth: state.depth + 1,
        entries: state.entries,
        seen: state.seen,
      });
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (state.seen.has(value)) {
    reject("malformed-request", `Cursor ACP config field ${fieldPath} contains a cyclic value.`);
  }
  state.seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject("malformed-request", `Cursor ACP config field ${fieldPath} must be a plain object.`);
  }
  try {
    // Enumerate only own enumerable properties incrementally so the shared entry
    // budget can fail closed before materializing an unbounded key array.
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nextPath = `${fieldPath}.${key}`;
      state.entries.count += 1;
      if (state.entries.count > CURSOR_ACP_SECRET_SCAN_MAX_ENTRIES) {
        reject(
          "malformed-request",
          `Cursor ACP config field ${nextPath} exceeds secret-scan bounds.`,
        );
      }
      if (/(?:api[_-]?key|token|password|secret|authorization|credential)/i.test(key)) {
        reject("secret-forbidden", `Cursor ACP config field ${nextPath} is forbidden.`);
      }
      let nested: unknown;
      try {
        nested = (value as Record<string, unknown>)[key];
      } catch {
        reject("malformed-request", `Cursor ACP config field ${nextPath} cannot be read.`);
      }
      assertCursorAcpValueIsNonSecret(nested, nextPath, {
        depth: state.depth + 1,
        entries: state.entries,
        seen: state.seen,
      });
    }
  } catch (error) {
    if (error instanceof CursorAcpPolicyRejected) throw error;
    reject("malformed-request", `Cursor ACP config field ${fieldPath} cannot be enumerated.`);
  }
}
