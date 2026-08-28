import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IntegrationAccount } from "@octant/contracts/integration";
import type { IntegrationConnectionState } from "./integrationOAuth";

export interface IntegrationConnectionStore {
  readonly read: () => IntegrationConnectionState | undefined;
  readonly write: (state: IntegrationConnectionState | undefined) => void;
}

export function createMemoryConnectionStore(
  initial?: IntegrationConnectionState,
): IntegrationConnectionStore {
  let current = initial;
  return {
    read: () => current,
    write: (state) => {
      current = state;
    },
  };
}

/**
 * Durable non-secret connection facts for an integration. Tokens never live
 * here; this only records whether OAuth expired so a personal API key cannot
 * silently take over after a restart.
 */
export function createFileConnectionStore(filePath: string): IntegrationConnectionStore {
  let current = readState(filePath);
  return {
    read: () => current,
    write: (state) => {
      current = state;
      writeState(filePath, state);
    },
  };
}

function readState(filePath: string): IntegrationConnectionState | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return decodeState(raw);
  } catch {
    return undefined;
  }
}

function writeState(filePath: string, state: IntegrationConnectionState | undefined): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    if (state === undefined) {
      writeFileSync(filePath, "null\n", { mode: 0o600 });
      return;
    }
    writeFileSync(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
    // Connection facts are advisory for reconnect; secret material lives in
    // the credential vault. A failed write must not block disconnect.
  }
}

function decodeState(value: unknown): IntegrationConnectionState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("source" in value) || (value.source !== "oauth" && value.source !== "personal-api-key")) {
    return undefined;
  }
  if (!("reconnectRequired" in value) || typeof value.reconnectRequired !== "boolean") {
    return undefined;
  }
  const account = "account" in value ? decodeAccount(value.account) : undefined;
  return {
    source: value.source,
    reconnectRequired: value.reconnectRequired,
    ...(account === undefined ? {} : { account }),
  };
}

function decodeAccount(value: unknown): IntegrationAccount | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("login" in value) || typeof value.login !== "string" || value.login.length === 0) {
    return undefined;
  }
  if (!("source" in value) || typeof value.source !== "string" || value.source.length === 0) {
    return undefined;
  }
  if (!("scopes" in value) || !Array.isArray(value.scopes)) return undefined;
  const scopes = value.scopes.filter((item): item is string => typeof item === "string");
  return { login: value.login, source: value.source, scopes };
}
