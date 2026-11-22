import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFinishedReceiptId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeUtcTimestamp,
  type FinishedReceiptItem,
  type FinishedReceiptRecorded,
  type ReplayableRunCase,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { pickAgentModel } from "../packages/cli/src/agentThread";
import {
  buildAgentReplayArgs,
  formatReplayRunCasesReport,
  parseAgentReplayThreadId,
  parseReplayRunCasesCommand,
  runReplayCases,
  type ReplayCaseRunResult,
} from "./replay-run-cases";

const PROJECT_ID = decodeProjectId("11111111-1111-4111-8111-111111111111");
const PROVIDER_ID = decodeProviderInstanceId("22222222-2222-4222-8222-222222222222");
const MODEL_ID = decodeProviderModelId("claude-sonnet-4-5");

function makeReceipt(
  index: number,
  mode: "work" | "code",
  items: ReadonlyArray<FinishedReceiptItem>,
): FinishedReceiptRecorded {
  return {
    receiptId: decodeFinishedReceiptId(
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    ),
    threadId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
    mode,
    projectId: PROJECT_ID,
    summary: `Completed case ${String(index)}`,
    items,
    diff: { status: "observed", changedFiles: 1, insertions: 5, deletions: 1 },
    recordedAt: decodeUtcTimestamp("2026-11-19T12:00:00.000Z"),
  };
}

function makeCase(
  index: number,
  mode: "work" | "code",
  items: ReadonlyArray<FinishedReceiptItem>,
): ReplayableRunCase {
  const receipt = makeReceipt(index, mode, items);
  return {
    receiptId: receipt.receiptId,
    threadId: receipt.threadId,
    mode,
    request: `Solve task ${String(index)}`,
    project: { id: PROJECT_ID, name: "Octant" },
    model: { providerInstanceId: PROVIDER_ID, modelId: MODEL_ID },
    receipt,
    changedFileCount: 1,
    recordedAt: receipt.recordedAt,
  };
}

const ALL_PROVEN_ITEMS: ReadonlyArray<FinishedReceiptItem> = [
  { kind: "check", label: "bun run test", command: "bun run test", status: "proven", exitCode: 0 },
];

const MIXED_CLAIMED_ITEMS: ReadonlyArray<FinishedReceiptItem> = [
  { kind: "check", label: "bun run test", command: "bun run test", status: "proven", exitCode: 0 },
  { kind: "goal-criterion", label: "copy reads clearly", status: "claimed" },
];

describe("maintainer replayable run case script", () => {
  it("replays cases through an injected runner and prints the share whose receipt was all proven", async () => {
    const cases = [
      makeCase(1, "code", ALL_PROVEN_ITEMS),
      makeCase(2, "work", ALL_PROVEN_ITEMS),
      makeCase(3, "code", ALL_PROVEN_ITEMS),
    ];
    const seen: Array<{ readonly request: string; readonly modelOverride?: string | undefined }> =
      [];

    const outcomes: ReadonlyArray<ReplayCaseRunResult> = [
      {
        status: "completed",
        replayThreadId: "replay-1",
        receipt: makeReceipt(101, "code", ALL_PROVEN_ITEMS),
      },
      {
        status: "completed",
        replayThreadId: "replay-2",
        receipt: makeReceipt(102, "work", MIXED_CLAIMED_ITEMS),
      },
      { status: "failed", reason: "provider exited with code 1" },
    ];

    let index = 0;
    const report = await runReplayCases({
      cases,
      dryRun: false,
      modelOverride: "gpt-5.2",
      runner: async (runCase, options) => {
        seen.push({ request: runCase.request, modelOverride: options.modelOverride });
        const result = outcomes[index] ?? { status: "failed" as const, reason: "unexpected" };
        index += 1;
        return result;
      },
    });

    expect(seen).toEqual([
      { request: "Solve task 1", modelOverride: "gpt-5.2" },
      { request: "Solve task 2", modelOverride: "gpt-5.2" },
      { request: "Solve task 3", modelOverride: "gpt-5.2" },
    ]);
    expect(report.summary).toEqual({
      allProvenCount: 1,
      totalCount: 3,
      share: 1 / 3,
      formatted: "1/3 (33.3%) all proven",
    });

    const formatted = formatReplayRunCasesReport(report);
    expect(formatted).toContain("1/3 (33.3%) all proven");
    expect(formatted).toContain("all-proven");
    expect(formatted).toContain("not-all-proven");
    expect(formatted).toContain("failed");
  });

  it("summarizes stored baseline cases in dry-run mode without invoking any live runner", async () => {
    const cases = [
      makeCase(1, "code", ALL_PROVEN_ITEMS),
      makeCase(2, "work", MIXED_CLAIMED_ITEMS),
      makeCase(3, "code", ALL_PROVEN_ITEMS),
    ];
    let invoked = false;

    const report = await runReplayCases({
      cases,
      mode: "code",
      limit: 1,
      dryRun: true,
      runner: async () => {
        invoked = true;
        return { status: "failed", reason: "should not run in dry-run" };
      },
    });

    expect(invoked).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.summary.formatted).toBe("1/1 (100.0%) all proven");
    expect(formatReplayRunCasesReport(report)).toContain("dry-run");
    expect(formatReplayRunCasesReport(report)).toContain("1/1 (100.0%) all proven");
  });

  it("parses CLI flags and extracts the created thread id from octant agent JSON output", () => {
    expect(
      parseReplayRunCasesCommand([
        "--cases",
        "/tmp/cases.json",
        "--mode",
        "code",
        "--limit",
        "5",
        "--model",
        "gpt-5.2",
        "--dry-run",
        "--json",
      ]),
    ).toEqual({
      casesPath: "/tmp/cases.json",
      mode: "code",
      limit: 5,
      modelOverride: "gpt-5.2",
      dryRun: true,
      json: true,
    });
    expect(() => parseReplayRunCasesCommand(["--mode", "chat"])).toThrow(/--mode/);
    expect(() => parseReplayRunCasesCommand(["--limit", "0"])).toThrow(/--limit/);

    const output = [
      JSON.stringify({ kind: "thread", threadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      JSON.stringify({ kind: "outcome", outcome: "completed" }),
    ].join("\n");
    expect(parseAgentReplayThreadId(output)).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(parseAgentReplayThreadId("not json\n")).toBeUndefined();
  });

  it("is not wired into bun run test or bun run verify", () => {
    const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(rootPkg.scripts.test).not.toContain("replay-run-cases");
    expect(rootPkg.scripts.verify).not.toContain("replay-run-cases");
    expect(rootPkg.scripts["replay:run-cases"]).toBe("bun scripts/replay-run-cases.ts");
  });

  it("passes the resolved Project name (never the Project UUID) to octant agent --project and fails clearly when no name exists", () => {
    const runCase = makeCase(1, "code", ALL_PROVEN_ITEMS);

    // Prefers the current Project name from the target host over stale stored names.
    const renamed = buildAgentReplayArgs({
      runCase,
      hostProjects: [{ id: String(PROJECT_ID), name: "Octant Renamed" }],
    });
    expect(renamed.status).toBe("ready");
    if (renamed.status === "ready") {
      const projectFlagIndex = renamed.args.indexOf("--project");
      expect(projectFlagIndex).toBeGreaterThan(-1);
      expect(renamed.args[projectFlagIndex + 1]).toBe("Octant Renamed");
      expect(renamed.args).not.toContain(String(PROJECT_ID));
    }

    // Falls back to the stored Project name when the host list does not contain it.
    const fallback = buildAgentReplayArgs({ runCase });
    expect(fallback.status).toBe("ready");
    if (fallback.status === "ready") {
      const projectFlagIndex = fallback.args.indexOf("--project");
      expect(fallback.args[projectFlagIndex + 1]).toBe("Octant");
      expect(fallback.args).not.toContain(String(PROJECT_ID));
    }

    // Fails clearly rather than passing a Project UUID when no name is resolvable.
    const namelessCase: ReplayableRunCase = {
      ...runCase,
      project: { id: PROJECT_ID },
    };
    const missing = buildAgentReplayArgs({ runCase: namelessCase, hostProjects: [] });
    expect(missing.status).toBe("failed");
    if (missing.status === "failed") {
      expect(missing.reason).toContain("Project name");
    }

    // Refuses when two active Projects share a name (case- and trim-insensitive)
    // so octant agent --project cannot silently redirect replay to the first match.
    const secondProjectId = decodeProjectId("66666666-6666-4666-8666-666666666666");
    const targetSecondCase: ReplayableRunCase = {
      ...runCase,
      project: { id: secondProjectId, name: "Website" },
    };
    const duplicate = buildAgentReplayArgs({
      runCase: targetSecondCase,
      hostProjects: [
        { id: String(PROJECT_ID), name: "website" },
        { id: String(secondProjectId), name: " Website " },
      ],
    });
    expect(duplicate.status).toBe("failed");
    if (duplicate.status === "failed") {
      expect(duplicate.reason).toContain("multiple active Projects");
    }

    // Refuses when the stored Project name now belongs only to a different active Project.
    const hijacked = buildAgentReplayArgs({
      runCase: targetSecondCase,
      hostProjects: [{ id: String(PROJECT_ID), name: "Website" }],
    });
    expect(hijacked.status).toBe("failed");
    if (hijacked.status === "failed") {
      expect(hijacked.reason).toContain("different active Project");
    }
  });

  it("disambiguates duplicate model IDs across two endpoints using providerInstanceId", () => {
    const secondProviderId = decodeProviderInstanceId("55555555-5555-4555-8555-555555555555");
    const sharedModelId = decodeProviderModelId("gpt-5.2");
    const runCase: ReplayableRunCase = {
      ...makeCase(1, "code", ALL_PROVEN_ITEMS),
      model: { providerInstanceId: secondProviderId, modelId: sharedModelId },
    };
    const hostModels = [
      { instanceId: String(PROVIDER_ID), endpoint: "Personal OpenAI", modelId: "gpt-5.2" },
      { instanceId: String(secondProviderId), endpoint: "Work OpenAI", modelId: "gpt-5.2" },
    ] as const;

    // Bare model id would be ambiguous in pickAgentModel.
    expect(pickAgentModel(hostModels, "gpt-5.2")).toBeUndefined();

    const built = buildAgentReplayArgs({ runCase, hostModels });
    expect(built.status).toBe("ready");
    if (built.status === "ready") {
      const modelFlagIndex = built.args.indexOf("--model");
      expect(modelFlagIndex).toBeGreaterThan(-1);
      const selector = built.args[modelFlagIndex + 1];
      expect(selector).toBe("Work OpenAI/gpt-5.2");
      expect(pickAgentModel(hostModels, selector ?? "")?.instanceId).toBe(String(secondProviderId));
    }

    // Explicit --model override is forwarded verbatim.
    const overridden = buildAgentReplayArgs({
      runCase,
      hostModels,
      modelOverride: "Personal OpenAI/gpt-5.2",
    });
    expect(overridden.status).toBe("ready");
    if (overridden.status === "ready") {
      const modelFlagIndex = overridden.args.indexOf("--model");
      expect(overridden.args[modelFlagIndex + 1]).toBe("Personal OpenAI/gpt-5.2");
    }
  });
});
