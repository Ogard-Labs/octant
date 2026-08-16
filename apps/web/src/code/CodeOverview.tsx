import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { CodeBoardCard, CodeBoardView } from "@octant/contracts";
import type { CodeThreadId } from "@octant/contracts/code";
import type { HostIdentity } from "@octant/contracts/host";
import type { CodeNewThreadWorkspace, ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { resolveCodeNewThreadWorkspace, type PickerGroup } from "@octant/domain";
import type { WorktreeRemoteFacts } from "@octant/domain/code-worktree-source-policy";
import {
  ArrowUpRight,
  Bot,
  CircleAlert,
  CircleCheck,
  Clock3,
  GitBranch,
  GitCompare,
  GitPullRequest,
  ListChecks,
  MessageCircleQuestion,
  RefreshCw,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ShellState } from "../shell/ShellState";
import type { CodeController } from "./useCodeController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { CodeSidebarSection } from "./CodeSidebarSection";
import { CodeComposerAdapter, type CodeComposerSubmitInput } from "./composer/CodeComposerAdapter";
import { useWorktreeRemoteFacts } from "./composer/useWorktreeRemoteFacts";

export type CodeOverviewProps =
  | {
      readonly controller: CodeController;
      readonly onOpenSurface?: (kind: CodeOverviewSurfaceKind) => void;
      readonly threadId: CodeThreadId;
    }
  | {
      readonly controller: CodeController;
      readonly onOpenThread: (threadId: CodeThreadId) => void;
      readonly projectId: ProjectId;
      readonly projectName?: string;
      readonly projectRoot?: string;
      readonly hosts?: ReadonlyArray<HostIdentity>;
      readonly providerGroups?: ReadonlyArray<PickerGroup>;
      readonly selectedProviderInstanceId?: ProviderInstanceId;
      readonly selectedModelId?: ProviderModelId;
      readonly onSelectProvider?: (selection: {
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
      }) => void;
      readonly onCreateThread?: (
        input: CodeComposerSubmitInput,
        projectId: ProjectId,
      ) => void | Promise<void>;
      /**
       * The Project's remembered habit for how new threads start,
       * exactly as the server projection reports it.
       */
      readonly newThreadWorkspace?: CodeNewThreadWorkspace;
      /**
       * Records a new habit through the journaled Project command. The control
       * re-renders only from the refreshed projection, never from an optimistic
       * local guess the server did not accept.
       */
      readonly onChangeNewThreadWorkspace?: (
        projectId: ProjectId,
        newThreadWorkspace: CodeNewThreadWorkspace,
      ) => Promise<boolean>;
      readonly creating?: boolean;
      readonly errorMessage?: string;
      readonly pendingMessage?: string;
    };

export function CodeOverview(props: CodeOverviewProps) {
  if ("projectId" in props) return <ProjectCodeOverview {...props} />;
  const view =
    props.controller.activeView?.thread.id === props.threadId
      ? props.controller.activeView
      : undefined;
  if (props.controller.status === "disconnected") {
    return (
      <ShellState
        action={{ label: "Retry Code", onClick: props.controller.retry }}
        eyebrow="Code workspace"
        message={props.controller.errorMessage ?? "The local Code service is unavailable."}
        role="alert"
        state="disconnected"
        title="Code is disconnected"
      />
    );
  }
  if (view === undefined) {
    const unavailable = props.controller.errorCategory;
    return (
      <ShellState
        {...(unavailable === undefined
          ? {}
          : { action: { label: "Retry Code", onClick: props.controller.retry } })}
        eyebrow="Code workspace"
        message={
          props.controller.errorMessage ??
          (props.controller.status === "conflict-reload"
            ? "Loading current authoritative Code state."
            : "Loading the selected Code thread.")
        }
        {...(unavailable === undefined ? {} : { role: "alert" as const })}
        state={unavailable === undefined ? "loading" : "warning"}
        title={unavailable === undefined ? "Loading Code thread" : "Code thread unavailable"}
      />
    );
  }
  const { checkout, thread } = view;
  return (
    <section aria-label="Code overview" className="project-overview code-overview">
      <header className="project-overview__toolbar code-overview__toolbar">
        <div className="project-overview__identity code-overview__identity">
          <span className="project-overview__type">Code thread</span>
          <h1 className="project-overview__name">{thread.title}</h1>
          <div className="code-overview__meta">
            <span className="code-overview__lifecycle">
              <span aria-hidden="true" className="code-overview__lifecycle-mark" />
              {lifecycleSummary(thread.lifecycle)}
            </span>
            <span>{headLabel(checkout.head)}</span>
          </div>
        </div>
        <span className="code-overview__policy">{policyLabel(thread.executionPolicy)}</span>
      </header>

      {thread.lifecycle === "waiting" || thread.lifecycle === "interrupted" ? (
        <div className="project-overview__warning" role="alert">
          <div className="project-overview__warning-copy">
            <strong>{lifecycleLabel(thread.lifecycle)}</strong>
            <p>
              {thread.lifecycle === "waiting"
                ? "This thread is waiting for authoritative recovery or user input."
                : "This thread was interrupted and requires an explicit retry."}
            </p>
          </div>
        </div>
      ) : null}

      <section
        aria-label="Repository and checkout"
        className="project-overview__context code-overview__context"
      >
        <div className="project-overview__root">
          <span>{checkout.kind === "managed-worktree" ? "Managed worktree" : "Checkout"}</span>
          <strong>{headLabel(checkout.head)}</strong>
        </div>
        <span className="project-overview__availability">
          {checkout.availability === "available"
            ? "Available"
            : checkout.availability === "waiting"
              ? "Waiting"
              : "Unavailable"}
        </span>
      </section>

      <section aria-label="Code status summary" className="code-overview__summary">
        <article className="code-overview__card code-overview__card--delivery">
          <div>
            <span className="code-overview__eyebrow">Delivery target</span>
            <h2>
              <GitBranch aria-hidden="true" size={17} strokeWidth={1.8} />
              {thread.deliveryTarget.branchIntent}
            </h2>
            <p>
              {thread.deliveryTarget.branchIntent} → {thread.deliveryTarget.proposedBaseBranch}
            </p>
          </div>
          <dl className="code-overview__target-details">
            <div>
              <dt>Base</dt>
              <dd>{thread.deliveryTarget.proposedBaseBranch}</dd>
            </div>
            <div>
              <dt>Remote</dt>
              <dd>
                {thread.deliveryTarget.remoteName} · {thread.deliveryTarget.proposedBaseRepository}
              </dd>
            </div>
          </dl>
        </article>

        <div className="code-overview__signals">
          <article className="code-overview__signal">
            <GitCompare aria-hidden="true" size={17} strokeWidth={1.7} />
            <div>
              <span>Changes</span>
              <strong>Review checkout changes</strong>
              <p>Git changes load in the Git pane.</p>
            </div>
          </article>
          <article className="code-overview__signal">
            <ListChecks aria-hidden="true" size={17} strokeWidth={1.7} />
            <div>
              <span>Tests</span>
              <strong>Keep verification close</strong>
              <p>Test summaries load when repository tests run.</p>
            </div>
          </article>
          <article className="code-overview__signal">
            <GitPullRequest aria-hidden="true" size={17} strokeWidth={1.7} />
            <div>
              <span>Approvals</span>
              <strong>Review before delivery</strong>
              <p>Approval requests appear when the provider asks.</p>
            </div>
          </article>
        </div>
      </section>
      {props.onOpenSurface === undefined ? null : (
        <nav aria-label="Code workspace surfaces" className="project-overview__actions">
          <OctantButton
            className="project-button"
            onClick={() => props.onOpenSurface!("code-diff")}
            type="button"
            variant="secondary"
          >
            <GitCompare aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Open Git changes</span>
            <ArrowUpRight aria-hidden="true" className="code-overview__action-arrow" size={14} />
          </OctantButton>
          <OctantButton
            className="project-button"
            onClick={() => props.onOpenSurface!("code-terminal")}
            type="button"
            variant="secondary"
          >
            <Terminal aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Open terminal</span>
            <ArrowUpRight aria-hidden="true" className="code-overview__action-arrow" size={14} />
          </OctantButton>
          <OctantButton
            className="project-button"
            onClick={() => props.onOpenSurface!("code-git")}
            type="button"
            variant="secondary"
          >
            <GitBranch aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Open Git delivery</span>
            <ArrowUpRight aria-hidden="true" className="code-overview__action-arrow" size={14} />
          </OctantButton>
          <OctantButton
            className="project-button"
            onClick={() => props.onOpenSurface!("code-pr")}
            type="button"
            variant="secondary"
          >
            <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Open pull request</span>
            <ArrowUpRight aria-hidden="true" className="code-overview__action-arrow" size={14} />
          </OctantButton>
        </nav>
      )}
    </section>
  );
}

export type CodeOverviewSurfaceKind =
  | "code-diff"
  | "code-terminal"
  | "code-test"
  | "code-git"
  | "code-pr";

function ProjectCodeOverview(props: Extract<CodeOverviewProps, { readonly projectId: ProjectId }>) {
  const [boardState, setBoardState] = useState<ProjectBoardState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const ready = props.controller.status === "ready";
  const { remoteFacts } = useWorktreeRemoteFacts({
    execute: props.controller.execute,
    projectId: props.projectId,
    enabled: ready && props.onCreateThread !== undefined,
  });

  useEffect(() => {
    if (props.controller.status === "disconnected") {
      setBoardState({
        kind: "unavailable",
        message: props.controller.errorMessage ?? "The Code host is disconnected.",
      });
      return;
    }
    if (!ready) {
      setBoardState({ kind: "loading" });
      return;
    }
    let active = true;
    setBoardState({ kind: "loading" });
    void props.controller.client.queryBoard({ version: 1, projectIds: [props.projectId] }).then(
      (view) => {
        if (active) setBoardState({ kind: "ready", view });
      },
      (error: unknown) => {
        if (!active) return;
        setBoardState({
          kind: "unavailable",
          message:
            error instanceof Error
              ? error.message
              : "The Code Project projections are unavailable.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [
    props.controller.client,
    props.controller.errorMessage,
    props.controller.status,
    props.projectId,
    ready,
    reload,
  ]);

  const cards =
    boardState.kind === "ready"
      ? boardState.view.cards
          .filter((card) => String(card.projectId) === String(props.projectId))
          .slice(0, MAX_PROJECT_OVERVIEW_CARDS)
      : [];
  const navigationThreads = props.controller.navigation.filter(
    (thread) => String(thread.projectId) === String(props.projectId),
  );

  return (
    <section aria-label="Code Project Overview" className="code-project-overview">
      <CodeProjectSessions
        boardState={boardState}
        cards={cards}
        navigationThreads={navigationThreads}
        onRenameThread={(threadId, title) =>
          void props.controller.renameThread(threadId as CodeThreadId, title)
        }
        onPinThread={(threadId, pinned) =>
          void props.controller.pinThread(threadId as CodeThreadId, pinned)
        }
        onOpenThread={props.onOpenThread}
        onRetry={() => setReload((current) => current + 1)}
      />
      <CodeProjectionSections boardState={boardState} cards={cards} />
      <CodeProjectQuickStart
        controller={props.controller}
        projectId={props.projectId}
        providerGroups={props.providerGroups ?? []}
        {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
        {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
        {...(props.onCreateThread === undefined ? {} : { onCreateThread: props.onCreateThread })}
        {...(props.onChangeNewThreadWorkspace === undefined
          ? {}
          : { onChangeNewThreadWorkspace: props.onChangeNewThreadWorkspace })}
        {...(props.newThreadWorkspace === undefined
          ? {}
          : { newThreadWorkspace: props.newThreadWorkspace })}
        {...(props.onSelectProvider === undefined
          ? {}
          : { onSelectProvider: props.onSelectProvider })}
        {...(props.pendingMessage === undefined ? {} : { pendingMessage: props.pendingMessage })}
        {...(props.projectName === undefined ? {} : { projectName: props.projectName })}
        {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
        {...(remoteFacts === undefined ? {} : { remoteFacts })}
        {...(props.selectedModelId === undefined ? {} : { selectedModelId: props.selectedModelId })}
        {...(props.selectedProviderInstanceId === undefined
          ? {}
          : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
        {...(props.creating === undefined ? {} : { creating: props.creating })}
      />
    </section>
  );
}

const MAX_PROJECT_OVERVIEW_CARDS = 24;

type ProjectBoardState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: CodeBoardView }
  | { readonly kind: "unavailable"; readonly message: string };

function CodeProjectSessions(props: {
  readonly boardState: ProjectBoardState;
  readonly cards: ReadonlyArray<CodeBoardCard>;
  readonly navigationThreads: CodeController["navigation"];
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onPinThread?: (threadId: string, pinned: boolean) => void;
  readonly onOpenThread: (threadId: CodeThreadId) => void;
  readonly onRetry: () => void;
}) {
  return (
    <section aria-label="Code sessions" className="code-project-overview__sessions">
      <header className="code-project-overview__section-header">
        <div>
          <span className="code-project-overview__eyebrow">Exact Project scope</span>
          <h2>Code sessions</h2>
        </div>
        <span className="code-project-overview__scope-label">Host-authorized</span>
      </header>
      {props.boardState.kind === "loading" ? (
        <p role="status">Loading authoritative Code projections…</p>
      ) : props.boardState.kind === "unavailable" ? (
        <div className="code-project-overview__state" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <div>
            <strong>Code projections unavailable</strong>
            <p>{props.boardState.message}</p>
          </div>
          <OctantButton onClick={props.onRetry} type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> Retry projections
          </OctantButton>
        </div>
      ) : props.cards.length > 0 ? (
        <ul className="code-project-overview__thread-list">
          {props.cards.map((card) => (
            <li key={String(card.threadId)}>
              <OctantButton
                className="project-button project-button--quiet"
                onClick={() => props.onOpenThread(card.threadId)}
                type="button"
                variant="ghost"
              >
                <span>{card.title}</span>
                <span>
                  {boardStatusLabel(card.status)} · {card.followUp ? "Follow-up" : "No follow-up"}
                </span>
              </OctantButton>
            </li>
          ))}
        </ul>
      ) : (
        // Board cards are the richer projection; when they are absent the
        // navigation list is the authoritative fallback, and it carries the
        // follow-up filter so a Project with many threads stays scannable.
        <CodeSidebarSection
          onSelectThread={(threadId) => props.onOpenThread(threadId as CodeThreadId)}
          {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
          {...(props.onPinThread === undefined ? {} : { onPinThread: props.onPinThread })}
          threads={props.navigationThreads.slice(0, MAX_PROJECT_OVERVIEW_CARDS)}
        />
      )}
    </section>
  );
}

function CodeProjectionSections(props: {
  readonly boardState: ProjectBoardState;
  readonly cards: ReadonlyArray<CodeBoardCard>;
}) {
  const cards = props.cards;
  const active = cards.filter((card) => card.status === "in-progress" || card.executing);
  const waiting = cards.filter((card) => card.status === "waiting");
  const followUps = cards.filter((card) => card.followUp);
  const recent = [...cards]
    .filter((card) => card.lastMeaningfulActivityAt !== null)
    .sort((left, right) =>
      String(right.lastMeaningfulActivityAt).localeCompare(String(left.lastMeaningfulActivityAt)),
    )
    .slice(0, 8);

  return (
    <div className="code-project-overview__sections">
      <OverviewProjectionSection
        icon={<GitBranch aria-hidden="true" size={16} />}
        label="Repository, checkout, and worktree"
        state={props.boardState}
      >
        {cards.length === 0 ? (
          <ProjectionEmpty />
        ) : (
          <div className="code-project-overview__items">
            {cards.map((card) => (
              <article className="code-project-overview__item" key={String(card.threadId)}>
                <strong>{card.title}</strong>
                {card.worktree.kind === "available" ? (
                  <p>
                    Checkout available · {headLabel(card.worktree.head)} · {card.worktree.path}
                  </p>
                ) : (
                  <p>Checkout/worktree unavailable · no mutation is authorized here.</p>
                )}
              </article>
            ))}
          </div>
        )}
      </OverviewProjectionSection>

      <OverviewProjectionSection
        icon={<GitCompare aria-hidden="true" size={16} />}
        label="Branch and changes"
        state={props.boardState}
      >
        {cards.length === 0 ? (
          <ProjectionEmpty />
        ) : (
          <div className="code-project-overview__items">
            {cards.map((card) => (
              <article className="code-project-overview__item" key={String(card.threadId)}>
                <strong>{card.title}</strong>
                <p>{changedFilesLabel(card.changedFiles)}</p>
                {card.changedFiles.kind === "observed" &&
                card.changedFiles.freshness === "stale" ? (
                  <ProjectionStatus icon={<Clock3 aria-hidden="true" size={13} />}>
                    Stale observation
                  </ProjectionStatus>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </OverviewProjectionSection>

      <OverviewProjectionSection
        icon={<Clock3 aria-hidden="true" size={16} />}
        label="Thread activity"
        state={props.boardState}
      >
        <ThreadActivityGroup label="Active threads" cards={active} />
        <ThreadActivityGroup label="Waiting threads" cards={waiting} />
        <ThreadActivityGroup label="Follow-up threads" cards={followUps} />
        <ThreadActivityGroup label="Recent threads" cards={recent} />
      </OverviewProjectionSection>

      <OverviewProjectionSection
        icon={<MessageCircleQuestion aria-hidden="true" size={16} />}
        label="Approvals and input"
        state={props.boardState}
      >
        {cards.some((card) => card.status === "waiting") ? (
          <ProjectionStatus icon={<ShieldAlert aria-hidden="true" size={13} />}>
            Waiting for server-reported approval, input, or recovery. The overview does not grant
            authority.
          </ProjectionStatus>
        ) : (
          <ProjectionStatus icon={<CircleCheck aria-hidden="true" size={13} />}>
            No pending approval or input is reported.
          </ProjectionStatus>
        )}
      </OverviewProjectionSection>

      <OverviewProjectionSection
        icon={<ListChecks aria-hidden="true" size={16} />}
        label="Tests and validation"
        state={props.boardState}
      >
        {cards.length === 0 ? (
          <ProjectionEmpty />
        ) : (
          <div className="code-project-overview__items">
            {cards.map((card) => (
              <article className="code-project-overview__item" key={String(card.threadId)}>
                <strong>{card.title}</strong>
                <p>
                  Checks: {capitalize(card.checks.state)} · Review:{" "}
                  {capitalize(card.reviewState.state)}
                </p>
                {card.checks.freshness === "stale" || card.reviewState.freshness === "stale" ? (
                  <ProjectionStatus icon={<Clock3 aria-hidden="true" size={13} />}>
                    Stale validation observation
                  </ProjectionStatus>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </OverviewProjectionSection>

      <OverviewProjectionSection
        icon={<GitPullRequest aria-hidden="true" size={16} />}
        label="Delivery and pull request"
        state={props.boardState}
      >
        {cards.length === 0 ? (
          <ProjectionEmpty />
        ) : (
          <div className="code-project-overview__items">
            {cards.map((card) => (
              <article className="code-project-overview__item" key={String(card.threadId)}>
                <strong>{card.title}</strong>
                <p>
                  {deliveryOutcomeLabel(card.outcomeKind)} · {capitalize(card.deliverySatisfaction)}
                </p>
                {card.linkedPullRequest.kind === "linked" ? (
                  <p>
                    #{card.linkedPullRequest.number} · {card.linkedPullRequest.state}
                    {card.linkedPullRequest.freshness === "stale" ? " · Stale" : ""}
                  </p>
                ) : (
                  <p>No linked pull request reported.</p>
                )}
              </article>
            ))}
          </div>
        )}
      </OverviewProjectionSection>

      <OverviewProjectionSection
        icon={<Bot aria-hidden="true" size={16} />}
        label="Active child agents"
        state={props.boardState}
      >
        {cards.length === 0 ? (
          <ProjectionEmpty />
        ) : (
          <div className="code-project-overview__items">
            {cards.map((card) => (
              <article className="code-project-overview__item" key={String(card.threadId)}>
                <strong>{card.title}</strong>
                <p>
                  {card.childAgents.active} active · {card.childAgents.completed} completed ·{" "}
                  {card.childAgents.failed} failed
                </p>
                {card.childAgents.latestSummary === undefined ? null : (
                  <p>{card.childAgents.latestSummary}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </OverviewProjectionSection>

      <details className="code-project-overview__details">
        <summary>
          <Terminal aria-hidden="true" size={15} />
          <span>Environment and metadata details</span>
        </summary>
        <div className="code-project-overview__items">
          {cards.length === 0 ? (
            <ProjectionEmpty />
          ) : (
            cards.map((card) => (
              <article className="code-project-overview__item" key={String(card.threadId)}>
                <strong>{card.title}</strong>
                <p>
                  <EnvironmentState card={card} /> · Host-scoped read-only projection
                </p>
                {card.recovery.kind === "recovering" ? (
                  <p>Recovery: {card.recovery.reasons.join(", ")}</p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </details>
    </div>
  );
}

function OverviewProjectionSection(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly state: ProjectBoardState;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.label} className="code-project-overview__projection">
      <header className="code-project-overview__section-header">
        <div>
          {props.icon}
          <h2>{props.label}</h2>
        </div>
        {props.state.kind === "unavailable" ? (
          <ProjectionStatus icon={<CircleAlert aria-hidden="true" size={13} />}>
            Unavailable
          </ProjectionStatus>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

function ThreadActivityGroup(props: {
  readonly label: string;
  readonly cards: ReadonlyArray<CodeBoardCard>;
}) {
  return (
    <div className="code-project-overview__activity-group">
      <h3>{props.label}</h3>
      {props.cards.length === 0 ? (
        <p>None reported.</p>
      ) : (
        <ul>
          {props.cards.map((card) => (
            <li key={`${props.label}-${String(card.threadId)}`}>
              <strong>{card.title}</strong>
              <span>{boardStatusLabel(card.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectionStatus(props: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <span className="code-project-overview__status" role="status">
      {props.icon}
      <span>{props.children}</span>
    </span>
  );
}

function ProjectionEmpty() {
  return <p className="code-project-overview__empty">No projection is currently reported.</p>;
}

function CodeProjectQuickStart(props: {
  readonly controller: CodeController;
  readonly projectId: ProjectId;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectProvider?: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  readonly onCreateThread?: (
    input: CodeComposerSubmitInput,
    projectId: ProjectId,
  ) => void | Promise<void>;
  readonly newThreadWorkspace?: CodeNewThreadWorkspace;
  readonly onChangeNewThreadWorkspace?: (
    projectId: ProjectId,
    newThreadWorkspace: CodeNewThreadWorkspace,
  ) => Promise<boolean>;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly remoteFacts?: WorktreeRemoteFacts;
}) {
  // Absence is not an error: a Project that never chose falls back to the
  // current checkout, which creates no worktree the user did not ask for.
  const habit = resolveCodeNewThreadWorkspace({
    type: "code",
    ...(props.newThreadWorkspace === undefined
      ? {}
      : { newThreadWorkspace: props.newThreadWorkspace }),
  });
  const onChangeNewThreadWorkspace = props.onChangeNewThreadWorkspace;
  return (
    <section aria-label="Code quick start" className="code-project-overview__quick-start">
      <header className="code-project-overview__section-header">
        <div>
          <span className="code-project-overview__eyebrow">Ordinary Code creation</span>
          <h2>Start a Code thread</h2>
        </div>
        <span className="code-project-overview__scope-label">Approval gated by default</span>
      </header>
      {props.onCreateThread === undefined ? (
        <p role="status">
          Code quick start is unavailable until server creation authority is connected.
        </p>
      ) : props.controller.status !== "ready" || props.controller.bootstrap === undefined ? (
        <p role="status">Code creation is waiting for the authoritative host connection.</p>
      ) : (
        <>
          <p className="code-project-overview__quick-start-copy">
            Host, Project, provider/model, checkout/worktree, delivery target, and permission
            persistence are confirmed by the Code service before the first turn. The overview is
            read-only.
          </p>
          <p className="code-project-overview__quick-start-copy">
            Checkout and worktree are confirmed by the Code service before creation.
          </p>
          {onChangeNewThreadWorkspace === undefined ? null : (
            <label className="code-project-overview__quick-start-copy">
              <span>New threads start in</span>
              <OctantNativeSelect
                aria-label="New threads start in"
                onChange={(event) =>
                  void onChangeNewThreadWorkspace(
                    props.projectId,
                    event.target.value as CodeNewThreadWorkspace,
                  )
                }
                value={habit}
              >
                <option value="current-checkout">This Project's current checkout</option>
                <option value="managed-worktree">A managed worktree Octant creates</option>
              </OctantNativeSelect>
            </label>
          )}
          <CodeComposerAdapter
            {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
            newThreadWorkspace={habit}
            projectId={props.projectId}
            {...(props.projectName === undefined ? {} : { projectName: props.projectName })}
            {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
            defaultExecutionPolicy="approval-gated"
            defaultPermissionPersistence={
              props.controller.bootstrap.settings.defaultPermissionPersistence
            }
            providerGroups={props.providerGroups}
            {...(props.selectedProviderInstanceId === undefined
              ? {}
              : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
            {...(props.selectedModelId === undefined
              ? {}
              : { selectedModelId: props.selectedModelId })}
            onSelectProvider={props.onSelectProvider ?? (() => {})}
            onCreateThread={(input) => props.onCreateThread?.(input, props.projectId)}
            // Escape should not discard the inline draft; a failed or cancelled
            // create remains available for an explicit retry.
            onCancel={() => undefined}
            {...(props.creating === undefined ? {} : { creating: props.creating })}
            {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
            {...(props.pendingMessage === undefined
              ? {}
              : { pendingMessage: props.pendingMessage })}
            {...(props.remoteFacts === undefined ? {} : { worktreeRemoteFacts: props.remoteFacts })}
            execute={props.controller.execute}
          />
        </>
      )}
    </section>
  );
}

function changedFilesLabel(changes: CodeBoardCard["changedFiles"]): string {
  if (changes.kind === "unavailable") return "Changed files unavailable";
  return `${changes.changedPathCount} changed ${changes.changedPathCount === 1 ? "file" : "files"} · ${changes.stagedCount} staged · ${changes.committedAhead} committed ahead${changes.workingTreeClean ? " · Working tree clean" : ""}`;
}

function boardStatusLabel(status: CodeBoardCard["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "in-progress":
      return "In progress";
    case "waiting":
      return "Waiting";
    case "done":
      return "Done";
  }
}

function deliveryOutcomeLabel(kind: CodeBoardCard["outcomeKind"]): string {
  switch (kind) {
    case "investigation-result":
      return "Investigation result";
    case "local-implementation":
      return "Local implementation";
    case "opened-pr":
      return "Opened pull request";
    case "merged-pr":
      return "Merged pull request";
  }
}

function EnvironmentState({ card }: { readonly card: CodeBoardCard }): string {
  if (card.worktree.kind === "unavailable") return "Unavailable";
  if (card.recovery.kind === "recovering") return "Waiting for recovery";
  if (card.childAgents.failed > 0 || card.checks.state === "failing") return "Failed";
  if (card.status === "waiting") return "Waiting";
  if (card.executing) return "Active";
  if (card.githubFreshness === "stale") return "Stale";
  return "Idle";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).replaceAll("-", " ");
}

function headLabel(
  head: { readonly kind: "branch"; readonly name: string } | { readonly kind: "detached" },
): string {
  return head.kind === "branch" ? head.name : "Detached HEAD";
}

function lifecycleLabel(lifecycle: "waiting" | "interrupted"): string {
  return lifecycle === "waiting" ? "Waiting" : "Interrupted";
}

function lifecycleSummary(lifecycle: "active" | "archived" | "waiting" | "interrupted"): string {
  switch (lifecycle) {
    case "active":
      return "Active";
    case "archived":
      return "Archived";
    case "waiting":
      return "Waiting";
    case "interrupted":
      return "Interrupted";
  }
}

function policyLabel(policy: ProviderExecutionPolicy): string {
  switch (policy) {
    case "plan":
      return "Plan · read-only";
    case "approval-gated":
      return "Approval gated";
    case "auto-accept-edits":
      return "Auto-accept edits";
    case "full-access":
      return "Full access";
    default:
      return policy;
  }
}
