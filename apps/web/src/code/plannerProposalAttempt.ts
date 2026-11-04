import { decodeCodeThreadId, type CodeThreadId, type CodePlannerView } from "@octant/contracts";

type Review = CodePlannerView["proposals"][number];
export interface PlannerAttemptStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}
type Attempt = { readonly threadId: CodeThreadId; readonly expectedVersion: number };
export type PlannerAttemptState =
  | { readonly status: "none" }
  | { readonly status: "blocked"; readonly threadId: CodeThreadId }
  | { readonly status: "unavailable" };

export function plannerAttemptStorage(): PlannerAttemptStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
const key = (review: Review) =>
  `octant:planner-attempt:${String(review.proposal.projectId)}:${String(review.proposal.id)}`;
function stored(
  review: Review,
  storage: PlannerAttemptStorage | undefined,
): Attempt | "unavailable" | undefined {
  if (storage === undefined) return "unavailable";
  try {
    const raw = storage.getItem(key(review));
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("threadId" in value) ||
      !("expectedVersion" in value) ||
      typeof value.expectedVersion !== "number" ||
      !Number.isSafeInteger(value.expectedVersion) ||
      value.expectedVersion < 0
    )
      return "unavailable";
    return { threadId: decodeCodeThreadId(value.threadId), expectedVersion: value.expectedVersion };
  } catch {
    return "unavailable";
  }
}

/** Pending, missing task and declined are never proof that an earlier create ended. */
export function settlePlannerAttempt(review: Review, storage = plannerAttemptStorage()): void {
  const attempt = stored(review, storage);
  if (attempt === undefined || attempt === "unavailable") return;
  if (
    review.proposal.status !== "confirmed" &&
    !(
      review.proposal.creationAttempt?.status === "failed" &&
      Number(review.proposalVersion) > attempt.expectedVersion
    )
  )
    return;
  try {
    storage?.removeItem(key(review));
  } catch {
    /* Keeping the marker fails closed. */
  }
}

export function readPlannerAttempt(
  review: Review,
  storage = plannerAttemptStorage(),
): PlannerAttemptState {
  if (
    review.proposal.creationAttempt?.status === "creating" &&
    review.proposal.status === "pending"
  )
    return { status: "blocked", threadId: review.proposal.creationAttempt.threadId };
  const attempt = stored(review, storage);
  return attempt === "unavailable"
    ? { status: "unavailable" }
    : attempt === undefined
      ? { status: "none" }
      : { status: "blocked", threadId: attempt.threadId };
}

/** Write and read back before dispatch so remount/reload cannot replace an unknown attempt. */
export function reservePlannerAttempt(
  review: Review,
  threadId: CodeThreadId,
  storage = plannerAttemptStorage(),
): PlannerAttemptState {
  settlePlannerAttempt(review, storage);
  const current = readPlannerAttempt(review, storage);
  if (current.status !== "none") return current;
  if (storage === undefined) return { status: "unavailable" };
  try {
    const value = JSON.stringify({ threadId, expectedVersion: Number(review.proposalVersion) });
    storage.setItem(key(review), value);
    if (storage.getItem(key(review)) !== value) return { status: "unavailable" };
    return { status: "none" };
  } catch {
    return { status: "unavailable" };
  }
}

export function finishPlannerAttempt(review: Review, storage = plannerAttemptStorage()): void {
  try {
    storage?.removeItem(key(review));
  } catch {
    /* A confirmed proposal remains inspectable. */
  }
}
