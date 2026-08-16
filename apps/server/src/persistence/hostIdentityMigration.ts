import type { SqliteConnection } from "./sqlitePort";
import { decodeStableHostId } from "@octant/contracts/remote-access";

export interface HostIdentityKeyStore {
  readonly ensureKey: (hostId: string) => Promise<{ readonly fingerprint: string }>;
}

type HostPayloadTransform = (payload: unknown, fromHostId: string, toHostId: string) => unknown;

export class HostIdentityMigrationFailed extends Error {
  constructor() {
    super("Octant host identity recovery is required.");
    this.name = "HostIdentityMigrationFailed";
  }
}

export class HostIdentityMigrationRegistry {
  readonly #transforms = new Map<string, HostPayloadTransform>();

  registerEnvelopeOnly(
    registrations: ReadonlyArray<{
      readonly eventName: string;
      readonly eventVersion: number;
    }>,
  ): this {
    for (const registration of registrations) {
      this.register(registration.eventName, registration.eventVersion, (payload) => payload);
    }
    return this;
  }

  register(eventName: string, eventVersion: number, transform: HostPayloadTransform): this {
    this.#transforms.set(`${eventName}@${eventVersion}`, transform);
    return this;
  }

  has(eventName: string, eventVersion: number): boolean {
    return this.#transforms.has(`${eventName}@${eventVersion}`);
  }

  transform(
    eventName: string,
    eventVersion: number,
    payload: unknown,
    fromHostId: string,
    toHostId: string,
  ): unknown {
    const transform = this.#transforms.get(`${eventName}@${eventVersion}`);
    if (transform === undefined) throw new HostIdentityMigrationFailed();
    return transform(payload, fromHostId, toHostId);
  }
}

export async function migrateLegacyHostIdentity(input: {
  readonly connection: SqliteConnection;
  readonly keyStore: HostIdentityKeyStore;
  readonly hostId: string;
  readonly displayName: string;
  readonly clock: () => string;
  readonly registry: HostIdentityMigrationRegistry;
  readonly beforeCommit?: () => void;
}): Promise<{ readonly hostId: string; readonly keyFingerprint: string }> {
  try {
    decodeStableHostId(input.hostId);
  } catch {
    throw new HostIdentityMigrationFailed();
  }
  let keyFingerprint: string;
  try {
    keyFingerprint = (await input.keyStore.ensureKey(input.hostId)).fingerprint;
  } catch {
    throw new HostIdentityMigrationFailed();
  }
  if (!/^[0-9a-f]{64}$/.test(keyFingerprint)) throw new HostIdentityMigrationFailed();

  try {
    input.connection.transaction(() => {
      const existing = input.connection
        .prepare(
          "SELECT host_id, key_fingerprint FROM host_identity_projection WHERE identity_key = 'host'",
        )
        .get() as { host_id: string; key_fingerprint: string } | undefined;
      if (
        existing !== undefined &&
        (existing.host_id !== input.hostId || existing.key_fingerprint !== keyFingerprint)
      ) {
        throw new HostIdentityMigrationFailed();
      }
      const rows = input.connection
        .prepare(
          "SELECT event_id, event_name, event_version, host_id, payload_json FROM event_journal ORDER BY global_sequence",
        )
        .all() as ReadonlyArray<{
        event_id: string;
        event_name: string;
        event_version: number;
        host_id: string;
        payload_json: string;
      }>;
      for (const row of rows) {
        if (row.host_id === input.hostId) continue;
        if (row.host_id !== "local") throw new HostIdentityMigrationFailed();
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          throw new HostIdentityMigrationFailed();
        }
        const migratedPayload = input.registry.transform(
          row.event_name,
          row.event_version,
          payload,
          "local",
          input.hostId,
        );
        input.connection
          .prepare("UPDATE event_journal SET host_id = ?, payload_json = ? WHERE event_id = ?")
          .run(input.hostId, JSON.stringify(migratedPayload), row.event_id);
      }
      input.connection
        .prepare(
          `INSERT INTO host_identity_projection (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at, rotated_at) VALUES ('host', ?, ?, ?, 1, ?, NULL) ON CONFLICT(identity_key) DO UPDATE SET host_id = excluded.host_id, display_name = excluded.display_name, key_fingerprint = excluded.key_fingerprint`,
        )
        .run(input.hostId, input.displayName, keyFingerprint, input.clock());
      input.beforeCommit?.();
    })();
  } catch (error) {
    if (error instanceof HostIdentityMigrationFailed) throw error;
    throw new HostIdentityMigrationFailed();
  }
  return { hostId: input.hostId, keyFingerprint };
}

export async function initializeFreshHostIdentity(input: {
  readonly connection: SqliteConnection;
  readonly keyStore: HostIdentityKeyStore;
  readonly hostId: string;
  readonly displayName: string;
  readonly clock: () => string;
}): Promise<{ readonly hostId: string; readonly keyFingerprint: string }> {
  const eventCount = input.connection
    .prepare("SELECT count(*) AS count FROM event_journal")
    .get() as {
    readonly count: number;
  };
  if (eventCount.count !== 0) throw new HostIdentityMigrationFailed();
  return migrateLegacyHostIdentity({
    ...input,
    registry: new HostIdentityMigrationRegistry(),
  });
}
