import { timingSafeEqual } from "node:crypto";
import type { HostRuntimeOwnerReceipt } from "./ownerReceipt";
import type {
  HostRuntimeControlPayload,
  HostRuntimeControlResponse,
  HostRuntimeLocalControlRequest,
} from "./owner";

export const MAX_CONTROL_MESSAGE_BYTES = 16_384;

export async function respondToHostControlLine(
  reply: (value: HostRuntimeControlResponse) => void,
  line: string,
  receipt: HostRuntimeOwnerReceipt,
  secret: string,
  onStopRequested: (() => void | Promise<void>) | undefined,
  onControlRequest:
    | ((
        request: HostRuntimeLocalControlRequest,
      ) => HostRuntimeControlPayload | undefined | Promise<HostRuntimeControlPayload | undefined>)
    | undefined,
): Promise<void> {
  let request: {
    readonly version?: unknown;
    readonly secret?: unknown;
    readonly principal?: unknown;
    readonly type?: unknown;
    readonly since?: unknown;
    readonly limit?: unknown;
    readonly follow?: unknown;
    readonly label?: unknown;
  };
  try {
    const decoded: unknown = JSON.parse(line);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      reply({ ok: false, error: "invalid-request" });
      return;
    }
    request = decoded as typeof request;
  } catch {
    reply({ ok: false, error: "invalid-request" });
    return;
  }
  if (
    request.version !== 1 ||
    typeof request.secret !== "string" ||
    !safeSecretEqual(request.secret, secret) ||
    request.principal !== "local"
  ) {
    reply({ ok: false, error: "unauthorized" });
    return;
  }
  if (request.type === "status") {
    reply({ ok: true, owner: receipt });
    return;
  }
  if (request.type === "stop") {
    if (onStopRequested === undefined) {
      reply({ ok: false, error: "stop-unavailable" });
      return;
    }
    reply({ ok: true });
    await onStopRequested();
    return;
  }
  if (request.type === "diagnostics") {
    try {
      const payload = await onControlRequest?.({ type: "diagnostics", principal: "local" });
      reply({ ok: true, ...payload });
    } catch {
      reply({ ok: false, error: "handler-failed" });
    }
    return;
  }
  if (request.type === "logs") {
    if (
      (request.since !== undefined && typeof request.since !== "string") ||
      (request.limit !== undefined &&
        (typeof request.limit !== "number" ||
          !Number.isSafeInteger(request.limit) ||
          request.limit < 1 ||
          request.limit > 1_000)) ||
      (request.follow !== undefined && typeof request.follow !== "boolean")
    ) {
      reply({ ok: false, error: "invalid-request" });
      return;
    }
    try {
      const payload = await onControlRequest?.({
        type: "logs",
        principal: "local",
        ...(request.since === undefined ? {} : { since: request.since }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.follow === undefined ? {} : { follow: request.follow }),
      });
      reply({ ok: true, ...payload });
    } catch {
      reply({ ok: false, error: "handler-failed" });
    }
    return;
  }
  if (request.type === "backup") {
    if (
      request.label !== undefined &&
      (typeof request.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.label))
    ) {
      reply({ ok: false, error: "invalid-request" });
      return;
    }
    try {
      const payload = await onControlRequest?.({
        type: "backup",
        principal: "local",
        ...(request.label === undefined ? {} : { label: request.label }),
      });
      if (payload?.backup === undefined) {
        reply({ ok: false, error: "backup-unavailable" });
        return;
      }
      reply({ ok: true, backup: payload.backup });
    } catch {
      reply({ ok: false, error: "handler-failed" });
    }
    return;
  }
  if (request.type === "restore") {
    try {
      const payload = await onControlRequest?.({ type: "restore", principal: "local" });
      if (payload?.restore === undefined) {
        reply({ ok: false, error: "restore-unavailable" });
        return;
      }
      reply({ ok: true, restore: payload.restore });
    } catch {
      reply({ ok: false, error: "handler-failed" });
    }
    return;
  }
  reply({ ok: false, error: "unsupported-request" });
}

function safeSecretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
