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
    rings: ["stable"],
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
    rings: ["preview", "candidate"],
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

/** Local packages default to stable; release automation must select its flavor explicitly. */
export function resolveDesktopPackageFlavor(
  environment: Readonly<Record<string, string | undefined>>,
  version: string,
): DesktopFlavor {
  const flavor = environment.OCTANT_PACKAGE_FLAVOR ?? "stable";
  const identity = desktopIdentity(flavor);
  const prerelease = version.includes("-");
  if ((flavor === "nightly") !== prerelease) {
    throw new TypeError("Stable versions require Octant; prerelease versions require Octant Nightly.");
  }
  if (prerelease && !/^\d+\.\d+\.\d+-(preview|candidate)\.\d{8}\.\d+$/.test(version)) {
    throw new TypeError("Octant Nightly requires a dated preview or candidate version.");
  }
  return identity.flavor;
}
