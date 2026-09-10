export interface CommitGraphEdge {
  readonly fromLane: number;
  readonly toLane: number;
  readonly from: number;
  readonly to: number;
}
export interface CommitGraphRow {
  readonly lane: number;
  readonly width: number;
  readonly edges: ReadonlyArray<CommitGraphEdge>;
}

/** Parent identities occupy stable lanes; appending older commits never moves an earlier node. */
export function layoutCommitGraph(
  commits: ReadonlyArray<{ readonly oid: string; readonly parents: ReadonlyArray<string> }>,
): ReadonlyArray<CommitGraphRow> {
  const lanes: Array<string | undefined> = [];
  return commits.map((commit) => {
    const incoming = lanes.indexOf(commit.oid);
    let lane = incoming;
    if (lane < 0) {
      lane = lanes.indexOf(undefined);
      if (lane < 0) lane = lanes.length;
    }
    const edges: CommitGraphEdge[] = [];
    for (let index = 0; index < lanes.length; index++) {
      if (lanes[index] === undefined) continue;
      edges.push({ fromLane: index, toLane: index, from: 0, to: index === incoming ? 0.5 : 1 });
    }
    lanes[lane] = undefined;
    for (const [index, parent] of commit.parents.entries()) {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = index === 0 ? lane : lanes.indexOf(undefined);
        if (target < 0) target = lanes.length;
        lanes[target] = parent;
      }
      edges.push({ fromLane: lane, toLane: target, from: 0.5, to: 1 });
    }
    const width = Math.max(lane + 1, lanes.length);
    while (lanes.length > 0 && lanes.at(-1) === undefined) lanes.pop();
    return { lane, width, edges };
  });
}
