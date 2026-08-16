import { describe, expect, it } from "vitest";
import { TestDefinitionService } from "./testDefinitionService";

describe("TestDefinitionService", () => {
  it("resolves only an explicitly selected existing package script to package-manager argv", () => {
    const service = new TestDefinitionService();
    expect(
      service.fromPackageScript({
        id: "10000000-0000-4000-8000-000000000001" as never,
        packagePath: "packages/contracts/package.json",
        packageManager: "bun",
        script: "test:unit",
        packageJson: { scripts: { "test:unit": "vitest run --pool=forks" } },
        cwd: "packages/contracts",
        environmentRefs: ["TEST_DATABASE_URL"],
        timeoutMs: 60_000,
        artifactPaths: ["artifacts/report.json"],
      }),
    ).toMatchObject({
      source: { kind: "package-script", script: "test:unit" },
      argv: ["bun", "run", "test:unit"],
    });
    expect(() =>
      service.fromPackageScript({
        id: "10000000-0000-4000-8000-000000000001" as never,
        packagePath: "package.json",
        packageManager: "bun",
        script: "missing",
        packageJson: { scripts: { test: "vitest run" } },
        cwd: ".",
        environmentRefs: [],
        timeoutMs: 60_000,
        artifactPaths: [],
      }),
    ).toThrow("not available");
  });

  it("selects one strict definition from .octant/tests.json", () => {
    const service = new TestDefinitionService();
    expect(
      service.fromOctantFile({
        id: "10000000-0000-4000-8000-000000000001" as never,
        selectedId: "lint",
        file: {
          version: 1,
          tests: [
            {
              id: "lint",
              name: "Lint",
              argv: ["bun", "run", "lint"],
              cwd: ".",
              environmentRefs: [],
              timeoutMs: 60_000,
              artifactPaths: [],
            },
          ],
        },
      }),
    ).toMatchObject({
      source: { kind: "octant-file", selectedId: "lint" },
      argv: ["bun", "run", "lint"],
    });
  });
});
