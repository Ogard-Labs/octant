import {
  MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH,
  type ExtensionCommand,
  type ExtensionCommandResult,
  type ExtensionSnapshot,
  type SkillMarketplaceEntry,
} from "@octant/contracts/extension-rpc";
import type {
  ExtensionEffectiveState,
  ExtensionPackageManifest,
  ExtensionSkillCollision,
  StandaloneSkillRecord,
} from "@octant/contracts/extensions";
import type { StandaloneSkillActivationState } from "@octant/contracts/shell";
import { sourceQualifiedSkillId, bundledSkillRecords } from "@octant/plugin-host";
import { skillReachesAudience, type SkillAudience } from "@octant/plugin-host/skills";
import type { ExtensionLifecycleService } from "./extensionLifecycleService";
import {
  inspectExtensionPackage,
  type InspectedExtensionPackage,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import type { SkillDiscoveryService } from "./skillDiscoveryService";

export interface StandaloneSkillActivationStore {
  read(): Promise<Readonly<Record<string, StandaloneSkillActivationState>>>;
  write(activations: Readonly<Record<string, StandaloneSkillActivationState>>): Promise<void>;
}

const IN_MEMORY_EMPTY_STORE: StandaloneSkillActivationStore = {
  async read() {
    return {};
  },
  async write() {
    // No persistence in memory-only mode.
  },
};

export interface SkillMarketplacePort {
  search(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly entries: ReadonlyArray<SkillMarketplaceEntry>;
    readonly nextCursor?: string;
  }>;
  resolve(
    source: Extract<ExtensionCommand, { readonly kind: "preview-skill" }>["source"],
    signal?: AbortSignal,
  ): Promise<ResolvedExtensionPackage>;
}

type SkillCommand = Extract<
  ExtensionCommand,
  {
    readonly kind:
      | "search-skills"
      | "preview-skill"
      | "install-skill"
      | "update-skill"
      | "remove-skill"
      | "reconcile-skills"
      | "review-skill"
      | "trust-skill-source"
      | "set-skill-desired"
      | "select-skill-collision";
  }
>;

export class StandaloneSkillService {
  readonly #discovery: Pick<SkillDiscoveryService, "snapshot" | "reconcile"> &
    Partial<Pick<SkillDiscoveryService, "startWatching">>;
  readonly #marketplace: SkillMarketplacePort | undefined;
  readonly #lifecycle: Pick<
    ExtensionLifecycleService,
    "snapshot" | "install" | "update" | "uninstall"
  >;
  readonly #activationStore: StandaloneSkillActivationStore;
  readonly #inspections = new Map<string, InspectedExtensionPackage>();
  #activations: Readonly<Record<string, StandaloneSkillActivationState>> = {};

  constructor(options: {
    readonly discovery: Pick<SkillDiscoveryService, "snapshot" | "reconcile"> &
      Partial<Pick<SkillDiscoveryService, "startWatching">>;
    readonly marketplace?: SkillMarketplacePort;
    readonly lifecycle: Pick<
      ExtensionLifecycleService,
      "snapshot" | "install" | "update" | "uninstall"
    >;
    readonly activationStore?: StandaloneSkillActivationStore;
  }) {
    this.#discovery = options.discovery;
    this.#marketplace = options.marketplace;
    this.#lifecycle = options.lifecycle;
    this.#activationStore = options.activationStore ?? IN_MEMORY_EMPTY_STORE;
  }

  async reconcile(): Promise<ExtensionSnapshot> {
    await this.#discovery.reconcile();
    await this.#discovery.startWatching?.();
    this.#activations = await this.#activationStore.read();
    await this.#turnOffConflictingSkills();
    return this.snapshot(this.#lifecycle.snapshot());
  }

  /**
   * An activation file written before one-at-a-time held can leave two
   * same-named skills on where one thread would see both. Neither wins on its
   * own: both are turned off, the collision is listed, and the person chooses.
   */
  async #turnOffConflictingSkills(): Promise<void> {
    const candidates = this.#candidates().map((record) => this.#applyActivation(record));
    const updated: Record<string, StandaloneSkillActivationState> = {};
    for (const record of candidates) {
      if (
        isActive(record) &&
        candidates.some(
          (other) =>
            other !== record &&
            other.skill.name === record.skill.name &&
            isActive(other) &&
            skillsShareAnAudience(record, other),
        )
      ) {
        updated[String(record.skill.qualifiedId)] = {
          ...this.#activationOf(record),
          desiredEnabled: false,
        };
      }
    }
    if (Object.keys(updated).length === 0) return;
    this.#activations = { ...this.#activations, ...updated };
    await this.#activationStore.write(this.#activations);
  }

  snapshot(base: ExtensionSnapshot): ExtensionSnapshot {
    const installed = base.packages.flatMap((pkg) =>
      pkg.components
        .filter(({ component }) => component.kind === "skill-instructions")
        .map(({ component, activation, effectiveState }) =>
          installedSkill(pkg, component, activation, effectiveState),
        ),
    );
    const discovered = this.#discovery
      .snapshot()
      .skills.filter(
        (skill) =>
          !installed.some((candidate) => candidate.skill.qualifiedId === skill.skill.qualifiedId),
      );
    const bundled = bundledSkillRecords().filter(
      (skill) =>
        !installed.some((candidate) => candidate.skill.qualifiedId === skill.skill.qualifiedId) &&
        !discovered.some((candidate) => candidate.skill.qualifiedId === skill.skill.qualifiedId),
    );
    const activated = [...discovered, ...bundled].map((skill) => this.#applyActivation(skill));
    const catalog = resolveStandaloneSkillCatalog(activated);
    return {
      ...base,
      skills: [...catalog.skills, ...installed],
      collisions: [...base.collisions, ...catalog.collisions],
    };
  }

  async execute(command: SkillCommand, signal?: AbortSignal): Promise<ExtensionCommandResult> {
    switch (command.kind) {
      case "search-skills": {
        if (this.#marketplace === undefined) throw new Error("Skill marketplace is unavailable.");
        const result = await this.#marketplace.search(command.query, command.cursor, signal);
        return {
          kind: "skill-search-results",
          entries: [...result.entries],
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        };
      }
      case "preview-skill": {
        const inspection = await this.#inspect(command.source, signal);
        return {
          kind: "skill-package-preview",
          preview: {
            entry: skillMarketplaceEntry(inspection.manifest),
            extensionId: inspection.manifest.extensionId,
            packageId: inspection.manifest.packageId,
            license: inspection.manifest.license,
            ...previewSkillInstructions(inspection),
            diagnostics: [],
          },
        };
      }
      case "install-skill":
        return this.#change(command, "install");
      case "update-skill":
        return this.#change(command, "update");
      case "remove-skill":
        return {
          kind: "extension-state-updated",
          snapshot: this.snapshot(await this.#lifecycle.uninstall(command.extensionId)),
        };
      case "reconcile-skills":
        return { kind: "extension-state-updated", snapshot: await this.reconcile() };
      case "review-skill":
      case "trust-skill-source":
      case "set-skill-desired":
      case "select-skill-collision":
        return this.#mutateActivation(command);
    }
  }

  async #mutateActivation(
    command: Extract<
      SkillCommand,
      | { readonly kind: "review-skill" }
      | { readonly kind: "trust-skill-source" }
      | { readonly kind: "set-skill-desired" }
      | { readonly kind: "select-skill-collision" }
    >,
  ): Promise<ExtensionCommandResult> {
    const key = command.qualifiedId;
    const target = this.#candidates().find(
      (candidate) => String(candidate.skill.qualifiedId) === key,
    );
    if (target === undefined && this.#isInstalledSkill(key)) {
      // An installed skill's switches belong to its package; an entry here
      // would never be read, so the switch would silently do nothing.
      return {
        kind: "extension-command-failed",
        failure: {
          category: "blocked",
          message:
            "An installed skill is switched on and off with its package in Extension packages.",
        },
      };
    }
    if (
      target === undefined ||
      (command.kind === "select-skill-collision"
        ? target.skill.name !== command.name
        : String(target.skill.digest) !== String(command.digest))
    ) {
      return {
        kind: "extension-command-failed",
        failure: { category: "stale", message: "Skill state is out of date." },
      };
    }
    const existing = this.#activationOf(target);
    switch (command.kind) {
      case "review-skill":
        this.#activations = { ...this.#activations, [key]: { ...existing, reviewed: true } };
        break;
      case "trust-skill-source":
        this.#activations = {
          ...this.#activations,
          [key]: { ...existing, reviewed: true, trusted: command.trusted },
        };
        break;
      case "set-skill-desired": {
        const updated = command.desired ? this.#turnOffOthersMeeting(target) : {};
        this.#activations = {
          ...this.#activations,
          ...updated,
          [key]: { ...existing, desiredEnabled: command.desired },
        };
        break;
      }
      case "select-skill-collision": {
        const updated = this.#turnOffOthersMeeting(target);
        this.#activations = {
          ...this.#activations,
          ...updated,
          [key]: { ...existing, reviewed: true, trusted: true, desiredEnabled: true },
        };
        break;
      }
    }
    await this.#activationStore.write(this.#activations);
    return {
      kind: "extension-state-updated",
      snapshot: this.snapshot(this.#lifecycle.snapshot()),
    };
  }

  /** The skills whose activation this service owns: discovered and built-in. */
  #candidates(): ReadonlyArray<StandaloneSkillRecord> {
    const discovered = this.#discovery.snapshot().skills;
    return [
      ...discovered,
      ...bundledSkillRecords().filter(
        (bundled) =>
          !discovered.some(
            (record) => String(record.skill.qualifiedId) === String(bundled.skill.qualifiedId),
          ),
      ),
    ];
  }

  #isInstalledSkill(qualifiedId: string): boolean {
    return this.#lifecycle
      .snapshot()
      .packages.some((pkg) =>
        pkg.components.some(
          ({ component }) =>
            component.kind === "skill-instructions" &&
            String(sourceQualifiedSkillId(pkg.source, component.id, pkg.digest)) === qualifiedId,
        ),
      );
  }

  /** The stored decision for a skill, or the one it was found with. */
  #activationOf(record: StandaloneSkillRecord): StandaloneSkillActivationState {
    return (
      this.#activations[String(record.skill.qualifiedId)] ?? {
        reviewed: record.reviewed,
        trusted: record.provenance.reviewed,
        desiredEnabled: record.desiredEnabled,
      }
    );
  }

  /**
   * Only one same-named skill is on where a thread can see it. Turning one on
   * turns off every other same-named skill that shares a thread with it,
   * built-in ones included, and leaves another Project's skill alone.
   */
  #turnOffOthersMeeting(
    target: StandaloneSkillRecord,
  ): Readonly<Record<string, StandaloneSkillActivationState>> {
    const updated: Record<string, StandaloneSkillActivationState> = {};
    for (const candidate of this.#candidates()) {
      if (
        String(candidate.skill.qualifiedId) !== String(target.skill.qualifiedId) &&
        candidate.skill.name === target.skill.name &&
        skillsShareAnAudience(candidate, target)
      ) {
        updated[String(candidate.skill.qualifiedId)] = {
          ...this.#activationOf(candidate),
          desiredEnabled: false,
        };
      }
    }
    return updated;
  }

  #applyActivation(record: StandaloneSkillRecord): StandaloneSkillRecord {
    const key = String(record.skill.qualifiedId);
    const activation = this.#activations[key];
    if (activation === undefined) return record;
    return {
      ...record,
      reviewed: activation.reviewed,
      desiredEnabled: activation.desiredEnabled,
      // `provenance.reviewed` carries the user's trust decision for filesystem
      // skills. The publisher provenance is the skill source itself; trust is
      // explicit and revocable.
      provenance: { reviewed: activation.trusted },
    };
  }

  async #inspect(
    source: Extract<ExtensionCommand, { readonly kind: "preview-skill" }>["source"],
    signal?: AbortSignal,
  ) {
    if (this.#marketplace === undefined) throw new Error("Skill marketplace is unavailable.");
    const resolved = await this.#marketplace.resolve(source, signal);
    const inspection = inspectExtensionPackage(resolved);
    if (
      !inspection.manifest.components.some((component) => component.kind === "skill-instructions")
    ) {
      throw new Error("Skill package is invalid.");
    }
    this.#inspections.set(targetKey(inspection.manifest), inspection);
    while (this.#inspections.size > 64) {
      const oldest = this.#inspections.keys().next().value;
      if (oldest === undefined) break;
      this.#inspections.delete(oldest);
    }
    return inspection;
  }

  async #change(
    command: Extract<ExtensionCommand, { readonly kind: "install-skill" | "update-skill" }>,
    operation: "install" | "update",
  ): Promise<ExtensionCommandResult> {
    const inspection = this.#inspections.get(targetKey(command));
    if (inspection === undefined) {
      return {
        kind: "extension-command-failed",
        failure: { category: "stale", message: "Skill preview is required." },
      };
    }
    const snapshot =
      operation === "install"
        ? await this.#lifecycle.install(inspection)
        : await this.#lifecycle.update(inspection);
    return { kind: "extension-state-updated", snapshot: this.snapshot(snapshot) };
  }
}

function installedSkill(
  pkg: ExtensionSnapshot["packages"][number],
  component: ExtensionPackageManifest["components"][number],
  activation: ExtensionSnapshot["packages"][number]["activation"],
  effectiveState: ExtensionSnapshot["packages"][number]["components"][number]["effectiveState"],
): StandaloneSkillRecord {
  const skillId = sourceQualifiedSkillId(pkg.source, component.id, pkg.digest);
  return {
    skill: {
      qualifiedId: skillId,
      name: component.skillName ?? component.id,
      sourceKind: pkg.source.kind,
      digest: pkg.digest,
      available: true,
    },
    source: pkg.source,
    version: pkg.version,
    displayName: component.displayName,
    ...(component.description === undefined ? {} : { description: component.description }),
    provenance: { reviewed: activation.trusted },
    contentBytes: 0,
    reviewed: activation.trusted,
    desiredEnabled: activation.componentDesired,
    effectiveState,
  };
}

function skillMarketplaceEntry(manifest: ExtensionPackageManifest): SkillMarketplaceEntry {
  const component = manifest.components.find(
    (candidate) => candidate.kind === "skill-instructions",
  );
  if (component === undefined) throw new Error("Skill package is invalid.");
  return {
    skill: {
      qualifiedId: sourceQualifiedSkillId(manifest.source, component.id, manifest.digest),
      name: component.skillName ?? component.id,
      sourceKind: manifest.source.kind,
      digest: manifest.digest,
      available: true,
    },
    source: manifest.source,
    version: manifest.version,
    displayName: component.displayName,
    ...(component.description === undefined ? {} : { description: component.description }),
    provenance: manifest.provenance,
  };
}

function previewSkillInstructions(inspection: InspectedExtensionPackage): {
  readonly instructions?: string;
} {
  const component = inspection.manifest.components.find(
    (candidate) => candidate.kind === "skill-instructions",
  );
  if (component === undefined) throw new Error("Skill package is invalid.");
  const referencedPath = inspection.contentReferences[component.id];
  const file =
    referencedPath === undefined
      ? inspection.files.find(
          (candidate) => candidate.path === "SKILL.md" || candidate.path.endsWith("/SKILL.md"),
        )
      : inspection.files.find((candidate) => candidate.path === referencedPath);
  if (file === undefined) throw new Error("Skill instructions are unavailable for review.");
  let instructions: string;
  try {
    instructions = new TextDecoder("utf-8", { fatal: true }).decode(file.content).trim();
  } catch {
    throw new Error("Skill instructions are unavailable for review.");
  }
  if (instructions === "") return {};
  if (instructions.length > MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH) {
    throw new Error("Skill instructions exceed the preview limit.");
  }
  return { instructions };
}

function standaloneEffectiveState(
  record: StandaloneSkillRecord,
  superseded: boolean,
): ExtensionEffectiveState {
  if (!record.skill.available) {
    return { kind: "blocked", reason: "unavailable" };
  }
  if (superseded) {
    return { kind: "blocked", reason: "superseded" };
  }
  if (!record.provenance.reviewed) {
    return { kind: "blocked", reason: "untrusted" };
  }
  if (!record.reviewed) {
    return { kind: "blocked", reason: "review-required" };
  }
  if (!record.desiredEnabled) {
    return { kind: "blocked", reason: "component-disabled" };
  }
  return { kind: "effective" };
}

function isActive(record: StandaloneSkillRecord): boolean {
  return (
    record.skill.available && record.reviewed && record.desiredEnabled && record.provenance.reviewed
  );
}

/** The narrowest set of threads a skill reaches: its thread, its Project, or every thread. */
function audienceOf(record: Pick<StandaloneSkillRecord, "scope" | "projectScope">): SkillAudience {
  if (record.scope !== undefined) {
    return {
      mode: record.scope.mode,
      projectId: String(record.scope.projectId),
      threadRef: String(record.scope.threadRef),
    };
  }
  if (record.projectScope !== undefined) {
    return {
      mode: record.projectScope.mode,
      projectId: String(record.projectScope.projectId),
      threadRef: null,
    };
  }
  return { mode: "chat", projectId: null, threadRef: null };
}

/**
 * Could one thread see both skills? A shared skill meets every skill; two
 * Project skills meet only inside the same Project; a thread's own skill
 * meets its Project's and its thread's.
 */
function skillsShareAnAudience(
  left: Pick<StandaloneSkillRecord, "scope" | "projectScope">,
  right: Pick<StandaloneSkillRecord, "scope" | "projectScope">,
): boolean {
  return (
    skillReachesAudience(left, audienceOf(right)) || skillReachesAudience(right, audienceOf(left))
  );
}

/**
 * Decide each skill's state per audience. A skill gives way when an active
 * same-named skill shares a thread with it. Two active same-named skills that
 * share a thread both fail closed until one is chosen. A collision is listed
 * only where one thread would see several sources without exactly one in use,
 * so two Projects that each use their own skill do not collide.
 */
function resolveStandaloneSkillCatalog(records: ReadonlyArray<StandaloneSkillRecord>): {
  readonly skills: ReadonlyArray<StandaloneSkillRecord>;
  readonly collisions: ReadonlyArray<ExtensionSkillCollision>;
} {
  const byName = new Map<string, StandaloneSkillRecord[]>();
  for (const record of records) {
    const list = byName.get(record.skill.name) ?? [];
    list.push(record);
    byName.set(record.skill.name, list);
  }

  const skills: StandaloneSkillRecord[] = [];
  const collisions: ExtensionSkillCollision[] = [];

  for (const [name, candidates] of byName) {
    const available = candidates.filter((candidate) => candidate.skill.available);
    const colliding = new Set<StandaloneSkillRecord>();
    for (const audience of available.map(audienceOf)) {
      const reached = available.filter((candidate) => skillReachesAudience(candidate, audience));
      if (reached.length > 1 && reached.filter(isActive).length !== 1) {
        for (const candidate of reached) colliding.add(candidate);
      }
    }
    if (colliding.size > 0) {
      collisions.push({
        name,
        candidates: available
          .filter((candidate) => colliding.has(candidate))
          .map((candidate) => candidate.skill.qualifiedId),
      });
    }
    for (const candidate of candidates) {
      const superseded = available.some(
        (other) =>
          other !== candidate && isActive(other) && skillsShareAnAudience(candidate, other),
      );
      skills.push({
        ...candidate,
        effectiveState: standaloneEffectiveState(candidate, superseded),
      });
    }
  }

  return { skills, collisions };
}

function targetKey(value: {
  readonly extensionId: string;
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
}): string {
  return `${value.extensionId}:${value.packageId}:${value.version}:${value.digest}`;
}
