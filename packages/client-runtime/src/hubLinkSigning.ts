// What a device that is not a host does to sign a member request: the same
// signed header every hub and spoke request carries, built from a key the
// platform holds. Shared by the guest and owner clients; not a public surface.

export const HUB_LINK_HEADER = "x-octant-hub-link";

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const sha256 = async (bytes: BufferSource | string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", typeof bytes === "string" ? encoder.encode(bytes) : bytes);

/** The key a member request is signed with: the identity key the roster vouches for. */
export interface LinkSigner {
  readonly memberId: string;
  /** IEEE-P1363 signature over the text, base64url. */
  readonly sign: (payload: string) => Promise<string>;
}

export async function linkHeader(input: {
  readonly signer: LinkSigner;
  readonly recipientMemberId: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly now: number;
}): Promise<string> {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const text = [
    "octant-hub-link-v1",
    input.recipientMemberId,
    input.method.toUpperCase(),
    input.path,
    hex(await sha256(input.body)),
    String(input.now),
    nonce,
  ].join("\n");
  return `v1.${input.signer.memberId}.${input.now}.${nonce}.${await input.signer.sign(text)}`;
}
