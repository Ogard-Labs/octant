import {
  decodeCanvasActionCancelRequest,
  decodeCanvasActionRequest,
  decodeCanvasActionResult,
  decodeCanvasActor,
  decodeCanvasCreateResult,
  decodeCanvasId,
  decodeCanvasReviseRequest,
  decodeCanvasReviseResult,
  decodeCanvasRefreshCancelRequest,
  decodeCanvasRefreshRequest,
  decodeCanvasRefreshResult,
  decodeCanvasVersionId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type CanvasActionCancelRequest,
  type CanvasActionReport,
  type CanvasActionRequest,
  type CanvasActionResult,
  type CanvasActor,
  type CanvasVersion,
  type CanvasCreateResult,
  type CanvasThreadReferenceCard,
  type CanvasGetOutcome,
  type CanvasHistoryOutcome,
  type CanvasId,
  type CanvasReviseResult,
  type CanvasRefreshCancelRequest,
  type CanvasRefreshRequest,
  type CanvasRefreshRecipe,
  type CanvasRefreshSkill,
  type CanvasRefreshSkillOptions,
  type CanvasRefreshResult,
  type CanvasRefreshSourceResult,
  type CanvasDefinition,
  type CanvasProvenance,
  type CanvasWorkspaceScope,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  CanvasCardsPolicyRejected,
  CanvasRevisionPolicyRejected,
  admitCanvasCreate,
  admitCanvasRevise,
  authorizeCanvasCreateRequest,
  buildCreateVersion,
  listCanvasVersionHistory,
  projectThreadReferenceCardFromVersion,
  CanvasRefreshPolicyRejected,
  buildCanvasRefreshVersion,
  classifyCanvasRefreshOutcome,
  validateCanvasRefreshRequest,
  CanvasActionPolicyRejected,
  authorizeCanvasAction,
  evaluateCanvasActionApproval,
  planCanvasActionEffect,
  reportCanvasActionCapability,
  sameCanvasActionIdentity,
  type CanvasActionCapability,
} from "@octant/domain";
import type { CanvasProjection } from "./canvasProjection";
import { CanvasEventStore, CanvasEventStoreError } from "./canvasEventStore";

export interface CanvasServiceOptions {
  readonly projection: CanvasProjection;
  readonly eventStore: CanvasEventStore;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor?: CanvasActor;
  readonly providerInstanceId?: ReturnType<typeof decodeProviderInstanceId>;
  readonly modelId?: ReturnType<typeof decodeProviderModelId>;
  /**
   * Told about every version this service commits, whatever surface asked for
   * it. The mirror listens here so materialization follows revision rather than
   * being re-triggered by each renderer that can revise.
   *
   * It is told after the journal write, never before, and its failure is not
   * the revision's: a file that could not be written must not undo a version
   * that already happened.
   */
  readonly onVersionCommitted?: (version: CanvasVersion) => void;
}

export interface CanvasAuthorizationContext {
  readonly mode: "chat" | "work" | "code";
  readonly projectId: string | null;
  readonly hostId?: string;
  readonly workspace?: import("@octant/contracts/canvas-cards").CanvasWorkspaceScope;
  readonly originThreadId?: string;
}

export interface CanvasProjectRecord {
  readonly id: string;
  readonly type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
}

export type CanvasRefreshSourceOutcome = CanvasRefreshSourceResult & {
  /** New server-validated definition produced by the authoritative source. */
  readonly refreshedDefinition?: CanvasDefinition;
};

/**
 * The honest result of dispatching an admitted, reauthorized Canvas action
 * command. Read commands complete with a typed navigation/selection report;
 * `request-refresh` and `propose-thread` are handed off to their own
 * subsystems and reported as `requested`. A dispatch that could not produce a
 * side effect fails closed rather than faking success.
 */
export type CanvasActionExecutionOutcome =
  | { readonly outcome: "completed" | "requested"; readonly report: CanvasActionReport }
  | { readonly outcome: "failed"; readonly message?: string };

export interface CanvasServiceDependencies {
  readonly authorize: (
    entry: NonNullable<ReturnType<CanvasProjection["getById"]>>,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ) => boolean;
  /** Reauthorize a source against provider, extension, and credential state. */
  readonly refreshSource?: (
    source: import("@octant/contracts").CanvasSourceManifestEntry,
    request: CanvasRefreshRequest,
    currentDefinition: import("@octant/contracts").CanvasDefinition,
    isCancelled?: () => boolean,
  ) => CanvasRefreshSourceOutcome | Promise<CanvasRefreshSourceOutcome>;
  /**
   * Resolve the active server-owned workspace for a Canvas from durable host
   * state. The Canvas's own provenance identifies it, so the resolution never
   * depends on client-supplied scope. `undefined` fails a mutation closed.
   */
  readonly resolveWorkspace?: (provenance: CanvasProvenance) => CanvasWorkspaceScope | undefined;
  /**
   * List the skills eligible to present this Canvas, for the client to offer as
   * a refresh choice. The host is the only source of a digest-pinned skill
   * identity; selection grants nothing, because `skillAuthorized` and the
   * contribution resolver re-check the chosen skill on the refresh itself.
   */
  readonly listRefreshSkills?: (
    provenance: CanvasProvenance,
    workspace: CanvasWorkspaceScope,
  ) => CanvasRefreshSkillOptions;
  readonly skillAuthorized?: (skill: CanvasRefreshSkill, request: CanvasRefreshRequest) => boolean;
  /**
   * Resolve a trusted skill contribution (layouts/presentation rules) for a
   * refresh recipe skill. A denied resolution fails the refresh closed; the
   * contribution never grants authority beyond the reauthorized sources.
   */
  readonly resolveSkillContribution?: (
    skill: CanvasRefreshSkill,
    request: CanvasRefreshRequest,
    currentDefinition: CanvasDefinition,
  ) => import("@octant/contracts/canvas-skill").CanvasSkillContributionResolution | undefined;
  readonly parameterAuthorized?: (
    parameter: CanvasRefreshRequest["recipe"]["parameters"][number],
    request: CanvasRefreshRequest,
    currentDefinition: CanvasDefinition,
  ) => boolean;
  /**
   * Reauthorize a specific command against current capability/credential state
   * just before dispatch. Returning a revocation fails the action closed with
   * an auditable receipt-less denial; used to prove capability revocation for
   * typed Canvas actions.
   */
  readonly reauthorizeCommand?: (
    request: CanvasActionRequest,
    capability: CanvasActionCapability,
  ) =>
    | { readonly ok: true }
    | { readonly ok: false; readonly code: "revoked" | "unauthorized"; readonly message: string };
  /**
   * Dispatch an admitted, reauthorized command. The default performs the
   * representative D2 stubs (authorized reads, honest refresh/thread hand-offs).
   * A host wires the real subsystems here; a thrown error fails the action
   * closed. The `isCancelled` probe lets a long dispatch observe an in-flight
   * cancellation.
   */
  readonly executeCommand?: (
    request: CanvasActionRequest,
    capability: CanvasActionCapability,
    currentDefinition: CanvasDefinition,
    isCancelled: () => boolean,
  ) => CanvasActionExecutionOutcome | Promise<CanvasActionExecutionOutcome>;
}

/**
 * Server-authoritative Canvas revision and history service. Mutations journal a
 * new immutable version; reads expose opaque history rows without secrets.
 */
export class CanvasService {
  readonly #projection: CanvasProjection;
  readonly #eventStore: CanvasEventStore;
  readonly #uuid: () => string;
  readonly #clock: () => UtcTimestamp;
  readonly #authorize: CanvasServiceDependencies["authorize"];
  readonly #promptSummaries = new Map<string, string>();
  readonly #onVersionCommitted: CanvasServiceOptions["onVersionCommitted"];
  readonly #actor: CanvasActor;
  readonly #providerInstanceId: ReturnType<typeof decodeProviderInstanceId>;
  readonly #modelId: ReturnType<typeof decodeProviderModelId>;
  readonly #refreshSource: NonNullable<CanvasServiceDependencies["refreshSource"]>;
  readonly #resolveWorkspace: CanvasServiceDependencies["resolveWorkspace"];
  readonly #listRefreshSkills: CanvasServiceDependencies["listRefreshSkills"];
  readonly #skillAuthorized: CanvasServiceDependencies["skillAuthorized"];
  readonly #resolveSkillContribution: CanvasServiceDependencies["resolveSkillContribution"];
  readonly #parameterAuthorized: CanvasServiceDependencies["parameterAuthorized"];
  readonly #refreshResults = new Map<string, CanvasRefreshResult>();
  readonly #refreshInFlight = new Map<string, Promise<CanvasRefreshResult>>();
  readonly #refreshInFlightIdentity = new Map<
    string,
    { readonly canvasId: string; readonly recipeId: string }
  >();
  readonly #refreshOperations = new Map<
    string,
    { readonly canvasId: string; readonly recipeId: string; readonly recipe: CanvasRefreshRecipe }
  >();
  readonly #reauthorizeCommand: CanvasServiceDependencies["reauthorizeCommand"];
  readonly #executeCommand: NonNullable<CanvasServiceDependencies["executeCommand"]>;
  readonly #actionResults = new Map<string, CanvasActionResult>();
  readonly #actionInFlight = new Map<string, Promise<CanvasActionResult>>();
  readonly #actionInFlightIdentity = new Map<
    string,
    { readonly canvasId: string; readonly blockId: string }
  >();
  readonly #actionOperations = new Map<
    string,
    {
      readonly canvasId: string;
      readonly blockId: string;
      readonly capability: CanvasActionCapability;
    }
  >();

  constructor(options: CanvasServiceOptions, dependencies: CanvasServiceDependencies) {
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#onVersionCommitted = options.onVersionCommitted;
    this.#authorize = dependencies.authorize;
    this.#resolveWorkspace = dependencies.resolveWorkspace;
    this.#listRefreshSkills = dependencies.listRefreshSkills;
    this.#skillAuthorized = dependencies.skillAuthorized;
    this.#resolveSkillContribution = dependencies.resolveSkillContribution;
    this.#parameterAuthorized = dependencies.parameterAuthorized;
    this.#actor =
      options.actor ??
      decodeCanvasActor({
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000002",
      });
    this.#providerInstanceId =
      options.providerInstanceId ??
      decodeProviderInstanceId("00000000-0000-4000-8000-000000000003");
    this.#modelId = options.modelId ?? decodeProviderModelId("octant-local");
    this.#refreshSource =
      dependencies.refreshSource ??
      ((source) => ({
        sourceId: source.sourceId,
        status: "failed",
        message: "Source refresh authority is unavailable; the prior Canvas remains available.",
      }));
    this.#reauthorizeCommand = dependencies.reauthorizeCommand;
    this.#executeCommand =
      dependencies.executeCommand ??
      ((request) => {
        const plan = planCanvasActionEffect(request);
        return { outcome: plan.outcome, report: plan.report };
      });
    for (const receipt of options.eventStore.replayRefreshReceipts?.() ?? []) {
      this.#refreshResults.set(
        String(receipt.requestId),
        decodeCanvasRefreshResult({
          kind: "accepted",
          receipt,
        }),
      );
    }
    for (const receipt of options.eventStore.replayActionReceipts?.() ?? []) {
      this.#actionResults.set(
        String(receipt.requestId),
        decodeCanvasActionResult({ kind: "accepted", receipt }),
      );
    }
  }

  get(
    canvasId: CanvasId,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
    versionId?: ReturnType<typeof decodeCanvasVersionId>,
  ): CanvasGetOutcome {
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return {
        kind: "unavailable",
        canvasId,
        reason: "Canvas is unavailable. Reopen it from the Project.",
      };
    }
    if (!this.#authorize(entry, context, project)) {
      return { kind: "unauthorized", canvasId };
    }
    if (versionId !== undefined) {
      const version = this.#projection.getVersion(canvasId, versionId);
      if (version === undefined) {
        return {
          kind: "unavailable",
          canvasId,
          reason: "Canvas version is unavailable.",
        };
      }
      return { kind: "ready", version, ...this.#publishedScope(version.definition) };
    }
    return {
      kind: "ready",
      version: entry.currentVersion,
      ...this.#publishedScope(entry.currentVersion.definition),
    };
  }

  /**
   * What a client needs from the host before it may mutate a Canvas: the
   * workspace scope it must echo back, and the skills the host considers
   * eligible to present this Canvas.
   *
   * A host without a resolver, or one that cannot resolve the scope, publishes
   * nothing: the Canvas still reads, and the client withholds the mutation
   * surfaces rather than inferring a scope the server would reject. Skill
   * eligibility is scoped by that same workspace, so an unresolved scope
   * publishes no skills either.
   */
  #publishedScope(definition: CanvasDefinition): {
    readonly workspace?: CanvasWorkspaceScope;
    readonly refreshSkills?: CanvasRefreshSkillOptions;
  } {
    const workspace = this.#resolveWorkspace?.(definition.provenance);
    if (workspace === undefined) return {};
    const refreshSkills = this.#listRefreshSkills?.(definition.provenance, workspace);
    return refreshSkills === undefined || refreshSkills.length === 0
      ? { workspace }
      : { workspace, refreshSkills };
  }

  history(
    canvasId: CanvasId,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): CanvasHistoryOutcome {
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return {
        kind: "unavailable",
        canvasId,
        reason: "Canvas is unavailable. Reopen it from the Project.",
      };
    }
    if (!this.#authorize(entry, context, project)) {
      return { kind: "unauthorized", canvasId };
    }
    const summaries = new Map<string, string>();
    for (const version of entry.versions) {
      const summary = this.#promptSummaries.get(String(version.versionId));
      if (summary !== undefined) summaries.set(String(version.versionId), summary);
    }
    return {
      kind: "ready",
      history: listCanvasVersionHistory(canvasId, entry.versions, summaries),
    };
  }

  /**
   * Append a new version to a canvas.
   *
   * `blocks` is the document an author wrote. Without it the prompt is recorded
   * as a note on the page rather than answered, which is all a revision with
   * nobody to write it can honestly do.
   */
  revise(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
    blocks?: ReadonlyArray<CanvasDefinition["blocks"][number]>,
  ): CanvasReviseResult {
    let request;
    try {
      request = decodeCanvasReviseRequest(requestInput);
    } catch {
      return {
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas revise request is malformed.",
      };
    }

    const canvasId = decodeCanvasId(request.canvasId);
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return {
        kind: "denied",
        denialCode: "unavailable",
        message: "Canvas is unavailable. Reopen it from the Project.",
      };
    }
    if (!this.#authorize(entry, context, project)) {
      return {
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas revise is not authorized in this workspace.",
      };
    }

    try {
      const admitted = admitCanvasRevise({
        request: requestInput,
        current: entry.currentVersion,
        receiptId: this.#uuid(),
        nextVersionId: this.#uuid(),
        now: this.#clock(),
        ...(blocks === undefined ? {} : { blocks }),
      });
      this.#eventStore.appendVersion({
        canvasId,
        current: entry.currentVersion,
        next: admitted.next,
        occurredAt: admitted.receipt.createdAt,
      });
      this.#projection.applyVersionAppended({ canvasId, version: admitted.next });
      this.#promptSummaries.set(String(admitted.next.versionId), request.prompt);
      this.#announceVersion(admitted.next);
      return decodeCanvasReviseResult({
        kind: "accepted",
        receipt: admitted.receipt,
      });
    } catch (error) {
      if (error instanceof CanvasRevisionPolicyRejected) {
        return {
          kind: "denied",
          denialCode: error.denialCode,
          message: error.message,
        };
      }
      throw error;
    }
  }

  /**
   * Tell whoever is listening that a version was committed.
   *
   * A listener that throws is swallowed on purpose. The version is already in
   * the journal; letting a mirror's failure escape here would report a revision
   * as denied when it plainly happened.
   */
  #announceVersion(version: CanvasVersion): void {
    try {
      this.#onVersionCommitted?.(version);
    } catch {
      // Reported by the listener's own receipt, never by the revision.
    }
  }

  /** Open a canvas. `blocks` is the document an author wrote, when one did. */
  create(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
    blocks?: ReadonlyArray<CanvasDefinition["blocks"][number]>,
  ): CanvasCreateResult {
    let request;
    try {
      request = authorizeCanvasCreateRequest({
        request: requestInput,
        activeContext: context,
      });
    } catch (error) {
      if (error instanceof CanvasCardsPolicyRejected) {
        return { kind: "denied", denialCode: error.denialCode, message: error.message };
      }
      return {
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas create request is malformed.",
      };
    }
    if (project === undefined || project.lifecycle !== "active" || project.type !== request.mode) {
      return {
        kind: "denied",
        denialCode: "unavailable",
        message: "The active Canvas Project is unavailable.",
      };
    }
    try {
      const canvasId = decodeCanvasId(this.#uuid());
      const versionId = decodeCanvasVersionId(this.#uuid());
      const admitted = admitCanvasCreate({
        request,
        receiptId: this.#uuid(),
        canvasId,
        versionId,
        now: this.#clock(),
      });
      const version = buildCreateVersion({
        request,
        admitted,
        canvasId,
        versionId,
        projectId: project.id as never,
        actor: this.#actor,
        providerInstanceId: this.#providerInstanceId,
        modelId: this.#modelId,
        createdAt: admitted.receipt.createdAt,
        ...(blocks === undefined ? {} : { blocks }),
      });
      this.#eventStore.appendCreate({
        canvasId,
        version,
        occurredAt: admitted.receipt.createdAt,
      });
      this.#projection.applyCreated({ canvasId, version });
      // A created Canvas is a committed version like any other, and since an
      // author can write its document at creation it is no longer reliably
      // empty. Announcing only revisions would leave a first draft with no
      // file until someone happened to edit it.
      this.#announceVersion(version);
      const card = projectThreadReferenceCardFromVersion({
        version,
        cardId: version.versionId,
        authority: admitted.receipt.effectiveAuthority,
        request,
      });
      return decodeCanvasCreateResult({
        kind: "accepted",
        receipt: admitted.receipt,
        card,
      });
    } catch (error) {
      if (error instanceof CanvasCardsPolicyRejected) {
        return { kind: "denied", denialCode: error.denialCode, message: error.message };
      }
      if (error instanceof CanvasEventStoreError) {
        return { kind: "denied", denialCode: "unavailable", message: error.message };
      }
      throw error;
    }
  }

  /**
   * Reauthorize and replay an approved refresh recipe. A partial outcome never
   * appends a version, preserving the last complete Canvas for recovery.
   */
  async refresh(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): Promise<CanvasRefreshResult> {
    let requestId: string | undefined;
    try {
      requestId = String(decodeCanvasRefreshRequest(requestInput).requestId);
    } catch {
      // The internal decoder returns the canonical malformed-request result.
    }
    if (requestId !== undefined) {
      const existing = this.#refreshInFlight.get(requestId);
      if (existing !== undefined) {
        const decoded = decodeCanvasRefreshRequest(requestInput);
        const identity = this.#refreshInFlightIdentity.get(requestId);
        if (
          identity?.canvasId !== String(decoded.canvasId) ||
          identity.recipeId !== String(decoded.recipe.recipeId)
        ) {
          return decodeCanvasRefreshResult({
            kind: "denied",
            denialCode: "unauthorized",
            message: "Refresh identity does not match the active operation.",
          });
        }
        return existing;
      }
      const decoded = decodeCanvasRefreshRequest(requestInput);
      this.#refreshInFlightIdentity.set(requestId, {
        canvasId: String(decoded.canvasId),
        recipeId: String(decoded.recipe.recipeId),
      });
    }
    const operation = this.#refreshInternal(requestInput, context, project);
    if (requestId === undefined) return operation;
    this.#refreshInFlight.set(requestId, operation);
    try {
      return await operation;
    } finally {
      if (this.#refreshInFlight.get(requestId) === operation)
        this.#refreshInFlight.delete(requestId);
      this.#refreshInFlightIdentity.delete(requestId);
      this.#refreshOperations.delete(requestId);
    }
  }

  async #refreshInternal(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): Promise<CanvasRefreshResult> {
    let acceptedContribution:
      | import("@octant/contracts/canvas-skill").CanvasSkillContribution
      | undefined;
    let decoded: CanvasRefreshRequest;
    try {
      decoded = decodeCanvasRefreshRequest(requestInput);
    } catch {
      return decodeCanvasRefreshResult({
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas refresh request is malformed.",
      });
    }
    const cached = this.#refreshResults.get(String(decoded.requestId));
    if (cached !== undefined) {
      if (
        cached.kind === "accepted" &&
        (String(cached.receipt.canvasId) !== String(decoded.canvasId) ||
          String(cached.receipt.recipeId) !== String(decoded.recipe.recipeId))
      ) {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: "unauthorized",
          message: "Refresh identity does not match the recorded operation.",
        });
      }
      return cached;
    }
    const canvasId = decodeCanvasId(decoded.canvasId);
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return decodeCanvasRefreshResult({
        kind: "denied",
        denialCode: "unavailable",
        message: "Canvas is unavailable. Reopen it from the Project.",
      });
    }
    if (project === undefined || project.lifecycle !== "active") {
      return decodeCanvasRefreshResult({
        kind: "denied",
        denialCode: "unavailable",
        message: "The active Canvas Project is unavailable.",
      });
    }
    if (!this.#authorize(entry, context, project)) {
      return decodeCanvasRefreshResult({
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas refresh is not authorized in this workspace.",
      });
    }
    try {
      const serverWorkspace = this.#resolveWorkspace?.(entry.currentVersion.definition.provenance);
      if (this.#resolveWorkspace !== undefined && serverWorkspace === undefined) {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: "scope-mismatch",
          message: "The active server workspace scope is unavailable.",
        });
      }
      if (
        decoded.recipe.skill !== undefined &&
        (this.#skillAuthorized === undefined ||
          !this.#skillAuthorized(decoded.recipe.skill, decoded))
      ) {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: "unauthorized",
          message: "The selected refresh skill is no longer authorized.",
        });
      }
      // Resolve the skill's trusted layout/presentation contribution. Only a
      // trusted, enabled, effective skill contributes; a contribution never
      // widens authority beyond the reauthorized sources, so an unsupported
      // source or an untrusted skill fails the refresh closed here.
      if (decoded.recipe.skill !== undefined && this.#resolveSkillContribution !== undefined) {
        const contribution = this.#resolveSkillContribution(
          decoded.recipe.skill,
          decoded,
          entry.currentVersion.definition,
        );
        if (contribution !== undefined && contribution.kind === "denied") {
          return decodeCanvasRefreshResult({
            kind: "denied",
            denialCode:
              contribution.denialCode === "unsupported-source" ? "incompatible" : "unauthorized",
            message: contribution.message,
          });
        }
        // Retain the authorized contribution so the accepted receipt can carry
        // auditable provenance. It stays presentation metadata: the refresh was
        // already authorized above, and echoing it grants nothing.
        if (contribution !== undefined && contribution.kind === "admitted") {
          acceptedContribution = contribution.contribution;
        }
      }
      const request = validateCanvasRefreshRequest({
        request: decoded,
        current: entry.currentVersion,
        context: {
          ...context,
          ...(serverWorkspace === undefined ? {} : { workspace: serverWorkspace }),
        },
      });
      if (
        request.recipe.parameters.some(
          (parameter) =>
            this.#parameterAuthorized === undefined ||
            !this.#parameterAuthorized(parameter, request, entry.currentVersion.definition),
        )
      ) {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: "unauthorized",
          message: "Canvas refresh parameter is not an authorized server-owned reference.",
        });
      }
      const currentSources = new Map(
        entry.currentVersion.definition.sourceManifest.map((source) => [
          String(source.sourceId),
          source,
        ]),
      );
      const manifestValid = request.recipe.sourceManifest.every((source) => {
        const canonical = currentSources.get(String(source.sourceId));
        return (
          canonical !== undefined &&
          sameCanvasSource(source, canonical) &&
          canonical.hostId === entry.currentVersion.definition.provenance.hostId &&
          String(canonical.projectId) ===
            String(entry.currentVersion.definition.provenance.projectId)
        );
      });
      this.#refreshOperations.set(String(request.requestId), {
        canvasId: String(request.canvasId),
        recipeId: String(request.recipe.recipeId),
        recipe: request.recipe,
      });
      const sources: CanvasRefreshSourceResult[] = [];
      let refreshedDefinition: CanvasDefinition | undefined;
      const requestedSourceIds = new Set<string>();
      for (const source of request.recipe.sourceManifest) {
        // Give the cancellation route a macrotask boundary between sources;
        // synchronous resolvers must not monopolize the event loop.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const currentSource = currentSources.get(String(source.sourceId));
        requestedSourceIds.add(String(source.sourceId));
        if (!manifestValid) {
          sources.push({
            sourceId: source.sourceId,
            status: currentSource === undefined ? "missing" : "unauthorized",
            message: "The complete refresh manifest is not authorized for this Canvas.",
          });
          continue;
        }
        if (currentSource === undefined) {
          sources.push({
            sourceId: source.sourceId,
            status: "missing",
            message: "Source is no longer part of this Canvas.",
          });
          continue;
        }
        if (!sameCanvasSource(source, currentSource)) {
          sources.push({
            sourceId: source.sourceId,
            status: "unauthorized",
            message: "Source manifest entry does not match the canonical Canvas source.",
          });
          continue;
        }
        if (
          currentSource.hostId !== entry.currentVersion.definition.provenance.hostId ||
          String(currentSource.projectId) !==
            String(entry.currentVersion.definition.provenance.projectId)
        ) {
          sources.push({
            sourceId: source.sourceId,
            status: "unauthorized",
            message: "Source is no longer authorized for this Canvas Project.",
          });
          continue;
        }
        if (this.#isRefreshCancelled(request.requestId)) {
          sources.push({
            sourceId: source.sourceId,
            status: "interrupted",
            message: "Refresh cancelled before source reauthorization completed.",
          });
          break;
        }
        try {
          const result = await this.#refreshSource(
            currentSource,
            request,
            entry.currentVersion.definition,
            () => this.#isRefreshCancelled(request.requestId),
          );
          if (String(result.sourceId) !== String(currentSource.sourceId)) {
            sources.push({
              sourceId: source.sourceId,
              status: "failed",
              message: "Source refresh identity changed; the prior Canvas remains available.",
            });
            continue;
          }
          if (result.status === "ready" && result.refreshedDefinition !== undefined) {
            if (
              refreshedDefinition !== undefined &&
              JSON.stringify(refreshedDefinition) !== JSON.stringify(result.refreshedDefinition)
            ) {
              sources.push({
                sourceId: source.sourceId,
                status: "failed",
                message: "Sources produced conflicting Canvas definitions.",
              });
              continue;
            }
            refreshedDefinition = result.refreshedDefinition;
          }
          if (result.status === "ready" && result.refreshedDefinition === undefined) {
            sources.push({
              sourceId: source.sourceId,
              status: "failed",
              message: "Source refresh did not provide a regenerated Canvas definition.",
            });
            continue;
          }
          sources.push({
            sourceId: result.sourceId,
            status: result.status,
            ...(result.message === undefined ? {} : { message: result.message }),
            ...(result.observedVersion === undefined
              ? {}
              : { observedVersion: result.observedVersion }),
          });
        } catch {
          sources.push({
            sourceId: source.sourceId,
            status: "failed",
            message: "Source refresh failed; the prior Canvas remains available.",
          });
        }
      }
      for (const currentSource of currentSources.values()) {
        if (!requestedSourceIds.has(String(currentSource.sourceId))) {
          sources.push({
            sourceId: currentSource.sourceId,
            status: "missing",
            message: "The approved refresh recipe omitted a canonical Canvas source.",
          });
        }
      }
      if (
        this.#isRefreshCancelled(request.requestId) &&
        !sources.some((source) => source.status === "interrupted")
      ) {
        sources.push({
          sourceId:
            request.recipe.sourceManifest[Math.max(0, sources.length - 1)]?.sourceId ??
            request.recipe.sourceManifest[0]?.sourceId ??
            ("00000000-0000-4000-8000-000000000000" as never),
          status: "interrupted",
          message: "Refresh cancelled before all sources completed.",
        });
      }
      const outcome = classifyCanvasRefreshOutcome(sources);
      if (outcome === "ready") {
        const next = buildCanvasRefreshVersion({
          canvasId,
          current: entry.currentVersion,
          nextVersionId: decodeCanvasVersionId(this.#uuid()),
          request,
          sources,
          ...(refreshedDefinition === undefined ? {} : { refreshedDefinition }),
          actor: this.#actor,
          createdAt: this.#clock(),
        });
        const receipt = decodeCanvasRefreshResult({
          kind: "accepted",
          ...(acceptedContribution === undefined ? {} : { contribution: acceptedContribution }),
          receipt: {
            schemaVersion: 1,
            kind: "canvas-refresh-receipt",
            requestId: request.requestId,
            recipeId: request.recipe.recipeId,
            recipe: request.recipe,
            canvasId,
            versionId: next.versionId,
            sequence: next.sequence,
            outcome,
            sources,
            completedAt: next.createdAt,
          },
        });
        if (receipt.kind !== "accepted")
          throw new Error("Canvas refresh receipt construction failed.");
        this.#eventStore.appendVersion({
          canvasId,
          current: entry.currentVersion,
          next,
          occurredAt: next.createdAt,
          refreshReceipt: receipt.receipt,
        });
        this.#projection.applyVersionAppended({ canvasId, version: next });
        this.#rememberRefreshResult(receipt);
        return receipt;
      }
      const receipt = decodeCanvasRefreshResult({
        kind: "accepted",
        ...(acceptedContribution === undefined ? {} : { contribution: acceptedContribution }),
        receipt: {
          schemaVersion: 1,
          kind: "canvas-refresh-receipt",
          requestId: request.requestId,
          recipeId: request.recipe.recipeId,
          recipe: request.recipe,
          canvasId,
          outcome,
          sources,
          completedAt: this.#clock(),
          recoveryReason:
            outcome === "cancelled"
              ? "Refresh interrupted; retry the approved recipe when the source is available."
              : "The prior complete Canvas version remains available.",
        },
      });
      if (outcome === "cancelled") {
        const cancelled = this.#refreshResults.get(String(request.requestId));
        if (cancelled !== undefined) return cancelled;
      }
      this.#persistRefreshResult(receipt);
      return receipt;
    } catch (error) {
      if (error instanceof CanvasRefreshPolicyRejected) {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: error.denialCode,
          message: error.message,
        });
      }
      if (error instanceof CanvasEventStoreError && error.category === "invalid") {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: "stale-version",
          message: "Canvas refresh raced with another version; retry the approved recipe.",
        });
      }
      throw error;
    }
  }

  async cancelRefresh(requestInput: unknown): Promise<CanvasRefreshResult> {
    let request: CanvasRefreshCancelRequest;
    try {
      request = decodeCanvasRefreshCancelRequest(requestInput);
    } catch {
      return decodeCanvasRefreshResult({
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas refresh cancellation is malformed.",
      });
    }
    const existing = this.#refreshResults.get(String(request.requestId));
    if (existing !== undefined) {
      if (
        existing.kind === "accepted" &&
        (String(existing.receipt.canvasId) !== String(request.canvasId) ||
          String(existing.receipt.recipeId) !== String(request.recipeId))
      ) {
        return decodeCanvasRefreshResult({
          kind: "denied",
          denialCode: "unauthorized",
          message: "Cancellation identity does not match the recorded refresh.",
        });
      }
      return existing;
    }
    const operation = this.#refreshOperations.get(String(request.requestId));
    if (
      operation === undefined ||
      operation.canvasId !== String(request.canvasId) ||
      operation.recipeId !== String(request.recipeId)
    ) {
      return decodeCanvasRefreshResult({
        kind: "denied",
        denialCode: "unavailable",
        message: "The refresh operation is unavailable or does not match this Canvas.",
      });
    }
    const cancelled = decodeCanvasRefreshResult({
      kind: "accepted",
      receipt: {
        schemaVersion: 1,
        kind: "canvas-refresh-receipt",
        requestId: request.requestId,
        recipeId: request.recipeId,
        recipe: operation.recipe,
        canvasId: request.canvasId,
        outcome: "cancelled",
        sources: [],
        completedAt: this.#clock(),
        recoveryReason: "Refresh cancelled before source reauthorization began.",
      },
    });
    this.#persistRefreshResult(cancelled);
    return cancelled;
  }

  #isRefreshCancelled(requestId: CanvasRefreshRequest["requestId"]): boolean {
    const cached = this.#refreshResults.get(String(requestId));
    return cached?.kind === "accepted" && cached.receipt.outcome === "cancelled";
  }

  #rememberRefreshResult(result: CanvasRefreshResult): void {
    if (result.kind === "accepted") {
      this.#refreshResults.set(String(result.receipt.requestId), result);
    }
  }

  #persistRefreshResult(result: CanvasRefreshResult): void {
    if (result.kind === "accepted") {
      const appendRefreshReceipt = (
        this.#eventStore as unknown as {
          appendRefreshReceipt?: CanvasEventStore["appendRefreshReceipt"];
        }
      ).appendRefreshReceipt;
      if (appendRefreshReceipt === undefined) {
        throw new CanvasEventStoreError(
          "invalid",
          "Canvas refresh receipt persistence is unavailable.",
        );
      }
      appendRefreshReceipt.call(this.#eventStore, {
        receipt: result.receipt,
        occurredAt: result.receipt.completedAt,
      });
    }
    this.#rememberRefreshResult(result);
  }

  /**
   * Reauthorize and execute an admitted Canvas action (D2). A duplicate
   * requestId replays the recorded receipt idempotently; a mismatched identity
   * for a reused requestId fails closed. Read commands complete; mutating
   * commands are approval-gated and handed off honestly. Every terminal outcome
   * is journaled as an auditable receipt.
   */
  async executeAction(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): Promise<CanvasActionResult> {
    let requestId: string | undefined;
    try {
      requestId = String(decodeCanvasActionRequest(requestInput).requestId);
    } catch {
      // The internal decoder returns the canonical malformed-request result.
    }
    if (requestId !== undefined) {
      const existing = this.#actionInFlight.get(requestId);
      if (existing !== undefined) {
        const decoded = decodeCanvasActionRequest(requestInput);
        const identity = this.#actionInFlightIdentity.get(requestId);
        if (
          identity?.canvasId !== String(decoded.canvasId) ||
          identity.blockId !== String(decoded.block.blockId)
        ) {
          return decodeCanvasActionResult({
            kind: "denied",
            denialCode: "unauthorized",
            message: "Action identity does not match the active operation.",
          });
        }
        return existing;
      }
      const decoded = decodeCanvasActionRequest(requestInput);
      this.#actionInFlightIdentity.set(requestId, {
        canvasId: String(decoded.canvasId),
        blockId: String(decoded.block.blockId),
      });
    }
    const operation = this.#executeActionInternal(requestInput, context, project);
    if (requestId === undefined) return operation;
    this.#actionInFlight.set(requestId, operation);
    try {
      return await operation;
    } finally {
      if (this.#actionInFlight.get(requestId) === operation) this.#actionInFlight.delete(requestId);
      this.#actionInFlightIdentity.delete(requestId);
      this.#actionOperations.delete(requestId);
    }
  }

  async #executeActionInternal(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): Promise<CanvasActionResult> {
    let decoded: CanvasActionRequest;
    try {
      decoded = decodeCanvasActionRequest(requestInput);
    } catch {
      return decodeCanvasActionResult({
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas action request is malformed.",
      });
    }
    const cached = this.#actionResults.get(String(decoded.requestId));
    if (cached !== undefined) {
      if (
        cached.kind === "accepted" &&
        (String(cached.receipt.canvasId) !== String(decoded.canvasId) ||
          String(cached.receipt.blockId) !== String(decoded.block.blockId))
      ) {
        return decodeCanvasActionResult({
          kind: "denied",
          denialCode: "unauthorized",
          message: "Action identity does not match the recorded operation.",
        });
      }
      return cached;
    }
    const canvasId = decodeCanvasId(decoded.canvasId);
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return decodeCanvasActionResult({
        kind: "denied",
        denialCode: "unavailable",
        message: "Canvas is unavailable. Reopen it from the Project.",
      });
    }
    if (project === undefined || project.lifecycle !== "active") {
      return decodeCanvasActionResult({
        kind: "denied",
        denialCode: "unavailable",
        message: "The active Canvas Project is unavailable.",
      });
    }
    if (!this.#authorize(entry, context, project)) {
      return decodeCanvasActionResult({
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas action is not authorized in this workspace.",
      });
    }
    try {
      // Actions dispatch side effects, so they are held to the same
      // server-owned scope as a refresh: a host that cannot resolve the
      // Canvas's workspace denies rather than accepting the client's word.
      const serverWorkspace = this.#resolveWorkspace?.(entry.currentVersion.definition.provenance);
      if (this.#resolveWorkspace !== undefined && serverWorkspace === undefined) {
        return decodeCanvasActionResult({
          kind: "denied",
          denialCode: "scope-mismatch",
          message: "The active server workspace scope is unavailable.",
        });
      }
      const request = authorizeCanvasAction({
        request: decoded,
        current: entry.currentVersion,
        context: {
          ...context,
          ...(serverWorkspace === undefined ? {} : { workspace: serverWorkspace }),
        },
      });
      const capability = reportCanvasActionCapability(request);
      // Capability revocation reauth just before dispatch.
      const reauth = this.#reauthorizeCommand?.(request, capability);
      if (reauth !== undefined && !reauth.ok) {
        return decodeCanvasActionResult({
          kind: "denied",
          denialCode: reauth.code,
          message: reauth.message,
        });
      }
      evaluateCanvasActionApproval(capability, request.approval);
      this.#actionOperations.set(String(request.requestId), {
        canvasId: String(request.canvasId),
        blockId: String(request.block.blockId),
        capability,
      });
      // Give a concurrent cancellation a boundary to interrupt an in-flight
      // action before any side effect is dispatched.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const cancelledBefore = this.#cancelledActionResult(request.requestId);
      if (cancelledBefore !== undefined) return cancelledBefore;
      let execution: CanvasActionExecutionOutcome;
      try {
        execution = await this.#executeCommand(
          request,
          capability,
          entry.currentVersion.definition,
          () => this.#isActionCancelled(request.requestId),
        );
      } catch {
        execution = {
          outcome: "failed",
          message: "Canvas action failed to execute; no side effect was recorded.",
        };
      }
      const cancelledAfter = this.#cancelledActionResult(request.requestId);
      if (cancelledAfter !== undefined) return cancelledAfter;
      const receipt = decodeCanvasActionResult({
        kind: "accepted",
        receipt: {
          schemaVersion: 1,
          kind: "canvas-action-receipt",
          requestId: request.requestId,
          canvasId,
          blockId: request.block.blockId,
          capability,
          outcome: execution.outcome,
          ...(execution.outcome === "failed" ? {} : { report: execution.report }),
          completedAt: this.#clock(),
          ...(execution.outcome === "failed" && execution.message !== undefined
            ? { recoveryReason: execution.message }
            : {}),
        },
      });
      this.#persistActionResult(receipt);
      return receipt;
    } catch (error) {
      if (error instanceof CanvasActionPolicyRejected) {
        return decodeCanvasActionResult({
          kind: "denied",
          denialCode: error.denialCode,
          message: error.message,
        });
      }
      throw error;
    }
  }

  /**
   * Cancel an in-flight or not-yet-dispatched action. A cancellation must name
   * the same Canvas and action block as the recorded operation; a completed
   * action replays its terminal receipt idempotently.
   */
  async cancelAction(requestInput: unknown): Promise<CanvasActionResult> {
    let request: CanvasActionCancelRequest;
    try {
      request = decodeCanvasActionCancelRequest(requestInput);
    } catch {
      return decodeCanvasActionResult({
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas action cancellation is malformed.",
      });
    }
    const existing = this.#actionResults.get(String(request.requestId));
    if (existing !== undefined) {
      if (
        existing.kind === "accepted" &&
        (String(existing.receipt.canvasId) !== String(request.canvasId) ||
          String(existing.receipt.blockId) !== String(request.blockId))
      ) {
        return decodeCanvasActionResult({
          kind: "denied",
          denialCode: "unauthorized",
          message: "Cancellation identity does not match the recorded action.",
        });
      }
      return existing;
    }
    const operation = this.#actionOperations.get(String(request.requestId));
    if (
      operation === undefined ||
      !sameCanvasActionIdentity(
        { canvasId: operation.canvasId, blockId: operation.blockId },
        { canvasId: String(request.canvasId), blockId: String(request.blockId) },
      )
    ) {
      return decodeCanvasActionResult({
        kind: "denied",
        denialCode: "unavailable",
        message: "The action operation is unavailable or does not match this Canvas.",
      });
    }
    const cancelled = decodeCanvasActionResult({
      kind: "accepted",
      receipt: {
        schemaVersion: 1,
        kind: "canvas-action-receipt",
        requestId: request.requestId,
        canvasId: request.canvasId,
        blockId: request.blockId,
        capability: operation.capability,
        outcome: "cancelled",
        completedAt: this.#clock(),
        recoveryReason: "Canvas action cancelled before it completed.",
      },
    });
    this.#persistActionResult(cancelled);
    return cancelled;
  }

  #isActionCancelled(requestId: CanvasActionRequest["requestId"]): boolean {
    const cached = this.#actionResults.get(String(requestId));
    return cached?.kind === "accepted" && cached.receipt.outcome === "cancelled";
  }

  #cancelledActionResult(
    requestId: CanvasActionRequest["requestId"],
  ): CanvasActionResult | undefined {
    const cached = this.#actionResults.get(String(requestId));
    return cached?.kind === "accepted" && cached.receipt.outcome === "cancelled"
      ? cached
      : undefined;
  }

  #rememberActionResult(result: CanvasActionResult): void {
    if (result.kind === "accepted") {
      this.#actionResults.set(String(result.receipt.requestId), result);
    }
  }

  #persistActionResult(result: CanvasActionResult): void {
    if (result.kind === "accepted") {
      const appendActionReceipt = (
        this.#eventStore as unknown as {
          appendActionReceipt?: CanvasEventStore["appendActionReceipt"];
        }
      ).appendActionReceipt;
      if (appendActionReceipt === undefined) {
        throw new CanvasEventStoreError(
          "invalid",
          "Canvas action receipt persistence is unavailable.",
        );
      }
      appendActionReceipt.call(this.#eventStore, {
        receipt: result.receipt,
        occurredAt: result.receipt.completedAt,
      });
    }
    this.#rememberActionResult(result);
  }

  threadReferenceCards(input: {
    readonly mode: "chat" | "work" | "code";
    readonly threadId: string;
    readonly projectId: string;
  }): ReadonlyArray<CanvasThreadReferenceCard> {
    return this.#projection
      .byThread({
        mode: input.mode,
        threadId: input.threadId,
        projectId: input.projectId as never,
      })
      .map((entry) =>
        projectThreadReferenceCardFromVersion({
          version: entry.currentVersion,
          cardId: entry.currentVersion.versionId,
          authority: {
            filesystem: false,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: false,
            executionPolicy: "approval-gated",
            permissionPersistence: "current-session",
          },
        }),
      );
  }
}

function sameCanvasSource(
  left: import("@octant/contracts").CanvasSourceManifestEntry,
  right: import("@octant/contracts").CanvasSourceManifestEntry,
): boolean {
  return (
    String(left.sourceId) === String(right.sourceId) &&
    left.kind === right.kind &&
    left.hostId === right.hostId &&
    String(left.projectId) === String(right.projectId) &&
    left.opaqueRef === right.opaqueRef &&
    // sourceVersion is a mutable observation, not part of source identity.
    left.displayName === right.displayName
  );
}
