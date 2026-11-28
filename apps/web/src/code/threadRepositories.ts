import type { CodeCheckoutId, CodeThreadView } from "@octant/contracts/code";

export interface CodeRepositoryOption {
  readonly checkoutId: CodeCheckoutId;
  readonly label: string;
}

/**
 * Every Git repository checkout reachable from `view` for per-repository Diff,
 * Git, and pull-request actions.
 *
 * Plain-folder primaries have no Git repository of their own, so they are
 * omitted when linked repositories exist; single-repository threads yield at
 * most one entry and show no repository picker.
 */
export function reachableGitRepositoriesForThread(
  view: CodeThreadView,
  primaryLabel = "Main repository",
): ReadonlyArray<CodeRepositoryOption> {
  const options: CodeRepositoryOption[] = [];
  if (view.checkout.kind !== "plain-folder") {
    options.push({ checkoutId: view.checkout.id, label: primaryLabel });
  }
  for (const linked of view.thread.linkedCheckouts ?? []) {
    if (!options.some((existing) => String(existing.checkoutId) === String(linked.checkoutId))) {
      options.push({ checkoutId: linked.checkoutId, label: linked.label });
    }
  }
  return options;
}

/**
 * Default checkout to observe in Diff and Git: the primary checkout when it is
 * a Git repository, or the first linked repository when the primary is a plain
 * folder holding repositories.
 */
export function defaultGitCheckoutId(view: CodeThreadView): CodeCheckoutId {
  if (view.checkout.kind === "plain-folder") {
    const firstLinked = view.thread.linkedCheckouts?.[0];
    if (firstLinked !== undefined) return firstLinked.checkoutId;
  }
  return view.checkout.id;
}
