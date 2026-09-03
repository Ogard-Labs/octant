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
import { suggestCodeDeliveryOutcome } from "@octant/domain/delivery-target-policy";
import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";
import { FolderOpen, GitBranch, Paperclip } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ComposerModelPicker } from "../../providers/ComposerModelPicker";
import { ThreadComposer } from "../../composer/ThreadComposer";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { CodeBranchSelector } from "./CodeBranchSelector";
import { CodeComposerAccessMenu } from "./CodeComposerAccessMenu";
import { CodeWorkspaceSelector } from "./CodeWorkspaceSelector";
import { CodeWorktreeSourceControl } from "./CodeWorktreeSourceControl";
import { useCodeWorktreeSourcePreview } from "./useCodeWorktreeSourcePreview";
import { clipboardHasImage } from "../../chat/composerImagePaste";
import {
  selectedModelReadsImages,
  useWorkComposerImages,
} from "../../work/composer/useWorkComposerImages";
import { WorkImageAttachmentChips } from "../../work/composer/WorkImageAttachmentChips";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../../chat/ThreadMentionPicker";
import { useThreadMentions } from "../../chat/useThreadMentions";
import { TrackerReferenceComposerHints } from "../../tracker/TrackerReferenceComposerHints";
import type {
  GithubIssueContextRequest,
  LinearIssueContextRequest,
  MentionableThreadId,
} from "@octant/contracts";
import type { CodeCommand, CodeCommandResult, CodeWorktreeRef } from "@octant/contracts/code";

export const CODE_DELIVERY_OUTCOME_LABELS: Record<CodeDeliveryOutcomeKind, string> = {
  "investigation-result": "Investigation result",
  "local-implementation": "Local implementation",
  "opened-pr": "Opened pull request",
  "merged-pr": "Merged pull request",
};

export interface CodeComposerAdapterProps {
  readonly projectId?: ProjectId;
  /** False when the server says the selected Code Project is unavailable. */
  readonly projectAvailable?: boolean;
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
  /** Reports the composer-local access posture to the shell. */
  readonly onExecutionPolicyChange?: (executionPolicy: ProviderExecutionPolicy) => void;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  readonly onCreateThread: (
    input: CodeComposerSubmitInput,
  ) => boolean | void | Promise<boolean | void>;
  readonly onCancel: () => void;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
  readonly folderControl?: ReactNode;
  /**
   * Optional GitHub repository selection slot rendered on the context tray.
   * Host, Octant Project, and GitHub repository stay distinct visible selections.
   */
  readonly githubControl?: ReactNode;
  readonly createFromControl?: ReactNode;
  /** Ready-made prompts shown under the composer; choosing one fills the prompt. */
  readonly suggestions?: ReadonlyArray<CodeComposerSuggestion>;
  /** Content shown under the composer (what is waiting, what to continue). */
  readonly beneath?: ReactNode;
  /**
   * A prompt handed in from beneath the composer, such as an assigned issue
   * chosen from "Up next". Each new revision replaces the draft and focuses
   * the prompt; the same revision is never applied twice.
   */
  readonly promptRequest?: { readonly text: string; readonly revision: number };
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
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export interface CodeComposerSuggestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
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
  readonly images?: ReadonlyArray<File>;
  readonly threadMentionIds?: ReadonlyArray<MentionableThreadId>;
  readonly issueContext?: GithubIssueContextRequest;
  readonly linearIssueContext?: LinearIssueContextRequest;
}

export function CodeComposerAdapter(props: CodeComposerAdapterProps) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appliedPromptRevision = useRef<number | undefined>(undefined);
  const promptRequest = props.promptRequest;
  useEffect(() => {
    if (promptRequest === undefined || appliedPromptRevision.current === promptRequest.revision) {
      return;
    }
    appliedPromptRevision.current = promptRequest.revision;
    setPrompt(promptRequest.text);
    textareaRef.current?.focus();
  }, [promptRequest]);
  const applySuggestion = (suggestion: CodeComposerSuggestion) => {
    setPrompt(suggestion.prompt);
    textareaRef.current?.focus();
  };
  const mentionListId = "code-new-thread-mentions";
  const images = useWorkComposerImages();
  const imageSupport = selectedModelReadsImages(props.providerGroups, {
    ...(props.selectedProviderInstanceId === undefined
      ? {}
      : { providerInstanceId: props.selectedProviderInstanceId }),
    ...(props.selectedModelId === undefined ? {} : { modelId: props.selectedModelId }),
  });
  const threadMentions = useThreadMentions({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: prompt,
  });
  const mention = useThreadMentionTypeahead({
    mentions: threadMentions.composer,
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
    ...(props.creating === true ? { disabled: true } : {}),
  });
  const [executionPolicy, setExecutionPolicy] = useState(props.defaultExecutionPolicy);
  const onExecutionPolicyChange = props.onExecutionPolicyChange;
  useEffect(() => {
    onExecutionPolicyChange?.(executionPolicy);
  }, [executionPolicy, onExecutionPolicyChange]);
  const [permissionPersistence, setPermissionPersistence] = useState(
    props.defaultPermissionPersistence,
  );
  // F2: the default delivery branch must never collide with the base branch
  // (e.g. `development`), which normally exists. Derive a unique
  // `octant/<short-id>` default once from a stable short id.
  const [shortId] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID !== undefined
      ? crypto.randomUUID().slice(0, 8)
      : "new",
  );
  const initialBaseBranch = props.baseBranch ?? props.branchName ?? "development";
  // The delivery target is derived from the tray, not typed into a form: the
  // base branch is the branch picker, the base repository is the connected
  // GitHub repository (or the local Project), and the remote is the one the
  // worktree starts from. A separate "Delivery target" form asked the person
  // to restate choices the tray already showed.
  const baseRepository =
    props.baseRepository ??
    (props.projectName === undefined || props.projectName.trim() === ""
      ? "local/repository"
      : `local/${props.projectName}`);
  const [baseBranch, setBaseBranch] = useState(initialBaseBranch);
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
      : (props.remoteName ?? "origin"));
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
  // The delivery outcome follows the prompt; the thread board and overview
  // show it once the thread exists.
  const outcomeKind: CodeDeliveryOutcomeKind = useMemo(
    () => suggestCodeDeliveryOutcome(prompt),
    [prompt],
  );
  const trimmed = prompt.trim();
  // A Code thread belongs to a Project (decision 0037), so the first turn
  // cannot start until one is chosen.
  const [submitting, setSubmitting] = useState(false);
  const canSubmit =
    trimmed.length > 0 && !props.creating && !submitting && props.projectId !== undefined;

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
    setSubmitting(true);
    const staged = images.filesForSend();
    void threadMentions
      .resolveForSend()
      .then(async (threadMentionIds) => {
        const created = await props.onCreateThread({
          prompt: trimmed,
          executionPolicy,
          permissionPersistence,
          deliveryTarget: {
            branchIntent: defaultDeliveryBranchIntent(baseBranch.trim() || "development", shortId),
            remoteName: resolvedWorktreeRemote,
            proposedBaseRepository: baseRepository,
            proposedBaseBranch: baseBranch.trim() || "development",
            outcomeKind,
          },
          workspace,
          worktreeSource: {
            startFromOrigin,
            remoteName: resolvedWorktreeRemote,
          },
          ...(staged.length === 0 ? {} : { images: staged }),
          ...(threadMentionIds.length === 0 ? {} : { threadMentionIds }),
        });
        if (created !== false) images.clearAfterAccepted();
        return created;
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [
    canSubmit,
    trimmed,
    executionPolicy,
    permissionPersistence,
    workspace,
    baseRepository,
    baseBranch,
    shortId,
    outcomeKind,
    startFromOrigin,
    resolvedWorktreeRemote,
    images,
    threadMentions,
    props,
  ]);

  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (items === null) return false;
    if (!clipboardHasImage(items)) return false;
    if (imageSupport === false) {
      images.refuse("The selected model does not accept images. Choose an image-capable model.");
      return true;
    }
    return images.consumePaste(items);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.handleKeyDown(event)) return;
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

  const hasProject = props.projectId !== undefined;
  const projectControl =
    props.folderControl ??
    (props.projectName === undefined ? null : (
      <span className="composer-tray__item" title={props.projectRoot}>
        <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
        <span>{props.projectName}</span>
      </span>
    ));
  const branchControl = hasProject ? (
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
  ) : (
    <span className="composer-tray__item">
      <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
      <span>{props.branchName ?? "Default branch"}</span>
    </span>
  );
  const environmentControl = (
    <HostSelector
      presentation="environment"
      {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
      {...(props.selectedHostId === undefined ? {} : { selectedHostId: props.selectedHostId })}
      {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
      {...(props.lastSelectedHealthyHostId === undefined
        ? {}
        : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
      {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
      {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
      requiredCapability="code"
    />
  );
  return (
    <section aria-label="New Code thread" className="code-composer-adapter">
      <div className="welcome">
        <div className="welcome__heading">
          <h1 className="oct-title oct-title--hero">What should we build?</h1>
          {props.projectAvailable === false &&
          props.projectId !== undefined &&
          props.errorMessage === undefined ? (
            <p role="status">The selected Project is unavailable. Choose another Project.</p>
          ) : null}
        </div>

        <div className="composer-stack">
          <ThreadComposer
            chips={
              <>
                <ThreadMentionChips
                  chips={threadMentions.chips}
                  onRemove={(threadId) => threadMentions.composer?.onRemoveChip(threadId)}
                />
                <TrackerReferenceComposerHints draft={prompt} />
                <WorkImageAttachmentChips images={images} />
              </>
            }
            input={
              <OctantTextarea
                aria-label="First message"
                autoFocus
                className="composer-input"
                disabled={props.creating}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  mention.sync(event.target.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) =>
                  mention.sync(event.currentTarget.value, event.currentTarget.selectionStart)
                }
                onKeyDown={handleKeyDown}
                onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
                  if (props.creating === true) return;
                  if (attachFromTransfer(event.clipboardData)) event.preventDefault();
                }}
                placeholder="Describe what to build, ask a follow-up, or attach an image…"
                ref={textareaRef}
                rows={3}
                value={prompt}
              />
            }
            typeahead={
              mention.open ? (
                <ThreadMentionTypeahead
                  activeIndex={mention.activeIndex}
                  {...(threadMentions.composer?.busy === undefined
                    ? {}
                    : { busy: threadMentions.composer.busy })}
                  candidates={threadMentions.composer?.candidates ?? []}
                  listId={mentionListId}
                  onChoose={mention.choose}
                  onHover={mention.setActiveIndex}
                />
              ) : null
            }
            row={{
              className: "code-composer-adapter__composer-bar",
              leading: (
                <>
                  <label>
                    <span className="work-composer-adapter__visually-hidden">Add attachment</span>
                    {/* ui-boundary-exception: native-file-input */}
                    <input
                      aria-label="Choose attachment file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="work-composer-adapter__file-input"
                      disabled={props.creating === true || imageSupport === false}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.item(0);
                        if (file !== null && file !== undefined) {
                          if (imageSupport === false) {
                            images.refuse(
                              "The selected model does not accept images. Choose an image-capable model.",
                            );
                          } else {
                            images.attach([file]);
                          }
                        }
                        event.currentTarget.value = "";
                      }}
                      type="file"
                    />
                  </label>
                  <OctantButton
                    aria-label="Add attachment"
                    disabled={props.creating === true || imageSupport === false}
                    onClick={(event) => {
                      event.currentTarget.parentElement
                        ?.querySelector<HTMLInputElement>('input[type="file"]')
                        ?.click();
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Paperclip aria-hidden="true" size={16} strokeWidth={1.8} />
                  </OctantButton>

                  <span aria-hidden="true" className="composer-gap" />
                  <span className="code-composer-adapter__context-picker">
                    <ComposerModelPicker
                      ariaLabel="Provider and model"
                      groups={props.providerGroups}
                      menuSide="bottom"
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
                  <CodeComposerAccessMenu
                    onChange={setExecutionPolicy}
                    onPersistenceChange={setPermissionPersistence}
                    persistence={permissionPersistence}
                    value={executionPolicy}
                    {...(props.creating === true ? { disabled: true } : {})}
                  />
                </>
              ),
              actions: {
                kind: "send",
                send: {
                  ariaLabel:
                    props.errorMessage === undefined ? "Create thread" : "Retry creating thread",
                  disabled: !canSubmit,
                  onSend: submit,
                },
              },
            }}
            footer={
              <div className="composer-tray" aria-label="Thread context">
                <div className="composer-tray__leading">
                  {projectControl}
                  {branchControl}
                  {environmentControl}
                </div>
                <div className="composer-tray__trailing">
                  {hasProject ? (
                    <CodeWorkspaceSelector
                      onChange={setWorkspaceOverride}
                      value={workspace}
                      {...(props.creating === true ? { disabled: true } : {})}
                    />
                  ) : null}
                  {props.githubControl}
                  {props.createFromControl}
                </div>
              </div>
            }
          />
        </div>

        {/* Start from origin only decides where a new worktree branches from.
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

        {/* A draft of only spaces is empty to submit, so it is empty here too:
            the suggestions stay reachable instead of disappearing behind a
            stray space. */}
        {props.suggestions === undefined ||
        props.suggestions.length === 0 ||
        trimmed !== "" ? null : (
          <div aria-label="Suggested prompts" className="code-home__suggestions" role="group">
            {props.suggestions.map((suggestion) => (
              <OctantButton
                disabled={props.creating}
                key={suggestion.id}
                onClick={() => applySuggestion(suggestion)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {suggestion.label}
              </OctantButton>
            ))}
          </div>
        )}
        {props.beneath}

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
      </div>
    </section>
  );
}
