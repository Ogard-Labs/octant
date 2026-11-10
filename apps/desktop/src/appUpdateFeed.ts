import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReleaseFeedVerifier, type ReleaseFeedVerifier } from "@octant/host-runtime";
import { type AppReleaseRing, OCTANT_UPDATE_CHECK_DISCLOSURE } from "@octant/contracts/app-updates";
import { createPinnedUpdateFetch, isPrivateAddress } from "./updateHttpsTransport";

const MAX_UPDATE_REDIRECTS = 5;
const MAX_UPDATE_FEED_BYTES = 64 * 1024;
const UPDATE_FEED_DEADLINE_MS = 30 * 1000;
const UPDATE_ARTIFACT_DEADLINE_MS = 15 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const pinnedUpdateFetch = createPinnedUpdateFetch();

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
 * Where the signed feeds live by default.
 *
 * A base rather than one address, because a build follows a ring and runs on a
 * platform, and each combination is its own feed: `<base>/<ring>/<platform>-<arch>.json`.
 * That shape is why adding a ring or a platform later is a new file at a known
 * path rather than a change to how anything is addressed.
 *
 * A default, not a constant the logic depends on. The maintainer may move the
 * endpoint, and a self-hosting user or a team may point at their own — so this
 * is one configurable value resolved in `resolveUpdateFeedBaseUrl`, and nothing
 * downstream assumes a host. Trust comes from the signature; pointing Octant at
 * a different server does not lower the bar it has to clear.
 */
export const DEFAULT_OCTANT_UPDATE_FEED_BASE_URL = "https://octant.sh/updates";

export const UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE = "OCTANT_UPDATE_FEED_BASE_URL";

/**
 * Resolve the feed base, preferring an explicit override.
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
export function resolveUpdateFeedBaseUrl(
  environment: Record<string, string | undefined> = {},
  fallback: string = DEFAULT_OCTANT_UPDATE_FEED_BASE_URL,
): string {
  const configured = (environment[UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE] ?? "").trim();
  if (configured === "") return fallback;
  if (!isHttpsUrl(configured)) {
    throw new Error(
      `${UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE} must be an https URL; Octant will not check for updates over an insecure endpoint.`,
    );
  }
  return configured.replace(/\/+$/, "");
}

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

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
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
  const requestSignal = withDeadline(signal, UPDATE_FEED_DEADLINE_MS);
  let response: Response | undefined;
  try {
    response = await fetchUpdateResponse(request.url, request.init, fetchImpl, requestSignal);
  } catch {
    return { kind: "unreachable" };
  }
  if (response === undefined) return { kind: "unreachable" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "unreachable" };
  }
  try {
    const bytes = await readBoundedBody(response, MAX_UPDATE_FEED_BYTES);
    return { kind: "fetched", document: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (error) {
    if (error instanceof UpdateBodyTooLarge) return { kind: "malformed" };
    if (requestSignal.aborted) return { kind: "unreachable" };
    return { kind: "malformed" };
  }
}

async function fetchUpdateResponse(
  initialUrl: string,
  init: RequestInit,
  injectedFetch: typeof globalThis.fetch | undefined,
  signal: AbortSignal,
): Promise<Response | undefined> {
  const initial = new URL(initialUrl);
  let current = initial;
  for (let redirects = 0; redirects <= MAX_UPDATE_REDIRECTS; redirects += 1) {
    if (!isPermittedUpdateUrl(current, initial)) return undefined;
    const transport =
      injectedFetch ?? (current.origin === initial.origin ? globalThis.fetch : pinnedUpdateFetch);
    const response = await transport(current.href, {
      ...init,
      redirect: "manual",
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (location === null) return undefined;
    try {
      current = new URL(location, current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A redirect may retain initial private authority, but may not introduce it. */
function isPermittedUpdateUrl(candidate: URL, initial: URL): boolean {
  if (candidate.protocol !== "https:" || candidate.username !== "" || candidate.password !== "") {
    return false;
  }
  if (candidate.origin === initial.origin) return true;
  const hostname = candidate.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) === 0 || !isPrivateAddress(bare);
}

class UpdateBodyTooLarge extends Error {}

function declaredBodyTooLarge(response: Response, maximumBytes: number): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength)) return false;
  const declared = Number(contentLength);
  return !Number.isSafeInteger(declared) || declared > maximumBytes;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (declaredBodyTooLarge(response, maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpdateBodyTooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpdateBodyTooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function writeWhole(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await file.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten === 0) throw new Error("The update artifact could not be staged.");
    offset += written.bytesWritten;
  }
}

/**
 * Stage and hash an artifact on disk before allocating its final byte array.
 * A corrupt or oversized response therefore never keeps both every network
 * chunk and a second contiguous copy resident in the desktop main process.
 */
async function readVerifiedArtifactBody(
  response: Response,
  maximumBytes: number,
  expectedHex: string,
): Promise<ArtifactFetchOutcome> {
  if (declaredBodyTooLarge(response, maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "corrupt" };
  }
  if (response.body === null) {
    const empty = new Uint8Array();
    return matchesDigest(empty, expectedHex)
      ? { kind: "verified", bytes: empty }
      : { kind: "corrupt" };
  }
  const directory = await mkdtemp(join(tmpdir(), "octant-update-"));
  const artifact = join(directory, "artifact");
  const reader = response.body.getReader();
  let file: FileHandle | undefined;
  let complete = false;
  try {
    file = await open(artifact, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) throw new UpdateBodyTooLarge();
      hash.update(next.value);
      await writeWhole(file, next.value);
    }
    complete = true;
    await file.close();
    file = undefined;
    if (!matchesDigestValue(hash.digest(), expectedHex)) return { kind: "corrupt" };
    return { kind: "verified", bytes: await readFile(artifact) };
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
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
  fetchImpl?: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<ArtifactFetchOutcome> {
  if (!isHttpsUrl(input.url)) return { kind: "unreachable" };
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) return { kind: "corrupt" };
  const requestSignal = withDeadline(signal, UPDATE_ARTIFACT_DEADLINE_MS);
  let response: Response | undefined;
  try {
    response = await fetchUpdateResponse(
      input.url,
      { method: "GET", redirect: "manual", credentials: "omit" },
      fetchImpl,
      requestSignal,
    );
  } catch {
    return { kind: "unreachable" };
  }
  if (response === undefined) return { kind: "unreachable" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "unreachable" };
  }
  try {
    return await readVerifiedArtifactBody(response, input.maxBytes, input.sha256);
  } catch (error) {
    if (error instanceof UpdateBodyTooLarge) return { kind: "corrupt" };
    return { kind: "unreachable" };
  }
}

/** Constant-time comparison, so a mismatch reveals nothing about where it differs. */
function matchesDigest(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash("sha256").update(bytes).digest();
  return matchesDigestValue(actual, expectedHex);
}

function matchesDigestValue(actual: Buffer, expectedHex: string): boolean {
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
