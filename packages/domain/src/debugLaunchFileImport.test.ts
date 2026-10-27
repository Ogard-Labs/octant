import { describe, expect, it } from "vitest";
import type { CodeRelativePath } from "@octant/contracts/code";
import type { ExtensionComponentQualifiedId } from "@octant/contracts/extensions";
import {
  MAX_DEBUG_LAUNCH_FILE_PROPOSALS,
  proposeDebugConfigurations,
  type DebugLaunchFileImportContext,
} from "./debugLaunchFileImport";

const nodeAdapter = "10000000-0000-4000-8000-000000000001/adapter" as ExtensionComponentQualifiedId;
const otherNodeAdapter =
  "10000000-0000-4000-8000-000000000002/adapter" as ExtensionComponentQualifiedId;
const pythonAdapter =
  "10000000-0000-4000-8000-000000000003/adapter" as ExtensionComponentQualifiedId;

const context: DebugLaunchFileImportContext = {
  checkoutRoot: "/home/person/code/shop",
  currentFile: "src/routes/cart.ts" as CodeRelativePath,
  adapters: [
    { adapter: nodeAdapter, importTypes: ["node", "pwa-node"] },
    { adapter: pythonAdapter, importTypes: ["debugpy"] },
  ],
};

function propose(
  configurations: ReadonlyArray<unknown>,
  overrides: Partial<DebugLaunchFileImportContext> = {},
) {
  const reading = proposeDebugConfigurations(
    { version: "0.2.0", configurations },
    { ...context, ...overrides },
  );
  if (reading.status !== "read") throw new Error("The launch file was not read.");
  return reading.proposals;
}

function only(
  entry: Record<string, unknown>,
  overrides: Partial<DebugLaunchFileImportContext> = {},
) {
  const [proposal] = propose([entry], overrides);
  return proposal;
}

function launch(overrides: Record<string, unknown> = {}) {
  return {
    name: "Launch server",
    type: "node",
    request: "launch",
    program: "${workspaceFolder}/src/server.js",
    ...overrides,
  };
}

describe("debug launch file import", () => {
  it("maps a launch entry's six fields to a configuration and lists every field it does not use", () => {
    expect(
      only(
        launch({
          args: ["--port", "8080", "${workspaceFolder}/fixtures/seed.json"],
          cwd: "${workspaceFolder}/src",
          env: { NODE_ENV: "development", SHOP_NAME: "${workspaceFolderBasename}" },
          stopOnEntry: true,
          preLaunchTask: "npm: build",
          postDebugTask: "npm: clean",
          runtimeExecutable: "/opt/evil/node",
          envFile: "${workspaceFolder}/.env",
          console: "integratedTerminal",
          skipFiles: ["<node_internals>/**"],
        }),
      ),
    ).toEqual({
      status: "proposed",
      configuration: {
        name: "Launch server",
        adapter: nodeAdapter,
        program: "src/server.js",
        args: ["--port", "8080", "/home/person/code/shop/fixtures/seed.json"],
        cwd: "src",
        env: [
          { key: "NODE_ENV", value: "development" },
          { key: "SHOP_NAME", value: "shop" },
        ],
        stopOnEntry: true,
      },
      unusedFields: [
        "console",
        "envFile",
        "postDebugTask",
        "preLaunchTask",
        "runtimeExecutable",
        "skipFiles",
      ],
    });
  });

  it("runs from the checkout's root with no arguments, environment, or stop when the entry names none", () => {
    expect(only(launch({ program: "server.js", cwd: "${workspaceFolder}" }))).toEqual({
      status: "proposed",
      configuration: {
        name: "Launch server",
        adapter: nodeAdapter,
        program: "server.js",
        args: [],
        env: [],
        stopOnEntry: false,
      },
      unusedFields: [],
    });
  });

  it("resolves the current-file variables from the editor's open file", () => {
    const proposal = only(
      launch({
        program: "${file}",
        cwd: "${fileDirname}",
        args: ["${relativeFile}"],
      }),
    );
    expect(proposal).toMatchObject({
      status: "proposed",
      configuration: {
        program: "src/routes/cart.ts",
        cwd: "src/routes",
        args: ["src/routes/cart.ts"],
      },
    });
    const { currentFile: _currentFile, ...noFile } = context;
    expect(
      proposeDebugConfigurations({ configurations: [launch({ program: "${file}" })] }, noFile),
    ).toEqual({
      status: "read",
      proposals: [{ status: "unmappable", name: "Launch server", reason: "needs-open-file" }],
      truncated: false,
    });
  });

  it("refuses an entry that uses any variable outside the closed set, in any field", () => {
    for (const entry of [
      launch({ program: "${env:HOME}/server.js" }),
      launch({ args: ["${command:pickProcess}"] }),
      launch({ env: { TOKEN: "${input:token}" } }),
      launch({ cwd: "${config:shop.root}" }),
      launch({ program: "${userHome}/server.js" }),
      launch({ program: "${workspaceFolder:api}/server.js" }),
      launch({ program: "${workspaceFolder/server.js" }),
      // A field Octant does not use still says what the file wanted to run.
      launch({ runtimeExecutable: "${command:python.interpreterPath}" }),
    ]) {
      expect(only(entry)).toEqual({
        status: "unmappable",
        name: "Launch server",
        reason: "unsupported-variable",
      });
    }
  });

  it("refuses a program or folder that resolves outside the checkout", () => {
    for (const entry of [
      launch({ program: "${workspaceFolder}/../other/server.js" }),
      launch({ program: "/usr/bin/node" }),
      launch({ program: "/home/person/code/shop-admin/server.js" }),
      launch({ program: "../server.js" }),
      launch({ cwd: "${fileDirname}/../../.." }),
      launch({ cwd: "/tmp" }),
    ]) {
      expect(only(entry)).toEqual({
        status: "unmappable",
        name: "Launch server",
        reason: "outside-checkout",
      });
    }
    // An absolute path that names a file inside the checkout is that file.
    expect(only(launch({ program: "/home/person/code/shop/src/server.js" }))).toMatchObject({
      status: "proposed",
      configuration: { program: "src/server.js" },
    });
  });

  it("maps only launch entries whose type exactly one effective adapter imports", () => {
    expect(only(launch({ request: "attach", processId: "${command:pickProcess}" }))).toEqual({
      status: "unmappable",
      name: "Launch server",
      reason: "not-launch",
    });
    expect(only(launch({ request: undefined }))).toMatchObject({ reason: "not-launch" });
    expect(only(launch({ type: "cppdbg" }))).toMatchObject({ reason: "no-adapter" });
    expect(
      only(launch(), {
        adapters: [
          { adapter: nodeAdapter, importTypes: ["node"] },
          { adapter: otherNodeAdapter, importTypes: ["node"] },
        ],
      }),
    ).toMatchObject({ reason: "adapter-ambiguous" });
    expect(only(launch({ type: "debugpy", program: "main.py" }))).toMatchObject({
      status: "proposed",
      configuration: { adapter: pythonAdapter, program: "main.py" },
    });
  });

  it("refuses an entry whose mapped values are missing, mistyped, or outside the configuration's bounds", () => {
    for (const entry of [
      launch({ program: undefined }),
      launch({ program: "${workspaceFolder}" }),
      launch({ args: "--port 8080" }),
      launch({ env: { NODE_ENV: null } }),
      launch({ env: { OCTANT_CREDENTIAL_BROKER_TOKEN: "x" } }),
      launch({ env: { ANTHROPIC_API_KEY: "x" } }),
      launch({ stopOnEntry: "yes" }),
      launch({ args: Array.from({ length: 65 }, () => "a") }),
    ]) {
      expect(only(entry)).toEqual({
        status: "unmappable",
        name: "Launch server",
        reason: "invalid",
      });
    }
    expect(only(launch({ name: undefined }))).toEqual({ status: "unmappable", reason: "invalid" });
    expect(only("not an entry" as never)).toEqual({ status: "unmappable", reason: "invalid" });
  });

  it("reads only a launch file's configurations list and proposes a bounded number", () => {
    expect(proposeDebugConfigurations([], context)).toEqual({ status: "unreadable" });
    expect(proposeDebugConfigurations({ version: "0.2.0" }, context)).toEqual({
      status: "unreadable",
    });
    expect(proposeDebugConfigurations({ configurations: {} }, context)).toEqual({
      status: "unreadable",
    });
    const many = proposeDebugConfigurations(
      {
        configurations: Array.from({ length: MAX_DEBUG_LAUNCH_FILE_PROPOSALS + 1 }, (_, index) =>
          launch({ name: `Entry ${index}` }),
        ),
      },
      context,
    );
    expect(many.status === "read" ? [many.proposals.length, many.truncated] : undefined).toEqual([
      MAX_DEBUG_LAUNCH_FILE_PROPOSALS,
      true,
    ]);
  });
});
