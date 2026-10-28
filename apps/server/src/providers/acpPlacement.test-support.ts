import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ProviderPlacedLaunch,
  ProviderPlacedProcess,
  ProviderPlacedProcessEnd,
  ProviderRemoteProcessPlacement,
} from "@octant/provider-sdk/driver";
import { Deferred, Effect, Queue, Stream } from "effect";
import type { AcpProviderProfile } from "./acpProfiles";

/**
 * An ACP profile whose whole launch can be stated on a remote target: no
 * guard, variable, managed file, host read, or denied path, and a sign-in
 * folder one variable names, so the placement tests see only what they add.
 */
export const placeableAcpProfile: AcpProviderProfile = {
  kind: "copilot",
  displayName: "Fixture Agent",
  reasoningOptionId: "thinking",
  sessionMode: (_mode, policy) => (policy === "plan" ? "plan" : "default"),
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage: "Fixture Agent is not signed in.",
  process: {
    agentName: "fixture-agent",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\r?\n?$/,
    minimumVersion: [0, 1, 0],
    passthroughVariables: [],
    guards: {},
    environment: () => ({}),
    args: () => ["--acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".fixture-agent"),
      loginHint: "Sign the fixture agent in, then retry.",
      environment: (path) => ({ FIXTURE_AGENT_HOME: path }),
    },
    confinement: { kind: "deny-default-seatbelt" },
    remote: { args: ["--acp"] },
  },
};

/**
 * A stand-in target whose placed agent answers ACP `initialize` as the
 * profile's agent at `version`, records each launch it was asked for, and
 * ends when the launch's scope closes.
 */
export function acpStandInTarget(
  options: {
    readonly executable?: string;
    readonly agentName?: string;
    /** The version the agent reports; undefined reports no agent information at all. */
    readonly version?: string | undefined;
    readonly launches?: ProviderPlacedLaunch[];
  } = {},
): ProviderRemoteProcessPlacement {
  const agentName = options.agentName ?? placeableAcpProfile.process.agentName;
  const version = "version" in options ? options.version : "0.4.2";
  return {
    kind: "remote",
    executable: options.executable ?? "/opt/fixture-agent/bin/fixture-agent",
    launch: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          options.launches?.push(launch);
          const output = yield* Queue.unbounded<Uint8Array>();
          const ended = yield* Deferred.make<ProviderPlacedProcessEnd>();
          let pending = "";
          const process: ProviderPlacedProcess = {
            output: Stream.fromQueue(output),
            write: (bytes) =>
              Effect.gen(function* () {
                pending += new TextDecoder().decode(bytes);
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) {
                  if (line.trim() === "") continue;
                  const message: unknown = JSON.parse(line);
                  if (
                    typeof message !== "object" ||
                    message === null ||
                    !("method" in message) ||
                    message.method !== "initialize" ||
                    !("id" in message)
                  ) {
                    continue;
                  }
                  const answer = {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      protocolVersion: 1,
                      agentCapabilities: { loadSession: true },
                      ...(version === undefined ? {} : { agentInfo: { name: agentName, version } }),
                    },
                  };
                  yield* Queue.offer(
                    output,
                    new TextEncoder().encode(`${JSON.stringify(answer)}\n`),
                  );
                }
              }),
            ended: Deferred.await(ended),
          };
          return { process, output, ended };
        }),
        ({ output, ended }) =>
          Effect.zipRight(
            Deferred.succeed(ended, { kind: "exited", code: 0 }),
            Queue.shutdown(output),
          ),
      ).pipe(Effect.map(({ process }) => process)),
  };
}
