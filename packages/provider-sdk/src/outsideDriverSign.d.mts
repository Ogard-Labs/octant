/**
 * Types for `outsideDriverSign.mjs`, the author's signing tool for an
 * outside provider driver package. It is plain JavaScript an author can copy
 * and run; see that file for the signed message and the command line.
 */

export declare const SIGNATURE_FORMAT: "octant-signature/1";
export declare const SIGNATURE_PATH: "octant-signature.json";
export declare const DRIVER_DOCUMENT_PATH: "octant-provider-driver.json";

export interface OutsideDriverSignedContent {
  readonly name: string;
  readonly version: string;
  readonly protocolVersions: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

/** The exact bytes a publisher signs. */
export declare function signedMessage(content: OutsideDriverSignedContent): Uint8Array;

/** `ed25519:` and the hex SHA-256 of a public key's 32 raw bytes. */
export declare function publisherKeyFingerprint(rawPublicKey: Uint8Array): string;

/** Signs the folder and writes `octant-signature.json`; the private key is never written or printed. */
export declare function signOutsideDriverPackage(input: {
  readonly root: string;
  readonly privateKeyPem: string | Uint8Array;
}): Promise<{ readonly fingerprint: string; readonly path: string }>;
