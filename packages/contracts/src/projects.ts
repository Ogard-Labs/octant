import { Schema } from "effect";
import { CanvasDesignBrand } from "./canvasBrand";
import { DesktopRecipe, DesktopRecipeKeyChange } from "./desktopLease";
import { ActorId, AggregateVersion, EventActor, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { PermissionMode, ProviderInstanceId } from "./providers";
import { AutoReviewer } from "./shield";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ProjectId = brandedUuid("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const MemoryEntryId = brandedUuid("MemoryEntryId");
export type MemoryEntryId = typeof MemoryEntryId.Type;
export const BindingRevisionId = brandedUuid("BindingRevisionId");
export type BindingRevisionId = typeof BindingRevisionId.Type;
export const BindingReceiptId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  Schema.brand("BindingReceiptId"),
);
export type BindingReceiptId = typeof BindingReceiptId.Type;

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
};

export const ProjectRank = Schema.String.pipe(
  Schema.pattern(/^-?(?:0|[1-9]\d*)\/[1-9]\d*$/),
  Schema.filter((value) => {
    const [numeratorText, denominatorText] = value.split("/") as [string, string];
    const numerator = BigInt(numeratorText);
    const denominator = BigInt(denominatorText);
    return numeratorText !== "-0" && gcd(numerator, denominator) === 1n;
  }),
  Schema.brand("ProjectRank"),
);
export type ProjectRank = typeof ProjectRank.Type;

export const ProjectType = Schema.Literal("chat", "work", "code");
export type ProjectType = typeof ProjectType.Type;
export const ProjectLifecycle = Schema.Literal("active", "archived");
export type ProjectLifecycle = typeof ProjectLifecycle.Type;

export const CodeAccessPersistence = Schema.Literal("current-session", "project-default");
export type CodeAccessPersistence = typeof CodeAccessPersistence.Type;

/**
 * A credential-free identity observed from a Code Project's Git remotes.
 *
 * This is deliberately narrower than a remote URL: no scheme, username,
 * token, host alias, or path is ever sent to the renderer. Only an exact
 * github.com owner/repository pair may be projected here.
 */
export const ConnectedGitHubRepository = Schema.Struct({
  host: Schema.Literal("github.com"),
  owner: Schema.NonEmptyTrimmedString.pipe(
    Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/),
  ),
  repository: Schema.NonEmptyTrimmedString.pipe(
    Schema.pattern(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/),
  ),
}).annotations(strict);
export type ConnectedGitHubRepository = typeof ConnectedGitHubRepository.Type;

/**
 * How a Code Project prefers new threads to start: in a managed
 * worktree Octant creates and owns, or in the Project's current checkout.
 *
 * This is a Project habit, not a second workspace product: the create dialog
 * still overrides it for one thread without rewriting the Project setting, and
 * the values stay inside the checkout kinds Code already supports.
 */
export const CodeNewThreadWorkspace = Schema.Literal("managed-worktree", "current-checkout");
export type CodeNewThreadWorkspace = typeof CodeNewThreadWorkspace.Type;

/**
 * The habit a Code Project falls back to before a user has ever chosen one.
 * Current checkout is the conservative default: it creates no worktree and no
 * host state the user did not ask for.
 */
export const DEFAULT_CODE_NEW_THREAD_WORKSPACE: CodeNewThreadWorkspace = "current-checkout";
export const Phase3CodeAccessPersistence = Schema.Literal("current-session");
export type Phase3CodeAccessPersistence = typeof Phase3CodeAccessPersistence.Type;

export const ProjectActor = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("system"), actorId: ActorId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("local-user"), actorId: ActorId }).annotations(strict),
);
export type ProjectActor = typeof ProjectActor.Type;

export const ProjectProviderPolicyMode = Schema.Literal("all", "eu-zdr", "whitelist");
export type ProjectProviderPolicyMode = typeof ProjectProviderPolicyMode.Type;
export const ProjectProviderPolicy = Schema.Struct({
  mode: ProjectProviderPolicyMode,
  /** Provider instances allowed when mode is `whitelist`; empty means none. */
  providerInstanceIds: Schema.Array(ProviderInstanceId).pipe(
    Schema.filter((ids) => new Set(ids).size === ids.length),
  ),
}).annotations(strict);
export type ProjectProviderPolicy = typeof ProjectProviderPolicy.Type;

export const CanonicalProjectBinding = Schema.Struct({
  canonicalRoot: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type CanonicalProjectBinding = typeof CanonicalProjectBinding.Type;

export const BindingRevision = Schema.Struct({
  revisionId: BindingRevisionId,
  revision: Schema.Int.pipe(Schema.positive()),
  previousBinding: Schema.optional(CanonicalProjectBinding),
  currentBinding: CanonicalProjectBinding,
  actor: ProjectActor,
  changedAt: UtcTimestamp,
}).annotations(strict);
export type BindingRevision = typeof BindingRevision.Type;

/**
 * The identity colour a person picks for a Project: the eight roles the theme
 * palette already defines, so a colour follows the active theme rather than
 * carrying its own hex value.
 */
export const ProjectColor = Schema.Literal(
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
);
export type ProjectColor = typeof ProjectColor.Type;

const ProjectFields = {
  id: ProjectId,
  name: Schema.NonEmptyTrimmedString,
  /** Absent means no colour was picked; older Projects and events never carried one. */
  color: Schema.optional(ProjectColor),
  /**
   * The Project's brand: the colours, fonts, radius and spacing its designs
   * draw with when they choose the brand theme. Absent means no kit was
   * defined. It has the shape of a design's own brand, so one rule validates
   * both.
   */
  brandKit: Schema.optional(CanvasDesignBrand),
  lifecycle: ProjectLifecycle,
  pinned: Schema.Boolean,
  rank: ProjectRank,
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
} as const;

/**
 * How a bound Project came to exist. Absent on every Project a person made
 * from a folder they picked. `default-folder` marks the Project the host
 * provisioned itself under the default folder so a thread could start without
 * one being chosen; it is an ordinary Project in every other respect.
 */
export const ProjectOrigin = Schema.Literal("default-folder");
export type ProjectOrigin = typeof ProjectOrigin.Type;

export const MAX_PROJECT_EXTRA_FOLDERS = 16;

/**
 * An absolute folder path in its canonical spelling: a leading `/`, no empty,
 * `.` or `..` segment, no trailing `/`, no NUL. The host stores the real path
 * the folder picker resolved, so a path that is not already in this form was
 * never produced by it.
 */
export const ProjectFolderPath = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter(
    (value) =>
      value.startsWith("/") &&
      value !== "/" &&
      !value.endsWith("/") &&
      !value.includes("\0") &&
      value
        .slice(1)
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
);
export type ProjectFolderPath = typeof ProjectFolderPath.Type;

/**
 * A folder the person added to a bound Project beside its main folder. It gets
 * the main folder's access at each thread's level; commands, checkouts and Git
 * stay in the main folder. Who added it and when are kept with it, and its
 * removal is journaled with the same facts.
 */
export const ProjectExtraFolder = Schema.Struct({
  canonicalRoot: ProjectFolderPath,
  addedBy: ProjectActor,
  addedAt: UtcTimestamp,
}).annotations(strict);
export type ProjectExtraFolder = typeof ProjectExtraFolder.Type;

const folderContains = (outer: string, inner: string): boolean =>
  outer === inner || inner.startsWith(`${outer}/`);

/**
 * The extra folders of one Project: at most {@link MAX_PROJECT_EXTRA_FOLDERS},
 * none equal to, inside, or containing another. Where they sit against the
 * main folder and the host's own folders is judged by the domain policy that
 * adds them.
 */
export const ProjectExtraFolders = Schema.Array(ProjectExtraFolder).pipe(
  Schema.filter(
    (folders) =>
      folders.length <= MAX_PROJECT_EXTRA_FOLDERS &&
      folders.every((folder, index) =>
        folders.every(
          (other, otherIndex) =>
            index === otherIndex || !folderContains(folder.canonicalRoot, other.canonicalRoot),
        ),
      ),
  ),
);
export type ProjectExtraFolders = typeof ProjectExtraFolders.Type;

const BoundProjectFields = {
  binding: CanonicalProjectBinding,
  bindingHistory: Schema.NonEmptyArray(BindingRevision),
  origin: Schema.optional(ProjectOrigin),
  /** Absent on older Projects and interpreted as allow-all. */
  providerPolicy: Schema.optional(ProjectProviderPolicy),
  /** Absent on every Project made before extra folders existed, and read as none. */
  extraFolders: Schema.optional(ProjectExtraFolders),
} as const;

export const ChatProject = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("chat"),
}).annotations(strict);
export type ChatProject = typeof ChatProject.Type;

/**
 * Whether Octant keeps a `STATUS.md` at the top of this Work Project's folder:
 * seeding it, asking every task to keep it current, and reading its dates for
 * reminders. Absent means disabled, so Octant writes nothing into the folder.
 * The default-folder Project can never enable it.
 */
export const WorkProjectStatusFile = Schema.Literal("enabled", "disabled");
export type WorkProjectStatusFile = typeof WorkProjectStatusFile.Type;

export const WorkProject = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("work"),
  ...BoundProjectFields,
  statusFile: Schema.optional(WorkProjectStatusFile),
}).annotations(strict);
export type WorkProject = typeof WorkProject.Type;

/**
 * Whether the host may keep this Project's pull-request snapshot current on a
 * bounded background cadence. Absent means disabled: only an explicit refresh
 * reaches GitHub, exactly the behavior Projects had before the setting existed.
 */
export const CodeProjectPullRequestBackgroundRefresh = Schema.Literal("enabled", "disabled");
export type CodeProjectPullRequestBackgroundRefresh =
  typeof CodeProjectPullRequestBackgroundRefresh.Type;

export const ProjectActionId = brandedUuid("ProjectActionId");
export type ProjectActionId = typeof ProjectActionId.Type;

export const MAX_PROJECT_ACTIONS = 12;

/**
 * A folder inside the Project's bound root, relative to it. `.` is the root
 * itself. A path that could leave the root (absolute, `..`, backslashes) is not
 * a working directory, so the shell is never pointed outside the Project.
 */
export const ProjectActionDirectory = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.filter(
    (value) =>
      value === "." ||
      (value.length > 0 &&
        !value.includes("\0") &&
        !value.includes("\\") &&
        !value.startsWith("/") &&
        !value.endsWith("/") &&
        value === value.normalize("NFC") &&
        value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")),
  ),
);

/**
 * A named command the person runs in the Project's terminal: one line they
 * wrote or confirmed, and the folder under the root it runs in. It is typed
 * into the person's own shell, so it runs under the same confinement and
 * approval posture as anything else typed there.
 */
export const ProjectAction = Schema.Struct({
  id: ProjectActionId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(40)),
  command: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(1_000),
    Schema.filter(
      (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    ),
  ),
  directory: ProjectActionDirectory,
}).annotations(strict);
export type ProjectAction = typeof ProjectAction.Type;

export const ProjectActions = Schema.Array(ProjectAction).pipe(
  Schema.filter(
    (actions) =>
      actions.length <= MAX_PROJECT_ACTIONS &&
      new Set(actions.map((action) => String(action.id))).size === actions.length &&
      new Set(actions.map((action) => action.name.toLowerCase())).size === actions.length,
  ),
);
export type ProjectActions = typeof ProjectActions.Type;

export const CodeProject = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("code"),
  ...BoundProjectFields,
  codeAccessPersistence: CodeAccessPersistence,
  /**
   * Absent on Projects created before this habit existed and on Projects whose
   * owner never
   * chose a habit; readers apply {@link DEFAULT_CODE_NEW_THREAD_WORKSPACE}
   * rather than treating absence as an error.
   */
  newThreadWorkspace: Schema.optional(CodeNewThreadWorkspace),
  pullRequestBackgroundRefresh: Schema.optional(CodeProjectPullRequestBackgroundRefresh),
  /**
   * The mode this Project's new threads start in, overriding Settings. Absent
   * follows Settings, except that a Project which remembered Full access
   * before the field existed (`codeAccessPersistence: "project-default"`)
   * starts in Full access, as it always did.
   */
  defaultPermissionMode: Schema.optional(PermissionMode),
  /**
   * Who answers this Project's prompts at Auto, overriding Settings. Absent
   * follows Settings.
   */
  autoReviewer: Schema.optional(AutoReviewer),
  /**
   * The disposable desktop this Project's threads lease from. Absent means no
   * recipe, so every lease command refuses `no-provider-configured`. A person
   * sets it from a local window; an agent cannot.
   */
  desktopRecipe: Schema.optional(DesktopRecipe),
  /** Named commands for the Project terminal. Absent means none were defined. */
  actions: Schema.optional(ProjectActions),
}).annotations(strict);
export type CodeProject = typeof CodeProject.Type;

export const Project = Schema.Union(ChatProject, WorkProject, CodeProject);
export type Project = typeof Project.Type;
export const BoundProject = Schema.Union(WorkProject, CodeProject);
export type BoundProject = typeof BoundProject.Type;

const WorkProjectSummary = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("work"),
  binding: CanonicalProjectBinding,
  /** Exact current binding revision the renderer must send on create/first turn. */
  bindingRevisionId: BindingRevisionId,
  origin: Schema.optional(ProjectOrigin),
  providerPolicy: Schema.optional(ProjectProviderPolicy),
  extraFolders: Schema.optional(ProjectExtraFolders),
  statusFile: Schema.optional(WorkProjectStatusFile),
}).annotations(strict);

const CodeProjectSummary = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("code"),
  binding: CanonicalProjectBinding,
  bindingRevisionId: BindingRevisionId,
  origin: Schema.optional(ProjectOrigin),
  codeAccessPersistence: CodeAccessPersistence,
  newThreadWorkspace: Schema.optional(CodeNewThreadWorkspace),
  pullRequestBackgroundRefresh: Schema.optional(CodeProjectPullRequestBackgroundRefresh),
  defaultPermissionMode: Schema.optional(PermissionMode),
  autoReviewer: Schema.optional(AutoReviewer),
  desktopRecipe: Schema.optional(DesktopRecipe),
  actions: Schema.optional(ProjectActions),
  connectedRepository: Schema.optional(ConnectedGitHubRepository),
  providerPolicy: Schema.optional(ProjectProviderPolicy),
  extraFolders: Schema.optional(ProjectExtraFolders),
}).annotations(strict);

export const ProjectSummary = Schema.Union(ChatProject, WorkProjectSummary, CodeProjectSummary);
export type ProjectSummary = typeof ProjectSummary.Type;

const AvailabilityFields = { projectId: ProjectId, observedAt: UtcTimestamp } as const;
export const ProjectAvailability = Schema.Union(
  Schema.Struct({
    ...AvailabilityFields,
    status: Schema.Literal("available"),
  }).annotations(strict),
  Schema.Struct({
    ...AvailabilityFields,
    status: Schema.Literal("unavailable"),
    reason: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...AvailabilityFields,
    status: Schema.Literal("unverified"),
    reason: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type ProjectAvailability = typeof ProjectAvailability.Type;

export const MemoryKind = Schema.Literal("decision", "fact", "preference", "summary", "outcome");
export type MemoryKind = typeof MemoryKind.Type;

const UserAuthoredMemoryProvenance = Schema.Struct({
  kind: Schema.Literal("user-authored"),
}).annotations(strict);

const TransferredMemoryProvenance = Schema.Struct({
  kind: Schema.Literal("transferred"),
  sourceProjectId: ProjectId,
  sourceEntryId: MemoryEntryId,
  destinationProjectId: ProjectId,
  transferredBy: ProjectActor,
  transferredAt: UtcTimestamp,
  selectedContent: Schema.NonEmptyTrimmedString,
}).annotations(strict);

export const MemoryProvenance = Schema.Union(
  UserAuthoredMemoryProvenance,
  TransferredMemoryProvenance,
);
export type MemoryProvenance = typeof MemoryProvenance.Type;

const MemoryEntryFields = {
  id: MemoryEntryId,
  projectId: ProjectId,
  kind: MemoryKind,
  content: Schema.NonEmptyTrimmedString,
  provenance: MemoryProvenance,
  author: ProjectActor,
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
} as const;

export const ActiveMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  status: Schema.Literal("active"),
}).annotations(strict);
export type ActiveMemoryEntry = typeof ActiveMemoryEntry.Type;

export const TransferredActiveMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  provenance: TransferredMemoryProvenance,
  status: Schema.Literal("active"),
}).annotations(strict);
export type TransferredActiveMemoryEntry = typeof TransferredActiveMemoryEntry.Type;

export const SupersededMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  status: Schema.Literal("superseded"),
  supersededBy: MemoryEntryId,
}).annotations(strict);
export type SupersededMemoryEntry = typeof SupersededMemoryEntry.Type;

export const RetractedMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  status: Schema.Literal("retracted"),
  retractionReason: Schema.NonEmptyTrimmedString,
  retractedBy: EventActor,
  retractedAt: UtcTimestamp,
}).annotations(strict);
export type RetractedMemoryEntry = typeof RetractedMemoryEntry.Type;

export const MemoryEntry = Schema.Union(
  ActiveMemoryEntry,
  SupersededMemoryEntry,
  RetractedMemoryEntry,
);
export type MemoryEntry = typeof MemoryEntry.Type;

export const ProjectMemoryView = Schema.Struct({
  projectId: ProjectId,
  active: Schema.Array(ActiveMemoryEntry),
  history: Schema.Array(Schema.Union(SupersededMemoryEntry, RetractedMemoryEntry)),
}).annotations(strict);
export type ProjectMemoryView = typeof ProjectMemoryView.Type;

export const ProjectBootstrap = Schema.Struct({
  active: Schema.Array(ProjectSummary),
  archived: Schema.Array(ProjectSummary),
  availability: Schema.Array(ProjectAvailability),
  memory: Schema.Array(ProjectMemoryView),
}).annotations(strict);
export type ProjectBootstrap = typeof ProjectBootstrap.Type;

const ProjectCommandFields = {
  projectId: ProjectId,
  expectedVersion: AggregateVersion,
} as const;

export const ProjectCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-chat-project"),
    ...ProjectCommandFields,
    name: Schema.NonEmptyTrimmedString,
    hostId: HostId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-work-project"),
    ...ProjectCommandFields,
    name: Schema.NonEmptyTrimmedString,
    receiptId: BindingReceiptId,
    hostId: HostId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-code-project"),
    ...ProjectCommandFields,
    name: Schema.NonEmptyTrimmedString,
    receiptId: BindingReceiptId,
    hostId: HostId,
    /**
     * When true, initialize the bound folder as a Git repository before the
     * Project is journaled if it is not already one. Absent or false keeps
     * the bind-without-Git behavior.
     */
    initializeGit: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  /**
   * The Project a thread starts in when nobody chose one: `<default
   * folder>/Work` or `<default folder>/Code`, created by the host on first
   * use and reused after. `projectId` names the Project if one has to be
   * created; when one already exists for the current default folder, that
   * one is returned and the id is unused.
   */
  Schema.Struct({
    kind: Schema.Literal("ensure-default-project"),
    ...ProjectCommandFields,
    projectType: Schema.Literal("work", "code"),
    hostId: HostId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rename-project"),
    ...ProjectCommandFields,
    name: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-project-color"),
    ...ProjectCommandFields,
    /** `null` clears the colour. */
    color: Schema.NullOr(ProjectColor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("move-project"),
    ...ProjectCommandFields,
    pinned: Schema.Boolean,
    beforeProjectId: Schema.optional(ProjectId),
    afterProjectId: Schema.optional(ProjectId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-project-lifecycle"),
    ...ProjectCommandFields,
    lifecycle: ProjectLifecycle,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("relink-project"),
    ...ProjectCommandFields,
    receiptId: BindingReceiptId,
  }).annotations(strict),
  /**
   * Adds the folder a receipt names to a bound Project beside its main folder.
   * A receipt comes only from a host window's folder picker, so only a person
   * can add one.
   */
  Schema.Struct({
    kind: Schema.Literal("add-project-extra-folder"),
    ...ProjectCommandFields,
    receiptId: BindingReceiptId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-project-extra-folder"),
    ...ProjectCommandFields,
    canonicalRoot: ProjectFolderPath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-access"),
    ...ProjectCommandFields,
    codeAccessPersistence: CodeAccessPersistence,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-permission-mode"),
    ...ProjectCommandFields,
    /** Absent returns the Project to the Settings default. */
    permissionMode: Schema.optional(PermissionMode),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-auto-reviewer"),
    ...ProjectCommandFields,
    /** Absent returns the Project to the Settings default. */
    autoReviewer: Schema.optional(AutoReviewer),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-new-thread-workspace"),
    ...ProjectCommandFields,
    newThreadWorkspace: CodeNewThreadWorkspace,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-pull-request-background-refresh"),
    ...ProjectCommandFields,
    pullRequestBackgroundRefresh: CodeProjectPullRequestBackgroundRefresh,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-actions"),
    ...ProjectCommandFields,
    /** The whole list; an empty list removes every action. */
    actions: ProjectActions,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-project-provider-policy"),
    ...ProjectCommandFields,
    policy: ProjectProviderPolicy,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-work-project-status-file"),
    ...ProjectCommandFields,
    statusFile: WorkProjectStatusFile,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-project-brand-kit"),
    ...ProjectCommandFields,
    /** An empty kit clears it. */
    brandKit: CanvasDesignBrand,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-desktop-recipe"),
    ...ProjectCommandFields,
    /** `null` removes the recipe. */
    recipe: Schema.NullOr(DesktopRecipe),
    /**
     * The key a cloud recipe's provider reads, entered or removed with this
     * save. The host stores an entered key in its credential store and
     * journals only the reference.
     */
    key: Schema.optional(DesktopRecipeKeyChange),
  }).annotations(strict),
);
export type ProjectCommand = typeof ProjectCommand.Type;

export const ProjectCommandResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("chat-project-created"), project: ChatProject }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("work-project-created"),
    project: WorkProject,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("code-project-created"), project: CodeProject }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("default-project-ensured"),
    project: BoundProject,
    created: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("project-renamed"), project: Project }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("project-color-changed"), project: Project }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("project-moved"), project: Project }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-lifecycle-changed"),
    project: Project,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("project-relinked"), project: BoundProject }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("project-extra-folder-added"),
    project: BoundProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-extra-folder-removed"),
    project: BoundProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-project-access-changed"),
    project: CodeProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-project-new-thread-workspace-changed"),
    project: CodeProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-project-pull-request-background-refresh-changed"),
    project: CodeProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-project-actions-changed"),
    project: CodeProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-provider-policy-changed"),
    project: BoundProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("work-project-status-file-changed"),
    project: WorkProject,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-brand-kit-changed"),
    project: Project,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-project-desktop-recipe-changed"),
    project: CodeProject,
  }).annotations(strict),
);
export type ProjectCommandResult = typeof ProjectCommandResult.Type;

export const MemoryCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-memory-entry"),
    projectId: ProjectId,
    entryId: MemoryEntryId,
    memoryKind: MemoryKind,
    content: Schema.NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("supersede-memory-entry"),
    projectId: ProjectId,
    entryId: MemoryEntryId,
    successorEntryId: MemoryEntryId,
    content: Schema.NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("retract-memory-entry"),
    projectId: ProjectId,
    entryId: MemoryEntryId,
    reason: Schema.NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("transfer-memory-entry"),
    sourceProjectId: ProjectId,
    sourceEntryId: MemoryEntryId,
    destinationProjectId: ProjectId,
    destinationEntryId: MemoryEntryId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type MemoryCommand = typeof MemoryCommand.Type;

export const MemoryCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("memory-entry-created"),
    entry: ActiveMemoryEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("memory-entry-superseded"),
    previousEntry: SupersededMemoryEntry,
    entry: ActiveMemoryEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("memory-entry-retracted"),
    entry: RetractedMemoryEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("memory-entry-transferred"),
    entry: TransferredActiveMemoryEntry,
  }).annotations(strict),
);
export type MemoryCommandResult = typeof MemoryCommandResult.Type;

const FailureMessage = Schema.NonEmptyTrimmedString;
export const ProjectFailure = Schema.Union(
  Schema.Struct({ category: Schema.Literal("invalid"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({ category: Schema.Literal("unauthorized"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({ category: Schema.Literal("unsupported"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({ category: Schema.Literal("unavailable"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({ category: Schema.Literal("not-found"), message: FailureMessage }).annotations(
    strict,
  ),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: FailureMessage,
    currentVersion: AggregateVersion,
  }).annotations(strict),
);
export type ProjectFailure = typeof ProjectFailure.Type;

export const ProjectCreated = Schema.Struct({ project: Project }).annotations(strict);
export type ProjectCreated = typeof ProjectCreated.Type;
export const ProjectRenamed = Schema.Struct({ project: Project }).annotations(strict);
export type ProjectRenamed = typeof ProjectRenamed.Type;
export const ProjectColorChanged = Schema.Struct({ project: Project }).annotations(strict);
export type ProjectColorChanged = typeof ProjectColorChanged.Type;
export const ProjectOrderChanged = Schema.Struct({ project: Project }).annotations(strict);
export type ProjectOrderChanged = typeof ProjectOrderChanged.Type;
export const ProjectLifecycleChanged = Schema.Struct({ project: Project }).annotations(strict);
export type ProjectLifecycleChanged = typeof ProjectLifecycleChanged.Type;
export const ProjectBindingRelinked = Schema.Struct({ project: BoundProject }).annotations(strict);
export type ProjectBindingRelinked = typeof ProjectBindingRelinked.Type;
/** The whole Project after the add, and the folder with who added it and when. */
export const ProjectExtraFolderAdded = Schema.Struct({
  project: BoundProject,
  folder: ProjectExtraFolder,
}).annotations(strict);
export type ProjectExtraFolderAdded = typeof ProjectExtraFolderAdded.Type;
/** The whole Project after the removal, and the folder with who removed it and when. */
export const ProjectExtraFolderRemoved = Schema.Struct({
  project: BoundProject,
  canonicalRoot: ProjectFolderPath,
  removedBy: ProjectActor,
  removedAt: UtcTimestamp,
}).annotations(strict);
export type ProjectExtraFolderRemoved = typeof ProjectExtraFolderRemoved.Type;
export const CodeProjectAccessChanged = Schema.Struct({ project: CodeProject }).annotations(strict);
export type CodeProjectAccessChanged = typeof CodeProjectAccessChanged.Type;
/**
 * The Project's default mode changed. The payload is the whole Project, so a
 * replay reads the level the Project's new threads start at without the
 * Settings it overrode.
 */
export const CodeProjectPermissionModeChanged = Schema.Struct({
  project: CodeProject,
}).annotations(strict);
export type CodeProjectPermissionModeChanged = typeof CodeProjectPermissionModeChanged.Type;
/** The Project's Auto reviewer changed; the payload is the whole Project. */
export const CodeProjectAutoReviewerChanged = Schema.Struct({
  project: CodeProject,
}).annotations(strict);
export type CodeProjectAutoReviewerChanged = typeof CodeProjectAutoReviewerChanged.Type;
/** Journaled so every window sees the same Project habit after a change. */
export const CodeProjectNewThreadWorkspaceChanged = Schema.Struct({
  project: CodeProject,
}).annotations(strict);
export type CodeProjectNewThreadWorkspaceChanged = typeof CodeProjectNewThreadWorkspaceChanged.Type;
/**
 * Journaled once per user toggle so the opt-in survives a host restart. The
 * background cadence itself never journals: per-poll observations stay in the
 * in-memory snapshot.
 */
export const CodeProjectPullRequestBackgroundRefreshChanged = Schema.Struct({
  project: CodeProject,
}).annotations(strict);
export type CodeProjectPullRequestBackgroundRefreshChanged =
  typeof CodeProjectPullRequestBackgroundRefreshChanged.Type;
/** Journaled once per save so every window and a restarted host see the same list. */
export const CodeProjectActionsChanged = Schema.Struct({ project: CodeProject }).annotations(
  strict,
);
export type CodeProjectActionsChanged = typeof CodeProjectActionsChanged.Type;
export const ProjectProviderPolicyChanged = Schema.Struct({
  project: BoundProject,
}).annotations(strict);
export type ProjectProviderPolicyChanged = typeof ProjectProviderPolicyChanged.Type;
export const WorkProjectStatusFileChanged = Schema.Struct({
  project: WorkProject,
}).annotations(strict);
export type WorkProjectStatusFileChanged = typeof WorkProjectStatusFileChanged.Type;
export const ProjectBrandKitChanged = Schema.Struct({ project: Project }).annotations(strict);
export type ProjectBrandKitChanged = typeof ProjectBrandKitChanged.Type;
/** Journaled once per person's save or removal; the lease service reads the Project it leaves. */
export const CodeProjectDesktopRecipeChanged = Schema.Struct({
  project: CodeProject,
}).annotations(strict);
export type CodeProjectDesktopRecipeChanged = typeof CodeProjectDesktopRecipeChanged.Type;

export const MemoryEntryCreated = Schema.Struct({ entry: ActiveMemoryEntry }).annotations(strict);
export type MemoryEntryCreated = typeof MemoryEntryCreated.Type;
export const MemoryEntrySuperseded = Schema.Struct({
  previousEntry: SupersededMemoryEntry,
  entry: ActiveMemoryEntry,
}).annotations(strict);
export type MemoryEntrySuperseded = typeof MemoryEntrySuperseded.Type;
export const MemoryEntryRetracted = Schema.Struct({ entry: RetractedMemoryEntry }).annotations(
  strict,
);
export type MemoryEntryRetracted = typeof MemoryEntryRetracted.Type;
export const MemoryEntryTransferred = Schema.Struct({
  entry: TransferredActiveMemoryEntry,
}).annotations(strict);
export type MemoryEntryTransferred = typeof MemoryEntryTransferred.Type;

export const PROJECT_EVENT_NAMES = [
  "project.created@1",
  "project.renamed@1",
  "project.color-changed@1",
  "project.order-changed@1",
  "project.lifecycle-changed@1",
  "project.binding-relinked@1",
  "project.code-access-changed@1",
  "project.code-permission-mode-changed@1",
  "project.code-auto-reviewer-changed@1",
  "project.code-new-thread-workspace-changed@1",
  "project.code-pull-request-background-refresh-changed@1",
  "project.provider-policy-changed@1",
  "project.work-status-file-changed@1",
  "project.brand-kit-changed@1",
  "project.code-desktop-recipe-changed@1",
  "project.code-actions-changed@1",
  "project.extra-folder-added@1",
  "project.extra-folder-removed@1",
  "memory.entry-created@1",
  "memory.entry-superseded@1",
  "memory.entry-retracted@1",
  "memory.entry-transferred@1",
] as const;

export const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
export const decodeProjectAction = Schema.decodeUnknownSync(ProjectAction);
export const decodeProjectActions = Schema.decodeUnknownSync(ProjectActions);
export const decodeProjectActionId = Schema.decodeUnknownSync(ProjectActionId);
export const decodeMemoryEntryId = Schema.decodeUnknownSync(MemoryEntryId);
export const decodeBindingRevisionId = Schema.decodeUnknownSync(BindingRevisionId);
export const decodeBindingReceiptId = Schema.decodeUnknownSync(BindingReceiptId);
export const decodeProjectRank = Schema.decodeUnknownSync(ProjectRank);
export const decodeProject = Schema.decodeUnknownSync(Project);
export const decodeProjectSummary = Schema.decodeUnknownSync(ProjectSummary);
export const decodeConnectedGitHubRepository = Schema.decodeUnknownSync(ConnectedGitHubRepository);
export const decodeProjectAvailability = Schema.decodeUnknownSync(ProjectAvailability);
export const decodeProjectBootstrap = Schema.decodeUnknownSync(ProjectBootstrap);
export const decodeProjectCommand = Schema.decodeUnknownSync(ProjectCommand);
export const decodeProjectCommandResult = Schema.decodeUnknownSync(ProjectCommandResult);
export const decodeMemoryEntry = Schema.decodeUnknownSync(MemoryEntry);
export const decodeProjectMemoryView = Schema.decodeUnknownSync(ProjectMemoryView);
export const decodeMemoryCommand = Schema.decodeUnknownSync(MemoryCommand);
export const decodeMemoryCommandResult = Schema.decodeUnknownSync(MemoryCommandResult);
export const decodeProjectFailure = Schema.decodeUnknownSync(ProjectFailure);
export const decodeProjectCreated = Schema.decodeUnknownSync(ProjectCreated);
export const decodeProjectRenamed = Schema.decodeUnknownSync(ProjectRenamed);
export const decodeProjectColorChanged = Schema.decodeUnknownSync(ProjectColorChanged);
export const decodeProjectOrderChanged = Schema.decodeUnknownSync(ProjectOrderChanged);
export const decodeProjectLifecycleChanged = Schema.decodeUnknownSync(ProjectLifecycleChanged);
export const decodeProjectBindingRelinked = Schema.decodeUnknownSync(ProjectBindingRelinked);
export const decodeProjectFolderPath = Schema.decodeUnknownSync(ProjectFolderPath);
export const decodeProjectExtraFolder = Schema.decodeUnknownSync(ProjectExtraFolder);
export const decodeProjectExtraFolderAdded = Schema.decodeUnknownSync(ProjectExtraFolderAdded);
export const decodeProjectExtraFolderRemoved = Schema.decodeUnknownSync(ProjectExtraFolderRemoved);
export const decodeCodeProjectAccessChanged = Schema.decodeUnknownSync(CodeProjectAccessChanged);
export const decodeCodeProjectPermissionModeChanged = Schema.decodeUnknownSync(
  CodeProjectPermissionModeChanged,
);
export const decodeCodeProjectAutoReviewerChanged = Schema.decodeUnknownSync(
  CodeProjectAutoReviewerChanged,
);
export const decodeCodeProjectNewThreadWorkspaceChanged = Schema.decodeUnknownSync(
  CodeProjectNewThreadWorkspaceChanged,
);
export const decodeCodeProjectPullRequestBackgroundRefreshChanged = Schema.decodeUnknownSync(
  CodeProjectPullRequestBackgroundRefreshChanged,
);
export const decodeCodeProjectActionsChanged = Schema.decodeUnknownSync(CodeProjectActionsChanged);
export const decodeProjectProviderPolicyChanged = Schema.decodeUnknownSync(
  ProjectProviderPolicyChanged,
);
export const decodeWorkProjectStatusFileChanged = Schema.decodeUnknownSync(
  WorkProjectStatusFileChanged,
);
export const decodeProjectBrandKitChanged = Schema.decodeUnknownSync(ProjectBrandKitChanged);
export const decodeCodeProjectDesktopRecipeChanged = Schema.decodeUnknownSync(
  CodeProjectDesktopRecipeChanged,
);
export const decodeMemoryEntryCreated = Schema.decodeUnknownSync(MemoryEntryCreated);
export const decodeMemoryEntrySuperseded = Schema.decodeUnknownSync(MemoryEntrySuperseded);
export const decodeMemoryEntryRetracted = Schema.decodeUnknownSync(MemoryEntryRetracted);
export const decodeMemoryEntryTransferred = Schema.decodeUnknownSync(MemoryEntryTransferred);
