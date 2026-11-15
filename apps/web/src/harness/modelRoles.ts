import {
  MAX_NATIVE_HARNESS_SLOT_CANDIDATES,
  nativeHarnessSlotCandidateKey,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type NativeHarnessSlotId,
} from "@octant/contracts";
import type { RoleSuggestion } from "@octant/domain";

export interface ModelRolePresentation {
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
}

/**
 * The roles a person sees, in the order the work gets harder. Each is a slot in
 * the routing table; the CLI and the guide still call them slots.
 */
export const MODEL_ROLES: ReadonlyArray<ModelRolePresentation> = [
  {
    id: "plan",
    label: "Planner",
    meaning: "Plans the work, splits it up and reads what comes back.",
  },
  {
    id: "task",
    label: "Scout",
    meaning: "Quick reads: searching, looking things up, reading logs and CI output.",
  },
  {
    id: "quick",
    label: "Quick edit",
    meaning: "Lint and format fixes, renames, one-line fixes, copy and docs edits.",
  },
  {
    id: "default",
    label: "Builder",
    meaning:
      "Ordinary features, bug fixes and tests. Every empty role uses it, and it takes over when a thread's own model stops answering.",
  },
  {
    id: "deep",
    label: "Hard problems",
    meaning: "Hard debugging, architecture, security-sensitive work and anything a Builder failed.",
  },
  { id: "slow", label: "Reviewer", meaning: "Checks a finished change with a stronger model." },
  {
    id: "vision",
    label: "Sees images",
    meaning:
      "Describes an attached image, or one a thread asks about, for a model that cannot read images. Empty, such images are refused. It needs a model that reads images on a connection that takes images from Octant, such as an agent runtime or an Ollama vision model.",
  },
  {
    id: "smol",
    label: "Small jobs",
    meaning: "Titles, summaries and shortening long threads. A small, fast model is enough.",
  },
];

export const ADVISOR_ROLE: ModelRolePresentation = {
  id: "advisor",
  label: "Advisor",
  meaning:
    "A second model reviews each turn and can pause the run for you. It costs one extra request per turn.",
};

export function rolePresentation(id: string): ModelRolePresentation {
  return (
    MODEL_ROLES.find((role) => role.id === id) ??
    (id === ADVISOR_ROLE.id ? ADVISOR_ROLE : { id, label: id, meaning: "A custom role." })
  );
}

/** What an empty role does, in the words its chooser shows. */
export function emptyRoleLabel(id: string): string {
  if (id === "default") return "Choose model";
  // The advisor and Sees images are off until chosen: the advisor costs a
  // request every turn, and the Builder may not read images at all. Every
  // other role borrows the Builder.
  if (id === "advisor" || id === "vision") return "Off";
  return "Same as Builder";
}

/** A role with no models is not configured; its flags go with it. */
export function slotWithCandidates(
  id: string,
  saved: NativeHarnessSlot | undefined,
  candidates: ReadonlyArray<NativeHarnessSlotCandidate>,
): NativeHarnessSlot | undefined {
  if (candidates.length === 0) return undefined;
  const base: NativeHarnessSlot = saved ?? { id: id as NativeHarnessSlotId, candidates };
  return { ...base, candidates: candidates.slice(0, MAX_NATIVE_HARNESS_SLOT_CANDIDATES) };
}

export type RoleFlag = "askBeforeUsing" | "continueOnFallback";

/**
 * Stores a flag only when it differs from its default (Ask before using is off,
 * Continue on the fallback is on), so a role a person never touched stays as it
 * was saved.
 */
export function slotWithFlag(slot: NativeHarnessSlot, flag: RoleFlag, value: boolean) {
  const { askBeforeUsing, continueOnFallback, ...rest } = slot;
  const next = {
    askBeforeUsing: flag === "askBeforeUsing" ? value : askBeforeUsing,
    continueOnFallback: flag === "continueOnFallback" ? value : continueOnFallback,
  };
  return {
    ...rest,
    ...(next.askBeforeUsing === true ? { askBeforeUsing: true } : {}),
    ...(next.continueOnFallback === false ? { continueOnFallback: false } : {}),
  } satisfies NativeHarnessSlot;
}

export function slotWithReasoning(
  slot: NativeHarnessSlot,
  index: number,
  reasoning: string | undefined,
): NativeHarnessSlot {
  return {
    ...slot,
    candidates: slot.candidates.map((candidate, at) => {
      if (at !== index) return candidate;
      const { reasoning: _previous, ...rest } = candidate;
      return reasoning === undefined ? rest : { ...rest, reasoning };
    }),
  };
}

export function hasCandidate(
  candidates: ReadonlyArray<NativeHarnessSlotCandidate>,
  candidate: NativeHarnessSlotCandidate,
): boolean {
  const key = nativeHarnessSlotCandidateKey(candidate);
  return candidates.some((entry) => nativeHarnessSlotCandidateKey(entry) === key);
}

/** Said once on each page that shows the two flags, not under every role. */
export const ROLE_FLAGS_NOTE =
  "Ask before using and Continue on the fallback are saved with each role. Octant does not act on them yet; they take effect when coordinators start using roles.";

/**
 * The role as a suggestion would leave it. The person's flags stay (the saved
 * role is the base). A reasoning level the person set on a model stays with
 * that model; the suggestion's own hint goes in only when the row was empty.
 * A suggestion with no model changes nothing.
 */
export function slotFromSuggestion(
  id: string,
  saved: NativeHarnessSlot | undefined,
  suggestion: RoleSuggestion,
  hostId: string,
): NativeHarnessSlot | undefined {
  if (suggestion.picks.length === 0) return saved;
  const wasEmpty = (saved?.candidates.length ?? 0) === 0;
  const candidates = suggestion.picks.map((pick): NativeHarnessSlotCandidate => {
    const candidate = {
      hostId: hostId as never,
      providerInstanceId: pick.providerInstanceId as never,
      modelId: pick.modelId as never,
    };
    const kept = saved?.candidates.find(
      (entry) => nativeHarnessSlotCandidateKey(entry) === nativeHarnessSlotCandidateKey(candidate),
    )?.reasoning;
    const reasoning = wasEmpty ? pick.reasoning : kept;
    return reasoning === undefined ? candidate : { ...candidate, reasoning };
  });
  return slotWithCandidates(id, saved, candidates);
}
