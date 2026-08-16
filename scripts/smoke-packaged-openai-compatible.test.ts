import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  OCTANT_KEYCHAIN_SERVICE,
  combineCompatibleSmokeFailures,
  compatibleProviderCommands,
  compatibleSmokeTurnRequests,
  createCompatibleSmokeIdentity,
  findSmokeOwnedProcess,
  keychainHelperInvocation,
  packagedCompatibleEnvironment,
  readCompatibleSmokeConfiguration,
  deriveReplacementCredential,
  assertStrictTurnEvidence,
  withCredentialLifecycle,
  type CompatibleSmokeProcess,
} from "./smoke-packaged-openai-compatible";

describe("packaged compatible smoke configuration", () => {
  it("keeps native Keychain evidence available without live endpoint inputs", () => {
    expect(readCompatibleSmokeConfiguration({})).toEqual({ kind: "native-only" });
  });

  it("rejects an enabled live gate with a sanitized exact missing-input list", () => {
    expect(() =>
      readCompatibleSmokeConfiguration({
        OCTANT_OPENAI_COMPATIBLE_SMOKE: "1",
        OCTANT_OPENAI_COMPATIBLE_API_KEY: "private-value",
      }),
    ).toThrow(
      "Packaged OpenAI-compatible smoke requires OCTANT_OPENAI_COMPATIBLE_BASE_URL and OCTANT_OPENAI_COMPATIBLE_MODEL; credential values are not logged.",
    );
  });

  it("returns live inputs only to the external harness", () => {
    expect(
      readCompatibleSmokeConfiguration({
        OCTANT_OPENAI_COMPATIBLE_SMOKE: "1",
        OCTANT_OPENAI_COMPATIBLE_BASE_URL: "https://compatible.example/v1",
        OCTANT_OPENAI_COMPATIBLE_API_KEY: "private-value",
        OCTANT_OPENAI_COMPATIBLE_MODEL: "fixture-model",
      }),
    ).toEqual({
      kind: "live",
      baseUrl: "https://compatible.example/v1",
      apiKey: "private-value",
      model: "fixture-model",
    });
  });

  it("configures the packaged server for both compatible protocols", () => {
    const commands = compatibleProviderCommands("80000000-0000-4000-8000-000000000551", {
      kind: "live",
      baseUrl: "https://compatible.example/v1",
      apiKey: "private-value",
      model: "fixture-model",
    });

    expect(commands.map((command) => command.kind)).toEqual([
      "create-openai-compatible-provider",
      "change-openai-compatible-configuration",
    ]);
    expect(commands.map((command) => command.configuration.protocol)).toEqual([
      "responses",
      "chat-completions",
    ]);
    expect(JSON.stringify(commands)).not.toContain("private-value");
  });

  it("uses packaged-server turn commands and has no source-tree test fallback", async () => {
    expect(compatibleSmokeTurnRequests("fixture-model")).toEqual([
      expect.objectContaining({ protocol: "responses", action: "complete" }),
      expect.objectContaining({ protocol: "responses", action: "cancel-after-output" }),
      expect.objectContaining({ protocol: "chat-completions", action: "complete" }),
      expect.objectContaining({ protocol: "chat-completions", action: "cancel-after-output" }),
    ]);
    const source = await readFile(
      new URL("./smoke-packaged-openai-compatible.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("/packaged-smoke-turn");
    expect(source).not.toContain("openAiCompatibleSmoke.integration.test");
    expect(source).not.toContain('["run", "--cwd", "apps/server", "test"');
  });
});

describe("packaged compatible native identity and helper protocol", () => {
  it("uses an isolated provider instance under the fixed Octant Keychain service", () => {
    const identity = createCompatibleSmokeIdentity(
      "80000000-0000-4000-8000-000000000551",
      "forced",
    );

    expect(identity).toEqual({
      dataDirectoryPrefix: "octant-compatible-forced.",
      providerInstanceId: "80000000-0000-4000-8000-000000000551",
      service: OCTANT_KEYCHAIN_SERVICE,
    });
  });

  it("passes a credential only through helper stdin", () => {
    const invocation = keychainHelperInvocation("/Applications/Octant/helper", {
      operation: "set",
      providerInstanceId: "80000000-0000-4000-8000-000000000551",
      credential: "private-value",
    });

    expect(invocation.command).toBe("/Applications/Octant/helper");
    expect(invocation.args).toEqual([]);
    expect(invocation.stdin).toContain("private-value");
    expect(`${invocation.command}\0${invocation.args.join("\0")}`).not.toContain("private-value");
  });

  it("derives a distinct replacement without embedding the actual credential", () => {
    const replacement = deriveReplacementCredential("actual-private-value");
    expect(replacement).not.toBe("actual-private-value");
    expect(replacement).not.toContain("actual-private-value");
  });

  it("strips all compatible credential inputs before launching the packaged app", () => {
    expect(
      packagedCompatibleEnvironment(
        {
          HOME: "/Users/test",
          OCTANT_OPENAI_COMPATIBLE_SMOKE: "1",
          OCTANT_OPENAI_COMPATIBLE_BASE_URL: "https://compatible.example/v1",
          OCTANT_OPENAI_COMPATIBLE_API_KEY: "private-value",
          OCTANT_OPENAI_COMPATIBLE_MODEL: "fixture-model",
        },
        "/tmp/octant-compatible",
      ),
    ).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      OCTANT_DATA_DIR: "/tmp/octant-compatible",
      OCTANT_SERVER_PORT: "13773",
      OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
    });
  });

  it("always deletes the isolated item after create, replace, presence, and resolve evidence", async () => {
    const calls: string[] = [];
    let stored: string | undefined;
    const helper = {
      set: vi.fn(async (_id: string, credential: string) => {
        calls.push(`set:${credential}`);
        stored = credential;
      }),
      has: vi.fn(async () => stored !== undefined),
      resolve: vi.fn(async () => stored),
      delete: vi.fn(async () => {
        calls.push("delete");
        stored = undefined;
      }),
    };

    await expect(
      withCredentialLifecycle(
        helper,
        "80000000-0000-4000-8000-000000000551",
        "private-value",
        async () => {
          throw new Error("private-value raw endpoint failure");
        },
      ),
    ).rejects.toThrow("Packaged OpenAI-compatible provider verification failed.");
    expect(calls).toEqual([
      "delete",
      "set:private-value",
      expect.stringMatching(/^set:(?!private-value$).+/),
      "set:private-value",
      "delete",
    ]);
    expect(helper.has).toHaveBeenCalledTimes(5);
    expect(helper.resolve).toHaveBeenCalledTimes(3);
    expect(stored).toBeUndefined();
  });
});

describe("packaged compatible lifecycle attribution", () => {
  const baseline: readonly CompatibleSmokeProcess[] = [
    { pid: 10, pgid: 10, command: "/older/Octant" },
  ];

  it("detects smoke-owned app, server, broker owner, and helper processes", () => {
    const options = {
      baseline,
      dataDirectory: "/tmp/octant-compatible-forced.abc",
      executable: "/package/Octant.app/Contents/MacOS/Octant",
      serverEntry: "/package/app/apps/server/dist/main.mjs",
      helperPath: "/package/Octant.app/Contents/Resources/native/octant-keychain-helper",
    };
    expect(
      findSmokeOwnedProcess(
        [...baseline, { pid: 11, pgid: 11, command: `${options.executable} --flag` }],
        options,
      )?.pid,
    ).toBe(11);
    expect(
      findSmokeOwnedProcess(
        [...baseline, { pid: 12, pgid: 11, command: options.serverEntry }],
        options,
      )?.pid,
    ).toBe(12);
    expect(
      findSmokeOwnedProcess(
        [...baseline, { pid: 13, pgid: 11, command: options.helperPath }],
        options,
      )?.pid,
    ).toBe(13);
    expect(
      findSmokeOwnedProcess(
        [...baseline, { pid: 14, pgid: 11, command: `node ${options.dataDirectory}` }],
        options,
      )?.pid,
    ).toBe(14);
    expect(findSmokeOwnedProcess(baseline, options)).toBeUndefined();
  });

  it("does not treat an absent native-only data marker as matching every process", () => {
    expect(
      findSmokeOwnedProcess([...baseline, { pid: 15, pgid: 15, command: "/usr/bin/unrelated" }], {
        baseline,
        dataDirectory: "",
        executable: "/package/Octant.app/Contents/MacOS/Octant",
        serverEntry: "/package/app/apps/server/dist/main.mjs",
        helperPath: "/package/Octant.app/Contents/Resources/native/octant-keychain-helper",
      }),
    ).toBeUndefined();
  });

  it("combines verification and cleanup failures without raw secret material", () => {
    const failure = combineCompatibleSmokeFailures(
      new Error("private-value raw provider response"),
      new Error("OCTANT_CREDENTIAL_BROKER_TOKEN=raw-token"),
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify(failure, errorProperties)).not.toMatch(
      /private-value|raw provider|BROKER_TOKEN|raw-token/,
    );
    expect(String(failure)).toContain("verification and cleanup");
  });
});

describe("strict packaged turn evidence", () => {
  const observation = {
    observedProtocol: "responses",
    capabilities: { streaming: "supported", usage: "supported" },
  };

  it("requires multiple deltas, numeric usage, streaming observation, and completion", () => {
    expect(() =>
      assertStrictTurnEvidence(
        {
          events: [
            { kind: "text-delta", text: "one" },
            { kind: "text-delta", text: "two" },
            { kind: "usage", inputTokens: 1, outputTokens: 2 },
            { kind: "completed" },
          ],
          observation,
        },
        "responses",
        "complete",
        "private-value",
      ),
    ).not.toThrow();
    for (const events of [
      [{ kind: "text-delta", text: "one" }, { kind: "usage" }, { kind: "completed" }],
      [
        { kind: "text-delta", text: "one" },
        { kind: "text-delta", text: "two" },
        { kind: "completed" },
      ],
    ]) {
      expect(() =>
        assertStrictTurnEvidence({ events, observation }, "responses", "complete", "private-value"),
      ).toThrow("strict streaming or usage evidence");
    }
  });

  it("requires output before an interrupted terminal", () => {
    expect(() =>
      assertStrictTurnEvidence(
        { events: [{ kind: "interrupted" }], observation },
        "responses",
        "cancel-after-output",
        "private-value",
      ),
    ).toThrow("accepted output or interruption");
  });
});

function errorProperties(_key: string, value: unknown): unknown {
  if (value instanceof AggregateError) return { message: value.message, errors: value.errors };
  if (value instanceof Error) return { message: value.message };
  return value;
}
