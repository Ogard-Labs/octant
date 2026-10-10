// The remembered private listener setting.
//
// A listener enabled from the host's local administration channel (Settings
// or the `octant listener` command) comes back after the server restarts. A
// headless host has nobody at a desktop to turn it on again, and without it
// no paired device can reach the host or finish pairing.
//
// The setting holds the exact config the host last enabled, including the TLS
// private key, because the administration routes receive PEMs rather than
// paths and the server reads no file a caller names. It lives under the local
// data directory with owner-only permissions — the same boundary that already
// holds the listener's host identity key — and is never returned by a route.
// Only a deliberate disable from the administration channel forgets it; a
// server shutdown stops the listener without forgetting it.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrivateListenerConfig } from "../privateListener";

const SETTING_SUBDIR = "remote";
const SETTING_FILE = "private-listener-setting.json";

export interface PrivateListenerSettingPort {
  readonly load: () => PrivateListenerConfig | undefined;
  readonly save: (config: PrivateListenerConfig) => void;
  readonly clear: () => void;
}

export function createPrivateListenerSetting(dataDirectory: string): PrivateListenerSettingPort {
  const directory = join(dataDirectory, SETTING_SUBDIR);
  const path = join(directory, SETTING_FILE);
  return {
    load: () => {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      return decodeSetting(text);
    },
    save: (config) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const staging = `${path}.${process.pid}.tmp`;
      writeFileSync(
        staging,
        JSON.stringify({
          hostname: config.hostname,
          port: config.port,
          origin: config.origin,
          certificatePem: String(config.tls.cert),
          privateKeyPem: String(config.tls.key),
        }),
        { mode: 0o600 },
      );
      // writeFileSync applies the mode only when it creates the file, so a
      // staging file left behind by a crashed save is narrowed here too.
      chmodSync(staging, 0o600);
      renameSync(staging, path);
    },
    clear: () => {
      rmSync(path, { force: true });
    },
  };
}

/** A setting that cannot be read back exactly is treated as no setting: the listener stays off. */
function decodeSetting(text: string): PrivateListenerConfig | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { hostname, port, origin, certificatePem, privateKeyPem } = record;
  if (
    typeof hostname !== "string" ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    typeof origin !== "string" ||
    typeof certificatePem !== "string" ||
    typeof privateKeyPem !== "string"
  ) {
    return undefined;
  }
  return { hostname, port, origin, tls: { cert: certificatePem, key: privateKeyPem } };
}
