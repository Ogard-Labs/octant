import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { OCTANT_UPDATE_CHECK_DISCLOSURE } from "@octant/contracts/app-updates";

/**
 * The public half of the key that signs Octant's update feed, as base64 DER
 * (SPKI). The private half lives with the maintainer and never in this
 * repository.
 *
 * Empty until a release key exists. An empty key is not a permissive default:
 * `createFeedVerifier` refuses every signature while it is empty, so a build
 * that forgot to set it offers no updates rather than accepting any. Overriding
 * it at build time is deliberate — see `docs/decisions/0032`.
 */
export const OCTANT_UPDATE_PUBLIC_KEY = "";

/**
 * What an update check may say about the machine asking.
 *
 * Deliberately not the default Electron user agent, which carries the app
 * version, the Electron version, and the OS build. The feed is static and the
 * comparison happens on the device, so none of that is needed to answer the
 * request — and a field that is not needed is a field that should not be sent.
 */
export const UPDATE_CHECK_USER_AGENT = "Octant";

/**
 * Where the signed feed lives. Static and cacheable by design: there is no
 * server to run, and nothing that could accumulate a request log richer than an
 * ordinary web server's.
 */
export const OCTANT_UPDATE_FEED_URL = "https://updates.octant.app/darwin-arm64/latest.json";

export interface FeedVerifier {
  /** Whether this signature is one our key produced over these exact bytes. */
  readonly verify: (message: Uint8Array, signature: string) => boolean;
  /** Whether a release key is configured at all. */
  readonly configured: boolean;
}

/**
 * Ed25519 verification against the compiled-in release key.
 *
 * Fails closed in every direction: no key, an unusable key, a malformed
 * signature, or a signature over different bytes all return false. Nothing here
 * can be persuaded to return true by the document it is checking.
 */
export function createFeedVerifier(publicKeyBase64 = OCTANT_UPDATE_PUBLIC_KEY): FeedVerifier {
  let key: KeyObject | undefined;
  if (publicKeyBase64 !== "") {
    try {
      key = createPublicKey({
        key: Buffer.from(publicKeyBase64, "base64"),
        format: "der",
        type: "spki",
      });
    } catch {
      // An unusable key is the same as no key. Saying so here rather than at
      // verify time keeps "we cannot check" from ever reading as "it checked
      // out".
      key = undefined;
    }
  }
  return {
    configured: key !== undefined,
    verify: (message, signature) => {
      if (key === undefined) return false;
      try {
        return verify(null, message, key, Buffer.from(signature, "base64"));
      } catch {
        return false;
      }
    },
  };
}

export interface FeedFetchResult {
  readonly kind: "fetched";
  readonly document: unknown;
}

export interface FeedFetchFailure {
  readonly kind: "unreachable" | "malformed";
}

/**
 * Fetch the update feed, sending the least a fetch can send.
 *
 * No version, no identifier, no headers beyond what an HTTPS GET needs — the
 * comparison happens on the device precisely so this request has nothing to
 * carry. `OCTANT_UPDATE_CHECK_DISCLOSURE` is the list this has to stay true to;
 * a test reads both.
 */
export async function fetchUpdateFeed(
  feedUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<FeedFetchResult | FeedFetchFailure> {
  if (!feedUrl.startsWith("https://")) return { kind: "unreachable" };
  let response: Response;
  try {
    response = await fetchImpl(feedUrl, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": UPDATE_CHECK_USER_AGENT },
      redirect: "follow",
      // No cookies, no credentials: this request identifies nobody, and a
      // stored cookie would quietly turn a version check into a visit count.
      credentials: "omit",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (!response.ok) return { kind: "unreachable" };
  try {
    return { kind: "fetched", document: await response.json() };
  } catch {
    return { kind: "malformed" };
  }
}

/** The disclosure list, re-exported so the update surface can show it verbatim. */
export const UPDATE_CHECK_DISCLOSURE = OCTANT_UPDATE_CHECK_DISCLOSURE;
