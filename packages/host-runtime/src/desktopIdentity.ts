import { join } from "node:path";

export type DesktopFlavor = "stable" | "nightly";

export const DESKTOP_FLAVOR_IDENTITIES = {
  stable: {
    flavor: "stable",
    productName: "Octant",
    bundleId: "app.octant.desktop",
    scheme: "octant",
    commandName: "octant",
    windowStorageName: "Octant",
    mayStartHost: true,
    rings: ["stable", "candidate"],
    defaultRing: "stable",
  },
  nightly: {
    flavor: "nightly",
    productName: "Octant Nightly",
    bundleId: "app.octant.desktop.nightly",
    scheme: "octant-nightly",
    commandName: "octant-nightly",
    windowStorageName: "Octant Nightly",
    mayStartHost: false,
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
