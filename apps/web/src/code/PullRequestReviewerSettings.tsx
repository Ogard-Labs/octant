import type { PullRequestReviewClient } from "@octant/client-runtime/pull-request-review-client";
import type {
  CodeThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderRegistrySnapshot,
  PullRequestReviewEffectiveConfig,
  PullRequestReviewProjectView,
  PullRequestReviewPullRequestView,
  PullRequestReviewRoute,
  PullRequestReviewRunRecord,
  PullRequestReviewTarget,
  PullRequestReviewThreadOverrideMode,
  PullRequestReviewThreadView,
  PullRequestReviewTurnRefusalReason,
} from "@octant/contracts";
import {
  rankPullRequestReviewerRoutes,
  type PullRequestReviewerRouteCandidate,
} from "@octant/domain/pull-request-review-policy";
import { useEffect, useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import "./pull-request-reviewer.css";

const NO_ROUTE_OPTION = "none";
const INHERIT_ROUTE_OPTION = "inherit";
const EFFORT_DEFAULT = "default";

const EFFORT_OPTIONS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: EFFORT_DEFAULT, label: "Provider default" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

const THREAD_MODE_OPTIONS: ReadonlyArray<{
  readonly id: PullRequestReviewThreadOverrideMode;
  readonly label: string;
}> = [
  { id: "inherit", label: "Follow Project setting" },
  { id: "enabled", label: "On for this thread" },
  { id: "disabled", label: "Off for this thread" },
];

function routeKey(route: Pick<PullRequestReviewRoute, "providerInstanceId" | "modelId">): string {
  return `${String(route.providerInstanceId)}/${String(route.modelId)}`;
}

export function reviewerRouteOptions(input: {
  readonly snapshot: ProviderRegistrySnapshot | undefined;
  readonly current: PullRequestReviewRoute | undefined;
  readonly workerProviderInstanceId?: ProviderInstanceId | undefined;
  readonly emptyOption: { readonly id: string; readonly label: string };
}): ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly route?: Pick<PullRequestReviewRoute, "providerInstanceId" | "modelId">;
}> {
  const candidates: PullRequestReviewerRouteCandidate[] = [];
  for (const instance of input.snapshot?.instances ?? []) {
    if (!instance.enabled) continue;
    const catalog = input.snapshot?.catalogs?.find(
      (entry) => String(entry.instanceId) === String(instance.id),
    );
    const apiKey =
      input.snapshot?.observedStates.find(
        (state) => String(state.instanceId) === String(instance.id),
      )?.accountAuthentication === "api-key";
    for (const model of catalog?.models ?? []) {
      candidates.push({
        providerInstanceId: instance.id,
        providerDisplayName: instance.displayName,
        modelId: model.id,
        modelDisplayName: model.displayName,
        apiKey,
      });
    }
  }
  const ranked = rankPullRequestReviewerRoutes({
    candidates,
    ...(input.workerProviderInstanceId === undefined
      ? {}
      : { workerProviderInstanceId: input.workerProviderInstanceId }),
  });

  const options: Array<{
    readonly id: string;
    readonly label: string;
    readonly route?: Pick<PullRequestReviewRoute, "providerInstanceId" | "modelId">;
  }> = [{ id: input.emptyOption.id, label: input.emptyOption.label }];

  for (const item of ranked) {
    const id = routeKey(item);
    const suffix = item.suggested ? " (Suggested · different provider)" : "";
    const auth = item.apiKey ? " (API key)" : "";
    options.push({
      id,
      label: `${item.providerDisplayName}${auth} · ${item.modelDisplayName}${suffix}`,
      route: { providerInstanceId: item.providerInstanceId, modelId: item.modelId },
    });
  }

  const current = input.current;
  if (current !== undefined && !options.some((option) => option.id === routeKey(current))) {
    options.push({
      id: routeKey(current),
      label: String(current.modelId),
      route: {
        providerInstanceId: current.providerInstanceId,
        modelId: current.modelId,
      },
    });
  }

  return options;
}

const REFUSAL_HEADLINES: Readonly<Record<PullRequestReviewTurnRefusalReason, string>> = {
  "no-route-configured": "No reviewer model configured",
  "no-account": "Reviewer account unavailable",
  "route-refused": "Reviewer route refused",
  capacity: "Reviewer capacity reached",
  "spend-ceiling": "Thread spend ceiling reached",
  "head-stale": "PR head moved before review finished",
  "not-effective": "Reviewer plugin disabled or untrusted",
  unsupported: "Reviewer unavailable on this host",
};

export interface PullRequestReviewStatusBannerProps {
  readonly latestReview?: PullRequestReviewRunRecord | undefined;
  readonly effective?: PullRequestReviewEffectiveConfig | undefined;
}

/**
 * Surfaces stale, refused, or unavailable pull request review state in the
 * Review pane and pull request review surface without hiding why nothing ran.
 */
export function PullRequestReviewStatusBanner(props: PullRequestReviewStatusBannerProps) {
  const { latestReview, effective } = props;

  if (latestReview?.status === "stale") {
    return (
      <OctantAlert className="pr-reviewer-banner" tone="warning">
        <div className="pr-reviewer-finding__badges">
          <OctantBadge variant="warning">Stale review</OctantBadge>
          <strong>PR head moved while the review was running</strong>
        </div>
        <p className="pr-reviewer-settings__hint">
          Reviewed head <code>{latestReview.headSha.slice(0, 7)}</code>
          {latestReview.currentHeadSha === undefined
            ? " is no longer current."
            : ` moved to ${latestReview.currentHeadSha.slice(0, 7)}.`}{" "}
          Stale results are never shown as current, posted to GitHub, or sent to the worker.
        </p>
      </OctantAlert>
    );
  }

  if (latestReview?.status === "refused") {
    const headline =
      latestReview.reason === undefined
        ? "Pull request reviewer unavailable"
        : REFUSAL_HEADLINES[latestReview.reason];
    return (
      <OctantAlert className="pr-reviewer-banner" tone="warning">
        <div className="pr-reviewer-finding__badges">
          <OctantBadge variant="warning">Reviewer unavailable</OctantBadge>
          <strong>{headline}</strong>
        </div>
        <p className="pr-reviewer-settings__hint">
          {latestReview.detail ??
            "The configured reviewer could not run. Octant never falls back silently to another model."}
        </p>
      </OctantAlert>
    );
  }

  if (latestReview?.status === "failed") {
    return (
      <OctantAlert className="pr-reviewer-banner" tone="warning">
        <div className="pr-reviewer-finding__badges">
          <OctantBadge variant="destructive">Review failed</OctantBadge>
          <strong>Pull request review did not complete</strong>
        </div>
        <p className="pr-reviewer-settings__hint">
          {latestReview.detail ?? "The reviewer failed before completing this head commit."}
        </p>
      </OctantAlert>
    );
  }

  if (effective?.unavailableReason !== undefined) {
    return (
      <OctantAlert className="pr-reviewer-banner" tone="warning">
        <div className="pr-reviewer-finding__badges">
          <OctantBadge variant="warning">Reviewer unavailable</OctantBadge>
          <strong>{REFUSAL_HEADLINES[effective.unavailableReason]}</strong>
        </div>
        <p className="pr-reviewer-settings__hint">
          {effective.unavailableDetail ??
            "Pick an available reviewer route before pull request reviews can run."}
        </p>
      </OctantAlert>
    );
  }

  return null;
}

export interface ProjectPullRequestReviewerSectionProps {
  readonly client: PullRequestReviewClient;
  readonly projectId: ProjectId;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly workerProviderInstanceId?: ProviderInstanceId | undefined;
  readonly disabled?: boolean;
}

/**
 * Code Project settings for the bundled second-model pull request reviewer:
 * off by default, requires an explicit model (no default model), suggests a
 * different provider from the worker, and keeps PR comment posting opt-in.
 */
export function ProjectPullRequestReviewerSection(props: ProjectPullRequestReviewerSectionProps) {
  const [view, setView] = useState<PullRequestReviewProjectView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const enabledDescId = useId();
  const commentDescId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void props.client
      .queryProject(props.projectId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setView(next);
          setError(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Pull request reviewer settings are unavailable.",
          );
        }
      });
    return () => controller.abort();
  }, [props.client, props.projectId]);

  const settings = view?.settings;
  const currentRoute = settings?.route;
  const routeOptions = reviewerRouteOptions({
    snapshot: props.providerSnapshot,
    current: currentRoute,
    ...(props.workerProviderInstanceId === undefined
      ? {}
      : { workerProviderInstanceId: props.workerProviderInstanceId }),
    emptyOption: { id: NO_ROUTE_OPTION, label: "Off — pick a reviewer model" },
  });

  const save = async (next: {
    readonly enabled: boolean;
    readonly route: PullRequestReviewRoute | null;
    readonly postSummaryComment: boolean;
  }) => {
    setPending(true);
    setError(undefined);
    try {
      const updated = await props.client.updateProject({
        projectId: props.projectId,
        enabled: next.enabled,
        ...(settings?.reviewerId === undefined ? {} : { reviewerId: settings.reviewerId }),
        route: next.route,
        postSummaryComment: next.postSummaryComment,
      });
      setView(updated);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Pull request reviewer settings could not be saved.",
      );
    } finally {
      setPending(false);
    }
  };

  const disabled = props.disabled === true || pending || settings === undefined;
  const hasRoute = currentRoute !== undefined;

  return (
    <div className="pr-reviewer-settings">
      <div className="pr-reviewer-settings__row">
        <div className="pr-reviewer-settings__label">
          <strong>Review pushed PR heads</strong>
          <p className="pr-reviewer-settings__hint" id={enabledDescId}>
            Off by default. Runs once per pushed PR head at Plan&apos;s read-only gate after the
            worker turn settles. Pick a model below before turning on.
          </p>
        </div>
        <OctantSwitch
          checked={settings?.enabled === true}
          describedBy={enabledDescId}
          disabled={disabled || (!hasRoute && settings?.enabled !== true)}
          {...(!hasRoute && settings?.enabled !== true
            ? { disabledReason: "Pick a reviewer model first." }
            : {})}
          label="Review pushed PR heads"
          onCheckedChange={(checked) => {
            if (settings === undefined) return;
            void save({
              enabled: checked,
              route: settings.route ?? null,
              postSummaryComment: settings.postSummaryComment,
            });
          }}
        />
      </div>

      <label className="pr-reviewer-settings__field">
        <span className="pr-reviewer-settings__field-label">Reviewer provider and model</span>
        <OctantSelectField
          aria-label="Reviewer provider and model"
          className="pr-reviewer-settings__select window-no-drag"
          disabled={disabled}
          onValueChange={(value) => {
            if (settings === undefined) return;
            const chosen = routeOptions.find((option) => option.id === value);
            if (chosen === undefined) return;
            if (chosen.route === undefined) {
              void save({
                enabled: false,
                route: null,
                postSummaryComment: settings.postSummaryComment,
              });
              return;
            }
            const nextRoute: PullRequestReviewRoute = {
              providerInstanceId: chosen.route.providerInstanceId,
              modelId: chosen.route.modelId,
              ...(currentRoute?.effort === undefined ? {} : { effort: currentRoute.effort }),
            };
            void save({
              enabled: settings.enabled,
              route: nextRoute,
              postSummaryComment: settings.postSummaryComment,
            });
          }}
          options={routeOptions.map(({ id, label }) => ({ id, label }))}
          value={currentRoute === undefined ? NO_ROUTE_OPTION : routeKey(currentRoute)}
        />
      </label>

      {currentRoute === undefined ? null : (
        <label className="pr-reviewer-settings__field">
          <span className="pr-reviewer-settings__field-label">Reviewer effort</span>
          <OctantSelectField
            aria-label="Reviewer effort"
            className="pr-reviewer-settings__select window-no-drag"
            disabled={disabled}
            onValueChange={(value) => {
              if (settings === undefined || currentRoute === undefined) return;
              const nextRoute: PullRequestReviewRoute = {
                providerInstanceId: currentRoute.providerInstanceId,
                modelId: currentRoute.modelId,
                ...(value === EFFORT_DEFAULT ? {} : { effort: value }),
              };
              void save({
                enabled: settings.enabled,
                route: nextRoute,
                postSummaryComment: settings.postSummaryComment,
              });
            }}
            options={EFFORT_OPTIONS}
            value={currentRoute.effort ?? EFFORT_DEFAULT}
          />
        </label>
      )}

      <div className="pr-reviewer-settings__row">
        <div className="pr-reviewer-settings__label">
          <strong>Post findings as a PR comment</strong>
          <p className="pr-reviewer-settings__hint" id={commentDescId}>
            Off by default. Posts at most one informational summary comment per reviewed head using
            your GitHub sign-in. Never approves or requests changes.
          </p>
        </div>
        <OctantSwitch
          checked={settings?.postSummaryComment === true}
          describedBy={commentDescId}
          disabled={disabled}
          label="Post findings as a PR comment"
          onCheckedChange={(checked) => {
            if (settings === undefined) return;
            void save({
              enabled: settings.enabled,
              route: settings.route ?? null,
              postSummaryComment: checked,
            });
          }}
        />
      </div>

      {error === undefined ? null : (
        <OctantAlert layout="row" tone="warning">
          {error}
        </OctantAlert>
      )}
    </div>
  );
}

export interface ThreadPullRequestReviewerSectionProps {
  readonly client: PullRequestReviewClient;
  readonly threadId: CodeThreadId;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly workerProviderInstanceId?: ProviderInstanceId | undefined;
  readonly disabled?: boolean;
}

/** Per-thread pull request review override shown in Code thread Environment. */
export function ThreadPullRequestReviewerSection(props: ThreadPullRequestReviewerSectionProps) {
  const [view, setView] = useState<PullRequestReviewThreadView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void props.client
      .queryThread(props.threadId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setView(next);
          setError(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Thread pull request review settings are unavailable.",
          );
        }
      });
    return () => controller.abort();
  }, [props.client, props.threadId]);

  const override = view?.override;
  const routeOptions = reviewerRouteOptions({
    snapshot: props.providerSnapshot,
    current: override?.route,
    ...(props.workerProviderInstanceId === undefined
      ? {}
      : { workerProviderInstanceId: props.workerProviderInstanceId }),
    emptyOption: { id: INHERIT_ROUTE_OPTION, label: "Follow Project model" },
  });

  const save = async (next: {
    readonly mode: PullRequestReviewThreadOverrideMode;
    readonly route: PullRequestReviewRoute | null;
  }) => {
    setPending(true);
    setError(undefined);
    try {
      const updated = await props.client.updateThread({
        threadId: props.threadId,
        mode: next.mode,
        route: next.route,
      });
      setView(updated);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Thread pull request review override could not be saved.",
      );
    } finally {
      setPending(false);
    }
  };

  const disabled = props.disabled === true || pending || override === undefined;

  return (
    <div className="pr-reviewer-settings">
      <label className="pr-reviewer-settings__field">
        <span className="pr-reviewer-settings__field-label">Thread override</span>
        <OctantSelectField
          aria-label="Pull request review override for this thread"
          className="pr-reviewer-settings__select window-no-drag"
          disabled={disabled}
          onValueChange={(value) => {
            if (
              override === undefined ||
              (value !== "inherit" && value !== "enabled" && value !== "disabled")
            ) {
              return;
            }
            void save({ mode: value, route: override.route ?? null });
          }}
          options={THREAD_MODE_OPTIONS}
          value={override?.mode ?? "inherit"}
        />
      </label>

      <label className="pr-reviewer-settings__field">
        <span className="pr-reviewer-settings__field-label">Thread reviewer model</span>
        <OctantSelectField
          aria-label="Reviewer model override for this thread"
          className="pr-reviewer-settings__select window-no-drag"
          disabled={disabled}
          onValueChange={(value) => {
            if (override === undefined) return;
            const chosen = routeOptions.find((option) => option.id === value);
            if (chosen === undefined) return;
            void save({
              mode: override.mode,
              route:
                chosen.route === undefined
                  ? null
                  : {
                      providerInstanceId: chosen.route.providerInstanceId,
                      modelId: chosen.route.modelId,
                    },
            });
          }}
          options={routeOptions.map(({ id, label }) => ({ id, label }))}
          value={override?.route === undefined ? INHERIT_ROUTE_OPTION : routeKey(override.route)}
        />
      </label>

      <PullRequestReviewStatusBanner
        effective={view?.effective}
        latestReview={view?.latestReview}
      />

      {error === undefined ? null : (
        <OctantAlert layout="row" tone="warning">
          {error}
        </OctantAlert>
      )}
    </div>
  );
}

export interface PullRequestHandBackSwitchProps {
  readonly client: PullRequestReviewClient;
  readonly target: PullRequestReviewTarget;
  readonly threadId?: CodeThreadId | undefined;
  readonly disabled?: boolean;
}

/**
 * Per-PR opt-in switch (`Send blocking findings to the worker`), off by
 * default, paired with the PR's latest reviewer status banner.
 */
export function PullRequestHandBackSwitch(props: PullRequestHandBackSwitchProps) {
  const [view, setView] = useState<PullRequestReviewPullRequestView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const statusId = useId();
  const targetKey = `${String(props.target.projectId)}:${String(props.target.repositoryOwner)}/${String(props.target.repositoryName)}#${props.target.number}`;

  useEffect(() => {
    const controller = new AbortController();
    void props.client
      .queryPullRequest(
        {
          target: props.target,
          ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
        },
        controller.signal,
      )
      .then((next) => {
        if (!controller.signal.aborted) {
          setView(next);
          setError(undefined);
        }
      })
      .catch(() => {
        // Leave unset when the host cannot resolve the PR review state.
      });
    return () => controller.abort();
  }, [props.client, targetKey, props.threadId]);

  const checked = view?.settings.sendBlockingFindingsToWorker === true;
  const disabled = props.disabled === true || pending || view === undefined;

  return (
    <div className="pr-reviewer-settings">
      <div className="code-pr-review__switch">
        <div className="code-pr-review__switch-text">
          <strong>Send blocking findings to the worker</strong>
          <p id={statusId} role="status">
            {checked
              ? "On. Blocking second-model review findings wake the linked thread through Auto-fix's outside-content path (capped at 3 tries under Strict)."
              : "Off. Blocking review findings stay in Review until you send a correction request yourself."}
          </p>
        </div>
        <OctantSwitch
          checked={checked}
          describedBy={statusId}
          disabled={disabled}
          label="Send blocking findings to the worker"
          onCheckedChange={(enabled) => {
            setPending(true);
            setError(undefined);
            void props.client
              .updatePullRequest({
                target: props.target,
                sendBlockingFindingsToWorker: enabled,
              })
              .then((updated) => setView(updated))
              .catch((caught: unknown) => {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Send blocking findings setting could not be saved.",
                );
              })
              .finally(() => setPending(false));
          }}
        />
      </div>

      <PullRequestReviewStatusBanner
        effective={view?.effective}
        latestReview={view?.latestReview}
      />

      {error === undefined ? null : (
        <OctantAlert layout="row" tone="warning">
          {error}
        </OctantAlert>
      )}
    </div>
  );
}
