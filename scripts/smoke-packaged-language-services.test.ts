import { describe, expect, it } from "vitest";
import { decodeCodeLanguageReadResult } from "@octant/contracts/code-language";
import { languageScenarioFailures, packagedServerLaunch } from "./smoke-packaged-language-services";

const scope = {
  threadId: "20000000-0000-4000-8000-000000000001",
  checkoutId: "30000000-0000-4000-8000-000000000001",
  fileId: "50000000-0000-4000-8000-000000000001",
};

const typeError = {
  path: "b.ts",
  range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } },
  severity: "error",
  message: "Type 'string' is not assignable to type 'number'.",
  source: "typescript",
};

const served = {
  diagnostics: decodeCodeLanguageReadResult({
    status: "diagnostics",
    ...scope,
    diagnostics: [typeError],
    truncated: false,
  }),
  definition: decodeCodeLanguageReadResult({
    status: "definition",
    ...scope,
    targets: [
      {
        kind: "checkout-location",
        path: "a.ts",
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
      },
    ],
  }),
  library: decodeCodeLanguageReadResult({
    status: "definition",
    ...scope,
    targets: [{ kind: "outside-checkout", label: "bundled-library" }],
  }),
};

describe("packaged language services smoke", () => {
  it("passes a package that served the type error, the cross-file jump, and the bundled library", () => {
    expect(languageScenarioFailures(served)).toEqual([]);
  });

  it("fails a package whose language server could not find its standard library", () => {
    // The realistic failure of a package that dropped lib.*.d.ts: the type
    // error is still there, among errors for every missing global type.
    const failures = languageScenarioFailures({
      ...served,
      diagnostics: decodeCodeLanguageReadResult({
        status: "diagnostics",
        ...scope,
        diagnostics: [
          {
            ...typeError,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            message: "Cannot find global type 'Array'.",
          },
          typeError,
        ],
        truncated: false,
      }),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("Cannot find global type 'Array'.");
  });

  it("fails a package whose language server was refused or never answered", () => {
    expect(
      languageScenarioFailures({
        diagnostics: { status: "refused", reason: "no-language-server" },
        definition: { status: "unavailable", reason: "starting" },
        library: { status: "unavailable", reason: "crashed" },
      }),
    ).toEqual([
      "diagnostics read answered refused (no-language-server)",
      "definition read answered unavailable (starting)",
      "standard-library definition read answered unavailable (crashed)",
    ]);
  });

  it("starts each package's own server and finds the language server inside that package", () => {
    expect(
      packagedServerLaunch(
        { kind: "desktop", platform: "darwin", root: "/tmp/x/Octant.app" },
        { platform: "darwin", arch: "arm64" },
        "/bin/bun",
      ),
    ).toEqual({
      executable: "/tmp/x/Octant.app/Contents/MacOS/Octant",
      args: ["/tmp/x/Octant.app/Contents/Resources/app/apps/server/dist/main.mjs"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      languageServerPackage:
        "/tmp/x/Octant.app/Contents/Resources/app/apps/server/node_modules/@typescript/typescript-darwin-arm64",
    });
    expect(
      packagedServerLaunch(
        { kind: "desktop", platform: "linux", root: "/tmp/x/Octant-linux-x64" },
        { platform: "linux", arch: "x64" },
        "/bin/bun",
      ),
    ).toMatchObject({
      executable: "/tmp/x/Octant-linux-x64/Octant",
      args: ["/tmp/x/Octant-linux-x64/resources/app/apps/server/dist/main.mjs"],
      languageServerPackage:
        "/tmp/x/Octant-linux-x64/resources/app/apps/server/node_modules/@typescript/typescript-linux-x64",
    });
    expect(
      packagedServerLaunch(
        { kind: "headless", root: "/tmp/x/octant-0.0.0-dev-linux-x64" },
        { platform: "linux", arch: "x64" },
        "/bin/bun",
      ),
    ).toMatchObject({
      executable: "/bin/bun",
      args: ["/tmp/x/octant-0.0.0-dev-linux-x64/lib/server/main.mjs"],
      env: { OCTANT_ARTIFACT_ROOT: "/tmp/x/octant-0.0.0-dev-linux-x64" },
      languageServerPackage:
        "/tmp/x/octant-0.0.0-dev-linux-x64/node_modules/@typescript/typescript-linux-x64",
    });
  });
});
