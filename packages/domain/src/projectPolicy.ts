import type { CanvasDesignBrand } from "@octant/contracts/canvas";
import type { DesktopRecipe, LeasableDesktopProvider } from "@octant/contracts/desktop-lease";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import type { KeyProviderDriverKinds, PermissionMode } from "@octant/contracts/providers";
import type { AutoReviewer } from "@octant/contracts/shield";
import { designBrandTokenRefusal } from "./canvasDesignFrameKit";
import { desktopNetworkAllowed } from "./desktopLeasePolicy";
import {
  MAX_PROJECT_EXTRA_FOLDERS,
  decodeProjectRank,
  type BindingRevisionId,
  type BoundProject,
  type CanonicalProjectBinding,
  type ChatProject,
  type CodeProject,
  type CodeProjectPullRequestBackgroundRefresh,
  type CodeAccessPersistence,
  type WorkProject,
  type WorkProjectStatusFile,
  type Project,
  type ProjectAction,
  type ProjectActor,
  type ProjectExtraFolder,
  type ProjectColor,
  type ProjectId,
  type ProjectLifecycle,
  type ProjectOrigin,
  type ProjectProviderPolicy,
  type ProjectRank,
} from "@octant/contracts/projects";

export type ProjectPolicyRejectionCode =
  | "extra-folder-refused"
  | "binding-not-allowed"
  | "binding-revision-conflict"
  | "binding-unchanged"
  | "invalid-brand-kit"
  | "invalid-desktop-recipe"
  | "invalid-lifecycle"
  | "invalid-name"
  | "invalid-neighbor"
  | "invalid-rank"
  | "relink-not-allowed";

export class ProjectPolicyRejected extends Error {
  override readonly name = "ProjectPolicyRejected";

  constructor(
    readonly code: ProjectPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function reject(code: ProjectPolicyRejectionCode, message: string): never {
  throw new ProjectPolicyRejected(code, message);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function normalizeRank(numerator: bigint, denominator: bigint): ProjectRank {
  if (denominator === 0n) reject("invalid-rank", "Project rank denominator cannot be zero");
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  const token = `${normalizedNumerator / divisor}/${normalizedDenominator / divisor}`;
  try {
    return decodeProjectRank(token);
  } catch {
    return reject("invalid-rank", "Project rank is not canonical");
  }
}

function parseRank(rank: ProjectRank): Rational {
  if (!/^-?(?:0|[1-9]\d*)\/[1-9]\d*$/.test(rank)) {
    return reject("invalid-rank", "Project rank is malformed");
  }
  const [numeratorText, denominatorText] = rank.split("/") as [string, string];
  const numerator = BigInt(numeratorText);
  const denominator = BigInt(denominatorText);
  if (numeratorText === "-0" || gcd(numerator, denominator) !== 1n) {
    return reject("invalid-rank", "Project rank is not canonical");
  }
  return { numerator, denominator };
}

function compareRank(left: ProjectRank, right: ProjectRank): number {
  const leftValue = parseRank(left);
  const rightValue = parseRank(right);
  const comparison =
    leftValue.numerator * rightValue.denominator - rightValue.numerator * leftValue.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function nextVersion(project: Project): AggregateVersion {
  return (project.version + 1) as AggregateVersion;
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) reject("invalid-name", "Project name cannot be empty");
  return normalized;
}

interface CreateProjectFields {
  readonly id: ProjectId;
  readonly name: string;
  readonly rank: ProjectRank;
  readonly createdAt: UtcTimestamp;
}

type CreateChatProjectInput = CreateProjectFields & { readonly type: "chat" };
type CreateBoundProjectFields = CreateProjectFields & {
  readonly binding: CanonicalProjectBinding;
  readonly revisionId: BindingRevisionId;
  readonly actor: ProjectActor;
  readonly origin?: ProjectOrigin;
};
type CreateWorkProjectInput = CreateBoundProjectFields & { readonly type: "work" };
type CreateCodeProjectInput = CreateBoundProjectFields & { readonly type: "code" };
export type CreateProjectInput =
  | CreateChatProjectInput
  | CreateWorkProjectInput
  | CreateCodeProjectInput;

export function createProject(input: CreateChatProjectInput): ChatProject;
export function createProject(input: CreateWorkProjectInput): WorkProject;
export function createProject(input: CreateCodeProjectInput): CodeProject;
export function createProject(input: CreateProjectInput): Project;
export function createProject(input: CreateProjectInput): Project {
  const name = normalizeName(input.name);
  parseRank(input.rank);
  const common = {
    id: input.id,
    name,
    lifecycle: "active" as const,
    pinned: false,
    rank: input.rank,
    version: 1 as AggregateVersion,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  if (input.type === "chat") {
    if ("binding" in input || "revisionId" in input || "actor" in input) {
      reject("binding-not-allowed", "Chat Projects cannot have a root binding");
    }
    return { ...common, type: "chat" };
  }
  const bindingHistory = [
    {
      revisionId: input.revisionId,
      revision: 1,
      currentBinding: input.binding,
      actor: input.actor,
      changedAt: input.createdAt,
    },
  ] as const;
  const origin = input.origin === undefined ? {} : { origin: input.origin };
  if (input.type === "work") {
    return { ...common, type: "work", binding: input.binding, bindingHistory, ...origin };
  }
  return {
    ...common,
    type: "code",
    binding: input.binding,
    bindingHistory,
    ...origin,
    codeAccessPersistence: "current-session",
  };
}

export function renameProject(project: Project, name: string, updatedAt: UtcTimestamp): Project {
  return {
    ...project,
    name: normalizeName(name),
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Set or clear (`null`) the Project's identity colour. Rejects an archived
 * Project and a no-op change so the journal never carries an event that
 * changed nothing.
 */
export function changeProjectColor(
  project: Project,
  color: ProjectColor | null,
  updatedAt: UtcTimestamp,
): Project {
  if (project.lifecycle === "archived") {
    reject("invalid-lifecycle", "Archived Projects are read-only");
  }
  if ((project.color ?? null) === color) {
    reject("invalid-lifecycle", "Project colour is already selected");
  }
  // Cleared means absent, not null, so the stored record matches one that never
  // had a colour.
  const { color: _previous, ...uncoloured } = project;
  return {
    ...uncoloured,
    ...(color === null ? {} : { color }),
    version: nextVersion(project),
    updatedAt,
  };
}

export function changeCodeProjectAccess(
  project: Project,
  codeAccessPersistence: CodeAccessPersistence,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject("binding-not-allowed", "Only Code Projects have an access persistence policy");
  }
  if (project.codeAccessPersistence === codeAccessPersistence) {
    reject("invalid-lifecycle", "Code Project access persistence is already selected");
  }
  // The older remembered-access switch speaks for the Project's whole mode
  // when it is used, so a Project mode set earlier does not outrank it.
  const { defaultPermissionMode: _previousMode, ...rest } = project;
  return {
    ...rest,
    codeAccessPersistence,
    version: nextVersion(project),
    updatedAt,
  };
}

/** Set who answers a Code Project's prompts at Auto, or return it to Settings. */
export function changeCodeProjectAutoReviewer(
  project: Project,
  autoReviewer: AutoReviewer | undefined,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject("binding-not-allowed", "Only Code Projects have an Auto reviewer");
  }
  if (project.autoReviewer === autoReviewer) {
    reject("invalid-lifecycle", "This Project already uses that Auto reviewer");
  }
  const { autoReviewer: _previous, ...rest } = project;
  return {
    ...rest,
    ...(autoReviewer === undefined ? {} : { autoReviewer }),
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Set the mode a Code Project's new threads start in, or return it to the
 * Settings default. Remembered Full access follows the mode, so every reader
 * of the older switch (the Project terminal, the CLI) agrees with it.
 */
export function changeCodeProjectPermissionMode(
  project: Project,
  permissionMode: PermissionMode | undefined,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject("binding-not-allowed", "Only Code Projects have a default mode");
  }
  const codeAccessPersistence: CodeAccessPersistence =
    permissionMode === "full-access" ? "project-default" : "current-session";
  // A Project that remembered Full access before Project modes existed has no
  // mode of its own but still starts threads in Full access, so returning it to
  // the Settings default is a change even though both modes are unset.
  if (
    project.defaultPermissionMode === permissionMode &&
    project.codeAccessPersistence === codeAccessPersistence
  ) {
    reject("invalid-lifecycle", "This Project already starts threads in that mode");
  }
  const { defaultPermissionMode: _previousMode, ...rest } = project;
  return {
    ...rest,
    ...(permissionMode === undefined ? {} : { defaultPermissionMode: permissionMode }),
    codeAccessPersistence,
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Replace a Code Project's named terminal actions with the list the person
 * saved. Only a Code Project has a terminal to run them in, and an archived
 * Project is read-only. A list equal to the saved one is refused so the journal
 * never carries an event that changed nothing; an absent list reads as empty.
 */
export function changeCodeProjectActions(
  project: Project,
  actions: ReadonlyArray<ProjectAction>,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject("binding-not-allowed", "Only Code Projects have terminal actions");
  }
  if (project.lifecycle === "archived") {
    reject("invalid-lifecycle", "Archived Projects are read-only");
  }
  if (JSON.stringify(project.actions ?? []) === JSON.stringify(actions)) {
    reject("invalid-lifecycle", "Code Project actions are already saved");
  }
  const { actions: _replaced, ...rest } = project;
  return {
    ...rest,
    ...(actions.length === 0 ? {} : { actions }),
    version: nextVersion(project),
    updatedAt,
  };
}

export function changeProjectProviderPolicy(
  project: Project,
  providerPolicy: ProjectProviderPolicy,
  updatedAt: UtcTimestamp,
): BoundProject {
  if (project.type === "chat") {
    reject("binding-not-allowed", "Only Work and Code Projects have a provider policy");
  }
  const current = project.providerPolicy ?? { mode: "all" as const, providerInstanceIds: [] };
  if (
    current.mode === providerPolicy.mode &&
    current.providerInstanceIds.length === providerPolicy.providerInstanceIds.length &&
    current.providerInstanceIds.every(
      (id, index) => String(id) === String(providerPolicy.providerInstanceIds[index]),
    )
  ) {
    reject("invalid-lifecycle", "Project provider policy is already selected");
  }
  return {
    ...project,
    providerPolicy,
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Sets which key providers a Work or Code Project trusts to run as
 * themselves there, with the Project's own settings, hooks, MCP servers, and
 * plugins. A Chat Project has no folder, so it holds no such trust. The list
 * is kept in the order the person gave it; an empty list removes the field.
 */
export function changeProjectNativeProviders(
  project: Project,
  providers: KeyProviderDriverKinds,
  updatedAt: UtcTimestamp,
): BoundProject {
  if (project.type === "chat") {
    reject("binding-not-allowed", "Only Work and Code Projects trust a provider's own setup");
  }
  const current = project.nativeProviders ?? [];
  if (current.length === providers.length && current.every((kind) => providers.includes(kind))) {
    reject("invalid-lifecycle", "Project already trusts exactly these providers");
  }
  const { nativeProviders: _previous, ...rest } = project;
  return {
    ...rest,
    ...(providers.length === 0 ? {} : { nativeProviders: providers }),
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Toggle the opt-in background refresh of the Project's pull-request snapshot.
 * Rejects a non-Code Project and a no-op change so the journal never carries
 * an event that changed nothing. Absence of the field reads as disabled — the
 * default every Project had before the setting existed.
 */
export function changeCodeProjectPullRequestBackgroundRefresh(
  project: Project,
  pullRequestBackgroundRefresh: CodeProjectPullRequestBackgroundRefresh,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject(
      "binding-not-allowed",
      "Only Code Projects have a pull-request background refresh setting",
    );
  }
  if ((project.pullRequestBackgroundRefresh ?? "disabled") === pullRequestBackgroundRefresh) {
    reject("invalid-lifecycle", "Code Project pull-request background refresh is already selected");
  }
  return {
    ...project,
    pullRequestBackgroundRefresh,
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Opt a Work Project into, or out of, the `STATUS.md` Octant keeps in its
 * folder. Absence reads as disabled, so every Project starts with Octant
 * writing nothing there. The default-folder Project collects what nobody gave
 * a home; a status for "everything else" means nothing, so it refuses.
 */
export function changeWorkProjectStatusFile(
  project: Project,
  statusFile: WorkProjectStatusFile,
  updatedAt: UtcTimestamp,
): WorkProject {
  if (project.type !== "work") {
    reject("binding-not-allowed", "Only Work Projects have a status file setting");
  }
  if (statusFile === "enabled" && project.origin === "default-folder") {
    reject("binding-not-allowed", "The default folder cannot keep a status file");
  }
  if ((project.statusFile ?? "disabled") === statusFile) {
    reject("invalid-lifecycle", "Work Project status file setting is already selected");
  }
  return { ...project, statusFile, version: nextVersion(project), updatedAt };
}

/**
 * Set, replace, or (with an empty kit) clear the Project's brand kit. Every
 * value must pass the rule a design's own brand passes, so nothing a kit holds
 * can end a stylesheet declaration or name something to load. Chat Projects
 * hold a kit too; it grants no folder or shell authority.
 */
export function changeProjectBrandKit(
  project: Project,
  brandKit: CanvasDesignBrand,
  updatedAt: UtcTimestamp,
): Project {
  const entries = Object.entries(brandKit);
  for (const [name, value] of entries) {
    const refusal = designBrandTokenRefusal(name, value);
    if (refusal !== undefined) reject("invalid-brand-kit", `Brand kit ${refusal}`);
  }
  const current = JSON.stringify(Object.entries(project.brandKit ?? {}).sort());
  if (current === JSON.stringify(entries.sort())) {
    reject("invalid-lifecycle", "Project brand kit is already selected");
  }
  const { brandKit: _previous, ...rest } = project;
  return {
    ...rest,
    ...(entries.length === 0 ? {} : { brandKit }),
    version: nextVersion(project),
    updatedAt,
  };
}

/**
 * Set, replace, or (with `null`) remove a Code Project's disposable desktop
 * recipe. A recipe names a provider this host offers for leasing now, so the
 * Project never stores a provider nothing could lease from; removing one is
 * always allowed. Network follows {@link desktopNetworkAllowed}. A placement
 * that runs on one of the person's machines names the machine, so the person
 * sees which computer a desktop uses. A no-op is refused so the journal never
 * carries an event that changed nothing.
 */
export function changeCodeProjectDesktopRecipe(
  project: Project,
  recipe: DesktopRecipe | null,
  offered: ReadonlyArray<LeasableDesktopProvider>,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject("binding-not-allowed", "Only Code Projects have a desktop recipe");
  }
  if (recipe !== null) {
    const provider = offered.find(
      (candidate) => String(candidate.providerId) === String(recipe.providerId),
    );
    if (provider === undefined) {
      reject("invalid-desktop-recipe", "That desktop provider isn't available on this host");
    }
    // A provider the host lists but the person has not set up starts nothing,
    // so a recipe may not move to it. One already on it may still be edited
    // or removed.
    if (
      provider.needsSetup !== undefined &&
      String(project.desktopRecipe?.providerId ?? "") !== String(recipe.providerId)
    ) {
      reject("invalid-desktop-recipe", "That desktop provider needs setup on this host first");
    }
    // A placement decides locality and billing, and so the network and key
    // rules below. A provider that offers placements is leased only on one of
    // them; one that offers none is leased on its own terms.
    const placements = provider.placements ?? [];
    const placement = placements.find(
      (candidate) => String(candidate.placementId) === String(recipe.placementId ?? ""),
    );
    if (placements.length === 0 ? recipe.placementId !== undefined : placement === undefined) {
      reject("invalid-desktop-recipe", "That desktop placement isn't available on this host");
    }
    const locality = placement?.locality ?? provider.locality;
    if (
      recipe.network === "allow" &&
      !desktopNetworkAllowed({ locality, placed: placement !== undefined })
    ) {
      reject("invalid-desktop-recipe", "A desktop there cannot have network access yet");
    }
    if (
      placement?.choosesMachine === true
        ? recipe.machine === undefined
        : recipe.machine !== undefined
    ) {
      reject(
        "invalid-desktop-recipe",
        placement?.choosesMachine === true
          ? "Choose which of your computers the desktop runs on"
          : "That desktop placement doesn't run on a computer you choose",
      );
    }
    // A daemon-run provider holds the person's own sign-in. Octant stores no
    // key for it, so a recipe that names one is refused rather than kept.
    if (provider.daemon === true && recipe.credentialRef !== undefined) {
      reject("invalid-desktop-recipe", "This desktop provider signs in through its own app");
    }
    // A cloud desktop runs on the person's own account: through a key Octant
    // holds, or through the placement a provider's daemon is signed in to.
    // With neither the lease service refuses every acquire, so a new recipe,
    // or one moving to this provider or placement, is refused here. A recipe
    // already on it may go without one: that is a person removing its key,
    // and it starts nothing until they enter another.
    const daemonPlacement = provider.daemon === true && placement !== undefined;
    const saved = project.desktopRecipe;
    const keyRemovedInPlace =
      saved !== undefined &&
      String(saved.providerId) === String(recipe.providerId) &&
      String(saved.placementId ?? "") === String(recipe.placementId ?? "");
    if (
      locality === "cloud" &&
      recipe.credentialRef === undefined &&
      !daemonPlacement &&
      !keyRemovedInPlace
    ) {
      reject("invalid-desktop-recipe", "A cloud desktop needs a saved key for its account");
    }
    // The host estimates every billed lease from the person's own hourly
    // figure before it starts; Octant knows no provider's price. A desktop
    // that does not bill has nothing to estimate, so it keeps no figure. A
    // recipe saved on the same provider and placement before the figure
    // existed may still be edited without one; it starts nothing until the
    // person enters it.
    const billed = placement?.billed ?? provider.billed;
    if (billed && recipe.hourlyCostUsdCents === undefined && !keyRemovedInPlace) {
      reject("invalid-desktop-recipe", "Enter what an hour of this desktop costs you");
    }
    if (!billed && recipe.hourlyCostUsdCents !== undefined) {
      reject("invalid-desktop-recipe", "Only a desktop that bills you takes a cost per hour");
    }
  }
  if (sameDesktopRecipe(project.desktopRecipe, recipe ?? undefined)) {
    reject("invalid-lifecycle", "Project desktop recipe is already selected");
  }
  const { desktopRecipe: _previous, ...rest } = project;
  return {
    ...rest,
    ...(recipe === null ? {} : { desktopRecipe: recipe }),
    version: nextVersion(project),
    updatedAt,
  };
}

function sameDesktopRecipe(
  left: DesktopRecipe | undefined,
  right: DesktopRecipe | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    String(left.providerId) === String(right.providerId) &&
    left.image === right.image &&
    left.screen.width === right.screen.width &&
    left.screen.height === right.screen.height &&
    String(left.credentialRef ?? "") === String(right.credentialRef ?? "") &&
    String(left.placementId ?? "") === String(right.placementId ?? "") &&
    String(left.machine?.machineId ?? "") === String(right.machine?.machineId ?? "") &&
    left.machine?.displayName === right.machine?.displayName &&
    left.network === right.network &&
    left.leaseMinutes === right.leaseMinutes &&
    left.maximumLeaseMinutes === right.maximumLeaseMinutes &&
    left.idleMinutes === right.idleMinutes &&
    left.hourlyCostUsdCents === right.hourlyCostUsdCents
  );
}

/** Whether Octant reads, seeds, and asks tasks to keep this Project's `STATUS.md`. */
export function workProjectKeepsStatusFile(
  project: Pick<Project, "type"> & {
    readonly origin?: ProjectOrigin | undefined;
    readonly statusFile?: WorkProjectStatusFile | undefined;
  },
): boolean {
  return (
    project.type === "work" &&
    project.origin !== "default-folder" &&
    project.statusFile === "enabled"
  );
}

/** Whether `inner` is `outer` or lies beneath it, both canonical absolute paths. */
export function folderContainsPath(outer: string, inner: string): boolean {
  if (outer === "/") return inner.startsWith("/");
  return inner === outer || inner.startsWith(`${outer}/`);
}

function foldersOverlap(left: string, right: string): boolean {
  return folderContainsPath(left, right) || folderContainsPath(right, left);
}

/**
 * The folders a bound Project grants, main folder first. Every question of
 * the form "is this path inside the Project?" asks it of this list: an extra
 * folder gets exactly the access the main folder gets at a thread's level.
 */
export function projectFolderRoots(project: {
  readonly binding: CanonicalProjectBinding;
  readonly extraFolders?: ReadonlyArray<Pick<ProjectExtraFolder, "canonicalRoot">> | undefined;
}): ReadonlyArray<string> {
  return [
    project.binding.canonicalRoot,
    ...(project.extraFolders ?? []).map((folder) => folder.canonicalRoot),
  ];
}

/** The extra folders alone, as the paths a launch or a driver is handed. */
export function projectExtraFolderRoots(project: {
  readonly extraFolders?: ReadonlyArray<Pick<ProjectExtraFolder, "canonicalRoot">> | undefined;
}): ReadonlyArray<string> {
  return (project.extraFolders ?? []).map((folder) => folder.canonicalRoot);
}

/**
 * What an agent is told about a Project's extra folders, or undefined when it
 * has none. The runtime only ever hears of its working directory, so without
 * this it would not know the folders it was granted exist.
 */
export function projectExtraFoldersInstructions(
  extraFolders: ReadonlyArray<string>,
): string | undefined {
  if (extraFolders.length === 0) return undefined;
  return [
    "This Project has extra folders beside its main folder (your working directory):",
    ...extraFolders.map((folder) => `- ${folder}`),
    "You may read and change files in them exactly as in the main folder, naming them by absolute path. Commands, Git and checkouts start in the main folder; the extra folders are plain folders.",
  ].join("\n");
}

/** Whether a canonical absolute path lies in one of a Project's folders. */
export function isPathInProjectFolders(
  folders: ReadonlyArray<string>,
  canonicalPath: string,
): boolean {
  return folders.some((folder) => folderContainsPath(folder, canonicalPath));
}

/**
 * Folders the operating system or the host owns. An extra folder may not be
 * one of these, contain one, or (for the system-owned trees) sit inside one.
 */
const SYSTEM_FOLDERS = [
  "/Applications",
  "/Library",
  "/Network",
  "/System",
  "/Users",
  "/Volumes",
  "/bin",
  "/boot",
  "/cores",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/private",
  "/private/etc",
  "/private/tmp",
  "/private/var",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
] as const;

/** System trees whose subfolders are never a person's working files. */
const SYSTEM_OWNED_TREES = [
  "/System",
  "/Library",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/private/etc",
  "/private/var/db",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
] as const;

/**
 * Folders under home that hold credentials. Granting one, a folder inside one,
 * or a folder that contains one would hand a runtime the keys the OS profiles
 * otherwise keep out of reach, so none of them can be an extra folder.
 */
const HOME_SECRET_FOLDERS = [
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".docker",
  ".gnupg",
  ".kube",
  ".password-store",
  ".ssh",
  "Library/Keychains",
] as const;

export interface ExtraFolderJudgement {
  readonly mainRoot: string;
  readonly extraFolders: ReadonlyArray<string>;
  readonly candidate: string;
  /** The host user's home folder, canonical. */
  readonly homeDirectory: string;
}

/**
 * Why a folder cannot be added to a Project beside its main folder, or
 * undefined when it can. The candidate is the canonical path the folder picker
 * resolved, so the comparisons here are exact.
 */
export function extraFolderRefusal(input: ExtraFolderJudgement): string | undefined {
  const { candidate, homeDirectory } = input;
  if (!candidate.startsWith("/") || candidate === "/") {
    return "Choose a folder, not the whole disk.";
  }
  if (candidate === homeDirectory || folderContainsPath(candidate, homeDirectory)) {
    return "Choose a folder inside your home folder, not the home folder itself.";
  }
  if (SYSTEM_FOLDERS.some((folder) => folder === candidate)) {
    return "A system folder cannot be added to a Project.";
  }
  if (SYSTEM_OWNED_TREES.some((tree) => folderContainsPath(tree, candidate))) {
    return "A folder the system owns cannot be added to a Project.";
  }
  if (
    HOME_SECRET_FOLDERS.some((secret) => foldersOverlap(`${homeDirectory}/${secret}`, candidate))
  ) {
    return "A folder that holds keys or credentials cannot be added to a Project.";
  }
  if (foldersOverlap(input.mainRoot, candidate)) {
    return candidate === input.mainRoot
      ? "That folder is already the Project's main folder."
      : "That folder overlaps the Project's main folder.";
  }
  const existing = input.extraFolders.find((folder) => foldersOverlap(folder, candidate));
  if (existing !== undefined) {
    return existing === candidate
      ? "That folder is already in the Project."
      : "That folder overlaps another folder in the Project.";
  }
  if (input.extraFolders.length >= MAX_PROJECT_EXTRA_FOLDERS) {
    return `A Project can have at most ${MAX_PROJECT_EXTRA_FOLDERS} extra folders.`;
  }
  return undefined;
}

export interface AddProjectExtraFolderInput {
  readonly canonicalRoot: string;
  readonly actor: ProjectActor;
  readonly addedAt: UtcTimestamp;
  readonly homeDirectory: string;
}

/** Adds a folder a person picked to a bound Project beside its main folder. */
export function addProjectExtraFolder(
  project: Project,
  input: AddProjectExtraFolderInput,
): { readonly project: BoundProject; readonly folder: ProjectExtraFolder } {
  if (project.type === "chat") {
    reject("binding-not-allowed", "Chat Projects have no folders");
  }
  if (project.lifecycle === "archived") {
    reject("invalid-lifecycle", "Archived Projects are read-only");
  }
  const existing = project.extraFolders ?? [];
  const refusal = extraFolderRefusal({
    mainRoot: project.binding.canonicalRoot,
    extraFolders: existing.map((folder) => folder.canonicalRoot),
    candidate: input.canonicalRoot,
    homeDirectory: input.homeDirectory,
  });
  if (refusal !== undefined) reject("extra-folder-refused", refusal);
  const folder: ProjectExtraFolder = {
    canonicalRoot: input.canonicalRoot,
    addedBy: input.actor,
    addedAt: input.addedAt,
  };
  return {
    project: {
      ...project,
      extraFolders: [...existing, folder],
      version: nextVersion(project),
      updatedAt: input.addedAt,
    },
    folder,
  };
}

/** Removes one extra folder; the main folder is changed only by relinking. */
export function removeProjectExtraFolder(
  project: Project,
  canonicalRoot: string,
  updatedAt: UtcTimestamp,
): BoundProject {
  if (project.type === "chat") {
    reject("binding-not-allowed", "Chat Projects have no folders");
  }
  if (project.lifecycle === "archived") {
    reject("invalid-lifecycle", "Archived Projects are read-only");
  }
  const existing = project.extraFolders ?? [];
  if (!existing.some((folder) => folder.canonicalRoot === canonicalRoot)) {
    reject(
      "extra-folder-refused",
      canonicalRoot === project.binding.canonicalRoot
        ? "The main folder cannot be removed; relink the Project to change it"
        : "That folder is not one of the Project's extra folders",
    );
  }
  const remaining = existing.filter((folder) => folder.canonicalRoot !== canonicalRoot);
  const { extraFolders: _replaced, ...rest } = project;
  return {
    ...rest,
    ...(remaining.length === 0 ? {} : { extraFolders: remaining }),
    version: nextVersion(project),
    updatedAt,
  };
}

export function changeProjectLifecycle(
  project: Project,
  lifecycle: ProjectLifecycle,
  updatedAt: UtcTimestamp,
): Project {
  if (project.lifecycle === lifecycle) {
    reject("invalid-lifecycle", `Project is already ${lifecycle}`);
  }
  return { ...project, lifecycle, version: nextVersion(project), updatedAt };
}

export interface RelinkProjectInput {
  readonly previousBindingRevision: number;
  readonly binding: CanonicalProjectBinding;
  readonly revisionId: BindingRevisionId;
  readonly actor: ProjectActor;
  readonly changedAt: UtcTimestamp;
}

export function relinkProject(project: Project, input: RelinkProjectInput): BoundProject {
  if (project.type === "chat") {
    reject("relink-not-allowed", "Chat Projects cannot be relinked");
  }
  const currentRevision = project.bindingHistory.at(-1);
  if (
    currentRevision === undefined ||
    currentRevision.currentBinding.canonicalRoot !== project.binding.canonicalRoot
  ) {
    reject("binding-revision-conflict", "Project binding history does not match its binding");
  }
  if (currentRevision.revision !== input.previousBindingRevision) {
    reject("binding-revision-conflict", "Project binding revision has changed");
  }
  if (input.binding.canonicalRoot === project.binding.canonicalRoot) {
    reject("binding-unchanged", "Replacement root must differ from the current root");
  }
  // The extra folders were judged against the old main folder; a new one that
  // overlaps any of them would grant the same files twice under two roles.
  const overlapping = (project.extraFolders ?? []).find((folder) =>
    foldersOverlap(folder.canonicalRoot, input.binding.canonicalRoot),
  );
  if (overlapping !== undefined) {
    reject(
      "extra-folder-refused",
      "The new main folder overlaps one of the Project's extra folders; remove that folder first",
    );
  }
  const revision = {
    revisionId: input.revisionId,
    revision: currentRevision.revision + 1,
    previousBinding: project.binding,
    currentBinding: input.binding,
    actor: input.actor,
    changedAt: input.changedAt,
  };
  return {
    ...project,
    binding: input.binding,
    bindingHistory: [...project.bindingHistory, revision],
    version: nextVersion(project),
    updatedAt: input.changedAt,
  };
}

export function rankBetween(left?: ProjectRank, right?: ProjectRank): ProjectRank {
  if (right === undefined) {
    if (left === undefined) return decodeProjectRank("0/1");
    const leftValue = parseRank(left);
    return normalizeRank(leftValue.numerator + leftValue.denominator, leftValue.denominator);
  }
  if (left === undefined) {
    const rightValue = parseRank(right);
    return normalizeRank(rightValue.numerator - rightValue.denominator, rightValue.denominator);
  }
  const leftValue = parseRank(left);
  const rightValue = parseRank(right);
  if (compareRank(left, right) >= 0) {
    reject("invalid-rank", "Project rank neighbors must be strictly ascending");
  }
  return normalizeRank(
    leftValue.numerator + rightValue.numerator,
    leftValue.denominator + rightValue.denominator,
  );
}

export function compareProjectOrder(left: Project, right: Project): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const rankComparison = compareRank(left.rank, right.rank);
  if (rankComparison !== 0) return rankComparison;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface MoveProjectInput {
  readonly pinned: boolean;
  readonly beforeProject?: Project;
  readonly afterProject?: Project;
  readonly updatedAt: UtcTimestamp;
}

function validateMoveNeighbor(
  current: Project,
  neighbor: Project | undefined,
  pinned: boolean,
): void {
  if (neighbor === undefined) return;
  if (neighbor.id === current.id) reject("invalid-neighbor", "A Project cannot neighbor itself");
  if (neighbor.type !== current.type) {
    reject("invalid-neighbor", "Move neighbors must belong to the same mode");
  }
  if (neighbor.lifecycle !== current.lifecycle) {
    reject("invalid-neighbor", "Move neighbors must have the same lifecycle");
  }
  if (neighbor.pinned !== pinned) {
    reject("invalid-neighbor", "Move neighbors must belong to the requested pin lane");
  }
}

export function moveProject(project: Project, input: MoveProjectInput): Project {
  validateMoveNeighbor(project, input.beforeProject, input.pinned);
  validateMoveNeighbor(project, input.afterProject, input.pinned);
  if (
    input.beforeProject !== undefined &&
    input.afterProject !== undefined &&
    input.beforeProject.id === input.afterProject.id
  ) {
    reject("invalid-neighbor", "Move neighbors must be distinct");
  }
  const rank = rankBetween(input.beforeProject?.rank, input.afterProject?.rank);
  return {
    ...project,
    pinned: input.pinned,
    rank,
    version: nextVersion(project),
    updatedAt: input.updatedAt,
  };
}
