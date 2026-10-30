// A Mac owner device's unlock key. The native helper makes a P-256 key in the
// Secure Enclave that signs only after the person proves presence (Touch ID,
// falling back to the account password). This module is the only door to it:
// make the key (the public half comes back), sign one owner unlock challenge,
// forget the key. It has no way to return the private key and no way to sign
// text that is not an owner unlock, because it builds the text itself from the
// host's challenge. Canonical: docs/design/hub-and-spokes.md "Owner devices".

import { ownerUnlockSigningPayload } from "@octant/domain";
import { isAbsolute } from "node:path";
import {
  HOST_IDENTITY_HELPER_MAX_BYTES,
  executeHostSigningHelper,
  type KeychainHelperExecutor,
} from "./hostIdentityKeychain";
import { KEYCHAIN_STORE_SCOPE_PATTERN } from "./keychainCredentialStore";

export const OWNER_UNLOCK_KEYCHAIN_NAMESPACE = "app.octant.owner-unlock.v1" as const;

/** The host's challenge fields, exactly what `ownerUnlockSigningPayload` joins into the text. */
export interface OwnerUnlockChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly hostMemberId: string;
  readonly ownerMemberId: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly expiresAt: number;
}

export type OwnerUnlockRefusal =
  /** No Secure Enclave, or no Touch ID or account password set: a software key is never made instead. */
  | "unavailable"
  | "no-key"
  /** The person declined the Touch ID or password prompt. */
  | "cancelled"
  /** The fields are not an owner unlock challenge. */
  | "not-an-owner-unlock"
  | "failed";

export type OwnerUnlockKeyOutcome<T> =
  | ({ readonly status: "done" } & T)
  | { readonly status: "refused"; readonly kind: OwnerUnlockRefusal };

export interface OwnerUnlockKeyService {
  /** Makes the key, replacing any earlier one. Returns SubjectPublicKeyInfo, base64url. Asks for nothing. */
  readonly makeKey: () => Promise<OwnerUnlockKeyOutcome<{ readonly publicKey: string }>>;
  /** Prompts for Touch ID, then returns a raw ES256 signature (IEEE-P1363, base64url) over the unlock text. */
  readonly sign: (
    challenge: OwnerUnlockChallenge,
  ) => Promise<OwnerUnlockKeyOutcome<{ readonly signature: string }>>;
  readonly forgetKey: () => Promise<OwnerUnlockKeyOutcome<Record<never, never>>>;
}

const FIELD_MAX_LENGTH = 2_048;
/** Only the owner routes take an owner unlock. */
const OWNER_PATH_PREFIX = "/api/hub/owner/";
const UNLOCK_METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);
const BODY_HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{1,512}$/;
/** Touch ID waits for the person; the other calls answer at once. */
const PROMPT_TIMEOUT_MS = 60_000;
const QUICK_TIMEOUT_MS = 5_000;

function isLineSafe(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= FIELD_MAX_LENGTH &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

/** The challenge's text when it is an owner unlock challenge, else nothing. */
export function ownerUnlockText(challenge: unknown): string | undefined {
  if (typeof challenge !== "object" || challenge === null) return undefined;
  const fields = challenge as Record<string, unknown>;
  const { challengeId, nonce, hostMemberId, ownerMemberId, method, path, bodyHash, expiresAt } =
    fields;
  if (
    !isLineSafe(challengeId) ||
    !isLineSafe(nonce) ||
    !isLineSafe(hostMemberId) ||
    !isLineSafe(ownerMemberId) ||
    !isLineSafe(method) ||
    !isLineSafe(path) ||
    typeof bodyHash !== "string" ||
    !BODY_HASH.test(bodyHash) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    !UNLOCK_METHODS.has(method) ||
    !path.startsWith(OWNER_PATH_PREFIX) ||
    Object.keys(fields).length !== 8
  ) {
    return undefined;
  }
  return ownerUnlockSigningPayload({
    challengeId,
    nonce,
    hostMemberId,
    ownerMemberId,
    method,
    path,
    bodyHash,
    expiresAt,
  });
}

interface HelperAnswer {
  readonly ok: boolean;
  readonly error?: string;
  readonly publicKey?: string;
  readonly signature?: string;
}

function decodeAnswer(stdout: string, operation: string): HelperAnswer | undefined {
  if (
    Buffer.byteLength(stdout) > HOST_IDENTITY_HELPER_MAX_BYTES ||
    !stdout.endsWith("\n") ||
    stdout.slice(0, -1).includes("\n")
  ) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const answer = value as Record<string, unknown>;
  if (answer.version !== 1) return undefined;
  if (answer.ok === false) {
    return Object.keys(answer).length === 3 && typeof answer.error === "string"
      ? { ok: false, error: answer.error }
      : undefined;
  }
  if (answer.ok !== true || answer.operation !== operation) return undefined;
  const allowed = new Set(["version", "ok", "operation", "publicKey", "signature"]);
  if (Object.keys(answer).some((key) => !allowed.has(key))) return undefined;
  return {
    ok: true,
    ...(typeof answer.publicKey === "string" ? { publicKey: answer.publicKey } : {}),
    ...(typeof answer.signature === "string" ? { signature: answer.signature } : {}),
  };
}

const REFUSALS: Readonly<Record<string, OwnerUnlockRefusal>> = {
  unavailable: "unavailable",
  missing: "no-key",
  cancelled: "cancelled",
};

export function makeOwnerUnlockKeyService(
  helperPath: string,
  options: { readonly storeScope: string; readonly execute?: KeychainHelperExecutor },
): OwnerUnlockKeyService {
  if (!isAbsolute(helperPath) || !KEYCHAIN_STORE_SCOPE_PATTERN.test(options.storeScope)) {
    throw new TypeError("The owner unlock key needs an absolute helper path and a store scope.");
  }
  const execute = options.execute ?? executeHostSigningHelper;

  const invoke = async (
    operation: "make" | "sign" | "forget",
    extra: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<{ readonly refused: OwnerUnlockRefusal } | { readonly answer: HelperAnswer }> => {
    const stdin = `${JSON.stringify({
      version: 1,
      namespace: OWNER_UNLOCK_KEYCHAIN_NAMESPACE,
      operation,
      storeScope: options.storeScope,
      ...extra,
    })}\n`;
    let result;
    try {
      result = await execute(
        { command: helperPath, args: [], stdin },
        { maxBytes: HOST_IDENTITY_HELPER_MAX_BYTES, timeoutMs },
      );
    } catch {
      return { refused: "unavailable" };
    }
    const answer = result.stderr.length > 0 ? undefined : decodeAnswer(result.stdout, operation);
    if (answer === undefined) return { refused: "failed" };
    if (!answer.ok) {
      return { refused: REFUSALS[answer.error ?? ""] ?? "failed" };
    }
    if (result.exitCode !== 0) return { refused: "failed" };
    return { answer };
  };

  return {
    makeKey: async () => {
      const outcome = await invoke("make", {}, QUICK_TIMEOUT_MS);
      if ("refused" in outcome) return { status: "refused", kind: outcome.refused };
      const publicKey = outcome.answer.publicKey;
      if (publicKey === undefined || !PUBLIC_KEY.test(publicKey)) {
        return { status: "refused", kind: "failed" };
      }
      return { status: "done", publicKey };
    },
    sign: async (challenge) => {
      const text = ownerUnlockText(challenge);
      if (text === undefined) return { status: "refused", kind: "not-an-owner-unlock" };
      const outcome = await invoke(
        "sign",
        { payload: Buffer.from(text, "utf8").toString("base64") },
        PROMPT_TIMEOUT_MS,
      );
      if ("refused" in outcome) return { status: "refused", kind: outcome.refused };
      const signature = outcome.answer.signature;
      // A raw P-256 signature is 64 bytes: 86 base64url characters.
      if (signature === undefined || !SIGNATURE.test(signature)) {
        return { status: "refused", kind: "failed" };
      }
      return { status: "done", signature };
    },
    forgetKey: async () => {
      const outcome = await invoke("forget", {}, QUICK_TIMEOUT_MS);
      return "refused" in outcome
        ? { status: "refused", kind: outcome.refused }
        : { status: "done" };
    },
  };
}
