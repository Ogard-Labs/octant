import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPackageExportMap,
  collectReferencedPaths,
  collectFiles,
  extractExportedNames,
  extractRuntimeSpecifiers,
  extractSpecifiers,
  findBarrelOnlyModules,
  findTypeOnlyReferencedModules,
  findUncalledEndpoints,
  findUnreachableModules,
  findUnregisteredRouteModules,
  hasRuntimeExport,
  KNOWN_ISLANDS,
  KNOWN_UNCALLED_ENDPOINTS,
  KNOWN_UNREGISTERED_ROUTES,
  type ScannedFile,
} from "./check-module-wiring";

const serverPath = "apps/server/src/server.ts";

function server(content: string): ScannedFile {
  return { path: serverPath, content };
}

describe("findUnregisteredRouteModules", () => {
  it("rejects a route module the server never imports", () => {
    const violations = findUnregisteredRouteModules([
      server(`import { createChatRouteHandler } from "./chatRoutes";`),
      { path: "apps/server/src/chatRoutes.ts", content: "export const a = 1;" },
      { path: "apps/server/src/goal/goalRoutes.ts", content: "export const b = 1;" },
    ]);

    expect(violations.map(({ path }) => path)).toEqual(["apps/server/src/goal/goalRoutes.ts"]);
  });

  it("accepts a route module registered through a nested relative specifier", () => {
    const violations = findUnregisteredRouteModules([
      server(`import { createGoalRouteHandler } from "./goal/goalRoutes";`),
      { path: "apps/server/src/goal/goalRoutes.ts", content: "export const b = 1;" },
    ]);

    expect(violations).toEqual([]);
  });

  it("ignores route test files", () => {
    const violations = findUnregisteredRouteModules([
      server(""),
      { path: "apps/server/src/goal/goalRoutes.test.ts", content: "" },
    ]);

    expect(violations).toEqual([]);
  });
});

describe("extractSpecifiers", () => {
  it("captures side-effect imports alongside named, dynamic, and require forms", () => {
    const specifiers = extractSpecifiers(
      [
        `import "./workImageAdapter";`,
        `import { a } from "./named";`,
        `const b = await import("./dynamic");`,
        `const c = require("./legacy");`,
      ].join("\n"),
    );

    expect(specifiers).toEqual(["./workImageAdapter", "./named", "./dynamic", "./legacy"]);
  });
});

describe("extractRuntimeSpecifiers", () => {
  it.each([
    ['import type { A } from "./m";', false],
    ['import type A from "./m";', false],
    ['import type * as ns from "./m";', false],
    ['import { type A } from "./m";', false],
    ['import { type A, type B } from "./m";', false],
    ['import {\n  type A,\n  type B,\n} from "./m";', false],
    ['export type { A } from "./m";', false],
    ['export type * from "./m";', false],
    ['import { type A, B } from "./m";', true],
    ['import {\n  type A,\n  B,\n} from "./m";', true],
    ['import A, { type B } from "./m";', true],
    ['import { A } from "./m";', true],
    ['import * as ns from "./m";', true],
    ['import "./m";', true],
    ['const m = await import("./m");', true],
    ['const m = require("./m");', true],
    ['export { A } from "./m";', true],
    ['export * from "./m";', true],
    // `type` is a contextual keyword: this imports a value that happens to be
    // named `type`, so erasing the statement would drop a runtime edge.
    ['import { type } from "./m";', true],
  ])("classifies %j as a runtime edge: %s", (source, isRuntime) => {
    expect(extractRuntimeSpecifiers(source as string)).toEqual(isRuntime ? ["./m"] : []);
  });

  it("keeps a module imported both ways in the runtime set", () => {
    expect(
      extractRuntimeSpecifiers(
        [`import type { A } from "./m";`, `import { b } from "./m";`].join("\n"),
      ),
    ).toEqual(["./m"]);
  });

  it("leaves every specifier extractSpecifiers sees when nothing is erased", () => {
    const source = [`import { a } from "./one";`, `import "./two";`].join("\n");

    expect(extractRuntimeSpecifiers(source)).toEqual(extractSpecifiers(source));
  });
});

describe("buildPackageExportMap", () => {
  it("maps a kebab-case exports subpath to the file it serves", () => {
    const map = buildPackageExportMap([
      {
        path: "packages/client-runtime/package.json",
        content: JSON.stringify({
          name: "@octant/client-runtime",
          exports: { "./preview-client": "./src/previewClient.ts" },
        }),
      },
    ]);

    expect(map.get("@octant/client-runtime/preview-client")).toBe(
      "packages/client-runtime/src/previewClient.ts",
    );
  });
});

describe("collectReferencedPaths", () => {
  it("resolves a kebab-case package specifier to its source file", () => {
    const referenced = collectReferencedPaths([
      {
        path: "packages/client-runtime/package.json",
        content: JSON.stringify({
          name: "@octant/client-runtime",
          exports: { "./preview-client": "./src/previewClient.ts" },
        }),
      },
      { path: "packages/client-runtime/src/previewClient.ts", content: "export const a = 1;" },
      {
        path: "apps/web/src/preview/usePreviewController.ts",
        content: `import { createPreviewClient } from "@octant/client-runtime/preview-client";`,
      },
    ]);

    expect(referenced.has("packages/client-runtime/src/previewClient.ts")).toBe(true);
  });

  it("counts an HTML script entry point as a reference", () => {
    const referenced = collectReferencedPaths([
      {
        path: "apps/web/canvas-browser-evidence.html",
        content: `<script type="module" src="/src/canvas/browserHarness.tsx"></script>`,
      },
      { path: "apps/web/src/canvas/browserHarness.tsx", content: "export const a = 1;" },
    ]);

    expect(referenced.has("apps/web/src/canvas/browserHarness.tsx")).toBe(true);
  });

  // Rule B's question is unchanged by Rule E: a type-only import is still an
  // edge, so the two rules report a module once each rather than both at once.
  it("still counts a type-only import as a reference", () => {
    const referenced = collectReferencedPaths([
      { path: "apps/web/src/goal/goalContract.ts", content: "export interface Goal {}" },
      {
        path: "apps/web/src/goal/GoalCard.tsx",
        content: `import type { Goal } from "./goalContract";`,
      },
    ]);

    expect(referenced.has("apps/web/src/goal/goalContract.ts")).toBe(true);
  });

  it("does not let a test import make a module reachable", () => {
    const referenced = collectReferencedPaths([
      { path: "apps/web/src/goal/GoalCard.tsx", content: "export const a = 1;" },
      {
        path: "apps/web/src/goal/GoalCard.test.tsx",
        content: `import { GoalCard } from "./GoalCard";`,
      },
    ]);

    expect(referenced.has("apps/web/src/goal/GoalCard.tsx")).toBe(false);
  });
});

describe("findUnreachableModules", () => {
  // A synthetic path keeps this case independent of KNOWN_ISLANDS, which would
  // otherwise suppress the violation as soon as the real module is exempted.
  it("reports a module that only its own test imports", () => {
    const violations = findUnreachableModules([
      { path: "apps/web/src/example/ExampleWidget.tsx", content: "export const a = 1;" },
      {
        path: "apps/web/src/example/ExampleWidget.test.tsx",
        content: `import { ExampleWidget } from "./ExampleWidget";`,
      },
    ]);

    expect(violations.map(({ path }) => path)).toEqual(["apps/web/src/example/ExampleWidget.tsx"]);
  });

  it("suppresses a module listed in KNOWN_ISLANDS", () => {
    const [exemptPath] = [...KNOWN_ISLANDS.keys()];
    const violations = findUnreachableModules([
      { path: exemptPath as string, content: "export const a = 1;" },
    ]);

    expect(violations).toEqual([]);
  });

  it("treats a side-effect import from product code as real reachability", () => {
    const violations = findUnreachableModules([
      {
        path: "apps/server/src/work/workMutationService.ts",
        content: `import "./workFormatAdapters";`,
      },
      {
        path: "apps/server/src/work/workFormatAdapters.ts",
        content: `import "./workImageAdapter";`,
      },
      { path: "apps/server/src/work/workImageAdapter.ts", content: "export const a = 1;" },
    ]);

    expect(violations.map(({ path }) => path)).not.toContain(
      "apps/server/src/work/workImageAdapter.ts",
    );
  });

  it("exempts test scaffolding and platform variants by shape", () => {
    const violations = findUnreachableModules([
      { path: "apps/server/src/preview/previewTestFixtures.ts", content: "export const a = 1;" },
      { path: "apps/web/src/context/contextFixtures.ts", content: "export const a = 1;" },
      { path: "apps/server/src/process/fakeSandboxConfinement.ts", content: "export const a = 1;" },
      {
        path: "apps/mobile/src/navigation/useMobileHardwareBack.web.ts",
        content: "export const a = 1;",
      },
      { path: "apps/desktop/src/preload.ts", content: "export const a = 1;" },
    ]);

    expect(violations).toEqual([]);
  });
});

describe("collectFiles", () => {
  it("ignores agent worktree fixtures while still finding a real island", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "octant-wiring-"));
    try {
      const fixturePath = resolve(
        root,
        ".agent-worktrees",
        "fixture",
        "packages",
        "domain",
        "src",
        "fixtureIsland.ts",
      );
      const realPath = resolve(root, "packages", "domain", "src", "realIsland.ts");
      await mkdir(resolve(fixturePath, ".."), { recursive: true });
      await mkdir(resolve(realPath, ".."), { recursive: true });
      await writeFile(fixturePath, "export const fixture = true;", "utf8");
      await writeFile(realPath, "export const real = true;", "utf8");

      const files = await collectFiles(root);

      expect(files.map(({ path }) => path)).not.toContain(
        ".agent-worktrees/fixture/packages/domain/src/fixtureIsland.ts",
      );
      expect(findUnreachableModules(files).map(({ path }) => path)).toContain(
        "packages/domain/src/realIsland.ts",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("findBarrelOnlyModules", () => {
  const barrel = {
    path: "packages/domain/src/index.ts",
    content: `export * from "./sharePolicy";\nexport * from "./usedPolicy";`,
  };

  it("reports a module the barrel re-exports that nothing uses", () => {
    const violations = findBarrelOnlyModules([
      barrel,
      {
        path: "packages/domain/src/sharePolicy.ts",
        content: "export function admitShare() {}",
      },
    ]);

    expect(violations.map(({ path }) => path)).toEqual(["packages/domain/src/sharePolicy.ts"]);
  });

  it("accepts a module whose export an app actually uses", () => {
    const violations = findBarrelOnlyModules([
      barrel,
      { path: "packages/domain/src/usedPolicy.ts", content: "export function admitThing() {}" },
      {
        path: "apps/server/src/thingService.ts",
        content: `import { admitThing } from "@octant/domain";\nadmitThing();`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does not let a test alone keep a barrel-only module alive", () => {
    const violations = findBarrelOnlyModules([
      barrel,
      { path: "packages/domain/src/sharePolicy.ts", content: "export function admitShare() {}" },
      {
        path: "packages/domain/src/sharePolicy.test.ts",
        content: `import { admitShare } from "./sharePolicy";\nadmitShare();`,
      },
    ]);

    expect(violations.map(({ path }) => path)).toEqual(["packages/domain/src/sharePolicy.ts"]);
  });

  it("ignores a module that exports no names, which is Rule B's question", () => {
    const violations = findBarrelOnlyModules([
      barrel,
      { path: "packages/domain/src/sideEffect.ts", content: `import "./registerAdapters";` },
    ]);

    expect(violations).toEqual([]);
  });

  it("suppresses a module listed in KNOWN_ISLANDS", () => {
    const exempt = [...KNOWN_ISLANDS.keys()].find((path) =>
      path.startsWith("packages/domain/src/"),
    ) as string;
    const violations = findBarrelOnlyModules([
      barrel,
      { path: exempt, content: "export function neverUsedAnywhere() {}" },
    ]);

    expect(violations).toEqual([]);
  });
});

describe("extractExportedNames", () => {
  it("names every exported declaration form", () => {
    expect(
      extractExportedNames(
        [
          "export function admit() {}",
          "export const LIMIT = 1;",
          "export class Store {}",
          "export interface Facts {}",
          "export type Scope = string;",
          "export declare const ambient: number;",
        ].join("\n"),
      ),
    ).toEqual(["admit", "LIMIT", "Store", "Facts", "Scope", "ambient"]);
  });
});

describe("hasRuntimeExport", () => {
  it.each([
    ["export function admit() {}", true],
    ["export async function admit() {}", true],
    ["export const LIMIT = 1;", true],
    ["export class Store {}", true],
    ["export abstract class Base {}", true],
    ["export enum Mode {\n  A,\n}", true],
    ["export default function Panel() {}", true],
    ['export * from "./m";', true],
    ["export { admit };", true],
    ["export { type A, admit };", true],
    // No exports at all: the module exists for its side effects, which only run
    // if something actually loads it.
    ['import "./registerAdapters";', true],
    ["export interface Facts {\n  readonly a: string;\n}", false],
    ["export type Scope = string;", false],
    ['export type { A } from "./m";', false],
    ["export { type A };", false],
    // Ambient: `declare` emits nothing, so it is not a runtime contribution.
    ["export declare const ambient: number;", false],
  ])("reads %j as exporting a runtime value: %s", (source, isRuntime) => {
    expect(hasRuntimeExport(source as string)).toBe(isRuntime);
  });
});

describe("findTypeOnlyReferencedModules", () => {
  const dialog = {
    path: "apps/web/src/example/ExampleDialog.tsx",
    content: 'export type Choice = "a" | "b";\nexport function ExampleDialog() {}',
  };
  const host = (content: string): ScannedFile => ({
    path: "apps/web/src/example/ExampleHost.tsx",
    content,
  });

  it("reports a runtime-exporting module whose only import is type-only", () => {
    const violations = findTypeOnlyReferencedModules([
      dialog,
      host(`import { type Choice } from "./ExampleDialog";`),
    ]);

    expect(violations.map(({ path }) => path)).toEqual([dialog.path]);
  });

  it("accepts a mixed import, which keeps the value binding at runtime", () => {
    const violations = findTypeOnlyReferencedModules([
      dialog,
      host(`import { type Choice, ExampleDialog } from "./ExampleDialog";`),
    ]);

    expect(violations).toEqual([]);
  });

  it("accepts a type-only import of a module that exports only types", () => {
    const violations = findTypeOnlyReferencedModules([
      { path: "apps/web/src/example/exampleContract.ts", content: "export interface Choice {}" },
      host(`import type { Choice } from "./exampleContract";`),
    ]);

    expect(violations).toEqual([]);
  });

  it("does not let a type-only re-export confer reachability", () => {
    const violations = findTypeOnlyReferencedModules([
      dialog,
      host(`export type { Choice } from "./ExampleDialog";`),
    ]);

    expect(violations.map(({ path }) => path)).toEqual([dialog.path]);
  });

  it("accepts a module a second non-test module imports for its value", () => {
    const violations = findTypeOnlyReferencedModules([
      dialog,
      host(`import type { Choice } from "./ExampleDialog";`),
      {
        path: "apps/web/src/example/ExampleRoute.tsx",
        content: `import { ExampleDialog } from "./ExampleDialog";`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("leaves a module with no reference at all to Rule B", () => {
    const violations = findTypeOnlyReferencedModules([dialog]);

    expect(violations).toEqual([]);
  });

  it("suppresses a module listed in KNOWN_ISLANDS", () => {
    const [exemptPath] = [...KNOWN_ISLANDS.keys()];
    const violations = findTypeOnlyReferencedModules([
      { path: exemptPath as string, content: "export function widget() {}" },
      host(`import type { Widget } from "../../../../${exemptPath as string}";`),
    ]);

    expect(violations).toEqual([]);
  });
});

describe("findUncalledEndpoints", () => {
  it("reports an endpoint the server answers but nothing calls", () => {
    const violations = findUncalledEndpoints([
      {
        path: "apps/server/src/exampleRoutes.ts",
        content: `if (url.pathname === "/api/example/orphan") return handle();`,
      },
    ]);

    expect(violations.map(({ path }) => path)).toEqual(["/api/example/orphan"]);
  });

  it("accepts an endpoint a client constructs", () => {
    const violations = findUncalledEndpoints([
      {
        path: "apps/server/src/exampleRoutes.ts",
        content: `if (url.pathname === "/api/example/used") return handle();`,
      },
      {
        path: "packages/client-runtime/src/exampleClient.ts",
        content: `new URL("/api/example/used", options.baseUrl)`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("treats a routing prefix as a guard rather than an endpoint", () => {
    const violations = findUncalledEndpoints([
      {
        path: "apps/server/src/exampleRoutes.ts",
        content: `if (!url.pathname.startsWith("/api/example/")) return undefined;`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("counts a caller that constructs a longer path under the endpoint", () => {
    const violations = findUncalledEndpoints([
      {
        path: "apps/server/src/exampleRoutes.ts",
        content: `if (url.pathname === "/api/example") return handle();`,
      },
      {
        path: "apps/web/src/example/useExample.ts",
        content: `fetch("/api/example/detail")`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("ignores test files on both sides", () => {
    const violations = findUncalledEndpoints([
      {
        path: "apps/server/src/exampleRoutes.test.ts",
        content: `await fetch("/api/example/test-only");`,
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("does not treat path strings in an unreachable island as served endpoints", () => {
    const island = [...KNOWN_ISLANDS.keys()].find((path) => path.startsWith("apps/server/src/"));
    if (island === undefined) {
      throw new Error("expected at least one server-tree island for this assertion");
    }
    const violations = findUncalledEndpoints([
      {
        path: island,
        content: `authenticatedFetch({ path: "/api/example/island-only" });`,
      },
    ]);

    expect(violations).toEqual([]);
  });
});

describe("wiring exemptions", () => {
  it("keeps known unregistered routes and uncalled endpoints empty", () => {
    expect([...KNOWN_UNREGISTERED_ROUTES.keys()]).toEqual([]);
    expect([...KNOWN_UNCALLED_ENDPOINTS.keys()]).toEqual([]);
  });

  it("states why each remaining island exists and when to remove it", () => {
    expect(KNOWN_ISLANDS.size).toBeGreaterThan(0);
    for (const reason of KNOWN_ISLANDS.values()) {
      expect(reason).toMatch(/Remove (once|when) /);
    }
  });

  it("does not exempt proven-live Canvas access logging or moved automation fallbacks", () => {
    expect(KNOWN_ISLANDS.has("packages/domain/src/canvasShareAccessLogPolicy.ts")).toBe(false);
    expect(KNOWN_ISLANDS.has("apps/server/src/automation/automationDispatchPort.ts")).toBe(false);
    expect(KNOWN_ISLANDS.has("apps/server/src/automation/automationModeDispatchPorts.ts")).toBe(
      false,
    );
    expect(KNOWN_ISLANDS.has("packages/domain/src/trackerReferencePolicy.ts")).toBe(false);
  });
});

describe("production launch wiring", () => {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

  it("injects the service policy store on every real desktop, server, and CLI launch path", async () => {
    const files = [
      "apps/desktop/src/main.ts",
      "apps/server/src/main.ts",
      "packages/cli/src/bin.ts",
      "packages/cli/src/web.ts",
      "packages/cli/src/hostLauncher.ts",
      "packages/cli/src/serverLifecycle.ts",
    ] as const;
    for (const relativePath of files) {
      const content = await readFile(resolve(repoRoot, relativePath), "utf8");
      expect(content).toMatch(/ServicePolicyStore/);
    }
  });
});
