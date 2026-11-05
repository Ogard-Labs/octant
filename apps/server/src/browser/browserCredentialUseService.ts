import type { WindowId } from "@octant/contracts";
import {
  decodeBrowserCredentialGrant,
  decodeBrowserCredentialHostCommand,
  decodeBrowserCredentialResult,
  type BrowserCredentialCommand,
  type BrowserCredentialGrant,
  type BrowserCredentialJournalRecord,
  type BrowserCredentialMetadata,
  type BrowserCredentialResult,
  type BrowserCredentialTarget,
  type BrowserCredentialFillPreparation,
  type BrowserCredentialHostCommand,
  type BrowserCredentialHostResult,
  type BrowserCredentialNativeResult,
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
  readonly fill?: {
    readonly prepare: (
      windowId: WindowId,
      target: BrowserCredentialTarget,
    ) => Promise<BrowserCredentialFillPreparation>;
    readonly hold: (
      windowId: WindowId,
      target: BrowserCredentialTarget,
      planId: string,
    ) => BrowserCredentialFillLease | BrowserCredentialRefusal;
    readonly host: (command: BrowserCredentialHostCommand) => Promise<BrowserCredentialHostResult>;
    readonly cancel: (
      windowId: WindowId,
      target: BrowserCredentialTarget,
      planId: string,
    ) => Promise<BrowserCredentialNativeResult | undefined>;
    readonly submit: (
      windowId: WindowId,
      target: BrowserCredentialTarget,
      planId: string,
      expiresAt: string,
    ) => Promise<BrowserCredentialNativeResult>;
  };
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
export interface BrowserCredentialFillLease {
  readonly kind: "held";
  readonly signal: AbortSignal;
  readonly current: () => Promise<BrowserCredentialCurrentTarget>;
  readonly release: () => void;
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
  const fillPlans = new Map<
    string,
    {
      readonly windowId: WindowId;
      readonly grant: BrowserCredentialGrant;
      readonly target: BrowserCredentialTarget;
      readonly expires: number;
      readonly abort: AbortController;
      state: "prepared" | "reading" | "filled" | "done";
      operation: "fill" | "submit" | undefined;
    }
  >();

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
    for (const plan of fillPlans.values())
      if (plan.grant.grantId === grant.grantId) plan.abort.abort();
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
  const fillOutcome = (
    planId: string,
    status: "filled" | "authentication-required" | "denied" | "cancelled" | "failed",
    effect: "none" | "possible" | "completed",
    message: string,
  ): BrowserCredentialResult =>
    decodeBrowserCredentialResult({
      kind: "browser-credential-fill-outcome",
      planId,
      status,
      effect,
      message,
    });
  const cancelFill = async (
    windowId: WindowId,
    command: Extract<BrowserCredentialCommand, { readonly planId: unknown }>,
  ): Promise<BrowserCredentialResult> => {
    const plan = fillPlans.get(command.planId);
    if (plan === undefined)
      return fillOutcome(
        command.planId,
        "cancelled",
        "none",
        "This fill plan is no longer pending.",
      );
    if (
      String(plan.windowId) !== String(windowId) ||
      String(plan.target.contextId) !== String(command.contextId) ||
      String(plan.target.threadId) !== String(command.threadId) ||
      plan.target.mode !== command.mode
    )
      return browserCredentialRefusal("unauthorized", "This fill plan belongs to another task.");
    plan.abort.abort();
    const result =
      plan.operation === "submit"
        ? await options.fill?.cancel(windowId, plan.target, command.planId)
        : await options.fill?.host(
            decodeBrowserCredentialHostCommand({
              kind: "cancel-browser-credential-fill",
              contextId: plan.target.contextId,
              owner: { windowId, threadId: plan.target.threadId },
              planId: command.planId,
            }),
          );
    if (plan.state !== "reading") {
      await options.fill?.cancel(windowId, plan.target, command.planId);
      fillPlans.delete(command.planId);
    }
    const effect = result !== undefined && "effect" in result ? result.effect : "none";
    return fillOutcome(
      command.planId,
      "cancelled",
      effect,
      effect === "none"
        ? "The fill was cancelled before a credential effect."
        : "Cancellation cannot undo an effect that may already have started. Check the page before continuing.",
    );
  };
  const prepareFill = async (
    windowId: WindowId,
    command: Extract<
      BrowserCredentialCommand,
      { readonly kind: "prepare-browser-credential-fill" }
    >,
    target: BrowserCredentialTarget,
    signal?: AbortSignal,
  ): Promise<BrowserCredentialResult> => {
    const fill = options.fill;
    if (fill === undefined)
      return browserCredentialRefusal("unsupported", "This host cannot fill Browser credentials.");
    for (const [id, plan] of fillPlans)
      if (plan.expires <= options.now() && plan.state !== "reading") {
        await fill.cancel(plan.windowId, plan.target, id);
        fillPlans.delete(id);
      }
    const grant = grants.get(command.grantId);
    if (
      grant === undefined ||
      !browserCredentialGrantMatches(grant, target, hostSessionId, options.now())
    )
      return stale();
    if (fillPlans.size >= 32)
      return browserCredentialRefusal("limit", "Finish another login form review first.");
    const metadata = await readMetadata(grant.metadata.item);
    const after = await currentTarget(windowId, command, true, signal);
    if (after.kind === "browser-credential-refused") return after;
    if (metadata.status !== "described") return metadataRefusal(metadata.status);
    if (
      !same(metadata.metadata, grant.metadata) ||
      !same(target, after.target) ||
      grants.get(grant.grantId) !== grant
    )
      return stale();
    const prepared = await fill.prepare(windowId, target);
    const final = await currentTarget(windowId, command, true, signal);
    if (prepared.status !== "prepared")
      return browserCredentialRefusal(
        prepared.reason === "authentication-required" ? "unsupported" : prepared.reason,
        "This page needs a manual sign-in or a fresh form review. No credential was read.",
      );
    if (!grant.metadata.websiteOrigins.includes(prepared.submissionOrigin)) {
      await fill.cancel(windowId, target, prepared.planId);
      return browserCredentialRefusal(
        "site-mismatch",
        "The selected item does not list this exact submission site. Sign in manually or correct its saved websites, then review again.",
      );
    }
    if (
      final.kind === "browser-credential-refused" ||
      !same(final.target, target) ||
      grants.get(grant.grantId) !== grant
    ) {
      await fill.cancel(windowId, target, prepared.planId);
      return stale();
    }
    fillPlans.set(prepared.planId, {
      windowId,
      grant,
      target,
      expires: Math.min(
        Date.parse(prepared.expiresAt),
        Date.parse(grant.expiresAt),
        options.now() + 180_000,
      ),
      abort: new AbortController(),
      state: "prepared",
      operation: undefined,
    });
    return decodeBrowserCredentialResult({
      kind: "browser-credential-fill-review",
      planId: prepared.planId,
      usernameLabel: prepared.usernameLabel,
      passwordLabel: prepared.passwordLabel,
      submissionOrigin: prepared.submissionOrigin,
      expiresAt: prepared.expiresAt,
      grantId: grant.grantId,
      metadata: grant.metadata,
      target,
    });
  };
  const useFill = async (
    windowId: WindowId,
    command: Extract<BrowserCredentialCommand, { readonly planId: unknown }>,
    signal?: AbortSignal,
  ): Promise<BrowserCredentialResult> => {
    const plan = fillPlans.get(command.planId);
    const fill = options.fill;
    if (
      fill === undefined ||
      plan === undefined ||
      plan.expires <= options.now() ||
      String(plan.windowId) !== String(windowId) ||
      String(plan.target.contextId) !== String(command.contextId) ||
      String(plan.target.threadId) !== String(command.threadId) ||
      command.mode !== plan.target.mode
    )
      return stale();
    if (
      (command.kind === "confirm-browser-credential-fill" && plan.state !== "prepared") ||
      (command.kind === "submit-browser-credential-fill" && plan.state !== "filled")
    )
      return stale();
    const lease = fill.hold(windowId, plan.target, command.planId);
    if (lease.kind !== "held") return lease;
    plan.state = "reading";
    plan.operation = command.kind === "submit-browser-credential-fill" ? "submit" : "fill";
    const abort = () => plan.abort.abort();
    signal?.addEventListener("abort", abort, { once: true });
    lease.signal.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || lease.signal.aborted) abort();
    const owner = { windowId, threadId: plan.target.threadId };
    const hostCommand = (
      kind: "stage-browser-credential-fill" | "cancel-browser-credential-fill",
      metadata = false,
    ) =>
      decodeBrowserCredentialHostCommand({
        kind,
        contextId: plan.target.contextId,
        owner,
        planId: command.planId,
        ...(metadata
          ? { metadata: plan.grant.metadata, expiresAt: new Date(plan.expires).toISOString() }
          : {}),
      });
    const stopHost = () => {
      if (plan.operation === "submit")
        void fill.cancel(windowId, plan.target, command.planId).catch(() => undefined);
      else void fill.host(hostCommand("cancel-browser-credential-fill")).catch(() => undefined);
    };
    plan.abort.signal.addEventListener("abort", stopHost, { once: true });
    let effectRequested = false;
    let answer: BrowserCredentialHostResult | BrowserCredentialNativeResult = {
      status: "cancelled",
      effect: "none",
    };
    const valid = async () => {
      const current = await lease.current();
      return (
        !plan.abort.signal.aborted &&
        current.kind === "browser-credential-target" &&
        same(current.target, plan.target) &&
        grants.get(plan.grant.grantId) === plan.grant &&
        browserCredentialGrantMatches(plan.grant, current.target, hostSessionId, options.now())
      );
    };
    try {
      if (!(await valid())) return stale();
      const metadata = await readMetadata(plan.grant.metadata.item);
      if (
        metadata.status !== "described" ||
        !same(metadata.metadata, plan.grant.metadata) ||
        !(await valid())
      )
        return stale();
      if (command.kind === "confirm-browser-credential-fill") {
        const staged = await fill.host(hostCommand("stage-browser-credential-fill", true));
        if (staged.status !== "ready") {
          answer = staged;
        } else if (!(await valid())) {
          answer = await fill.host(hostCommand("cancel-browser-credential-fill"));
        } else {
          effectRequested = true;
          answer = await fill.host(
            decodeBrowserCredentialHostCommand({
              kind: "commit-browser-credential-fill",
              contextId: plan.target.contextId,
              owner,
              planId: command.planId,
              custodyId: staged.custodyId,
            }),
          );
        }
      } else {
        effectRequested = true;
        answer = await fill.submit(
          windowId,
          plan.target,
          command.planId,
          new Date(plan.expires).toISOString(),
        );
      }
      const status =
        answer.status === "filled" ||
        answer.status === "authentication-required" ||
        answer.status === "cancelled" ||
        answer.status === "failed"
          ? answer.status
          : "denied";
      const effect = "effect" in answer ? answer.effect : "none";
      plan.state = status === "filled" && effect === "completed" ? "filled" : "done";
      try {
        options.record({
          name: "browser-credential.fill-recorded",
          grantId: plan.grant.grantId,
          planId: command.planId,
          windowId,
          status,
          effect,
        });
      } catch {
        return fillOutcome(
          command.planId,
          "failed",
          effect,
          "The effect receipt could not be recorded. Check the page; no completed effect was undone.",
        );
      }
      return fillOutcome(
        command.planId,
        status,
        effect,
        status === "filled"
          ? "The selected fields were filled. Review the page before submitting. Sign-in is not confirmed."
          : status === "authentication-required"
            ? "Complete sign-in, MFA or CAPTCHA in the page. Octant has not confirmed authentication."
            : effect === "none"
              ? "The requested credential effect did not run. Review the page or sign in manually."
              : "The credential effect may have run. Check the page before continuing; cancellation does not undo it.",
      );
    } catch {
      return fillOutcome(
        command.planId,
        "failed",
        effectRequested ? "possible" : "none",
        "The effect could not be confirmed. Check the page before continuing.",
      );
    } finally {
      plan.abort.signal.removeEventListener("abort", stopHost);
      signal?.removeEventListener("abort", abort);
      lease.signal.removeEventListener("abort", abort);
      if (plan.state !== "filled" || plan.abort.signal.aborted) {
        await fill.host(hostCommand("cancel-browser-credential-fill")).catch(() => undefined);
        await fill.cancel(windowId, plan.target, command.planId).catch(() => undefined);
        fillPlans.delete(command.planId);
      }
      lease.release();
    }
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
      if ("planId" in command)
        return command.kind === "cancel-browser-credential-fill"
          ? cancelFill(windowId, command)
          : useFill(windowId, command, signal);
      const hold =
        command.kind === "review-browser-credential" ||
        command.kind === "allow-browser-credential" ||
        command.kind === "prepare-browser-credential-fill";
      const current = await currentTarget(windowId, command, hold, signal);
      if (current.kind === "browser-credential-refused") return current;
      const target = current.target;
      if (command.kind === "prepare-browser-credential-fill")
        return prepareFill(windowId, command, target, signal);
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
