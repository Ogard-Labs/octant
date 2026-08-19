import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { OCTANT_UPDATE_CHECK_DISCLOSURE } from "@octant/contracts/app-updates";

/**
 * The public half of the key that signs Octant's update feed, as base64 DER
 * (SPKI). The private half lives with the maintainer and never in this
 * repository.
 *
 * This, not the host the feed came from, is what makes an update trustworthy.
 * A feed served from the right domain over a valid certificate proves only that
 * somebody controls that domain today; the signature proves the release is one
 * we published. See `docs/decisions/0034`.
 *
 * Empty until a release key exists, and empty is not a permissive default:
 * `createFeedVerifier` refuses every signature while it is empty, so a build
 * that forgot to set it offers no updates rather than accepting any.
 */
export const OCTANT_UPDATE_PUBLIC_KEY = "";

/**
 * What an update check says about the machine asking.
 *
 * Deliberately not the default Electron user agent, which carries the app
 * version, the Electron version, and the OS build. What the check needs to send
 * it sends as explicit parameters instead, where it can be read and counted.
 */
export const UPDATE_CHECK_USER_AGENT = "Octant";

/**
 * Where the signed feed lives by default.
 *
 * A default, not a constant the logic depends on. The maintainer may move the
 * endpoint, and a self-hosting user or a team may point at their own — so this
 * is one configurable value resolved in `resolveUpdateFeedUrl`, and nothing
 * downstream assumes a host. Trust comes from the signature; pointing Octant at
 * a different server does not lower the bar it has to clear.
 */
export const DEFAULT_OCTANT_UPDATE_FEED_URL = "https://octant.sh/updates/darwin-arm64.json";

export const UPDATE_FEED_URL_ENVIRONMENT_VARIABLE = "OCTANT_UPDATE_FEED_URL";

/**
 * Resolve the feed endpoint, preferring an explicit override.
 *
 * HTTPS is required of any endpoint, including an overridden one. That is
 * transport hygiene rather than trust: it keeps the request and the version it
 * carries off the wire in the clear. It proves nothing about the release, which
 * is why the signature check is not relaxed for any host.
 *
 * An override that is not usable is refused rather than silently ignored: a
 * team that pointed Octant at their own server and got the public one anyway
 * would be updating from somewhere they did not choose.
 */
export function resolveUpdateFeedUrl(
  environment: Record<string, string | undefined> = {},
  fallback: string = DEFAULT_OCTANT_UPDATE_FEED_URL,
): string {
  const configured = (environment[UPDATE_FEED_URL_ENVIRONMENT_VARIABLE] ?? "").trim();
  if (configured === "") return fallback;
  if (!isHttpsUrl(configured)) {
    throw new Error(
      `${UPDATE_FEED_URL_ENVIRONMENT_VARIABLE} must be an https URL; Octant will not check for updates over an insecure endpoint.`,
    );
  }
  return configured;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

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

export interface UpdateCheckIdentity {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
}

/**
 * Build the exact request an update check makes.
 *
 * Three parameters and nothing else. `platform` and `arch` are what select the
 * right release; `version` is what lets a feed answer "is there anything newer
 * for you" without Octant having to trust its answer — the comparison still
 * happens on the device afterwards, so a server that ignores the parameter
 * works identically.
 *
 * Everything absent here is absent on purpose: no account, no install id, no
 * Project or thread, no configuration, no counters, and no cookies. This path
 * carries update checks and is not a place to add anything else later.
 */
export function buildUpdateCheckRequest(
  feedUrl: string,
  identity: UpdateCheckIdentity,
): { readonly url: string; readonly init: RequestInit } {
  const url = new URL(feedUrl);
  url.searchParams.set("version", identity.version);
  url.searchParams.set("platform", identity.platform);
  url.searchParams.set("arch", identity.arch);
  return {
    url: url.toString(),
    init: {
      method: "GET",
      headers: { accept: "application/json", "user-agent": UPDATE_CHECK_USER_AGENT },
      redirect: "follow",
      // No cookies, no credentials: this request identifies nobody, and a
      // stored cookie would quietly turn a version check into a visit count.
      credentials: "omit",
    },
  };
}

/**
 * Fetch the update feed, sending only what a check needs.
 *
 * `OCTANT_UPDATE_CHECK_DISCLOSURE` is the list this has to stay true to; a test
 * reads both.
 */
export async function fetchUpdateFeed(
  feedUrl: string,
  identity: UpdateCheckIdentity,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<FeedFetchResult | FeedFetchFailure> {
  if (!isHttpsUrl(feedUrl)) return { kind: "unreachable" };
  const request = buildUpdateCheckRequest(feedUrl, identity);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      ...request.init,
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

export type ArtifactFetchOutcome =
  | { readonly kind: "verified"; readonly bytes: Uint8Array }
  | { readonly kind: "unreachable" }
  | { readonly kind: "corrupt" };

/**
 * Download the release artifact and prove it is the one that was signed.
 *
 * The feed says where the bytes are and what they must hash to, and both are
 * inside the signature — so this check is what turns a signed *notice* into a
 * verified *artifact*. Without it the signature would only cover a promise, and
 * whoever served the download could substitute anything.
 *
 * That is also what makes the artifact's location a free choice: it may sit on
 * the same host as the feed or in a GitHub release, because nothing here trusts
 * the host it came from. A mismatch is `corrupt` and stops the update; there is
 * no retry that lowers the bar and no path that installs unverified bytes.
 */
export async function fetchVerifiedArtifact(
  input: { readonly url: string; readonly sha256: string; readonly maxBytes: number },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<ArtifactFetchOutcome> {
  if (!isHttpsUrl(input.url)) return { kind: "unreachable" };
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (!response.ok) return { kind: "unreachable" };
  let bytes: Uint8Array;
  try {
    const buffer = await response.arrayBuffer();
    // A release is a known size; a body far past it is not a release, and
    // reading it into memory to find that out is how a download becomes a
    // denial of service.
    if (buffer.byteLength > input.maxBytes) return { kind: "corrupt" };
    bytes = new Uint8Array(buffer);
  } catch {
    return { kind: "unreachable" };
  }
  return matchesDigest(bytes, input.sha256) ? { kind: "verified", bytes } : { kind: "corrupt" };
}

/** Constant-time comparison, so a mismatch reveals nothing about where it differs. */
function matchesDigest(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash("sha256").update(bytes).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The disclosure list, re-exported so the update surface can show it verbatim. */
export const UPDATE_CHECK_DISCLOSURE = OCTANT_UPDATE_CHECK_DISCLOSURE;
