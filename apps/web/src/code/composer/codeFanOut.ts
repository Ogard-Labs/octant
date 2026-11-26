import { branchNameTaken, type ModelPickerSelection } from "@octant/domain";

/**
 * One prompt started on several models, each in a thread and a new worktree of
 * its own: the chosen model and up to three more (maintainer decision D2,
 * 2026-11-26). Each start is an ordinary create the person sent, so one that
 * is refused leaves the others started.
 */
export const MAX_FAN_OUT_MODELS = 4;

/** What one start reached, as the create path reports it to a composer that stays. */
export type CodeDraftStartOutcome =
  | { readonly status: "started"; readonly threadId?: string }
  | { readonly status: "refused"; readonly reason: string; readonly threadId?: string };

export interface CodeFanOutResult {
  /** Absent for a start on the composer's own model when none was chosen. */
  readonly selection: ModelPickerSelection | undefined;
  readonly outcome: CodeDraftStartOutcome;
}

function sameModel(left: ModelPickerSelection, right: ModelPickerSelection): boolean {
  return (
    String(left.providerInstanceId) === String(right.providerInstanceId) &&
    String(left.modelId) === String(right.modelId)
  );
}

/** The models beside the chosen one after the person Shift-clicks `selection`. */
export function toggleFanOutModel(
  primary: ModelPickerSelection | undefined,
  extra: ReadonlyArray<ModelPickerSelection>,
  selection: ModelPickerSelection,
): ReadonlyArray<ModelPickerSelection> {
  if (primary !== undefined && sameModel(primary, selection)) return extra;
  if (extra.some((each) => sameModel(each, selection))) {
    return extra.filter((each) => !sameModel(each, selection));
  }
  if (extra.length + 1 >= MAX_FAN_OUT_MODELS) return extra;
  return [...extra, selection];
}

/**
 * The branch the `index`th thread's worktree gets. The first keeps the name
 * the composer showed; the others add their model, since the host refuses a
 * taken name rather than choosing another.
 */
export function fanOutBranch(
  base: string,
  selection: ModelPickerSelection | undefined,
  index: number,
  taken: ReadonlyArray<string>,
): string {
  if (index === 0) return base;
  const slug = String(selection?.modelId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const name = `${base}-${slug === "" ? String(index + 1) : slug}`;
  // Numbered as a derived name is, past every taken one.
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name}-${String(attempt)}`;
    if (!branchNameTaken(candidate, taken)) return candidate;
  }
  return `${name}-${String(index + 1)}`;
}

/**
 * Starts the prompt on each model in turn, one after another so their
 * worktrees are made one at a time, and reports what each start reached.
 */
export async function startEachModel(
  models: ReadonlyArray<ModelPickerSelection | undefined>,
  baseBranch: string,
  taken: ReadonlyArray<string>,
  start: (
    selection: ModelPickerSelection | undefined,
    branch: string,
  ) => Promise<CodeDraftStartOutcome>,
): Promise<ReadonlyArray<CodeFanOutResult>> {
  const results: Array<CodeFanOutResult> = [];
  const used: Array<string> = [];
  for (const [index, selection] of models.entries()) {
    const branch = fanOutBranch(baseBranch, selection, index, [...taken, ...used]);
    used.push(branch);
    let outcome: CodeDraftStartOutcome;
    try {
      outcome = await start(selection, branch);
    } catch (error) {
      outcome = {
        status: "refused",
        reason:
          error instanceof Error && error.message !== ""
            ? error.message
            : "The thread could not be started.",
      };
    }
    results.push({ selection, outcome });
  }
  return results;
}
