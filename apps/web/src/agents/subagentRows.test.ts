import { decodeAgentRunId } from "@octant/contracts/agent-run";
import { describe, expect, it } from "vitest";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import { observedChildFixture } from "./agentActivityFixtures";
import { buildSubagentRows, groupSubagentRows, nestSubagentRows } from "./subagentRows";

const PARENT_RUN = "22222222-2222-4222-8222-222222222222";
const PROVIDER = "55555555-5555-4555-8555-555555555555";

function run(
  runId: string,
  more: Partial<AgentHierarchyInputEntry> = {},
): AgentHierarchyInputEntry {
  return {
    runId,
    role: "research",
    task: `Task ${runId}`,
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    route: {
      requestedProviderInstanceId: PROVIDER,
      requestedModelId: "gpt-6-astra",
      executionProviderInstanceId: PROVIDER,
      executionModelId: "gpt-6-astra",
      poolDerived: false,
    },
    version: 1,
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...more,
  };
}

const providers = new Map([[PROVIDER, { driverKind: "codex", displayName: "Codex" }]]);

describe("buildSubagentRows", () => {
  it("lists both kinds as subagents, naming the provider and an unknown model honestly", () => {
    const rows = buildSubagentRows({
      entries: [run(PARENT_RUN)],
      observations: [observedChildFixture()],
      providers,
    });
    expect(rows.map((row) => [row.kind, row.providerName, row.model])).toEqual([
      ["octant-started", "Codex", "gpt-6-astra"],
      ["provider-started", "Codex", "Model unknown"],
    ]);
    expect(rows[1]?.driverKind).toBe("codex");
  });

  it("falls back to the instance id when the surface does not know the provider", () => {
    const [row] = buildSubagentRows({ entries: [], observations: [observedChildFixture()] });
    expect(row?.providerName).toBe(PROVIDER);
    expect(row?.driverKind).toBeUndefined();
  });

  it("nests a provider-started subagent under the run or observed child that started it", () => {
    const rows = buildSubagentRows({
      entries: [run(PARENT_RUN)],
      observations: [
        observedChildFixture({
          observationId: "first",
          childAgentId: "child-one",
          parentRunId: decodeAgentRunId(PARENT_RUN),
        }),
        observedChildFixture({
          observationId: "second",
          childAgentId: "child-two",
          parentChildAgentId: "child-one",
        }),
      ],
    });
    expect(rows.map((row) => [row.id, row.parentId, row.depth])).toEqual([
      [PARENT_RUN, undefined, 0],
      ["observation:first", PARENT_RUN, 1],
      ["observation:second", "observation:first", 2],
    ]);
  });

  it("keeps a subagent whose parent is not listed at top level instead of inventing one", () => {
    const [row] = buildSubagentRows({
      entries: [],
      observations: [
        observedChildFixture({
          parentRunId: decodeAgentRunId(PARENT_RUN),
          parentChildAgentId: "gone",
        }),
      ],
    });
    expect(row?.parentId).toBeUndefined();
    expect(row?.depth).toBe(0);
  });
});

describe("nestSubagentRows", () => {
  it("places each subagent after its parent, keeping sibling order", () => {
    const rows = [
      { id: "a" },
      { id: "b" },
      { id: "a1", parentId: "a" },
      { id: "elsewhere", parentId: "not-listed" },
    ];
    expect(nestSubagentRows(rows).map((row) => row.id)).toEqual(["a", "a1", "b", "elsewhere"]);
  });
});

describe("groupSubagentRows", () => {
  it("groups siblings sharing a compare label in host order and leaves a lone label as a row", () => {
    const rows = buildSubagentRows({
      entries: [
        run("a", { compareGroup: "plans" }),
        run("b"),
        run("c", { compareGroup: "plans" }),
        run("d", { compareGroup: "solo" }),
      ],
    });
    const items = groupSubagentRows(rows);
    expect(
      items.map((item) =>
        item.kind === "group"
          ? `${item.label}:${item.members.map((m) => m.id).join(",")}`
          : item.row.id,
      ),
    ).toEqual(["plans:a,c", "b", "d"]);
  });
});
