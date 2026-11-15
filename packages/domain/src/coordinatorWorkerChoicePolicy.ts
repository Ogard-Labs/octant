import {
  nativeHarnessSlotCandidateKey,
  type CoordinatorWorkerChoice,
  type CoordinatorWorkerChoiceRank,
  type CoordinatorWorkerRole,
  type CoordinatorWorkerRoleName,
  type CoordinatorWorkerSize,
  type CoordinatorWorkerTask,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
} from "@octant/contracts";

/**
 * Which model a coordinator's worker starts on (docs/design/coordinator-threads.md,
 * Starting workers). A pure function of the person's model roles, the host's
 * facts about each model, and the coordinator's request: it never returns a
 * model outside the roles, and it says why whenever it does not start the
 * role's main model.
 */

/** Why a role's model cannot start a worker now. */
export type WorkerCandidateRejection =
  | "provider-off"
  | "not-signed-in"
  | "provider-down"
  | "model-not-offered"
  | "at-usage-limit"
  | "not-allowed"
  | "tools-not-verified"
  | "no-image-input"
  | "same-provider-as-reviewed";

/** What the host knows about one role model when a worker starts. */
export interface WorkerCandidateFacts {
  /** The model's name as its provider reports it, for reasons a person reads. */
  readonly label: string;
  /** The provider family ("claude-code", "codex", ...): a review prefers another one. */
  readonly providerKind: string;
  /**
   * Turned off or missing, signed out, down (its check or its last request
   * failed), or the model is not offered.
   */
  readonly notReady?: "provider-off" | "not-signed-in" | "provider-down" | "model-not-offered";
  /** At the account's usage limit, until the provider's reset when it named one. */
  readonly usageLimit?: { readonly until?: string };
  /** Allowed by the Project's provider policy and data rules. */
  readonly allowed: boolean;
  /** Carries the tools a worker needs (an agent runtime's own, or verified). */
  readonly toolsVerified: boolean;
  readonly readsImages: boolean;
}

export interface WorkerChoiceFacts {
  readonly candidate: (candidate: NativeHarnessSlotCandidate) => WorkerCandidateFacts;
  /** Whether the Sees images role has a model that can describe images. */
  readonly seesImagesAvailable: boolean;
}

/** Settings' roles and the Project's own choice; a role the Project lists wins. */
export interface WorkerRoles {
  readonly host: NativeHarnessRoutingConfiguration;
  readonly project?: NativeHarnessRoutingConfiguration | undefined;
}

export interface WorkerChoiceRequest {
  readonly task: CoordinatorWorkerTask;
  readonly size: CoordinatorWorkerSize;
  /**
   * The worker this one retries, by the role it ran in (absent when it ran
   * before roles and so counts as Builder). It starts one tier above.
   */
  readonly retries?: { readonly role?: CoordinatorWorkerRole | undefined } | undefined;
  /** The provider family of the worker a review reviews. */
  readonly reviewedProviderKind?: string | undefined;
  readonly risk?: "high" | undefined;
  readonly role?: CoordinatorWorkerRoleName | undefined;
  /** A handle from the role card. */
  readonly model?: string | undefined;
  readonly needsImages?: boolean | undefined;
  readonly why?: string | undefined;
}

export interface WorkerCandidateVerdict {
  readonly candidate: NativeHarnessSlotCandidate;
  readonly role: CoordinatorWorkerRole;
  readonly reasons: ReadonlyArray<WorkerCandidateRejection>;
}

export interface WorkerModelPick {
  readonly candidate: NativeHarnessSlotCandidate;
  readonly handle: string;
  /** The role the worker runs in (the role asked for, or Builder when it is empty). */
  readonly role: CoordinatorWorkerRole;
  readonly rank: CoordinatorWorkerChoiceRank;
  /** Host-written, from facts: why this is not the main model. Absent for the main model. */
  readonly reason?: string;
  /** Every model passed over before this one, with why. */
  readonly passedOver: ReadonlyArray<WorkerCandidateVerdict>;
}

export type WorkerModelChoice =
  | ({ readonly kind: "start" } & WorkerModelPick)
  | ({ readonly kind: "propose" } & WorkerModelPick)
  | {
      readonly kind: "refused";
      readonly reason: "model-not-eligible" | "no-eligible-model" | "policy";
      readonly message: string;
      readonly perCandidate: ReadonlyArray<WorkerCandidateVerdict>;
    };

export const WORKER_ROLE_NAMES: Readonly<Record<CoordinatorWorkerRole, string>> = {
  quick: "Quick edit",
  default: "Builder",
  deep: "Hard problems",
  slow: "Reviewer",
};

const ROLE_BY_NAME: Readonly<Record<CoordinatorWorkerRoleName, CoordinatorWorkerRole>> = {
  "quick-edit": "quick",
  builder: "default",
  "hard-problems": "deep",
  reviewer: "slow",
};

/** The role names a `start` call writes, by role. */
export const WORKER_ROLE_CALL_NAMES: Readonly<
  Record<CoordinatorWorkerRole, CoordinatorWorkerRoleName>
> = {
  quick: "quick-edit",
  default: "builder",
  deep: "hard-problems",
  slow: "reviewer",
};

/** The order the role card lists worker roles, and so the order handles are given. */
export const WORKER_ROLE_ORDER: ReadonlyArray<CoordinatorWorkerRole> = [
  "default",
  "quick",
  "deep",
  "slow",
];

const TIER: Readonly<Record<CoordinatorWorkerRole, number>> = {
  quick: 0,
  default: 1,
  slow: 1,
  deep: 2,
};

/** A role whose whole list is unavailable borrows these lists, in order. */
const BORROWS: Readonly<Record<CoordinatorWorkerRole, ReadonlyArray<CoordinatorWorkerRole>>> = {
  quick: ["default", "deep"],
  default: ["deep"],
  deep: ["default"],
  slow: ["default", "deep"],
};

/** The role's list: the Project's when it chose one for this role, else Settings'. */
export function effectiveWorkerRoleSlot(
  roles: WorkerRoles,
  role: string,
): NativeHarnessSlot | undefined {
  return (
    roles.project?.slots.find((slot) => String(slot.id) === role) ??
    roles.host.slots.find((slot) => String(slot.id) === role)
  );
}

/**
 * Whether the host chooses workers' models from roles: Builder, the role
 * every empty role falls back to, has a model. Without it, `start` keeps
 * today's rule (the coordinator's own model) so a host that never set roles
 * up keeps working.
 */
export function workerRolesConfigured(roles: WorkerRoles): boolean {
  return (effectiveWorkerRoleSlot(roles, "default")?.candidates.length ?? 0) > 0;
}

/** The role card's handles (`b1`…), one per distinct model across the worker roles. */
export function workerModelHandles(
  roles: WorkerRoles,
): ReadonlyArray<{ readonly handle: string; readonly candidate: NativeHarnessSlotCandidate }> {
  const seen = new Map<string, NativeHarnessSlotCandidate>();
  for (const role of WORKER_ROLE_ORDER) {
    for (const candidate of effectiveWorkerRoleSlot(roles, role)?.candidates ?? []) {
      const key = nativeHarnessSlotCandidateKey(candidate);
      if (!seen.has(key)) seen.set(key, candidate);
    }
  }
  return [...seen.values()].map((candidate, index) => ({
    handle: `b${String(index + 1)}`,
    candidate,
  }));
}

/** The role a request asks for before any list is read. */
export function requestedWorkerRole(request: {
  readonly task: CoordinatorWorkerTask;
  readonly size: CoordinatorWorkerSize;
  readonly risk?: "high" | undefined;
}): CoordinatorWorkerRole {
  if (request.task === "review") return request.risk === "high" ? "deep" : "slow";
  switch (request.size) {
    case "quick":
      return "quick";
    case "normal":
      return "default";
    case "hard":
      return "deep";
  }
}

/** One tier above a worker's role; Hard problems is the top and stays there. */
export function workerRoleAbove(role: CoordinatorWorkerRole | undefined): CoordinatorWorkerRole {
  switch (role ?? "default") {
    case "quick":
      return "default";
    case "default":
    case "slow":
    case "deep":
      return "deep";
  }
}

export function chooseWorkerModel(
  roles: WorkerRoles,
  facts: WorkerChoiceFacts,
  request: WorkerChoiceRequest,
): WorkerModelChoice {
  const overriding = request.role !== undefined || request.model !== undefined;
  if (overriding && request.why === undefined) {
    return refused("policy", "A role or model override needs a why.", []);
  }
  // Step 1: the role.
  const sized = requestedWorkerRole(request);
  const floor = request.retries === undefined ? undefined : workerRoleAbove(request.retries.role);
  let asked: CoordinatorWorkerRole;
  if (request.role !== undefined) {
    asked = ROLE_BY_NAME[request.role];
    if (floor !== undefined && TIER[asked] < TIER[floor]) {
      return refused(
        "policy",
        `A retry starts at ${WORKER_ROLE_NAMES[floor]} or above; it never goes down a tier.`,
        [],
      );
    }
  } else {
    asked = floor !== undefined && TIER[floor] > TIER[sized] ? floor : sized;
  }
  const askedSlot = effectiveWorkerRoleSlot(roles, asked);
  const role: CoordinatorWorkerRole =
    askedSlot === undefined || askedSlot.candidates.length === 0 ? "default" : asked;
  const emptyNote =
    role === asked ? undefined : `${WORKER_ROLE_NAMES[asked]} has no models; Builder's list`;
  const handles = workerModelHandles(roles);
  const handleOf = (candidate: NativeHarnessSlotCandidate) =>
    handles.find(
      (entry) =>
        nativeHarnessSlotCandidateKey(entry.candidate) === nativeHarnessSlotCandidateKey(candidate),
    )?.handle ?? "";
  const asksFirst = (slotRole: CoordinatorWorkerRole) =>
    effectiveWorkerRoleSlot(roles, slotRole)?.askBeforeUsing === true;

  // A named model: it starts only if it passes the same filter.
  if (request.model !== undefined) {
    const named = handles.find((entry) => entry.handle === request.model);
    if (named === undefined) {
      return refused(
        "model-not-eligible",
        `${request.model} is not on the role card. Use a handle the card lists.`,
        [],
      );
    }
    // A retry's floor holds for a named model too: it must be listed in a
    // role at or above the tier the retry starts in. An empty floor role
    // starts in Builder, as an unnamed retry does.
    const floorSlot = floor === undefined ? undefined : effectiveWorkerRoleSlot(roles, floor);
    const startsIn =
      floor === undefined
        ? undefined
        : floorSlot === undefined || floorSlot.candidates.length === 0
          ? "default"
          : floor;
    if (startsIn !== undefined) {
      const tiers = WORKER_ROLE_ORDER.filter((slotRole) =>
        (effectiveWorkerRoleSlot(roles, slotRole)?.candidates ?? []).some(
          (candidate) =>
            nativeHarnessSlotCandidateKey(candidate) ===
            nativeHarnessSlotCandidateKey(named.candidate),
        ),
      ).map((slotRole) => TIER[slotRole]);
      if (Math.max(...tiers) < TIER[startsIn]) {
        return refused(
          "policy",
          `${request.model} is listed only below ${WORKER_ROLE_NAMES[startsIn]}; a retry starts at ${WORKER_ROLE_NAMES[startsIn]} or above and never goes down a tier.`,
          [],
        );
      }
    }
    const reasons = [...hardRejections(named.candidate, facts, request)];
    // A named model keeps a review independent too: it may sit on the
    // reviewed worker's provider only while no model of the role's lists on
    // another provider could start.
    const reviewed = request.reviewedProviderKind;
    if (
      reasons.length === 0 &&
      request.task === "review" &&
      reviewed !== undefined &&
      facts.candidate(named.candidate).providerKind === reviewed &&
      [role, ...BORROWS[role]].some((listRole) =>
        (effectiveWorkerRoleSlot(roles, listRole)?.candidates ?? []).some(
          (candidate) =>
            facts.candidate(candidate).providerKind !== reviewed &&
            hardRejections(candidate, facts, request).length === 0,
        ),
      )
    ) {
      reasons.push("same-provider-as-reviewed");
    }
    if (reasons.length > 0) {
      return refused(
        "model-not-eligible",
        `${request.model} cannot start a worker now: ${reasons.join(", ")}.`,
        [{ candidate: named.candidate, role, reasons }],
      );
    }
    // A named model asks first when its role does or any role listing it does.
    const ask =
      asksFirst(role) ||
      WORKER_ROLE_ORDER.some(
        (slotRole) =>
          asksFirst(slotRole) &&
          (effectiveWorkerRoleSlot(roles, slotRole)?.candidates ?? []).some(
            (candidate) =>
              nativeHarnessSlotCandidateKey(candidate) ===
              nativeHarnessSlotCandidateKey(named.candidate),
          ),
      );
    return {
      kind: ask ? "propose" : "start",
      candidate: named.candidate,
      handle: named.handle,
      role,
      rank: "chosen",
      passedOver: [],
    };
  }

  // Steps 2-4: walk the role's list, then the lists it may borrow.
  const passedOver: WorkerCandidateVerdict[] = [];
  const lists: ReadonlyArray<CoordinatorWorkerRole> = [role, ...BORROWS[role]];
  for (const [listIndex, listRole] of lists.entries()) {
    const slot = effectiveWorkerRoleSlot(roles, listRole);
    if (slot === undefined || slot.candidates.length === 0) continue;
    const verdicts = filterList(slot.candidates, listRole, facts, request);
    const pickedIndex = verdicts.findIndex((verdict) => verdict.reasons.length === 0);
    const picked = pickedIndex === -1 ? undefined : verdicts[pickedIndex];
    if (picked === undefined) {
      passedOver.push(...verdicts);
      continue;
    }
    passedOver.push(...verdicts.slice(0, pickedIndex));
    const rank: CoordinatorWorkerChoiceRank =
      listIndex > 0
        ? {
            borrowed: listRole,
            ...(TIER[listRole] < TIER[role] ? { lowerTier: true as const } : {}),
          }
        : pickedIndex === 0
          ? "main"
          : { fallback: pickedIndex };
    const ask = asksFirst(asked) || asksFirst(role) || asksFirst(listRole);
    const reason = choiceReason(rank, role, listRole, passedOver, facts, emptyNote);
    return {
      kind: ask ? "propose" : "start",
      candidate: picked.candidate,
      handle: handleOf(picked.candidate),
      role,
      rank,
      ...(reason === undefined ? {} : { reason }),
      passedOver,
    };
  }
  return refused(
    "no-eligible-model",
    `No model in ${WORKER_ROLE_NAMES[role]}, or in the roles it may borrow, can start a worker now.`,
    passedOver,
  );
}

/** Why a running worker stays on its model when it stops. */
export type WorkerFallbackStay =
  /** A person picked the worker's model, so it is theirs to move. */
  | "taken-over"
  /** The role's **Continue on the fallback** box is off. */
  | "box-off"
  /** The roles no longer list the model it runs on. */
  | "not-in-roles"
  /** No model after it in the walk can take the work now. */
  | "none-left";

export type WorkerFallbackChoice =
  | {
      readonly kind: "continue";
      readonly candidate: NativeHarnessSlotCandidate;
      readonly role: CoordinatorWorkerRole;
      readonly rank: CoordinatorWorkerChoiceRank;
      /** Every model after the current one passed over before this one, with why. */
      readonly passedOver: ReadonlyArray<WorkerCandidateVerdict>;
    }
  | {
      readonly kind: "stays";
      readonly reason: WorkerFallbackStay;
      readonly perCandidate: ReadonlyArray<WorkerCandidateVerdict>;
    };

/**
 * The model a running worker continues on when its own stops on a usage
 * limit or an outage (docs/design/coordinator-threads.md, Running workers):
 * the next eligible model after the current one in the same walk a start
 * takes (the role's list, then the lists it may borrow), with the start's
 * own filters. The walk only goes forward and passes over every model it
 * already reached, so a worker moves through its lists at most once and
 * never back; at the end it stays, and pauses as before. A worker whose
 * model a person picked, whose role has the box off (the Project's choice
 * for the role before Settings), or whose model the roles no longer list
 * stays too. It never returns a model outside the roles.
 */
export function nextWorkerFallback(
  roles: WorkerRoles,
  facts: WorkerChoiceFacts,
  worker: {
    readonly current: Pick<NativeHarnessSlotCandidate, "providerInstanceId" | "modelId">;
    readonly choice: CoordinatorWorkerChoice;
  },
): WorkerFallbackChoice {
  const stays = (
    reason: WorkerFallbackStay,
    perCandidate: ReadonlyArray<WorkerCandidateVerdict> = [],
  ): WorkerFallbackChoice => ({ kind: "stays", reason, perCandidate });
  const { choice } = worker;
  if (choice.rank === "person") return stays("taken-over");
  const role = choice.role;
  if (effectiveWorkerRoleSlot(roles, role)?.continueOnFallback === false) return stays("box-off");
  const walk = [role, ...BORROWS[role]].flatMap((listRole) =>
    (effectiveWorkerRoleSlot(roles, listRole)?.candidates ?? []).map((candidate, index) => ({
      candidate,
      listRole,
      index,
    })),
  );
  // By provider and model: the worker's record carries no host, and a role
  // lists each model once per host.
  const keyOf = (candidate: Pick<NativeHarnessSlotCandidate, "providerInstanceId" | "modelId">) =>
    `${String(candidate.providerInstanceId)}\u0000${String(candidate.modelId)}`;
  const current = keyOf(worker.current);
  // The list the choice names first: a borrowed model sits in the list it was borrowed from.
  const named =
    typeof choice.rank === "object" && "borrowed" in choice.rank ? choice.rank.borrowed : role;
  let position = walk.findIndex(
    (entry) => entry.listRole === named && keyOf(entry.candidate) === current,
  );
  if (position === -1) position = walk.findIndex((entry) => keyOf(entry.candidate) === current);
  if (position === -1) return stays("not-in-roles");
  const reached = new Set(walk.slice(0, position + 1).map((entry) => keyOf(entry.candidate)));
  const request: WorkerChoiceRequest = {
    task: choice.reviewedProviderKind === undefined ? "feature" : "review",
    size: "normal",
    ...(choice.needsImages === true ? { needsImages: true } : {}),
    ...(choice.reviewedProviderKind === undefined
      ? {}
      : { reviewedProviderKind: choice.reviewedProviderKind }),
  };
  const remaining = walk.slice(position + 1).filter((entry) => {
    const key = keyOf(entry.candidate);
    if (reached.has(key)) return false;
    reached.add(key);
    return true;
  });
  const passedOver: WorkerCandidateVerdict[] = [];
  for (const listRole of [role, ...BORROWS[role]]) {
    const entries = remaining.filter((entry) => entry.listRole === listRole);
    if (entries.length === 0) continue;
    const verdicts = filterList(
      entries.map((entry) => entry.candidate),
      listRole,
      facts,
      request,
    );
    const pickedIndex = verdicts.findIndex((verdict) => verdict.reasons.length === 0);
    const picked = pickedIndex === -1 ? undefined : entries[pickedIndex];
    if (picked === undefined) {
      passedOver.push(...verdicts);
      continue;
    }
    passedOver.push(...verdicts.slice(0, pickedIndex));
    const rank: CoordinatorWorkerChoiceRank =
      listRole !== role
        ? {
            borrowed: listRole,
            ...(TIER[listRole] < TIER[role] ? { lowerTier: true as const } : {}),
          }
        : picked.index === 0
          ? "main"
          : { fallback: picked.index };
    return { kind: "continue", candidate: picked.candidate, role, rank, passedOver };
  }
  return stays("none-left", passedOver);
}

function filterList(
  candidates: ReadonlyArray<NativeHarnessSlotCandidate>,
  role: CoordinatorWorkerRole,
  facts: WorkerChoiceFacts,
  request: WorkerChoiceRequest,
): ReadonlyArray<WorkerCandidateVerdict> {
  const verdicts = candidates.map((candidate) => ({
    candidate,
    role,
    reasons: hardRejections(candidate, facts, request),
  }));
  const reviewed = request.reviewedProviderKind;
  if (request.task !== "review" || reviewed === undefined) return verdicts;
  // A review drops models on the reviewed worker's provider only while a
  // model on another provider is left.
  const otherLeft = verdicts.some(
    (verdict) =>
      verdict.reasons.length === 0 && facts.candidate(verdict.candidate).providerKind !== reviewed,
  );
  if (!otherLeft) return verdicts;
  return verdicts.map((verdict) =>
    verdict.reasons.length === 0 && facts.candidate(verdict.candidate).providerKind === reviewed
      ? { ...verdict, reasons: ["same-provider-as-reviewed"] }
      : verdict,
  );
}

function hardRejections(
  candidate: NativeHarnessSlotCandidate,
  facts: WorkerChoiceFacts,
  request: WorkerChoiceRequest,
): ReadonlyArray<WorkerCandidateRejection> {
  const fact = facts.candidate(candidate);
  const reasons: WorkerCandidateRejection[] = [];
  if (fact.notReady !== undefined) reasons.push(fact.notReady);
  if (fact.usageLimit !== undefined) reasons.push("at-usage-limit");
  if (!fact.allowed) reasons.push("not-allowed");
  if (!fact.toolsVerified) reasons.push("tools-not-verified");
  if (request.needsImages === true && !fact.readsImages && !facts.seesImagesAvailable) {
    reasons.push("no-image-input");
  }
  return reasons;
}

const REJECTION_WORDS: Readonly<Record<WorkerCandidateRejection, string>> = {
  "provider-off": "provider turned off",
  "not-signed-in": "not signed in",
  "provider-down": "provider down",
  "model-not-offered": "not offered by its provider",
  "at-usage-limit": "at usage limit",
  "not-allowed": "not allowed in this Project",
  "tools-not-verified": "tools not verified",
  "no-image-input": "cannot read images",
  "same-provider-as-reviewed": "same provider as the reviewed worker",
};

/** One model's reasons in the words a person and the coordinator read. */
export function describeWorkerCandidateRejection(
  verdict: Pick<WorkerCandidateVerdict, "reasons">,
  fact: WorkerCandidateFacts,
): string {
  const words = verdict.reasons.map((reason) =>
    reason === "at-usage-limit" && fact.usageLimit?.until !== undefined
      ? `at usage limit until ${workerClockTime(fact.usageLimit.until)}`
      : REJECTION_WORDS[reason],
  );
  return `${fact.label} ${words.join(", ")}`;
}

function choiceReason(
  rank: CoordinatorWorkerChoiceRank,
  role: CoordinatorWorkerRole,
  listRole: CoordinatorWorkerRole,
  passedOver: ReadonlyArray<WorkerCandidateVerdict>,
  facts: WorkerChoiceFacts,
  emptyNote: string | undefined,
): string | undefined {
  if (rank === "main") return emptyNote;
  const first = passedOver[0];
  const parts: string[] = [];
  if (emptyNote !== undefined) parts.push(emptyNote);
  if (typeof rank === "object" && "borrowed" in rank) {
    parts.push(
      rank.lowerTier === true
        ? `lower tier: all ${WORKER_ROLE_NAMES[role]} models unavailable`
        : `all ${WORKER_ROLE_NAMES[role]} models unavailable; borrowed ${WORKER_ROLE_NAMES[listRole]}`,
    );
  }
  if (first !== undefined) {
    const why = describeWorkerCandidateRejection(first, facts.candidate(first.candidate));
    parts.push(passedOver.length === 1 ? `main ${why}` : `main ${why} (and more)`);
  }
  return parts.length === 0 ? undefined : parts.join("; ").slice(0, 400);
}

/** "14:00 UTC" from an ISO instant; the text itself when it is not one. */
export function workerClockTime(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match?.[1] === undefined ? iso : `${match[1]} UTC`;
}

function refused(
  reason: "model-not-eligible" | "no-eligible-model" | "policy",
  message: string,
  perCandidate: ReadonlyArray<WorkerCandidateVerdict>,
): WorkerModelChoice {
  return { kind: "refused", reason, message, perCandidate };
}
