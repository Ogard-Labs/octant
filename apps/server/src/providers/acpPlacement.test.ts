import { homedir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderPlacedLaunch } from "@octant/provider-sdk/driver";
import { acquireProviderConnection } from "@octant/provider-sdk/process-placement";
import { Cause, Effect, Exit, Option, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { makeAcpDriver } from "./acpDriver";
import { acpRemotePlacement, makeAcpPlacedProcessLive } from "./acpPlacement";
import { acpStandInTarget, placeableAcpProfile } from "./acpPlacement.test-support";
import type { AcpProcessPort } from "./acpProcess";
import {
  acpProviderProfiles,
  type AcpHostAuthentication,
  type AcpProviderProfile,
} from "./acpProfiles";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000c01");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000c02");
const modelId = "agent-k2" as ProviderModelId;
const remoteRoot = "/home/build/app";

function withProcess(changes: Partial<AcpProviderProfile["process"]>): AcpProviderProfile {
  return { ...placeableAcpProfile, process: { ...placeableAcpProfile.process, ...changes } };
}

function failureOf<A>(exit: Exit.Exit<A, ProviderFailure>): ProviderFailure | undefined {
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;
}

describe("where an ACP profile can be placed on a remote target", () => {
  it("places no shipped profile, because each local launch carries something a placed launch cannot", () => {
    for (const profile of Object.values(acpProviderProfiles)) {
      expect(acpRemotePlacement(profile, undefined)).toBeUndefined();
    }
  });

  it("states the whole launch of a profile that can be placed, with its sign-in folder under the target user's home", () => {
    expect(acpRemotePlacement(placeableAcpProfile, "provider-owned")).toEqual({
      support: {
        postures: ["plan", "approval-gated", "auto-accept-edits"],
        appToolTransport: "stdio",
      },
      args: ["--acp"],
      accountState: [
        { path: ".fixture-agent", access: "read-write", variable: "FIXTURE_AGENT_HOME" },
      ],
    });
  });

  it("never places an instance that signs in here with a key or a browser sign-in", () => {
    expect(acpRemotePlacement(placeableAcpProfile, "api-key")).toBeUndefined();
    expect(acpRemotePlacement(placeableAcpProfile, "subscription")).toBeUndefined();
  });

  it("refuses a profile whose local launch would leave a guard, a variable, a managed file, or a host path behind", () => {
    const leftBehind: ReadonlyArray<Partial<AcpProviderProfile["process"]>> = [
      { guards: { NO_COLOR: "1" } },
      { environment: ({ managedHome }) => ({ XDG_CONFIG_HOME: join(managedHome, ".config") }) },
      { managedFiles: ({ managedHome }) => [{ path: join(managedHome, "config"), content: "{}" }] },
      { hostReadPaths: [join(homedir(), ".config/agent.json")] },
      { hostDeniedEntries: ["mcp"] },
      { forbiddenRootEntries: [".agent/hooks"] },
    ];
    for (const changes of leftBehind) {
      expect(acpRemotePlacement(withProcess(changes), undefined)).toBeUndefined();
    }
    expect(
      acpRemotePlacement({ ...placeableAcpProfile, refusesProject: () => undefined }, undefined),
    ).toBeUndefined();
  });

  it("states a sign-in folder only when one variable names exactly that folder under the home", () => {
    const folder = join(homedir(), ".fixture-agent");
    const unstated: ReadonlyArray<AcpHostAuthentication> = [
      // The agent's HOME on the target is its own runtime home, so a folder
      // no variable names would never be found there.
      { kind: "directory", defaultPath: folder, loginHint: "Sign in." },
      {
        kind: "directory",
        defaultPath: folder,
        loginHint: "Sign in.",
        environment: (path) => ({ AGENT_HOME: join(path, "..") }),
      },
      {
        kind: "directory",
        defaultPath: folder,
        loginHint: "Sign in.",
        environment: (path) => ({ AGENT_HOME: path }),
        forbiddenEntries: ["mcp"],
      },
      {
        kind: "directory",
        defaultPath: "/etc/agent",
        loginHint: "Sign in.",
        environment: (path) => ({ AGENT_HOME: path }),
      },
      { kind: "credential-file", defaultPath: join(folder, "token"), managedRelativePath: "token" },
    ];
    for (const hostAuthentication of unstated) {
      expect(acpRemotePlacement(withProcess({ hostAuthentication }), undefined)).toBeUndefined();
    }
    const { hostAuthentication: _unused, ...withoutSignIn } = placeableAcpProfile.process;
    expect(
      acpRemotePlacement({ ...placeableAcpProfile, process: withoutSignIn }, undefined)
        ?.accountState,
    ).toEqual([]);
  });

  it("leaves out a posture the profile refuses, and Plan for an agent that forks a child server", () => {
    expect(
      acpRemotePlacement(
        {
          ...placeableAcpProfile,
          refuses: (_mode, policy) => (policy === "approval-gated" ? "Not offered." : undefined),
        },
        undefined,
      )?.support.postures,
    ).toEqual(["plan", "auto-accept-edits"]);
    expect(
      acpRemotePlacement(withProcess({ requiresChildServer: true }), undefined)?.support.postures,
    ).toEqual(["approval-gated", "auto-accept-edits"]);
  });
});

describe("an ACP agent placed on a remote target", () => {
  const start = (target: ReturnType<typeof acpStandInTarget>) => {
    const placement = acpRemotePlacement(placeableAcpProfile, undefined);
    if (placement === undefined) throw new Error("the fixture profile is placeable");
    return Effect.runPromiseExit(
      Effect.scoped(
        makeAcpPlacedProcessLive({ startupTimeoutMs: 2_000 }).start({
          profile: placeableAcpProfile,
          placement: target,
          launch: placement,
          root: remoteRoot,
          clientCapabilities: { readTextFile: true, writeTextFile: false, terminal: false },
        }),
      ),
    );
  };

  it("negotiates ACP over the placed process and reports the version the agent states", async () => {
    const exit = await start(acpStandInTarget());
    expect(
      Exit.isSuccess(exit) ? { version: exit.value.version, root: exit.value.root } : exit,
    ).toEqual({
      version: "0.4.2",
      root: remoteRoot,
    });
  });

  it("refuses an agent that reports no version it can compare, an older one, or another agent", async () => {
    expect(failureOf(await start(acpStandInTarget({ version: "dev" })))).toMatchObject({
      category: "incompatible",
      reason: "runtime-incompatible",
    });
    expect(failureOf(await start(acpStandInTarget({ version: undefined })))).toMatchObject({
      category: "incompatible",
    });
    expect(failureOf(await start(acpStandInTarget({ version: "0.0.9" })))).toMatchObject({
      category: "incompatible",
      diagnostic: { kind: "version-mismatch", detectedVersion: "0.0.9" },
    });
    expect(failureOf(await start(acpStandInTarget({ agentName: "another-agent" })))).toMatchObject({
      category: "incompatible",
    });
  });
  it("survives a write the target fails after the agent was asked to stop", async () => {
    // A write still crossing the session when the agent's input closes, then
    // failed by a session that ended, must not surface as an unhandled
    // stream error that takes the host down.
    const target = acpStandInTarget();
    let initialized = false;
    const failingLate: ReturnType<typeof acpStandInTarget> = {
      ...target,
      launch: (launch) =>
        Effect.map(target.launch(launch), (process) => ({
          ...process,
          write: (bytes) => {
            if (!initialized) {
              initialized = true;
              return process.write(bytes);
            }
            return Effect.zipRight(
              Effect.sleep("20 millis"),
              Effect.fail({ category: "unavailable", message: "The session ended." } as const),
            );
          },
        })),
    };
    const placement = acpRemotePlacement(placeableAcpProfile, undefined);
    if (placement === undefined) throw new Error("the fixture profile is placeable");
    const scope = Effect.runSync(Scope.make());
    const connection = await Effect.runPromise(
      makeAcpPlacedProcessLive({ startupTimeoutMs: 2_000 })
        .start({
          profile: placeableAcpProfile,
          placement: failingLate,
          launch: placement,
          root: remoteRoot,
          clientCapabilities: { readTextFile: true, writeTextFile: false, terminal: false },
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const unhandled: unknown[] = [];
    const record = (error: unknown) => unhandled.push(error);
    process.on("uncaughtException", record);
    try {
      const cancelled = connection.acp
        .notify("session/cancel", { sessionId: "placed" })
        .catch(() => "refused");
      // The write is under way on the session before the agent is stopped.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(await cancelled).toBe("refused");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
    }
  });
});

describe("the ACP driver with a remote placement", () => {
  function placedDriver(options: { readonly authentication?: "api-key" } = {}): {
    readonly driver: ReturnType<typeof makeAcpDriver>;
    readonly localStarts: () => number;
  } {
    let localStarts = 0;
    const process: AcpProcessPort = {
      start: () =>
        Effect.sync(() => {
          localStarts += 1;
        }).pipe(
          Effect.zipRight(
            Effect.fail({ category: "unavailable" as const, message: "Not on this host." }),
          ),
        ),
    };
    return {
      driver: makeAcpDriver({
        profile: placeableAcpProfile,
        instanceId,
        binaryPath: "/usr/local/bin/fixture-agent",
        managedHome: "/tmp/octant-acp-placement-home",
        process,
        runtimeRegistry: new ProviderRuntimeRegistry(),
        ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
      }),
      localStarts: () => localStarts,
    };
  }

  const startIn = async (
    driver: ReturnType<typeof makeAcpDriver>,
    target: ReturnType<typeof acpStandInTarget>,
    session: {
      readonly executionPolicy: "full-access" | "approval-gated";
      readonly tools?: ReadonlyArray<ProviderToolDefinition>;
    },
  ) =>
    Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* acquireProviderConnection(driver, {
            instanceId,
            projectRoot: remoteRoot,
            mode: "code",
            placement: target,
          });
          return yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: session.executionPolicy,
            ...(session.tools === undefined ? {} : { tools: session.tools }),
          });
        }),
      ),
    );

  it("refuses a session in a posture the profile does not declare before anything launches", async () => {
    const { driver, localStarts } = placedDriver();
    const launches: ProviderPlacedLaunch[] = [];
    const exit = await startIn(driver, acpStandInTarget({ launches }), {
      executionPolicy: "full-access",
    });
    expect(failureOf(exit)).toMatchObject({ category: "unsupported" });
    expect(launches).toEqual([]);
    expect(localStarts()).toBe(0);
  });

  it("refuses app-managed tools that need the tool bridge, a listener the target would hold", async () => {
    const { driver, localStarts } = placedDriver();
    const launches: ProviderPlacedLaunch[] = [];
    const exit = await startIn(driver, acpStandInTarget({ launches }), {
      executionPolicy: "approval-gated",
      tools: [{ name: "octant_canvas", description: "Canvas.", inputSchema: { type: "object" } }],
    });
    expect(failureOf(exit)).toMatchObject({ category: "unsupported" });
    expect(launches).toEqual([]);
    expect(localStarts()).toBe(0);
  });

  it("declares nothing, and is refused a placement, for an instance that signs in with a key", async () => {
    const { driver, localStarts } = placedDriver({ authentication: "api-key" });
    expect(driver.remotePlacement).toBeUndefined();
    const launches: ProviderPlacedLaunch[] = [];
    const exit = await startIn(driver, acpStandInTarget({ launches }), {
      executionPolicy: "approval-gated",
    });
    expect(failureOf(exit)).toMatchObject({ category: "unsupported" });
    expect(launches).toEqual([]);
    expect(localStarts()).toBe(0);
  });
});
