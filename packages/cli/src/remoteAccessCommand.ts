import { failureMessage, type OpenedLocalControlSession } from "./localControl";

export type RemoteAccessCliCommand =
  | { readonly action: "pair"; readonly sourceClass: "loopback" | "lan-private" | "tailscale" }
  | { readonly action: "list-devices" }
  | { readonly action: "revoke-device"; readonly deviceId: string }
  | { readonly action: "revoke-all-devices" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolvePairCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): RemoteAccessCliCommand | undefined {
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

export interface RunRemoteAccessCliCommandInput {
  readonly command: RemoteAccessCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

export async function runRemoteAccessCliCommand(
  input: RunRemoteAccessCliCommandInput,
): Promise<number> {
  const { command, session } = input;
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
