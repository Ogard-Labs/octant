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
  CircleAlert,
  GitBranch,
  GitCompare,
  GitPullRequest,
  ListChecks,
  Pin,
  PinOff,
  RefreshCw,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { ShellState } from "../shell/ShellState";
import type { CodeController, CodeThreadNavigationItem } from "./useCodeController";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { ThreadRenameField } from "../projects/ThreadRenameField";
import { CodeComposerAdapter, type CodeComposerSubmitInput } from "./composer/CodeComposerAdapter";
import { useWorktreeRemoteFacts } from "./composer/useWorktreeRemoteFacts";

export type CodeOverviewProps =
  | {
      readonly controller: CodeController;
      readonly onOpenReview?: () => void;
      readonly onOpenSurface?: (kind: CodeOverviewSurfaceKind) => void;
      readonly threadId: CodeThreadId;
    }
  | {
      readonly controller: CodeController;
      readonly onOpenThread: (threadId: CodeThreadId) => void;
      readonly projectId: ProjectId;
      readonly projectName?: string;
      readonly projectRoot?: string;
      /** Server-observed credential-free GitHub owner/repository identity. */
      readonly baseRepository?: string;
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
      ) => boolean | void | Promise<boolean | void>;
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
              <GitBranch aria-hidden="true" size={16} strokeWidth={1.8} />
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
            <GitCompare aria-hidden="true" size={16} strokeWidth={1.7} />
            <div>
              <span>Changes</span>
              <strong>Review checkout changes</strong>
              <p>Local changes open in Review beside this thread.</p>
            </div>
          </article>
          <article className="code-overview__signal">
            <ListChecks aria-hidden="true" size={16} strokeWidth={1.7} />
            <div>
              <span>Tests</span>
              <strong>Keep verification close</strong>
              <p>Test summaries load when repository tests run.</p>
            </div>
          </article>
          <article className="code-overview__signal">
            <GitPullRequest aria-hidden="true" size={16} strokeWidth={1.7} />
            <div>
              <span>Approvals</span>
              <strong>Review before delivery</strong>
              <p>Approval requests appear when the provider asks.</p>
            </div>
          </article>
        </div>
      </section>
      {props.onOpenReview === undefined && props.onOpenSurface === undefined ? null : (
        <nav aria-label="Code workspace surfaces" className="project-overview__actions">
          {props.onOpenReview === undefined ? null : (
            <OctantButton
              className="project-button"
              onClick={props.onOpenReview}
              type="button"
              variant="secondary"
            >
              <GitCompare aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>View changes</span>
              <ArrowUpRight aria-hidden="true" className="code-overview__action-arrow" size={14} />
            </OctantButton>
          )}
          {props.onOpenSurface === undefined ? null : (
            <>
              <OctantButton
                className="project-button"
                onClick={() => props.onOpenSurface!("code-terminal")}
                type="button"
                variant="secondary"
              >
                <Terminal aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>Open terminal</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="code-overview__action-arrow"
                  size={14}
                />
              </OctantButton>
              <OctantButton
                className="project-button"
                onClick={() => props.onOpenSurface!("code-git")}
                type="button"
                variant="secondary"
              >
                <GitBranch aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>Open Git delivery</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="code-overview__action-arrow"
                  size={14}
                />
              </OctantButton>
              <OctantButton
                className="project-button"
                onClick={() => props.onOpenSurface!("code-pr")}
                type="button"
                variant="secondary"
              >
                <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>Open pull request</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="code-overview__action-arrow"
                  size={14}
                />
              </OctantButton>
            </>
          )}
        </nav>
      )}
    </section>
  );
}

export type CodeOverviewSurfaceKind = "code-terminal" | "code-test" | "code-git" | "code-pr";

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
      <CodeProjectFacts
        cards={cards}
        {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
      />
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
        {...(props.baseRepository === undefined ? {} : { baseRepository: props.baseRepository })}
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

/**
 * Project-level truth rendered exactly once: the bound repository and the
 * authority rule for this surface. Per-thread facts live on the thread rows
 * below, so nothing here repeats per thread.
 */
function CodeProjectFacts(props: {
  readonly cards: ReadonlyArray<CodeBoardCard>;
  readonly projectRoot?: string;
}) {
  const waiting = props.cards.filter((card) => card.status === "waiting").length;
  return (
    <section aria-label="Project scope and authority" className="code-project-overview__facts">
      {props.projectRoot === undefined ? null : (
        <dl className="kv">
          <dt>Repository</dt>
          <dd>{props.projectRoot}</dd>
        </dl>
      )}
      {waiting > 0 ? (
        <div className="callout callout-warn" role="status">
          <ShieldAlert aria-hidden="true" size={16} />
          <div>
            <p className="callout-title">
              {waiting === 1 ? "1 thread is waiting" : `${waiting} threads are waiting`}
            </p>
            <p>
              Waiting for server-reported approval, input, or recovery. The overview does not grant
              authority.
            </p>
          </div>
        </div>
      ) : (
        <p className="code-project-overview__authority">
          Read-only host projection. The overview does not grant authority.
        </p>
      )}
    </section>
  );
}

/**
 * One row per thread. The navigation projection orders the rows and carries
 * rename and pin; a board card whose thread the navigation does not carry
 * still gets a row, so no reported fact is lost.
 */
interface ThreadRowModel {
  readonly threadId: string;
  readonly title: string;
  readonly thread?: CodeThreadNavigationItem | undefined;
  readonly card?: CodeBoardCard | undefined;
}

function CodeProjectSessions(props: {
  readonly boardState: ProjectBoardState;
  readonly cards: ReadonlyArray<CodeBoardCard>;
  readonly navigationThreads: CodeController["navigation"];
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onPinThread?: (threadId: string, pinned: boolean) => void;
  readonly onOpenThread: (threadId: CodeThreadId) => void;
  readonly onRetry: () => void;
}) {
  const cardsByThread = new Map(props.cards.map((card) => [String(card.threadId), card]));
  const navigationIds = new Set(props.navigationThreads.map((thread) => String(thread.threadId)));
  const rows: ReadonlyArray<ThreadRowModel> = [
    ...props.navigationThreads.map((thread) => ({
      threadId: String(thread.threadId),
      title: thread.title,
      thread,
      card: cardsByThread.get(String(thread.threadId)),
    })),
    ...props.cards
      .filter((card) => !navigationIds.has(String(card.threadId)))
      .map((card) => ({ threadId: String(card.threadId), title: card.title, card })),
  ].slice(0, MAX_PROJECT_OVERVIEW_CARDS);
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
        <div className="callout callout-warn code-project-overview__state" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <div>
            <p className="callout-title">Code projections unavailable</p>
            <p>{props.boardState.message}</p>
          </div>
          <OctantButton onClick={props.onRetry} type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> Retry projections
          </OctantButton>
        </div>
      ) : rows.length === 0 ? (
        <p role="status">No Code threads in this Project.</p>
      ) : (
        <ul className="code-project-overview__threads">
          {rows.map((row) => (
            <li key={row.threadId}>
              <CodeProjectThreadRow
                onOpen={() => props.onOpenThread(row.threadId as CodeThreadId)}
                {...(props.onRenameThread === undefined
                  ? {}
                  : { onRename: (title: string) => props.onRenameThread?.(row.threadId, title) })}
                {...(row.thread === undefined || props.onPinThread === undefined
                  ? {}
                  : {
                      onPin: () => props.onPinThread?.(row.threadId, row.thread?.pinned !== true),
                    })}
                row={row}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CodeProjectThreadRow(props: {
  readonly row: ThreadRowModel;
  readonly onOpen: () => void;
  readonly onRename?: (title: string) => void;
  readonly onPin?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const { row } = props;
  const pinned = row.thread?.pinned === true;
  const facts = collapsedThreadFacts(row.card);
  const detail = detailThreadFacts(row.card);
  return (
    <article className="setgroup code-project-thread">
      {renaming && props.onRename !== undefined ? (
        <ThreadRenameField
          label="Rename Code thread"
          onCancel={() => setRenaming(false)}
          onRename={(title) => {
            setRenaming(false);
            props.onRename?.(title);
          }}
          title={row.title}
        />
      ) : (
        <div className="code-project-thread__row">
          <OctantButton
            className="code-project-thread__title"
            onClick={props.onOpen}
            // Renaming from the keyboard needs no pointer; F2 is the platform
            // convention and the double-click is the pointer equivalent.
            onDoubleClick={props.onRename === undefined ? undefined : () => setRenaming(true)}
            onKeyDown={(event) => {
              if (event.key !== "F2" || props.onRename === undefined) return;
              event.preventDefault();
              setRenaming(true);
            }}
            type="button"
            variant="ghost"
          >
            <span>{row.title}</span>
          </OctantButton>
          <span className="code-project-thread__chips">
            <ThreadStateBadge row={row} />
            {row.thread === undefined ? null : (
              <span className="tag">{policyLabel(row.thread.executionPolicy)}</span>
            )}
            {row.thread?.unread === true ? (
              <OctantBadge variant="default">New activity</OctantBadge>
            ) : null}
            {(row.thread?.followUp ?? row.card?.followUp) === true ? (
              <span className="tag">Follow-up</span>
            ) : null}
            {pinned ? <span className="tag">Pinned</span> : null}
          </span>
          {props.onPin === undefined ? null : (
            <OctantButton
              aria-label={pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
              aria-pressed={pinned}
              className="code-project-thread__pin"
              onClick={props.onPin}
              type="button"
              variant="ghost"
            >
              {pinned ? (
                <PinOff aria-hidden="true" size={14} strokeWidth={1.8} />
              ) : (
                <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
              )}
            </OctantButton>
          )}
        </div>
      )}
      {facts.length === 0 ? null : (
        <dl className="kv code-project-thread__facts">
          {facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {detail.length === 0 ? null : (
        <details className="code-project-thread__more">
          <summary>Full detail</summary>
          <dl className="kv">
            {detail.map((fact) => (
              <Fragment key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}

/**
 * The board's derived status outranks the navigation lifecycle because it is
 * projected from more evidence; the lifecycle stands in only when the board
 * has no card for the thread. Both are server-reported, never invented here.
 */
function ThreadStateBadge({ row }: { readonly row: ThreadRowModel }) {
  if (row.card !== undefined) {
    return (
      <span className={boardStatusBadgeClass(row.card.status)}>
        {boardStatusLabel(row.card.status)}
      </span>
    );
  }
  if (row.thread !== undefined) {
    return (
      <span className={lifecycleBadgeClass(row.thread.lifecycle)}>
        {lifecycleSummary(row.thread.lifecycle)}
      </span>
    );
  }
  return null;
}

interface ThreadFact {
  readonly label: string;
  readonly value: string;
}

/**
 * Only facts the host actually reported become rows. An unknown, unavailable,
 * or zero-valued facet is absence, not a fact, so it renders nothing rather
 * than a placeholder sentence.
 */
function collapsedThreadFacts(card: CodeBoardCard | undefined): ReadonlyArray<ThreadFact> {
  if (card === undefined) return [];
  const facts: ThreadFact[] = [];
  if (card.worktree.kind === "available") {
    facts.push({ label: "Branch", value: headLabel(card.worktree.head) });
  }
  if (card.changedFiles.kind === "observed") {
    facts.push({
      label: "Changes",
      value: withStaleness(observedChangesLabel(card.changedFiles), card.changedFiles.freshness),
    });
  }
  if (card.checks.state !== "unknown") {
    facts.push({
      label: "Checks",
      value: withStaleness(capitalize(card.checks.state), card.checks.freshness),
    });
  }
  if (card.reviewState.state !== "unknown") {
    facts.push({
      label: "Review",
      value: withStaleness(capitalize(card.reviewState.state), card.reviewState.freshness),
    });
  }
  if (card.linkedPullRequest.kind === "linked") {
    facts.push({
      label: "Pull request",
      value: withStaleness(
        `#${card.linkedPullRequest.number} · ${card.linkedPullRequest.state}`,
        card.linkedPullRequest.freshness,
      ),
    });
  }
  const agents = childAgentsLabel(card.childAgents);
  if (agents !== undefined) facts.push({ label: "Agents", value: agents });
  if (card.recovery.kind === "recovering") {
    facts.push({ label: "Recovery", value: card.recovery.reasons.join(", ") });
  }
  if (card.blockingReason !== undefined) {
    facts.push({ label: "Blocked", value: card.blockingReason });
  }
  return facts;
}

/**
 * The disclosure carries the facts that are true but rarely the reason to
 * glance at the board: paths, the confirmed delivery target, and trailing
 * activity. Everything here is still host-reported, only tucked away.
 */
function detailThreadFacts(card: CodeBoardCard | undefined): ReadonlyArray<ThreadFact> {
  if (card === undefined) return [];
  const facts: ThreadFact[] = [];
  if (card.worktree.kind === "available") {
    facts.push({ label: "Worktree", value: String(card.worktree.path) });
  }
  facts.push({
    label: "Delivery",
    value: `${deliveryOutcomeLabel(card.outcomeKind)} · ${capitalize(card.deliverySatisfaction)}`,
  });
  if (card.childAgents.latestSummary !== undefined) {
    facts.push({ label: "Latest agent", value: card.childAgents.latestSummary });
  }
  if (card.lastMeaningfulActivityAt !== null) {
    facts.push({
      label: "Last activity",
      value: new Date(String(card.lastMeaningfulActivityAt)).toLocaleString(),
    });
  }
  return facts;
}

function withStaleness(value: string, freshness: CodeBoardCard["githubFreshness"]): string {
  return freshness === "stale" ? `${value} · stale` : value;
}

function observedChangesLabel(
  changes: Extract<CodeBoardCard["changedFiles"], { readonly kind: "observed" }>,
): string {
  if (changes.workingTreeClean && changes.changedPathCount === 0 && changes.stagedCount === 0) {
    return changes.committedAhead > 0
      ? `Working tree clean · ${changes.committedAhead} committed ahead`
      : "Working tree clean";
  }
  const files = `${changes.changedPathCount} changed ${changes.changedPathCount === 1 ? "file" : "files"}`;
  return `${files} · ${changes.stagedCount} staged · ${changes.committedAhead} committed ahead`;
}

function childAgentsLabel(agents: CodeBoardCard["childAgents"]): string | undefined {
  const parts: string[] = [];
  if (agents.active > 0) parts.push(`${agents.active} active`);
  if (agents.completed > 0) parts.push(`${agents.completed} completed`);
  if (agents.failed > 0) parts.push(`${agents.failed} failed`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function boardStatusBadgeClass(status: CodeBoardCard["status"]): string {
  switch (status) {
    case "ready":
      return "badge";
    case "in-progress":
      return "badge badge-accent";
    case "waiting":
      return "badge badge-warn";
    case "done":
      return "badge badge-ok";
  }
}

function lifecycleBadgeClass(lifecycle: CodeThreadNavigationItem["lifecycle"]): string {
  switch (lifecycle) {
    case "waiting":
      return "badge badge-warn";
    case "interrupted":
      return "badge badge-danger";
    case "active":
    case "archived":
      return "badge";
  }
}

function CodeProjectQuickStart(props: {
  readonly controller: CodeController;
  readonly projectId: ProjectId;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly baseRepository?: string;
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
  ) => boolean | void | Promise<boolean | void>;
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
            {...(props.baseRepository === undefined
              ? {}
              : { baseRepository: props.baseRepository })}
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
