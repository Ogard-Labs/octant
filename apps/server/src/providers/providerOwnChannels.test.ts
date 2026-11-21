import type {
  ProviderConnection,
  ProviderDriver,
  ProviderOwnChannels,
  ProviderSessionResume,
  ProviderSessionStart,
} from "@octant/provider-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { launchOwnChannels, withProviderOwnChannels } from "./providerOwnChannels";

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

  it("outside Strict leaves telemetry to the provider and keeps self-update off when the person chose nothing", () => {
    expect(launchOwnChannels(false, undefined)).toEqual({ telemetry: true, selfUpdate: false });
  });
});
