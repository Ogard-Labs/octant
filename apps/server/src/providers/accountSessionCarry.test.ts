import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  type ProviderInstance,
} from "@octant/contracts";
import type { ProviderNativeSessions } from "@octant/provider-sdk";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeAccountSessionCarrier } from "./accountSessionCarry";

const first = decodeProviderInstanceId("80000000-0000-4000-8000-000000000931");
const second = decodeProviderInstanceId("80000000-0000-4000-8000-000000000932");
const codex = decodeProviderInstanceId("80000000-0000-4000-8000-000000000933");
const now = "2026-11-17T10:00:00.000Z";
const nativeSessionId = "6f1c2e2a-3b4d-4c5e-8f90-0a1b2c3d4e5f";
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000940");

function claude(id: typeof first, configDirectory: string): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: "Claude",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
      configDirectory,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe("carrying a session to another account of the same provider", () => {
  let instances: Map<string, ProviderInstance>;
  let carried: Array<{ instanceId: string; fromInstanceId: string; nativeSessionId: string }>;
  let discarded: number;

  beforeEach(() => {
    carried = [];
    discarded = 0;
    instances = new Map([
      [String(first), claude(first, "/accounts/a")],
      [String(second), claude(second, "/accounts/b")],
      [
        String(codex),
        decodeProviderInstance({
          id: codex,
          displayName: "Codex",
          driverKind: "codex",
          configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ],
    ]);
  });

  const request = (to = second) => ({
    fromInstanceId: first,
    toInstanceId: to,
    resumeCursor: { driverKind: "claude" as const, value: nativeSessionId },
    sessionId,
    projectRoot: "/projects/one",
    mode: "chat" as const,
    modelId: decodeProviderModelId("model-a"),
  });

  const carrier = (
    adopt: ProviderNativeSessions["adopt"],
    // `null` builds a driver that carries nothing.
    carry: ProviderNativeSessions["carry"] | null = (input) => {
      carried.push({
        instanceId: String(input.instanceId),
        fromInstanceId: String(input.fromInstanceId),
        nativeSessionId: input.nativeSessionId,
      });
      return Effect.succeed({
        status: "carried",
        discard: () =>
          Effect.sync(() => {
            discarded += 1;
          }),
      });
    },
  ) =>
    makeAccountSessionCarrier({
      readInstance: (id) => instances.get(String(id)),
      resolveDriver: () => ({
        nativeSessions: {
          list: () => Effect.succeed([]),
          adopt,
          ...(carry === null || carry === undefined ? {} : { carry }),
        },
      }),
    });

  it("has the new account's driver bring the session over and answers the cursor it took it up with", async () => {
    const adopted: Array<{ instanceId: string; nativeSessionId: string; sessionId: string }> = [];
    const carry = carrier((input) => {
      adopted.push({
        instanceId: String(input.instanceId),
        nativeSessionId: input.nativeSessionId,
        sessionId: String(input.sessionId),
      });
      return Effect.succeed({ driverKind: "claude", value: input.nativeSessionId });
    });

    expect(await carry.carry(request())).toEqual({
      status: "carried",
      resumeCursor: { driverKind: "claude", value: nativeSessionId },
    });
    expect(carried).toEqual([
      { instanceId: String(second), fromInstanceId: String(first), nativeSessionId },
    ]);
    expect(adopted).toEqual([
      { instanceId: String(second), nativeSessionId, sessionId: String(sessionId) },
    ]);
    expect(discarded).toBe(0);
  });

  it("takes the copy back when the new account refuses to take it up", async () => {
    const carry = carrier(() =>
      Effect.fail({ category: "unavailable" as const, message: "Already held." }),
    );

    expect(await carry.carry(request())).toEqual({ status: "text", cause: "session-not-adopted" });
    expect(discarded).toBe(1);
  });

  it("hands over as text when the driver refuses to bring the session", async () => {
    const carry = carrier(
      () => Effect.die("never adopted"),
      () => Effect.succeed({ status: "refused" }),
    );

    expect(await carry.carry(request())).toEqual({ status: "text", cause: "session-not-copied" });
  });

  it("keeps the text handoff for another provider's move and for a driver that carries nothing", async () => {
    const carry = carrier(() => Effect.die("never adopted"));

    expect(carry.sameProvider(first, codex)).toBe(false);
    expect(carry.sameProvider(first, second)).toBe(true);
    expect(carry.sameProvider(first, first)).toBe(false);
    expect(await carry.carry(request(codex))).toEqual({
      status: "text",
      cause: "provider-cannot-carry",
    });
    expect(await carrier(() => Effect.die("never adopted"), null).carry(request())).toEqual({
      status: "text",
      cause: "provider-cannot-carry",
    });
    expect(carried).toEqual([]);
  });

  it("hands over as text when an account is no longer set up", async () => {
    instances.delete(String(first));
    const carry = carrier(() => Effect.die("never adopted"));

    expect(await carry.carry(request())).toEqual({ status: "text", cause: "account-unavailable" });
  });
});
