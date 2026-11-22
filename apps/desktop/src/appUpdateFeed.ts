import {
  createReleaseFeedVerifier,
  fetchReleaseFeedDocument,
  type FeedFetchFailure,
  type FeedFetchResult,
  isHttpsUrl,
  type ReleaseFeedVerifier,
} from "@octant/host-runtime";
import { type AppReleaseRing, OCTANT_UPDATE_CHECK_DISCLOSURE } from "@octant/contracts/app-updates";

/**
 * The feed base, its override, the transport and the artifact download are
 * shared with a host that downloads a headless build for a server, so both
 * reach the feed the same way. Re-exported so this module stays the updater's
 * one entry point.
 */
export {
  DEFAULT_OCTANT_UPDATE_FEED_BASE_URL,
  fetchVerifiedArtifact,
  resolveUpdateFeedBaseUrl,
  UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE,
  type ArtifactFetchOutcome,
  type FeedFetchFailure,
  type FeedFetchResult,
} from "@octant/host-runtime";

/**
 * The public half of the key that signs Octant's stable update feed, as base64
 * DER (SPKI). The private half lives with the maintainer and the approval-gated
 * stable release environment, never in this repository.
 *
 * This, not the host the feed came from, is what makes an update trustworthy.
 * A feed served from the right domain over a valid certificate proves only that
 * somebody controls that domain today; the signature proves the release is one
 * we published. See docs/architecture.md, "Current Release Boundary".
 *
 * A missing or unusable value is not a permissive default:
 * `createFeedVerifier` refuses every signature unless this is a valid Ed25519
 * SPKI key, so a build that forgot to set it offers no updates rather than
 * accepting any.
 */
export const OCTANT_UPDATE_PUBLIC_KEY =
  "MCowBQYDK2VwAyEA5n78HQaS4Z3kQbVzFG3NCUaW3Gkx4ZogaxpTYPt4B/8=";

/**
 * The public half of the key the preview workflow signs preview and candidate
 * feeds with, as base64 DER (SPKI).
 *
 * Separate from the stable key because the preview workflow builds unreviewed
 * `main` without an approval gate: anything that runs there can read its
 * signing key. With one shared key, that code could sign a `ring: "stable"`
 * feed and the stable approval would protect nothing. This key verifies only
 * the preview and candidate rings.
 *
 * Empty until the maintainer mints the preview key pair. While empty those
 * rings trust only the stable key, and `scripts/sign-update-feed.ts` refuses to
 * sign a preview feed with a key no install trusts.
 */
export const OCTANT_UPDATE_PREVIEW_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAAySanIDCejRkQ3oaFsVukg6T7YS+0MaEfYcsdlrSSHc=";

/**
 * Which keys each ring believes.
 *
 * Stable trusts only the stable key. Preview and candidate trust the preview
 * key and also the stable key: whoever holds the stable key can already sign
 * stable releases, so letting it sign a preview grants nothing new, and it is
 * how installs that shipped before the preview key existed (which know only
 * the stable key) receive the first build that knows the preview key.
 */
export const OCTANT_UPDATE_TRUSTED_KEYS: Readonly<Record<AppReleaseRing, ReadonlyArray<string>>> = {
  stable: [OCTANT_UPDATE_PUBLIC_KEY],
  preview: [OCTANT_UPDATE_PREVIEW_PUBLIC_KEY, OCTANT_UPDATE_PUBLIC_KEY],
  candidate: [OCTANT_UPDATE_PREVIEW_PUBLIC_KEY, OCTANT_UPDATE_PUBLIC_KEY],
};

/**
 * What an update check says about the machine asking.
 *
 * Deliberately not the default Electron user agent, which carries the app
 * version, the Electron version, and the OS build. What the check needs to send
 * it sends as explicit parameters instead, where it can be read and counted.
 */
export const UPDATE_CHECK_USER_AGENT = "Octant";

/**
 * The feed address for one ring on one machine.
 *
 * The ring and the platform are in the path rather than in query parameters so
 * each feed is a plain static file a CDN can cache and a self-hoster can mirror
 * by copying a directory. The segments are encoded because `platform` and
 * `arch` come from the runtime rather than from a list this module controls.
 */
export function updateFeedUrl(
  baseUrl: string,
  target: { readonly ring: string; readonly platform: string; readonly arch: string },
): string {
  return `${baseUrl.replace(/\/+$/, "")}/${updateFeedRelativePath(target)}`;
}

/**
 * Where a ring's feed sits under the base: `<ring>/<platform>-<arch>.json` for
 * stable, `candidate/<platform>-<arch>.octant.json` and
 * `preview/<platform>-<arch>.octant-nightly.json` for the other two.
 *
 * The non-stable names carry the app because the release inside now names it,
 * and every install built before that decodes a feed strictly and calls a
 * document with the field malformed. Those installs keep reading the names in
 * `legacyUpdateFeedRelativePath`, which never receive a product-bearing
 * document. Stable has published nothing at its name, so it needs no new one.
 */
export function updateFeedRelativePath(target: {
  readonly ring: string;
  readonly platform: string;
  readonly arch: string;
}): string {
  const machine = `${encodeURIComponent(target.platform)}-${encodeURIComponent(target.arch)}`;
  const file =
    target.ring === "stable"
      ? `${machine}.json`
      : target.ring === "preview"
        ? `${machine}.octant-nightly.json`
        : `${machine}.octant.json`;
  return `${encodeURIComponent(target.ring)}/${file}`;
}

/**
 * The name candidate installs built before the release named its app read:
 * `candidate/<platform>-<arch>.preview-key.json`.
 *
 * Each candidate publication also writes a document there in the old shape,
 * so those installs move to a build that reads the new name. Only candidate
 * has one: candidate is Octant's alone, while the old preview names were read
 * by Octant builds that must never be offered Nightly, so those names stay as
 * they were last published and nothing writes them again.
 */
export function legacyUpdateFeedRelativePath(target: {
  readonly ring: string;
  readonly platform: string;
  readonly arch: string;
}): string | undefined {
  if (target.ring !== "candidate") return undefined;
  const machine = `${encodeURIComponent(target.platform)}-${encodeURIComponent(target.arch)}`;
  return `candidate/${machine}.preview-key.json`;
}

export type FeedVerifier = ReleaseFeedVerifier;

/**
 * Ed25519 verification against the compiled-in release keys of each ring. The
 * check itself is shared with a headless host, so the two cannot disagree on
 * what a valid signature is; only the keys named above are this app's own.
 */
export function createFeedVerifier(
  trustedKeys: Readonly<Record<AppReleaseRing, ReadonlyArray<string>>> = OCTANT_UPDATE_TRUSTED_KEYS,
): FeedVerifier {
  return createReleaseFeedVerifier(trustedKeys);
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
      redirect: "manual",
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
  fetchImpl?: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<FeedFetchResult | FeedFetchFailure> {
  if (!isHttpsUrl(feedUrl)) return { kind: "unreachable" };
  const request = buildUpdateCheckRequest(feedUrl, identity);
  return await fetchReleaseFeedDocument(request.url, request.init, fetchImpl, signal);
}

/**
 * The feed's "nothing published on this ring yet" marker.
 *
 * Unsigned and carrying nothing but its shape, so it can only ever mean "no
 * offer"; it never proves anything about a release.
 */
export function isEmptyFeedMarker(document: unknown): boolean {
  return (
    typeof document === "object" &&
    document !== null &&
    "schemaVersion" in document &&
    document.schemaVersion === 1 &&
    "status" in document &&
    document.status === "empty" &&
    Object.keys(document).length === 2
  );
}

/** The disclosure list, re-exported so the update surface can show it verbatim. */
export const UPDATE_CHECK_DISCLOSURE = OCTANT_UPDATE_CHECK_DISCLOSURE;
