import {
  decodeTaskAccessSnapshot,
  type ContextSubjectRef,
  type PermissionMode,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderObservedState,
  type TaskAccessSnapshot,
  type WindowId,
} from "@octant/contracts";
import { permissionModeOf, type ThreadAccess } from "@octant/domain/guardrail-policy";
import type { HostShield } from "../shield/hostShield";

export interface TaskAccessSubjectFacts {
  readonly selected: ThreadAccess;
  readonly standing: TaskAccessSnapshot["standing"];
  readonly turnRefusal?: "project-unavailable" | "binding-changed";
  readonly effective?: ThreadAccess;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly default?: { readonly mode: PermissionMode; readonly scope: "project" | "global" };
  readonly outsideContent: boolean;
}

export interface TaskAccessFactsDependencies {
  /** Called only after the existing subject read has authorized this window. */
  readonly subject: (
    subject: ContextSubjectRef,
    windowId: WindowId,
  ) => TaskAccessSubjectFacts | undefined;
  readonly instance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly observed: (id: ProviderInstanceId) => ProviderObservedState | undefined;
  readonly reviewer: HostShield["describe"];
  readonly clock: () => string;
  readonly browser?: (
    subject: ContextSubjectRef,
    windowId: WindowId,
  ) => TaskAccessSnapshot["browser"];
}

/** A fresh read over the same host policy inputs; nothing here persists or executes. */
export function createTaskAccessFacts(deps: TaskAccessFactsDependencies) {
  return (subject: ContextSubjectRef, windowId: WindowId): TaskAccessSnapshot | undefined => {
    const facts = deps.subject(subject, windowId);
    if (facts === undefined) return undefined;
    const instance = deps.instance(facts.providerInstanceId);
    const observed = deps.observed(facts.providerInstanceId);
    const selectedMode = permissionModeOf(facts.selected);
    const rawEffective =
      facts.effective === undefined ? undefined : permissionModeOf(facts.effective);
    // A failed reviewer read is unknown, never a guessed automatic grant.
    let route: ReturnType<HostShield["describe"]>;
    try {
      route =
        facts.effective === undefined ||
        facts.standing !== "active" ||
        facts.turnRefusal !== undefined
          ? undefined
          : deps.reviewer(String(subject.aggregateId), facts.effective);
    } catch {
      route = undefined;
    }
    const resolution = route?.resolution;
    const effective = resolution?.status === "supported" ? resolution : resolution?.fallback;
    const effectiveMode = effective?.mode;
    const reviewerKind =
      effective?.approver === "provider-review"
        ? "provider"
        : effective?.approver === "octant-shield"
          ? "octant-shield"
          : (effective?.approver ?? "unknown");
    const reviewerAccount =
      reviewerKind === "provider" ? facts.providerInstanceId : route?.model?.providerInstanceId;
    const reviewerInstance =
      reviewerAccount === undefined ? undefined : deps.instance(reviewerAccount);
    const reviewerObserved =
      reviewerAccount === undefined ? undefined : deps.observed(reviewerAccount);
    const reviewerUnavailable =
      route?.modelUnavailable === true ||
      reviewerInstance?.enabled === false ||
      reviewerObserved?.readiness === "unavailable" ||
      reviewerObserved?.readiness === "unauthenticated" ||
      reviewerObserved?.readiness === "incompatible";
    const limitations: Array<TaskAccessSnapshot["limitations"][number]> = [];
    if (facts.turnRefusal !== undefined)
      limitations.push({
        kind: "unavailable",
        message:
          facts.turnRefusal === "binding-changed"
            ? "The task's Project binding changed. Review its current Project before starting another turn."
            : "The task's Project is unavailable for another turn. Reconnect or ask the host owner to repair its Project.",
        recovery: "host-owner",
      });
    if (instance === undefined)
      limitations.push({
        kind: "unavailable",
        message:
          "The selected account is no longer configured. Choose an enabled account for this task.",
        recovery: "provider-settings",
      });
    else if (!instance.enabled)
      limitations.push({
        kind: "disabled",
        message: "The selected account is turned off. Turn it on or choose an enabled account.",
        recovery: "provider-settings",
      });
    else if (observed === undefined)
      limitations.push({
        kind: "unknown",
        message: "The host has not reported this runtime's readiness or capabilities.",
        recovery: "provider-settings",
      });
    else if (observed.readiness !== "ready")
      limitations.push({
        kind: "unavailable",
        message:
          observed.readiness === "unauthenticated"
            ? "The selected account needs sign-in. Open its provider settings on the host."
            : "The selected runtime is not ready. Check its provider status on the host.",
        recovery: "provider-settings",
      });
    if (facts.standing !== "active")
      limitations.push({
        kind: "unavailable",
        message:
          facts.standing === "completed"
            ? "This task is marked Done. Reopen it with its existing task controls before starting another turn."
            : "This task is inactive. Restore it with its existing task controls before starting another turn.",
        recovery: "none",
      });
    if (route === undefined && facts.standing === "active" && facts.turnRefusal === undefined)
      limitations.push({
        kind: "unknown",
        message:
          "The host could not report the current reviewer and effective level. This is not permission to run an action.",
        recovery: "none",
      });
    if (resolution?.status === "unsupported")
      limitations.push({
        kind: "needs-approval",
        message: "No automatic reviewer can run for this task, so it asks the person first.",
        recovery: "access-settings",
      });
    if (reviewerKind === "octant-shield" && reviewerUnavailable)
      limitations.push({
        kind: "needs-approval",
        message:
          "The configured reviewer account is unavailable. Its decisions go to the person; another account is not substituted.",
        recovery: "provider-settings",
      });
    if (effective?.readOnly)
      limitations.push({
        kind: "read-only",
        message: "Plan is read-only. Commands and file changes are not available in this turn.",
        recovery: "none",
      });
    const ceiling =
      rawEffective !== undefined &&
      rawEffective !== selectedMode &&
      (rawEffective === "plan" || rawEffective === "ask-first" || selectedMode === "full-access")
        ? rawEffective
        : undefined;
    if (ceiling !== undefined)
      limitations.push({
        kind: "limited",
        message:
          "The current turn or window session holds a narrower level than the task's selected level.",
        recovery: "none",
      });
    return decodeTaskAccessSnapshot({
      kind: "task-access",
      ...(deps.browser === undefined ? {} : { browser: deps.browser(subject, windowId) }),
      subject,
      observedAt: deps.clock(),
      selectedMode,
      standing: facts.standing,
      ...(effectiveMode === undefined ? {} : { effectiveMode }),
      effectiveContext:
        rawEffective === undefined
          ? "unknown"
          : rawEffective === selectedMode
            ? "thread"
            : "running-turn-or-session",
      ...(ceiling === undefined ? {} : { ceiling }),
      default:
        facts.default === undefined
          ? { status: "unknown" }
          : {
              status: "known",
              ...facts.default,
              matchesSelected: facts.default.mode === selectedMode,
            },
      reviewer: {
        kind: reviewerKind,
        ...(reviewerAccount === undefined ? {} : { accountId: reviewerAccount }),
        ...(reviewerInstance === undefined
          ? {}
          : { accountName: reviewerInstance.displayName.slice(0, 256).trim() }),
        ...(route?.model === undefined ? {} : { modelId: route.model.modelId }),
        availability:
          reviewerKind === "person" || reviewerKind === "none"
            ? "not-applicable"
            : reviewerUnavailable
              ? "unavailable"
              : reviewerObserved?.readiness === "ready"
                ? "available"
                : "unknown",
      },
      runtime: {
        accountId: facts.providerInstanceId,
        modelId: facts.modelId,
        ...(instance === undefined
          ? {}
          : { accountName: instance.displayName.slice(0, 256).trim(), enabled: instance.enabled }),
        ...(observed === undefined
          ? {}
          : { readiness: observed.readiness, observedAt: observed.observedAt }),
        capabilities:
          observed === undefined
            ? []
            : (
                [
                  "approvals",
                  "appManagedTools",
                  "nativeWebResearch",
                  "nativeChildAgents",
                  "forceStop",
                ] as const
              ).flatMap((id) => {
                const support = observed.capabilities[id];
                return support === undefined ? [] : [{ id, support }];
              }),
      },
      outsideContent: {
        read: facts.outsideContent,
        effect: effective?.outsideContent ?? "unknown",
      },
      limitations,
    });
  };
}
