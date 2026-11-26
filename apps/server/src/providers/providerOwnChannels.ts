import type { ProviderExecutionPolicy, ShellSettings } from "@octant/contracts";
import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
import { MODEL_PROVIDER_CREDENTIAL_VARIABLES } from "@octant/domain";
import type { ProviderDriver, ProviderOwnChannels } from "@octant/provider-sdk";
import { Effect } from "effect";

/**
 * What a launch outside Strict carries when nothing says otherwise: both
 * channels closed, as the person's switches default. Telemetry stays off
 * because Octant sends nothing to a vendor the person did not turn on, and
 * self-update because Octant installs and updates provider CLIs itself.
 */
export const DEFAULT_PROVIDER_OWN_CHANNELS: ProviderOwnChannels = {
  telemetry: false,
  selfUpdate: false,
};

const CLOSED_PROVIDER_OWN_CHANNELS: ProviderOwnChannels = { telemetry: false, selfUpdate: false };

/**
 * The person's two switches in Settings › Providers & Models, and the stored
 * list of host variables let through to this provider (by driver kind). Only
 * a Strict launch reads that list, adding its names to the provider's fixed
 * Strict list; outside Strict the person's environment already reaches every
 * provider (maintainer decision, 2026-11-25).
 */
export function providerOwnChannelsFromSettings(
  settings: Pick<
    ShellSettings,
    "providerTelemetry" | "providerSelfUpdate" | "providerCredentialPassThrough"
  >,
  driverKind: string,
): ProviderOwnChannels {
  const credentialPassThrough = providerCredentialPassThrough(settings, driverKind);
  return {
    telemetry: settings.providerTelemetry,
    selfUpdate: settings.providerSelfUpdate,
    ...(credentialPassThrough.length === 0 ? {} : { credentialPassThrough }),
  };
}

/** What decides which environment a launch builds. */
export interface CredentialLaunchPosture {
  readonly strict: boolean;
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The thread keeps its sandbox at Full access. */
  readonly fullAccessSandbox: boolean;
  /** The launch runs under an explicit sandbox policy. */
  readonly sandboxPolicy: boolean;
}

/**
 * Whether a launch of this driver kind and posture reads the person's
 * telemetry and self-update switches, as each driver decides it; they close
 * wherever this refuses. Strict never does. Claude Code and the ACP agents
 * also close them for a thread that keeps or chose a sandbox (`claudeDriver`
 * closes its own channels there; `acpProcess` sets `environmentStrict`), an
 * ACP agent only at Full access, where its driver passes the kept sandbox on.
 */
export function providerSwitchesApply(
  driverKind: string,
  posture: CredentialLaunchPosture,
): boolean {
  if (posture.strict) return false;
  if (driverKind === "claude") return !posture.fullAccessSandbox && !posture.sandboxPolicy;
  if (isAcpAgentKind(driverKind) || driverKind === "acp-agent") {
    const keptSandbox = posture.executionPolicy === "full-access" && posture.fullAccessSandbox;
    return !keptSandbox && !posture.sandboxPolicy;
  }
  return true;
}

/**
 * The host variables a launch of this posture adds to its fixed list, as one
 * comparable string, so a kept Strict session launched with another list is
 * told apart and one whose list did not change is left alone. Outside Strict
 * the list changes nothing a launch receives, so every such session compares
 * equal whatever the list holds. A thread whose provider is gone adds none.
 */
export function launchCredentialsKey(
  settings: Pick<ShellSettings, "providerCredentialPassThrough"> | undefined,
  driverKind: string | undefined,
  posture: CredentialLaunchPosture,
): string {
  const names =
    driverKind === undefined || !posture.strict
      ? []
      : providerCredentialPassThrough(settings, driverKind);
  return JSON.stringify([...new Set(names)].sort());
}

/** The host variables the person lets through to a Strict provider of this driver kind. */
export function providerCredentialPassThrough(
  settings: Pick<ShellSettings, "providerCredentialPassThrough"> | undefined,
  driverKind: string,
): ReadonlyArray<string> {
  const lists = settings?.providerCredentialPassThrough;
  return lists !== undefined && Object.hasOwn(lists, driverKind) ? (lists[driverKind] ?? []) : [];
}

/**
 * The channels one launch opens, and the let-through list it reads. Strict
 * closes both channels whatever the person chose, so a Strict launch keeps
 * every telemetry and self-update guard, and carries the list its fixed
 * environment adds. Outside Strict the list is dropped: the launch already
 * receives the person's environment, and a process keyed on these channels
 * must not restart for a list that changes nothing it gets.
 */
export function launchOwnChannels(
  strict: boolean,
  chosen: ProviderOwnChannels | undefined,
): ProviderOwnChannels {
  if (strict) {
    const letThrough = chosen?.credentialPassThrough ?? [];
    return letThrough.length === 0
      ? CLOSED_PROVIDER_OWN_CHANNELS
      : { ...CLOSED_PROVIDER_OWN_CHANNELS, credentialPassThrough: letThrough };
  }
  const { credentialPassThrough: _strictOnly, ...channels } =
    chosen ?? DEFAULT_PROVIDER_OWN_CHANNELS;
  return channels;
}

/**
 * The names a Strict launch adds to its provider's fixed list. Settings
 * refuses Octant's own variables and every model provider's key
 * (`hostCredentialPassThroughRefusal`), but a stored list is not trusted to
 * hold only what Settings admits today: a name that joined the model-provider
 * table after it was stored still never crosses.
 */
export function strictLetThroughNames(
  letThrough: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return new Set(
    (letThrough ?? []).filter((name) => {
      const upper = name.toUpperCase();
      return !upper.startsWith("OCTANT_") && !MODEL_PROVIDER_CREDENTIAL_VARIABLES.has(upper);
    }),
  );
}

/**
 * The host's values for {@link strictLetThroughNames}, for a Strict launch to
 * lay under its fixed list, so the launch's own variables and guards win over
 * a name the person let through.
 */
export function strictLetThroughEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  letThrough: ReadonlyArray<string> | undefined,
): NodeJS.ProcessEnv {
  const names = strictLetThroughNames(letThrough);
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(([key, value]) => value !== undefined && names.has(key)),
  );
}

/** A provider's guards sorted by the channel each one closes. */
export interface ProviderChannelGuardNames {
  readonly telemetry?: ReadonlyArray<string>;
  readonly selfUpdate?: ReadonlyArray<string>;
}

/** The guards a launch keeps: those of every channel the launch leaves closed. */
export function guardsForOwnChannels(
  guards: Readonly<Record<string, string>>,
  names: ProviderChannelGuardNames,
  channels: ProviderOwnChannels,
): Readonly<Record<string, string>> {
  const opened = new Set([
    ...(channels.telemetry ? (names.telemetry ?? []) : []),
    ...(channels.selfUpdate ? (names.selfUpdate ?? []) : []),
  ]);
  return Object.fromEntries(Object.entries(guards).filter(([name]) => !opened.has(name)));
}

/**
 * Stamps the person's current choice on every session start and resume,
 * read at each one, so a changed switch reaches the next launch. A caller
 * that already chose for a session keeps its own choice.
 */
export function withProviderOwnChannels(
  driver: ProviderDriver,
  current: () => ProviderOwnChannels,
): ProviderDriver {
  const choiceFor = (own: ProviderOwnChannels | undefined) =>
    own === undefined ? { ownChannels: current() } : {};
  return {
    ...driver,
    acquire: (input) =>
      driver.acquire(input).pipe(
        Effect.map((connection) => ({
          ...connection,
          start: (start) => connection.start({ ...start, ...choiceFor(start.ownChannels) }),
          resume: (resume) => connection.resume({ ...resume, ...choiceFor(resume.ownChannels) }),
        })),
      ),
  };
}
