export interface HostRuntimeDiagnostics {
  readonly identity: {
    readonly hostId: string;
    readonly instanceId: string;
    readonly endpoint: string;
    readonly serviceMode: string;
  };
  readonly version: {
    readonly server: string;
    readonly wire: string;
  };
  readonly store: {
    readonly state: string;
    readonly integrity: string;
  };
  readonly replay: {
    readonly journalHead: number;
    readonly projections: number;
  };
  readonly clients: {
    readonly connected: number;
  };
  readonly capabilities: ReadonlyArray<string>;
  readonly work: {
    readonly active: number;
    readonly attentionRequired: boolean;
  };
  readonly uptimeSeconds?: number;
}

export function boundHostRuntimeDiagnostics(input: HostRuntimeDiagnostics): HostRuntimeDiagnostics {
  return {
    identity: {
      hostId: input.identity.hostId.slice(0, 64),
      instanceId: input.identity.instanceId.slice(0, 64),
      endpoint: input.identity.endpoint.slice(0, 255),
      serviceMode: input.identity.serviceMode.slice(0, 32),
    },
    version: {
      server: input.version.server.slice(0, 64),
      wire: input.version.wire.slice(0, 64),
    },
    store: {
      state: input.store.state.slice(0, 32),
      integrity: input.store.integrity.slice(0, 32),
    },
    replay: {
      journalHead: boundCount(input.replay.journalHead),
      projections: boundCount(input.replay.projections),
    },
    clients: { connected: boundCount(input.clients.connected) },
    capabilities: [...new Set(input.capabilities.map((item) => item.slice(0, 64)))].slice(0, 64),
    work: {
      active: boundCount(input.work.active),
      attentionRequired: input.work.attentionRequired === true,
    },
    ...(input.uptimeSeconds === undefined
      ? {}
      : { uptimeSeconds: boundUptime(input.uptimeSeconds) }),
  };
}

function boundCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function boundUptime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 31_536_000) : 0;
}
