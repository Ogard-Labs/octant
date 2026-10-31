import {
  PROVIDER_NATIVE_SETUP_FEATURES,
  type KeyProviderDriverKind,
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
  toolServers: "MCP servers and plugins",
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
      settingId={settingId}
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
