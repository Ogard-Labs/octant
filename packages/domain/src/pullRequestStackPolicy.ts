import type { CodeProjectPullRequestRow, PullRequestStackPlace } from "@octant/contracts";

/** The facts a stack is read from: a cached row already carries all of them. */
export type StackablePullRequest = Pick<
  CodeProjectPullRequestRow,
  | "projectId"
  | "repositoryOwner"
  | "repositoryName"
  | "number"
  | "state"
  | "baseBranch"
  | "headBranch"
  | "crossRepository"
>;

function branchKey(row: StackablePullRequest, branch: string): string {
  // GitHub reads owner and name without case; a branch is exact.
  const repository = `${row.repositoryOwner}/${row.repositoryName}`.toLowerCase();
  return `${String(row.projectId)}:${repository}:${branch}`;
}

function groupedBy<Row>(
  rows: ReadonlyArray<Row>,
  keyOf: (row: Row) => string,
): ReadonlyMap<string, ReadonlyArray<Row>> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

/**
 * The stacks among the given pull requests, each bottom first: open pull
 * requests of one repository where each one's base is the head of the one
 * below it. The rows are the cached snapshot's, so nothing here asks the forge.
 *
 * A stack is one line, as a stack merge requires. A branch two open pull
 * requests share says nothing about which of them is below, and a pull request
 * that several are based on is usually a long-lived branch on its way to
 * another (development into main): linking those would make every feature a
 * layer of the release. A fork's head names a branch of another repository.
 */
export function derivePullRequestStacks<Row extends StackablePullRequest>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<ReadonlyArray<Row>> {
  const candidates = rows.filter((row) => row.state === "open" && row.crossRepository !== true);
  const byHead = groupedBy(candidates, (row) => branchKey(row, row.headBranch));
  const byBase = groupedBy(candidates, (row) => branchKey(row, row.baseBranch));
  const only = (group: ReadonlyArray<Row> | undefined): Row | undefined =>
    group?.length === 1 ? group[0] : undefined;
  const parentOf = (row: Row): Row | undefined => {
    const parent = only(byHead.get(branchKey(row, row.baseBranch)));
    if (parent === undefined) return undefined;
    return only(byBase.get(branchKey(parent, parent.headBranch))) === row ? parent : undefined;
  };
  const childOf = (row: Row): Row | undefined => {
    const child = only(byBase.get(branchKey(row, row.headBranch)));
    return child !== undefined && parentOf(child) === row ? child : undefined;
  };
  // Walking up from a row with no parent never enters a circle: every row of
  // one has a parent.
  return candidates.flatMap((row) => {
    if (parentOf(row) !== undefined) return [];
    const stack = [row];
    for (let above = childOf(row); above !== undefined; above = childOf(above)) stack.push(above);
    return stack.length > 1 ? [stack] : [];
  });
}

/** Each stacked row's place. A row of no stack has none. */
export function pullRequestStackPlaces<Row extends StackablePullRequest>(
  rows: ReadonlyArray<Row>,
): ReadonlyMap<Row, PullRequestStackPlace> {
  const places = new Map<Row, PullRequestStackPlace>();
  for (const stack of derivePullRequestStacks(rows)) {
    stack.forEach((row, index) => {
      const parent = stack[index - 1];
      places.set(row, {
        position: index + 1,
        size: stack.length,
        ...(parent === undefined ? {} : { parent: parent.number }),
      });
    });
  }
  return places;
}

/**
 * The same rows with each stack's layers together, bottom first, where the
 * first of them stood. Layers that are not in `rows` stay out.
 */
export function keepStacksTogether<Row>(
  rows: ReadonlyArray<Row>,
  stacks: ReadonlyArray<ReadonlyArray<Row>>,
): ReadonlyArray<Row> {
  const stackOf = new Map(stacks.flatMap((stack) => stack.map((row) => [row, stack] as const)));
  const shown = new Set(rows);
  const placed = new Set<Row>();
  return rows.flatMap((row) => {
    if (placed.has(row)) return [];
    const layers = (stackOf.get(row) ?? [row]).filter((layer) => shown.has(layer));
    for (const layer of layers) placed.add(layer);
    return layers;
  });
}
