import {
  decodeUtcTimestamp,
  sameToolActionAuthority,
  type StoredBrowserProfile,
  type WindowId,
} from "@octant/contracts";
import type {
  BrowserSessionGrant,
  BrowserSessionGrantee,
  BrowserSessionGrantsCommand,
  BrowserSessionGrantsResult,
  BrowserSessionTarget,
} from "@octant/contracts/browser-session-grants";
import { browserProfileKey } from "@octant/domain";
import {
  decodeBrowserSessionGrantId,
  decodeBrowserSessionReviewId,
} from "@octant/contracts/browser-session-grants";

export interface CurrentBrowserSessionTarget {
  readonly target: BrowserSessionTarget;
  /** A changed routine/workspace/session must receive another explicit review. */
  readonly revision: string;
  readonly notAfter?: number;
}

interface SavedPermission {
  readonly grant: BrowserSessionGrant;
  readonly revision: string;
  readonly windowId: WindowId;
}

interface BrowserSessionGrantsOptions {
  readonly now: () => number;
  readonly uuid: () => string;
  readonly isLocalWindow: (windowId: WindowId) => boolean;
  readonly localWindows?: () => ReadonlyArray<WindowId>;
  readonly canReview: (windowId: WindowId, target: BrowserSessionTarget) => boolean;
  readonly targets: () => ReadonlyArray<CurrentBrowserSessionTarget>;
  readonly current: (grantee: BrowserSessionGrantee) => CurrentBrowserSessionTarget | undefined;
  readonly profileLabel: (profile: StoredBrowserProfile) => Promise<string | undefined>;
  readonly record: (event: {
    readonly kind: "granted" | "revoked" | "expired" | "changed";
    readonly grant: BrowserSessionGrant;
    readonly windowId?: WindowId;
  }) => void;
  readonly onRevoked: (grantId: string) => void;
}

const MAX_PERMISSIONS = 256;
const REVIEW_MS = 2 * 60_000;

function refused(
  reason: Extract<
    BrowserSessionGrantsResult,
    { readonly kind: "browser-session-refused" }
  >["reason"],
  message: string,
): BrowserSessionGrantsResult {
  return { kind: "browser-session-refused", reason, message };
}

function sameTarget(a: BrowserSessionTarget, b: BrowserSessionTarget): boolean {
  return (
    JSON.stringify(a.grantee) === JSON.stringify(b.grantee) &&
    a.modelId === b.modelId &&
    sameToolActionAuthority(a.authority, b.authority)
  );
}

function httpsOrigins(values: ReadonlyArray<string>): ReadonlyArray<string> | undefined {
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.origin !== value
      )
        return undefined;
      origins.add(url.origin);
    } catch {
      return undefined;
    }
  }
  return origins.size > 0 && origins.size <= 16 ? [...origins].sort() : undefined;
}

/** Host-lifetime permissions; a restart deliberately restores none of them. */
export class BrowserSessionGrants {
  readonly #options: BrowserSessionGrantsOptions;
  readonly #grants = new Map<string, SavedPermission>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reviews = new Map<
    string,
    SavedPermission & { readonly windowId: WindowId; readonly expires: number }
  >();

  constructor(options: BrowserSessionGrantsOptions) {
    this.#options = options;
  }

  async execute(
    windowId: WindowId,
    command: BrowserSessionGrantsCommand,
  ): Promise<BrowserSessionGrantsResult> {
    if (!this.#options.isLocalWindow(windowId))
      return refused("not-local", "Session permissions are reviewed only on the execution host.");
    this.#prune();
    if (command.kind === "targets")
      return {
        kind: "browser-session-targets",
        targets: this.#options
          .targets()
          .filter((row) => this.#options.canReview(windowId, row.target))
          .slice(0, MAX_PERMISSIONS)
          .map((row) => row.target),
      };
    if (command.kind === "list")
      return {
        kind: "browser-session-grants",
        grants: [...this.#grants.values()]
          .filter((row) => this.#options.canReview(windowId, row.grant.target))
          .map((row) => row.grant),
      };
    if (command.kind === "revoke") {
      const row = this.#grants.get(command.grantId);
      if (row === undefined || !this.#options.canReview(windowId, row.grant.target))
        return refused("stale", "That session permission is no longer available.");
      const recorded = this.#remove(row, "revoked", windowId);
      return recorded
        ? { kind: "browser-session-revoked", grantId: command.grantId }
        : refused(
            "record-failed",
            "Permission was revoked, but its audit record could not be saved.",
          );
    }
    if (command.kind === "review") {
      const current = this.#options.current(command.grantee);
      const origins = httpsOrigins(command.origins);
      if (origins === undefined)
        return refused(
          "invalid",
          "Choose exact HTTPS origins without paths, credentials or query values.",
        );
      if (current === undefined || !this.#options.canReview(windowId, current.target))
        return refused("unavailable", "That caller no longer has eligible live task authority.");
      if (
        command.profile.kind === "project" &&
        String(command.profile.projectId) !== String(current.target.authority.projectId)
      )
        return refused("invalid", "Choose this task's own Project profile.");
      if (current.target.authority.mode === "chat")
        return refused("invalid", "Chat has no Browser session permission.");
      const label = await this.#options.profileLabel(command.profile);
      if (label === undefined)
        return refused("unavailable", "That profile is unavailable on this host.");
      const refreshed = this.#options.current(command.grantee);
      if (
        !this.#options.isLocalWindow(windowId) ||
        refreshed === undefined ||
        refreshed.revision !== current.revision ||
        !sameTarget(refreshed.target, current.target) ||
        !this.#options.canReview(windowId, refreshed.target)
      )
        return refused("stale", "The caller or local window changed. Review the session again.");
      const now = this.#options.now();
      const expires = Math.min(
        now + command.durationMinutes * 60_000,
        current.notAfter ?? Infinity,
      );
      if (expires <= now) return refused("expired", "That caller's session has ended.");
      const grant: BrowserSessionGrant = {
        grantId: decodeBrowserSessionGrantId(this.#options.uuid()),
        target: current.target,
        profile: command.profile,
        profileLabel: label,
        origins,
        grantedAt: decodeUtcTimestamp(new Date(now).toISOString()),
        expiresAt: decodeUtcTimestamp(new Date(expires).toISOString()),
      };
      if (this.#reviews.size >= MAX_PERMISSIONS)
        return refused("limit", "Finish or wait for an existing review before opening another.");
      const reviewId = decodeBrowserSessionReviewId(this.#options.uuid());
      this.#reviews.set(reviewId, {
        grant,
        revision: current.revision,
        windowId,
        expires: now + REVIEW_MS,
      });
      return { kind: "browser-session-review", reviewId, grant };
    }
    const review = this.#reviews.get(command.reviewId);
    if (review === undefined || String(review.windowId) !== String(windowId))
      return refused("stale", "This review belongs to its original window or has ended.");
    this.#reviews.delete(command.reviewId);
    if (!this.#current(review) || !this.#options.canReview(windowId, review.grant.target))
      return refused(
        "stale",
        "This review expired or the caller changed. Review its permission again.",
      );
    const label = await this.#options.profileLabel(review.grant.profile);
    if (
      review.expires <= this.#options.now() ||
      label !== review.grant.profileLabel ||
      !this.#current(review) ||
      !this.#options.isLocalWindow(windowId) ||
      !this.#options.canReview(windowId, review.grant.target)
    )
      return refused(
        "stale",
        "The review expired or its profile, caller or window changed. Review it again.",
      );
    if (this.#grants.size >= MAX_PERMISSIONS)
      return refused("limit", "Revoke an existing session permission first.");
    try {
      this.#options.record({ kind: "granted", grant: review.grant, windowId });
    } catch {
      return refused("record-failed", "The permission could not be recorded. Nothing was granted.");
    }
    this.#grants.set(review.grant.grantId, review);
    const timer = setTimeout(
      () => this.#remove(review, "expired"),
      Math.max(1, Date.parse(review.grant.expiresAt) - this.#options.now()),
    );
    timer.unref?.();
    this.#timers.set(review.grant.grantId, timer);
    return { kind: "browser-session-granted", grant: review.grant };
  }

  find(
    grantee: BrowserSessionGrantee,
    profile: StoredBrowserProfile,
    origins: ReadonlyArray<string>,
  ): string | undefined {
    this.#prune();
    return [...this.#grants.values()].find(
      (row) =>
        JSON.stringify(row.grant.target.grantee) === JSON.stringify(grantee) &&
        browserProfileKey(row.grant.profile) === browserProfileKey(profile) &&
        origins.length > 0 &&
        origins.every((origin) => row.grant.origins.includes(origin)),
    )?.grant.grantId;
  }

  isCurrent(
    grantId: string,
    target: BrowserSessionTarget,
    profile: StoredBrowserProfile,
    origins: ReadonlyArray<string>,
  ): boolean {
    this.#prune();
    const row = this.#grants.get(grantId);
    return (
      row !== undefined &&
      sameTarget(row.grant.target, target) &&
      browserProfileKey(row.grant.profile) === browserProfileKey(profile) &&
      origins.length > 0 &&
      origins.every((origin) => row.grant.origins.includes(origin))
    );
  }

  ownerWindowFor(grantId: string): WindowId | undefined {
    this.#prune();
    const row = this.#grants.get(grantId);
    if (row === undefined) return undefined;
    return [row.windowId, ...(this.#options.localWindows?.() ?? [])].find(
      (windowId) =>
        this.#options.isLocalWindow(windowId) &&
        this.#options.canReview(windowId, row.grant.target),
    );
  }

  forTarget(target: BrowserSessionTarget): ReadonlyArray<BrowserSessionGrant> {
    this.#prune();
    return [...this.#grants.values()]
      .filter((row) => sameTarget(row.grant.target, target))
      .map((row) => row.grant);
  }

  invalidateProfile(profile: StoredBrowserProfile): void {
    for (const row of this.#grants.values())
      if (browserProfileKey(row.grant.profile) === browserProfileKey(profile))
        this.#remove(row, "changed");
    for (const [id, row] of this.#reviews)
      if (browserProfileKey(row.grant.profile) === browserProfileKey(profile))
        this.#reviews.delete(id);
  }

  revokeWindow(windowId: WindowId): void {
    for (const [id, row] of this.#reviews)
      if (String(row.windowId) === String(windowId)) this.#reviews.delete(id);
  }

  close(): void {
    this.#reviews.clear();
    for (const row of this.#grants.values()) this.#remove(row, "revoked");
  }

  #current(row: SavedPermission): boolean {
    if (Date.parse(row.grant.expiresAt) <= this.#options.now()) return false;
    const current = this.#options.current(row.grant.target.grantee);
    return (
      current !== undefined &&
      current.revision === row.revision &&
      sameTarget(current.target, row.grant.target) &&
      (current.notAfter === undefined || current.notAfter > this.#options.now())
    );
  }

  #remove(
    row: SavedPermission,
    kind: "revoked" | "expired" | "changed",
    windowId?: WindowId,
  ): boolean {
    this.#grants.delete(row.grant.grantId);
    clearTimeout(this.#timers.get(row.grant.grantId));
    this.#timers.delete(row.grant.grantId);
    this.#options.onRevoked(row.grant.grantId);
    try {
      this.#options.record({
        kind,
        grant: row.grant,
        ...(windowId === undefined ? {} : { windowId }),
      });
      return true;
    } catch {
      return false;
    }
  }

  #prune(): void {
    for (const [id, review] of this.#reviews)
      if (review.expires <= this.#options.now()) this.#reviews.delete(id);
    for (const row of this.#grants.values())
      if (!this.#current(row))
        this.#remove(
          row,
          Date.parse(row.grant.expiresAt) <= this.#options.now() ? "expired" : "changed",
        );
  }
}
