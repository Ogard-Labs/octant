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
import { keyProviderLabel } from "./providerSettingsPresentation";

export interface ProviderNativeSetupSettingProps {
  readonly instance: {
    readonly id: string;
    readonly displayName: string;
    readonly driverKind: KeyProviderDriverKind;
    readonly nativeSetup?: boolean;
  };
  readonly observed?: Pick<ProviderObservedState, "capabilities">;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

const FEATURE_NAMES: Readonly<Record<ProviderNativeSetupFeature, string>> = {
  subagents: "its own subagents",
  webTools: "web search and fetch",
  skills: "skills",
  toolServers: "the MCP servers in its home folder",
  hooks: "settings and hooks",
  projectCode: "a trusted Project’s own code",
};

/**
 * The person's switch for one key provider account running as it does in its
 * own app: its own subagents, web tools, skills, and home configuration. On by
 * default; turning it off keeps them unloaded below Full access, and the web
 * tools at every level and in every mode. Only the host's own person may
 * change it, at a window on this host or on a device they paired (the server
 * refuses every other device). The line
 * under the switch says which of those this provider's driver can load at
 * all, so a feature Octant cannot see is never implied.
 */
export function ProviderNativeSetupSetting(props: ProviderNativeSetupSettingProps) {
  const name = keyProviderLabel(props.instance.driverKind);
  const settingId = `provider-${props.instance.id}-native-setup`;
  const unsupported = unsupportedFeatures(props.observed?.capabilities);
  return (
    <SettingRow
      description={
        <>
          Lets this account’s threads use {name}’s own setup, as in {name} itself: its own
          subagents, web search and fetch, skills, and the MCP servers, plugins, settings, and hooks
          in its home folder. On by default; each call still follows the thread’s level. Octant
          still shows each subagent and marks each web read. Turned off, web search and fetch stay
          off in every mode, and Full access still turns the rest on. Plan stays read-only, and Chat
          never gets a folder or a shell. A Project’s own hooks, MCP servers, and plugins load only
          in a Project you trust for {name}.
          {props.instance.driverKind === "mistral-vibe" ? (
            <>
              {" "}
              Vibe’s subagents, and your own Vibe agents they run as, work in Work and Code outside
              Plan, at every level there. Vibe doesn’t say which tool its subagents ask to run, so
              their approvals show no tool name, and a subagent running as one of your own Vibe
              agents may approve its own tools, as in Vibe.
            </>
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
        checked={props.instance.nativeSetup !== false}
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
    readonly ownMemory?: boolean;
  };
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

/**
 * The person's switch for one Claude Code or Codex account's own memory, on
 * by default and apart from "Run as itself": that switch and Full access never
 * turn memory on once the person turned it off. The text says what Octant does
 * not control while it is on, and what it may do in Plan and Chat: Claude Code
 * reads its memory there and cannot change it, and Codex, which writes its
 * memory in the background, keeps it off there. Only the host's own person may
 * change it, at a window on this host or on a device they paired (the server
 * refuses every other device).
 */
export function ProviderOwnMemorySetting(props: ProviderOwnMemorySettingProps) {
  const name = keyProviderLabel(props.instance.driverKind);
  const settingId = `provider-${props.instance.id}-own-memory`;
  return (
    <SettingRow
      description={
        <>
          Lets {name} keep and use its own memory in this account’s Work and Code threads, as in{" "}
          {name} itself. On by default. {name} decides what it remembers and carries it across
          Projects; Octant does not show, journal, or clear it.{" "}
          {props.instance.driverKind === "claude"
            ? "In Plan and in Chat it reads its memory and cannot change it."
            : "It stays off in Plan and in Chat, because it writes its memory in the background."}{" "}
          Octant’s Project memory and its memory of you work with this off. {name}’s telemetry and
          self-update stay off either way.
        </>
      }
      label={`Use ${name}’s own memory`}
      scope="host"
      settingId={`provider-${props.instance.id}-own-memory`}
    >
      <OctantSwitch
        checked={props.instance.ownMemory !== false}
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
