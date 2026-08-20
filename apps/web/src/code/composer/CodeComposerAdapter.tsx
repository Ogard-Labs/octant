import type { CodeCheckoutId, CodeRepositoryId } from "@octant/contracts/code";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import {
  DEFAULT_CODE_NEW_THREAD_WORKSPACE,
  type CodeNewThreadWorkspace,
  type ProjectId,
} from "@octant/contracts/projects";
import type {
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
  PermissionPersistence,
} from "@octant/contracts/providers";
import type { CreateHostViewScope, PickerGroup } from "@octant/domain";
import {
  defaultDeliveryBranchIntent,
  defaultStartFromOrigin,
  selectWorktreeRemote,
  type WorktreeRemoteFacts,
  type WorktreeSourceResolution,
} from "@octant/domain/code-worktree-source-policy";
import {
  CODE_DELIVERY_OUTCOME_ORDER,
  suggestCodeDeliveryOutcome,
} from "@octant/domain/delivery-target-policy";
import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";
import { ArrowUp, ShieldCheck, ChevronDown, ChevronUp, FolderOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ComposerModelPicker } from "../../providers/ComposerModelPicker";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantNativeSelect } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { CodeBranchSelector } from "./CodeBranchSelector";
import { CodeWorktreeSourceControl } from "./CodeWorktreeSourceControl";
import { useCodeWorktreeSourcePreview } from "./useCodeWorktreeSourcePreview";
import type { CodeCommand, CodeCommandResult, CodeWorktreeRef } from "@octant/contracts/code";

export const CODE_DELIVERY_OUTCOME_LABELS: Record<CodeDeliveryOutcomeKind, string> = {
  "investigation-result": "Investigation result",
  "local-implementation": "Local implementation",
  "opened-pr": "Opened pull request",
  "merged-pr": "Merged pull request",
};

export interface CodeComposerAdapterProps {
  readonly projectId?: ProjectId;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly repositoryId?: CodeRepositoryId;
  readonly checkoutId?: CodeCheckoutId;
  readonly branchName?: string;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: HostId;
  readonly fixedHostId?: HostId;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly viewScope?: CreateHostViewScope;
  readonly onSelectHost?: (hostId: HostId) => void;
  readonly remoteName?: string;
  readonly baseRepository?: string;
  readonly baseBranch?: string;
  readonly defaultExecutionPolicy: ProviderExecutionPolicy;
  readonly defaultPermissionPersistence: PermissionPersistence;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  readonly onCreateThread: (input: CodeComposerSubmitInput) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
  readonly folderControl?: ReactNode;
  /**
   * Optional GitHub repository selection slot rendered in the context strip.
   * Host, Octant Project, and GitHub repository stay distinct visible selections.
   */
  readonly githubControl?: ReactNode;
  /** Optional multi-model pool control slot rendered in the composer bar. */
  readonly poolControl?: ReactNode;
  /**
   * The selected Code Project's remembered habit for how new threads start. It only
   * preselects the Workspace control: choosing differently here overrides one thread
   * and never rewrites the Project setting.
   */
  readonly newThreadWorkspace?: CodeNewThreadWorkspace;
  readonly worktreeRemoteFacts?: WorktreeRemoteFacts;
  readonly worktreeResolution?: WorktreeSourceResolution;
  readonly execute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
}

export interface CodeComposerSubmitInput {
  readonly prompt: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly permissionPersistence: PermissionPersistence;
  readonly deliveryTarget: {
    readonly branchIntent: string;
    readonly remoteName: string;
    readonly proposedBaseRepository: string;
    readonly proposedBaseBranch: string;
    readonly outcomeKind: CodeDeliveryOutcomeKind;
  };
  /** The workspace this one thread starts in, after any per-thread override. */
  readonly workspace: CodeNewThreadWorkspace;
  readonly worktreeSource: {
    readonly startFromOrigin: boolean;
    readonly remoteName: string;
  };
}

export function CodeComposerAdapter(props: CodeComposerAdapterProps) {
  const [prompt, setPrompt] = useState("");
  const [executionPolicy, setExecutionPolicy] = useState(props.defaultExecutionPolicy);
  const [permissionPersistence, setPermissionPersistence] = useState(
    props.defaultPermissionPersistence,
  );
  const [showDelivery, setShowDelivery] = useState(false);
  // F2: the default delivery branch must never collide with the base branch
  // (e.g. `development`), which normally exists. Derive a unique
  // `octant/<short-id>` default once from a stable short id.
  const [shortId] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID !== undefined
      ? crypto.randomUUID().slice(0, 8)
      : "new",
  );
  const initialBaseBranch = props.baseBranch ?? props.branchName ?? "development";
  const [branchIntent, setBranchIntent] = useState(
    defaultDeliveryBranchIntent(initialBaseBranch, shortId),
  );
  const [remoteName, setRemoteName] = useState(props.remoteName ?? "origin");
  const [baseRepository, setBaseRepository] = useState(
    props.baseRepository ??
      (props.projectName === undefined || props.projectName.trim() === ""
        ? ""
        : `local/${props.projectName}`),
  );
  const [baseBranch, setBaseBranch] = useState(initialBaseBranch);
  // The delivery outcome is suggested from the prompt and confirmed by the
  // user. Until the user overrides it, it tracks the live prompt suggestion.
  const [outcomeOverride, setOutcomeOverride] = useState<CodeDeliveryOutcomeKind>();
  // F4: remote facts are server-authoritative. When the server has not
  // provided them, fail closed with no remotes so Start from origin is
  // disabled rather than fabricated.
  const worktreeRemoteFacts: WorktreeRemoteFacts = useMemo(
    () => props.worktreeRemoteFacts ?? { remotes: [] },
    [props.worktreeRemoteFacts],
  );
  const preferredRemote = selectWorktreeRemote(worktreeRemoteFacts);
  const [startFromOriginOverride, setStartFromOriginOverride] = useState<boolean>();
  // The Project habit is the preselection; the user may override it for this
  // one thread. Switching Projects drops the override so the next Project's
  // own habit is honored rather than the previous Project's choice.
  const [workspaceOverride, setWorkspaceOverride] = useState<CodeNewThreadWorkspace>();
  const workspace =
    workspaceOverride ?? props.newThreadWorkspace ?? DEFAULT_CODE_NEW_THREAD_WORKSPACE;
  const startFromOrigin = startFromOriginOverride ?? defaultStartFromOrigin(worktreeRemoteFacts);
  const [worktreeRemote, setWorktreeRemote] = useState<string | undefined>(
    preferredRemote.status === "selected" ? preferredRemote.remoteName : undefined,
  );
  const resolvedWorktreeRemote =
    worktreeRemote ??
    (preferredRemote.status === "selected"
      ? preferredRemote.remoteName
      : remoteName.trim() || "origin");
  const previewExecute = useCallback(
    async (command: CodeCommand, signal?: AbortSignal) =>
      props.execute === undefined ? undefined : props.execute(command, signal),
    [props.execute],
  );
  const sourcePreview = useCodeWorktreeSourcePreview({
    execute: previewExecute,
    ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
    branch: baseBranch.trim() || "development",
    startFromOrigin,
    remoteName: resolvedWorktreeRemote,
    enabled: props.projectId !== undefined && props.execute !== undefined,
  });
  const suggestedOutcome = useMemo(() => suggestCodeDeliveryOutcome(prompt), [prompt]);
  const outcomeKind = outcomeOverride ?? suggestedOutcome;
  const trimmed = prompt.trim();
  // A Code thread belongs to a Project (decision 0037), so the first turn
  // cannot start until one is chosen.
  const canSubmit = trimmed.length > 0 && !props.creating && props.projectId !== undefined;

  // Server-authoritative ref catalog for the branch selector, fetched lazily
  // the first time the selector opens.
  const [worktreeRefs, setWorktreeRefs] = useState<ReadonlyArray<CodeWorktreeRef>>();
  const [refsLoading, setRefsLoading] = useState(false);
  const projectId = props.projectId;
  const execute = props.execute;
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
    setWorktreeRefs(undefined);
    setRefsLoading(false);
    setWorkspaceOverride(undefined);
  }, [projectId]);
  const loadWorktreeRefs = useCallback(() => {
    if (projectId === undefined || execute === undefined) return;
    const requestedProjectId = projectId;
    setRefsLoading(true);
    void execute({ kind: "list-code-worktree-refs", projectId: requestedProjectId })
      .then((result) => {
        if (requestedProjectId !== projectIdRef.current) return;
        if (result?.kind === "worktree-refs-listed") setWorktreeRefs(result.refs);
      })
      .catch(() => undefined)
      .finally(() => {
        if (requestedProjectId === projectIdRef.current) setRefsLoading(false);
      });
  }, [projectId, execute]);
  const handleSelectRef = useCallback(
    (ref: CodeWorktreeRef) => {
      if (ref.kind === "remote" && ref.remoteName !== undefined) {
        const branch = ref.name.startsWith(`${ref.remoteName}/`)
          ? ref.name.slice(ref.remoteName.length + 1)
          : ref.name;
        setBaseBranch(branch);
        setWorktreeRemote(ref.remoteName);
        setStartFromOriginOverride(true);
      } else {
        setBaseBranch(ref.name);
        setStartFromOriginOverride(false);
      }
    },
    [setBaseBranch, setWorktreeRemote, setStartFromOriginOverride],
  );

  const submit = useCallback(() => {
    if (!canSubmit) return;
    void props.onCreateThread({
      prompt: trimmed,
      executionPolicy,
      permissionPersistence,
      deliveryTarget: {
        branchIntent: branchIntent.trim() || defaultDeliveryBranchIntent(baseBranch, shortId),
        remoteName: remoteName.trim() || "origin",
        proposedBaseRepository:
          baseRepository.trim() ||
          (props.projectName === undefined || props.projectName.trim() === ""
            ? "local/repository"
            : `local/${props.projectName}`),
        proposedBaseBranch: baseBranch.trim() || "development",
        outcomeKind,
      },
      workspace,
      worktreeSource: {
        startFromOrigin,
        remoteName: resolvedWorktreeRemote,
      },
    });
  }, [
    canSubmit,
    trimmed,
    executionPolicy,
    permissionPersistence,
    workspace,
    branchIntent,
    remoteName,
    baseRepository,
    baseBranch,
    shortId,
    outcomeKind,
    startFromOrigin,
    preferredRemote,
    resolvedWorktreeRemote,
    props,
  ]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (props.creating && props.onCancelFirstTurn !== undefined) {
        props.onCancelFirstTurn();
      } else {
        props.onCancel();
      }
    }
  }

  return (
    <section aria-label="New Code thread" className="code-composer-adapter">
      <div className="code-composer-adapter__canvas">
        <div className="code-composer-adapter__welcome">
          <p className="code-composer-adapter__eyebrow">Octant Code</p>
          <h1 className="code-composer-adapter__heading">What should we build?</h1>
          <p className="code-composer-adapter__description">
            {props.projectId === undefined
              ? "Choose a Project to build in. Its repository is the checkout this thread works against."
              : "Start a Code thread in this repository. The thread inherits the current checkout and approval policy."}
          </p>
        </div>

        <div className="code-composer-adapter__composer">
          <div className="code-composer-adapter__input-row">
            <OctantTextarea
              aria-label="First message"
              autoFocus
              className="code-composer-adapter__textarea"
              disabled={props.creating}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe the change…"
              rows={3}
              value={prompt}
            />
            <div className="code-composer-adapter__composer-bar">
              <span className="code-composer-adapter__context-picker">
                <ComposerModelPicker
                  ariaLabel="Provider and model"
                  groups={props.providerGroups}
                  onSelect={props.onSelectProvider}
                  {...(props.selectedModelId === undefined
                    ? {}
                    : { selectedModelId: props.selectedModelId })}
                  {...(props.selectedProviderInstanceId === undefined
                    ? {}
                    : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
                />
              </span>
              {props.poolControl}
              <span className="code-composer-adapter__context-item">
                <ShieldCheck aria-hidden="true" size={12} strokeWidth={1.8} />
                <OctantNativeSelect
                  aria-label="Access policy"
                  className="code-composer-adapter__policy-select"
                  onChange={(e) => setExecutionPolicy(e.target.value as ProviderExecutionPolicy)}
                  value={executionPolicy}
                >
                  <option value="plan">Plan</option>
                  <option value="approval-gated">Approval</option>
                  <option value="auto-accept-edits">Auto-accept edits</option>
                  <option value="full-access">Full access</option>
                </OctantNativeSelect>
              </span>
              <OctantButton
                aria-label={
                  props.errorMessage === undefined ? "Create thread" : "Retry creating thread"
                }
                className="code-composer-adapter__send"
                disabled={!canSubmit}
                onClick={submit}
                size="icon"
                type="button"
                variant="default"
              >
                <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
              </OctantButton>
            </div>
          </div>

          <div className="code-composer-adapter__context-strip" aria-label="Thread context">
            <HostSelector
              {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
              {...(props.selectedHostId === undefined
                ? {}
                : { selectedHostId: props.selectedHostId })}
              {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
              {...(props.lastSelectedHealthyHostId === undefined
                ? {}
                : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
              {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
              {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
              requiredCapability="code"
            />
            {props.folderControl}
            {props.folderControl === undefined && props.projectName !== undefined ? (
              <span className="code-composer-adapter__context-item" title={props.projectRoot}>
                <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>{props.projectName}</span>
              </span>
            ) : null}
            {props.githubControl}
            {props.projectId === undefined ? null : (
              <span className="code-composer-adapter__context-item">
                <OctantNativeSelect
                  aria-label="Workspace"
                  className="code-composer-adapter__policy-select"
                  onChange={(e) => setWorkspaceOverride(e.target.value as CodeNewThreadWorkspace)}
                  {...(props.creating === true ? { disabled: true } : {})}
                  value={workspace}
                >
                  <option value="current-checkout">Current checkout</option>
                  <option value="managed-worktree">Managed worktree</option>
                </OctantNativeSelect>
              </span>
            )}
            {props.projectId !== undefined ? (
              <CodeBranchSelector
                key={String(props.projectId)}
                branch={baseBranch.trim() || "development"}
                loading={refsLoading}
                onOpen={loadWorktreeRefs}
                onSelectRef={handleSelectRef}
                onStartFromOriginChange={setStartFromOriginOverride}
                remoteName={resolvedWorktreeRemote}
                startFromOrigin={startFromOrigin}
                startFromOriginAvailable={
                  preferredRemote.status === "selected" || worktreeRemote !== undefined
                }
                {...(worktreeRefs === undefined ? {} : { refs: worktreeRefs })}
                {...(props.creating === true ? { disabled: true } : {})}
              />
            ) : props.branchName !== undefined ? (
              <span className="code-composer-adapter__context-item">
                <span>{props.branchName}</span>
              </span>
            ) : null}
            <OctantButton
              aria-expanded={showDelivery}
              className="code-composer-adapter__disclosure-toggle"
              onClick={() => setShowDelivery(!showDelivery)}
              type="button"
              variant="ghost"
            >
              {showDelivery ? (
                <ChevronUp aria-hidden="true" size={12} />
              ) : (
                <ChevronDown aria-hidden="true" size={12} />
              )}
              <span>Delivery target</span>
            </OctantButton>
          </div>

          {/* Start from origin decides where a *new* worktree branches from.
              Binding the current checkout resolves no source, so the control
              would be a lie rather than a choice. */}
          {props.projectId === undefined || workspace !== "managed-worktree" ? null : (
            <CodeWorktreeSourceControl
              branch={baseBranch.trim() || "development"}
              {...(props.execute !== undefined ? { onRefresh: sourcePreview.refresh } : {})}
              onSelectRemote={setWorktreeRemote}
              onStartFromOriginChange={setStartFromOriginOverride}
              remoteFacts={worktreeRemoteFacts}
              resolution={
                props.execute !== undefined
                  ? sourcePreview.resolution
                  : (props.worktreeResolution ?? { kind: "idle" })
              }
              selectedRemote={resolvedWorktreeRemote}
              startFromOrigin={startFromOrigin}
            />
          )}

          {showDelivery ? (
            <div className="code-composer-adapter__delivery" aria-label="Delivery target">
              <label className="code-composer-adapter__field">
                <span>Outcome</span>
                <OctantNativeSelect
                  aria-label="Delivery outcome"
                  onChange={(e) => setOutcomeOverride(e.target.value as CodeDeliveryOutcomeKind)}
                  value={outcomeKind}
                >
                  {CODE_DELIVERY_OUTCOME_ORDER.map((kind) => (
                    <option key={kind} value={kind}>
                      {CODE_DELIVERY_OUTCOME_LABELS[kind]}
                    </option>
                  ))}
                </OctantNativeSelect>
              </label>
              <label className="code-composer-adapter__field">
                <span>Branch</span>
                <OctantInput
                  aria-label="Branch intent"
                  onChange={(e) => setBranchIntent(e.target.value)}
                  value={branchIntent}
                />
              </label>
              <label className="code-composer-adapter__field">
                <span>Remote</span>
                <OctantInput
                  aria-label="Remote name"
                  onChange={(e) => setRemoteName(e.target.value)}
                  value={remoteName}
                />
              </label>
              <label className="code-composer-adapter__field">
                <span>Base repository</span>
                <OctantInput
                  aria-label="Base repository"
                  onChange={(e) => setBaseRepository(e.target.value)}
                  placeholder="owner/repository"
                  value={baseRepository}
                />
              </label>
              <label className="code-composer-adapter__field">
                <span>Base branch</span>
                <OctantInput
                  aria-label="Base branch"
                  onChange={(e) => setBaseBranch(e.target.value)}
                  value={baseBranch}
                />
              </label>
              <label className="code-composer-adapter__field">
                <span>Permission duration</span>
                <OctantNativeSelect
                  aria-label="Permission persistence"
                  onChange={(e) =>
                    setPermissionPersistence(e.target.value as PermissionPersistence)
                  }
                  value={permissionPersistence}
                >
                  <option value="current-session">Current session</option>
                  <option value="project-default">Project default</option>
                </OctantNativeSelect>
              </label>
            </div>
          ) : null}

          {props.errorMessage !== undefined ? (
            <p className="code-composer-adapter__error" role="alert">
              {props.errorMessage}
            </p>
          ) : null}
          {props.creating ? (
            <div>
              <p aria-label="First-turn status" role="status">
                {props.pendingMessage ?? "Starting the first turn…"}
              </p>
              {props.onCancelFirstTurn === undefined ? null : (
                <OctantButton
                  onClick={props.onCancelFirstTurn}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel first turn
                </OctantButton>
              )}
            </div>
          ) : null}
          <p className="code-composer-adapter__hint">
            Press Enter to start · Shift+Enter for a new line · Escape to close
          </p>
        </div>
      </div>
    </section>
  );
}
