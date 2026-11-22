import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateAddress } from "./browserNavigation";
import { createPinnedUpdateFetch } from "./updateHttpsTransport";

/**
 * Reading Octant's signed release feed and the artifacts it names, shared by
 * the desktop updater and a host downloading a headless build for a server
 * it installs over SSH, so the two cannot disagree on how the feed is reached.
 * Canonical: docs/architecture.md, "The feed is published to GitHub releases".
 *
 * Nothing here decides whether a release is trusted: the signature over the
 * feed and the digest it names do that, checked by the caller and by
 * {@link fetchVerifiedArtifact}. What this enforces is the transport: HTTPS
 * on every hop, no URL credentials, at most five redirects, and a redirect to
 * a new origin connecting only to globally reachable addresses.
 */

const MAX_UPDATE_REDIRECTS = 5;
const MAX_UPDATE_FEED_BYTES = 64 * 1024;
const UPDATE_FEED_DEADLINE_MS = 30 * 1000;
const UPDATE_ARTIFACT_DEADLINE_MS = 15 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const pinnedUpdateFetch = createPinnedUpdateFetch();

/**
 * Where the signed feeds live by default.
 *
 * A base rather than one address, because a build follows a ring and runs on a
 * platform, and each combination is its own feed: `<base>/<ring>/<file>`.
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
  // Trailing slashes are trimmed by index rather than a `/+$` pattern, which
  // backtracks polynomially on a long run of slashes (flagged by CodeQL).
  let end = configured.length;
  while (end > 0 && configured[end - 1] === "/") end -= 1;
  return configured.slice(0, end);
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export interface FeedFetchResult {
  readonly kind: "fetched";
  readonly document: unknown;
}

export interface FeedFetchFailure {
  readonly kind: "unreachable" | "malformed";
}

/**
 * Fetch one feed document as JSON: at most 64 KiB, within 30 seconds. The
 * caller builds the request, so what it sends stays the caller's to state.
 */
export async function fetchReleaseFeedDocument(
  feedUrl: string,
  init: RequestInit,
  fetchImpl?: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<FeedFetchResult | FeedFetchFailure> {
  if (!isHttpsUrl(feedUrl)) return { kind: "unreachable" };
  const requestSignal = withDeadline(signal, UPDATE_FEED_DEADLINE_MS);
  let response: Response | undefined;
  try {
    response = await fetchUpdateResponse(feedUrl, init, fetchImpl, requestSignal);
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
 * chunk and a second contiguous copy resident in the process.
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

/**
 * Where a ring's signed document for one headless build sits under the feed
 * base: `<ring>/<target>.octant-headless.json`, such as
 * `candidate/linux-x64.octant-headless.json`. A name no desktop install
 * reads, so the desktop feeds' documents and readers are unchanged.
 */
export function headlessBuildFeedRelativePath(input: {
  readonly ring: string;
  readonly target: string;
}): string {
  return `${encodeURIComponent(input.ring)}/${encodeURIComponent(input.target)}.octant-headless.json`;
}
