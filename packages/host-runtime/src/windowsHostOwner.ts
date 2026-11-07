import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import { isMainThread } from "node:worker_threads";
import { MAX_CONTROL_MESSAGE_BYTES, respondToHostControlLine } from "./ownerControlProtocol";
import {
  decodeOwnerReceipt,
  encodeOwnerReceipt,
  type HostRuntimeOwnerReceipt,
} from "./ownerReceipt";
import {
  HostRuntimeOwnershipError,
  type AcquireHostRuntimeOwnerOptions,
  type HostRuntimeAttachment,
  type HostRuntimeControlResponse,
  type HostRuntimeLocalControlRequest,
  type HostRuntimeOwner,
  type HostRuntimeOwnerResult,
} from "./owner";

/** Private Node-API ABI. Native outputs are validated before acquiring authority. */
export interface WindowsHostOwnerNative {
  readonly apiVersion: number;
  readonly frameBytes: number;
  readonly prepare: (scope: string) => unknown;
  readonly claim: (receipt: Buffer, nonce: Buffer) => unknown;
  readonly poll: () => unknown;
  readonly reply: (id: number, bytes: Buffer) => unknown;
  readonly close: () => unknown;
  readonly lookup: (scope: string) => unknown;
  readonly beginRequest: (scope: string, bytes: Buffer) => unknown;
  readonly pollRequest: (id: number) => unknown;
  readonly closeRequest: (id: number) => unknown;
}
const methods = [
  "prepare",
  "claim",
  "poll",
  "reply",
  "close",
  "lookup",
  "beginRequest",
  "pollRequest",
  "closeRequest",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENDPOINT = /^\\\\\.\\pipe\\Octant-host-[0-9a-f]{64}$/;
const BIRTH = /^win32:[0-9a-f]{16}$/;
const anchored = new Set<HostRuntimeOwner>();
const CONTROL_BOUND_MS = 2_000;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function refused(): never {
  throw new HostRuntimeOwnershipError(
    "owner-unhealthy",
    "The private Windows host owner is unavailable or incompatible.",
  );
}
function bytes(value: unknown, maximum: number): Buffer | undefined {
  return value instanceof Uint8Array && value.byteLength <= maximum
    ? Buffer.from(value)
    : undefined;
}
function encodeResponse(value: HostRuntimeControlResponse): Buffer {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  return encoded.length < MAX_CONTROL_MESSAGE_BYTES
    ? encoded
    : Buffer.from('{"ok":false,"error":"response-too-large"}');
}

function isNativeBinding(value: unknown): value is WindowsHostOwnerNative {
  return (
    record(value) &&
    value.apiVersion === 1 &&
    value.frameBytes === MAX_CONTROL_MESSAGE_BYTES &&
    methods.every((method) => typeof value[method] === "function")
  );
}

/** A missing, incompatible or worker-loaded binding never grants host admission. */
export function loadWindowsHostOwnerNative(path: string): WindowsHostOwnerNative | undefined {
  if (
    process.platform !== "win32" ||
    !isMainThread ||
    !/^[a-z]:\\/i.test(path) ||
    path.includes("\0") ||
    win32.normalize(path) !== path ||
    win32.basename(path) !== "octant-windows-host-owner.node"
  )
    return undefined;
  try {
    const loaded: unknown = createRequire(import.meta.url)(path);
    if (!isNativeBinding(loaded)) return undefined;
    // The versioned ABI promises only callable methods; every returned value
    // remains unknown until the receiving operation validates it.
    return loaded;
  } catch {
    return undefined;
  }
}

export type AcquireWindowsHostOwnerOptions = Omit<
  AcquireHostRuntimeOwnerOptions,
  | "paths"
  | "processStart"
  | "pid"
  | "processAlive"
  | "afterSocketBound"
  | "afterStaleArtifactsQuarantined"
  | "beforePersistence"
  | "beforeSocketlessSecretQuarantine"
> & {
  readonly native: WindowsHostOwnerNative;
  readonly scope: string;
};

async function requestControl(
  native: WindowsHostOwnerNative,
  scope: string,
  secret: string,
  request: HostRuntimeLocalControlRequest,
): Promise<HostRuntimeControlResponse | undefined> {
  const encoded = Buffer.from(JSON.stringify({ version: 1, secret, ...request }), "utf8");
  if (encoded.length >= MAX_CONTROL_MESSAGE_BYTES) {
    encoded.fill(0);
    return undefined;
  }
  let id: number | undefined;
  try {
    const pending = native.beginRequest(scope, encoded);
    if (
      !record(pending) ||
      pending.status !== "pending" ||
      !Number.isSafeInteger(pending.id) ||
      typeof pending.id !== "number"
    )
      return undefined;
    id = pending.id;
    const deadline = performance.now() + CONTROL_BOUND_MS;
    while (performance.now() < deadline) {
      const result = native.pollRequest(id);
      if (!record(result)) return undefined;
      if (result.status === "response") {
        const response = bytes(result.bytes, MAX_CONTROL_MESSAGE_BYTES - 1);
        if (response === undefined) return undefined;
        try {
          // Same authenticated host-control response contract as the Unix
          // transport. The native client also pins the actual server PID/birth.
          const decoded: unknown = JSON.parse(response.toString("utf8"));
          return record(decoded) ? (decoded as HostRuntimeControlResponse) : undefined;
        } finally {
          response.fill(0);
        }
      }
      if (result.status !== "pending") return undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    encoded.fill(0);
    if (id !== undefined) native.closeRequest(id);
  }
}

function previousOwner(
  value: Readonly<Record<string, unknown>>,
  expected: AcquireWindowsHostOwnerOptions,
  expectedEndpoint: string,
): { readonly receipt: HostRuntimeOwnerReceipt; readonly secret: string } | undefined {
  const raw = bytes(value.receipt, 4096);
  const nonce = bytes(value.secret, 32);
  if (raw === undefined || nonce === undefined || nonce.length !== 32) {
    raw?.fill(0);
    nonce?.fill(0);
    return undefined;
  }
  try {
    const receipt = decodeOwnerReceipt(raw.toString("utf8"));
    const secret = nonce.toString("base64url");
    if (
      receipt.pid !== value.pid ||
      receipt.processStart !== value.processStart ||
      receipt.endpoint !== expectedEndpoint ||
      receipt.hostId !== expected.hostId ||
      receipt.wireVersion !== expected.wireVersion ||
      !ENDPOINT.test(receipt.endpoint) ||
      createHash("sha256").update(secret).digest("hex") !== receipt.nonceDigest
    )
      return undefined;
    return { receipt, secret };
  } catch {
    return undefined;
  } finally {
    raw.fill(0);
    nonce.fill(0);
  }
}

/**
 * Independent Windows owner prerequisite; ordinary platform startup still
 * refuses Windows. No path, PID, token or endpoint is accepted from a client.
 */
export async function acquireWindowsHostRuntimeOwner(
  options: AcquireWindowsHostOwnerOptions,
): Promise<HostRuntimeOwnerResult> {
  const native = options.native;
  if (
    !isMainThread ||
    !UUID.test(options.scope) ||
    native.apiVersion !== 1 ||
    native.frameBytes !== MAX_CONTROL_MESSAGE_BYTES
  )
    refused();
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const nonce = randomBytes(32);
  const secret = nonce.toString("base64url");
  try {
    const facts = native.prepare(options.scope);
    if (
      !record(facts) ||
      facts.status !== "prepared" ||
      typeof facts.pid !== "number" ||
      !Number.isSafeInteger(facts.pid) ||
      facts.pid < 1 ||
      typeof facts.processStart !== "string" ||
      !BIRTH.test(facts.processStart) ||
      typeof facts.endpoint !== "string" ||
      !ENDPOINT.test(facts.endpoint)
    )
      refused();
    const receipt: HostRuntimeOwnerReceipt = Object.freeze({
      schemaVersion: 1,
      hostId: options.hostId,
      instanceId: options.instanceId,
      endpoint: facts.endpoint,
      pid: facts.pid,
      processStart: facts.processStart,
      serverVersion: options.serverVersion,
      wireVersion: options.wireVersion,
      serviceMode: options.serviceMode,
      nonceDigest: createHash("sha256").update(secret).digest("hex"),
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
    });
    const encoded = Buffer.from(encodeOwnerReceipt(receipt), "utf8");
    let result: unknown;
    try {
      result = native.claim(encoded, nonce);
    } finally {
      encoded.fill(0);
    }
    if (!record(result)) refused();
    if (result.status === "existing") {
      const existing = previousOwner(result, options, facts.endpoint);
      native.close();
      if (existing === undefined) refused();
      const status = await requestControl(native, options.scope, existing.secret, {
        type: "status",
        principal: "local",
      });
      if (
        status?.ok !== true ||
        !record(status.owner) ||
        status.owner.instanceId !== existing.receipt.instanceId ||
        status.owner.pid !== existing.receipt.pid ||
        status.owner.processStart !== existing.receipt.processStart
      )
        refused();
      const attachment: HostRuntimeAttachment = {
        kind: "attached",
        owner: existing.receipt,
        request: (request) => requestControl(native, options.scope, existing.secret, request),
        requestStop: async () =>
          (
            await requestControl(native, options.scope, existing.secret, {
              type: "stop",
              principal: "local",
            })
          )?.ok === true,
      };
      return attachment;
    }
    if (result.status !== "owned") refused();
    active = true;
    const owner: HostRuntimeOwner = {
      kind: "owner",
      receipt,
      release: async () => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        native.close();
        anchored.delete(owner);
        // The native PID/birth tombstone stays until the writer exits. A
        // missing endpoint is never permission to replace a live process.
      },
    };
    const tick = () => {
      if (!active) return;
      try {
        const event = native.poll();
        if (!record(event) || event.status === "closed") {
          void owner.release();
          return;
        }
        if (
          event.status === "request" &&
          typeof event.id === "number" &&
          Number.isSafeInteger(event.id)
        ) {
          const id = event.id;
          const frame = bytes(event.bytes, MAX_CONTROL_MESSAGE_BYTES - 1);
          if (frame === undefined) {
            void owner.release();
            return;
          }
          const reply = (response: HostRuntimeControlResponse) => {
            if (!active) return;
            const encoded = encodeResponse(response);
            try {
              native.reply(id, encoded);
            } finally {
              encoded.fill(0);
            }
          };
          // Host command callbacks retain the same host-owned lifecycle as
          // Unix control. Only replies to this exact live connection dispatch.
          const line = frame.toString("utf8");
          frame.fill(0);
          void respondToHostControlLine(
            reply,
            line,
            receipt,
            secret,
            options.onStopRequested,
            options.onControlRequest,
          ).catch(() => reply({ ok: false, error: "handler-failed" }));
        }
      } catch {
        void owner.release();
        return;
      }
      if (active) timer = setTimeout(tick, 10);
    };
    anchored.add(owner);
    timer = setTimeout(tick, 0);
    return owner;
  } catch (error) {
    if (!active) native.close();
    if (error instanceof HostRuntimeOwnershipError) throw error;
    refused();
  } finally {
    nonce.fill(0);
  }
}
