/**
 * Whether this host's launches reach an app-managed tool bridge in an
 * OpenCode or ACP launch. The bridge is a loopback HTTP endpoint the host
 * owns, opened only with its per-bridge bearer token. macOS opens its one port
 * in the launch's Seatbelt profile. Linux reaches it as Pi's bridge does: a
 * launch on the shared host network (the provider default) reaches loopback
 * directly, and a proxied launch reaches it through the egress forwarder's
 * loopback relay, which opens only the bridge's port (maintainer decision,
 * 2026-11-16). A Windows launch runs with no Octant sandbox, so it reaches
 * loopback directly; no relay, socket or pipe stands between them.
 */
export function appToolBridgeReachesLaunchOn(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}
