import { decodeScaffoldEntry, type ScaffoldEntry } from "@octant/contracts/scaffolds";
import { describe, expect, it } from "vitest";
import { planScaffold, scaffoldRefusalText } from "./scaffoldPolicy";

const webApp: ScaffoldEntry = decodeScaffoldEntry({
  id: "web-app",
  displayName: "Web app",
  summary: "A browser app with a dev server and a build.",
  target: "web-app",
  generator: {
    kind: "pinned-package",
    runner: "bun",
    packageName: "create-vite",
    version: "8.0.2",
    presetArguments: ["--template", "react-ts"],
  },
  requiresTool: "bun",
  produces: ["package.json", "src/main.tsx"],
});

const nativeApp: ScaffoldEntry = decodeScaffoldEntry({
  id: "native-apple-app",
  displayName: "Native Apple app",
  summary: "A Swift package that builds with the Apple toolchain.",
  target: "native-apple-app",
  generator: {
    kind: "toolchain",
    tool: "swift",
    presetArguments: ["package", "init", "--type", "executable"],
  },
  requiresTool: "swift",
  produces: ["Package.swift"],
});

function facts(overrides: Partial<Parameters<typeof planScaffold>[0]> = {}) {
  return {
    entry: webApp,
    directoryName: "storefront",
    posture: "approval-gated" as const,
    availableTools: ["bun", "swift"],
    targetExists: false,
    ...overrides,
  };
}

describe("starting a project from a curated scaffold", () => {
  it("pins the generator version into the command it runs", () => {
    const plan = planScaffold(facts());

    expect(plan).toEqual({
      status: "planned",
      argv: ["bunx", "--bun", "create-vite@8.0.2", "storefront", "--template", "react-ts"],
      relativeCwd: ".",
      createsPath: "storefront",
      hostCreatesDirectory: false,
    });
  });

  it("runs a toolchain scaffold with the tool the machine already has", () => {
    const plan = planScaffold(facts({ entry: nativeApp, directoryName: "Widget" }));

    expect(plan).toEqual({
      status: "planned",
      argv: ["swift", "package", "init", "--type", "executable", "--name", "Widget"],
      // Swift initializes the directory it is standing in, so the host makes it.
      relativeCwd: "Widget",
      createsPath: "Widget",
      hostCreatesDirectory: true,
    });
  });

  it("refuses to write a project in Plan mode", () => {
    expect(planScaffold(facts({ posture: "plan" }))).toEqual({
      status: "refused",
      reason: "plan-mode-is-read-only",
    });
  });

  it("refuses a scaffold whose tool is not on this machine", () => {
    expect(planScaffold(facts({ entry: nativeApp, availableTools: ["bun"] }))).toEqual({
      status: "refused",
      reason: "tool-unavailable",
    });
  });

  it("refuses to write over something that is already there", () => {
    expect(planScaffold(facts({ targetExists: true }))).toEqual({
      status: "refused",
      reason: "directory-exists",
    });
  });

  it.each([".git", "..", "node_modules", ".hidden", "-rf", "nested/app", "up\\app"])(
    "refuses to create a project directory called %s",
    (directoryName) => {
      expect(planScaffold(facts({ directoryName }))).toEqual({
        status: "refused",
        reason: "directory-name-refused",
      });
    },
  );

  it("names the missing tool when it explains the refusal", () => {
    expect(scaffoldRefusalText("tool-unavailable", nativeApp)).toContain("swift");
  });
});
