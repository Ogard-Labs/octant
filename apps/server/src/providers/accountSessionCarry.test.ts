import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  type ProviderInstance,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAccountSessionCarrier } from "./accountSessionCarry";
import { claudeProjectFolderName } from "./claudeProcess";

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
  let root: string;
  let projectRoot: string;
  let instances: Map<string, ProviderInstance>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "octant-account-carry-")));
    projectRoot = join(root, "project");
    await Promise.all([mkdir(projectRoot), mkdir(join(root, "a")), mkdir(join(root, "b"))]);
    await mkdir(join(root, "a", "projects", claudeProjectFolderName(projectRoot)), {
      recursive: true,
    });
    await writeFile(
      join(root, "a", "projects", claudeProjectFolderName(projectRoot), `${nativeSessionId}.jsonl`),
      "t\n",
    );
    instances = new Map([
      [String(first), claude(first, join(root, "a"))],
      [String(second), claude(second, join(root, "b"))],
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

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const request = (to = second) => ({
    fromInstanceId: first,
    toInstanceId: to,
    resumeCursor: { driverKind: "claude" as const, value: nativeSessionId },
    sessionId,
    projectRoot,
    mode: "chat" as const,
    modelId: decodeProviderModelId("model-a"),
  });

  const carrier = (adopt: NonNullable<ProviderDriver["nativeSessions"]>["adopt"]) =>
    makeAccountSessionCarrier({
      readInstance: (id) => instances.get(String(id)),
      resolveDriver: () => ({ nativeSessions: { list: () => Effect.succeed([]), adopt } }),
      hostEnvironment: {},
      homeDirectory: root,
    });

  const copied = () =>
    join(root, "b", "projects", claudeProjectFolderName(projectRoot), `${nativeSessionId}.jsonl`);

  it("copies the session into the new account and answers the cursor its driver took it up with", async () => {
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
    expect(adopted).toEqual([
      { instanceId: String(second), nativeSessionId, sessionId: String(sessionId) },
    ]);
    expect((await stat(copied())).isFile()).toBe(true);
  });

  it("removes the copy when the new account refuses to take it up", async () => {
    const carry = carrier(() =>
      Effect.fail({ category: "unavailable" as const, message: "Already held." }),
    );

    expect(await carry.carry(request())).toEqual({ status: "text", cause: "session-not-adopted" });
    await expect(stat(copied())).rejects.toThrow();
  });

  it("keeps another provider's move on the text handoff", async () => {
    const carry = carrier(() => Effect.die("never adopted"));

    expect(carry.sameProvider(first, codex)).toBe(false);
    expect(carry.sameProvider(first, second)).toBe(true);
    expect(carry.sameProvider(first, first)).toBe(false);
    expect(await carry.carry(request(codex))).toEqual({
      status: "text",
      cause: "provider-cannot-carry",
    });
  });

  it("hands over as text when an account is no longer set up", async () => {
    instances.delete(String(first));
    const carry = carrier(() => Effect.die("never adopted"));

    expect(await carry.carry(request())).toEqual({ status: "text", cause: "account-unavailable" });
  });
});
