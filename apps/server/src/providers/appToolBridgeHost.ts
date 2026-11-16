/**
 * Whether this host's confinement carries an app-managed tool bridge into an
 * OpenCode or ACP launch. The bridge is a loopback HTTP endpoint the host
 * owns. macOS opens its one port in the launch's Seatbelt profile. Linux
 * reaches it as Pi's bridge does: a launch on the shared host network (the
 * provider default) reaches loopback directly, and a proxied launch reaches
 * it through the egress forwarder's loopback relay, which opens only the
 * bridge's port (maintainer decision, 2026-11-16). Windows confinement
 * refuses a loopback relay, so the tools are not offered there.
 */
export function appToolBridgeReachesLaunchOn(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}
