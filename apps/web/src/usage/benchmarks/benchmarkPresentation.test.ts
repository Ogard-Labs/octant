import { describe, expect, it } from "vitest";
import {
  decodeBenchmarkSuite,
  decodeBenchmarkSuiteSaveRequest,
  type BenchmarkSuite,
} from "@octant/contracts";
import {
  draftToSaveRequest,
  exportSuiteJson,
  importSuiteJson,
  nameForImportedSuite,
  suiteToDraft,
} from "./benchmarkPresentation";

const now = "2026-11-07T12:00:00.000Z";
const id = (n: number) => `78000000-0000-4000-8000-00000000000${n}`;

function richSuite(): BenchmarkSuite {
  return decodeBenchmarkSuite({
    suiteId: id(1),
    revision: 3,
    name: "Everything",
    description: "Every check kind.",
    cases: [
      {
        caseId: id(2),
        kind: "prompt",
        title: "Prompt case",
        prompt: "Answer in JSON.",
        referenceAnswer: "{}",
        rubric: "Short.",
        checks: [
          { kind: "contains", text: "x", caseSensitive: true },
          { kind: "not-contains", text: "y", caseSensitive: false },
          { kind: "matches", pattern: "^a+$", flags: "im" },
          { kind: "equals", text: "z", trim: false },
          { kind: "valid-json" },
        ],
      },
      {
        caseId: id(3),
        kind: "code",
        title: "Code case",
        prompt: "Fix the bug.",
        code: { codeProjectId: id(4), ref: "main" },
        checks: [
          { kind: "command-exits-zero", command: "bun test", timeoutSeconds: 120 },
          { kind: "max-files-changed", count: 3 },
        ],
      },
    ],
    judge: { providerInstanceId: id(5), modelId: "judge-model", rubric: "Be strict." },
    createdAt: now,
    updatedAt: now,
  });
}

function savedCases(suite: BenchmarkSuite) {
  const result = draftToSaveRequest(suiteToDraft(suite));
  if (result.status !== "ok") throw new Error(result.message);
  return result.request;
}

describe("a suite through the editor and back", () => {
  it("saves exactly the cases it was opened with", () => {
    const suite = richSuite();
    const request = savedCases(suite);
    expect(request.cases).toEqual(suite.cases);
    expect(request.judge).toEqual(suite.judge);
    expect(request.expectedRevision).toBe(3);
    expect(() => decodeBenchmarkSuiteSaveRequest(request)).not.toThrow();
  });

  it("imports its own export as the same cases under new ids", () => {
    const suite = richSuite();
    const imported = importSuiteJson(exportSuiteJson(suite));
    if (imported.status !== "ok") throw new Error(imported.message);
    const result = draftToSaveRequest(imported.draft);
    if (result.status !== "ok") throw new Error(result.message);

    const withoutIds = (cases: BenchmarkSuite["cases"]) =>
      cases.map(({ caseId: _caseId, ...rest }) => rest);
    expect(withoutIds(result.request.cases)).toEqual(withoutIds(suite.cases));
    expect(result.request.suiteId).not.toBe(suite.suiteId);
    expect(result.request).not.toHaveProperty("expectedRevision");
    expect(result.request.cases.map((c) => c.caseId)).not.toContain(suite.cases[0]?.caseId);
  });

  it("drops the whitespace a text box leaves around a prompt or a check", () => {
    const draft = suiteToDraft(richSuite());
    const [first, ...rest] = draft.cases;
    if (first === undefined) throw new Error("no case");
    const result = draftToSaveRequest({
      ...draft,
      cases: [
        {
          ...first,
          prompt: "Answer in JSON.\n",
          checks: first.checks.map((check) =>
            check.kind === "contains" ? { ...check, text: " x " } : check,
          ),
        },
        ...rest,
      ],
    });
    if (result.status !== "ok") throw new Error(result.message);
    expect(result.request.cases[0]?.prompt).toBe("Answer in JSON.");
    expect(result.request.cases[0]?.checks[0]).toMatchObject({ kind: "contains", text: "x" });
  });

  it("refuses an exact-match text with surrounding spaces instead of trimming it", () => {
    const draft = suiteToDraft(richSuite());
    const [first, ...rest] = draft.cases;
    if (first === undefined) throw new Error("no case");
    const withEquals = (trim: boolean) =>
      draftToSaveRequest({
        ...draft,
        cases: [
          {
            ...first,
            checks: first.checks.map((check) =>
              check.kind === "equals" ? { ...check, text: " z ", trim } : check,
            ),
          },
          ...rest,
        ],
      });

    const refused = withEquals(false);
    expect(refused).toMatchObject({ status: "invalid" });
    expect(refused.status === "invalid" ? refused.message : "").toMatch(
      /surrounding spaces can't be matched exactly/,
    );

    const trimmed = withEquals(true);
    if (trimmed.status !== "ok") throw new Error(trimmed.message);
    expect(trimmed.request.cases[0]?.checks[3]).toMatchObject({
      kind: "equals",
      text: "z",
      trim: true,
    });
  });
});

describe("naming an imported suite", () => {
  it("keeps a name no suite has", () => {
    expect(nameForImportedSuite("Capitals", ["Other"])).toBe("Capitals");
  });

  it("marks a copy of an existing suite, then numbers further copies", () => {
    expect(nameForImportedSuite("Capitals", ["Capitals"])).toBe("Capitals (imported)");
    expect(nameForImportedSuite("Capitals", ["Capitals", "Capitals (imported)"])).toBe(
      "Capitals (imported 2)",
    );
    expect(
      nameForImportedSuite("Capitals", [
        "Capitals",
        "Capitals (imported)",
        "Capitals (imported 2)",
      ]),
    ).toBe("Capitals (imported 3)");
  });

  it("shortens the base so the copy still fits the 80-character name limit", () => {
    const name = "x".repeat(80);
    const copy = nameForImportedSuite(name, [name]);
    expect(copy).toHaveLength(80);
    expect(copy.endsWith(" (imported)")).toBe(true);
    const second = nameForImportedSuite(name, [name, copy]);
    expect(second).toHaveLength(80);
    expect(second.endsWith(" (imported 2)")).toBe(true);
  });
});
