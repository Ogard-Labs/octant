import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  decodeOwnerReceipt,
  encodeOwnerReceipt,
  type HostRuntimeOwnerReceipt,
  type HostRuntimeServiceMode,
} from "./ownerReceipt";
import type { HostRuntimePaths } from "./paths";
import type { HostLogReadResult } from "./logs";
import type { HostRuntimeDiagnostics } from "./diagnostics";

const MAX_CONTROL_MESSAGE_BYTES = 16_384;
const execFileAsync = promisify(execFile);

export type HostRuntimeOwnershipErrorCode =
  | "ambiguous-owner-node"
  | "owner-unhealthy"
  | "owner-incompatible"
  | "owner-bind-failed"
  | "unsafe-owner-artifact";

export class HostRuntimeOwnershipError extends Error {
  readonly code: HostRuntimeOwnershipErrorCode;
  readonly path: string | undefined;

  constructor(code: HostRuntimeOwnershipErrorCode, message: string, path?: string) {
    super(message);
    this.name = "HostRuntimeOwnershipError";
    this.code = code;
    this.path = path;
  }
}

export interface AcquireHostRuntimeOwnerOptions {
  readonly paths: HostRuntimePaths;
  readonly hostId: string;
  readonly instanceId: string;
  readonly serverVersion: string;
  readonly wireVersion: string;
  readonly serviceMode: HostRuntimeServiceMode;
  readonly processStart: string;
  readonly pid?: number;
  readonly now?: () => string;
  readonly afterSocketBound?: () => void | Promise<void>;
  readonly afterStaleArtifactsQuarantined?: () => void | Promise<void>;
  readonly beforePersistence?: () => void | Promise<void>;
  readonly onStopRequested?: () => void | Promise<void>;
  readonly onControlRequest?: (
    request: HostRuntimeLocalControlRequest,
  ) => HostRuntimeControlPayload | undefined | Promise<HostRuntimeControlPayload | undefined>;
  readonly processAlive?: (pid: number, processStart: string) => boolean | Promise<boolean>;
}

export type HostRuntimeLocalControlRequest =
  | { readonly type: "status"; readonly principal: "local" }
  | { readonly type: "stop"; readonly principal: "local" }
  | { readonly type: "diagnostics"; readonly principal: "local" }
  | {
      readonly type: "logs";
      readonly principal: "local";
      readonly since?: string;
      readonly limit?: number;
      readonly follow?: boolean;
    }
  | { readonly type: "backup"; readonly principal: "local"; readonly label?: string }
  | { readonly type: "restore"; readonly principal: "local" };

export type HostRuntimeBackupOutcome =
  | {
      readonly outcome: "created";
      readonly path: string;
      readonly migrationVersion: number;
      readonly journalHead: number;
      readonly byteLength: number;
    }
  | { readonly outcome: "failed"; readonly code: string };

export interface HostRuntimeRestoreOutcome {
  readonly outcome: "refused-online";
  readonly guidance: string;
}

export interface HostRuntimeControlPayload {
  readonly diagnostics?: HostRuntimeDiagnostics;
  readonly logs?: HostLogReadResult;
  readonly backup?: HostRuntimeBackupOutcome;
  readonly restore?: HostRuntimeRestoreOutcome;
}

export interface HostRuntimeControlResponse extends HostRuntimeControlPayload {
  readonly ok?: boolean;
  readonly owner?: unknown;
  readonly error?: string;
}

export interface HostRuntimeOwner {
  readonly kind: "owner";
  readonly receipt: HostRuntimeOwnerReceipt;
  release(): Promise<void>;
}

export interface HostRuntimeAttachment {
  readonly kind: "attached";
  readonly owner: HostRuntimeOwnerReceipt;
  request(request: HostRuntimeLocalControlRequest): Promise<HostRuntimeControlResponse | undefined>;
  requestStop(): Promise<boolean>;
}

export type HostRuntimeOwnerResult = HostRuntimeOwner | HostRuntimeAttachment;

export async function acquireHostRuntimeOwner(
  options: AcquireHostRuntimeOwnerOptions,
): Promise<HostRuntimeOwnerResult> {
  const expectedOwner = { hostId: options.hostId, wireVersion: options.wireVersion };
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const existing = await safeLstat(options.paths.socketPath);
  if (existing !== undefined) {
    if (!existing.isSocket() || existing.uid !== options.paths.uid) {
      throw new HostRuntimeOwnershipError(
        "ambiguous-owner-node",
        "Octant found an unsafe or ambiguous control-socket path.",
        options.paths.socketPath,
      );
    }
    const attached = await tryAttach(options.paths, expectedOwner);
    if (attached !== undefined) return attached;
    const initializingOwner = await waitForAttachment(options.paths, expectedOwner);
    if (initializingOwner !== undefined) return initializingOwner;
    const staleReceipt = await readVerifiedStaleReceipt(options.paths, expectedOwner);
    if (staleReceipt === undefined) {
      throw new HostRuntimeOwnershipError(
        "owner-unhealthy",
        "Octant found an unreachable owner socket without a valid receipt.",
        options.paths.socketPath,
      );
    }
    if (await processAlive(staleReceipt.receipt.pid, staleReceipt.receipt.processStart)) {
      throw new HostRuntimeOwnershipError(
        "owner-unhealthy",
        "Octant owner is present but its authenticated control endpoint is unavailable.",
        options.paths.socketPath,
      );
    }
    await quarantineStaleOwner(
      options.paths,
      staleReceipt,
      fileIdentity(existing),
      options.afterStaleArtifactsQuarantined,
    );
  } else {
    await recoverSocketlessStaleOwner(options.paths, expectedOwner, processAlive);
  }

  const controlSecret = randomBytes(32).toString("base64url");
  const receipt: HostRuntimeOwnerReceipt = {
    schemaVersion: 1,
    hostId: options.hostId,
    instanceId: options.instanceId,
    endpoint: options.paths.socketPath,
    pid: options.pid ?? process.pid,
    processStart: options.processStart,
    serverVersion: options.serverVersion,
    wireVersion: options.wireVersion,
    serviceMode: options.serviceMode,
    nonceDigest: createHash("sha256").update(controlSecret).digest("hex"),
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const server = createControlServer(
    receipt,
    controlSecret,
    options.onStopRequested,
    options.onControlRequest,
  );
  let socketIdentity: FileIdentity | undefined;
  let secretIdentity: FileIdentity | undefined;
  let secretWritten = false;
  try {
    await listen(server, options.paths.socketPath);
    socketIdentity = fileIdentity(await lstat(options.paths.socketPath));
    await options.afterSocketBound?.();
    secretIdentity = await writeExclusiveSecret(options.paths.controlSecretPath, controlSecret);
    secretWritten = true;
    await chmod(options.paths.socketPath, 0o600);
    socketIdentity = fileIdentity(await lstat(options.paths.socketPath));
    await writeReceipt(options.paths.ownerReceiptPath, receipt);
    await options.beforePersistence?.();
  } catch (error) {
    await close(server);
    await unlinkIfSame(options.paths.socketPath, socketIdentity);
    await unlinkReceiptIfOwned(options.paths.ownerReceiptPath, receipt.instanceId);
    if (secretWritten) await unlinkIfSame(options.paths.controlSecretPath, secretIdentity);
    if (isAddressInUse(error)) {
      const attached = await waitForAttachment(options.paths, expectedOwner);
      if (attached !== undefined) return attached;
      throw new HostRuntimeOwnershipError(
        "owner-unhealthy",
        "Octant lost the owner race but could not attach to the winning process.",
        options.paths.socketPath,
      );
    }
    if (error instanceof HostRuntimeOwnershipError) throw error;
    throw new HostRuntimeOwnershipError(
      "owner-bind-failed",
      `Octant could not acquire runtime ownership: ${safeMessage(error)}`,
      options.paths.socketPath,
    );
  }

  let released = false;
  return Object.freeze({
    kind: "owner" as const,
    receipt: Object.freeze(receipt),
    release: async () => {
      if (released) return;
      released = true;
      await close(server);
      await unlinkIfSame(options.paths.socketPath, socketIdentity);
      await unlinkReceiptIfOwned(options.paths.ownerReceiptPath, receipt.instanceId);
      await unlinkIfSame(options.paths.controlSecretPath, secretIdentity);
    },
  });
}

export async function readHostRuntimeProcessStart(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const fact = await tryReadProcessStart(pid, platform);
  if (fact === undefined) {
    throw new HostRuntimeOwnershipError(
      "owner-unhealthy",
      "Octant could not determine the local process-start identity.",
    );
  }
  return fact;
}

interface ExpectedOwnerFacts {
  readonly hostId: string;
  readonly wireVersion: string;
}

interface VerifiedStaleReceipt {
  readonly receipt: HostRuntimeOwnerReceipt;
  readonly receiptIdentity: FileIdentity;
}

interface VerifiedStaleOwner extends VerifiedStaleReceipt {
  readonly secretIdentity: FileIdentity;
}

type ProcessAlive = (pid: number, processStart: string) => boolean | Promise<boolean>;

async function tryAttach(
  paths: HostRuntimePaths,
  expected: ExpectedOwnerFacts,
): Promise<HostRuntimeAttachment | undefined> {
  let secret: string;
  try {
    const metadata = await lstat(paths.controlSecretPath);
    if (!metadata.isFile() || metadata.uid !== paths.uid || (metadata.mode & 0o077) !== 0) {
      throw new HostRuntimeOwnershipError(
        "unsafe-owner-artifact",
        "Octant found an unsafe control-secret artifact.",
        paths.controlSecretPath,
      );
    }
    secret = (await readFile(paths.controlSecretPath, "utf8")).trim();
  } catch (error) {
    if (error instanceof HostRuntimeOwnershipError) throw error;
    return undefined;
  }
  const status = await sendControlRequest(paths.socketPath, secret, {
    type: "status",
    principal: "local",
  });
  if (status === undefined) return undefined;
  if (status.ok !== true) {
    throw new HostRuntimeOwnershipError(
      "owner-unhealthy",
      "Octant found a live owner socket that rejected the persisted control authority.",
      paths.socketPath,
    );
  }
  if (status.owner === undefined) return undefined;
  const owner = decodeOwnerReceipt(JSON.stringify(status.owner));
  if (
    owner.endpoint !== paths.socketPath ||
    owner.hostId !== expected.hostId ||
    owner.wireVersion !== expected.wireVersion
  ) {
    throw new HostRuntimeOwnershipError(
      "owner-incompatible",
      "Octant owner identity, wire version, or control endpoint is incompatible.",
      paths.socketPath,
    );
  }
  return Object.freeze({
    kind: "attached" as const,
    owner,
    request: (request: HostRuntimeLocalControlRequest) =>
      sendControlRequest(paths.socketPath, secret, request),
    requestStop: async () => {
      const response = await sendControlRequest(paths.socketPath, secret, {
        type: "stop",
        principal: "local",
      });
      return response?.ok === true;
    },
  });
}

export async function requestHostRuntimeControl(
  paths: HostRuntimePaths,
  request: HostRuntimeLocalControlRequest,
): Promise<HostRuntimeControlResponse | undefined> {
  let secret: string;
  try {
    const metadata = await lstat(paths.controlSecretPath);
    if (!metadata.isFile() || metadata.uid !== paths.uid || (metadata.mode & 0o077) !== 0) {
      return { ok: false, error: "unauthorized" };
    }
    secret = (await readFile(paths.controlSecretPath, "utf8")).trim();
  } catch (error) {
    if (isMissing(error)) return undefined;
    return { ok: false, error: "unavailable" };
  }
  return sendControlRequest(paths.socketPath, secret, request);
}

async function waitForAttachment(
  paths: HostRuntimePaths,
  expected: ExpectedOwnerFacts,
): Promise<HostRuntimeAttachment | undefined> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const attached = await tryAttach(paths, expected);
    if (attached !== undefined) return attached;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

function createControlServer(
  receipt: HostRuntimeOwnerReceipt,
  secret: string,
  onStopRequested: (() => void | Promise<void>) | undefined,
  onControlRequest:
    | ((
        request: HostRuntimeLocalControlRequest,
      ) => HostRuntimeControlPayload | undefined | Promise<HostRuntimeControlPayload | undefined>)
    | undefined,
): Server {
  return createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      void handleControlLine(socket, line, receipt, secret, onStopRequested, onControlRequest);
    });
  });
}

async function handleControlLine(
  socket: Socket,
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
    request = JSON.parse(line) as typeof request;
  } catch {
    respond(socket, { ok: false, error: "invalid-request" });
    return;
  }
  if (
    request.version !== 1 ||
    typeof request.secret !== "string" ||
    !safeSecretEqual(request.secret, secret) ||
    request.principal !== "local"
  ) {
    respond(socket, { ok: false, error: "unauthorized" });
    return;
  }
  if (request.type === "status") {
    respond(socket, { ok: true, owner: receipt });
    return;
  }
  if (request.type === "stop") {
    if (onStopRequested === undefined) {
      respond(socket, { ok: false, error: "stop-unavailable" });
      return;
    }
    respond(socket, { ok: true });
    await onStopRequested();
    return;
  }
  if (request.type === "diagnostics") {
    try {
      const payload = await onControlRequest?.({ type: "diagnostics", principal: "local" });
      respond(socket, { ok: true, ...(payload ?? {}) });
    } catch {
      respond(socket, { ok: false, error: "handler-failed" });
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
      respond(socket, { ok: false, error: "invalid-request" });
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
      respond(socket, { ok: true, ...(payload ?? {}) });
    } catch {
      respond(socket, { ok: false, error: "handler-failed" });
    }
    return;
  }
  if (request.type === "backup") {
    if (
      request.label !== undefined &&
      (typeof request.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.label))
    ) {
      respond(socket, { ok: false, error: "invalid-request" });
      return;
    }
    try {
      const payload = await onControlRequest?.({
        type: "backup",
        principal: "local",
        ...(request.label === undefined ? {} : { label: request.label }),
      });
      if (payload?.backup === undefined) {
        respond(socket, { ok: false, error: "backup-unavailable" });
        return;
      }
      respond(socket, { ok: true, backup: payload.backup });
    } catch {
      respond(socket, { ok: false, error: "handler-failed" });
    }
    return;
  }
  if (request.type === "restore") {
    try {
      const payload = await onControlRequest?.({ type: "restore", principal: "local" });
      if (payload?.restore === undefined) {
        respond(socket, { ok: false, error: "restore-unavailable" });
        return;
      }
      respond(socket, { ok: true, restore: payload.restore });
    } catch {
      respond(socket, { ok: false, error: "handler-failed" });
    }
    return;
  }
  respond(socket, { ok: false, error: "unsupported-request" });
}

function respond(socket: Socket, value: unknown): void {
  const encoded = JSON.stringify(value);
  socket.end(
    Buffer.byteLength(encoded) > MAX_CONTROL_MESSAGE_BYTES
      ? `${JSON.stringify({ ok: false, error: "response-too-large" })}\n`
      : `${encoded}\n`,
  );
}

async function sendControlRequest(
  path: string,
  secret: string,
  request: HostRuntimeLocalControlRequest,
): Promise<HostRuntimeControlResponse | undefined> {
  return await new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    let buffer = "";
    const finish = (value: HostRuntimeControlResponse | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => finish(undefined));
    socket.once("error", () => finish(undefined));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ version: 1, secret, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_MESSAGE_BYTES) {
        finish(undefined);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)) as HostRuntimeControlResponse);
      } catch {
        finish(undefined);
      }
    });
  });
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function writeExclusiveSecret(path: string, secret: string): Promise<FileIdentity> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  let identity: FileIdentity | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    identity = fileIdentity(await handle.stat());
    await handle.writeFile(`${secret}\n`, { encoding: "utf8" });
    await handle.chmod(0o600);
    identity = fileIdentity(await handle.stat());
    return identity;
  } catch (error) {
    if (handle !== undefined) {
      try {
        identity = fileIdentity(await handle.stat());
      } catch {
        // The exclusive handle no longer identifies a path we can safely remove.
      }
    }
    await unlinkIfSame(path, identity);
    throw new HostRuntimeOwnershipError(
      "unsafe-owner-artifact",
      `Octant could not create its exclusive control secret: ${safeMessage(error)}`,
      path,
    );
  } finally {
    await handle?.close();
  }
}

async function writeReceipt(path: string, receipt: HostRuntimeOwnerReceipt): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.owner-${receipt.instanceId}.tmp`);
  await writeFile(temporary, encodeOwnerReceipt(receipt), { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readReceipt(path: string): Promise<HostRuntimeOwnerReceipt | undefined> {
  try {
    return decodeOwnerReceipt(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readVerifiedStaleReceipt(
  paths: HostRuntimePaths,
  expected: ExpectedOwnerFacts,
): Promise<VerifiedStaleOwner | undefined> {
  try {
    const [receiptFile, secretFile] = await Promise.all([
      readPrivateOwnedFile(paths.ownerReceiptPath, paths.uid),
      readPrivateOwnedFile(paths.controlSecretPath, paths.uid),
    ]);
    const receipt = decodeOwnerReceipt(receiptFile.content);
    if (
      receipt.endpoint !== paths.socketPath ||
      receipt.hostId !== expected.hostId ||
      receipt.wireVersion !== expected.wireVersion ||
      receipt.nonceDigest !== createHash("sha256").update(secretFile.content.trim()).digest("hex")
    ) {
      return undefined;
    }
    return {
      receipt,
      receiptIdentity: receiptFile.identity,
      secretIdentity: secretFile.identity,
    };
  } catch {
    return undefined;
  }
}

async function readVerifiedReceipt(
  paths: HostRuntimePaths,
  expected: ExpectedOwnerFacts,
): Promise<VerifiedStaleReceipt | undefined> {
  try {
    const receiptFile = await readPrivateOwnedFile(paths.ownerReceiptPath, paths.uid);
    const receipt = decodeOwnerReceipt(receiptFile.content);
    if (
      receipt.endpoint !== paths.socketPath ||
      receipt.hostId !== expected.hostId ||
      receipt.wireVersion !== expected.wireVersion
    ) {
      return undefined;
    }
    return { receipt, receiptIdentity: receiptFile.identity };
  } catch {
    return undefined;
  }
}

async function readPrivateOwnedFile(
  path: string,
  uid: number,
): Promise<{ readonly content: string; readonly identity: FileIdentity }> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
      throw new HostRuntimeOwnershipError(
        "unsafe-owner-artifact",
        "Octant found an unsafe owner artifact.",
        path,
      );
    }
    return { content: await handle.readFile("utf8"), identity: fileIdentity(metadata) };
  } finally {
    await handle.close();
  }
}

async function quarantineStaleOwner(
  paths: HostRuntimePaths,
  stale: VerifiedStaleOwner,
  expectedSocket: FileIdentity,
  afterArtifactsQuarantined: (() => void | Promise<void>) | undefined,
): Promise<void> {
  try {
    // Move authority artifacts while the stale socket still excludes competing
    // owners. The receipt move is the recovery claim: any second contender then
    // fails closed before the socket pathname can be exposed.
    const { quarantine, suffix } = await quarantineStaleAuthority(paths, stale);
    await afterArtifactsQuarantined?.();
    await renameIfSame(paths.socketPath, join(quarantine, `owner-${suffix}.sock`), expectedSocket);
  } catch (error) {
    if (error instanceof HostRuntimeOwnershipError) throw error;
    throw new HostRuntimeOwnershipError(
      "ambiguous-owner-node",
      `Octant could not quarantine stale owner artifacts: ${safeMessage(error)}`,
      paths.socketPath,
    );
  }
}

async function recoverSocketlessStaleOwner(
  paths: HostRuntimePaths,
  expected: ExpectedOwnerFacts,
  processAlive: ProcessAlive,
): Promise<void> {
  const [receiptNode, secretNode] = await Promise.all([
    safeLstat(paths.ownerReceiptPath),
    safeLstat(paths.controlSecretPath),
  ]);
  if (receiptNode === undefined && secretNode === undefined) return;
  if (receiptNode !== undefined && secretNode === undefined) {
    const staleReceipt = await readVerifiedReceipt(paths, expected);
    if (staleReceipt === undefined) {
      throw new HostRuntimeOwnershipError(
        "owner-unhealthy",
        "Octant found a socket-less owner receipt without verifiable identity.",
        paths.ownerReceiptPath,
      );
    }
    if (await processAlive(staleReceipt.receipt.pid, staleReceipt.receipt.processStart)) {
      throw new HostRuntimeOwnershipError(
        "owner-unhealthy",
        "Octant found a live owner whose runtime authority artifacts are unavailable.",
        paths.ownerReceiptPath,
      );
    }
    await quarantineStaleReceipt(paths, staleReceipt);
    return;
  }
  const stale = await readVerifiedStaleReceipt(paths, expected);
  if (stale === undefined) {
    throw new HostRuntimeOwnershipError(
      "owner-unhealthy",
      "Octant found socket-less owner artifacts without verifiable authority.",
      paths.ownerReceiptPath,
    );
  }
  if (await processAlive(stale.receipt.pid, stale.receipt.processStart)) {
    throw new HostRuntimeOwnershipError(
      "owner-unhealthy",
      "Octant found a live owner whose control socket is unavailable.",
      paths.ownerReceiptPath,
    );
  }
  await quarantineStaleAuthority(paths, stale);
}

async function quarantineStaleAuthority(
  paths: HostRuntimePaths,
  stale: VerifiedStaleOwner,
): Promise<{ readonly quarantine: string; readonly suffix: string }> {
  const { quarantine, suffix } = await quarantineStaleReceipt(paths, stale);
  await renameIfSame(
    paths.controlSecretPath,
    join(quarantine, `owner-${suffix}.secret`),
    stale.secretIdentity,
  );
  return { quarantine, suffix };
}

async function quarantineStaleReceipt(
  paths: HostRuntimePaths,
  stale: VerifiedStaleReceipt,
): Promise<{ readonly quarantine: string; readonly suffix: string }> {
  const quarantine = join(paths.runtimeDirectory, "quarantine");
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${stale.receipt.instanceId}`;
  await renameIfSame(
    paths.ownerReceiptPath,
    join(quarantine, `owner-${suffix}.json`),
    stale.receiptIdentity,
  );
  return { quarantine, suffix };
}

async function defaultProcessAlive(pid: number, expectedProcessStart: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
  const observed = await tryReadProcessStart(pid, process.platform);
  return observed === undefined || observed === expectedProcessStart;
}

async function tryReadProcessStart(
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1 || (platform !== "darwin" && platform !== "linux")) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 1_000,
      maxBuffer: 4_096,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const startedAt = stdout.trim().replace(/\s+/g, " ");
    return startedAt === "" ? undefined : `${platform}:${startedAt}`;
  } catch {
    return undefined;
  }
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EADDRINUSE"
  );
}

function safeSecretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly size: number;
}

function fileIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    // ctime alone has millisecond granularity, so an in-place replacement
    // written within the same tick could still match; the byte length keeps
    // cleanup bound to the exact artifact this owner published.
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    size: stats.size,
  };
}

async function unlinkIfSame(path: string, expected: FileIdentity | undefined): Promise<void> {
  if (expected === undefined) return;
  const current = await safeLstat(path);
  if (sameFileIdentity(current, expected)) await safeUnlink(path);
}

function sameFileIdentity(current: Stats | undefined, expected: FileIdentity): boolean {
  return (
    current?.dev === expected.dev &&
    current.ino === expected.ino &&
    current.ctimeMs === expected.ctimeMs &&
    current.birthtimeMs === expected.birthtimeMs &&
    current.size === expected.size
  );
}

async function renameIfSame(from: string, to: string, expected: FileIdentity): Promise<void> {
  const current = await safeLstat(from);
  if (!sameFileIdentity(current, expected)) {
    throw new HostRuntimeOwnershipError(
      "ambiguous-owner-node",
      "Octant owner artifacts changed during stale-owner verification.",
      from,
    );
  }
  await rename(from, to);
}

async function unlinkReceiptIfOwned(path: string, instanceId: string): Promise<void> {
  const receipt = await readReceipt(path);
  if (receipt?.instanceId === instanceId) await safeUnlink(path);
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown runtime failure";
}
