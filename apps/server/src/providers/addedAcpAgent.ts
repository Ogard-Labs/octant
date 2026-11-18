/**
 * Running an agent the person added (Provider runtimes: "Any ACP agent") on
 * the shared ACP stack. It has no reviewed profile, so the profile here claims
 * nothing a probe would have to show: its identity is the configured command,
 * its version is whatever `--version` or its `initialize` reply says, and
 * every capability is what that reply advertises. Its launch follows
 * `decideAcpAgentLaunch`: until the person trusts it, Octant's sandbox at
 * every level, nothing remembered and none of Octant's tools.
 */
import { Effect } from "effect";
import { ACP_CLIENT_TOOL_NAMES } from "@octant/provider-sdk";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import type { AddedAcpAgentProviderInstance, ProviderToolDefinition } from "@octant/contracts";
import { addedAcpAgentSteps } from "@octant/domain";
import { decideAcpAgentLaunch, type AcpAgentSteps } from "@octant/plugin-host/acp-agents";
import { HOST_PASSTHROUGH_VARIABLES, type AcpProviderProfile } from "./acpProfiles";

/**
 * The generic profile for one added agent. Its mode is never selected, since
 * no mapping of Chat, Work, Code and Plan onto the agent's own modes was
 * read; Plan's read-only wall and the level's approvals are Octant's sandbox
 * and approval bridge instead. No exact-release feature (usage, compaction,
 * file review, forms, warm reuse, unadvertised HTTP tools) is pinned, so none
 * is offered at any level.
 */
export function addedAcpAgentProfile(instance: AddedAcpAgentProviderInstance): AcpProviderProfile {
  const { configuration } = instance;
  const name = instance.displayName;
  const environment = configuration.environment ?? {};
  return {
    kind: "acp-agent",
    displayName: name,
    reasoningOptionId: "effort",
    sessionMode: () => "",
    selectsNoMode: true,
    modelSelection: "follow-session",
    chatSessionRoot: "managed-home",
    userQuestions: "unsupported",
    resumeMethod: "session/load",
    closesSessions: false,
    authenticateOnProbe: false,
    authentication: { kind: "provider-owned" },
    unauthenticatedMessage: `${name} is not signed in. Sign in with its own command in your terminal, then check the connection again.`,
    process: {
      // The configured command is the agent's identity, so any name its
      // `initialize` reply gives is accepted; ACP's version still must match.
      agentName: name,
      verifyAgentInfo: () => true,
      versionPattern: /(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u,
      minimumVersion: [0, 0, 0],
      versionProbe: "best-effort",
      passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
      guards: { NO_COLOR: "1" },
      environment: () => environment,
      args: () => configuration.args,
      managedFiles: () => [],
      confinement: { kind: "deny-default-seatbelt" },
    },
  };
}

const ACP_CLIENT_TOOLS: ReadonlySet<string> = new Set(Object.values(ACP_CLIENT_TOOL_NAMES));

/** The tools an untrusted agent keeps: only the ACP client's own file and terminal calls. */
function withoutOctantTools(
  tools: ReadonlyArray<ProviderToolDefinition> | undefined,
): ReadonlyArray<ProviderToolDefinition> | undefined {
  return tools?.filter((tool) => ACP_CLIENT_TOOLS.has(tool.name));
}

/**
 * Holds an added agent's driver to the launch decision for its steps. A
 * session of an agent that is not installed or not on starts nothing. An
 * untrusted one is started under Strict, with the sandbox kept at Full
 * access, with none of the person's own setup, with Octant's tools taken out
 * and every approval answered for one call only, whatever the thread asked.
 */
export function withAddedAcpAgentLaunch(
  driver: ProviderDriver,
  instance: AddedAcpAgentProviderInstance,
): ProviderDriver {
  const steps: AcpAgentSteps = addedAcpAgentSteps(instance);
  const name = instance.displayName;
  return {
    ...driver,
    probe: (input) =>
      driver.probe(input).pipe(
        Effect.map((result) =>
          steps.trusted
            ? result
            : {
                ...result,
                capabilities: { ...result.capabilities, appManagedTools: "unsupported" as const },
              },
        ),
      ),
    acquire: (input) => {
      const refusal = decideAcpAgentLaunch({ steps, executionPolicy: "approval-gated" });
      if (refusal.status === "refused")
        return Effect.fail({
          category: "unavailable" as const,
          message:
            refusal.reason === "not-installed"
              ? `Install ${name} before starting it.`
              : `Turn ${name} on before starting it.`,
        });
      return driver.acquire(input).pipe(Effect.map((connection) => heldConnection(connection)));
    },
  };

  function heldConnection(connection: ProviderConnection): ProviderConnection {
    if (steps.trusted) return connection;
    return {
      ...connection,
      start: (start) => {
        const { nativeSetup: _setup, tools, ...rest } = start;
        const held = withoutOctantTools(tools);
        return connection.start({
          ...rest,
          ...(held === undefined ? {} : { tools: held }),
          strict: true,
          ...(start.executionPolicy === "full-access" ? { fullAccessSandbox: true } : {}),
        });
      },
      resume: (resume) => {
        const { nativeSetup: _setup, tools, ...rest } = resume;
        const held = withoutOctantTools(tools);
        return connection.resume({
          ...rest,
          ...(held === undefined ? {} : { tools: held }),
          strict: true,
          ...(resume.executionPolicy === "full-access" ? { fullAccessSandbox: true } : {}),
        });
      },
      answerApproval: (answer) => connection.answerApproval({ ...answer, scope: "once" }),
    };
  }
}
