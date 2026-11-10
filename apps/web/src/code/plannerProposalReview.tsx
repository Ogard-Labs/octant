import type { CodePlannerView, ProjectId } from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { defaultPermissionModeFor } from "@octant/domain/guardrail-policy";
import { isDraftSelectionSelectable } from "@octant/domain";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantDialog } from "../ui/base/OctantDialog";
import { NewTaskDraftScopeContext } from "../composer/useNewTaskPrompt";
import type { CodeOverviewProps } from "./CodeOverview";
import { CodeComposerAdapter } from "./composer/CodeComposerAdapter";
import { useWorktreeRemoteFacts } from "./composer/useWorktreeRemoteFacts";
import { plannerReply, type PlannerProposalReview } from "./plannerProposalCreation";
import { readPlannerAttempt, settlePlannerAttempt } from "./plannerProposalAttempt";

/** The Project-scoped props a planner review needs, as the Project overview receives them. */
export type PlannerReviewProps = Extract<CodeOverviewProps, { readonly projectId: ProjectId }>;

/**
 * One Project's planner state as a window holds it: the last host read, kept
 * current by a poll, and the guard that lets one decision run at a time. The
 * Project overview's planner section and a coordinator thread's proposal
 * cards share it, so both keep the same stale, disconnected, and
 * uncertain-outcome rules.
 */
export interface PlannerState {
  readonly supported: boolean;
  readonly ready: boolean;
  readonly view: CodePlannerView | undefined;
  /** A view read from this host that no failure or reconnect has made stale. */
  readonly current: boolean;
  readonly failure: string | undefined;
  readonly busy: boolean;
  readonly notice: string | undefined;
  readonly refresh: () => void;
  /** Sends one designation or decline through the versioned planner routes. */
  readonly mutate: (
    action: () => Promise<{ readonly status: string; readonly message?: string }>,
  ) => Promise<void>;
  /**
   * Runs one approval alone, then re-reads the host's planner state. Refuses
   * while another decision is in flight.
   */
  readonly exclusive: <T>(
    run: () => Promise<T>,
  ) => Promise<{ readonly status: "ran"; readonly value: T } | { readonly status: "refused" }>;
}

export function usePlannerState(props: {
  readonly controller: PlannerReviewProps["controller"];
  readonly projectId: ProjectId;
}): PlannerState {
  const { client } = props.controller;
  const ready = props.controller.status === "ready";
  const [state, setState] = useState<{
    readonly projectId: ProjectId;
    readonly client: typeof client;
    readonly view?: CodePlannerView;
    readonly failure?: string;
  }>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<string>();
  const view =
    state?.client === client && String(state.projectId) === String(props.projectId)
      ? state.view
      : undefined;
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    if (!ready) {
      setState((previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              failure: "Reconnect and refresh planner state before making a decision.",
            },
      );
      return;
    }
    if (client.readPlanner === undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const pending = client.readPlanner?.(props.projectId);
        const next = pending === undefined ? undefined : await plannerReply(pending);
        if (!disposed && next !== undefined)
          for (const entry of next.proposals) settlePlannerAttempt(entry);
        if (!disposed)
          setState({
            projectId: props.projectId,
            client,
            ...(next === undefined ? {} : { view: next }),
          });
      } catch (error) {
        if (!disposed)
          setState((previous) => ({
            projectId: props.projectId,
            client,
            ...(previous?.client === client &&
            String(previous.projectId) === String(props.projectId) &&
            previous.view !== undefined
              ? { view: previous.view }
              : {}),
            failure:
              error instanceof Error
                ? error.message
                : "Planner state is unavailable. Refresh before making a decision.",
          }));
      }
      if (!disposed) timer = setTimeout(() => void read(), 5_000);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [client, props.projectId, ready, revision]);

  const markChecking = () =>
    setState((previous) =>
      previous === undefined
        ? previous
        : { ...previous, failure: "Checking current planner state…" },
    );

  return {
    supported: client.readPlanner !== undefined,
    ready,
    view,
    current: ready && view !== undefined && state?.failure === undefined,
    failure: state?.failure,
    busy,
    notice,
    refresh,
    mutate: async (action) => {
      if (!(ready && view !== undefined && state?.failure === undefined) || inFlight.current)
        return;
      inFlight.current = true;
      setBusy(true);
      setNotice(undefined);
      try {
        const result = await plannerReply(action());
        setNotice(
          result.status === "refused"
            ? (result.message ?? "The planner decision was refused.")
            : "Planner decision recorded.",
        );
      } catch {
        setNotice(
          "The decision reply was lost. Refresh and inspect current proposals before trying again; nothing is retried automatically.",
        );
      } finally {
        inFlight.current = false;
        setBusy(false);
        markChecking();
        refresh();
      }
    },
    exclusive: async (run) => {
      if (inFlight.current) return { status: "refused" };
      inFlight.current = true;
      setBusy(true);
      try {
        return { status: "ran", value: await run() };
      } finally {
        inFlight.current = false;
        setBusy(false);
        refresh();
      }
    },
  };
}

/**
 * The ordinary Code creation review for one planner proposal, with the
 * proposal's intent and Project fixed. Approving sends the proposal through
 * the window's creation path, which confirms it on the versioned planner
 * proposal route.
 */
export function PlannerProposalReviewDialog(
  props: PlannerReviewProps & {
    readonly planner: PlannerState;
    readonly review: PlannerProposalReview;
    readonly heading: string;
    readonly onClose: () => void;
  },
) {
  const { planner, review } = props;
  const ready = props.controller.status === "ready";
  const { remoteFacts } = useWorktreeRemoteFacts({
    execute: props.controller.execute,
    projectId: props.projectId,
    enabled: ready,
  });
  const bootstrap = props.controller.bootstrap;
  if (bootstrap === undefined) return null;
  const current = planner.current;
  const disabled = !current || planner.busy || props.creating === true;
  const providerGroups = props.providerGroups ?? [];
  const providerSelection =
    props.selectedProviderInstanceId !== undefined && props.selectedModelId !== undefined
      ? { providerInstanceId: props.selectedProviderInstanceId, modelId: props.selectedModelId }
      : undefined;
  const providerGroup = providerGroups.find(
    (group) => String(group.instance.id) === String(providerSelection?.providerInstanceId),
  );
  const providerReady =
    providerSelection !== undefined &&
    (providerGroup?.readiness === "ready" || providerGroup?.readiness === "degraded") &&
    isDraftSelectionSelectable(providerGroups, providerSelection);
  const reviewCurrent =
    planner.view?.proposals.some(
      (entry) =>
        String(entry.proposal.id) === String(review.proposal.id) &&
        entry.proposal.status === "pending" &&
        entry.proposalVersion === review.proposalVersion,
    ) === true;
  const reviewAttempt = readPlannerAttempt(
    planner.view?.proposals.find(
      (entry) => String(entry.proposal.id) === String(review.proposal.id),
    ) ?? review,
  );
  return (
    <OctantDialog
      label="Approve planner proposal"
      open
      onClose={() => {
        if (!planner.busy && !props.creating) props.onClose();
      }}
      className="code-project-planner__review"
    >
      <NewTaskDraftScopeContext.Provider value={`planner-proposal:${String(review.proposal.id)}`}>
        <CodeComposerAdapter
          projectId={props.projectId}
          projectAvailable={current && reviewCurrent}
          heading={
            <>
              <h2>{props.heading}</h2>
              <h3>{review.proposal.title}</h3>
            </>
          }
          fixedPrompt={review.proposal.intent}
          createLabel="Approve and start described task"
          providerGroups={providerGroups}
          {...(!current || !reviewCurrent
            ? {
                createDisabledReason:
                  "Refresh the changed proposal and host state before approving.",
              }
            : reviewAttempt.status !== "none"
              ? {
                  createDisabledReason:
                    "The prior approval outcome is unresolved. Inspect its submitted task; no replacement approval can be sent.",
                }
              : providerReady
                ? {}
                : {
                    createDisabledReason:
                      "Choose an available provider and model before approving this task.",
                  })}
          {...(props.projectName === undefined ? {} : { projectName: props.projectName })}
          {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
          {...(props.baseRepository === undefined ? {} : { baseRepository: props.baseRepository })}
          {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
          {...(props.newThreadWorkspace === undefined
            ? {}
            : { newThreadWorkspace: props.newThreadWorkspace })}
          {...(remoteFacts === undefined ? {} : { worktreeRemoteFacts: remoteFacts })}
          defaultPermissionMode={defaultPermissionModeFor({ settings: bootstrap.settings })}
          defaultPermissionPersistence={bootstrap.settings.defaultPermissionPersistence}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          onSelectProvider={props.onSelectProvider ?? (() => {})}
          creating={disabled}
          {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
          {...(props.pendingMessage === undefined ? {} : { pendingMessage: props.pendingMessage })}
          execute={props.controller.execute}
          onCancel={props.onClose}
          onCreateThread={async (input) => {
            if (!current || !reviewCurrent || reviewAttempt.status !== "none" || !providerReady)
              return false;
            const created = await planner.exclusive(
              async () =>
                await props.onCreateThread?.(
                  { ...input, prompt: review.proposal.intent },
                  props.projectId,
                  review,
                ),
            );
            return created.status === "ran" ? created.value : false;
          }}
        />
      </NewTaskDraftScopeContext.Provider>
      <p className="oct-row-detail">
        Approve and start creates this described task in {props.projectName ?? "this Project"} and
        sends its exact proposal as the first message, using the provider, checkout and access you
        choose above.
      </p>
      {!current || !reviewCurrent ? (
        <OctantAlert tone="warning">
          The proposal or host state changed. Close this review and refresh before deciding.
        </OctantAlert>
      ) : null}
    </OctantDialog>
  );
}
