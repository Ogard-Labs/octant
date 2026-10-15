// The desktop app's side of pairing with another computer from its app
// pairing code. Main reads the code, reaches the listener only through the
// Node transport held to the code's pin, verifies the host hello, and only
// then records the pin and opens the host's own pairing page in a window
// whose session checks every certificate against the recorded pins. The
// renderer hands over the pasted text and nothing else: it cannot name a pin,
// an origin, or a page to open.

import { createHash, X509Certificate } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { openAppPairingCode } from "@octant/client-runtime/app-pairing-code";
import {
  connectListener,
  createListenerFetch,
} from "@octant/client-runtime/remote-listener-tls-node";
import {
  judgeListenerCertificate,
  LISTENER_TRUST_REFUSAL_COPY,
  listenerPinFromSha256,
  type ListenerOriginTrust,
} from "@octant/client-runtime/remote-listener-trust";
import { classifyRemoteListenerAddress } from "@octant/domain";

/** The session partition every paired computer's window uses, and nothing else. */
export const PAIRED_COMPUTER_PARTITION = "persist:octant-paired-computers";

/** Chromium's verification results a certificate verification hook answers with. */
export const CERTIFICATE_ACCEPTED = 0;
export const CERTIFICATE_REFUSED = -2;

export interface PairedComputer {
  readonly origin: string;
  readonly displayName: string;
}

interface PinRecord {
  readonly origin: string;
  readonly displayName: string;
  readonly pin: string;
}

export type PairedComputerOutcome =
  | { readonly status: "opened"; readonly computer: PairedComputer }
  | { readonly status: "refused"; readonly message: string };

/**
 * The pins main keeps, one per paired origin, in an owner-only file under the
 * app's data. A file that cannot be read holds no pins, so nothing is
 * trusted rather than something wrongly.
 */
export class PairedComputerPins {
  readonly #path: string;
  #records: ReadonlyArray<PinRecord>;

  constructor(path: string) {
    this.#path = path;
    this.#records = readPinRecords(path);
  }

  list(): ReadonlyArray<PairedComputer> {
    return this.#records.map(({ origin, displayName }) => ({ origin, displayName }));
  }

  pinFor(origin: string): string | undefined {
    return this.#records.find((record) => record.origin === origin)?.pin;
  }

  /**
   * Records an origin's pin. Only a private LAN or Tailscale name or address
   * can be pinned, so a compromised renderer cannot make main trust a public
   * site's key, whatever reaches this.
   */
  record(input: PinRecord): void {
    if (!isPrivateListenerOrigin(input.origin)) {
      throw new Error("Octant pins only a private network or Tailscale address.");
    }
    const next = [
      ...this.#records.filter((record) => record.origin !== input.origin),
      { origin: input.origin, displayName: input.displayName, pin: input.pin },
    ];
    writePinRecords(this.#path, next);
    this.#records = next;
  }

  /** Drops an origin's pin. Returns whether there was one. */
  forget(origin: string): boolean {
    const next = this.#records.filter((record) => record.origin !== origin);
    if (next.length === this.#records.length) return false;
    writePinRecords(this.#path, next);
    this.#records = next;
    return true;
  }

  /**
   * Judges a certificate the paired computers' session was served. Chromium
   * names only the host, not the port, so a name is held to every pin
   * recorded for it; a name with no pin is refused, because that session
   * opens nothing but paired computers.
   */
  judgeCertificate(hostname: string, certificatePem: string, now: number): number {
    const pins = this.#records
      .filter((record) => hostOf(record.origin) === hostname)
      .map((record) => record.pin);
    if (pins.length === 0) return CERTIFICATE_REFUSED;
    let servedPin: string;
    try {
      const spki = new X509Certificate(certificatePem).publicKey.export({
        type: "spki",
        format: "der",
      });
      servedPin = listenerPinFromSha256(createHash("sha256").update(spki).digest());
    } catch {
      return CERTIFICATE_REFUSED;
    }
    const accepted = pins.some(
      (pin) =>
        judgeListenerCertificate({
          trust: pinnedTrust(pin),
          servedPin,
          platformTrusted: false,
          now,
        }).status === "accepted",
    );
    return accepted ? CERTIFICATE_ACCEPTED : CERTIFICATE_REFUSED;
  }
}

export interface PairedComputerWindows {
  /** Opens a window on `url`, held to `origin`, in the paired computers' session. */
  readonly open: (input: { readonly origin: string; readonly url: string }) => void;
  /** Closes every open window held to `origin`, without waiting on the page. */
  readonly closeAll: (origin: string) => void;
}

/** The part of an Electron session that holds what a page left behind. */
export interface PageStoragePort {
  readonly clearStorageData: (options: { readonly origin: string }) => Promise<void>;
  readonly clearCache: () => Promise<void>;
  readonly clearAuthCache: () => Promise<void>;
}

/**
 * Clears everything a remote page left in a session for one origin: cookies,
 * local and session storage, IndexedDB, service workers, and the HTTP and
 * authentication caches. Every unpair path (forgetting a paired computer, and
 * dropping a remote dev server's page) calls this one helper, so none of them
 * leaves a page's data behind. The caches are session-wide, which is safe
 * because these sessions open nothing but remote computers.
 */
export async function clearRemotePageStorage(
  storage: PageStoragePort,
  origin: string,
): Promise<void> {
  // Each step is attempted whatever an earlier one did: the pin is already
  // gone by the time a caller clears, so a step skipped here would never
  // be retried.
  const results = await Promise.allSettled([
    storage.clearStorageData({ origin }),
    storage.clearCache(),
    storage.clearAuthCache(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

export type ForgetOutcome =
  | { readonly status: "forgotten" }
  | { readonly status: "refused"; readonly message: string };

/**
 * Forgets a paired computer. Its windows close first so no page outlives its
 * trust, then the pin goes, so that computer's key is trusted by nothing, and
 * last its page storage and session are cleared. This only ends this app's
 * side: the other computer keeps listing this device until it is revoked there.
 */
export async function forgetPairedComputer(input: {
  readonly origin: unknown;
  readonly pins: PairedComputerPins;
  readonly windows: PairedComputerWindows;
  readonly storage: PageStoragePort;
  /** The pages of that computer's servers Octant's browser opened, which go with it. */
  readonly serverPages?: {
    readonly forgetListener: (
      listenerOrigin: string,
    ) => Promise<{ readonly status: "forgotten" | "incomplete" }>;
  };
}): Promise<ForgetOutcome> {
  const origin = typeof input.origin === "string" ? input.origin : "";
  if (input.pins.pinFor(origin) === undefined) {
    return { status: "refused", message: "Octant isn't paired with that computer." };
  }
  input.windows.closeAll(origin);
  input.pins.forget(origin);
  try {
    await clearRemotePageStorage(input.storage, origin);
    const pages = await input.serverPages?.forgetListener(origin);
    if (pages?.status === "incomplete") throw new Error("Server page storage was not cleared.");
  } catch {
    return {
      status: "refused",
      message:
        "Octant forgot that computer, but couldn't clear everything its page stored. Quit and reopen Octant, then pair again if you want it back.",
    };
  }
  return { status: "forgotten" };
}

/**
 * Pairs with the computer a pasted code names: verifies its host hello over a
 * connection held to the code's pin, records the pin, and opens the host's
 * pairing page with the code's ticket, where the person confirms and the
 * host approves.
 */
export async function pairFromPairingCode(input: {
  readonly code: unknown;
  readonly pins: PairedComputerPins;
  readonly windows: PairedComputerWindows;
  readonly webBuildVersion: string;
  /** The Node transport; replaced only by tests. */
  readonly fetchFor?: (origin: string, trust: ListenerOriginTrust) => typeof globalThis.fetch;
}): Promise<PairedComputerOutcome> {
  if (typeof input.code !== "string") {
    return { status: "refused", message: "Paste the whole pairing code from that computer." };
  }
  const fetchFor = input.fetchFor ?? ((origin, trust) => createListenerFetch({ origin, trust }));
  const opened = await openAppPairingCode({
    code: input.code,
    transport: ({ origin, trust }) => ({ status: "available", fetch: fetchFor(origin, trust) }),
    webBuildVersion: input.webBuildVersion,
  });
  if (opened.status !== "opened") return { status: "refused", message: opened.message };
  if (opened.listenerTrust.kind !== "pinned") {
    return { status: "refused", message: "This pairing code carries no certificate pin." };
  }
  const computer = { origin: opened.origin, displayName: opened.hostHello.displayName };
  input.pins.record({ ...computer, pin: opened.listenerTrust.pin });
  const fragment = new URLSearchParams({
    ticketId: opened.ticket.ticketId,
    ticketProof: opened.ticket.ticketProof,
  });
  input.windows.open({ origin: opened.origin, url: `${opened.origin}/#${fragment.toString()}` });
  return { status: "opened", computer };
}

/**
 * Opens a paired computer again. Its address is resolved and judged and its
 * key checked against the pin before the window loads anything.
 */
export async function openPairedComputer(input: {
  readonly origin: unknown;
  readonly pins: PairedComputerPins;
  readonly windows: PairedComputerWindows;
  /** The Node connection; replaced only by tests. */
  readonly connect?: typeof connectListener;
}): Promise<PairedComputerOutcome> {
  const origin = typeof input.origin === "string" ? input.origin : "";
  const pin = input.pins.pinFor(origin);
  const computer = input.pins.list().find((entry) => entry.origin === origin);
  if (pin === undefined || computer === undefined) {
    return { status: "refused", message: "Octant isn't paired with that computer." };
  }
  const connection = await (input.connect ?? connectListener)({ origin, trust: pinnedTrust(pin) });
  if (connection.status === "connected") {
    connection.socket.destroy();
    // The person may have forgotten this computer while the connection was
    // being made; a window opened now would outlive its trust.
    if (input.pins.pinFor(origin) !== pin) {
      return { status: "refused", message: "Octant isn't paired with that computer." };
    }
    input.windows.open({ origin, url: `${origin}/` });
    return { status: "opened", computer };
  }
  if (connection.status === "refused") {
    return { status: "refused", message: LISTENER_TRUST_REFUSAL_COPY[connection.reason] };
  }
  return { status: "refused", message: "Octant couldn't reach that computer." };
}

function pinnedTrust(pin: string): ListenerOriginTrust {
  return { current: { kind: "pinned", pin } };
}

function hostOf(origin: string): string {
  return new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
}

function isPrivateListenerOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.origin !== origin) return false;
  const reach = classifyRemoteListenerAddress(hostOf(origin));
  return reach === "lan-private" || reach === "tailscale";
}

function readPinRecords(path: string): ReadonlyArray<PinRecord> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || !("computers" in value)) return [];
  const computers = (value as { computers: unknown }).computers;
  if (!Array.isArray(computers)) return [];
  const records: PinRecord[] = [];
  for (const entry of computers) {
    if (typeof entry !== "object" || entry === null) continue;
    const { origin, displayName, pin } = entry as Record<string, unknown>;
    if (
      typeof origin === "string" &&
      typeof displayName === "string" &&
      typeof pin === "string" &&
      isPrivateListenerOrigin(origin)
    ) {
      records.push({ origin, displayName, pin });
    }
  }
  return records;
}

function writePinRecords(path: string, records: ReadonlyArray<PinRecord>): void {
  // Written whole to an owner-only staging file and renamed over the target,
  // so a crash leaves the old pins or the new ones, never half of either.
  const staging = `${path}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  const descriptor = openSync(staging, "wx", 0o600);
  try {
    writeSync(descriptor, JSON.stringify({ version: 1, computers: records }));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(staging, path);
}

export const PAIRED_COMPUTER_CHANNELS = {
  pair: "octant:paired-computers:pair",
  list: "octant:paired-computers:list",
  open: "octant:paired-computers:open",
  forget: "octant:paired-computers:forget",
} as const;

/**
 * The paired-computer actions a trusted local window may ask for: pair from a
 * pasted code, list paired computers, open one, and forget one. Each refusal is a value
 * with one line of copy.
 */
export function installPairedComputerIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly resolveOwnedWindow: (event: unknown) => void;
  readonly pins: () => PairedComputerPins;
  readonly windows: PairedComputerWindows;
  readonly storage: PageStoragePort;
  readonly serverPages?: Parameters<typeof forgetPairedComputer>[0]["serverPages"];
  readonly webBuildVersion: string;
}): void {
  const authorize = (event: unknown): void => {
    try {
      options.resolveOwnedWindow(event);
    } catch {
      throw new Error("Octant rejected an unauthorized paired-computer request.");
    }
  };
  options.handle(PAIRED_COMPUTER_CHANNELS.pair, async (event, code) => {
    authorize(event);
    return await pairFromPairingCode({
      code,
      pins: options.pins(),
      windows: options.windows,
      webBuildVersion: options.webBuildVersion,
    });
  });
  options.handle(PAIRED_COMPUTER_CHANNELS.list, (event) => {
    authorize(event);
    return options.pins().list();
  });
  options.handle(PAIRED_COMPUTER_CHANNELS.open, async (event, origin) => {
    authorize(event);
    return await openPairedComputer({ origin, pins: options.pins(), windows: options.windows });
  });
  options.handle(PAIRED_COMPUTER_CHANNELS.forget, async (event, origin) => {
    authorize(event);
    return await forgetPairedComputer({
      origin,
      pins: options.pins(),
      windows: options.windows,
      storage: options.storage,
      ...(options.serverPages === undefined ? {} : { serverPages: options.serverPages }),
    });
  });
}
