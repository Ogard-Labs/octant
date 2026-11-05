import type { WindowId } from "@octant/contracts";
import {
  decodeBrowserCredentialGrant,
  decodeBrowserCredentialResult,
  type BrowserCredentialCommand,
  type BrowserCredentialGrant,
  type BrowserCredentialJournalRecord,
  type BrowserCredentialMetadata,
  type BrowserCredentialResult,
  type BrowserCredentialTarget,
} from "@octant/contracts/browser-credential-use";
import {
  BROWSER_CREDENTIAL_GRANT_MAX_MS,
  browserCredentialGrantMatches,
  browserProfileKey,
} from "@octant/domain";
import type { BrowserMetadataAnswer } from "../secretStores/secretStoreBrokerClient";

export type BrowserCredentialRefusal = Extract<
  BrowserCredentialResult,
  { readonly kind: "browser-credential-refused" }
>;
export type BrowserCredentialCurrentTarget =
  | { readonly kind: "browser-credential-target"; readonly target: BrowserCredentialTarget }
  | BrowserCredentialRefusal;

export interface BrowserCredentialUseOptions {
  readonly currentTarget: (
    windowId: WindowId,
    command: BrowserCredentialCommand,
    holdRequired: boolean,
  ) => Promise<BrowserCredentialCurrentTarget>;
  readonly metadata: (item: BrowserCredentialMetadata["item"]) => Promise<BrowserMetadataAnswer>;
  readonly record: (record: BrowserCredentialJournalRecord) => void;
  readonly now: () => number;
  readonly uuid: () => string;
}
export function browserCredentialRefusal(
  reason: BrowserCredentialRefusal["reason"],
  message: string,
): BrowserCredentialRefusal {
  return { kind: "browser-credential-refused", reason, message };
}
export function createBrowserCredentialUseService(options: BrowserCredentialUseOptions) {
  const hostSessionId = options.uuid();
  const grants = new Map<string, BrowserCredentialGrant>();
  const reviews = new Map<
    string,
    {
      readonly windowId: WindowId;
      readonly target: BrowserCredentialTarget;
      readonly metadata: BrowserCredentialMetadata;
      readonly expires: number;
    }
  >();
  const currentTarget = async (
    windowId: WindowId,
    command: BrowserCredentialCommand,
    hold: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserCredentialCurrentTarget> => {
    if (signal?.aborted)
      return browserCredentialRefusal("cancelled", "The login permission request was cancelled.");
    const result = await options.currentTarget(windowId, command, hold);
    return signal?.aborted
      ? browserCredentialRefusal("cancelled", "The login permission request was cancelled.")
      : result;
  };
  const same = (left: object, right: object) => JSON.stringify(left) === JSON.stringify(right);
  const stale = () =>
    browserCredentialRefusal(
      "stale",
      "The selected item or Browser page changed. Review it again.",
    );
  const readMetadata = async (item: BrowserCredentialMetadata["item"]) => {
    try {
      return await options.metadata(item);
    } catch {
      return { status: "unavailable" as const };
    }
  };
  const metadataRefusal = (
    status: Exclude<BrowserMetadataAnswer, { readonly status: "described" }>["status"],
  ) =>
    status === "changed"
      ? stale()
      : browserCredentialRefusal(
          status,
          status === "locked"
            ? "Unlock the selected 1Password account, then review the item again."
            : status === "not-linked"
              ? "Link the secret store in Settings before reviewing this item."
              : "The selected item's website metadata could not be verified. Nothing was allowed.",
        );
  const remove = (
    windowId: WindowId | undefined,
    grant: BrowserCredentialGrant,
    reason: "revoked" | "expired" | "changed",
  ): boolean => {
    grants.delete(grant.grantId);
    try {
      options.record({
        name: "browser-credential.revoked",
        grantId: grant.grantId,
        reason,
        ...(windowId === undefined ? {} : { windowId }),
      });
      return true;
    } catch {
      return false;
    }
  };
  const list = async (
    windowId: WindowId,
    command: BrowserCredentialCommand,
    target: BrowserCredentialTarget,
    signal?: AbortSignal,
  ): Promise<BrowserCredentialResult> => {
    const active: BrowserCredentialGrant[] = [];
    for (const grant of grants.values()) {
      if (Date.parse(grant.expiresAt) <= options.now()) {
        remove(windowId, grant, "expired");
        continue;
      }
      if (!browserCredentialGrantMatches(grant, target, hostSessionId, options.now())) {
        if (String(grant.target.contextId) === String(target.contextId))
          remove(windowId, grant, "changed");
        continue;
      }
      const answer = await readMetadata(grant.metadata.item);
      const current = await currentTarget(windowId, command, false, signal);
      if (current.kind === "browser-credential-refused") return current;
      if (!same(current.target, target)) return stale();
      if (answer.status !== "described") {
        if (
          answer.status === "not-linked" ||
          answer.status === "missing" ||
          answer.status === "changed"
        )
          remove(windowId, grant, "changed");
        return metadataRefusal(answer.status);
      }
      if (!same(answer.metadata, grant.metadata)) {
        remove(windowId, grant, "changed");
        continue;
      }
      if (
        grants.get(grant.grantId) === grant &&
        browserCredentialGrantMatches(grant, target, hostSessionId, options.now())
      )
        active.push(grant);
    }
    return { kind: "browser-credential-grants", grants: active };
  };
  return {
    invalidateProfile: (profile: BrowserCredentialTarget["profile"]): boolean => {
      let recorded = true;
      for (const grant of grants.values())
        if (browserProfileKey(grant.target.profile) === browserProfileKey(profile))
          recorded = remove(undefined, grant, "changed") && recorded;
      for (const [id, review] of reviews)
        if (browserProfileKey(review.target.profile) === browserProfileKey(profile))
          reviews.delete(id);
      return recorded;
    },
    execute: async (
      windowId: WindowId,
      command: BrowserCredentialCommand,
      signal?: AbortSignal,
    ): Promise<BrowserCredentialResult> => {
      const hold =
        command.kind === "review-browser-credential" || command.kind === "allow-browser-credential";
      const current = await currentTarget(windowId, command, hold, signal);
      if (current.kind === "browser-credential-refused") return current;
      const target = current.target;
      if (command.kind === "list-browser-credential-grants")
        return list(windowId, command, target, signal);
      if (command.kind === "revoke-browser-credential") {
        const grant = grants.get(command.grantId);
        if (grant !== undefined) {
          if (
            String(grant.scope.projectId) !== String(target.projectId) ||
            grant.target.mode !== target.mode
          )
            return browserCredentialRefusal(
              "unauthorized",
              "This Project cannot revoke that permission.",
            );
          if (!remove(windowId, grant, "revoked"))
            return browserCredentialRefusal(
              "journal-unavailable",
              "The permission was removed, but its revocation could not be recorded.",
            );
        }
        return list(windowId, command, target, signal);
      }
      for (const [key, review] of reviews) if (review.expires <= options.now()) reviews.delete(key);
      if (command.kind === "review-browser-credential") {
        if (reviews.size >= 32)
          return browserCredentialRefusal("limit", "Finish or cancel another item review first.");
        const answer = await readMetadata(command.item);
        const after = await currentTarget(windowId, command, true, signal);
        if (after.kind === "browser-credential-refused") return after;
        if (!same(after.target, target)) return stale();
        if (answer.status !== "described") return metadataRefusal(answer.status);
        if (!answer.metadata.websiteOrigins.includes(target.topOrigin))
          return browserCredentialRefusal(
            "site-mismatch",
            "This exact HTTPS site and port are not saved on the selected item.",
          );
        if (reviews.size >= 32)
          return browserCredentialRefusal("limit", "Finish another item review first.");
        const reviewId = options.uuid();
        const expires = options.now() + 3 * 60 * 1000;
        reviews.set(reviewId, { windowId, target, metadata: answer.metadata, expires });
        return decodeBrowserCredentialResult({
          kind: "browser-credential-review",
          reviewId,
          target,
          metadata: answer.metadata,
          expiresAt: new Date(expires).toISOString(),
        });
      }
      const review = reviews.get(command.reviewId);
      if (review === undefined || review.expires <= options.now())
        return browserCredentialRefusal("expired", "The item review expired. Review it again.");
      if (String(review.windowId) !== String(windowId) || !same(review.target, target))
        return stale();
      if (target.profile.kind === "private" && command.scope !== "task")
        return browserCredentialRefusal(
          "unsupported",
          "A Private page permits only this task and context.",
        );
      if (grants.size >= 64)
        return browserCredentialRefusal("limit", "Revoke an existing login permission first.");
      const answer = await readMetadata(review.metadata.item);
      const after = await currentTarget(windowId, command, true, signal);
      if (after.kind === "browser-credential-refused") return after;
      if (
        !same(after.target, target) ||
        !same(review.target, target) ||
        reviews.get(command.reviewId) !== review
      )
        return stale();
      if (answer.status !== "described") return metadataRefusal(answer.status);
      if (review.expires <= options.now() || !same(answer.metadata, review.metadata))
        return stale();
      if (grants.size >= 64)
        return browserCredentialRefusal("limit", "Revoke an existing login permission first.");
      const now = options.now();
      const grant = decodeBrowserCredentialGrant({
        kind: "browser-credential-grant",
        grantId: options.uuid(),
        hostSessionId,
        metadata: answer.metadata,
        target,
        scope:
          command.scope === "project"
            ? { kind: "project", projectId: target.projectId }
            : {
                kind: "task",
                projectId: target.projectId,
                threadId: target.threadId,
                contextId: target.contextId,
              },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + BROWSER_CREDENTIAL_GRANT_MAX_MS).toISOString(),
      });
      try {
        options.record({ name: "browser-credential.granted", grant, windowId });
      } catch {
        return browserCredentialRefusal(
          "journal-unavailable",
          "The permission could not be recorded, so nothing was allowed.",
        );
      }
      reviews.delete(command.reviewId);
      // The dialog replaces its list with this answer, so returning only the new
      // grant hid earlier permissions (and their revoke controls) that stay active.
      // Earlier grants were checked by the last permission read; the next read
      // revalidates every one of them against the broker again.
      const earlier = [...grants.values()].filter((existing) =>
        browserCredentialGrantMatches(existing, target, hostSessionId, now),
      );
      grants.set(grant.grantId, grant);
      return { kind: "browser-credential-grants", grants: [grant, ...earlier] };
    },
  };
}
export type BrowserCredentialUseService = ReturnType<typeof createBrowserCredentialUseService>;
