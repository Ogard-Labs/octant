// The host's Notifications setting for paired phones: whether the host sends
// through a push gateway at all, and which one.
//
// It is off by default, so no request reaches a gateway until the person turns
// it on at this computer. The setting holds no secret (an address and a
// switch), but it lives owner-only beside the push registrations it governs,
// and removing all local data deletes it with them so a fresh store starts off.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REMOTE_PUSH_GATEWAY_DEFAULT_URL,
  decodeRemotePushGatewaySettingsV1,
  type RemotePushGatewaySettingsV1,
  type SetRemotePushGatewaySettingsV1,
} from "@octant/contracts/remote-push-notifications";

export const PUSH_GATEWAY_SETTING_FILE = join("remote", "push-gateway-setting.json");

export type PushGatewaySettingChange =
  | { readonly kind: "changed"; readonly settings: RemotePushGatewaySettingsV1 }
  | { readonly kind: "stale-version"; readonly settings: RemotePushGatewaySettingsV1 }
  | { readonly kind: "unavailable"; readonly settings: RemotePushGatewaySettingsV1 };

export interface PushGatewaySettingPort {
  readonly current: () => RemotePushGatewaySettingsV1;
  readonly change: (command: SetRemotePushGatewaySettingsV1) => PushGatewaySettingChange;
}

const DEFAULT_SETTINGS: RemotePushGatewaySettingsV1 = {
  kind: "remote-push-gateway-settings",
  enabled: false,
  gatewayUrl: REMOTE_PUSH_GATEWAY_DEFAULT_URL,
  version: 0,
};

export function createPushGatewaySetting(dataDirectory: string): PushGatewaySettingPort {
  const directory = join(dataDirectory, "remote");
  const path = join(dataDirectory, PUSH_GATEWAY_SETTING_FILE);
  // Read once and kept in memory: delivery asks for it before every send, and
  // only this port writes the file.
  let settings = load(path);
  return {
    current: () => settings,
    change: (command) => {
      if (command.expectedVersion !== settings.version) {
        return { kind: "stale-version", settings };
      }
      const next: RemotePushGatewaySettingsV1 = {
        kind: "remote-push-gateway-settings",
        enabled: command.enabled,
        gatewayUrl: command.gatewayUrl,
        version: settings.version + 1,
      };
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const staging = `${path}.${process.pid}.tmp`;
        writeFileSync(staging, JSON.stringify(next), { mode: 0o600 });
        chmodSync(staging, 0o600);
        renameSync(staging, path);
      } catch {
        return { kind: "unavailable", settings };
      }
      settings = next;
      return { kind: "changed", settings };
    },
  };
}

/** A file that cannot be read back exactly reads as the default: off. */
function load(path: string): RemotePushGatewaySettingsV1 {
  try {
    return decodeRemotePushGatewaySettingsV1(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_SETTINGS;
  }
}
