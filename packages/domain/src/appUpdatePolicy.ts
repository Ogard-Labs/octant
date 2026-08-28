import {
  type AppReleaseRing,
  AppUpdateFeed,
  type AppUpdateRefusal,
  type AppUpdateRelease,
  type AppVersion,
  PREVIEW_PRERELEASE_TAG,
} from "@octant/contracts/app-updates";
import { Schema } from "effect";

/**
 * What the app is, for the purpose of deciding whether a feed offers anything.
 */
export interface RunningApp {
  readonly version: AppVersion;
  readonly platform: string;
  readonly arch: string;
  /** The ring this app is following, and therefore the ring its feed must name. */
  readonly ring: AppReleaseRing;
}

/**
 * The ring a build belongs to, read from its own version.
 *
 * A preview build is one whose version carries the preview prerelease tag.
 * Deriving it rather than storing it beside the version means a build cannot
 * be a preview that thinks it is stable, which is the failure that would put
 * unreviewed `main` in front of everyone on the stable ring.
 *
 * This is the *default* ring, not a lock: a person may follow either ring, and
 * the version ordering already makes both directions safe — a stable release
 * outranks the previews leading to it, and no ring can offer a version that is
 * not strictly newer.
 */
export function ringForVersion(version: AppVersion): AppReleaseRing {
  const [, prerelease] = splitOnce(String(version), "-");
  if (prerelease === undefined) return "stable";
  return prerelease.split(".")[0] === PREVIEW_PRERELEASE_TAG ? "preview" : "stable";
}

export type UpdateOffer =
  | { readonly kind: "offer"; readonly release: AppUpdateRelease }
  | { readonly kind: "refuse"; readonly refusal: AppUpdateRefusal };

/**
 * The exact bytes a feed's signature covers.
 *
 * Canonical rather than "whatever the server sent": keys in a fixed order, no
 * insignificant whitespace, absent optional fields simply absent. A verifier
 * that signed the received text instead would accept a document re-serialized
 * with different spacing and reject one that is byte-identical in meaning, and
 * either way it would be checking the transport rather than the release.
 */
export function canonicalReleaseBytes(release: AppUpdateRelease): Uint8Array {
  const ordered: Record<string, string> = {
    arch: release.arch,
    platform: release.platform,
    releasedAt: String(release.releasedAt),
    ring: release.ring,
    sha256: release.sha256,
    url: release.url,
    version: String(release.version),
  };
  if (release.notes !== undefined) ordered.notes = release.notes;
  const canonical = Object.keys(ordered)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(ordered[key])}`)
    .join(",");
  return new TextEncoder().encode(`{${canonical}}`);
}

const decodeFeed = Schema.decodeUnknownEither(AppUpdateFeed);

/**
 * Decide what a fetched feed offers this app, refusing anything it cannot
 * prove.
 *
 * Every path out of here that is not `offer` is a refusal: there is no partial
 * trust, no "probably fine", and no way for a caller to proceed on a document
 * that failed a check. The order matters — the signature is verified before
 * any field is believed, because an unsigned document's version number is not
 * evidence of anything.
 *
 * `verifySignature` is injected rather than imported so this stays a pure
 * decision. Whether Ed25519 says yes is the host's to answer; what to do about
 * the answer is this.
 */
export function resolveUpdateOffer(input: {
  readonly document: unknown;
  readonly app: RunningApp;
  readonly verifySignature: (message: Uint8Array, signature: string) => boolean;
}): UpdateOffer {
  const decoded = decodeFeed(input.document);
  if (decoded._tag === "Left") return { kind: "refuse", refusal: "malformed" };
  const feed = decoded.right;

  let verified = false;
  try {
    verified = input.verifySignature(canonicalReleaseBytes(feed.release), feed.signature);
  } catch {
    // A verifier that threw told us nothing, which is not the same as telling
    // us yes.
    verified = false;
  }
  if (!verified) return { kind: "refuse", refusal: "untrusted-signature" };

  if (feed.release.platform !== input.app.platform || feed.release.arch !== input.app.arch) {
    return { kind: "refuse", refusal: "wrong-platform" };
  }
  if (feed.release.ring !== input.app.ring) {
    // Both rings are signed by one key, so the signature alone cannot tell a
    // stable feed from a preview one served at the stable address. Checking
    // the signed ring against the ring we asked for is what makes the two
    // streams actually separate.
    return { kind: "refuse", refusal: "wrong-ring" };
  }
  if (compareAppVersions(feed.release.version, input.app.version) <= 0) {
    // Equal is not newer, and older is a downgrade. Refusing both is what stops
    // a feed from walking an install back to a version with a known hole.
    return { kind: "refuse", refusal: "not-newer" };
  }
  return { kind: "offer", release: feed.release };
}

/**
 * Order two versions: negative when `left` is older, positive when newer.
 *
 * A prerelease sorts below the release it leads to, so `1.0.0-rc.1` never
 * counts as newer than `1.0.0`. Numeric prerelease identifiers compare as
 * numbers so `rc.2` follows `rc.10` correctly rather than alphabetically.
 */
export function compareAppVersions(left: AppVersion, right: AppVersion): number {
  const parsedLeft = parseVersion(String(left));
  const parsedRight = parseVersion(String(right));
  for (let index = 0; index < 3; index += 1) {
    const difference = (parsedLeft.release[index] ?? 0) - (parsedRight.release[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (parsedLeft.prerelease === undefined && parsedRight.prerelease === undefined) return 0;
  if (parsedLeft.prerelease === undefined) return 1;
  if (parsedRight.prerelease === undefined) return -1;
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function parseVersion(value: string): {
  readonly release: ReadonlyArray<number>;
  readonly prerelease?: ReadonlyArray<string>;
} {
  const [core, prerelease] = splitOnce(value, "-");
  const release = core.split(".").map((part) => Number.parseInt(part, 10));
  return prerelease === undefined ? { release } : { release, prerelease: prerelease.split(".") };
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index === -1
    ? [value, undefined]
    : [value.slice(0, index), value.slice(index + separator.length)];
}

function comparePrerelease(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    // A shorter run of identifiers sorts first: `rc` precedes `rc.1`.
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * Work that would be lost if the app were replaced right now, as the host
 * already reports it for the quit guard.
 *
 * Deliberately the same shape the app already trusts to decide whether quitting
 * would interrupt something. A second, separately derived notion of "busy"
 * would be one more thing to keep true, and the two would disagree exactly when
 * it mattered.
 */
export interface UpdateWorkInFlight {
  readonly activeAgentCount: number;
  readonly attentionRequired: boolean;
}

export type UpdateInstallReadiness =
  | { readonly kind: "ready" }
  | {
      readonly kind: "wait";
      readonly activeAgentCount: number;
      readonly attentionRequired: boolean;
    };

/**
 * May a staged update be applied right now?
 *
 * Running work is work the person has not seen the end of, and relaunching
 * under it loses whatever had not been journaled. A thread waiting on an
 * approval counts too: it is a question the person has not answered, and
 * restarting throws the question away. So install waits and says what it is
 * waiting for — the person lets the work finish or checkpoints it, the same
 * choice restoring already asks them to make.
 *
 * This is a refusal to act, not a delay that expires: nothing here ever decides
 * that work has taken long enough and proceeds anyway.
 */
export function resolveUpdateInstallReadiness(work: UpdateWorkInFlight): UpdateInstallReadiness {
  if (work.activeAgentCount === 0 && !work.attentionRequired) return { kind: "ready" };
  return {
    kind: "wait",
    activeAgentCount: work.activeAgentCount,
    attentionRequired: work.attentionRequired,
  };
}
