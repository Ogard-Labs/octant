import { isAbsolute, join, resolve, sep } from "node:path";

export type DesktopFlavor = "stable" | "nightly";

export const DESKTOP_FLAVOR_IDENTITIES = {
  stable: {
    flavor: "stable",
    productName: "Octant",
    /** The app its signed update feeds name. */
    updateProduct: "octant",
    bundleId: "app.octant.desktop",
    scheme: "octant",
    commandName: "octant",
    windowStorageName: "Octant",
    mayStartHost: true,
    testHost: null,
    rings: ["stable", "candidate"],
    defaultRing: "stable",
  },
  nightly: {
    flavor: "nightly",
    productName: "Octant Nightly",
    updateProduct: "octant-nightly",
    bundleId: "app.octant.desktop.nightly",
    scheme: "octant-nightly",
    commandName: "octant-nightly",
    windowStorageName: "Octant Nightly",
    mayStartHost: false,
    // Nightly's own host for development and testing: never Octant's data
    // folder, port or Keychain items. It starts only from the stored choice.
    testHost: {
      darwinDataDirectory: ["Library", "Application Support", "Octant Nightly", "Test Data"],
      linuxDataDirectory: ["octant-nightly", "test-data"],
      serverPort: 13_774,
      keychainServiceFamily: "octant-nightly-test-data",
    },
    rings: ["preview"],
    defaultRing: "preview",
  },
} as const;

export type DesktopIdentity = (typeof DESKTOP_FLAVOR_IDENTITIES)[DesktopFlavor];

export function desktopIdentity(flavor: unknown): DesktopIdentity {
  if (flavor !== "stable" && flavor !== "nightly") {
    throw new TypeError("This Octant package has no recognized application identity.");
  }
  return DESKTOP_FLAVOR_IDENTITIES[flavor];
}

export function desktopIdentityForPackage(value: unknown): DesktopIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("This Octant package has no recognized application identity.");
  }
  const manifest = value as Readonly<Record<string, unknown>>;
  const identity = desktopIdentity(manifest.octantDesktopFlavor);
  if (typeof manifest.version !== "string")
    throw new TypeError("This Octant package has no version.");
  resolveDesktopPackageFlavor({ OCTANT_PACKAGE_FLAVOR: identity.flavor }, manifest.version);
  return identity;
}

export function desktopWindowStorageDirectory(
  identity: DesktopIdentity,
  hostDataDirectory: string,
  appDataDirectory: string,
): string {
  return identity.flavor === "stable"
    ? hostDataDirectory
    : join(appDataDirectory, identity.windowStorageName);
}

/** Local packages default to stable; release automation must select its flavor explicitly. */
export function resolveDesktopPackageFlavor(
  environment: Readonly<Record<string, string | undefined>>,
  version: string,
): DesktopFlavor {
  const flavor = environment.OCTANT_PACKAGE_FLAVOR ?? "stable";
  const identity = desktopIdentity(flavor);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(preview|candidate)\.\d{8}\.(0|[1-9]\d*))?$/.test(
      version,
    )
  ) {
    throw new TypeError("This Octant package has no valid release version.");
  }
  const nightlyVersion = version.includes("-preview.");
  if ((flavor === "nightly") !== nightlyVersion) {
    throw new TypeError(
      "Stable and candidate versions require Octant; preview versions require Octant Nightly.",
    );
  }
  return identity.flavor;
}

/**
 * Which set of macOS Keychain service names a host's credentials live under.
 * Nightly's own test host keeps its items apart from Octant's.
 */
export type KeychainServiceFamily = "octant" | "octant-nightly-test-data";

/** Set by the desktop for its host child; absent means Octant's own services. */
export const KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT = "OCTANT_KEYCHAIN_SERVICE_FAMILY";

/** Set by the desktop for its host child; absent means `~/Octant`. */
export const DEFAULT_FOLDER_ENVIRONMENT = "OCTANT_DEFAULT_FOLDER";

/** An unset value is Octant's family; any value but the two names is refused. */
export function decodeKeychainServiceFamily(
  value: string | undefined,
): KeychainServiceFamily | undefined {
  if (value === undefined || value === "octant") return "octant";
  return value === "octant-nightly-test-data" ? value : undefined;
}

/** The prefix every Keychain service name of a family starts with. */
export function keychainServicePrefix(family: KeychainServiceFamily): string {
  return family === "octant" ? "app.octant." : "app.octant.desktop.nightly.test-data.";
}

/** Nightly's window-storage file that holds the Data choice. */
export const DESKTOP_DATA_CHOICE_FILE = "data-choice.json";

export type DesktopDataChoice = "octant" | "test-data";

/**
 * Anything but an exact `{"data":"test-data"}` is Octant's data: a missing,
 * malformed or unreadable choice never starts a host.
 */
export function decodeDesktopDataChoice(raw: string | undefined): DesktopDataChoice {
  if (raw === undefined) return "octant";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "octant";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "octant";
  const keys = Object.keys(value);
  return keys.length === 1 &&
    keys[0] === "data" &&
    (value as Readonly<Record<string, unknown>>).data === "test-data"
    ? "test-data"
    : "octant";
}

export function encodeDesktopDataChoice(choice: DesktopDataChoice): string {
  return `${JSON.stringify({ data: choice })}\n`;
}

export type DesktopHostRole =
  /** Octant owns its host on Octant's data. */
  | { readonly kind: "octant-host" }
  /** Nightly connects to Octant's host and never starts one. */
  | { readonly kind: "octant-client" }
  /** Nightly owns a host of its own on its test data. */
  | {
      readonly kind: "test-host";
      readonly dataDirectory: string;
      readonly serverPort: number;
      readonly keychainServiceFamily: "octant-nightly-test-data";
    };

/** Decided once at startup by the main process, never from renderer input. */
export function resolveDesktopHostRole(
  identity: DesktopIdentity,
  choice: DesktopDataChoice,
  location: {
    readonly platform: NodeJS.Platform;
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): DesktopHostRole {
  if (identity.testHost === null) return { kind: "octant-host" };
  if (choice !== "test-data") return { kind: "octant-client" };
  return {
    kind: "test-host",
    dataDirectory: nightlyTestDataDirectory(identity.testHost, location),
    serverPort: identity.testHost.serverPort,
    keychainServiceFamily: identity.testHost.keychainServiceFamily,
  };
}

function nightlyTestDataDirectory(
  testHost: NonNullable<DesktopIdentity["testHost"]>,
  location: {
    readonly platform: NodeJS.Platform;
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): string {
  if (!isAbsolute(location.home)) throw new TypeError("Octant Nightly needs an absolute home.");
  if (location.platform === "darwin") return join(location.home, ...testHost.darwinDataDirectory);
  if (location.platform !== "linux")
    throw new TypeError(`Octant Nightly has no test data on ${location.platform}.`);
  // The same XDG rule the host-runtime path resolver applies to Octant's data.
  const xdg = location.env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && xdg !== "" && xdg.trim() === xdg && isAbsolute(xdg)
      ? resolve(xdg)
      : join(location.home, ".local", "share");
  return join(base, ...testHost.linuxDataDirectory);
}

/** True when either folder is the other or lies inside it, compared by path segments. */
export function desktopDataDirectoriesOverlap(first: string, second: string): boolean {
  const a = resolve(first);
  const b = resolve(second);
  return (
    a === b ||
    a.startsWith(b.endsWith(sep) ? b : b + sep) ||
    b.startsWith(a.endsWith(sep) ? a : a + sep)
  );
}
