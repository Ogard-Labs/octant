import { Schema } from "effect";
import {
  GuidString,
  NonEmptyTrimmedString,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import { ApprovedWorkingFolders } from "./workingDirectory";
import { CanvasDesignBrand } from "./canvasBrand";
import { DesignSystemChoice } from "./designSystems";
import { DesktopRecipe, DesktopRecipeKeyChange } from "./desktopLease";
import { ActorId, AggregateVersion, EventActor, EventActorDeviceId, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ApprovalOutsideContent } from "./contentProvenance";
import { OctantMode } from "./modes";
import {
  KeyProviderDriverKinds,
  PermissionMode,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";
import { AutoReviewer } from "./shield";
import { LinearNodeId } from "./linearIssues";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const ProjectId = brandedUuid("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const MemoryEntryId = brandedUuid("MemoryEntryId");
export type MemoryEntryId = typeof MemoryEntryId.Type;
export const BindingRevisionId = brandedUuid("BindingRevisionId");
export type BindingRevisionId = typeof BindingRevisionId.Type;
export const BindingReceiptId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)),
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
  Schema.check(
    Schema.isPattern(/^-?(?:0|[1-9]\d*)\/[1-9]\d*$/),
    Schema.makeFilter((value) => {
      const [numeratorText, denominatorText] = value.split("/") as [string, string];
      const numerator = BigInt(numeratorText);
      const denominator = BigInt(denominatorText);
      return numeratorText !== "-0" && gcd(numerator, denominator) === 1n;
    }),
  ),
  Schema.brand("ProjectRank"),
);
export type ProjectRank = typeof ProjectRank.Type;

export const ProjectType = Schema.Literals(["chat", "work", "code"]);
export type ProjectType = typeof ProjectType.Type;
export const ProjectLifecycle = Schema.Literals(["active", "archived"]);
export type ProjectLifecycle = typeof ProjectLifecycle.Type;

export const CodeAccessPersistence = Schema.Literals(["current-session", "project-default"]);
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
  owner: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/),
  ),
  repository: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isPattern(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/),
  ),
});
export type ConnectedGitHubRepository = typeof ConnectedGitHubRepository.Type;

/**
 * The Linear team (and optional Linear project) a bound Octant Project scopes
 * its Linear issues and project-pinned `octant_linear` reads to. Set from a
 * local window on this host; never carries credentials or arbitrary URLs.
 */
export const ProjectLinearTarget = Schema.Struct({
  teamId: LinearNodeId,
  teamKey: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isPattern(/^[A-Z][A-Z0-9]{0,9}$/)),
  teamName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  projectId: Schema.optional(LinearNodeId),
  projectName: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
}).check(
  Schema.makeFilter(
    (target) => (target.projectId === undefined) === (target.projectName === undefined),
    { message: "Linear project id and name must be provided together." },
  ),
);
export type ProjectLinearTarget = typeof ProjectLinearTarget.Type;

/**
 * How a Code Project prefers new threads to start: in a managed
 * worktree Octant creates and owns, or in the Project's current checkout.
 *
 * This is a Project habit, not a second workspace product: the create dialog
 * still overrides it for one thread without rewriting the Project setting, and
 * the values stay inside the checkout kinds Code already supports.
 */
export const CodeNewThreadWorkspace = Schema.Literals(["managed-worktree", "current-checkout"]);
export type CodeNewThreadWorkspace = typeof CodeNewThreadWorkspace.Type;

/**
 * The habit a Code Project falls back to before a user has ever chosen one.
 * Current checkout is the conservative default: it creates no worktree and no
 * host state the user did not ask for.
 */
export const DEFAULT_CODE_NEW_THREAD_WORKSPACE: CodeNewThreadWorkspace = "current-checkout";
export const Phase3CodeAccessPersistence = Schema.Literal("current-session");
export type Phase3CodeAccessPersistence = typeof Phase3CodeAccessPersistence.Type;

/**
 * Who a Project record says did something: the host itself, the person at
 * this host, or a device that person paired, named by its id. A record
 * written before a device could act names only the first two.
 */
export const ProjectActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("system"), actorId: ActorId }),
  Schema.Struct({ kind: Schema.Literal("local-user"), actorId: ActorId }),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    actorId: ActorId,
    deviceId: EventActorDeviceId,
  }),
]);
export type ProjectActor = typeof ProjectActor.Type;

export const ProjectProviderPolicyMode = Schema.Literals(["all", "eu-zdr", "whitelist"]);
export type ProjectProviderPolicyMode = typeof ProjectProviderPolicyMode.Type;
export const ProjectProviderPolicy = Schema.Struct({
  mode: ProjectProviderPolicyMode,
  /** Provider instances allowed when mode is `whitelist`; empty means none. */
  providerInstanceIds: Schema.Array(ProviderInstanceId).check(
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
});
export type ProjectProviderPolicy = typeof ProjectProviderPolicy.Type;

export const CanonicalProjectBinding = Schema.Struct({
  canonicalRoot: NonEmptyTrimmedString,
});
export type CanonicalProjectBinding = typeof CanonicalProjectBinding.Type;

export const BindingRevision = Schema.Struct({
  revisionId: BindingRevisionId,
  revision: PositiveInt,
  previousBinding: Schema.optional(CanonicalProjectBinding),
  currentBinding: CanonicalProjectBinding,
  actor: ProjectActor,
  changedAt: UtcTimestamp,
});
export type BindingRevision = typeof BindingRevision.Type;

/**
 * The identity colour a person picks for a Project: the eight roles the theme
 * palette already defines, so a colour follows the active theme rather than
 * carrying its own hex value.
 */
export const ProjectColor = Schema.Literals([
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
]);
export type ProjectColor = typeof ProjectColor.Type;

/**
 * Whether an agent below Full access may write this Project's memory without
 * the person confirming each change. Absent means disabled: each write waits
 * for the person. Full access never asks and Plan never writes, whatever this
 * says. Only a window on the host sets it.
 */
export const ProjectAgentMemoryWrites = Schema.Literals(["enabled", "disabled"]);
export type ProjectAgentMemoryWrites = typeof ProjectAgentMemoryWrites.Type;

/**
 * The image profile and model a person told a thread of this Project to keep
 * using without asking ("Don't ask again" on the image card). An agent's image
 * call in the Project then generates with it at every level, in a routine's
 * turn too. Absent means each call asks, apart from Full access with exactly
 * one ready image profile. The host drops a choice it can no longer run.
 */
export const ProjectImageGenerationChoice = Schema.Struct({
  profileInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
});
export type ProjectImageGenerationChoice = typeof ProjectImageGenerationChoice.Type;

const ProjectFields = {
  id: ProjectId,
  name: NonEmptyTrimmedString,
  /** Absent means no colour was picked; older Projects and events never carried one. */
  color: Schema.optional(ProjectColor),
  /**
   * The Project's brand: the colours, fonts, radius and spacing its designs
   * draw with when they choose the brand theme. Absent means no kit was
   * defined. It has the shape of a design's own brand, so one rule validates
   * both.
   */
  brandKit: Schema.optional(CanvasDesignBrand),
  agentMemoryWrites: Schema.optional(ProjectAgentMemoryWrites),
  imageGenerationChoice: Schema.optional(ProjectImageGenerationChoice),
  /**
   * Set when the person dropped the kept choice with Ask again, so the next
   * image call shows the card even at Full access; cleared when a choice is
   * kept again.
   */
  imageGenerationAskAgain: Schema.optional(Schema.Literal(true)),
  /**
   * The video profile and model the Project's agents generate clips with
   * without asking, kept by the same rule as the image choice (maintainer
   * decision, 2026-11-22: one consent rule keyed by media kind).
   */
  videoGenerationChoice: Schema.optional(ProjectImageGenerationChoice),
  /** As `imageGenerationAskAgain`, for video. */
  videoGenerationAskAgain: Schema.optional(Schema.Literal(true)),
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
export const ProjectFolderPath = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter(
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
  /** Server-owned add identity; older records use their original timestamp. */
  addedRevision: Schema.optional(AggregateVersion),
});
export type ProjectExtraFolder = typeof ProjectExtraFolder.Type;

const folderContains = (outer: string, inner: string): boolean =>
  outer === inner || inner.startsWith(`${outer}/`);

/**
 * The extra folders of one Project: at most {@link MAX_PROJECT_EXTRA_FOLDERS},
 * none equal to, inside, or containing another. Where they sit against the
 * main folder and the host's own folders is judged by the domain policy that
 * adds them.
 */
export const ProjectExtraFolders = Schema.Array(ProjectExtraFolder).check(
  Schema.makeFilter(
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
  /**
   * The key providers the person trusted in this Project: each runs here as
   * itself, with its own setup and the Project's own settings, hooks, MCP
   * servers, plugins, and tools. Absent trusts none. A person sets it from a
   * window on this host; an agent cannot.
   */
  nativeProviders: Schema.optional(KeyProviderDriverKinds),
  /** Absent on every Project made before extra folders existed, and read as none. */
  extraFolders: Schema.optional(ProjectExtraFolders),
  /**
   * The design system (`DESIGN.md`) a person chose for this Project, or that
   * they turned design systems off. Absent follows the automatic rule.
   */
  designSystem: Schema.optional(DesignSystemChoice),
  /** Linear team (and optional Linear project) bound to this Project. */
  linearTarget: Schema.optional(ProjectLinearTarget),
} as const;

export const ChatProject = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("chat"),
});
export type ChatProject = typeof ChatProject.Type;

/**
 * Whether Octant keeps a `STATUS.md` at the top of this Work Project's folder:
 * seeding it, asking every task to keep it current, and reading its dates for
 * reminders. Absent means disabled, so Octant writes nothing into the folder.
 * The default-folder Project can never enable it.
 */
export const WorkProjectStatusFile = Schema.Literals(["enabled", "disabled"]);
export type WorkProjectStatusFile = typeof WorkProjectStatusFile.Type;

/**
 * Whether the host may keep this Project's pull-request snapshot current on a
 * bounded background cadence. Absent means disabled: only an explicit refresh
 * reaches GitHub, exactly the behavior Projects had before the setting existed.
 */
export const CodeProjectPullRequestBackgroundRefresh = Schema.Literals(["enabled", "disabled"]);
export type CodeProjectPullRequestBackgroundRefresh =
  typeof CodeProjectPullRequestBackgroundRefresh.Type;

/**
 * Whether a Code agent may merge the pull request its thread owns without the
 * per-merge approval a request in the turn needs. Absent means disabled: the
 * agent merges only on the person's request, with that act's approval. Only a
 * window on the host sets it, and every merge it allows is journaled as
 * allowed by the Project.
 */
export const CodeProjectAgentMerge = Schema.Literals(["enabled", "disabled"]);
export type CodeProjectAgentMerge = typeof CodeProjectAgentMerge.Type;
/**
 * A Code Project's mark that it takes delegated Code work from other members
 * of the hub, with the delivery target its person confirmed: the remote and
 * base branch a delegated thread's own branch starts from, and the outcome it
 * aims at. Absent, the Project takes none. Only the host's own person sets it
 * (hub and spokes, Code delegation). The outcome kinds are the Code delivery
 * outcomes, written here because the Code contracts import this module.
 */
export const CodeProjectDelegatedCode = Schema.Struct({
  remoteName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  baseBranch: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  outcomeKind: Schema.Literals([
    "investigation-result",
    "local-implementation",
    "opened-pr",
    "merged-pr",
  ]),
  confirmedAt: UtcTimestamp,
});
export type CodeProjectDelegatedCode = typeof CodeProjectDelegatedCode.Type;
export const decodeCodeProjectDelegatedCode = Schema.decodeUnknownSync(
  CodeProjectDelegatedCode,
  STRICT_DECODE_OPTIONS,
);
/**
 * Whether a Code agent below Full access may post a comment or a review reply
 * on the pull request its thread owns without the per-post approval. Absent
 * means disabled: each post asks. Full access never asks, whatever this says.
 * Only a window on the host sets it.
 */
export const CodeProjectAgentPullRequestComments = Schema.Literals(["enabled", "disabled"]);
export type CodeProjectAgentPullRequestComments = typeof CodeProjectAgentPullRequestComments.Type;
/**
 * Whether a push to the default branch goes ahead on the thread's ordinary
 * push authority. Absent means disabled: such a push needs the person's
 * approval for that one act, as a plain force-push always does. Only a window
 * on the host sets it.
 */
export const CodeProjectAgentDefaultBranchPush = Schema.Literals(["enabled", "disabled"]);
export type CodeProjectAgentDefaultBranchPush = typeof CodeProjectAgentDefaultBranchPush.Type;

/**
 * Whether this Project's language services run the Project's own copy of a
 * language's toolchain (its pinned TypeScript, say) instead of the one Octant
 * bundles. Absent means disabled. The Project's copy is a program the
 * repository supplies, so a server run from it is `repo-tooling`: approved per
 * checkout, refused in Plan, and started only by the person at the machine.
 * Only a window on the host sets it.
 */
export const CodeProjectOwnToolchain = Schema.Literals(["enabled", "disabled"]);
export type CodeProjectOwnToolchain = typeof CodeProjectOwnToolchain.Type;

export const ProjectActionId = brandedUuid("ProjectActionId");
export type ProjectActionId = typeof ProjectActionId.Type;

export const MAX_PROJECT_ACTIONS = 12;

/**
 * A folder inside the Project's bound root, relative to it. `.` is the root
 * itself. A path that could leave the root (absolute, `..`, backslashes) is not
 * a working directory, so the shell is never pointed outside the Project.
 */
export const ProjectActionDirectory = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
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
 * A named command the person runs in a dedicated process: one line they
 * wrote or confirmed, and the relative folder under the host-resolved root.
 * The host applies the chosen checkout's current execution authority.
 */
export const ProjectAction = Schema.Struct({
  id: ProjectActionId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(40)),
  command: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(1_000),
    Schema.makeFilter(
      (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    ),
  ),
  directory: ProjectActionDirectory,
  preparesWorktrees: Schema.optional(Schema.Literal(true)),
});
export type ProjectAction = typeof ProjectAction.Type;

export const ProjectActions = Schema.Array(ProjectAction).check(
  Schema.makeFilter(
    (actions) =>
      actions.length <= MAX_PROJECT_ACTIONS &&
      actions.filter((action) => action.preparesWorktrees === true).length <= 1 &&
      new Set(actions.map((action) => String(action.id))).size === actions.length &&
      new Set(actions.map((action) => action.name.toLowerCase())).size === actions.length,
  ),
);
export type ProjectActions = typeof ProjectActions.Type;

/**
 * Whether a Work Project shows Octant's developer surfaces (its Project
 * terminal and Project actions today; Git and pull-request panels where they
 * exist), and who last turned them on or off and when. A person sets it from a
 * window on the host; an agent, a routine, or an import never does. It changes
 * what the Project shows, never what its threads may do: a Work thread runs
 * commands and `git` through its shell at its level with it off. Absent means
 * off.
 */
export const WorkProjectDeveloperTools = Schema.Struct({
  enabled: Schema.Boolean,
  changedBy: EventActor,
  changedAt: UtcTimestamp,
});
export type WorkProjectDeveloperTools = typeof WorkProjectDeveloperTools.Type;

/**
 * The modes a Work Project can start new threads in. Work shares Code's
 * levels, Plan included (maintainer decision, 2026-11-21).
 */
export const WorkProjectPermissionMode = Schema.Literals([
  "auto",
  "ask-first",
  "accept-edits",
  "full-access",
  "plan",
]);
export type WorkProjectPermissionMode = typeof WorkProjectPermissionMode.Type;

export const WorkProject = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("work"),
  ...BoundProjectFields,
  statusFile: Schema.optional(WorkProjectStatusFile),
  developerTools: Schema.optional(WorkProjectDeveloperTools),
  /**
   * The mode this Project's new Work threads start in, overriding Work's
   * default in Settings. Absent follows Settings.
   */
  defaultPermissionMode: Schema.optional(WorkProjectPermissionMode),
  /** New threads here at Full access keep the sandbox; absent follows Settings. */
  defaultFullAccessSandbox: Schema.optional(Schema.Boolean),
  /** Strict for threads here that did not choose; absent follows Settings. */
  defaultStrict: Schema.optional(Schema.Boolean),
  /** Named commands for the Project terminal. Absent means none were defined. */
  actions: Schema.optional(ProjectActions),
});
export type WorkProject = typeof WorkProject.Type;

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
  agentMerge: Schema.optional(CodeProjectAgentMerge),
  delegatedCode: Schema.optional(CodeProjectDelegatedCode),
  ownToolchain: Schema.optional(CodeProjectOwnToolchain),
  agentPullRequestComments: Schema.optional(CodeProjectAgentPullRequestComments),
  agentDefaultBranchPush: Schema.optional(CodeProjectAgentDefaultBranchPush),
  /**
   * The host moves the issues linked to this Project's threads to In
   * Progress, In Review and Done, with a comment on merge. Absent is off.
   */
  keepLinkedIssuesCurrent: Schema.optional(Schema.Boolean),
  /**
   * Agents below Full access change the state of, or comment on, their
   * thread's linked issues without asking for each act. Absent is off.
   */
  agentsMayUpdateIssues: Schema.optional(Schema.Boolean),
  /**
   * The mode this Project's new threads start in, overriding Settings. Absent
   * follows Settings, except that a Project which remembered Full access
   * before the field existed (`codeAccessPersistence: "project-default"`)
   * starts in Full access, as it always did.
   */
  defaultPermissionMode: Schema.optional(PermissionMode),
  /** New threads here at Full access keep the sandbox; absent follows Settings. */
  defaultFullAccessSandbox: Schema.optional(Schema.Boolean),
  /** Strict for threads here that did not choose; absent follows Settings. */
  defaultStrict: Schema.optional(Schema.Boolean),
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
});
export type CodeProject = typeof CodeProject.Type;

export const Project = Schema.Union([ChatProject, WorkProject, CodeProject]);
export type Project = typeof Project.Type;
export const BoundProject = Schema.Union([WorkProject, CodeProject]);
export type BoundProject = typeof BoundProject.Type;

const WorkProjectSummary = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("work"),
  binding: CanonicalProjectBinding,
  /** Exact current binding revision the renderer must send on create/first turn. */
  bindingRevisionId: BindingRevisionId,
  workingFolders: Schema.optional(ApprovedWorkingFolders),
  origin: Schema.optional(ProjectOrigin),
  providerPolicy: Schema.optional(ProjectProviderPolicy),
  nativeProviders: Schema.optional(KeyProviderDriverKinds),
  extraFolders: Schema.optional(ProjectExtraFolders),
  statusFile: Schema.optional(WorkProjectStatusFile),
  developerTools: Schema.optional(WorkProjectDeveloperTools),
  defaultPermissionMode: Schema.optional(WorkProjectPermissionMode),
  /** New threads here at Full access keep the sandbox; absent follows Settings. */
  defaultFullAccessSandbox: Schema.optional(Schema.Boolean),
  /** Strict for threads here that did not choose; absent follows Settings. */
  defaultStrict: Schema.optional(Schema.Boolean),
  actions: Schema.optional(ProjectActions),
  designSystem: Schema.optional(DesignSystemChoice),
  linearTarget: Schema.optional(ProjectLinearTarget),
});

const CodeProjectSummary = Schema.Struct({
  ...ProjectFields,
  type: Schema.Literal("code"),
  binding: CanonicalProjectBinding,
  bindingRevisionId: BindingRevisionId,
  workingFolders: Schema.optional(ApprovedWorkingFolders),
  origin: Schema.optional(ProjectOrigin),
  codeAccessPersistence: CodeAccessPersistence,
  newThreadWorkspace: Schema.optional(CodeNewThreadWorkspace),
  pullRequestBackgroundRefresh: Schema.optional(CodeProjectPullRequestBackgroundRefresh),
  agentMerge: Schema.optional(CodeProjectAgentMerge),
  delegatedCode: Schema.optional(CodeProjectDelegatedCode),
  ownToolchain: Schema.optional(CodeProjectOwnToolchain),
  agentPullRequestComments: Schema.optional(CodeProjectAgentPullRequestComments),
  agentDefaultBranchPush: Schema.optional(CodeProjectAgentDefaultBranchPush),
  /**
   * The host moves the issues linked to this Project's threads to In
   * Progress, In Review and Done, with a comment on merge. Absent is off.
   */
  keepLinkedIssuesCurrent: Schema.optional(Schema.Boolean),
  /**
   * Agents below Full access change the state of, or comment on, their
   * thread's linked issues without asking for each act. Absent is off.
   */
  agentsMayUpdateIssues: Schema.optional(Schema.Boolean),
  defaultPermissionMode: Schema.optional(PermissionMode),
  /** New threads here at Full access keep the sandbox; absent follows Settings. */
  defaultFullAccessSandbox: Schema.optional(Schema.Boolean),
  /** Strict for threads here that did not choose; absent follows Settings. */
  defaultStrict: Schema.optional(Schema.Boolean),
  autoReviewer: Schema.optional(AutoReviewer),
  desktopRecipe: Schema.optional(DesktopRecipe),
  actions: Schema.optional(ProjectActions),
  connectedRepository: Schema.optional(ConnectedGitHubRepository),
  providerPolicy: Schema.optional(ProjectProviderPolicy),
  nativeProviders: Schema.optional(KeyProviderDriverKinds),
  extraFolders: Schema.optional(ProjectExtraFolders),
  designSystem: Schema.optional(DesignSystemChoice),
  linearTarget: Schema.optional(ProjectLinearTarget),
});

export const ProjectSummary = Schema.Union([ChatProject, WorkProjectSummary, CodeProjectSummary]);
export type ProjectSummary = typeof ProjectSummary.Type;

const AvailabilityFields = { projectId: ProjectId, observedAt: UtcTimestamp } as const;
export const ProjectAvailability = Schema.Union([
  Schema.Struct({
    ...AvailabilityFields,
    status: Schema.Literal("available"),
  }),
  Schema.Struct({
    ...AvailabilityFields,
    status: Schema.Literal("unavailable"),
    reason: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    ...AvailabilityFields,
    status: Schema.Literal("unverified"),
    reason: NonEmptyTrimmedString,
  }),
]);
export type ProjectAvailability = typeof ProjectAvailability.Type;

export const MemoryKind = Schema.Literals(["decision", "fact", "preference", "summary", "outcome"]);
export type MemoryKind = typeof MemoryKind.Type;

const UserAuthoredMemoryProvenance = Schema.Struct({
  kind: Schema.Literal("user-authored"),
});

const TransferredMemoryProvenance = Schema.Struct({
  kind: Schema.Literal("transferred"),
  sourceProjectId: ProjectId,
  sourceEntryId: MemoryEntryId,
  destinationProjectId: ProjectId,
  transferredBy: ProjectActor,
  transferredAt: UtcTimestamp,
  selectedContent: NonEmptyTrimmedString,
});

/**
 * A change an agent made from a thread: where the words came from. When the
 * person approved it they are the entry's author. `unconfirmed` marks a change
 * accepted with nobody asked, at Full access or under the Project's setting;
 * the author field then holds the host's person only because every entry has
 * one, not because they saw the change. A thread purge removes `threadId` and
 * keeps the entry.
 */
export const AgentAuthoredMemoryProvenance = Schema.Struct({
  kind: Schema.Literal("agent-authored"),
  mode: OctantMode,
  threadId: Schema.optional(GuidString),
  unconfirmed: Schema.optional(Schema.Literal(true)),
});
export type AgentAuthoredMemoryProvenance = typeof AgentAuthoredMemoryProvenance.Type;

export const MemoryProvenance = Schema.Union([
  UserAuthoredMemoryProvenance,
  TransferredMemoryProvenance,
  AgentAuthoredMemoryProvenance,
]);
export type MemoryProvenance = typeof MemoryProvenance.Type;

const MemoryEntryFields = {
  id: MemoryEntryId,
  projectId: ProjectId,
  kind: MemoryKind,
  content: NonEmptyTrimmedString,
  provenance: MemoryProvenance,
  author: ProjectActor,
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
} as const;

export const ActiveMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  status: Schema.Literal("active"),
});
export type ActiveMemoryEntry = typeof ActiveMemoryEntry.Type;

export const TransferredActiveMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  provenance: TransferredMemoryProvenance,
  status: Schema.Literal("active"),
});
export type TransferredActiveMemoryEntry = typeof TransferredActiveMemoryEntry.Type;

export const SupersededMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  status: Schema.Literal("superseded"),
  supersededBy: MemoryEntryId,
});
export type SupersededMemoryEntry = typeof SupersededMemoryEntry.Type;

export const RetractedMemoryEntry = Schema.Struct({
  ...MemoryEntryFields,
  status: Schema.Literal("retracted"),
  retractionReason: NonEmptyTrimmedString,
  retractedBy: EventActor,
  retractedAt: UtcTimestamp,
  /** The thread whose agent retracted it; absent when the person did it themselves. */
  retractionOrigin: Schema.optional(AgentAuthoredMemoryProvenance),
});
export type RetractedMemoryEntry = typeof RetractedMemoryEntry.Type;

export const MemoryEntry = Schema.Union([
  ActiveMemoryEntry,
  SupersededMemoryEntry,
  RetractedMemoryEntry,
]);
export type MemoryEntry = typeof MemoryEntry.Type;

export const ProjectMemoryView = Schema.Struct({
  projectId: ProjectId,
  active: Schema.Array(ActiveMemoryEntry),
  history: Schema.Array(Schema.Union([SupersededMemoryEntry, RetractedMemoryEntry])),
});
export type ProjectMemoryView = typeof ProjectMemoryView.Type;

export const ProjectBootstrap = Schema.Struct({
  active: Schema.Array(ProjectSummary),
  archived: Schema.Array(ProjectSummary),
  availability: Schema.Array(ProjectAvailability),
  memory: Schema.Array(ProjectMemoryView),
});
export type ProjectBootstrap = typeof ProjectBootstrap.Type;

const ProjectCommandFields = {
  projectId: ProjectId,
  expectedVersion: AggregateVersion,
} as const;

export const ProjectCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create-chat-project"),
    ...ProjectCommandFields,
    name: NonEmptyTrimmedString,
    hostId: HostId,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-work-project"),
    ...ProjectCommandFields,
    name: NonEmptyTrimmedString,
    receiptId: BindingReceiptId,
    hostId: HostId,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-code-project"),
    ...ProjectCommandFields,
    name: NonEmptyTrimmedString,
    receiptId: BindingReceiptId,
    hostId: HostId,
    /**
     * When true, initialize the bound folder as a Git repository before the
     * Project is journaled if it is not already one. Absent or false keeps
     * the bind-without-Git behavior.
     */
    initializeGit: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("ensure-default-project"),
    ...ProjectCommandFields,
    projectType: Schema.Literals(["work", "code"]),
    hostId: HostId,
  }),
  Schema.Struct({
    kind: Schema.Literal("rename-project"),
    ...ProjectCommandFields,
    name: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-color"),
    ...ProjectCommandFields,
    /** `null` clears the colour. */
    color: Schema.NullOr(ProjectColor),
  }),
  Schema.Struct({
    kind: Schema.Literal("move-project"),
    ...ProjectCommandFields,
    pinned: Schema.Boolean,
    beforeProjectId: Schema.optional(ProjectId),
    afterProjectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-lifecycle"),
    ...ProjectCommandFields,
    lifecycle: ProjectLifecycle,
  }),
  Schema.Struct({
    kind: Schema.Literal("relink-project"),
    ...ProjectCommandFields,
    receiptId: BindingReceiptId,
  }),
  Schema.Struct({
    kind: Schema.Literal("add-project-extra-folder"),
    ...ProjectCommandFields,
    receiptId: BindingReceiptId,
    /**
     * The person confirmed the home folder warning. A home folder sent
     * without it is not added: the host answers with the warning and a fresh
     * receipt for the same folder, which a confirmed resend spends.
     */
    confirmHomeFolder: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-project-extra-folder"),
    ...ProjectCommandFields,
    canonicalRoot: ProjectFolderPath,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-access"),
    ...ProjectCommandFields,
    codeAccessPersistence: CodeAccessPersistence,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-permission-mode"),
    ...ProjectCommandFields,
    /** Absent returns the Project to the Settings default. */
    permissionMode: Schema.optional(PermissionMode),
    /** The sandbox at Full access for new threads; absent returns it to Settings. */
    fullAccessSandbox: Schema.optional(Schema.Boolean),
    /** Strict for threads here; absent keeps the choice, null returns it to Settings. */
    strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-auto-reviewer"),
    ...ProjectCommandFields,
    /** Absent returns the Project to the Settings default. */
    autoReviewer: Schema.optional(AutoReviewer),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-new-thread-workspace"),
    ...ProjectCommandFields,
    newThreadWorkspace: CodeNewThreadWorkspace,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-pull-request-background-refresh"),
    ...ProjectCommandFields,
    pullRequestBackgroundRefresh: CodeProjectPullRequestBackgroundRefresh,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-agent-merge"),
    ...ProjectCommandFields,
    agentMerge: CodeProjectAgentMerge,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-delegated-code"),
    ...ProjectCommandFields,
    /** Absent takes the mark off: the Project takes no delegated Code work. */
    delegatedCode: Schema.optional(CodeProjectDelegatedCode),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-own-toolchain"),
    ...ProjectCommandFields,
    ownToolchain: CodeProjectOwnToolchain,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-agent-pull-request-comments"),
    ...ProjectCommandFields,
    agentPullRequestComments: CodeProjectAgentPullRequestComments,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-agent-default-branch-push"),
    ...ProjectCommandFields,
    agentDefaultBranchPush: CodeProjectAgentDefaultBranchPush,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-issue-updates"),
    ...ProjectCommandFields,
    keepLinkedIssuesCurrent: Schema.optional(Schema.Boolean),
    agentsMayUpdateIssues: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-code-project-actions"),
    ...ProjectCommandFields,
    /** The whole list; an empty list removes every action. */
    actions: ProjectActions,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-provider-policy"),
    ...ProjectCommandFields,
    policy: ProjectProviderPolicy,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-native-providers"),
    ...ProjectCommandFields,
    providers: KeyProviderDriverKinds,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-work-project-status-file"),
    ...ProjectCommandFields,
    statusFile: WorkProjectStatusFile,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-work-project-developer-tools"),
    ...ProjectCommandFields,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-work-project-permission-mode"),
    ...ProjectCommandFields,
    /** Absent returns the Project to Work's default in Settings. */
    permissionMode: Schema.optional(WorkProjectPermissionMode),
    /** The sandbox at Full access for new threads; absent returns it to Settings. */
    fullAccessSandbox: Schema.optional(Schema.Boolean),
    /** Strict for threads here; absent keeps the choice, null returns it to Settings. */
    strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-work-project-actions"),
    ...ProjectCommandFields,
    /** The whole list; an empty list removes every action. */
    actions: ProjectActions,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-agent-memory-writes"),
    ...ProjectCommandFields,
    agentMemoryWrites: ProjectAgentMemoryWrites,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-image-generation-choice"),
    ...ProjectCommandFields,
    /**
     * Which media the choice is for. Absent means image, so commands and
     * events journaled before video decode unchanged.
     */
    media: Schema.optional(Schema.Literals(["image", "video"])),
    /** The choice to keep; absent drops it, so the next call asks again. */
    imageGenerationChoice: Schema.optional(ProjectImageGenerationChoice),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-brand-kit"),
    ...ProjectCommandFields,
    /** An empty kit clears it. */
    brandKit: CanvasDesignBrand,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-design-system"),
    ...ProjectCommandFields,
    /** `null` returns the Project to the automatic rule. */
    designSystem: Schema.NullOr(DesignSystemChoice),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-linear-target"),
    ...ProjectCommandFields,
    /** `null` unbinds the Project from Linear. */
    linearTarget: Schema.NullOr(ProjectLinearTarget),
  }),
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
  }),
]);
export type ProjectCommand = typeof ProjectCommand.Type;

export const ProjectCommandResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat-project-created"), project: ChatProject }),
  Schema.Struct({
    kind: Schema.Literal("work-project-created"),
    project: WorkProject,
  }),
  Schema.Struct({ kind: Schema.Literal("code-project-created"), project: CodeProject }),
  Schema.Struct({
    kind: Schema.Literal("default-project-ensured"),
    project: BoundProject,
    created: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("project-renamed"), project: Project }),
  Schema.Struct({ kind: Schema.Literal("project-color-changed"), project: Project }),
  Schema.Struct({ kind: Schema.Literal("project-moved"), project: Project }),
  Schema.Struct({
    kind: Schema.Literal("project-lifecycle-changed"),
    project: Project,
  }),
  Schema.Struct({ kind: Schema.Literal("project-relinked"), project: BoundProject }),
  Schema.Struct({
    kind: Schema.Literal("project-extra-folder-added"),
    project: BoundProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-extra-folder-needs-confirmation"),
    project: BoundProject,
    canonicalRoot: ProjectFolderPath,
    receiptId: BindingReceiptId,
    warning: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    kind: Schema.Literal("project-extra-folder-removed"),
    project: BoundProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-access-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-new-thread-workspace-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-pull-request-background-refresh-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-agent-merge-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-delegated-code-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-own-toolchain-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-agent-pull-request-comments-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-agent-default-branch-push-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-issue-updates-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-actions-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-provider-policy-changed"),
    project: BoundProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-native-providers-changed"),
    project: BoundProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("work-project-status-file-changed"),
    project: WorkProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("work-project-developer-tools-changed"),
    project: WorkProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("work-project-permission-mode-changed"),
    project: WorkProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("work-project-actions-changed"),
    project: WorkProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-agent-memory-writes-changed"),
    project: Project,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-image-generation-choice-changed"),
    project: Project,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-brand-kit-changed"),
    project: Project,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-project-desktop-recipe-changed"),
    project: CodeProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-design-system-changed"),
    project: Project,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-linear-target-changed"),
    project: BoundProject,
  }),
]);
export type ProjectCommandResult = typeof ProjectCommandResult.Type;

export const MemoryCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create-memory-entry"),
    projectId: ProjectId,
    entryId: MemoryEntryId,
    memoryKind: MemoryKind,
    content: NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("supersede-memory-entry"),
    projectId: ProjectId,
    entryId: MemoryEntryId,
    successorEntryId: MemoryEntryId,
    content: NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("retract-memory-entry"),
    projectId: ProjectId,
    entryId: MemoryEntryId,
    reason: NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("transfer-memory-entry"),
    sourceProjectId: ProjectId,
    sourceEntryId: MemoryEntryId,
    destinationProjectId: ProjectId,
    destinationEntryId: MemoryEntryId,
    expectedVersion: AggregateVersion,
  }),
]);
export type MemoryCommand = typeof MemoryCommand.Type;

export const MemoryCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("memory-entry-created"),
    entry: ActiveMemoryEntry,
  }),
  Schema.Struct({
    kind: Schema.Literal("memory-entry-superseded"),
    previousEntry: SupersededMemoryEntry,
    entry: ActiveMemoryEntry,
  }),
  Schema.Struct({
    kind: Schema.Literal("memory-entry-retracted"),
    entry: RetractedMemoryEntry,
  }),
  Schema.Struct({
    kind: Schema.Literal("memory-entry-transferred"),
    entry: TransferredActiveMemoryEntry,
  }),
]);
export type MemoryCommandResult = typeof MemoryCommandResult.Type;

export const ProjectMemoryProposalId = brandedUuid("ProjectMemoryProposalId");
export type ProjectMemoryProposalId = typeof ProjectMemoryProposalId.Type;

/** The longest entry text an agent may propose; the person reads all of it before approving. */
export const MAX_PROPOSED_MEMORY_CONTENT_LENGTH = 2_000;
const ProposedMemoryText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PROPOSED_MEMORY_CONTENT_LENGTH),
);

/** One change an agent asks to make to its Project's memory. */
export const ProjectMemoryChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    memoryKind: MemoryKind,
    content: ProposedMemoryText,
  }),
  Schema.Struct({
    kind: Schema.Literal("supersede"),
    entryId: MemoryEntryId,
    previousContent: NonEmptyTrimmedString,
    content: ProposedMemoryText,
  }),
  Schema.Struct({
    kind: Schema.Literal("retract"),
    entryId: MemoryEntryId,
    content: NonEmptyTrimmedString,
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(500)),
  }),
]);
export type ProjectMemoryChange = typeof ProjectMemoryChange.Type;

/**
 * A change to Project memory a thread's agent asked for, waiting for the
 * person. Nothing is written until the person confirms it; the host fixes the
 * Project, thread, and memory version from the thread when it is asked.
 */
export const ProjectMemoryProposal = Schema.Struct({
  proposalId: ProjectMemoryProposalId,
  projectId: ProjectId,
  mode: OctantMode,
  threadId: GuidString,
  change: ProjectMemoryChange,
  /** The Project memory version the agent's change was made against. */
  expectedVersion: AggregateVersion,
  /** Present when the thread has read outside content, naming what it read. */
  outsideContent: Schema.optional(ApprovalOutsideContent),
  requestedAt: UtcTimestamp,
});
export type ProjectMemoryProposal = typeof ProjectMemoryProposal.Type;

export const ProjectMemoryProposalList = Schema.Struct({
  kind: Schema.Literal("project-memory-proposal-list"),
  proposals: Schema.Array(ProjectMemoryProposal).check(Schema.isMaxLength(32)),
});
export type ProjectMemoryProposalList = typeof ProjectMemoryProposalList.Type;

export const ProjectMemoryProposalDecision = Schema.Struct({
  proposalId: ProjectMemoryProposalId,
  decision: Schema.Literals(["confirm", "decline"]),
});
export type ProjectMemoryProposalDecision = typeof ProjectMemoryProposalDecision.Type;

export const ProjectMemoryProposalDecisionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-memory-proposal-confirmed"),
    result: MemoryCommandResult,
  }),
  Schema.Struct({ kind: Schema.Literal("project-memory-proposal-declined") }),
  Schema.Struct({ kind: Schema.Literal("project-memory-proposal-gone") }),
  Schema.Struct({
    kind: Schema.Literal("project-memory-proposal-not-applied"),
    message: NonEmptyTrimmedString,
  }),
]);
export type ProjectMemoryProposalDecisionResult = typeof ProjectMemoryProposalDecisionResult.Type;

const FailureMessage = NonEmptyTrimmedString;
export const ProjectFailure = Schema.Union([
  Schema.Struct({ category: Schema.Literal("invalid"), message: FailureMessage }),
  Schema.Struct({ category: Schema.Literal("unauthorized"), message: FailureMessage }),
  Schema.Struct({ category: Schema.Literal("unsupported"), message: FailureMessage }),
  Schema.Struct({ category: Schema.Literal("unavailable"), message: FailureMessage }),
  Schema.Struct({ category: Schema.Literal("not-found"), message: FailureMessage }),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: FailureMessage,
    currentVersion: AggregateVersion,
  }),
]);
export type ProjectFailure = typeof ProjectFailure.Type;

export const ProjectCreated = Schema.Struct({ project: Project });
export type ProjectCreated = typeof ProjectCreated.Type;
export const ProjectRenamed = Schema.Struct({ project: Project });
export type ProjectRenamed = typeof ProjectRenamed.Type;
export const ProjectColorChanged = Schema.Struct({ project: Project });
export type ProjectColorChanged = typeof ProjectColorChanged.Type;
export const ProjectOrderChanged = Schema.Struct({ project: Project });
export type ProjectOrderChanged = typeof ProjectOrderChanged.Type;
export const ProjectLifecycleChanged = Schema.Struct({ project: Project });
export type ProjectLifecycleChanged = typeof ProjectLifecycleChanged.Type;
export const ProjectBindingRelinked = Schema.Struct({ project: BoundProject });
export type ProjectBindingRelinked = typeof ProjectBindingRelinked.Type;
/** The whole Project after the add, and the folder with who added it and when. */
export const ProjectExtraFolderAdded = Schema.Struct({
  project: BoundProject,
  folder: ProjectExtraFolder,
});
export type ProjectExtraFolderAdded = typeof ProjectExtraFolderAdded.Type;
/** The whole Project after the removal, and the folder with who removed it and when. */
export const ProjectExtraFolderRemoved = Schema.Struct({
  project: BoundProject,
  canonicalRoot: ProjectFolderPath,
  removedBy: ProjectActor,
  removedAt: UtcTimestamp,
});
export type ProjectExtraFolderRemoved = typeof ProjectExtraFolderRemoved.Type;
export const CodeProjectAccessChanged = Schema.Struct({ project: CodeProject });
export type CodeProjectAccessChanged = typeof CodeProjectAccessChanged.Type;
/**
 * The Project's default mode changed. The payload is the whole Project, so a
 * replay reads the level the Project's new threads start at without the
 * Settings it overrode.
 */
export const CodeProjectPermissionModeChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectPermissionModeChanged = typeof CodeProjectPermissionModeChanged.Type;
/** The Project's Auto reviewer changed; the payload is the whole Project. */
export const CodeProjectAutoReviewerChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectAutoReviewerChanged = typeof CodeProjectAutoReviewerChanged.Type;
/** Journaled so every window sees the same Project habit after a change. */
export const CodeProjectNewThreadWorkspaceChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectNewThreadWorkspaceChanged = typeof CodeProjectNewThreadWorkspaceChanged.Type;
/**
 * Journaled once per user toggle so the opt-in survives a host restart. The
 * background cadence itself never journals: per-poll observations stay in the
 * in-memory snapshot.
 */
export const CodeProjectPullRequestBackgroundRefreshChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectPullRequestBackgroundRefreshChanged =
  typeof CodeProjectPullRequestBackgroundRefreshChanged.Type;
/** Journaled once per change so the standing permission survives a restart and shows who set it. */
/** Journaled once per change so a Project's mark for delegated Code work survives a restart and shows who set it. */
export const CodeProjectDelegatedCodeChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectDelegatedCodeChanged = typeof CodeProjectDelegatedCodeChanged.Type;
export const CodeProjectAgentMergeChanged = Schema.Struct({ project: CodeProject });
export type CodeProjectAgentMergeChanged = typeof CodeProjectAgentMergeChanged.Type;
/** Journaled once per change so the choice survives a restart and shows who made it. */
export const CodeProjectOwnToolchainChanged = Schema.Struct({ project: CodeProject });
export type CodeProjectOwnToolchainChanged = typeof CodeProjectOwnToolchainChanged.Type;
/** Journaled once per change, as the merge permission is, so it survives a restart and shows who set it. */
export const CodeProjectAgentPullRequestCommentsChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectAgentPullRequestCommentsChanged =
  typeof CodeProjectAgentPullRequestCommentsChanged.Type;
/** Journaled once per change, as the merge permission is, so it survives a restart and shows who set it. */
export const CodeProjectAgentDefaultBranchPushChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectAgentDefaultBranchPushChanged =
  typeof CodeProjectAgentDefaultBranchPushChanged.Type;
/** Journaled once per change of either linked-issue choice. */
export const CodeProjectIssueUpdatesChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectIssueUpdatesChanged = typeof CodeProjectIssueUpdatesChanged.Type;
/** Journaled once per save so every window and a restarted host see the same list. */
export const CodeProjectActionsChanged = Schema.Struct({ project: CodeProject });
export type CodeProjectActionsChanged = typeof CodeProjectActionsChanged.Type;
export const ProjectProviderPolicyChanged = Schema.Struct({
  project: BoundProject,
});
export type ProjectProviderPolicyChanged = typeof ProjectProviderPolicyChanged.Type;
/** A person changed which key providers this Project trusts, from a window on this host. */
export const ProjectNativeProvidersChanged = Schema.Struct({
  project: BoundProject,
});
export type ProjectNativeProvidersChanged = typeof ProjectNativeProvidersChanged.Type;
export const WorkProjectStatusFileChanged = Schema.Struct({
  project: WorkProject,
});
export type WorkProjectStatusFileChanged = typeof WorkProjectStatusFileChanged.Type;
/** Journaled with who turned the switch and when, on the Project's own stream. */
export const WorkProjectDeveloperToolsChanged = Schema.Struct({
  project: WorkProject,
});
export type WorkProjectDeveloperToolsChanged = typeof WorkProjectDeveloperToolsChanged.Type;
/** The Project's own Work mode changed; the payload is the whole Project. */
export const WorkProjectPermissionModeChanged = Schema.Struct({
  project: WorkProject,
});
export type WorkProjectPermissionModeChanged = typeof WorkProjectPermissionModeChanged.Type;
export const WorkProjectActionsChanged = Schema.Struct({ project: WorkProject });
export type WorkProjectActionsChanged = typeof WorkProjectActionsChanged.Type;
export const ProjectAgentMemoryWritesChanged = Schema.Struct({ project: Project });
export type ProjectAgentMemoryWritesChanged = typeof ProjectAgentMemoryWritesChanged.Type;
export const ProjectImageGenerationChoiceChanged = Schema.Struct({ project: Project });
export type ProjectImageGenerationChoiceChanged = typeof ProjectImageGenerationChoiceChanged.Type;
export const ProjectBrandKitChanged = Schema.Struct({ project: Project });
export type ProjectBrandKitChanged = typeof ProjectBrandKitChanged.Type;
export const ProjectDesignSystemChanged = Schema.Struct({ project: Project });
export type ProjectDesignSystemChanged = typeof ProjectDesignSystemChanged.Type;
/** Journaled once per host-owner Linear team/project binding change. */
export const ProjectLinearTargetChanged = Schema.Struct({ project: BoundProject });
export type ProjectLinearTargetChanged = typeof ProjectLinearTargetChanged.Type;
/** Journaled once per person's save or removal; the lease service reads the Project it leaves. */
export const CodeProjectDesktopRecipeChanged = Schema.Struct({
  project: CodeProject,
});
export type CodeProjectDesktopRecipeChanged = typeof CodeProjectDesktopRecipeChanged.Type;

export const MemoryEntryCreated = Schema.Struct({ entry: ActiveMemoryEntry });
export type MemoryEntryCreated = typeof MemoryEntryCreated.Type;
export const MemoryEntrySuperseded = Schema.Struct({
  previousEntry: SupersededMemoryEntry,
  entry: ActiveMemoryEntry,
});
export type MemoryEntrySuperseded = typeof MemoryEntrySuperseded.Type;
export const MemoryEntryRetracted = Schema.Struct({ entry: RetractedMemoryEntry });
export type MemoryEntryRetracted = typeof MemoryEntryRetracted.Type;
export const MemoryEntryTransferred = Schema.Struct({
  entry: TransferredActiveMemoryEntry,
});
export type MemoryEntryTransferred = typeof MemoryEntryTransferred.Type;

export const decodeProjectId = Schema.decodeUnknownSync(ProjectId, STRICT_DECODE_OPTIONS);
export const decodeProjectAction = Schema.decodeUnknownSync(ProjectAction, STRICT_DECODE_OPTIONS);
export const decodeProjectActions = Schema.decodeUnknownSync(ProjectActions, STRICT_DECODE_OPTIONS);
export const decodeProjectActionId = Schema.decodeUnknownSync(
  ProjectActionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryEntryId = Schema.decodeUnknownSync(MemoryEntryId, STRICT_DECODE_OPTIONS);
export const decodeBindingRevisionId = Schema.decodeUnknownSync(
  BindingRevisionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBindingReceiptId = Schema.decodeUnknownSync(
  BindingReceiptId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectRank = Schema.decodeUnknownSync(ProjectRank, STRICT_DECODE_OPTIONS);
export const decodeProject = Schema.decodeUnknownSync(Project, STRICT_DECODE_OPTIONS);
export const decodeProjectSummary = Schema.decodeUnknownSync(ProjectSummary, STRICT_DECODE_OPTIONS);
export const decodeConnectedGitHubRepository = Schema.decodeUnknownSync(
  ConnectedGitHubRepository,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectLinearTarget = Schema.decodeUnknownSync(
  ProjectLinearTarget,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectAvailability = Schema.decodeUnknownSync(
  ProjectAvailability,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectBootstrap = Schema.decodeUnknownSync(
  ProjectBootstrap,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectCommand = Schema.decodeUnknownSync(ProjectCommand, STRICT_DECODE_OPTIONS);
export const decodeProjectCommandResult = Schema.decodeUnknownSync(
  ProjectCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryEntry = Schema.decodeUnknownSync(MemoryEntry, STRICT_DECODE_OPTIONS);
export const decodeProjectMemoryView = Schema.decodeUnknownSync(
  ProjectMemoryView,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryCommand = Schema.decodeUnknownSync(MemoryCommand, STRICT_DECODE_OPTIONS);
export const decodeMemoryCommandResult = Schema.decodeUnknownSync(
  MemoryCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectMemoryProposalId = Schema.decodeUnknownSync(
  ProjectMemoryProposalId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectMemoryChange = Schema.decodeUnknownSync(
  ProjectMemoryChange,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectMemoryProposal = Schema.decodeUnknownSync(
  ProjectMemoryProposal,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectMemoryProposalList = Schema.decodeUnknownSync(
  ProjectMemoryProposalList,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectMemoryProposalDecision = Schema.decodeUnknownSync(
  ProjectMemoryProposalDecision,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectMemoryProposalDecisionResult = Schema.decodeUnknownSync(
  ProjectMemoryProposalDecisionResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectFailure = Schema.decodeUnknownSync(ProjectFailure, STRICT_DECODE_OPTIONS);
export const decodeProjectCreated = Schema.decodeUnknownSync(ProjectCreated, STRICT_DECODE_OPTIONS);
export const decodeProjectRenamed = Schema.decodeUnknownSync(ProjectRenamed, STRICT_DECODE_OPTIONS);
export const decodeProjectColorChanged = Schema.decodeUnknownSync(
  ProjectColorChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectOrderChanged = Schema.decodeUnknownSync(
  ProjectOrderChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectLifecycleChanged = Schema.decodeUnknownSync(
  ProjectLifecycleChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectBindingRelinked = Schema.decodeUnknownSync(
  ProjectBindingRelinked,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectFolderPath = Schema.decodeUnknownSync(
  ProjectFolderPath,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectExtraFolder = Schema.decodeUnknownSync(
  ProjectExtraFolder,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectExtraFolderAdded = Schema.decodeUnknownSync(
  ProjectExtraFolderAdded,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectExtraFolderRemoved = Schema.decodeUnknownSync(
  ProjectExtraFolderRemoved,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectAccessChanged = Schema.decodeUnknownSync(
  CodeProjectAccessChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPermissionModeChanged = Schema.decodeUnknownSync(
  CodeProjectPermissionModeChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectAutoReviewerChanged = Schema.decodeUnknownSync(
  CodeProjectAutoReviewerChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectNewThreadWorkspaceChanged = Schema.decodeUnknownSync(
  CodeProjectNewThreadWorkspaceChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectPullRequestBackgroundRefreshChanged = Schema.decodeUnknownSync(
  CodeProjectPullRequestBackgroundRefreshChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectAgentMergeChanged = Schema.decodeUnknownSync(
  CodeProjectAgentMergeChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectDelegatedCodeChanged = Schema.decodeUnknownSync(
  CodeProjectDelegatedCodeChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectOwnToolchainChanged = Schema.decodeUnknownSync(
  CodeProjectOwnToolchainChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectAgentPullRequestCommentsChanged = Schema.decodeUnknownSync(
  CodeProjectAgentPullRequestCommentsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectAgentDefaultBranchPushChanged = Schema.decodeUnknownSync(
  CodeProjectAgentDefaultBranchPushChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectIssueUpdatesChanged = Schema.decodeUnknownSync(
  CodeProjectIssueUpdatesChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectActionsChanged = Schema.decodeUnknownSync(
  CodeProjectActionsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectProviderPolicyChanged = Schema.decodeUnknownSync(
  ProjectProviderPolicyChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectNativeProvidersChanged = Schema.decodeUnknownSync(
  ProjectNativeProvidersChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkProjectStatusFileChanged = Schema.decodeUnknownSync(
  WorkProjectStatusFileChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkProjectDeveloperToolsChanged = Schema.decodeUnknownSync(
  WorkProjectDeveloperToolsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkProjectPermissionModeChanged = Schema.decodeUnknownSync(
  WorkProjectPermissionModeChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkProjectActionsChanged = Schema.decodeUnknownSync(
  WorkProjectActionsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectAgentMemoryWritesChanged = Schema.decodeUnknownSync(
  ProjectAgentMemoryWritesChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectImageGenerationChoiceChanged = Schema.decodeUnknownSync(
  ProjectImageGenerationChoiceChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectBrandKitChanged = Schema.decodeUnknownSync(
  ProjectBrandKitChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectDesignSystemChanged = Schema.decodeUnknownSync(
  ProjectDesignSystemChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectLinearTargetChanged = Schema.decodeUnknownSync(
  ProjectLinearTargetChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeProjectDesktopRecipeChanged = Schema.decodeUnknownSync(
  CodeProjectDesktopRecipeChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryEntryCreated = Schema.decodeUnknownSync(
  MemoryEntryCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryEntrySuperseded = Schema.decodeUnknownSync(
  MemoryEntrySuperseded,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryEntryRetracted = Schema.decodeUnknownSync(
  MemoryEntryRetracted,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemoryEntryTransferred = Schema.decodeUnknownSync(
  MemoryEntryTransferred,
  STRICT_DECODE_OPTIONS,
);
