export interface HostActivity {
  readonly activeAgentCount: number;
  readonly attentionRequired: boolean;
  /** A category, never a provider's name: this route is unauthenticated. */
  readonly attentionReason?: "provider-not-ready" | "provider-stopped";
}

export function healthResponse(
  version: string,
  instanceId?: string,
  activity?: HostActivity,
  canvasPreviewPage?: boolean,
): Response {
  return Response.json({
    product: "Octant",
    status: "ok",
    storage: "ready",
    version,
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(activity === undefined ? {} : activity),
    // Whether this host finds the Canvas preview page, so a launcher that
    // attached to it can tell a host started without the web build path.
    ...(canvasPreviewPage === undefined ? {} : { canvasPreviewPage }),
  });
}

/** What `/health` says about work and attention, read from the provider registry. */
export function hostActivity(registry: {
  activeSessionTotal(): number;
  attentionReason(): HostActivity["attentionReason"];
}): HostActivity {
  const attentionReason = registry.attentionReason();
  return {
    activeAgentCount: registry.activeSessionTotal(),
    attentionRequired: attentionReason !== undefined,
    ...(attentionReason === undefined ? {} : { attentionReason }),
  };
}
