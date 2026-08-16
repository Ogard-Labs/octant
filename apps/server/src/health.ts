export interface HostActivity {
  readonly activeAgentCount: number;
  readonly attentionRequired: boolean;
}

export function healthResponse(
  version: string,
  instanceId?: string,
  developmentWebBootstrap?: true,
  activity?: HostActivity,
): Response {
  return Response.json({
    product: "Octant",
    status: "ok",
    storage: "ready",
    version,
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(developmentWebBootstrap === undefined ? {} : { developmentWebBootstrap }),
    ...(activity === undefined ? {} : activity),
  });
}
