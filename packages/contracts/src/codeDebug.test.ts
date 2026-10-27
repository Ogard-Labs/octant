import { describe, expect, it } from "vitest";
import {
  decodeCodeDebugConfiguration,
  decodeCodeDebugConfigurationProposal,
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
