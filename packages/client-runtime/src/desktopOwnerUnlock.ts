// A Mac owner device's unlock key as an owner client's signer. The desktop app
// holds the key in the Secure Enclave and signs only after Touch ID (or the
// account password); this module hands it the host's challenge fields, never
// text of the renderer's choosing, so the desktop builds the exact unlock text
// itself. A raw key signs the unlock text only: the desktop has no call that
// signs a new-member confirmation, so that asks for another device's key.

import { OwnerUnlockDeclined, type OwnerUnlockSigner } from "./hubOwnerClient";

/** The host's challenge fields behind one unlock text. */
export interface DesktopOwnerUnlockChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly hostMemberId: string;
  readonly ownerMemberId: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly expiresAt: number;
}

export type DesktopOwnerUnlockOutcome<T> =
  | ({ readonly status: "done" } & T)
  | { readonly status: "refused"; readonly kind: string };

/** What the desktop shell exposes to a window for the Mac's unlock key. */
export interface DesktopOwnerUnlockPort {
  /** Makes the key and returns its SubjectPublicKeyInfo, base64url. */
  readonly ownerUnlockMakeKey: () => Promise<
    DesktopOwnerUnlockOutcome<{ readonly publicKey?: string }>
  >;
  /** Prompts for Touch ID and returns a raw ES256 signature, base64url. */
  readonly ownerUnlockSign: (
    challenge: DesktopOwnerUnlockChallenge,
  ) => Promise<DesktopOwnerUnlockOutcome<{ readonly signature?: string }>>;
  readonly ownerUnlockForgetKey: () => Promise<DesktopOwnerUnlockOutcome<object>>;
}

const UNLOCK_TEXT_VERSION = "octant-owner-unlock-v1";

/**
 * The challenge fields behind an owner unlock text, or nothing when the text
 * is anything else. The inverse of `ownerUnlockSigningPayload`; the desktop
 * rebuilds the text from these fields, so a text that is not an unlock cannot
 * be signed through here.
 */
export function readOwnerUnlockText(text: string): DesktopOwnerUnlockChallenge | undefined {
  const parts = text.split("\n");
  const [
    version,
    challengeId,
    nonce,
    hostMemberId,
    ownerMemberId,
    method,
    path,
    bodyHash,
    expires,
  ] = parts;
  if (
    parts.length !== 9 ||
    version !== UNLOCK_TEXT_VERSION ||
    challengeId === undefined ||
    nonce === undefined ||
    hostMemberId === undefined ||
    ownerMemberId === undefined ||
    method === undefined ||
    path === undefined ||
    bodyHash === undefined ||
    expires === undefined
  ) {
    return undefined;
  }
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expires) return undefined;
  return { challengeId, nonce, hostMemberId, ownerMemberId, method, path, bodyHash, expiresAt };
}

/**
 * A raw-shape signer for the Mac's key. Opening asks for nothing: the prompt
 * comes with each signature, when the Secure Enclave is asked to sign.
 */
export function desktopUnlockSigner(
  port: Pick<DesktopOwnerUnlockPort, "ownerUnlockSign">,
  publicKey: string,
): OwnerUnlockSigner {
  return {
    shape: "raw",
    publicKey,
    open: async () => ({
      status: "signed",
      value: {
        sign: async (text) => {
          const challenge = readOwnerUnlockText(text);
          if (challenge === undefined) throw new Error("Only an owner unlock can be signed here.");
          const answer = await port.ownerUnlockSign(challenge);
          if (answer.status === "done" && typeof answer.signature === "string") {
            return answer.signature;
          }
          if (answer.status === "refused" && answer.kind === "cancelled") {
            throw new OwnerUnlockDeclined();
          }
          throw new Error("The Mac's unlock key did not sign.");
        },
        close: () => undefined,
      },
    }),
  };
}
