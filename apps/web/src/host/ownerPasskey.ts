// A browser owner's unlock key: a passkey with user verification, made when the
// browser joins as an owner and asked for on each action. A passkey belongs to
// one web origin, so a browser owner makes one per host origin it uses. The
// private key never leaves the authenticator; the host records only the public
// key and checks the assertion's signature, user-present and user-verified flags,
// and challenge (the SHA-256 of its unlock text).

import {
  base64UrlEncode,
  type OwnerUnlockAssertion,
  type OwnerUnlockSigner,
  type UnlockAttempt,
} from "@octant/client-runtime";
import type { HubAdministrationBridge } from "../shell/hostBridge";

/** The part of `navigator.credentials` this module uses, so a test can stand one in. */
export interface PasskeyCredentials {
  readonly create: (options: CredentialCreationOptions) => Promise<Credential | null>;
  readonly get: (options: CredentialRequestOptions) => Promise<Credential | null>;
}

export interface OwnerPasskey {
  readonly credentialId: string;
  /** SubjectPublicKeyInfo, base64url: what the host records as the owner's unlock key. */
  readonly publicKey: string;
}

export type PasskeyRegistration =
  | { readonly status: "registered"; readonly passkey: OwnerPasskey }
  | { readonly status: "cancelled" }
  | { readonly status: "unsupported" };

const ES256 = -7;
/** An unlock a person walks away from still ends; the host's own challenge ends sooner. */
const PROMPT_TIMEOUT_MS = 60_000;

/**
 * A desktop window already has the host's authority, so only a browser client
 * that is not one is offered a passkey unlock.
 */
export function browserOwnerOffered(input: {
  readonly hubAdministration: HubAdministrationBridge | undefined;
  readonly joinedAsOwner: boolean;
  readonly credentials: PasskeyCredentials | undefined;
}): boolean {
  return (
    input.hubAdministration === undefined && input.joinedAsOwner && input.credentials !== undefined
  );
}

function asPublicKeyCredential(credential: Credential | null): PublicKeyCredential | undefined {
  return credential !== null && "rawId" in credential
    ? (credential as PublicKeyCredential)
    : undefined;
}

/** Makes the passkey for one host origin. A browser without a verifying authenticator cannot be an owner. */
export async function registerOwnerPasskey(input: {
  readonly credentials: PasskeyCredentials;
  readonly hostName: string;
  readonly ownerMemberId: string;
  readonly ownerName: string;
}): Promise<PasskeyRegistration> {
  let credential: PublicKeyCredential | undefined;
  try {
    credential = asPublicKeyCredential(
      await input.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: `Octant on ${input.hostName}` },
          user: {
            id: new TextEncoder().encode(input.ownerMemberId),
            name: input.ownerName,
            displayName: input.ownerName,
          },
          pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required",
            residentKey: "preferred",
          },
          timeout: PROMPT_TIMEOUT_MS,
        },
      }),
    );
  } catch {
    // A declined prompt and a browser with no platform authenticator both end here.
    return { status: "cancelled" };
  }
  if (credential === undefined) return { status: "cancelled" };
  const publicKey = (credential.response as AuthenticatorAttestationResponse).getPublicKey();
  if (publicKey === null) return { status: "unsupported" };
  return {
    status: "registered",
    passkey: {
      credentialId: base64UrlEncode(credential.rawId),
      publicKey: base64UrlEncode(publicKey),
    },
  };
}

function bytesOfBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** An unlock signer that asks the person for the passkey on every action. */
export function passkeyUnlockSigner(input: {
  readonly credentials: PasskeyCredentials;
  readonly passkey: OwnerPasskey;
}): OwnerUnlockSigner {
  return {
    shape: "webauthn",
    publicKey: input.passkey.publicKey,
    assert: async (challenge): Promise<UnlockAttempt<OwnerUnlockAssertion>> => {
      let credential: PublicKeyCredential | undefined;
      try {
        credential = asPublicKeyCredential(
          await input.credentials.get({
            publicKey: {
              challenge: bytesOfBase64Url(challenge),
              allowCredentials: [
                { type: "public-key", id: bytesOfBase64Url(input.passkey.credentialId) },
              ],
              userVerification: "required",
              timeout: PROMPT_TIMEOUT_MS,
            },
          }),
        );
      } catch {
        return { status: "cancelled" };
      }
      if (credential === undefined) return { status: "cancelled" };
      const response = credential.response as AuthenticatorAssertionResponse;
      return {
        status: "signed",
        value: {
          authenticatorData: base64UrlEncode(response.authenticatorData),
          clientDataJson: base64UrlEncode(response.clientDataJSON),
          signature: base64UrlEncode(response.signature),
        },
      };
    },
  };
}
