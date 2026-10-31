import { describe, expect, it } from "vitest";
import { resolvePluginCliCommand, runPluginCliCommand } from "./pluginCommand";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";

const extensionId = "17000000-0000-4000-8000-000000000001";
const packageId = "17000000-0000-4000-8000-000000000002";
const digest = `sha256:${"e".repeat(64)}`;
const npm = {
  packageName: "@example/demo",
  version: "1.0.0",
  registry: "https://registry.example.test",
  integrity: `sha512-${"C".repeat(86)}==`,
};

const inspected = {
  kind: "package-inspected",
  preview: {
    entry: {
      extensionId,
      packageId,
      slug: "demo",
      displayName: "Demo",
      version: "1.0.0",
      digest,
      source: { kind: "plugin-package", sourceRef: "npm:abc" },
    },
    review: {
      provenance: { publisher: "Example", reviewed: false, npm },
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
      declaredCapabilities: ["instructions"],
      components: [
        {
          id: "skill-demo",
          kind: "skill-instructions",
          displayName: "demo",
          declaredCapabilities: ["instructions"],
        },
      ],
    },
    diagnostics: [],
  },
};

function session(answer: (request: LocalControlRequest) => LocalControlResponse) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    sent,
    out,
    err,
    input: {
      session: {
        kind: "opened" as const,
        windowId: "11111111-1111-4111-8111-111111111111",
        send: async (request: LocalControlRequest) => {
          sent.push(request);
          return answer(request);
        },
        close: async () => undefined,
      },
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
    },
  };
}

describe("resolvePluginCliCommand", () => {
  it.each([
    [["install", "npm:demo"], { action: "install", packageName: "demo" }],
    [["install", "npm:@example/demo"], { action: "install", packageName: "@example/demo" }],
    [
      ["install", "npm:@example/demo@^1.2.0"],
      { action: "install", packageName: "@example/demo", range: "^1.2.0" },
    ],
    [["install", "npm:demo@beta"], { action: "install", packageName: "demo", range: "beta" }],
    [["check-update", "@example/demo"], { action: "check-update", packageName: "@example/demo" }],
  ])("reads %j", (positional, expected) => {
    expect(resolvePluginCliCommand(positional, {})).toEqual(expected);
  });

  it("refuses anything that is not an npm install or an update check", () => {
    expect(resolvePluginCliCommand(["install", "demo"], {})).toBeUndefined();
    expect(resolvePluginCliCommand(["install", "npm:demo@"], {})).toBeUndefined();
    expect(resolvePluginCliCommand(["install", "npm:demo", "extra"], {})).toBeUndefined();
    expect(resolvePluginCliCommand(["install", "npm:demo"], { registry: "x" })).toBeUndefined();
    expect(resolvePluginCliCommand(["enable", "demo"], {})).toBeUndefined();
  });
});

describe("runPluginCliCommand", () => {
  it("looks the package up, prints what the host found, and installs that exact version", async () => {
    const context = session((request) => ({
      status: 200,
      body:
        request.path === "/api/extensions/npm"
          ? inspected
          : {
              kind: "extension-state-updated",
              snapshot: {
                sequence: 1,
                snapshotAt: "2026-10-31T12:00:00.000Z",
                packages: [],
                collisions: [],
              },
            },
    }));

    const code = await runPluginCliCommand({
      ...context.input,
      command: { action: "install", packageName: "@example/demo", range: "^1.0.0" },
    });

    expect(code).toBe(0);
    expect(
      context.sent.map((request) => [request.path, (request.body as { kind: string }).kind]),
    ).toEqual([
      ["/api/extensions/npm", "resolve-npm-package"],
      ["/api/extensions/lifecycle", "install-package"],
    ]);
    expect(context.sent[0]?.body).toEqual({
      kind: "resolve-npm-package",
      packageName: "@example/demo",
      range: "^1.0.0",
    });
    expect(context.sent[1]?.body).toEqual({
      kind: "install-package",
      extensionId,
      packageId,
      version: "1.0.0",
      digest,
    });
    const text = context.out.join("");
    expect(text).toContain("@example/demo@1.0.0");
    expect(text).toContain(npm.integrity);
    expect(text).toContain("untrusted and switched off");
  });

  it("installs nothing when the lookup is refused, and prints the host's sentence", async () => {
    const context = session(() => ({
      status: 200,
      body: {
        kind: "extension-command-failed",
        failure: {
          category: "invalid",
          message:
            "The download does not match the integrity the registry published. Octant discarded it and installed nothing.",
        },
      },
    }));

    const code = await runPluginCliCommand({
      ...context.input,
      command: { action: "install", packageName: "demo" },
    });

    expect(code).toBe(1);
    expect(context.sent).toHaveLength(1);
    expect(context.err.join("")).toContain("does not match the integrity");
  });

  it("checks an installed npm package for an update and installs nothing", async () => {
    const context = session((request) =>
      request.path === "/api/extensions/snapshot"
        ? {
            status: 200,
            body: {
              sequence: 1,
              snapshotAt: "2026-10-31T12:00:00.000Z",
              collisions: [],
              packages: [
                {
                  extensionId,
                  packageId,
                  slug: "demo",
                  displayName: "Demo",
                  stateVersion: 1,
                  version: "1.0.0",
                  digest,
                  source: { kind: "plugin-package", sourceRef: "npm:abc" },
                  npm,
                  compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
                  activation: {
                    installed: true,
                    trusted: false,
                    pluginDesired: false,
                    componentDesired: false,
                    compatible: true,
                    policyAllowed: true,
                    quarantined: false,
                    draining: false,
                    broken: false,
                    unavailable: false,
                    interrupted: false,
                    waiting: false,
                  },
                  components: [],
                  diagnostics: [],
                },
              ],
            },
          }
        : {
            status: 200,
            body: {
              kind: "npm-update-checked",
              extensionId,
              installedVersion: "1.0.0",
              available: "1.1.0",
            },
          },
    );

    const code = await runPluginCliCommand({
      ...context.input,
      command: { action: "check-update", packageName: "@example/demo" },
    });

    expect(code).toBe(0);
    expect(context.out.join("")).toContain("1.1.0 is available");
    expect(context.out.join("")).toContain("Nothing was installed");
    expect(context.sent.map((request) => request.path)).toEqual([
      "/api/extensions/snapshot",
      "/api/extensions/npm",
    ]);
  });
});
