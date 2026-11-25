import type { ProviderExecutionPolicy, ShellSettings } from "@octant/contracts";
import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
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
 * list of host credentials let through to this provider (by driver kind).
 * No launch environment reads that list any more: outside Strict the person's
 * credentials reach every provider, and Strict keeps its fixed list
 * (maintainer decision, 2026-11-25). It still travels with the channels, so a
 * driver that keys a kept process on it keeps doing so.
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

/** What decides whether a launch reads the pass-through list at all. */
export interface CredentialLaunchPosture {
  readonly strict: boolean;
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The thread keeps its sandbox at Full access. */
  readonly fullAccessSandbox: boolean;
  /** The launch runs under an explicit sandbox policy. */
  readonly sandboxPolicy: boolean;
}

/**
 * Whether a launch of this driver kind and posture builds the environment a
 * launch outside Strict gets, as each driver decides it: the person's own
 * environment, and the telemetry and self-update switches, which close
 * wherever this refuses. The stored pass-through list is keyed on the same
 * answer (`launchCredentialsKey`). Strict never does. Claude Code and the
 * ACP agents also build the Strict environment for a thread that keeps or
 * chose a sandbox (`claudeDriver` closes its own channels there; `acpProcess`
 * sets `environmentStrict`), an ACP agent only at Full access, where its
 * driver passes the kept sandbox on. Codex and Pi read only Strict.
 */
export function credentialPassThroughApplies(
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
 * The credentials a launch of this posture actually lets through, as one
 * comparable string, so a kept session launched with other grants is told
 * apart and one whose grants did not change is left alone. A posture that
 * discards the list, or a thread whose provider is gone, lets nothing
 * through.
 */
export function launchCredentialsKey(
  settings: Pick<ShellSettings, "providerCredentialPassThrough"> | undefined,
  driverKind: string | undefined,
  posture: CredentialLaunchPosture,
): string {
  const names =
    driverKind === undefined || !credentialPassThroughApplies(driverKind, posture)
      ? []
      : providerCredentialPassThrough(settings, driverKind);
  return JSON.stringify([...new Set(names)].sort());
}

/** The host credentials the person lets through to a provider of this driver kind. */
export function providerCredentialPassThrough(
  settings: Pick<ShellSettings, "providerCredentialPassThrough"> | undefined,
  driverKind: string,
): ReadonlyArray<string> {
  const lists = settings?.providerCredentialPassThrough;
  return lists !== undefined && Object.hasOwn(lists, driverKind) ? (lists[driverKind] ?? []) : [];
}

/**
 * The channels one launch opens. Strict closes both whatever the person
 * chose, so a Strict launch keeps every telemetry and self-update guard.
 */
export function launchOwnChannels(
  strict: boolean,
  chosen: ProviderOwnChannels | undefined,
): ProviderOwnChannels {
  if (strict) return CLOSED_PROVIDER_OWN_CHANNELS;
  return chosen ?? DEFAULT_PROVIDER_OWN_CHANNELS;
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
