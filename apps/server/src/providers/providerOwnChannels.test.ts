import type {
  ProviderConnection,
  ProviderDriver,
  ProviderOwnChannels,
  ProviderSessionResume,
  ProviderSessionStart,
} from "@octant/provider-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  launchCredentialsKey,
  launchOwnChannels,
  strictLetThroughEnvironment,
  withProviderOwnChannels,
} from "./providerOwnChannels";

describe("provider own channels", () => {
  it("carries the person's current switches on every start and resume, read at each one", async () => {
    const starts: ProviderSessionStart[] = [];
    const resumes: ProviderSessionResume[] = [];
    const connection = {
      start: (input: ProviderSessionStart) => {
        starts.push(input);
        return Effect.succeed({ sessionId: input.sessionId });
      },
      resume: (input: ProviderSessionResume) => {
        resumes.push(input);
        return Effect.succeed({ sessionId: input.sessionId });
      },
    } as unknown as ProviderConnection;
    let current: ProviderOwnChannels = { telemetry: false, selfUpdate: false };
    const driver = withProviderOwnChannels(
      { acquire: () => Effect.succeed(connection) } as unknown as ProviderDriver,
      () => current,
    );
    const acquired = await Effect.runPromise(Effect.scoped(driver.acquire({} as never)));
    const start = { sessionId: "s-1", modelId: "m", executionPolicy: "full-access" } as never;
    await Effect.runPromise(acquired.start(start));
    current = { telemetry: true, selfUpdate: true };
    await Effect.runPromise(
      acquired.resume({ sessionId: "s-1", executionPolicy: "plan", resumeCursor: {} } as never),
    );
    expect(starts.map((input) => input.ownChannels)).toEqual([
      { telemetry: false, selfUpdate: false },
    ]);
    expect(resumes.map((input) => input.ownChannels)).toEqual([
      { telemetry: true, selfUpdate: true },
    ]);
  });

  it("opens no channel under Strict whatever the person chose", () => {
    expect(launchOwnChannels(true, { telemetry: true, selfUpdate: true })).toEqual({
      telemetry: false,
      selfUpdate: false,
    });
  });

  it("outside Strict keeps the provider's own telemetry and self-update off when the person chose nothing", () => {
    expect(launchOwnChannels(false, undefined)).toEqual({ telemetry: false, selfUpdate: false });
  });

  it("carries the names the person let through only into a Strict launch", () => {
    const chosen = { telemetry: true, selfUpdate: false, credentialPassThrough: ["GH_TOKEN"] };
    expect(launchOwnChannels(true, chosen)).toEqual({
      telemetry: false,
      selfUpdate: false,
      credentialPassThrough: ["GH_TOKEN"],
    });
    expect(launchOwnChannels(false, chosen)).toEqual({ telemetry: true, selfUpdate: false });
  });

  it("a Strict launch takes a let-through name the host has, and never a model provider's key or one of Octant's own variables a stored list names", () => {
    expect(
      strictLetThroughEnvironment(
        {
          GH_TOKEN: "gh-token",
          NPM_TOKEN: "npm-token",
          OPENAI_API_KEY: "model-key",
          OCTANT_DESKTOP_BRIDGE_SECRET: "bridge",
        },
        ["GH_TOKEN", "NOT_SET", "OPENAI_API_KEY", "OCTANT_DESKTOP_BRIDGE_SECRET"],
      ),
    ).toEqual({ GH_TOKEN: "gh-token" });
  });

  it("tells kept Strict sessions apart by the let-through list, and never sessions outside Strict", () => {
    const posture = {
      executionPolicy: "approval-gated",
      fullAccessSandbox: false,
      sandboxPolicy: false,
    } as const;
    const key = (strict: boolean, names: ReadonlyArray<string>, driverKind = "codex") =>
      launchCredentialsKey({ providerCredentialPassThrough: { codex: names } }, driverKind, {
        ...posture,
        strict,
      });
    expect(key(true, ["GH_TOKEN"])).not.toBe(key(true, []));
    expect(key(true, ["NPM_TOKEN", "GH_TOKEN"])).toBe(key(true, ["GH_TOKEN", "NPM_TOKEN"]));
    expect(key(false, ["GH_TOKEN"])).toBe(key(false, []));
    // Another provider's list is not this one's.
    expect(key(true, ["GH_TOKEN"], "claude")).toBe(key(true, [], "claude"));
  });
});
