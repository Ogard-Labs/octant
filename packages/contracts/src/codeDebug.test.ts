import { describe, expect, it } from "vitest";
import {
  decodeCodeDebugConfiguration,
  decodeCodeDebugConfigurationApproved,
  decodeCodeDebugConfigurationProposal,
  decodeCodeDebugSessionCall,
  decodeCodeDebugSessionEnded,
  decodeCodeDebugSessionResult,
  MAX_CODE_DEBUG_VALUE_LENGTH,
  HOST_CREDENTIAL_ENVIRONMENT_KEYS,
  MAX_CODE_DEBUG_ARGUMENTS,
  MAX_CODE_DEBUG_ENVIRONMENT_ENTRIES,
} from "./codeDebug";

const adapter = "10000000-0000-4000-8000-000000000001/adapter";

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    name: "Run the server",
    adapter,
    program: "src/server.js",
    args: ["--port", "8080"],
    cwd: "src",
    env: [{ key: "NODE_ENV", value: "development" }],
    stopOnEntry: false,
    ...overrides,
  };
}

describe("Code debug configuration contracts", () => {
  it("decodes a configuration whose program and folder are checkout-relative", () => {
    expect(decodeCodeDebugConfiguration(configuration())).toEqual(configuration());
    // Without a folder the program runs from the checkout's root.
    const { cwd: _cwd, ...atRoot } = configuration();
    expect(decodeCodeDebugConfiguration(atRoot)).toEqual(atRoot);
  });

  it("refuses a host path, an escape, or an unknown field", () => {
    for (const overrides of [
      { program: "/usr/bin/node" },
      { program: "../outside.js" },
      { program: "src/../../outside.js" },
      { cwd: "/tmp" },
      { cwd: "." },
      { request: "attach" },
      { preLaunchTask: "build" },
      { adapter: "node" },
      { name: "" },
      { name: "x".repeat(129) },
    ]) {
      expect(() => decodeCodeDebugConfiguration(configuration(overrides))).toThrow();
    }
  });

  it("bounds the arguments and the environment", () => {
    expect(() =>
      decodeCodeDebugConfiguration(
        configuration({ args: Array.from({ length: MAX_CODE_DEBUG_ARGUMENTS + 1 }, () => "a") }),
      ),
    ).toThrow();
    expect(() =>
      decodeCodeDebugConfiguration(configuration({ args: ["é".repeat(513)] })),
    ).toThrow();
    expect(() => decodeCodeDebugConfiguration(configuration({ args: ["a\0b"] }))).toThrow();
    expect(() =>
      decodeCodeDebugConfiguration(
        configuration({
          env: Array.from({ length: MAX_CODE_DEBUG_ENVIRONMENT_ENTRIES + 1 }, (_, index) => ({
            key: `KEY_${index}`,
            value: "1",
          })),
        }),
      ),
    ).toThrow();
    for (const env of [
      [{ key: "1BAD", value: "1" }],
      [{ key: "HAS-DASH", value: "1" }],
      [{ key: "LONG", value: "x".repeat(1_025) }],
      [
        { key: "TWICE", value: "1" },
        { key: "TWICE", value: "2" },
      ],
    ]) {
      expect(() => decodeCodeDebugConfiguration(configuration({ env }))).toThrow();
    }
  });

  it("refuses an environment entry that names Octant's own or a credential variable the host keeps from children", () => {
    for (const key of [
      "OCTANT_CREDENTIAL_BROKER_TOKEN",
      "OCTANT_ANYTHING",
      "octant_lowercase",
      // The GitHub CLI reads each of these as a token; the host keeps them from
      // the `gh` it runs, so a configuration may not name one either.
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "gh_token",
      ...HOST_CREDENTIAL_ENVIRONMENT_KEYS,
    ]) {
      expect(() =>
        decodeCodeDebugConfiguration(configuration({ env: [{ key, value: "typed" }] })),
      ).toThrow();
    }
    // A variable the person chooses for their own program is theirs.
    expect(
      decodeCodeDebugConfiguration(
        configuration({ env: [{ key: "DATABASE_PASSWORD", value: "local" }] }),
      ).env,
    ).toEqual([{ key: "DATABASE_PASSWORD", value: "local" }]);
  });

  it("decodes a proposal that lists the launch file's fields Octant does not use", () => {
    const proposal = {
      status: "proposed",
      configuration: configuration(),
      unusedFields: ["console", "preLaunchTask"],
    };
    expect(decodeCodeDebugConfigurationProposal(proposal)).toEqual(proposal);
    expect(
      decodeCodeDebugConfigurationProposal({
        status: "unmappable",
        name: "Attach",
        reason: "not-launch",
      }),
    ).toEqual({ status: "unmappable", name: "Attach", reason: "not-launch" });
    expect(() =>
      decodeCodeDebugConfigurationProposal({ status: "unmappable", reason: "looks-odd" }),
    ).toThrow();
  });
});

describe("Code debug session contracts", () => {
  const scope = {
    threadId: "20000000-0000-4000-8000-000000000001",
    checkoutId: "30000000-0000-4000-8000-000000000001",
    sessionId: "40000000-0000-4000-8000-000000000001",
  };

  it("decodes only the requests on Octant's closed list", () => {
    for (const request of [
      { kind: "state", afterOutput: 3 },
      { kind: "stack-trace", programThreadId: 1 },
      { kind: "variables", variablesReference: 1000 },
      { kind: "next", programThreadId: 1 },
      { kind: "evaluate", expression: "count", context: "repl" },
      { kind: "stop" },
    ]) {
      expect(decodeCodeDebugSessionCall({ ...scope, request }).request).toEqual(request);
    }
    for (const request of [
      { kind: "attach", processId: 4 },
      { kind: "restart" },
      { kind: "set-variable", variablesReference: 1, name: "x", value: "1" },
      { kind: "read-memory", memoryReference: "0x0" },
      // `evaluate` carries only what the person typed, in a context the panel has.
      { kind: "evaluate", expression: "count", context: "clipboard" },
      { kind: "evaluate", expression: "", context: "repl" },
      { kind: "source", path: "/etc/passwd" },
    ]) {
      expect(() => decodeCodeDebugSessionCall({ ...scope, request })).toThrow();
    }
  });

  it("bounds what a session answers and keeps host paths out of locations", () => {
    expect(() =>
      decodeCodeDebugSessionResult({
        status: "variables",
        variables: [
          {
            name: "big",
            value: "x".repeat(MAX_CODE_DEBUG_VALUE_LENGTH + 1),
            truncated: false,
            variablesReference: 0,
          },
        ],
        truncated: false,
      }),
    ).toThrow();
    expect(() =>
      decodeCodeDebugSessionResult({
        status: "stack",
        frames: [
          {
            id: 1,
            name: "main",
            location: { kind: "checkout", path: "/home/me/main.py", line: 1, column: 1 },
          },
        ],
        truncated: false,
      }),
    ).toThrow();
  });

  it("journals a confirmation with its configuration and a session with its end reason, and nothing it showed", () => {
    const approved = {
      approvalId: "50000000-0000-4000-8000-000000000001",
      projectId: "60000000-0000-4000-8000-000000000001",
      approvalClass: "shell-commands",
      configurationDigest: `sha256:${"a".repeat(64)}`,
      configuration: configuration(),
      adapter: {
        extensionId: "10000000-0000-4000-8000-000000000001",
        componentId: "adapter",
        packageDigest: `sha256:${"b".repeat(64)}`,
        lifecycleVersion: 2,
      },
      scope: { kind: "checkout", checkoutId: scope.checkoutId },
    };
    expect(decodeCodeDebugConfigurationApproved(approved)).toEqual(approved);
    const ended = {
      sessionId: scope.sessionId,
      projectId: approved.projectId,
      threadId: scope.threadId,
      configurationDigest: approved.configurationDigest,
      endReason: "program-exited",
    };
    expect(decodeCodeDebugSessionEnded(ended)).toEqual(ended);
    expect(() => decodeCodeDebugSessionEnded({ ...ended, output: "secret" })).toThrow();
  });
});
