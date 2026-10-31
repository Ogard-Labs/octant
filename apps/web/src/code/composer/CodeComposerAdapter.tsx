import { useDraftModelOptions } from "../../providers/useDraftModelOptions";
import {
  mentionChipsFromDraft,
  mentionChipsToDraft,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
  useNewTaskPrompt,
} from "../../composer/useNewTaskPrompt";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { useExtensionDraftSelections } from "../../chat/useExtensionDraftSelections";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
} from "../../composer/useComposerSlashCommands";
import { ComposerAtTypeahead, useComposerAtMenu } from "../../composer/useComposerAtMenu";
import { ComposerAttachButton } from "../../composer/ComposerAttachButton";
import { StartSuggestionChip } from "../../composer/StartSuggestionChip";
import type { CodeCheckoutId, CodeRepositoryId } from "@octant/contracts/code";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import {
  DEFAULT_CODE_NEW_THREAD_WORKSPACE,
  type CodeNewThreadWorkspace,
  type ProjectId,
} from "@octant/contracts/projects";
import type {
  PermissionMode,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
  PermissionPersistence,
} from "@octant/contracts/providers";
import {
  draftThreadModePresentation,
  type CreateHostViewScope,
  type PickerGroup,
} from "@octant/domain";
import {
  defaultDeliveryBranchIntent,
  defaultStartFromOrigin,
  selectWorktreeRemote,
  type WorktreeRemoteFacts,
  type WorktreeSourceResolution,
} from "@octant/domain/code-worktree-source-policy";
import { suggestCodeDeliveryOutcome } from "@octant/domain/delivery-target-policy";
import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";
import { FolderOpen } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ComposerModelPicker } from "../../providers/ComposerModelPicker";
import { providerFamilyForThread } from "../../providers/providerFamily";
import { ThreadComposer } from "../../composer/ThreadComposer";
import { WelcomeHeading } from "../../composer/WelcomeHeading";
import { ComposerVoiceButton } from "../../voice/ComposerVoiceButton";
import { appendTranscript } from "../../voice/appendTranscript";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { CodeBranchSelector } from "./CodeBranchSelector";
import { threadAccessOf } from "@octant/domain/guardrail-policy";
import { PermissionModePicker } from "../PermissionModePicker";
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
import { useComposerThreadDropRegistration } from "../../chat/composerThreadDrop";
import { TrackerReferenceComposerHints } from "../../tracker/TrackerReferenceComposerHints";
import type {
  GithubIssueContextRequest,
  LinearIssueContextRequest,
  MentionableThreadId,
} from "@octant/contracts";
import type { CodeCommand, CodeCommandResult, CodeWorktreeRef } from "@octant/contracts/code";
import type { OctantHostBridge } from "../../shell/hostBridge";
import { boundsInsideViewport } from "../../browser/useNativeBrowserSurface";
import { observeComposerPlacement } from "../codeWorkspaceApprovals";
import { OctantAlert } from "../../ui/base/OctantAlert";

export interface CodeComposerAdapterProps {
  readonly projectId?: ProjectId;
  /** False when the server says the selected Code Project is unavailable. */
  readonly projectAvailable?: boolean;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly repositoryId?: CodeRepositoryId;
  readonly checkoutId?: CodeCheckoutId;
  /**
   * The branch this draft was opened for, such as the failing pull request's
   * branch from Start a fix. It is a decision, not a seed: the draft starts a
   * worktree from it, and the checkout's head does not replace it.
   */
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
  /** The mode the new thread starts in: the Project's, else Settings'. */
  readonly defaultPermissionMode: PermissionMode;
  readonly defaultPermissionPersistence: PermissionPersistence;
  readonly onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Whether the selected provider has a reviewer of its own, so Auto applies. */
  readonly autoSupported?: boolean;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  /** Opens Providers & Models from the start composer while none is ready. */
  readonly onOpenSettings?: () => void;
  readonly onCreateThread: (
    input: CodeComposerSubmitInput,
  ) => boolean | void | Promise<boolean | void>;
  readonly onCancel: () => void;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
  readonly folderControl?: ReactNode;
  readonly projectSetup?: ReactNode;
  /**
   * Optional GitHub repository selection slot rendered on the context tray.
   * Host, Octant Project, and GitHub repository stay distinct visible selections.
   */
  readonly createFromControl?: ReactNode;
  /** Ready-made prompts shown under the composer; choosing one fills the prompt. */
  readonly suggestions?: ReadonlyArray<CodeComposerSuggestion>;
  /**
   * The start screen's action tiles and Running now strip, directly under the
   * composer and its suggestions, ahead of the sections in `beneath`.
   */
  readonly homeStart?: ReactNode;
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
  readonly hostBridge?: OctantHostBridge;
  readonly extensionClient?: ExtensionClient;
}

export interface CodeComposerSuggestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

export interface CodeComposerSubmitInput {
  readonly modelOptionValues?: ProviderModelOptionValues;
  readonly computerUseSelection?: ExtensionSelection;
  readonly extensionSelections?: ReadonlyArray<ExtensionSelection>;
  readonly prompt: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly permissionPersistence: PermissionPersistence;
  /** Start in Auto: the provider's reviewer answers the thread's prompts. */
  readonly autoApprove?: boolean;
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
  /** Local draft identity used only to anchor a native approval view. */
  readonly presentation?: { readonly composerId: string };
}

/**
 * Used only when the host could never name the base branch. Kept out of every
 * visible surface so the tray never asserts a branch the repository may not
 * have.
 */
const LAST_RESORT_BASE_BRANCH = "development";

export function CodeComposerAdapter(props: CodeComposerAdapterProps) {
  const suggestionDescriptionId = useId();
  const providerGroups = props.providerGroups;
  const [prompt, setPrompt] = useNewTaskPrompt();
  const drafts = useContext(NewTaskDraftsContext);
  const draftScope = useContext(NewTaskDraftScopeContext);
  const storedCheckout =
    draftScope === undefined ? undefined : drafts?.readCodeCheckout(draftScope);
  const storedMentionChips = mentionChipsFromDraft(
    draftScope === undefined || drafts === undefined ? [] : drafts.readMentionChips(draftScope),
  );
  const storedExtensionReceipts =
    draftScope === undefined || drafts === undefined
      ? []
      : drafts.readExtensionReceipts(draftScope);
  const { modelKey, modelOptionValues, setModelChoice } = useDraftModelOptions(
    providerGroups,
    props.selectedProviderInstanceId,
    props.selectedModelId,
  );

  const selectedFamily = providerFamilyForThread(providerGroups, props.selectedProviderInstanceId);
  const extensionDraft = useExtensionDraftSelections({
    ...(props.extensionClient === undefined ? {} : { client: props.extensionClient }),
    mode: "code",
    projectId: props.projectId ?? null,
    ...(selectedFamily === undefined ? {} : { providerFamily: selectedFamily }),
    ...(storedExtensionReceipts.length === 0 ? {} : { initialReceipts: storedExtensionReceipts }),
  });
  const slash = useComposerSlashCommands({
    textarea: () => textareaRef.current,
    draft: prompt,
    onDraftChange: setPrompt,
  });
  const atMenu = useComposerAtMenu({
    textarea: () => textareaRef.current,
    draft: prompt,
    onDraftChange: setPrompt,
    onResolveExtensionReference: extensionDraft.resolveReference,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerIdRef = useRef(globalThis.crypto.randomUUID());
  useEffect(() => {
    const update = props.hostBridge?.updateCodeOperationApprovalAnchor;
    if (update === undefined || props.projectId === undefined) return;
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const composer = textareaRef.current?.closest<HTMLElement>(".thread-composer");
      if (composer === undefined || composer === null) return;
      const rect = composer.getBoundingClientRect();
      void update({
        kind: "draft",
        projectId: String(props.projectId),
        composerId: composerIdRef.current,
        bounds: boundsInsideViewport(rect, window.innerWidth, window.innerHeight),
      }).catch(() => undefined);
    };
    const resize = new ResizeObserver(sync);
    const composer = textareaRef.current?.closest<HTMLElement>(".thread-composer");
    if (composer !== undefined && composer !== null) {
      observeComposerPlacement(composer, resize);
    }
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    sync();
    return () => {
      disposed = true;
      resize.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      const cancel = props.hostBridge?.cancelCodeOperationApproval;
      if (cancel !== undefined) void cancel().catch(() => undefined);
    };
  }, [props.hostBridge, props.projectId]);
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
  const imageSupport = selectedModelReadsImages(providerGroups, {
    ...(props.selectedProviderInstanceId === undefined
      ? {}
      : { providerInstanceId: props.selectedProviderInstanceId }),
    ...(props.selectedModelId === undefined ? {} : { modelId: props.selectedModelId }),
  });
  const threadMentions = useThreadMentions({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: prompt,
    ...(storedMentionChips.length === 0 ? {} : { initialChips: storedMentionChips }),
  });
  const mention = useThreadMentionTypeahead({
    mentions: threadMentions.composer,
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
    ...(props.creating === true ? { disabled: true } : {}),
  });
  const threadDropKey = useComposerThreadDropRegistration({
    enabled: threadMentions.composer !== undefined,
    onDraftChange: (next) => setPrompt(next),
    attachDroppedThread: threadMentions.attachDroppedThread,
  });
  const [permissionMode, setPermissionMode] = useState(
    storedCheckout?.permissionMode ?? props.defaultPermissionMode,
  );
  const [permissionPersistence] = useState(
    storedCheckout?.permissionPersistence ?? props.defaultPermissionPersistence,
  );
  const { executionPolicy, autoApprove } = threadAccessOf(permissionMode);
  // F2: the default delivery branch must never collide with the base branch
  // (e.g. `development`), which normally exists. Derive a unique
  // `octant/<short-id>` default once from a stable short id.
  const [shortId] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID !== undefined
      ? crypto.randomUUID().slice(0, 8)
      : "new",
  );
  // Unknown until the host says. Neither caller supplies a branch for a
  // Project-bound composer, so seeding a literal here meant the tray asserted
  // `development` for every repository, including the ones on `main`.
  const skipProjectReset = useRef(storedCheckout !== undefined);
  const initialBaseBranch =
    storedCheckout?.baseBranch ?? props.branchName ?? props.baseBranch ?? "";
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
  // Whether the branch on screen is the reader's own pick. A seeded base branch
  // is a starting value, not a decision: the checkout's actual head outranks it,
  // and only a pick from the ref list outranks the head. A branch the draft was
  // opened for is already chosen; read as a seed, the head replaced it and Start
  // a fix created the thread from `main` while the tray named the failing branch.
  const handedBranch = props.branchName;
  const baseBranchChosen = useRef(storedCheckout?.baseBranchChosen ?? handedBranch !== undefined);
  // F4: remote facts are server-authoritative. When the server has not
  // provided them, fail closed with no remotes so Start from origin is
  // disabled rather than fabricated.
  const worktreeRemoteFacts: WorktreeRemoteFacts = useMemo(
    () => props.worktreeRemoteFacts ?? { remotes: [] },
    [props.worktreeRemoteFacts],
  );
  const preferredRemote = selectWorktreeRemote(worktreeRemoteFacts);
  const [startFromOriginOverride, setStartFromOriginOverride] = useState<boolean | undefined>(
    storedCheckout?.startFromOriginOverride,
  );
  // The Project habit is the preselection; the user may override it for this
  // one thread. Switching Projects drops the override so the next Project's
  // own habit is honored rather than the previous Project's choice.
  // The current checkout keeps whatever branch it is on, so a draft opened for
  // a branch starts a worktree from that branch instead.
  const handedWorkspace: CodeNewThreadWorkspace | undefined =
    handedBranch === undefined ? undefined : "managed-worktree";
  const [workspaceOverride, setWorkspaceOverride] = useState<CodeNewThreadWorkspace | undefined>(
    storedCheckout?.workspaceOverride ?? handedWorkspace,
  );
  const workspace: CodeNewThreadWorkspace =
    workspaceOverride ?? props.newThreadWorkspace ?? DEFAULT_CODE_NEW_THREAD_WORKSPACE;
  const startFromOrigin = startFromOriginOverride ?? defaultStartFromOrigin(worktreeRemoteFacts);
  const [worktreeRemote, setWorktreeRemote] = useState<string | undefined>(
    storedCheckout?.worktreeRemote ??
      (preferredRemote.status === "selected" ? preferredRemote.remoteName : undefined),
  );
  const resolvedWorktreeRemote =
    worktreeRemote ??
    (preferredRemote.status === "selected"
      ? preferredRemote.remoteName
      : (props.remoteName ?? "origin"));
  /**
   * The base branch as a value, not a guess.
   *
   * `undefined` means the host has not said yet. Every caller below decides
   * for itself what that means: the tray says "Default branch", the source
   * preview stays off rather than previewing a branch nobody picked, and the
   * delivery target is only proposed once there is something true to propose.
   */
  const resolvedBaseBranch = baseBranch.trim() === "" ? undefined : baseBranch.trim();
  /**
   * What a submitted delivery target names as its base.
   *
   * The contract requires a non-empty branch, so a host that cannot list refs
   * still needs one. This is the only place a name is assumed rather than
   * observed, and it is never shown: the tray says "Default branch" until the
   * host has actually named the branch, so nothing on screen asserts it.
   */
  const submittedBaseBranch = resolvedBaseBranch ?? LAST_RESORT_BASE_BRANCH;
  const previewExecute = useCallback(
    async (command: CodeCommand, signal?: AbortSignal) =>
      props.execute === undefined ? undefined : props.execute(command, signal),
    [props.execute],
  );
  const sourcePreview = useCodeWorktreeSourcePreview({
    execute: previewExecute,
    ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
    branch: resolvedBaseBranch ?? "",
    startFromOrigin,
    remoteName: resolvedWorktreeRemote,
    enabled:
      props.projectId !== undefined &&
      props.execute !== undefined &&
      resolvedBaseBranch !== undefined,
  });
  // What the task delivers is read from the prompt, not asked up front:
  // nothing about delivery is a question on the start screen. The thread's
  // board shows the reading once the thread exists, and an agent may propose
  // raising it from there.
  const outcomeKind: CodeDeliveryOutcomeKind = useMemo(
    () => suggestCodeDeliveryOutcome(prompt),
    [prompt],
  );
  const trimmed = prompt.trim();
  const [submitting, setSubmitting] = useState(false);
  // A send refused before the host saw it explains itself beside the composer,
  // since no thread exists to carry a reason.
  const [sendNotice, setSendNotice] = useState<string>();
  // A notice about the Project no longer applies once another is chosen.
  useEffect(() => setSendNotice(undefined), [props.projectId]);
  const canSubmit = trimmed.length > 0 && !props.creating && !submitting && !atMenu.resolving;

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
    if (skipProjectReset.current) {
      skipProjectReset.current = false;
      return;
    }
    setWorkspaceOverride(handedWorkspace);
    // A ref the reader picked belongs to the Project they picked it in. Left
    // standing, it both kept the previous Project's branch on screen and told
    // the adoption below that this Project's head had already been overruled.
    // Falls back to whatever the caller seeded, not to nothing: a host that
    // never lists refs still has that to show.
    baseBranchChosen.current = handedBranch !== undefined;
    setBaseBranch(props.branchName ?? props.baseBranch ?? "");
    setStartFromOriginOverride(undefined);
    setWorktreeRemote(
      preferredRemote.status === "selected" ? preferredRemote.remoteName : undefined,
    );
    // Only a change of Project resets this; the seed is read as it stands then.
  }, [projectId]);
  useEffect(() => {
    if (draftScope === undefined || drafts === undefined) return;
    drafts.writeCodeCheckout(draftScope, {
      baseBranch,
      baseBranchChosen: baseBranchChosen.current,
      permissionMode,
      permissionPersistence,
      ...(workspaceOverride === undefined ? {} : { workspaceOverride }),
      ...(worktreeRemote === undefined ? {} : { worktreeRemote }),
      ...(startFromOriginOverride === undefined ? {} : { startFromOriginOverride }),
    });
  }, [
    baseBranch,
    drafts,
    draftScope,
    permissionMode,
    permissionPersistence,
    startFromOriginOverride,
    worktreeRemote,
    workspaceOverride,
  ]);
  const structuredDraftScope = useRef(draftScope);
  useLayoutEffect(() => {
    if (drafts === undefined || draftScope === undefined) return;
    if (structuredDraftScope.current === draftScope) return;
    structuredDraftScope.current = draftScope;
    threadMentions.restore(mentionChipsFromDraft(drafts.readMentionChips(draftScope)));
    extensionDraft.restore(drafts.readExtensionReceipts(draftScope));
  }, [drafts, draftScope, extensionDraft, threadMentions]);
  useEffect(() => {
    if (draftScope === undefined || drafts === undefined) return;
    if (structuredDraftScope.current !== draftScope) return;
    drafts.writeMentionChips(draftScope, mentionChipsToDraft(threadMentions.chips));
    drafts.writeExtensionReceipts(draftScope, extensionDraft.stagedReceipts);
  }, [drafts, draftScope, extensionDraft.stagedReceipts, threadMentions.chips]);
  const loadWorktreeRefs = useCallback(() => {
    if (projectId === undefined || execute === undefined) return;
    const requestedProjectId = projectId;
    setRefsLoading(true);
    // A host may answer synchronously, and one that cannot list refs at all
    // answers with nothing. Reading `.then` off that threw where the listing
    // used to be reached only by opening the picker, and is now loaded for
    // every bound Project.
    void Promise.resolve(
      execute({ kind: "list-code-worktree-refs", projectId: requestedProjectId }),
    )
      .then((result) => {
        if (requestedProjectId !== projectIdRef.current) return;
        if (result?.kind === "worktree-refs-listed") setWorktreeRefs(result.refs);
      })
      .catch(() => undefined)
      .finally(() => {
        if (requestedProjectId === projectIdRef.current) setRefsLoading(false);
      });
  }, [projectId, execute]);
  // The tray states the branch a new thread starts from, so it has to know it
  // before the reader opens the picker. Loaded only on open, the tray showed
  // its fallback until someone happened to look at the list.
  useEffect(() => {
    if (projectId === undefined) return;
    loadWorktreeRefs();
  }, [loadWorktreeRefs, projectId]);
  useEffect(() => {
    if (baseBranchChosen.current || worktreeRefs === undefined) return;
    const current =
      worktreeRefs.find((ref) => ref.isCurrent === true && ref.kind === "local") ??
      worktreeRefs.find((ref) => ref.isCurrent === true);
    if (current === undefined) return;
    setBaseBranch(String(current.name));
  }, [worktreeRefs]);
  const handleSelectRef = useCallback(
    (ref: CodeWorktreeRef) => {
      baseBranchChosen.current = true;
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
    // A Code thread belongs to a Project, so the first turn cannot start until
    // one is chosen. Send stays live and says so: a Send greyed out for this
    // alone left people guessing why nothing happened.
    if (props.projectId === undefined) {
      setSendNotice("Choose a Project first. A Code task works in a folder.");
      return;
    }
    const extensionSelections = extensionDraft.receipts.flatMap((receipt) =>
      receipt.selection === undefined ? [] : [receipt.selection],
    );
    setSendNotice(undefined);
    setSubmitting(true);
    const staged = images.filesForSend();
    void threadMentions
      .resolveForSend()
      .then(async (threadMentionIds) => {
        const created = await props.onCreateThread({
          prompt: trimmed,
          modelOptionValues,
          ...(extensionSelections.length === 0 ? {} : { extensionSelections }),
          executionPolicy,
          permissionPersistence,
          ...(autoApprove ? { autoApprove: true } : {}),
          deliveryTarget: {
            branchIntent: defaultDeliveryBranchIntent(submittedBaseBranch, shortId),
            remoteName: resolvedWorktreeRemote,
            proposedBaseRepository: baseRepository,
            proposedBaseBranch: submittedBaseBranch,
            outcomeKind,
          },
          workspace,
          worktreeSource: {
            startFromOrigin,
            remoteName: resolvedWorktreeRemote,
          },
          presentation: { composerId: composerIdRef.current },
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
    extensionDraft,
    canSubmit,
    trimmed,
    modelOptionValues,
    executionPolicy,
    autoApprove,
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
    if (atMenu.handleKeyDown(event)) return;
    if (slash.handleKeyDown(event)) return;
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
  // A branch names a Project's checkout. With no Project chosen, a static
  // "Default branch" chip named a branch of nothing and sat between the
  // person and the prompt.
  const branchControl = hasProject ? (
    <CodeBranchSelector
      key={String(props.projectId)}
      branch={resolvedBaseBranch ?? "Default branch"}
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
  ) : null;
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
          <WelcomeHeading projectChosen={props.projectId !== undefined} />
          {props.projectAvailable === false &&
          props.projectId !== undefined &&
          props.errorMessage === undefined ? (
            <p role="status">The selected Project is unavailable. Choose another Project.</p>
          ) : null}
        </div>
        <div className="composer-stack">
          <ThreadComposer
            {...(threadDropKey === undefined ? {} : { threadDropKey })}
            planUsage={{
              providerInstanceId:
                props.selectedProviderInstanceId === undefined
                  ? undefined
                  : String(props.selectedProviderInstanceId),
            }}
            startContext={
              <div className="composer-tray composer-tray--inside" aria-label="Thread context">
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
                  {props.createFromControl}
                </div>
              </div>
            }
            chips={
              <>
                {extensionDraft.receipts.length > 0 ? (
                  <ul aria-label="Selected extensions" className="composer-chips">
                    {extensionDraft.receipts.map((receipt) => (
                      <li className="chip" key={receipt.reference}>
                        <span>{receipt.label}</span>
                        {receipt.status.kind === "blocked" ? (
                          <span>{`Blocked: ${receipt.status.reason}`}</span>
                        ) : null}
                        <OctantButton
                          aria-label={`Remove ${receipt.label} extension`}
                          className="chip-x window-no-drag"
                          onClick={() => extensionDraft.remove(receipt.reference)}
                          type="button"
                          variant="bare"
                        >
                          ×
                        </OctantButton>
                      </li>
                    ))}
                  </ul>
                ) : null}
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
                aria-autocomplete="list"
                aria-expanded={atMenu.open || slash.open}
                aria-controls={atMenu.open ? atMenu.listId : slash.open ? slash.listId : undefined}
                aria-activedescendant={
                  atMenu.active !== undefined
                    ? `${atMenu.listId}-${atMenu.active.id}`
                    : slash.active === undefined
                      ? undefined
                      : `${slash.listId}-${slash.active.id}`
                }
                autoFocus
                className="composer-input"
                disabled={props.creating}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  slash.sync(event.target.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.target.value, event.currentTarget.selectionStart);
                  mention.sync(event.target.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) => {
                  mention.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onKeyDown={handleKeyDown}
                onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
                  if (props.creating === true) return;
                  if (attachFromTransfer(event.clipboardData)) event.preventDefault();
                }}
                placeholder={draftThreadModePresentation("code").composerPlaceholder}
                ref={textareaRef}
                rows={3}
                value={prompt}
              />
            }
            typeahead={
              atMenu.open ? (
                <ComposerAtTypeahead controller={atMenu} />
              ) : slash.open ? (
                <ComposerSlashTypeahead controller={slash} />
              ) : mention.open ? (
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
                  <ComposerAttachButton
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    busy={props.creating === true}
                    refusedReason={
                      imageSupport === false
                        ? "The selected model does not accept images. Choose an image-capable model."
                        : undefined
                    }
                    onRefused={images.refuse}
                    onFileSelected={(file) => images.attach([file])}
                  />
                  <PermissionModePicker
                    autoSupported={props.autoSupported === true}
                    onChange={(next) => {
                      setPermissionMode(next);
                      props.onPermissionModeChange?.(next);
                    }}
                    value={permissionMode}
                    {...(props.creating === true ? { disabled: true } : {})}
                  />
                </>
              ),
              trailing: (
                <>
                  <span className="code-composer-adapter__context-picker">
                    <ComposerModelPicker
                      ariaLabel="Provider and model"
                      groups={providerGroups}
                      disabled={props.creating === true || submitting}
                      modelOptionValues={modelOptionValues}
                      onModelOptionChange={(id, value) => {
                        const remaining = Object.fromEntries(
                          Object.entries(modelOptionValues).filter(([key]) => key !== id),
                        );
                        setModelChoice({
                          key: modelKey,
                          values: value === undefined ? remaining : { ...remaining, [id]: value },
                        });
                      }}
                      menuSide="bottom"
                      onSelect={props.onSelectProvider}
                      {...(props.onOpenSettings === undefined
                        ? {}
                        : { onOpenSettings: props.onOpenSettings })}
                      {...(props.selectedModelId === undefined
                        ? {}
                        : { selectedModelId: props.selectedModelId })}
                      {...(props.selectedProviderInstanceId === undefined
                        ? {}
                        : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
                    />
                  </span>
                  {props.poolControl}
                  <ComposerVoiceButton
                    disabled={props.creating === true}
                    onTranscript={(transcript) =>
                      setPrompt((current) => appendTranscript(current, transcript))
                    }
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
          />
        </div>

        {/* A refusal answers the Send just pressed, so it sits under the
            composer rather than below the start screen's cards. */}
        {props.errorMessage !== undefined ? (
          <OctantAlert className="code-composer-adapter__error" tone="danger">
            {props.errorMessage}
          </OctantAlert>
        ) : sendNotice !== undefined ? (
          <OctantAlert className="code-composer-adapter__error" tone="danger">
            {sendNotice}
          </OctantAlert>
        ) : null}

        {props.projectSetup}

        {/* Start from origin only decides where a new worktree branches from.
              Binding the current checkout resolves no source, so the control
              would be a lie rather than a choice. */}
        {props.projectId === undefined || workspace !== "managed-worktree" ? null : (
          <CodeWorktreeSourceControl
            branch={resolvedBaseBranch ?? "Default branch"}
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

        {/* The action tiles and Running now come first: a running thread is
            what a person most often came back to, and below the five
            suggestions it sat under the fold. */}
        {props.homeStart}
        {/* A draft of only spaces is empty to submit, so it is empty here too:
            the suggestions stay reachable instead of disappearing behind a
            stray space. */}
        {props.suggestions === undefined ||
        props.suggestions.length === 0 ||
        trimmed !== "" ? null : (
          <div aria-label="Suggested prompts" className="code-home__suggestions" role="group">
            {props.suggestions.map((suggestion) => (
              <StartSuggestionChip
                aria-describedby={`${suggestionDescriptionId}-${suggestion.id}`}
                aria-label={suggestion.label}
                disabled={props.creating}
                key={suggestion.id}
                onClick={() => applySuggestion(suggestion)}
                title={suggestion.prompt}
              >
                {suggestion.label}
                <span className="sr-only" id={`${suggestionDescriptionId}-${suggestion.id}`}>
                  {suggestion.prompt}
                </span>
              </StartSuggestionChip>
            ))}
          </div>
        )}
        {props.beneath}
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
