import type { ProviderExecutionPolicy } from "@octant/contracts/providers";

/**
 * Adding any ACP agent: one from the public ACP registry, or the person's own
 * local command (Provider runtimes: "Any ACP agent"). Installation, trust and
 * enablement stay separate steps, as for every plugin, and finding an agent in
 * the registry grants it nothing. A custom agent has no runtime profile: every
 * capability is what its own `initialize` reports, so this module decides only
 * whether it may start, whose sandbox holds it, and whether anything about it
 * may be remembered.
 */

/** Where an added agent comes from. Its command is never run through a shell. */
export type AcpAgentSource =
  | {
      readonly kind: "registry";
      /** The registry's own id for the agent, as its `agent.json` names it. */
      readonly registryId: string;
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }
  | {
      readonly kind: "local";
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };

/** The person's three steps for one added agent. */
export interface AcpAgentSteps {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly enabled: boolean;
}

/** Nothing done yet: what a registry listing, or a typed-in command, starts with. */
export const ACP_AGENT_DISCOVERED: AcpAgentSteps = {
  installed: false,
  trusted: false,
  enabled: false,
};

/**
 * Whether an added agent may start, and how.
 * - `octant`: Octant's sandbox, at the thread's level; a Full access thread
 *   gets the wall Accept edits has, since the agent is not yet trusted to run
 *   open.
 * - `own`: no Octant sandbox below Full access, as for a shipped profile with
 *   a sandbox of its own: a trusted agent outside Strict runs as on its own.
 * - `none`: Full access, which keeps no sandbox.
 * `remembers` is false until the agent is trusted: no remembered approval and
 * no Project trust is recorded for it, and an answer covers one call.
 */
export type AcpAgentLaunchDecision =
  | { readonly status: "refused"; readonly reason: "not-installed" | "disabled" }
  | {
      readonly status: "starts";
      readonly sandbox: "octant" | "own" | "none";
      readonly remembers: boolean;
    };

export function decideAcpAgentLaunch(input: {
  readonly steps: AcpAgentSteps;
  readonly executionPolicy: ProviderExecutionPolicy;
  /** Absent is Strict, so a launch that never resolved it keeps Octant's sandbox. */
  readonly strict?: boolean;
}): AcpAgentLaunchDecision {
  if (!input.steps.installed) return { status: "refused", reason: "not-installed" };
  if (!input.steps.enabled) return { status: "refused", reason: "disabled" };
  if (!input.steps.trusted) return { status: "starts", sandbox: "octant", remembers: false };
  // Full access keeps no sandbox, Strict or not, as for a shipped profile;
  // Plan keeps its read-only confinement, and Strict keeps Octant's sandbox.
  if (input.executionPolicy === "full-access")
    return { status: "starts", sandbox: "none", remembers: true };
  if (input.executionPolicy === "plan" || input.strict !== false)
    return { status: "starts", sandbox: "octant", remembers: true };
  return { status: "starts", sandbox: "own", remembers: true };
}

/** Why a typed-in or registry command is refused before it is ever added. */
export type AcpAgentCommandRefusal = "not-absolute" | "control-character" | "too-many-arguments";

/**
 * A command is an absolute executable path plus literal arguments. Nothing is
 * expanded or passed to a shell, so a control character is refused outright
 * rather than escaped.
 */
export function acpAgentCommandRefusal(source: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): AcpAgentCommandRefusal | undefined {
  // oxlint-disable-next-line no-control-regex -- the refusal is about control characters.
  const control = /[\u0000-\u001f\u007f]/u;
  if (!source.command.startsWith("/")) return "not-absolute";
  if (source.args.length > 32) return "too-many-arguments";
  if ([source.command, ...source.args].some((part) => control.test(part)))
    return "control-character";
  return undefined;
}

/** One agent as the public ACP registry lists it for this host. */
export interface AcpRegistryAgent {
  readonly registryId: string;
  readonly name: string;
  /** The registry's distribution: an npm package run with `npx`, or a binary in an archive. */
  readonly distribution:
    | { readonly kind: "npx"; readonly package: string; readonly args: ReadonlyArray<string> }
    | { readonly kind: "binary"; readonly command: string; readonly args: ReadonlyArray<string> };
  /** Why Octant has no reviewed profile for it yet. */
  readonly unreviewedBecause: string;
}

/**
 * The registry agents Octant was asked to make first-class, as the registry's
 * source repository `agentclientprotocol/registry` listed them at commit
 * `131167e` (2026-11-16), macOS distribution. None has a signed-in probe on
 * record, so each is offered as an agent the person may add, not as a
 * reviewed profile. Trae is not in the registry at that commit; a person adds
 * it as a local command.
 */
export const ACP_REGISTRY_AGENTS: ReadonlyArray<AcpRegistryAgent> = [
  {
    registryId: "antigravity-acp",
    name: "Google Antigravity",
    distribution: { kind: "binary", command: "agy_acp_server.par", args: [] },
    unreviewedBecause:
      "How it signs in outside its IDE extension, and whether it runs without the IDE, needs a signed-in probe.",
  },
  {
    registryId: "factory-droid",
    name: "Factory Droid",
    distribution: {
      kind: "npx",
      package: "droid@1.12.1",
      args: ["exec", "--output-format", "acp-daemon"],
    },
    unreviewedBecause:
      "Its ACP entry is a daemon output mode; its modes and sign-in folder need a signed-in probe.",
  },
  {
    registryId: "junie",
    name: "Junie",
    distribution: {
      kind: "binary",
      command: "Applications/junie.app/Contents/MacOS/junie",
      args: ["--acp=true"],
    },
    unreviewedBecause:
      "Whether it launches under Seatbelt from its app bundle, and which JetBrains account state it reads, needs a signed-in probe.",
  },
  {
    registryId: "amp-acp",
    name: "Amp",
    distribution: { kind: "binary", command: "amp-acp", args: [] },
    unreviewedBecause:
      "The registry entry is a third-party wrapper around Amp, whose modes and sign-in need a signed-in probe.",
  },
  {
    registryId: "auggie",
    name: "Auggie CLI",
    distribution: { kind: "npx", package: "@augmentcode/auggie@0.37.0", args: ["--acp"] },
    unreviewedBecause: "Its modes, sign-in folder and Project entries need a signed-in probe.",
  },
  {
    registryId: "kiro",
    name: "Kiro CLI",
    distribution: {
      kind: "binary",
      command: "kirocli/bin/kiro-cli",
      args: ["acp", "--agent-engine=v3"],
    },
    unreviewedBecause: "Its modes, sign-in folder and Project entries need a signed-in probe.",
  },
  {
    registryId: "muse-code",
    name: "Muse Code",
    distribution: { kind: "binary", command: "muse", args: ["acp"] },
    unreviewedBecause: "Its modes, sign-in folder and Project entries need a signed-in probe.",
  },
  {
    registryId: "cursor",
    name: "Cursor",
    distribution: { kind: "binary", command: "dist-package/cursor-agent", args: ["acp"] },
    unreviewedBecause:
      "Its compatibility probe through the shared ACP stack has not been run; until it is, Cursor is added as any ACP agent.",
  },
];

/**
 * Adding a registry agent the person installed: its command resolves to the
 * executable the person's install put on disk, and it starts untrusted and
 * disabled, so adding it alone lets it run nothing.
 */
export function addRegistryAcpAgent(
  agent: AcpRegistryAgent,
  installedExecutable: string,
):
  | {
      readonly status: "added";
      readonly source: AcpAgentSource;
      readonly steps: AcpAgentSteps;
    }
  | { readonly status: "refused"; readonly reason: AcpAgentCommandRefusal } {
  const args = agent.distribution.args;
  const refusal = acpAgentCommandRefusal({ command: installedExecutable, args });
  if (refusal !== undefined) return { status: "refused", reason: refusal };
  return {
    status: "added",
    source: {
      kind: "registry",
      registryId: agent.registryId,
      name: agent.name,
      command: installedExecutable,
      args,
    },
    steps: { installed: true, trusted: false, enabled: false },
  };
}
