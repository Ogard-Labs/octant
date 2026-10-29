// Pure rules of the wake service: how a hardware address becomes a Wake-on-LAN
// magic packet, and when a spoke believes a nudge. The spoke decides; the hub's
// message is never a command, so the checks here are the whole of what a nudge
// can cause.

/** The UDP port a Wake-on-LAN magic packet is sent to by convention. */
export const WAKE_ON_LAN_PORT = 9;

const HARDWARE_ADDRESS = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

/**
 * A hardware (MAC) address as six lowercase hex pairs joined by colons, or
 * undefined when the text is not one. Dashes are accepted on input because
 * Windows and some routers print them.
 */
export function normalizeHardwareAddress(text: string): string | undefined {
  const trimmed = text.trim();
  if (!HARDWARE_ADDRESS.test(trimmed)) return undefined;
  return trimmed.toLowerCase().replaceAll("-", ":");
}

/**
 * The magic packet for a hardware address: six 0xFF bytes, then the address
 * sixteen times (102 bytes). Undefined for text that is not an address.
 */
export function buildWakeOnLanPacket(address: string): Uint8Array | undefined {
  const normalized = normalizeHardwareAddress(address);
  if (normalized === undefined) return undefined;
  const octets = normalized.split(":").map((pair) => Number.parseInt(pair, 16));
  const packet = new Uint8Array(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let repeat = 0; repeat < 16; repeat += 1) packet.set(octets, 6 + repeat * 6);
  return packet;
}

export type WakeNudgeDecision =
  | { readonly status: "accept" }
  | { readonly status: "ignore"; readonly kind: "time-mismatch" | "too-early" };

/**
 * A spoke acts on a nudge only for an occurrence that is its own next one,
 * within a small window, and only when that occurrence is close enough that
 * waking early is plausible. Anything else is ignored and starts nothing.
 */
export function decideWakeNudge(input: {
  readonly ownNextDueAtMs: number;
  readonly occurrenceAtMs: number;
  readonly nowMs: number;
  readonly matchWindowMs: number;
  readonly maxLeadMs: number;
}): WakeNudgeDecision {
  if (Math.abs(input.ownNextDueAtMs - input.occurrenceAtMs) > input.matchWindowMs) {
    return { status: "ignore", kind: "time-mismatch" };
  }
  if (input.nowMs < input.ownNextDueAtMs - input.maxLeadMs) {
    return { status: "ignore", kind: "too-early" };
  }
  return { status: "accept" };
}

/**
 * Whether the hub should be waking a spoke for an occurrence now: from the
 * lead time before it until it has passed. A later occurrence is the spoke's
 * own missed-run policy to settle, not the hub's.
 */
export function wakeIsDue(input: {
  readonly occurrenceAtMs: number;
  readonly nowMs: number;
  readonly leadMs: number;
  readonly staleAfterMs: number;
}): boolean {
  return (
    input.nowMs >= input.occurrenceAtMs - input.leadMs &&
    input.nowMs <= input.occurrenceAtMs + input.staleAfterMs
  );
}
