import { describe, expect, it } from "vitest";
import { findPathCollisions } from "./check-path-collisions";

function reasons(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return findPathCollisions(paths).map((collision) => `${collision.path}: ${collision.reason}`);
}

describe("findPathCollisions", () => {
  it("rejects a component and a model whose names differ only by their first letter's case", () => {
    // The break this gate exists for: on Linux these are two modules, and on the
    // Mac they ship to, `import "./RoutineCalendar"` reaches whichever the
    // resolver saw first.
    const collisions = findPathCollisions([
      "apps/web/src/automation/RoutineCalendar.tsx",
      "apps/web/src/automation/routineCalendar.ts",
    ]);

    expect(collisions.map(({ path }) => path)).toEqual([
      "apps/web/src/automation/RoutineCalendar.tsx",
    ]);
  });

  it("names both colliding paths so the message says what to rename", () => {
    const reported = reasons([
      "apps/web/src/automation/RoutineCalendar.tsx",
      "apps/web/src/automation/routineCalendar.ts",
    ]).join();

    expect(reported).toContain("apps/web/src/automation/RoutineCalendar.tsx");
    expect(reported).toContain("apps/web/src/automation/routineCalendar.ts");
  });

  it("rejects two paths that a checkout could not hold at once", () => {
    expect(reasons(["docs/Readme.md", "docs/readme.md"]).join()).toContain(
      "cannot both be checked out",
    );
  });

  it("accepts a module beside its own test suite", () => {
    expect(
      findPathCollisions([
        "scripts/check-path-collisions.ts",
        "scripts/check-path-collisions.test.ts",
      ]),
    ).toEqual([]);
  });

  it("accepts two files whose names differ only by extension", () => {
    // Ambiguous, but ambiguous the same way on every filesystem, so the Linux
    // build already reports whatever it does. This gate answers for what that
    // build cannot see.
    expect(
      findPathCollisions(["packages/theme/src/theme.ts", "packages/theme/src/theme.tsx"]),
    ).toEqual([]);
  });

  it("accepts the same file name under differently cased directories of its own", () => {
    expect(
      findPathCollisions(["apps/web/src/Zen/surface.ts", "apps/web/src/zen/other.ts"]),
    ).toEqual([]);
  });

  it("rejects a collision that comes from the directory rather than the file name", () => {
    expect(
      findPathCollisions(["apps/web/src/Zen/surface.ts", "apps/web/src/zen/surface.ts"]).map(
        ({ path }) => path,
      ),
    ).toEqual(["apps/web/src/Zen/surface.ts"]);
  });

  it("keeps an asset's extension part of its name", () => {
    // `logo.png` and `logo.svg` are referenced with their extensions, so neither
    // stands in for the other however the filesystem folds case.
    expect(findPathCollisions(["apps/web/public/logo.png", "apps/web/public/logo.svg"])).toEqual(
      [],
    );
  });

  it("reports every colliding path in a group of more than two", () => {
    const collisions = findPathCollisions([
      "apps/web/src/panel.ts",
      "apps/web/src/Panel.tsx",
      "apps/web/src/PANEL.js",
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions.map(({ reason }) => reason).join()).toContain(
      "apps/web/src/Panel.tsx, apps/web/src/PANEL.js",
    );
  });

  it("accepts a repository with nothing tracked", () => {
    expect(findPathCollisions([])).toEqual([]);
  });
});
