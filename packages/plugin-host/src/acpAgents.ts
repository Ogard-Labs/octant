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
 * - `own`: the launch a shipped profile gets outside Strict below Full
 *   access: the agent's own settings decide what Strict would fix.
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

/**
 * Why an agent cannot be enabled yet. Enabling comes last: the person installs
 * it, then trusts it having seen what trusting grants and how its bytes were
 * checked, and only then turns it on. Untrusting an enabled agent leaves it
 * on, and it then starts in Octant's sandbox remembering nothing
 * (`decideAcpAgentLaunch`).
 */
export function acpAgentEnableRefusal(
  steps: AcpAgentSteps,
): "not-installed" | "not-trusted" | undefined {
  if (!steps.installed) return "not-installed";
  if (!steps.trusted) return "not-trusted";
  return undefined;
}

/** Why a typed-in or registry command is refused before it is ever added. */
export type AcpAgentCommandRefusal =
  | "not-absolute"
  | "control-character"
  | "too-many-arguments"
  | "secret-argument";

/** A flag or assignment that names a key, token, secret or password. */
const SECRET_ARGUMENT =
  /^(?:--?[a-z0-9_-]*(?:api[-_]?key|token|secret|password|passwd|credential)s?(?:=|$)|[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)/iu;

/**
 * A command is an absolute executable path plus literal arguments. Nothing is
 * expanded or passed to a shell, so a control character is refused outright
 * rather than escaped. The arguments are journaled with the agent, so one
 * that carries a key is refused: a key reaches an agent through its own
 * sign-in, never through Octant's record.
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
  if (source.args.some((argument) => SECRET_ARGUMENT.test(argument))) return "secret-argument";
  return undefined;
}

/**
 * How a registry distribution reaches disk. `npx` and `uvx` name a package at
 * an exact version that the package manager installs into Octant's managed
 * folder, with its own lockfile and integrity checks and with install scripts
 * off; `binary` names an archive Octant downloads over HTTPS from the URL the
 * registry lists. The registry's `sha256` is optional: an archive that has one
 * is checked against it and refused on a mismatch, and one without is
 * installed as an unverified download, which the Trust step says plainly.
 * `command` is the executable's path inside the archive.
 */
export type AcpRegistryDistribution =
  | {
      readonly kind: "npx" | "uvx";
      readonly package: string;
      readonly version: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "binary";
      readonly archive: string;
      readonly sha256?: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    };

/** One agent as the public ACP registry lists it for this host. */
export interface AcpRegistryAgent {
  readonly registryId: string;
  readonly name: string;
  /** The release the registry entry pins; an install takes exactly this one. */
  readonly version: string;
  /** The registry's distribution for Apple Silicon macOS. */
  readonly distribution: AcpRegistryDistribution;
  /** Why Octant has no reviewed profile for it yet. */
  readonly unreviewedBecause: string;
}

/**
 * The registry agents Octant was asked to make first-class, as the registry's
 * source repository `agentclientprotocol/registry` listed them at commit
 * `131167e` (2026-11-16), `darwin-aarch64` distribution. None has a signed-in
 * probe on record, so each is offered as an agent the person may add, not as
 * a reviewed profile. Trae is not in the registry at that commit; a person
 * adds it as a local command.
 */
export const ACP_REGISTRY_AGENTS: ReadonlyArray<AcpRegistryAgent> = [
  {
    registryId: "antigravity-acp",
    name: "Google Antigravity",
    version: "1.5.0",
    distribution: {
      kind: "binary",
      archive:
        "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-arm64.zip",
      sha256: "c82ecb4ef476bfc35cbe5b2745cdddef873b99c9f5bd7fd11e5ca1fc1667a3fc",
      command: "agy_acp_server.par",
      args: [],
    },
    unreviewedBecause:
      "How it signs in outside its IDE extension, and whether it runs without the IDE, needs a signed-in probe.",
  },
  {
    registryId: "factory-droid",
    name: "Factory Droid",
    version: "1.12.1",
    distribution: {
      kind: "npx",
      package: "droid",
      version: "1.12.1",
      args: ["exec", "--output-format", "acp-daemon"],
      env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    },
    unreviewedBecause:
      "Its ACP entry is a daemon output mode; its modes and sign-in folder need a signed-in probe.",
  },
  {
    registryId: "junie",
    name: "Junie",
    version: "4020.10.0",
    distribution: {
      kind: "binary",
      archive:
        "https://github.com/JetBrains/junie-acp-release/releases/download/4020.10/junie-release-4020.10-macos-aarch64.zip",
      command: "Applications/junie.app/Contents/MacOS/junie",
      args: ["--acp=true"],
    },
    unreviewedBecause:
      "Whether it launches under Seatbelt from its app bundle, and which JetBrains account state it reads, needs a signed-in probe.",
  },
  {
    registryId: "amp-acp",
    name: "Amp",
    version: "0.13.0",
    distribution: {
      kind: "binary",
      archive:
        "https://github.com/tao12345666333/amp-acp/releases/download/v0.13.0/amp-acp-darwin-aarch64.tar.gz",
      sha256: "ca3315e3e54ea85c7e5db09d19a1908cd2ea149c8e83a728cefb814c7a490edf",
      command: "amp-acp",
      args: [],
    },
    unreviewedBecause:
      "The registry entry is a third-party wrapper around Amp, whose modes and sign-in need a signed-in probe.",
  },
  {
    registryId: "auggie",
    name: "Auggie CLI",
    version: "0.37.0",
    distribution: {
      kind: "npx",
      package: "@augmentcode/auggie",
      version: "0.37.0",
      args: ["--acp"],
      env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
    },
    unreviewedBecause: "Its modes, sign-in folder and Project entries need a signed-in probe.",
  },
  {
    registryId: "kiro",
    name: "Kiro CLI",
    version: "3.0.0",
    distribution: {
      kind: "binary",
      archive: "https://prod.download.cli.kiro.dev/stable/3.0.0/kirocli-universal-darwin.tar.gz",
      sha256: "fa32d8f2054d79642922db696683630114b2cea99a2c7f655becd923afe33ccf",
      command: "kirocli/bin/kiro-cli",
      args: ["acp", "--agent-engine=v3"],
    },
    unreviewedBecause: "Its modes, sign-in folder and Project entries need a signed-in probe.",
  },
  {
    registryId: "muse-code",
    name: "Muse Code",
    version: "1.4.14",
    distribution: {
      kind: "binary",
      archive:
        "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.14-R7309.1&file=muse-aarch64-macos",
      sha256: "1c96114408acbeade9a8fb79e3b4425e5b64d50425938568aef01bdc04ce2e03",
      command: "muse",
      args: ["acp"],
      env: { MUSE_EXPERIMENTAL_ACP: "on" },
    },
    unreviewedBecause: "Its modes, sign-in folder and Project entries need a signed-in probe.",
  },
  {
    registryId: "cursor",
    name: "Cursor",
    version: "2026.11.13",
    distribution: {
      kind: "binary",
      archive:
        "https://downloads.cursor.com/lab/2026.11.13-eacade1/darwin/arm64/agent-cli-package.tar.gz",
      command: "dist-package/cursor-agent",
      args: ["acp"],
    },
    unreviewedBecause:
      "Its compatibility probe through the shared ACP stack has not been run; until it is, Cursor is added as any ACP agent.",
  },
];

export function acpRegistryAgent(registryId: string): AcpRegistryAgent | undefined {
  return ACP_REGISTRY_AGENTS.find((agent) => agent.registryId === registryId);
}

/**
 * What the install step can say about the bytes it put on disk, which the
 * Trust step shows before anything runs.
 * - `package-manager`: npm or uv installed the exact pinned release, checking
 *   it against the package registry's own integrity data.
 * - `sha256-verified`: the archive matched the ACP registry's checksum.
 * - `unverified-download`: the ACP registry lists no checksum for the
 *   archive, so only HTTPS vouches for it.
 * - `local-command`: the person's own executable, which Octant did not fetch.
 */
export type AcpAgentInstallIntegrity =
  | "package-manager"
  | "sha256-verified"
  | "unverified-download"
  | "local-command";

/**
 * Adding a registry agent the person installed: its command resolves to the
 * executable the install put on disk, and it starts untrusted and disabled,
 * so adding it alone lets it run nothing.
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
