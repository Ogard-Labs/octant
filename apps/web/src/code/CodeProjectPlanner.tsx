import type { CodePlannerCommand, CodePlannerView, ProjectId } from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { defaultPermissionModeFor } from "@octant/domain/guardrail-policy";
import { isDraftSelectionSelectable } from "@octant/domain";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { NewTaskDraftScopeContext } from "../composer/useNewTaskPrompt";
import type { CodeOverviewProps } from "./CodeOverview";
import { CodeComposerAdapter } from "./composer/CodeComposerAdapter";
import { useWorktreeRemoteFacts } from "./composer/useWorktreeRemoteFacts";
import { plannerReply, type PlannerProposalReview } from "./plannerProposalCreation";
import { readPlannerAttempt, settlePlannerAttempt } from "./plannerProposalAttempt";

/** The person reviews one Project's planner; every write retains its server version. */
export function CodeProjectPlanner(
  props: Extract<CodeOverviewProps, { readonly projectId: ProjectId }>,
) {
  const { client } = props.controller;
  const ready = props.controller.status === "ready";
  const supported = client.readPlanner !== undefined;
  const [state, setState] = useState<{
    readonly projectId: ProjectId;
    readonly client: typeof client;
    readonly view?: CodePlannerView;
    readonly failure?: string;
  }>();
  const [revision, refresh] = useState(0);
  const [chosen, choose] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<string>();
  const [review, setReview] = useState<PlannerProposalReview>();
  const { remoteFacts } = useWorktreeRemoteFacts({
    execute: props.controller.execute,
    projectId: props.projectId,
    enabled: ready && review !== undefined,
  });
  const view =
    state?.client === client && String(state.projectId) === String(props.projectId)
      ? state.view
      : undefined;
  const current = ready && view !== undefined && state?.failure === undefined;
  const threads = (props.controller.bootstrap?.threads ?? []).filter(
    (thread) =>
      String(thread.projectId) === String(props.projectId) && thread.lifecycle !== "archived",
  );
  const selected = threads.find((thread) => String(thread.id) === chosen) ?? threads[0];
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

  async function mutate(
    action: () => Promise<{ readonly status: string; readonly message?: string }>,
  ) {
    if (!current || inFlight.current) return;
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
      setState((previous) =>
        previous === undefined
          ? previous
          : { ...previous, failure: "Checking current planner state…" },
      );
      refresh((value) => value + 1);
    }
  }
  const designation = (command: CodePlannerCommand) =>
    mutate(async () => {
      if (client.executePlanner === undefined)
        return { status: "refused", message: "Planner designation is unavailable on this host." };
      return client.executePlanner(command);
    });
  if (!supported) return null;
  const disabled = !current || busy || props.creating === true;
  const activePlanner =
    view?.designation.kind === "designated" ? view.designation.plannerThreadId : undefined;
  const planner = threads.find((thread) => String(thread.id) === String(activePlanner));
  const proposals = [...(view?.proposals ?? [])]
    .sort(
      (a, b) =>
        Number(b.proposal.status === "pending") - Number(a.proposal.status === "pending") ||
        b.proposal.proposedAt.localeCompare(a.proposal.proposedAt),
    )
    .slice(0, 50);
  const reviewCurrent =
    review !== undefined &&
    view?.proposals.some(
      (entry) =>
        String(entry.proposal.id) === String(review.proposal.id) &&
        entry.proposal.status === "pending" &&
        entry.proposalVersion === review.proposalVersion,
    );
  const reviewAttempt =
    review === undefined
      ? { status: "none" as const }
      : readPlannerAttempt(
          view?.proposals.find(
            (entry) => String(entry.proposal.id) === String(review.proposal.id),
          ) ?? review,
        );
  return (
    <section aria-label="Project planner" className="code-project-planner">
      <header className="code-project-overview__section-header">
        <h2>Project planner</h2>
        <OctantButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => refresh((value) => value + 1)}
        >
          Refresh planner
        </OctantButton>
      </header>
      <p className="oct-row-detail">
        One Code thread may survey this Project and propose tasks. Each proposal waits for your
        decision; designation grants no right to start work.
      </p>
      {!ready || state?.failure !== undefined ? (
        <OctantAlert tone="warning">
          {!ready
            ? "Planner decisions need a connected host. Reconnect and refresh before continuing."
            : state?.failure}
        </OctantAlert>
      ) : null}
      {notice === undefined ? null : (
        <p role="status" className="oct-row-detail">
          {notice}
        </p>
      )}
      {view === undefined ? (
        <p role="status">Loading planner state…</p>
      ) : activePlanner === undefined ? (
        <div className="code-project-planner__controls">
          <OctantSelectField
            aria-label="Planner thread"
            value={selected === undefined ? "" : String(selected.id)}
            options={threads.map((thread) => ({ id: String(thread.id), label: thread.title }))}
            placeholder={threads.length === 0 ? "No Code threads yet" : "Choose a thread"}
            onValueChange={choose}
            disabled={disabled}
          />
          <OctantButton
            type="button"
            variant="secondary"
            disabled={disabled || selected === undefined || client.executePlanner === undefined}
            onClick={() => {
              if (selected !== undefined)
                void designation({
                  kind: "designate-code-planner-thread",
                  projectId: props.projectId,
                  threadId: selected.id,
                  expectedVersion: view.designationVersion,
                });
            }}
          >
            Designate planner
          </OctantButton>
          {threads.length === 0 ? (
            <p className="oct-meta">Create a Code thread in this Project first.</p>
          ) : null}
        </div>
      ) : (
        <div className="code-project-planner__controls">
          <span>{planner?.title ?? "Designated planner thread"}</span>
          <OctantButton
            type="button"
            variant="ghost"
            onClick={() => props.onOpenThread(activePlanner)}
          >
            Open planner
          </OctantButton>
          <OctantButton
            type="button"
            variant="ghost"
            disabled={disabled || client.executePlanner === undefined}
            onClick={() =>
              void designation({
                kind: "undesignate-code-planner-thread",
                projectId: props.projectId,
                expectedVersion: view.designationVersion,
              })
            }
          >
            Remove designation
          </OctantButton>
        </div>
      )}
      <ul className="code-project-planner__proposals">
        {proposals.map((entry) => {
          const attempt = readPlannerAttempt(entry);
          return (
            <li key={String(entry.proposal.id)}>
              <h3>{entry.proposal.title}</h3>
              <p className="oct-meta">
                {entry.proposal.status === "confirmed"
                  ? "Approved"
                  : entry.proposal.status === "declined"
                    ? "Declined"
                    : "Awaiting your decision"}{" "}
                ·{" "}
                <time dateTime={entry.proposal.proposedAt}>
                  {new Date(entry.proposal.proposedAt).toLocaleString()}
                </time>
              </p>
              <p className="code-project-planner__intent">{entry.proposal.intent}</p>
              {entry.proposal.rationale === undefined ? null : (
                <p className="oct-row-detail">{entry.proposal.rationale}</p>
              )}
              {entry.proposal.status === "pending" && attempt.status !== "none" ? (
                <p className="oct-row-detail" role="status">
                  {attempt.status === "blocked"
                    ? "The submitted approval is unresolved. Inspect its task; another approval or decline stays blocked until the host records its outcome."
                    : "This window cannot retain approval identity. Session storage is required before approving."}
                </p>
              ) : null}
              {entry.proposal.status === "pending" &&
              entry.proposal.creationAttempt?.status === "failed" ? (
                <p className="oct-row-detail">
                  Creation did not start:{" "}
                  {entry.proposal.creationAttempt.message ?? "The host refused before creation."}{" "}
                  Review the current settings before explicitly approving again.
                </p>
              ) : null}
              {entry.proposal.status === "pending" && attempt.status === "blocked" ? (
                <OctantButton
                  type="button"
                  variant="ghost"
                  onClick={() => props.onOpenThread(attempt.threadId)}
                >
                  Inspect submitted task
                </OctantButton>
              ) : null}
              {entry.proposal.status === "confirmed" ? (
                <OctantButton
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (entry.proposal.status === "confirmed")
                      props.onOpenThread(entry.proposal.createdThreadId);
                  }}
                >
                  Open created task
                </OctantButton>
              ) : entry.proposal.status !== "pending" ? null : (
                <div className="code-project-planner__controls">
                  <OctantButton
                    type="button"
                    variant="secondary"
                    disabled={
                      disabled ||
                      attempt.status !== "none" ||
                      props.onCreateThread === undefined ||
                      client.executePlannerProposal === undefined
                    }
                    onClick={() => setReview(entry)}
                  >
                    Review and approve
                  </OctantButton>
                  <OctantButton
                    type="button"
                    variant="ghost"
                    disabled={
                      disabled ||
                      attempt.status === "blocked" ||
                      client.executePlannerProposal === undefined
                    }
                    onClick={() =>
                      void mutate(async () =>
                        client.executePlannerProposal === undefined
                          ? { status: "refused", message: "Proposal decisions are unavailable." }
                          : client.executePlannerProposal({
                              kind: "decline-planner-work-proposal",
                              proposalId: entry.proposal.id,
                              expectedVersion: entry.proposalVersion,
                            }),
                      )
                    }
                  >
                    Decline proposal
                  </OctantButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {view !== undefined && proposals.length === 0 ? (
        <p className="oct-row-detail">
          No proposals yet. Open the designated planner to ask it to survey this Project.
        </p>
      ) : null}
      {(view?.proposals.length ?? 0) > 50 ? (
        <p className="oct-meta">Showing the first fifty proposals, with pending decisions first.</p>
      ) : null}
      {review === undefined || props.controller.bootstrap === undefined ? null : (
        <OctantDialog
          label="Approve planner proposal"
          open
          onClose={() => {
            if (!busy && !props.creating) setReview(undefined);
          }}
          className="code-project-planner__review"
        >
          <NewTaskDraftScopeContext.Provider
            value={`planner-proposal:${String(review.proposal.id)}`}
          >
            <CodeComposerAdapter
              projectId={props.projectId}
              projectAvailable={current && reviewCurrent === true}
              heading={
                <>
                  <h2>{"Review the planner's proposal"}</h2>
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
              {...(props.baseRepository === undefined
                ? {}
                : { baseRepository: props.baseRepository })}
              {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
              {...(props.newThreadWorkspace === undefined
                ? {}
                : { newThreadWorkspace: props.newThreadWorkspace })}
              {...(remoteFacts === undefined ? {} : { worktreeRemoteFacts: remoteFacts })}
              defaultPermissionMode={defaultPermissionModeFor({
                settings: props.controller.bootstrap.settings,
              })}
              defaultPermissionPersistence={
                props.controller.bootstrap.settings.defaultPermissionPersistence
              }
              {...(props.selectedProviderInstanceId === undefined
                ? {}
                : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
              {...(props.selectedModelId === undefined
                ? {}
                : { selectedModelId: props.selectedModelId })}
              onSelectProvider={props.onSelectProvider ?? (() => {})}
              creating={disabled}
              {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
              {...(props.pendingMessage === undefined
                ? {}
                : { pendingMessage: props.pendingMessage })}
              execute={props.controller.execute}
              onCancel={() => setReview(undefined)}
              onCreateThread={async (input) => {
                if (
                  !current ||
                  !reviewCurrent ||
                  reviewAttempt.status !== "none" ||
                  !providerReady ||
                  inFlight.current
                )
                  return false;
                inFlight.current = true;
                setBusy(true);
                try {
                  return await props.onCreateThread?.(
                    { ...input, prompt: review.proposal.intent },
                    props.projectId,
                    review,
                  );
                } finally {
                  inFlight.current = false;
                  setBusy(false);
                  refresh((value) => value + 1);
                }
              }}
            />
          </NewTaskDraftScopeContext.Provider>
          <p className="oct-row-detail">
            Approve and start creates this described task in {props.projectName ?? "this Project"}{" "}
            and sends its exact proposal as the first message, using the provider, checkout and
            access you choose above.
          </p>
          {!current || !reviewCurrent ? (
            <OctantAlert tone="warning">
              The proposal or host state changed. Close this review and refresh before deciding.
            </OctantAlert>
          ) : null}
        </OctantDialog>
      )}
    </section>
  );
}
