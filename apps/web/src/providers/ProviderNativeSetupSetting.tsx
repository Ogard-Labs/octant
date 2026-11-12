import {
  PROVIDER_NATIVE_SETUP_FEATURES,
  type KeyProviderDriverKind,
  type OwnMemoryProviderDriverKind,
  type ProviderCapabilities,
  type ProviderNativeSetupFeature,
  type ProviderObservedState,
} from "@octant/contracts";
import { SettingRow } from "../settings/primitives";
import { OctantSwitch } from "../ui/base/OctantSwitch";

export interface ProviderNativeSetupSettingProps {
  readonly instance: {
    readonly id: string;
    readonly displayName: string;
    readonly driverKind: KeyProviderDriverKind;
    readonly nativeSetup?: true;
  };
  readonly observed?: Pick<ProviderObservedState, "capabilities">;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

const PROVIDER_NAMES: Readonly<Record<KeyProviderDriverKind, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "mistral-vibe": "Mistral Vibe",
};

const FEATURE_NAMES: Readonly<Record<ProviderNativeSetupFeature, string>> = {
  subagents: "its own subagents",
  webTools: "web search and fetch",
  skills: "skills",
  toolServers: "the MCP servers in its home folder",
  hooks: "settings and hooks",
  projectCode: "a trusted Project’s own code",
};

/**
 * The person's switch that lets one key provider account run as it does in
 * its own app at Guarded and Reviewed: its own subagents, web tools, skills,
 * and home configuration. Full access turns the same on by itself. Only a
 * window on this host may change it (the server refuses others). The line
 * under the switch says which of those this provider's driver can load at
 * all, so a feature Octant cannot see is never implied.
 */
export function ProviderNativeSetupSetting(props: ProviderNativeSetupSettingProps) {
  const name = PROVIDER_NAMES[props.instance.driverKind];
  const settingId = `provider-${props.instance.id}-native-setup`;
  const unsupported = unsupportedFeatures(props.observed?.capabilities);
  return (
    <SettingRow
      description={
        <>
          Lets this account’s threads use {name}’s own setup, as in {name} itself: its own
          subagents, web search and fetch, skills, and the MCP servers, plugins, settings, and hooks
          in its home folder. Octant still shows each subagent and marks each web read. Full access
          turns this on by itself. Plan stays read-only, and Chat never gets a folder or a shell. A
          Project’s own hooks, MCP servers, and plugins load only in a Project you trust for {name}.
          {props.instance.driverKind === "mistral-vibe" ? (
            <> Mistral Vibe’s own subagents run only at Full access.</>
          ) : null}
          {unsupported.length === 0 ? null : (
            <>
              {" "}
              Not available for {name} yet: {unsupported.join(", ")}.
            </>
          )}
        </>
      }
      label={`Run ${name} as itself`}
      scope="host"
      settingId={`provider-${props.instance.id}-native-setup`}
    >
      <OctantSwitch
        checked={props.instance.nativeSetup === true}
        describedBy={`${settingId}-description`}
        disabled={props.disabled}
        label={`Run ${props.instance.displayName} as itself`}
        onCheckedChange={(next) => {
          void props.onChange(next);
        }}
      />
    </SettingRow>
  );
}

export interface ProviderOwnMemorySettingProps {
  readonly instance: {
    readonly id: string;
    readonly displayName: string;
    readonly driverKind: OwnMemoryProviderDriverKind;
    readonly ownMemory?: true;
  };
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

/**
 * The person's switch for one Claude Code or Codex account's own memory, off
 * by default and apart from "Run as itself": that switch and Full access never
 * turn memory on. The text says what Octant does not control once it is on,
 * and where it stays off. Only a window on this host may change it (the
 * server refuses others).
 */
export function ProviderOwnMemorySetting(props: ProviderOwnMemorySettingProps) {
  const name = PROVIDER_NAMES[props.instance.driverKind];
  const settingId = `provider-${props.instance.id}-own-memory`;
  return (
    <SettingRow
      description={
        <>
          Lets {name} keep and use its own memory in this account’s Work and Code threads. {name}{" "}
          decides what it remembers and carries it across Projects; Octant does not show, journal,
          or clear it. It stays off in Plan and in Chat. Octant’s Project memory and its memory of
          you work with this off. {name}’s telemetry and self-update stay off either way.
        </>
      }
      label={`Use ${name}’s own memory`}
      scope="host"
      settingId={settingId}
    >
      <OctantSwitch
        checked={props.instance.ownMemory === true}
        describedBy={`${settingId}-description`}
        disabled={props.disabled}
        label={`Use ${props.instance.displayName}’s own memory`}
        onCheckedChange={(next) => {
          void props.onChange(next);
        }}
      />
    </SettingRow>
  );
}

/**
 * The features the driver reports it cannot load. Before the first check
 * there is nothing reported to name; after it, a missing report means none.
 */
function unsupportedFeatures(
  capabilities: ProviderCapabilities | undefined,
): ReadonlyArray<string> {
  if (capabilities === undefined) return [];
  const support = capabilities.nativeSetup;
  return PROVIDER_NATIVE_SETUP_FEATURES.filter((feature) => support?.[feature] !== "supported").map(
    (feature) => FEATURE_NAMES[feature],
  );
}
