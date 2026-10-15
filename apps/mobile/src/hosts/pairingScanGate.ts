import { PAIRING_CODE_PREFIX } from "@octant/domain";

export type PairingScanVerdict =
  /** The first pairing code since the scanner opened: hand it over. */
  | "deliver"
  /** A QR code that is not an Octant pairing code. */
  | "other"
  /** A repeat after a code was already handed over; the camera reports a code many times a second. */
  | "ignored";

/**
 * Decides what the scanner does with each scanned text: it hands over one
 * pairing code per opening and ignores the camera's repeats of it. Opening
 * the scanner again starts afresh, so a code whose pairing failed can be
 * scanned again.
 */
export function createPairingScanGate() {
  let delivered = false;
  return {
    offer(text: string): PairingScanVerdict {
      if (delivered) return "ignored";
      if (!text.startsWith(PAIRING_CODE_PREFIX)) return "other";
      delivered = true;
      return "deliver";
    },
    reset(): void {
      delivered = false;
    },
  };
}
