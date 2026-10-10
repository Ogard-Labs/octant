import { readFile } from "node:fs/promises";
import {
  failureMessage,
  type LocalControlResponse,
  type OpenedLocalControlSession,
} from "./localControl";

export type RemoteAccessCliCommand =
  | { readonly action: "pair"; readonly sourceClass: "loopback" | "lan-private" | "tailscale" }
  | { readonly action: "list-pairing-requests" }
  | { readonly action: "approve-pairing"; readonly ticketId: string }
  | { readonly action: "deny-pairing"; readonly ticketId: string }
  | { readonly action: "list-devices" }
  | { readonly action: "revoke-device"; readonly deviceId: string }
  | { readonly action: "revoke-all-devices" }
  | { readonly action: "listener-status" }
  | {
      readonly action: "listener-enable";
      readonly hostname: string;
      readonly port: number;
      readonly certificatePath: string;
      readonly privateKeyPath: string;
    }
  | { readonly action: "listener-disable" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolvePairCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): RemoteAccessCliCommand | undefined {
  const [action, ...rest] = positional;
  if (action === "requests") {
    if (rest.length !== 0 || Object.keys(flags).length !== 0) return undefined;
    return { action: "list-pairing-requests" };
  }
  if (action === "approve" || action === "deny") {
    const [ticketId] = rest;
    if (Object.keys(flags).length !== 0 || rest.length !== 1 || ticketId === undefined) {
      return undefined;
    }
    if (!UUID_PATTERN.test(ticketId)) return undefined;
    return { action: action === "approve" ? "approve-pairing" : "deny-pairing", ticketId };
  }
  if (positional.length !== 0) return undefined;
  if (Object.keys(flags).some((flag) => flag !== "source")) return undefined;
  const source = flags.source ?? "loopback";
  if (source !== "loopback" && source !== "lan-private" && source !== "tailscale") return undefined;
  return { action: "pair", sourceClass: source };
}

export function resolveAuthCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): RemoteAccessCliCommand | undefined {
  const [action, ...rest] = positional;
  if (action === undefined || action === "list") {
    if (rest.length !== 0 || Object.keys(flags).length !== 0) return undefined;
    return { action: "list-devices" };
  }
  if (action !== "revoke") return undefined;
  if (Object.keys(flags).some((flag) => flag !== "all")) return undefined;
  if (flags.all === true) {
    return rest.length === 0 ? { action: "revoke-all-devices" } : undefined;
  }
  const [deviceId] = rest;
  if (deviceId === undefined || rest.length !== 1 || !UUID_PATTERN.test(deviceId)) return undefined;
  return { action: "revoke-device", deviceId };
}

export function resolveListenerCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): RemoteAccessCliCommand | undefined {
  const [action, ...rest] = positional;
  if (rest.length !== 0) return undefined;
  if (action === undefined || action === "status" || action === "disable") {
    if (Object.keys(flags).length !== 0) return undefined;
    return action === "disable" ? { action: "listener-disable" } : { action: "listener-status" };
  }
  if (action !== "enable") return undefined;
  const allowed = new Set(["hostname", "port", "cert", "key"]);
  if (Object.keys(flags).some((flag) => !allowed.has(flag))) return undefined;
  const { hostname, port, cert, key } = flags;
  if (
    typeof hostname !== "string" ||
    typeof port !== "string" ||
    typeof cert !== "string" ||
    typeof key !== "string" ||
    !/^\d{1,5}$/.test(port)
  ) {
    return undefined;
  }
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65_535) return undefined;
  return {
    action: "listener-enable",
    hostname,
    port: portNumber,
    certificatePath: cert,
    privateKeyPath: key,
  };
}

export interface RunRemoteAccessCliCommandInput {
  readonly command: RemoteAccessCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  /** Reads the certificate and key files the person named; defaults to the filesystem. */
  readonly readTextFile?: (path: string) => Promise<string>;
}

export async function runRemoteAccessCliCommand(
  input: RunRemoteAccessCliCommandInput,
): Promise<number> {
  const { command } = input;
  if (
    command.action === "listener-status" ||
    command.action === "listener-enable" ||
    command.action === "listener-disable"
  ) {
    return await runListenerCommand(input, command);
  }
  if (
    command.action === "list-pairing-requests" ||
    command.action === "approve-pairing" ||
    command.action === "deny-pairing"
  ) {
    return await runPairingDecisionCommand(input, command);
  }
  return await runDeviceCommand(input, command);
}

async function runDeviceCommand(
  input: RunRemoteAccessCliCommandInput,
  command: Extract<
    RemoteAccessCliCommand,
    { readonly action: "pair" | "list-devices" | "revoke-device" | "revoke-all-devices" }
  >,
): Promise<number> {
  const { session } = input;
  if (command.action === "pair") {
    const response = await session.send({
      path: "/api/desktop/remote/pairing-tickets",
      method: "POST",
      body: { sourceClass: command.sourceClass },
    });
    if (response.status !== 201) {
      input.stderr.write(
        `${failureMessage(response, "Octant refused to mint a pairing token.")}\n`,
      );
      return 1;
    }
    const ticket = pairingTicketOf(response.body);
    if (ticket === undefined) {
      input.stderr.write("Octant returned an unusable pairing token.\n");
      return 1;
    }
    input.stdout.write(`Pairing token ${ticket.ticketId}\n`);
    input.stdout.write(`Proof ${ticket.ticketProof}\n`);
    input.stdout.write(`Expires ${new Date(ticket.expiresAt).toISOString()}\n`);
    input.stdout.write(
      `The device must claim it over ${command.sourceClass}, and you approve the request on this host.\n`,
    );
    return 0;
  }
  if (command.action === "list-devices") {
    const response = await session.send({
      path: "/api/desktop/remote/devices",
      method: "GET",
    });
    if (response.status !== 200) {
      input.stderr.write(`${failureMessage(response, "Octant refused to list paired devices.")}\n`);
      return 1;
    }
    const devices = deviceListOf(response.body);
    if (devices.length === 0) {
      input.stdout.write("No devices are paired with this host.\n");
      return 0;
    }
    for (const device of devices) {
      input.stdout.write(`${device.deviceId}  ${device.state}  ${device.deviceLabel}\n`);
    }
    return 0;
  }
  const response = await session.send({
    path:
      command.action === "revoke-all-devices"
        ? "/api/desktop/remote/devices/revoke-all"
        : "/api/desktop/remote/devices/revoke",
    method: "POST",
    body: command.action === "revoke-all-devices" ? {} : { deviceId: command.deviceId },
  });
  if (response.status !== 201) {
    input.stderr.write(`${failureMessage(response, "Octant refused to revoke this access.")}\n`);
    return 1;
  }
  input.stdout.write(
    command.action === "revoke-all-devices"
      ? "Revoked every paired device.\n"
      : `Revoked device ${command.deviceId}.\n`,
  );
  return 0;
}

async function runListenerCommand(
  input: RunRemoteAccessCliCommandInput,
  command: Extract<
    RemoteAccessCliCommand,
    { readonly action: "listener-status" | "listener-enable" | "listener-disable" }
  >,
): Promise<number> {
  let response: LocalControlResponse;
  if (command.action === "listener-enable") {
    const read = input.readTextFile ?? ((path: string) => readFile(path, "utf8"));
    let certificatePem: string;
    let privateKeyPem: string;
    try {
      certificatePem = await read(command.certificatePath);
    } catch {
      input.stderr.write(`Could not read the certificate at ${command.certificatePath}.\n`);
      return 1;
    }
    try {
      privateKeyPem = await read(command.privateKeyPath);
    } catch {
      input.stderr.write(`Could not read the private key at ${command.privateKeyPath}.\n`);
      return 1;
    }
    response = await input.session.send({
      path: "/api/desktop/private-listener/enable",
      method: "POST",
      body: {
        hostname: command.hostname,
        port: command.port,
        // The listener's own address and port, as Settings derives it, which
        // the host refuses unless they match the bind; an IPv6 address must be
        // bracketed to be a valid URL authority.
        origin: `https://${command.hostname.includes(":") ? `[${command.hostname}]` : command.hostname}${command.port === 443 ? "" : `:${command.port}`}`,
        certificatePem,
        privateKeyPem,
      },
    });
  } else if (command.action === "listener-disable") {
    response = await input.session.send({
      path: "/api/desktop/private-listener/disable",
      method: "POST",
    });
  } else {
    response = await input.session.send({
      path: "/api/desktop/private-listener/status",
      method: "GET",
    });
  }
  if (response.status !== 200) {
    input.stderr.write(
      `${failureMessage(response, "Octant refused to change the remote listener.")}\n`,
    );
    return 1;
  }
  const status = listenerStatusOf(response.body);
  if (status === undefined) {
    input.stderr.write("Octant returned an unusable remote listener status.\n");
    return 1;
  }
  input.stdout.write(`Remote listener ${status.state}\n`);
  if (status.origin !== null) input.stdout.write(`Origin ${status.origin}\n`);
  if (status.exposureClass !== null) input.stdout.write(`Reach ${status.exposureClass}\n`);
  if (status.certificateFingerprint !== null) {
    input.stdout.write(`Certificate ${status.certificateFingerprint}\n`);
  }
  if (status.errorCode !== undefined) input.stdout.write(`Error ${status.errorCode}\n`);
  return 0;
}

async function runPairingDecisionCommand(
  input: RunRemoteAccessCliCommandInput,
  command: Extract<
    RemoteAccessCliCommand,
    { readonly action: "list-pairing-requests" | "approve-pairing" | "deny-pairing" }
  >,
): Promise<number> {
  const listed = await input.session.send({
    path: "/api/desktop/remote/pairing-requests",
    method: "GET",
  });
  if (listed.status !== 200) {
    input.stderr.write(
      `${pairingFailureMessage(listed, "Octant refused to list pairing requests.")}\n`,
    );
    return 1;
  }
  const pending = pendingRequestsOf(listed.body);
  if (command.action === "list-pairing-requests") {
    if (pending.length === 0) {
      input.stdout.write("No pairing requests are waiting for approval.\n");
      return 0;
    }
    for (const request of pending) {
      input.stdout.write(
        [
          `Request ${request.ticketId}`,
          `  Device ${request.deviceLabel}`,
          `  From ${request.origin} (${request.sourceClass})`,
          `  Comparison code ${request.comparisonCode}`,
          `  Key fingerprint ${request.deviceKeyFingerprint}`,
          `  Expires ${request.expiresAt}`,
          "",
        ].join("\n"),
      );
    }
    input.stdout.write(
      "Approve only if the comparison code matches the one shown on the device.\n",
    );
    return 0;
  }
  // Deciding goes through the same listing Settings shows, so the person sees
  // the device and comparison code they are deciding on, and a ticket that is
  // no longer pending is refused here instead of as a bare `invalid`.
  const request = pending.find((entry) => entry.ticketId === command.ticketId);
  if (request === undefined) {
    input.stderr.write(`No pending pairing request has the ticket ${command.ticketId}.\n`);
    return 1;
  }
  const approving = command.action === "approve-pairing";
  const response = await input.session.send({
    path: approving
      ? "/api/desktop/remote/pairing-requests/approve"
      : "/api/desktop/remote/pairing-requests/deny",
    method: "POST",
    body: approving
      ? { ticketId: command.ticketId }
      : { ticketId: command.ticketId, reasonCode: "user-denied" },
  });
  if (response.status !== 201) {
    input.stderr.write(
      `${pairingFailureMessage(response, "The pairing decision was not applied.")}\n`,
    );
    return 1;
  }
  input.stdout.write(
    `${approving ? "Approved" : "Denied"} ${request.deviceLabel} (comparison code ${request.comparisonCode}).\n`,
  );
  return 0;
}

/** Pairing lives on the remote gateway, so a host with the listener off has none to ask. */
function pairingFailureMessage(response: LocalControlResponse, fallback: string): string {
  const message = failureMessage(response, fallback);
  return response.status === 503
    ? `${message} Turn the remote listener on first with \`octant listener enable\`.`
    : message;
}

interface ListenerStatusOutput {
  readonly state: string;
  readonly origin: string | null;
  readonly exposureClass: string | null;
  readonly certificateFingerprint: string | null;
  readonly errorCode?: string;
}

function listenerStatusOf(body: unknown): ListenerStatusOutput | undefined {
  const status = fieldOf(body, "status");
  const state = fieldOf(status, "state");
  const origin = fieldOf(status, "origin");
  const exposureClass = fieldOf(status, "exposureClass");
  const certificateFingerprint = fieldOf(status, "certificateFingerprint");
  const errorCode = fieldOf(status, "errorCode");
  if (
    typeof state !== "string" ||
    !nullableString(origin) ||
    !nullableString(exposureClass) ||
    !nullableString(certificateFingerprint)
  ) {
    return undefined;
  }
  return {
    state,
    origin,
    exposureClass,
    certificateFingerprint,
    ...(typeof errorCode === "string" ? { errorCode } : {}),
  };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

interface PendingPairingOutput {
  readonly ticketId: string;
  readonly deviceLabel: string;
  readonly origin: string;
  readonly sourceClass: string;
  readonly comparisonCode: string;
  readonly deviceKeyFingerprint: string;
  readonly expiresAt: string;
}

function pendingRequestsOf(body: unknown): ReadonlyArray<PendingPairingOutput> {
  const pending = fieldOf(body, "pending");
  if (!Array.isArray(pending)) return [];
  const listed: PendingPairingOutput[] = [];
  for (const entry of pending) {
    const ticketId = fieldOf(entry, "ticketId");
    const deviceLabel = fieldOf(entry, "deviceLabel");
    const origin = fieldOf(entry, "origin");
    const sourceClass = fieldOf(entry, "sourceClass");
    const comparisonCode = fieldOf(entry, "comparisonCode");
    const deviceKeyFingerprint = fieldOf(entry, "deviceKeyFingerprint");
    const expiresAt = fieldOf(entry, "expiresAt");
    if (
      typeof ticketId === "string" &&
      typeof deviceLabel === "string" &&
      typeof origin === "string" &&
      typeof sourceClass === "string" &&
      typeof comparisonCode === "string" &&
      typeof deviceKeyFingerprint === "string" &&
      typeof expiresAt === "string"
    ) {
      listed.push({
        ticketId,
        deviceLabel,
        origin,
        sourceClass,
        comparisonCode,
        deviceKeyFingerprint,
        expiresAt,
      });
    }
  }
  return listed;
}

function pairingTicketOf(body: unknown): PairingTicketOutput | undefined {
  const ticket = fieldOf(body, "ticket");
  const ticketId = fieldOf(ticket, "ticketId");
  const ticketProof = fieldOf(ticket, "ticketProof");
  const expiresAt = fieldOf(ticket, "expiresAt");
  if (
    typeof ticketId !== "string" ||
    typeof ticketProof !== "string" ||
    typeof expiresAt !== "number"
  ) {
    return undefined;
  }
  return { ticketId, ticketProof, expiresAt };
}

interface PairingTicketOutput {
  readonly ticketId: string;
  readonly ticketProof: string;
  readonly expiresAt: number;
}

interface PairedDeviceOutput {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly state: string;
}

function deviceListOf(body: unknown): ReadonlyArray<PairedDeviceOutput> {
  const devices = fieldOf(body, "devices");
  if (!Array.isArray(devices)) return [];
  const listed: PairedDeviceOutput[] = [];
  for (const device of devices) {
    const deviceId = fieldOf(device, "deviceId");
    const deviceLabel = fieldOf(device, "deviceLabel");
    const state = fieldOf(device, "state");
    if (
      typeof deviceId === "string" &&
      typeof deviceLabel === "string" &&
      typeof state === "string"
    ) {
      listed.push({ deviceId, deviceLabel, state });
    }
  }
  return listed;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}
