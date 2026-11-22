import type { ShellSettings } from "@octant/contracts";
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
 * The person's two switches in Settings › Providers & Models, and the host
 * credentials they let through to this provider (by driver kind).
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
