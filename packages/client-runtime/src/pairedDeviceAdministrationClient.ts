import type {
  RemoteDeviceInventoryEntry,
  RemoteMintedPairingTicket,
  RemotePairingTicketSourceClass,
  RemotePendingPairingRequest,
} from "@octant/contracts/desktop-bridge";

/** A host answer, or its refusal in words a person can act on. */
export type PairedDeviceAdministrationAnswer<T = undefined> =
  | (T extends undefined ? { readonly status: "ok" } : { readonly status: "ok"; readonly value: T })
  | { readonly status: "refused"; readonly message: string };

/**
 * Paired devices and pairing requests as a device the host's own person
 * paired administers them (maintainer decision, 2026-11-12): list, rename and
 * revoke devices, approve or deny a new device, and start a pairing. The host
 * refuses every other session, and refuses a device's approval of its own
 * request; each refusal is a value the caller shows.
 */
export interface PairedDeviceAdministrationClient {
  readonly listDevices: () => Promise<
    PairedDeviceAdministrationAnswer<ReadonlyArray<RemoteDeviceInventoryEntry>>
  >;
  readonly renameDevice: (
    deviceId: string,
    deviceLabel: string,
  ) => Promise<PairedDeviceAdministrationAnswer>;
  readonly revokeDevice: (deviceId: string) => Promise<PairedDeviceAdministrationAnswer>;
  readonly revokeAllDevices: () => Promise<PairedDeviceAdministrationAnswer>;
  readonly reconcileExpiredDevices: () => Promise<PairedDeviceAdministrationAnswer>;
  readonly listPairingRequests: () => Promise<
    PairedDeviceAdministrationAnswer<ReadonlyArray<RemotePendingPairingRequest>>
  >;
  readonly approvePairingRequest: (ticketId: string) => Promise<PairedDeviceAdministrationAnswer>;
  readonly denyPairingRequest: (ticketId: string) => Promise<PairedDeviceAdministrationAnswer>;
  readonly createPairingTicket: (
    sourceClass: RemotePairingTicketSourceClass,
  ) => Promise<PairedDeviceAdministrationAnswer<RemoteMintedPairingTicket>>;
}

const UNREACHABLE = "The host could not be reached.";
// The host answers an own-request approval with the same refusal it gives a
// session it does not take approvals from, so the sentence names both.
const APPROVAL_REFUSED =
  "The host did not take this approval. A device cannot approve its own pairing request; approve it from another paired device or at the host.";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function createPairedDeviceAdministrationClient(port: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}): PairedDeviceAdministrationClient {
  const ask = async (
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<
    | { readonly status: "ok"; readonly value: Readonly<Record<string, unknown>> }
    | { readonly status: "refused"; readonly message: string; readonly unauthorized: boolean }
  > => {
    try {
      const response = await port.fetch(new URL(path, port.baseUrl).toString(), {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const value = record(await response.json().catch(() => undefined));
      if (response.ok && value !== undefined) return { status: "ok", value };
      const message = value?.message;
      return {
        status: "refused",
        message: typeof message === "string" ? message : "The host refused the request.",
        unauthorized: response.status === 401,
      };
    } catch {
      return { status: "refused", message: UNREACHABLE, unauthorized: false };
    }
  };
  const change = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<PairedDeviceAdministrationAnswer> => {
    const answer = await ask(path, body);
    return answer.status === "ok"
      ? { status: "ok" }
      : { status: "refused", message: answer.message };
  };
  const list = async <T>(
    path: string,
    key: string,
  ): Promise<PairedDeviceAdministrationAnswer<ReadonlyArray<T>>> => {
    const answer = await ask(path);
    if (answer.status !== "ok") return { status: "refused", message: answer.message };
    const entries = answer.value[key];
    return Array.isArray(entries)
      ? { status: "ok", value: entries as ReadonlyArray<T> }
      : { status: "refused", message: "The host returned an invalid answer." };
  };

  return {
    listDevices: () => list<RemoteDeviceInventoryEntry>("/api/remote/devices", "devices"),
    renameDevice: (deviceId, deviceLabel) =>
      change("/api/remote/devices/rename", { deviceId, deviceLabel }),
    revokeDevice: (deviceId) => change("/api/remote/devices/revoke", { deviceId }),
    revokeAllDevices: () => change("/api/remote/devices/revoke-all", {}),
    reconcileExpiredDevices: () => change("/api/remote/devices/reconcile-expired", {}),
    listPairingRequests: () =>
      list<RemotePendingPairingRequest>("/api/remote/pairing-requests", "pending"),
    async approvePairingRequest(ticketId) {
      const answer = await ask("/api/remote/pairing-requests/approve", { ticketId });
      if (answer.status === "ok") return { status: "ok" };
      return {
        status: "refused",
        message: answer.unauthorized ? APPROVAL_REFUSED : answer.message,
      };
    },
    denyPairingRequest: (ticketId) =>
      change("/api/remote/pairing-requests/deny", { ticketId, reasonCode: "user-denied" }),
    async createPairingTicket(sourceClass) {
      const answer = await ask("/api/remote/pairing-tickets", { sourceClass });
      if (answer.status !== "ok") return { status: "refused", message: answer.message };
      const ticket = record(answer.value.ticket);
      return typeof ticket?.ticketId === "string" &&
        typeof ticket.ticketProof === "string" &&
        typeof ticket.expiresAt === "number"
        ? {
            status: "ok",
            value: {
              ticketId: ticket.ticketId,
              ticketProof: ticket.ticketProof,
              expiresAt: ticket.expiresAt,
              sourceClass,
            },
          }
        : { status: "refused", message: "The host returned an invalid answer." };
    },
  };
}
