import { describe, expect, it } from "vitest";
import {
  decodeCodeRepositoryTestDefinition,
  decodeCodeRepositoryTestDefinitionFile,
  decodeCodeRepositoryTestRun,
} from "./codeTestDefinitions";

const ids = {
  definition: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000001",
  thread: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
} as const;
const now = "2026-07-21T12:00:00.000Z";

const definition = {
  id: ids.definition,
  name: "Unit tests",
  source: {
    kind: "package-script",
    packagePath: "package.json",
    packageManager: "bun",
    script: "test:unit",
  },
  argv: ["bun", "run", "test:unit"],
  cwd: ".",
  environmentRefs: ["TEST_DATABASE_URL"],
  timeoutMs: 60_000,
  artifactPaths: ["artifacts/report.json"],
} as const;

describe("Code repository test definition contracts", () => {
  it("decodes selected package scripts as structured argv without a shell command", () => {
    expect(decodeCodeRepositoryTestDefinition(definition)).toEqual(definition);
    expect(() =>
      decodeCodeRepositoryTestDefinition({ ...definition, command: "bun run test:unit" }),
    ).toThrow();
    expect(() =>
      decodeCodeRepositoryTestDefinition({
        ...definition,
        argv: ["/bin/sh", "-c", "bun run test:unit"],
      }),
    ).toThrow();
    expect(() =>
      decodeCodeRepositoryTestDefinition({ ...definition, argv: ["bash", "-c", "echo unsafe"] }),
    ).toThrow();
  });

  it("decodes only strict .octant/tests.json definitions", () => {
    const file = {
      version: 1,
      tests: [
        {
          id: "lint",
          name: "Lint",
          argv: ["bun", "run", "lint"],
          cwd: ".",
          environmentRefs: [],
          timeoutMs: 120_000,
          artifactPaths: [],
        },
      ],
    } as const;
    expect(decodeCodeRepositoryTestDefinitionFile(file)).toEqual(file);
    expect(() =>
      decodeCodeRepositoryTestDefinitionFile({
        ...file,
        tests: [{ ...file.tests[0], command: "bun run lint" }],
      }),
    ).toThrow();
  });

  it("records bounded output, artifacts, provenance, checkout, posture, timing, and verdict", () => {
    const run = {
      id: ids.run,
      definition,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      checkoutRevision: "a".repeat(40),
      executionPolicy: "approval-gated",
      startedAt: now,
      completedAt: "2026-07-21T12:00:01.000Z",
      exitCode: 0,
      termination: "exited",
      stdout: { text: "ok\n", byteLength: 3, truncated: false },
      stderr: { text: "", byteLength: 0, truncated: false },
      artifacts: [{ path: "artifacts/report.json", byteLength: 42, status: "retained" }],
      verdict: "passed",
      concerns: [],
    } as const;
    expect(decodeCodeRepositoryTestRun(run)).toEqual(run);
    expect(() => decodeCodeRepositoryTestRun({ ...run, verdict: "running" })).toThrow();
    expect(() =>
      decodeCodeRepositoryTestRun({ ...run, stdout: { ...run.stdout, text: "x", byteLength: 3 } }),
    ).toThrow();

    expect(
      decodeCodeRepositoryTestRun({
        ...run,
        artifacts: [{ path: "artifacts/report.json", byteLength: 0, status: "unavailable" }],
        verdict: "inconclusive",
        concerns: ["artifact-read-unavailable"],
      }),
    ).toMatchObject({
      artifacts: [{ status: "unavailable" }],
      concerns: ["artifact-read-unavailable"],
    });
  });
});
