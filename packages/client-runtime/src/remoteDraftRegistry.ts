export interface RemoteDraftRegistry {
  readonly read: () => string;
  readonly write: (value: string) => void;
  readonly clear: () => void;
}

/**
 * In-memory composer draft that survives stale/reconnect transitions. Drafts are
 * cleared only on explicit reset — authority-bearing mutations are never queued
 * while offline.
 */
export function createRemoteDraftRegistry(): RemoteDraftRegistry {
  let draft = "";
  return {
    read: () => draft,
    write: (value: string) => {
      draft = value;
    },
    clear: () => {
      draft = "";
    },
  };
}
