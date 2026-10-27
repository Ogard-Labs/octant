/**
 * Commands and files inside one E2B sandbox, through its in-sandbox daemon
 * (envd), over the host's HTTPS port.
 *
 * envd serves process control as a Connect RPC service and files over plain
 * HTTP. E2B's own SDK speaks Connect's JSON codec to it, so this does too: a
 * server-streaming call is one POST whose body is one enveloped JSON message,
 * answered by enveloped JSON events and an end-of-stream envelope. Every call
 * goes to E2B's shared sandbox host with the sandbox named in routing
 * headers, carries the sandbox's own access token, and never the person's
 * API key. Commands run as an argument list with no shell unless the driver
 * names one, so text and file names cross as data.
 */
import type { DesktopHttpsPort, DesktopHttpsResult } from "@octant/plugin-api/desktop-provider";

/** E2B's shared host for in-sandbox traffic; the sandbox is named in headers. */
export const E2B_SANDBOX_ORIGIN = "https://sandbox.e2b.app";
/** The port envd listens on inside every sandbox. */
const ENVD_PORT = "49983";
/** The unprivileged user E2B's desktop template runs as, as HTTP Basic with no password. */
const SANDBOX_USER = "user";
const SANDBOX_USER_AUTHORIZATION = `Basic ${btoa(`${SANDBOX_USER}:`)}`;
/** Output a command may print; commands here print a process id at most. */
const MAX_COMMAND_RESPONSE_BYTES = 262_144;
const MAX_STDOUT_BYTES = 4_096;
const END_STREAM = 0x02;
const COMPRESSED = 0x01;

/** What the driver keeps for a running sandbox. The token never leaves host memory. */
export interface E2bSandboxSession {
  readonly sandboxId: string;
  readonly accessToken: string;
}

export type E2bCommandResult =
  | { readonly status: "exited"; readonly exitCode: number; readonly stdout: string }
  /** The sandbox did not answer, or answered for something that is not this sandbox. */
  | { readonly status: "unreachable" }
  | { readonly status: "failed" };

function envdHeaders(session: E2bSandboxSession): Record<string, string> {
  return {
    "E2b-Sandbox-Id": session.sandboxId,
    "E2b-Sandbox-Port": ENVD_PORT,
    "X-Access-Token": session.accessToken,
    Authorization: SANDBOX_USER_AUTHORIZATION,
  };
}

/** One Connect envelope: a flags byte, a big-endian length, then the message. */
export function connectEnvelope(message: unknown, flags = 0): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const envelope = new Uint8Array(5 + json.byteLength);
  envelope[0] = flags;
  new DataView(envelope.buffer).setUint32(1, json.byteLength);
  envelope.set(json, 5);
  return envelope;
}

type Envelope = { readonly flags: number; readonly message: unknown };

/** Splits a Connect stream body into its envelopes, or undefined when it is not one. */
export function readConnectEnvelopes(body: Uint8Array): ReadonlyArray<Envelope> | undefined {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const envelopes: Array<Envelope> = [];
  let offset = 0;
  while (offset < body.byteLength) {
    if (offset + 5 > body.byteLength) return undefined;
    const flags = view.getUint8(offset);
    const length = view.getUint32(offset + 1);
    if (offset + 5 + length > body.byteLength) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(
        new TextDecoder().decode(body.subarray(offset + 5, offset + 5 + length)),
      );
    } catch {
      return undefined;
    }
    envelopes.push({ flags, message });
    offset += 5 + length;
  }
  return envelopes;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Whether an answer means the sandbox itself is out of reach. */
function unreachable(result: DesktopHttpsResult): boolean {
  if (result.status !== "answered") return result.status !== "refused";
  // E2B's proxy answers 502 for a sandbox that is not running and 404 for
  // one it does not know; either way nothing inside it answered.
  return result.httpStatus === 502 || result.httpStatus === 404;
}

/**
 * Runs one program to completion. A process event stream that ends without
 * an exit, or a stream error, is a failure; stdout past the bound is too.
 */
export async function runInSandbox(
  https: DesktopHttpsPort,
  session: E2bSandboxSession,
  command: {
    readonly cmd: string;
    readonly args: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
  },
): Promise<E2bCommandResult> {
  const answered = await https.request({
    method: "POST",
    url: `${E2B_SANDBOX_ORIGIN}/process.Process/Start`,
    headers: {
      ...envdHeaders(session),
      "Content-Type": "application/connect+json",
      "Connect-Protocol-Version": "1",
    },
    body: connectEnvelope({
      process: { cmd: command.cmd, args: command.args, envs: { DISPLAY: ":0" } },
      stdin: false,
    }),
    maxResponseBytes: MAX_COMMAND_RESPONSE_BYTES,
    ...(command.signal === undefined ? {} : { signal: command.signal }),
  });
  if (answered.status !== "answered") {
    return unreachable(answered) ? { status: "unreachable" } : { status: "failed" };
  }
  if (answered.httpStatus !== 200) {
    return unreachable(answered) ? { status: "unreachable" } : { status: "failed" };
  }
  const envelopes = readConnectEnvelopes(answered.body);
  if (envelopes === undefined) return { status: "failed" };
  const stdout: Array<Uint8Array> = [];
  let stdoutBytes = 0;
  let exitCode: number | undefined;
  for (const { flags, message } of envelopes) {
    if ((flags & COMPRESSED) !== 0) return { status: "failed" };
    if ((flags & END_STREAM) !== 0) {
      if (isRecord(message) && message.error !== undefined) return { status: "failed" };
      continue;
    }
    const event = isRecord(message) && isRecord(message.event) ? message.event : undefined;
    if (event === undefined) return { status: "failed" };
    if (isRecord(event.data) && typeof event.data.stdout === "string") {
      const chunk = decodeBase64(event.data.stdout);
      if (chunk === undefined) return { status: "failed" };
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) return { status: "failed" };
      stdout.push(chunk);
    }
    if (isRecord(event.end)) {
      // proto3 JSON leaves a zero exit code out.
      const code = event.end.exitCode ?? 0;
      if (typeof code !== "number" || !Number.isSafeInteger(code)) return { status: "failed" };
      exitCode = code;
    }
  }
  if (exitCode === undefined) return { status: "failed" };
  const joined = new Uint8Array(stdoutBytes);
  let offset = 0;
  for (const chunk of stdout) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "exited", exitCode, stdout: new TextDecoder().decode(joined) };
}

const fileUrl = (path: string): string =>
  `${E2B_SANDBOX_ORIGIN}/files?${new URLSearchParams({ path, username: SANDBOX_USER }).toString()}`;

export type E2bFileRead =
  | { readonly status: "read"; readonly bytes: Uint8Array }
  | { readonly status: "unreachable" }
  | { readonly status: "failed" };

/** Downloads one file from the sandbox, reading at most `maxBytes`. */
export async function readSandboxFile(
  https: DesktopHttpsPort,
  session: E2bSandboxSession,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<E2bFileRead> {
  const answered = await https.request({
    method: "GET",
    url: fileUrl(path),
    headers: envdHeaders(session),
    maxResponseBytes: maxBytes,
    ...(signal === undefined ? {} : { signal }),
  });
  if (answered.status !== "answered" || answered.httpStatus !== 200) {
    return unreachable(answered) ? { status: "unreachable" } : { status: "failed" };
  }
  return { status: "read", bytes: answered.body };
}

/** Uploads one file into the sandbox at `path`, replacing any file there. */
export async function writeSandboxFile(
  https: DesktopHttpsPort,
  session: E2bSandboxSession,
  path: string,
  bytes: Uint8Array,
): Promise<"written" | "unreachable" | "failed"> {
  const answered = await https.request({
    method: "POST",
    url: fileUrl(path),
    headers: { ...envdHeaders(session), "Content-Type": "application/octet-stream" },
    body: bytes,
    maxResponseBytes: 65_536,
  });
  if (answered.status === "answered" && answered.httpStatus === 200) return "written";
  return unreachable(answered) ? "unreachable" : "failed";
}
