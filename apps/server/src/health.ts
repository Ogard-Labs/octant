export interface HostActivity {
  readonly activeAgentCount: number;
  readonly attentionRequired: boolean;
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
