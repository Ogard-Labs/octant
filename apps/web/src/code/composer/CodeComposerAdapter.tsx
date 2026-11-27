import { typedClaimFor } from "@octant/client-runtime/typed-composer-text";
import { useDroppedFolderMentions } from "../../composer/useDroppedFolderMentions";
import { attachAllowingFiles } from "../../composer/attachmentMediaType";
import { MAX_WORK_ATTACHMENT_BYTES, MAX_WORK_TURN_ATTACHMENTS } from "@octant/contracts";
import {
  useNewTaskComposerStash,
  type ComposerStashSource,
  type ComposerStashTodoSource,
} from "../../composer/useNewTaskComposerStash";
import { useDraftModelOptions } from "../../providers/useDraftModelOptions";
import type { AutoReview } from "../autoReview";
import { WorktreeLaunchContext } from "../worktreeLaunchContext";
import {
  mentionChipsFromDraft,
  mentionChipsToDraft,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
  useNewTaskPrompt,
  useNewTaskTypedScope,
} from "../../composer/useNewTaskPrompt";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { useExtensionDraftSelections } from "../../chat/useExtensionDraftSelections";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
  composerProviderCommands,
} from "../../composer/useComposerSlashCommands";
import {
  ComposerAtTypeahead,
  useComposerAtMenu,
  useThreadProviderMentions,
} from "../../composer/useComposerAtMenu";
import { ComposerAttachButton } from "../../composer/ComposerAttachButton";
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
  findPickerModel,
  type CreateHostViewScope,
  type ModelPickerSelection,
  type PickerGroup,
} from "@octant/domain";
import { lazyOr } from "../../lib/lazyOr";
import {
  MAX_FAN_OUT_MODELS,
  startEachModel,
  toggleFanOutModel,
  type CodeDraftStartOutcome,
  type CodeFanOutResult,
} from "./codeFanOut";
import type { CodeStartResultsProps } from "./CodeStartResults";
import {
  branchNameTaken,
  deriveDeliveryBranch,
  isValidBranchName,
  promptForNameSuggestion,
} from "@octant/domain/code-worktree-naming";
import {
  defaultStartFromOrigin,
  selectWorktreeRemote,
  type WorktreeRemoteFacts,
  type WorktreeSourceResolution,
} from "@octant/domain/code-worktree-source-policy";
import { suggestCodeDeliveryOutcome } from "@octant/domain/delivery-target-policy";
import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";
import { FolderOpen, Network, type IconComponent } from "../../ui/icons";
import {
  readSeenPlacementNotices,
  rememberPlacementNotice,
  serverCodeSelectionRefusal,
  serverCodeThreadProviderGroups,
  serverPlacementNotice,
  serverPlacementNoticeKey,
} from "./serverCodeComposer";
import {
  lazy,
  Suspense,
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
import { ComposerStartTray } from "../../composer/ComposerStartTray";
import { ThreadComposer } from "../../composer/ThreadComposer";
import { WelcomeHeading } from "../../composer/WelcomeHeading";
import { ComposerVoiceButton } from "../../voice/ComposerVoiceButton";
import { appendTranscript } from "../../voice/appendTranscript";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { CodeBranchSelector } from "./CodeBranchSelector";
import { threadAccessOf } from "@octant/domain/guardrail-policy";
import { PermissionModePicker } from "../PermissionModePicker";
import { CodeWhereControl, type CodeWhereControlProps } from "./CodeWhereControl";
import { CodeWorktreeSourceControl } from "./CodeWorktreeSourceControl";
import { useCodeWorktreeSourcePreview } from "./useCodeWorktreeSourcePreview";
import { clipboardHasImage } from "../../chat/composerImagePaste";
import {
  selectedModelReadsImages,
  useWorkComposerImages,
} from "../../work/composer/useWorkComposerImages";
import { useSeesImages } from "../../harness/useSeesImages";
import { WorkImageAttachmentChips } from "../../work/composer/WorkImageAttachmentChips";
import { ThreadMentionTypeahead, useThreadMentionTypeahead } from "../../chat/ThreadMentionPicker";
import { useThreadMentions } from "../../chat/useThreadMentions";
import { useComposerThreadDropRegistration } from "../../chat/composerThreadDrop";
import { TrackerReferenceComposerHints } from "../../tracker/TrackerReferenceComposerHints";
import type {
  GithubIssueContextRequest,
  LinearIssueContextRequest,
  MentionableThreadId,
  TerminalSessionImportRequest,
} from "@octant/contracts";
import type {
  CodeCommand,
  CodeCommandResult,
  CodeWorktreeRef,
  CodeWorktreeSettings,
} from "@octant/contracts/code";
import type { OctantHostBridge } from "../../shell/hostBridge";
import { boundsInsideViewport } from "../../browser/useNativeBrowserSurface";
import { observeComposerPlacement } from "../codeWorkspaceApprovals";
import { ComposerInput, type ComposerInputElement } from "../../composer/ComposerInput";
import { CodeBranchNameField, type BranchSuggestionStatus } from "./CodeBranchNameField";

export interface CodeComposerAdapterProps {
  /** Settings › Code › Worktrees: the prefix and naming a new worktree's branch follows. */
  readonly worktreeSettings?: CodeWorktreeSettings;
  readonly stashSource?: ComposerStashSource;
  readonly stashTodo?: ComposerStashTodoSource;
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
  /** Opens the Where menu on first draw — "New task on another branch…" lands here. */
  readonly startFromOpen?: boolean;
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
  /**
   * The modes this creation may offer, in picker order; all of them when
   * absent. A coordinator's proposal limits them to its requested level.
   */
  readonly permissionModes?: ReadonlyArray<PermissionMode>;
  readonly defaultPermissionPersistence: PermissionPersistence;
  readonly onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Whether the selected provider has a reviewer of its own, so Auto applies. */
  readonly autoSupported?: boolean;
  /** Who would answer the new thread's prompts at Auto, or why nobody can. */
  readonly autoReview?: AutoReview;
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
  /** A reviewed planner proposal is sent exactly as shown, never edited in this form. */
  readonly fixedPrompt?: string;
  /**
   * Replaces the start screen's question when the composer serves a decision
   * rather than a new task: a review dialog asking "What are we building
   * today?" above a fixed proposal reads as an invitation to write one.
   */
  readonly heading?: ReactNode;
  readonly createLabel?: string;
  readonly createDisabledReason?: string;
  readonly onCancelFirstTurn?: () => void;
  readonly folderControl?: ReactNode;
  /** The working-folder fields, drawn as the "Subfolder" row of the Where panel. */
  readonly subfolderControl?: ReactNode;
  readonly subfolderName?: string;
  readonly subfolderValid?: boolean;
  /** The Project's remembered workspace and how to change it; absent where it cannot be recorded. */
  readonly rememberedWorkspace?: CodeWhereControlProps["remembered"];
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
  /**
   * Settings for what this composer starts, directly under it and ahead of
   * the suggestions, `homeStart`, and `beneath` (the New coordinator draft's
   * settings line).
   */
  readonly afterComposer?: ReactNode;
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
   * The create path honours `stay` and `providerSelection`: it can start a
   * thread without opening it, on the model a start names. Only then does
   * this composer offer ⌘↩ (start and stay) and Shift-click for several models.
   */
  readonly startsInBackground?: boolean;
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
  /**
   * The selected Project is bound to a folder on one of the person's servers.
   * The composer then offers what the host runs there: the Octant Harness
   * alone, the bound folder alone, any access level, and no connector or
   * plugin. The host still decides each of these itself.
   */
  readonly server?: {
    /** `alias:folder`, as the server Project names it. */
    readonly location: string;
  };
}

export interface CodeComposerSuggestion {
  readonly id: string;
  readonly label: string;
  /** One short line under the label: what the agent will do. */
  readonly detail: string;
  /** The glyph that leads the card. */
  readonly icon: IconComponent;
  readonly prompt: string;
}

export interface CodeComposerSubmitInput {
  /** The person typed this prompt into the composer; the host believes it only on their own routes. */
  readonly typedByPerson?: true;
  readonly workingFolder?: import("@octant/contracts").ThreadWorkingFolderChoice;
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
  /**
   * Set when `proposedBaseBranch` is the stand-in rather than a branch the
   * host named or the person picked, so the create path can base the thread on
   * the branch the prepared checkout is on instead.
   */
  readonly baseBranchAssumed?: true;
  /** The workspace this one thread starts in, after any per-thread override. */
  readonly workspace: CodeNewThreadWorkspace;
  readonly worktreeSource: {
    readonly startFromOrigin: boolean;
    readonly remoteName: string;
  };
  readonly images?: ReadonlyArray<File>;
  readonly threadMentionIds?: ReadonlyArray<MentionableThreadId>;
  /**
   * The Create from source. A start that stays on the draft names the one it
   * was submitted with here, since the draft's own is cleared for the next
   * task; any other start takes the draft's current one.
   */
  readonly issueContext?: GithubIssueContextRequest;
  readonly linearIssueContext?: LinearIssueContextRequest;
  readonly terminalSession?: TerminalSessionImportRequest;
  /** Local draft identity used only to anchor a native approval view. */
  readonly presentation?: { readonly composerId: string };
  /**
   * Start the thread and stay on this draft (⌘↩, or a start on several
   * models): the window does not open the new thread, and what the start
   * reached is reported here rather than on the draft.
   */
  readonly stay?: { readonly report: (outcome: CodeDraftStartOutcome) => void };
  /** This one thread's provider and model, when one prompt starts on several. */
  readonly providerSelection?: ModelPickerSelection;
}

/**
 * Used only when the host could never name the base branch. Kept out of every
 * visible surface so the tray never asserts a branch the repository may not
 * have.
 */
const LAST_RESORT_BASE_BRANCH = "development";
const LazyCodeStartResults = lazyOr<CodeStartResultsProps>(
  async () => (await import("./CodeStartResults")).CodeStartResults,
  ({ results, label }) => (
    <>
      {results
        .map((result) =>
          result.outcome.status === "started"
            ? `${label(result)}: started.`
            : `${label(result)}: ${result.outcome.reason}`,
        )
        .join(" ")}
    </>
  ),
);
const WorktreeLaunchProgress = lazy(() =>
  import("../WorktreeLaunchProgress").then(({ WorktreeLaunchProgress }) => ({
    default: WorktreeLaunchProgress,
  })),
);

export function CodeComposerAdapter(props: CodeComposerAdapterProps) {
  const suggestionDescriptionId = useId();
  const server = props.server;
  const isServer = server !== undefined;
  const providerGroups = useMemo(
    () => (isServer ? serverCodeThreadProviderGroups(props.providerGroups) : props.providerGroups),
    [props.providerGroups, isServer],
  );
  const [draftPrompt, setPrompt] = useNewTaskPrompt();
  // A start the composer stays on settles later, against the draft as it is then.
  const latestDraftPrompt = useRef(draftPrompt);
  latestDraftPrompt.current = draftPrompt;
  const latestStashSource = useRef(props.stashSource);
  latestStashSource.current = props.stashSource;
  // New thread remounts this composer on the same draft scope; a start from
  // the composer that was replaced must not write its source into the new one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const typedScope = useNewTaskTypedScope();
  const prompt = props.fixedPrompt ?? draftPrompt;
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
    // A thread on a server carries none of Octant's connectors or plugins, so
    // with no client a reference stays blocked rather than selected.
    ...(props.extensionClient === undefined || isServer ? {} : { client: props.extensionClient }),
    mode: "code",
    projectId: props.projectId ?? null,
    ...(selectedFamily === undefined ? {} : { providerFamily: selectedFamily }),
    ...(storedExtensionReceipts.length === 0 ? {} : { initialReceipts: storedExtensionReceipts }),
  });
  const textareaRef = useRef<ComposerInputElement>(null);
  const composerIdRef = useRef(globalThis.crypto.randomUUID());
  const launches = useContext(WorktreeLaunchContext)?.launches;
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
  const mentionListId = useId();
  const images = useWorkComposerImages();
  // A model that cannot read images may still take one when Sees images can
  // describe it; the host decides again when the turn starts.
  const imageSupport = useSeesImages({
    readsImages: selectedModelReadsImages(providerGroups, {
      ...(props.selectedProviderInstanceId === undefined
        ? {}
        : { providerInstanceId: props.selectedProviderInstanceId }),
      ...(props.selectedModelId === undefined ? {} : { modelId: props.selectedModelId }),
    }),
    serverUrl: props.serverUrl,
    windowCapability: props.windowCapability,
    projectId: props.projectId === undefined ? undefined : String(props.projectId),
    providerInstanceId:
      props.selectedProviderInstanceId === undefined
        ? undefined
        : String(props.selectedProviderInstanceId),
    modelId: props.selectedModelId === undefined ? undefined : String(props.selectedModelId),
  }).takesImages;
  const threadMentions = useThreadMentions({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: prompt,
    ...(props.projectId === undefined ? {} : { trackerProjectId: String(props.projectId) }),
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
  const [permissionMode, setPermissionMode] = useState(() => {
    const stored = storedCheckout?.permissionMode;
    // A remembered draft mode never reaches above the modes this creation offers.
    return stored !== undefined &&
      (props.permissionModes === undefined || props.permissionModes.includes(stored))
      ? stored
      : props.defaultPermissionMode;
  });
  const [permissionPersistence] = useState(
    storedCheckout?.permissionPersistence ?? props.defaultPermissionPersistence,
  );
  const { executionPolicy, autoApprove } = threadAccessOf(permissionMode);
  const slash = useComposerSlashCommands({
    textarea: () => textareaRef.current,
    draft: prompt,
    onDraftChange: setPrompt,
    provider: composerProviderCommands(providerGroups, props.selectedProviderInstanceId),
  });
  const providerMentions = useThreadProviderMentions(providerGroups, {
    kind: "draft",
    mode: "code",
    projectId: isServer ? undefined : props.projectId,
    providerInstanceId: props.selectedProviderInstanceId,
    executionPolicy,
  });
  const atMenu = useComposerAtMenu({
    modelGroups: props.providerGroups,
    provider: providerMentions,
    textarea: () => textareaRef.current,
    draft: prompt,
    onDraftChange: setPrompt,
    onResolveExtensionReference: extensionDraft.resolveReference,
  });
  // F2: the default delivery branch must never collide with the base branch
  // (e.g. `development`), which normally exists. Derive a unique
  // `octant/<short-id>` default once from a stable short id.
  const newShortId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID !== undefined
      ? crypto.randomUUID().slice(0, 8)
      : "new";
  // A start the composer stays on takes this id's name, so the next draft
  // gets a fresh one.
  const [shortId, setShortId] = useState(newShortId);
  // Branches handed to starts this composer stayed on that the host may not
  // list yet: the next draft's name must not reuse one.
  const [branchesInFlight, setBranchesInFlight] = useState<ReadonlyArray<string>>([]);
  // Starts this composer stays on run one after another, so one start's
  // refusal is never read as another's.
  const stayStarts = useRef<Promise<void>>(Promise.resolve());
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
  // "New task on another branch…" opens this draft for a worktree started from
  // a picked branch, so it begins on the worktree choice: the Where menu's
  // Start from picker is what the intent is for. A choice the draft already
  // recorded still outranks the intent.
  const startFromWorkspace: CodeNewThreadWorkspace | undefined =
    props.startFromOpen === true ? "managed-worktree" : undefined;
  const [workspaceOverride, setWorkspaceOverride] = useState<CodeNewThreadWorkspace | undefined>(
    storedCheckout?.workspaceOverride ?? handedWorkspace ?? startFromWorkspace,
  );
  // A thread on a server starts in the bound folder unless the person picks a
  // new worktree, which is then made on the server; a remembered habit is
  // this host's, so it does not choose for a server.
  const workspace: CodeNewThreadWorkspace = isServer
    ? (workspaceOverride ?? "current-checkout")
    : (workspaceOverride ?? props.newThreadWorkspace ?? DEFAULT_CODE_NEW_THREAD_WORKSPACE);
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
      !isServer &&
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
  // The models besides the chosen one that a Shift-click in the picker added:
  // one prompt then starts a thread on each, each in a new worktree.
  const [fanOutModels, setFanOutModels] = useState<ReadonlyArray<ModelPickerSelection>>([]);
  // What the starts this composer stayed on reached, until the person dismisses it.
  const [startResults, setStartResults] = useState<ReadonlyArray<CodeFanOutResult>>([]);
  // A notice about the Project no longer applies once another is chosen.
  useEffect(() => setSendNotice(undefined), [props.projectId]);
  // Whether the chosen model is one the server runs. Neither this nor the
  // menu grants anything: the host admits the turn itself.
  const serverRefusal = isServer
    ? serverCodeSelectionRefusal(
        providerGroups,
        props.selectedProviderInstanceId === undefined || props.selectedModelId === undefined
          ? undefined
          : {
              providerInstanceId: props.selectedProviderInstanceId,
              modelId: props.selectedModelId,
            },
      )
    : undefined;
  // A provider that runs on the server itself says once what that means,
  // per server and provider, then keeps it behind Details.
  const placedGroup =
    isServer && serverRefusal === undefined
      ? providerGroups.find(
          (group) =>
            group.serverPlacement === "supported" &&
            group.runtime !== "octant-harness" &&
            String(group.instance.id) === String(props.selectedProviderInstanceId),
        )
      : undefined;
  const placementServer = server?.location.split(":", 1)[0] ?? "the server";
  const placementKey =
    placedGroup === undefined
      ? undefined
      : serverPlacementNoticeKey(placementServer, String(placedGroup.instance.id));
  const [placementSeen, setPlacementSeen] = useState<ReadonlySet<string>>(readSeenPlacementNotices);
  const [placementOpen, setPlacementOpen] = useState(false);
  const canSubmit =
    trimmed.length > 0 &&
    props.createDisabledReason === undefined &&
    !props.creating &&
    !submitting &&
    !atMenu.resolving &&
    serverRefusal === undefined;
  const stash = useNewTaskComposerStash({
    mode: "code",
    host: props.fixedHostId ?? props.selectedHostId,
    projectId: props.projectId,
    prompt: draftPrompt,
    textarea: textareaRef,
    setPrompt,
    busy: props.creating === true || submitting || atMenu.resolving,
    files: {
      current: images.staged.map((attachment) => attachment.file),
      change: images.replaceDraftFiles,
      attachmentLimit: MAX_WORK_TURN_ATTACHMENTS,
      attachmentByteLimit: MAX_WORK_ATTACHMENT_BYTES,
      readsImages: imageSupport !== false,
    },
    threads: { current: threadMentions.chips, change: threadMentions.restore },
    extensions: {
      current: extensionDraft.stagedReceipts,
      change: extensionDraft.restore,
      scopeKey: extensionDraft.scopeKey,
    },
    source: props.stashSource,
    todo: props.stashTodo,
  });

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
    setWorkspaceOverride(handedWorkspace ?? startFromWorkspace);
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
  // Every name a new branch must not collide with, read apart from the display
  // list above, which stops at 200 entries. Until it is read, or when the host
  // cannot read all of it, nothing proves a generated name is free.
  const [branchNames, setBranchNames] = useState<{
    readonly forProject: ProjectId;
    readonly names: ReadonlyArray<string>;
    readonly complete: boolean;
  }>();
  const loadBranchNames = useCallback(() => {
    if (projectId === undefined || execute === undefined) return;
    const requestedProjectId = projectId;
    void Promise.resolve(
      execute({ kind: "list-code-worktree-branch-names", projectId: requestedProjectId }),
    )
      .then((result) => {
        if (requestedProjectId !== projectIdRef.current) return;
        setBranchNames(
          result?.kind === "worktree-branch-names-listed"
            ? { forProject: requestedProjectId, names: result.names, complete: !result.truncated }
            : { forProject: requestedProjectId, names: [], complete: false },
        );
      })
      .catch(() => undefined);
  }, [projectId, execute]);
  useEffect(() => {
    loadBranchNames();
  }, [loadBranchNames]);
  // The tray states the branch a new thread starts from, so it has to know it
  // before the reader opens the picker. Loaded only on open, the tray showed
  // its fallback until someone happened to look at the list.
  useEffect(() => {
    // A server folder's branches are listed by Git on the server.
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

  // The name shown before Send is the name sent: one derivation serves both,
  // from the branches the host listed, so a taken name is already numbered.
  const namesKnown =
    branchNames !== undefined && branchNames.forProject === projectId && branchNames.complete;
  const existingBranchNames = useMemo(
    () => [
      ...(worktreeRefs ?? []).flatMap((ref) => (ref.kind === "local" ? [ref.name] : [])),
      ...(branchNames !== undefined && branchNames.forProject === projectId
        ? branchNames.names
        : []),
      ...branchesInFlight,
    ],
    [worktreeRefs, branchNames, projectId, branchesInFlight],
  );
  // Words from the prompt are used only once every taken name is known: with a
  // name list that is missing or cut short the id name is the one that fails closed.
  const namingNow = namesKnown ? props.worktreeSettings?.branchNaming : "short-id";
  const derivedBranch = useMemo(
    () =>
      deriveDeliveryBranch({
        baseBranch: submittedBaseBranch,
        shortId,
        prefix: props.worktreeSettings?.branchPrefix,
        naming: namingNow,
        prompt: trimmed,
        existingBranches: existingBranchNames,
      }),
    [
      props.worktreeSettings?.branchPrefix,
      namingNow,
      shortId,
      submittedBaseBranch,
      trimmed,
      existingBranchNames,
    ],
  );
  // A name the person typed or asked a model for outranks the derived one, but
  // only while it is still a usable branch name nobody has taken since, and only
  // for the Project and base checkout it was chosen for.
  const choiceScope = `${props.projectId ?? ""}\0${submittedBaseBranch}`;
  const [branchChoice, setBranchChoice] = useState<{
    readonly name: string;
    readonly scope: string;
  }>();
  const [branchSuggestion, setBranchSuggestion] = useState<BranchSuggestionStatus>("idle");
  const suggestionFor = useRef({ generation: 0, draft: "", model: "" });
  const suggestionCall = useRef<AbortController | undefined>(undefined);
  const stopSuggestion = useCallback(() => {
    suggestionCall.current?.abort();
    suggestionCall.current = undefined;
    suggestionFor.current = {
      ...suggestionFor.current,
      generation: suggestionFor.current.generation + 1,
    };
    setBranchSuggestion((current) => (current === "asking" ? "idle" : current));
  }, []);
  // A choice belongs to the Project and base checkout it was made for: another
  // one starts again from the derived name, and an answer still on its way for
  // the old one is stopped, not just ignored.
  useEffect(() => {
    setBranchChoice((current) => (current?.scope === choiceScope ? current : undefined));
    return undefined;
  }, [choiceScope]);
  useEffect(() => stopSuggestion, [props.projectId, stopSuggestion]);
  const takenNames = [submittedBaseBranch, ...existingBranchNames];
  const worktreeBranch =
    branchChoice !== undefined &&
    branchChoice.scope === choiceScope &&
    isValidBranchName(branchChoice.name) &&
    !branchNameTaken(branchChoice.name, takenNames)
      ? branchChoice.name
      : derivedBranch;
  const editBranchName = useCallback(
    (name: string): string | undefined => {
      if (name === "") {
        setBranchChoice(undefined);
        return undefined;
      }
      if (!isValidBranchName(name)) {
        return "Use letters, numbers, dots, dashes and slashes, without spaces, a trailing .lock or a name Windows reserves.";
      }
      if (branchNameTaken(name, [submittedBaseBranch, ...existingBranchNames])) {
        return "A branch, a remote branch or a tag with that name, or one inside it or around it, already exists.";
      }
      // What the person typed outranks an answer still on its way.
      stopSuggestion();
      setBranchChoice(name === derivedBranch ? undefined : { name, scope: choiceScope });
      return undefined;
    },
    [choiceScope, derivedBranch, existingBranchNames, stopSuggestion, submittedBaseBranch],
  );
  const suggestModel =
    props.selectedProviderInstanceId === undefined || props.selectedModelId === undefined
      ? undefined
      : { providerInstanceId: props.selectedProviderInstanceId, modelId: props.selectedModelId };
  const suggestModelLabel = findPickerModel(providerGroups, suggestModel)?.model.displayName;
  const suggestModelKey =
    suggestModel === undefined ? "" : `${suggestModel.providerInstanceId}/${suggestModel.modelId}`;
  // What the model is sent: the draft after redaction, reduced to the words a
  // branch name may carry, and at most 2,000 characters.
  const suggestDraft = useMemo(() => promptForNameSuggestion(trimmed), [trimmed]);
  // Anything in flight is answering a question that no longer stands once the
  // draft, the Project or the model changes; its answer is dropped on arrival.
  const currentQuestion = `${props.projectId ?? ""}\0${suggestModelKey}\0${trimmed}`;
  const suggestBranchName = useCallback(() => {
    if (
      props.execute === undefined ||
      props.projectId === undefined ||
      suggestModel === undefined ||
      suggestDraft === ""
    ) {
      return;
    }
    suggestionCall.current?.abort();
    const call = new AbortController();
    suggestionCall.current = call;
    const generation = suggestionFor.current.generation + 1;
    suggestionFor.current = { generation, draft: currentQuestion, model: suggestModelKey };
    setBranchSuggestion("asking");
    void props
      .execute(
        {
          kind: "suggest-code-worktree-branch",
          projectId: props.projectId,
          providerInstanceId: suggestModel.providerInstanceId,
          modelId: suggestModel.modelId,
          draft: suggestDraft,
        },
        call.signal,
      )
      .then(
        (result) => result,
        () => undefined,
      )
      .then((result) => {
        if (suggestionFor.current.generation !== generation) return;
        if (suggestionCall.current === call) suggestionCall.current = undefined;
        if (result?.kind !== "worktree-branch-suggested") {
          setBranchSuggestion("declined");
          return;
        }
        // The question is compared at arrival through the ref the render keeps.
        if (latestQuestion.current !== suggestionFor.current.draft) {
          setBranchSuggestion("dropped");
          return;
        }
        const name = deriveDeliveryBranch({
          baseBranch: submittedBaseBranch,
          shortId,
          prefix: props.worktreeSettings?.branchPrefix,
          naming: namesKnown ? "prompt" : "short-id",
          prompt: result.words,
          existingBranches: existingBranchNames,
        });
        setBranchChoice({ name, scope: choiceScope });
        setBranchSuggestion("idle");
      });
  }, [
    choiceScope,
    currentQuestion,
    existingBranchNames,
    namesKnown,
    suggestDraft,
    suggestModelKey,
    props,
    shortId,
    submittedBaseBranch,
    suggestModel,
  ]);
  const latestQuestion = useRef(currentQuestion);
  latestQuestion.current = currentQuestion;

  const primaryModel: ModelPickerSelection | undefined =
    props.selectedProviderInstanceId === undefined || props.selectedModelId === undefined
      ? undefined
      : { providerInstanceId: props.selectedProviderInstanceId, modelId: props.selectedModelId };
  // A model chosen as the main one is no longer an extra.
  const extraModels = fanOutModels.filter(
    (each) =>
      primaryModel === undefined ||
      String(each.providerInstanceId) !== String(primaryModel.providerInstanceId) ||
      String(each.modelId) !== String(primaryModel.modelId),
  );
  const startsInBackground = props.startsInBackground === true;
  // A reviewed proposal is one exact thread, so it starts on one model; and
  // without a chosen model there is no first thread to add others beside.
  const fanOutOffered =
    startsInBackground && props.fixedPrompt === undefined && primaryModel !== undefined;
  const fanningOut = fanOutOffered && extraModels.length > 0;
  const modelLabel = (selection: ModelPickerSelection | undefined): string => {
    const found = findPickerModel(providerGroups, selection)?.model.displayName;
    return found ?? (selection === undefined ? "The chosen model" : String(selection.modelId));
  };

  const submit = useCallback(
    (how: "open" | "stay" = "open") => {
      if (!canSubmit) return;
      const typedClaim = typedClaimFor(typedScope, trimmed);
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
      const staged = images.filesForSend();
      const stays = startsInBackground && (how === "stay" || fanningOut);
      const sentPrompt = trimmed;
      const input = (
        threadMentionIds: ReadonlyArray<MentionableThreadId>,
      ): CodeComposerSubmitInput => ({
        prompt: sentPrompt,
        ...typedClaim,
        modelOptionValues,
        ...(extensionSelections.length === 0 ? {} : { extensionSelections }),
        executionPolicy,
        // Nothing about a thread on a server is remembered for the Project.
        permissionPersistence: isServer ? "current-session" : permissionPersistence,
        ...(autoApprove ? { autoApprove: true } : {}),
        deliveryTarget: {
          branchIntent: worktreeBranch,
          remoteName: resolvedWorktreeRemote,
          proposedBaseRepository: baseRepository,
          proposedBaseBranch: submittedBaseBranch,
          outcomeKind,
        },
        ...(resolvedBaseBranch === undefined ? { baseBranchAssumed: true as const } : {}),
        workspace,
        worktreeSource: {
          startFromOrigin,
          remoteName: resolvedWorktreeRemote,
        },
        // A start the composer stays on shows no launch progress in it: the
        // composer is already the next draft.
        ...(stays ? {} : { presentation: { composerId: composerIdRef.current } }),
        ...(staged.length === 0 ? {} : { images: staged }),
        ...(threadMentionIds.length === 0 ? {} : { threadMentionIds }),
      });
      if (!stays) {
        setSubmitting(true);
        void threadMentions
          .resolveForSend()
          .then(async (threadMentionIds) => {
            const created = await props.onCreateThread(input(threadMentionIds));
            if (created !== false) images.clearAfterAccepted();
            // A refused creation may be because the name was taken meanwhile; the
            // names are read again so the name shown is the one that would be tried.
            else loadBranchNames();
            return created;
          })
          .finally(() => {
            setSubmitting(false);
          });
        return;
      }
      // Start and stay: the prompt is handed over and the composer is the next
      // draft at once, keeping its Project, workspace and base branch.
      const models: ReadonlyArray<ModelPickerSelection | undefined> = fanningOut
        ? [primaryModel, ...extraModels]
        : [primaryModel];
      const sentReceipts = extensionDraft.stagedReceipts;
      const sentSource = props.stashSource?.current;
      setPrompt("");
      images.clearAfterAccepted();
      // Chips beside the prompt leave with it, or the next draft would carry
      // a plugin or connector choice, or a Create from issue or terminal
      // session, into threads it was never chosen for.
      extensionDraft.clear();
      if (sentSource !== undefined) props.stashSource?.change(undefined);
      setShortId(newShortId());
      const run = async () => {
        const threadMentionIds = await threadMentions.resolveForSend();
        // Every model's thread starts from the source this submission captured.
        const base: CodeComposerSubmitInput = {
          ...input(threadMentionIds),
          ...(sentSource?.kind === "github" ? { issueContext: sentSource.request } : {}),
          ...(sentSource?.kind === "linear" ? { linearIssueContext: sentSource.request } : {}),
          ...(sentSource?.kind === "terminal" ? { terminalSession: sentSource.request } : {}),
        };
        const startOne = async (
          selection: ModelPickerSelection | undefined,
          branch: string,
        ): Promise<CodeDraftStartOutcome> => {
          let reported: CodeDraftStartOutcome | undefined;
          // A model added beside the chosen one starts on its own default
          // options, and takes the plugin and connector choices only from
          // the same provider family: both were made for the chosen model.
          const added = selection !== primaryModel;
          const { modelOptionValues: _options, extensionSelections: _extensions, ...shared } = base;
          const created = await props.onCreateThread({
            ...shared,
            ...(added || base.modelOptionValues === undefined
              ? {}
              : { modelOptionValues: base.modelOptionValues }),
            ...(base.extensionSelections === undefined ||
            (added &&
              providerFamilyForThread(providerGroups, selection?.providerInstanceId) !==
                selectedFamily)
              ? {}
              : { extensionSelections: base.extensionSelections }),
            ...(fanningOut ? { workspace: "managed-worktree" as const } : {}),
            deliveryTarget: { ...base.deliveryTarget, branchIntent: branch },
            ...(selection === undefined ? {} : { providerSelection: selection }),
            stay: {
              report: (outcome) => {
                reported = outcome;
              },
            },
          });
          return (
            reported ??
            (created === false
              ? { status: "refused", reason: "The thread could not be started." }
              : { status: "started" })
          );
        };
        const results = await startEachModel(
          models,
          worktreeBranch,
          takenNames,
          (selection, branch) => {
            setBranchesInFlight((current) => [...current, branch]);
            return startOne(selection, branch);
          },
        );
        setStartResults((current) => [...current, ...results]);
        loadBranchNames();
        // Nothing was even created: the prompt and its files come back, unless
        // the person already began the next prompt. A thread that exists keeps
        // its prompt in its own draft instead, and its row offers Open.
        if (
          results.every(
            (result) =>
              result.outcome.status === "refused" && result.outcome.threadId === undefined,
          )
        ) {
          const nextDraftStarted =
            latestDraftPrompt.current !== "" || latestStashSource.current?.current !== undefined;
          setPrompt((current) => (current === "" ? sentPrompt : current));
          if (staged.length > 0) images.restore(staged);
          if (sentReceipts.length > 0) extensionDraft.restore(sentReceipts);
          if (sentSource !== undefined && mounted.current && !nextDraftStarted) {
            latestStashSource.current?.change(sentSource);
          }
        }
      };
      stayStarts.current = stayStarts.current.then(run, run).catch(() => undefined);
    },
    [
      extensionDraft,
      canSubmit,
      trimmed,
      modelOptionValues,
      executionPolicy,
      autoApprove,
      permissionPersistence,
      isServer,
      workspace,
      baseRepository,
      baseBranch,
      worktreeBranch,
      outcomeKind,
      startFromOrigin,
      resolvedWorktreeRemote,
      images,
      loadBranchNames,
      threadMentions,
      fanningOut,
      primaryModel,
      extraModels,
      startsInBackground,
      takenNames,
      providerGroups,
      selectedFamily,
      props,
    ],
  );

  const folderDrops = useDroppedFolderMentions({
    scope:
      props.projectId === undefined
        ? undefined
        : { mode: "code-draft", projectId: props.projectId },
    draft: prompt,
    onDraftChange: (text) => setPrompt(text),
    textarea: () => textareaRef.current,
    serverUrl: props.serverUrl,
    windowCapability: props.windowCapability,
    hostId: props.fixedHostId ?? props.selectedHostId,
    refused:
      isServer ||
      workspace === "managed-worktree" ||
      props.fixedPrompt !== undefined ||
      props.creating === true,
    onFiles: (files) =>
      void attachAllowingFiles(
        files,
        imageSupport,
        images.attach,
        images.refuse,
        "Choose an image-capable model to attach images.",
      ),
  });
  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (items === null) return false;
    if (!clipboardHasImage(items)) return false;
    if (imageSupport === false) {
      images.refuse("This model cannot read images. Pick one that can.");
      return true;
    }
    return images.consumePaste(items);
  }

  function handleKeyDown(event: KeyboardEvent<ComposerInputElement>) {
    if (atMenu.handleKeyDown(event)) return;
    if (slash.handleKeyDown(event)) return;
    if (mention.handleKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // ⌘↩ (Ctrl+↩) starts the thread and leaves a fresh draft here.
      submit(startsInBackground && (event.metaKey || event.ctrlKey) ? "stay" : "open");
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
        <FolderOpen aria-hidden="true" size={12} />
        <span>{props.projectName}</span>
      </span>
    ));
  // A branch names a Project's checkout. With no Project chosen, a static
  // "Default branch" chip named a branch of nothing and sat between the
  // person and the prompt.
  // A server Project names where it runs; its branches, listed by Git on the
  // server, choose a new worktree's source and the pull request's base.
  const serverLocation =
    hasProject && server !== undefined ? (
      <span className="composer-tray__item" title={`On a server: ${server.location}`}>
        <Network aria-hidden="true" size={12} />
        <span>{server.location}</span>
      </span>
    ) : null;
  const branchPicker = hasProject ? (
    <CodeBranchSelector
      key={String(props.projectId)}
      branch={resolvedBaseBranch ?? "Default branch"}
      loading={refsLoading}
      onOpen={loadWorktreeRefs}
      {...(props.startFromOpen === true ? { startOpen: true } : {})}
      onSelectRef={handleSelectRef}
      onStartFromOriginChange={setStartFromOriginOverride}
      presentation="row"
      remoteName={resolvedWorktreeRemote}
      startFromOrigin={startFromOrigin}
      startFromOriginAvailable={
        preferredRemote.status === "selected" || worktreeRemote !== undefined
      }
      {...(worktreeRefs === undefined ? {} : { refs: worktreeRefs })}
      {...(props.creating === true ? { disabled: true } : {})}
    />
  ) : null;
  const sourceControl =
    props.projectId === undefined ? null : (
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
    );
  const branchControl = hasProject ? (
    <>
      {serverLocation}
      <CodeWhereControl
        {...(props.startFromOpen === true ? { startOpen: true } : {})}
        baseBranchPicker={branchPicker}
        sourceControl={sourceControl}
        branch={resolvedBaseBranch ?? "Default branch"}
        onWorkspaceChange={setWorkspaceOverride}
        worktreeBranch={worktreeBranch}
        branchNameControl={
          <CodeBranchNameField
            chosen={branchChoice !== undefined && worktreeBranch === branchChoice.name}
            {...(props.creating === true ? { disabled: true } : {})}
            onEdit={editBranchName}
            {...(props.execute === undefined || suggestModel === undefined
              ? {}
              : { onSuggest: suggestBranchName })}
            {...(suggestModelLabel === undefined ? {} : { modelLabel: suggestModelLabel })}
            suggestDisabled={suggestDraft === ""}
            suggestion={branchSuggestion}
            value={worktreeBranch}
          />
        }
        workspace={workspace}
        {...(props.creating === true ? { disabled: true } : {})}
        {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
        {...(props.subfolderControl === undefined ? {} : { subfolder: props.subfolderControl })}
        {...(props.subfolderName === undefined ? {} : { subfolderName: props.subfolderName })}
        {...(props.subfolderValid === undefined ? {} : { subfolderValid: props.subfolderValid })}
        {...(props.rememberedWorkspace === undefined || isServer
          ? {}
          : { remembered: props.rememberedWorkspace })}
      />
    </>
  ) : null;
  const worktreeLaunch =
    workspace !== "managed-worktree" || launches === undefined
      ? undefined
      : Array.from(launches.values()).findLast(
          (launch) =>
            launch.composerId === composerIdRef.current &&
            String(launch.projectId) === String(props.projectId) &&
            launch.target === undefined &&
            (props.creating === true ? launch.blocked !== true : launch.blocked === true),
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
          {props.heading ?? (
            <WelcomeHeading
              projectChosen={props.projectId !== undefined}
              {...(props.projectId !== undefined && props.projectName !== undefined
                ? { projectName: props.projectName }
                : {})}
            />
          )}
        </div>
        <div className="composer-stack">
          <ThreadComposer
            stash={props.fixedPrompt === undefined ? stash : undefined}
            notices={[
              ...(folderDrops.notice === undefined ? [] : [folderDrops.notice]),
              ...(images.message === undefined
                ? []
                : [{ key: "image", tone: "warning" as const, text: images.message }]),
              ...(props.projectAvailable === false &&
              props.projectId !== undefined &&
              props.errorMessage === undefined
                ? [
                    {
                      key: "project-unavailable",
                      tone: "warning" as const,
                      text: "That Project is unavailable. Pick another.",
                    },
                  ]
                : []),
              ...(fanningOut
                ? [
                    {
                      key: "fan-out",
                      tone: "neutral" as const,
                      role: "status" as const,
                      text: `Starts ${String(extraModels.length + 1)} threads, each in a new worktree: ${[
                        primaryModel,
                        ...extraModels,
                      ]
                        .map(modelLabel)
                        .join(
                          ", ",
                        )}. Shift-click a model, or press Shift+Enter on it, to add or remove it (up to ${String(
                        MAX_FAN_OUT_MODELS,
                      )}).`,
                      action: (
                        <OctantButton
                          onClick={() => setFanOutModels([])}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Use one model
                        </OctantButton>
                      ),
                    },
                  ]
                : []),
              ...(startResults.length === 0
                ? []
                : [
                    {
                      key: "start-results",
                      tone: startResults.some((result) => result.outcome.status === "refused")
                        ? ("warning" as const)
                        : ("neutral" as const),
                      role: "status" as const,
                      text: (
                        <LazyCodeStartResults
                          label={(result) => modelLabel(result.selection ?? primaryModel)}
                          results={startResults}
                        />
                      ),
                      action: (
                        <OctantButton
                          onClick={() => setStartResults([])}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Dismiss
                        </OctantButton>
                      ),
                    },
                  ]),
              // A refusal answers the Send just pressed, so it is the card
              // directly above the composer, not a line below the start screen.
              ...(props.errorMessage !== undefined || sendNotice !== undefined
                ? [
                    {
                      key: "error",
                      tone: "danger" as const,
                      role: "alert" as const,
                      text: props.errorMessage ?? sendNotice ?? "",
                    },
                  ]
                : []),
              ...(props.createDisabledReason === undefined
                ? []
                : [
                    {
                      key: "create-disabled",
                      tone: "warning" as const,
                      text: props.createDisabledReason,
                    },
                  ]),
              ...(serverRefusal !== undefined && props.errorMessage === undefined
                ? [{ key: "server-refusal", tone: "warning" as const, text: serverRefusal }]
                : []),
              ...(placedGroup === undefined || placementKey === undefined
                ? []
                : placementOpen || !placementSeen.has(placementKey)
                  ? [
                      {
                        key: "server-placement",
                        tone: "neutral" as const,
                        text: serverPlacementNotice(
                          placedGroup.driverLabel,
                          placementServer,
                          placedGroup.instance.driverKind,
                        ),
                        action: (
                          <OctantButton
                            onClick={() => {
                              setPlacementOpen(false);
                              setPlacementSeen(rememberPlacementNotice(placementKey));
                            }}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Got it
                          </OctantButton>
                        ),
                      },
                    ]
                  : [
                      {
                        key: "server-placement",
                        tone: "neutral" as const,
                        transient: true as const,
                        text: `${placedGroup.driverLabel} runs on ${placementServer} as itself.`,
                        action: (
                          <OctantButton
                            onClick={() => setPlacementOpen(true)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Details
                          </OctantButton>
                        ),
                      },
                    ]),
              ...(props.creating && worktreeLaunch === undefined
                ? [
                    {
                      key: "first-turn",
                      label: "First-turn status",
                      // Without Cancel it is passing by itself: the quiet
                      // line, still named for assistive technology.
                      ...(props.onCancelFirstTurn === undefined
                        ? { transient: true as const }
                        : {}),
                      tone: "neutral" as const,
                      role: "status" as const,
                      text: props.pendingMessage ?? "Starting the first turn…",
                      ...(props.onCancelFirstTurn === undefined
                        ? {}
                        : {
                            action: (
                              <OctantButton
                                onClick={props.onCancelFirstTurn}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                Cancel first turn
                              </OctantButton>
                            ),
                          }),
                    },
                  ]
                : []),
            ]}
            {...(threadDropKey === undefined ? {} : { threadDropKey })}
            planUsage={{
              providerInstanceId:
                props.selectedProviderInstanceId === undefined
                  ? undefined
                  : String(props.selectedProviderInstanceId),
            }}
            startContext={
              <ComposerStartTray
                project={projectControl}
                branch={branchControl}
                environment={environmentControl}
                createFrom={props.createFromControl}
              />
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
                <TrackerReferenceComposerHints draft={prompt} />
                <WorkImageAttachmentChips images={images} withMessage={false} />
              </>
            }
            input={
              <ComposerInput
                typedScope={typedScope}
                {...(props.creating === true || props.fixedPrompt !== undefined
                  ? {}
                  : { onPasteAsFile: (file: File) => images.attach([file]) })}
                inlineChips={mention.inlineChips}
                renderModelChip={atMenu.renderModelChip}
                aria-label="First message"
                aria-autocomplete="list"
                aria-expanded={atMenu.open || slash.open || mention.open}
                aria-controls={
                  atMenu.open
                    ? atMenu.listId
                    : slash.open
                      ? slash.listId
                      : mention.open
                        ? mentionListId
                        : undefined
                }
                aria-activedescendant={
                  atMenu.active !== undefined
                    ? `${atMenu.listId}-${atMenu.active.id}`
                    : slash.active !== undefined
                      ? `${slash.listId}-${slash.active.id}`
                      : mention.activeOptionId === undefined
                        ? undefined
                        : `${mentionListId}-${mention.activeOptionId}`
                }
                autoFocus
                className="composer-input"
                disabled={props.creating}
                readOnly={props.fixedPrompt !== undefined}
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
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  if (folderDrops.onDrop(event) || attachFromTransfer(event.dataTransfer))
                    event.preventDefault();
                }}
                onPaste={(event: ClipboardEvent<ComposerInputElement>) => {
                  if (props.creating === true) return;
                  if (attachFromTransfer(event.clipboardData)) event.preventDefault();
                }}
                placeholder={draftThreadModePresentation("code").composerPlaceholder}
                ref={textareaRef}
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
                  onChooseTracker={mention.chooseTracker}
                  trackers={mention.trackers}
                  onHover={mention.setActiveIndex}
                />
              ) : null
            }
            row={{
              className: "code-composer-adapter__composer-bar",
              attach: (
                <ComposerAttachButton
                  busy={props.creating === true}
                  onRefused={images.refuse}
                  onFileSelected={(file) =>
                    attachAllowingFiles(
                      [file],
                      imageSupport,
                      images.attach,
                      images.refuse,
                      "This model cannot read images. Pick one that can.",
                    )
                  }
                />
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
                      {...(fanOutOffered
                        ? {
                            alsoSelected: extraModels,
                            onShiftSelect: (selection: ModelPickerSelection) =>
                              setFanOutModels(
                                toggleFanOutModel(primaryModel, extraModels, selection),
                              ),
                          }
                        : {})}
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
                </>
              ),
              approval: (
                <>
                  <PermissionModePicker
                    autoSupported={props.autoSupported === true}
                    autoReview={props.autoReview}
                    onChange={(next) => {
                      setPermissionMode(next);
                      props.onPermissionModeChange?.(next);
                    }}
                    value={permissionMode}
                    {...(props.permissionModes === undefined
                      ? {}
                      : { modes: props.permissionModes })}
                    warningScope={
                      props.projectId === undefined
                        ? "machine"
                        : { projectId: String(props.projectId) }
                    }
                    {...(props.creating === true ? { disabled: true } : {})}
                  />
                </>
              ),
              dictate: (
                <ComposerVoiceButton
                  disabled={props.creating === true || props.fixedPrompt !== undefined}
                  onTranscript={(transcript) =>
                    setPrompt((current) => appendTranscript(typedScope, current, transcript))
                  }
                />
              ),
              actions: {
                kind: "send",
                send: {
                  ariaLabel: fanningOut
                    ? `Start ${String(extraModels.length + 1)} threads`
                    : (props.createLabel ??
                      (props.errorMessage === undefined
                        ? "Create thread"
                        : "Retry creating thread")),
                  disabled: !canSubmit,
                  onSend: () => submit(),
                },
              },
            }}
          />
        </div>

        {worktreeLaunch === undefined ? null : (
          <Suspense fallback={<span role="status">Setting up worktree…</span>}>
            <WorktreeLaunchProgress key={worktreeLaunch.threadId} launch={worktreeLaunch} />
          </Suspense>
        )}
        {props.projectSetup}

        {/* Settings for what the composer starts (a new coordinator's) belong
            to the box itself, so they come before the suggestions and cards. */}
        {props.afterComposer}
        {/* The prompts sit directly under the composer they fill in, and the
            list follows. Under the list they were a screen away from the
            box they act on. Each is a card: a glyph, what it is, and one line
            on what the agent will do. A draft of only spaces is empty to
            submit, so it is empty here too. Once the person has typed, the
            cards step out of sight and out of reach but keep their place:
            removed, the list under them jumped up on the first keystroke. */}
        {props.suggestions === undefined || props.suggestions.length === 0 ? null : (
          <div
            aria-hidden={trimmed === "" ? undefined : true}
            aria-label="Suggested prompts"
            className="code-home__suggestions"
            data-away={trimmed === "" ? undefined : "true"}
            role="group"
          >
            {props.suggestions.map((suggestion) => {
              const Icon = suggestion.icon;
              return (
                <OctantButton
                  aria-describedby={`${suggestionDescriptionId}-${suggestion.id}`}
                  aria-label={suggestion.label}
                  disabled={props.creating === true || trimmed !== ""}
                  key={suggestion.id}
                  onClick={() => applySuggestion(suggestion)}
                  title={suggestion.prompt}
                  type="button"
                  variant="ghost"
                >
                  <Icon aria-hidden={true} className="code-home__suggestion-icon" size={16} />
                  <span className="draft-thread__intent-label">{suggestion.label}</span>
                  <span className="draft-thread__intent-description">{suggestion.detail}</span>
                  <span className="sr-only" id={`${suggestionDescriptionId}-${suggestion.id}`}>
                    {suggestion.prompt}
                  </span>
                </OctantButton>
              );
            })}
          </div>
        )}
        {/* Running now comes before what waits below: a running thread is what
            a person most often came back to. */}
        {props.homeStart}
        {props.beneath}
      </div>
    </section>
  );
}
