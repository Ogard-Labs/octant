import type { DesktopProviderSetupReason } from "@octant/contracts";
import type { DesktopProvider } from "@octant/plugin-api/desktop-provider";
import type { RegisteredDesktopProvider } from "./desktopLeaseService";

export interface BundledDesktopProvidersInput {
  /** The host-local driver with whether its programs were ready as the host started; absent off Linux. */
  readonly hostLocal?: { readonly provider: DesktopProvider; readonly ready: boolean };
  /** The cloud driver for an account the person keeps a key for. */
  readonly cloud: DesktopProvider;
  /** The driver for the person's own daemon; absent where the host cannot reach one. */
  readonly daemon?: DesktopProvider;
  /** Whether the host has a credential store to keep a cloud account's key in. */
  readonly credentialStore: () => boolean;
  /** Whether the person's daemon socket is there now. Asks the daemon nothing. */
  readonly daemonReady: () => boolean;
}

/**
 * The desktop drivers a host loads, and which of them it offers.
 *
 * Every bundled driver is listed from the first start, a daemon-run one
 * included: a recipe can name only a provider the host lists, so a driver
 * listed only after its first lease could never be leased. The lease service
 * keeps a daemon-run driver quiet until a lease of it is journaled, so
 * listing it makes no call to the person's daemon.
 *
 * Offering a provider is not enabling it. A person opts in by saving a recipe
 * that names it, and a provider whose setup is missing is listed with the
 * reason and starts nothing. A billed desktop still asks the person first.
 */
export function bundledDesktopProviders(
  input: BundledDesktopProvidersInput,
): () => ReadonlyArray<RegisteredDesktopProvider> {
  const setup = (provider: DesktopProvider): DesktopProviderSetupReason | undefined => {
    if (provider.daemon !== undefined) {
      return input.daemonReady() ? undefined : "daemon-not-connected";
    }
    if (provider.locality === "cloud") {
      return input.credentialStore() ? undefined : "no-credential-store";
    }
    return undefined;
  };
  return () => {
    const entries: Array<RegisteredDesktopProvider> = [];
    if (input.hostLocal !== undefined) {
      entries.push({ provider: input.hostLocal.provider, effective: input.hostLocal.ready });
    }
    for (const provider of [input.cloud, ...(input.daemon === undefined ? [] : [input.daemon])]) {
      const needsSetup = setup(provider);
      entries.push({
        provider,
        effective: true,
        ...(needsSetup === undefined ? {} : { needsSetup }),
      });
    }
    return entries;
  };
}
