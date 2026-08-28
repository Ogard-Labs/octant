import { OctantSwitch } from "../ui/base/OctantSwitch";

export interface MarketplaceFetchSettingsProps {
  readonly enabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
}

/**
 * Host preference for skills.sh / npm / GitHub catalog fetches.
 *
 * Mirrors Updates: off means no request leaves the host. Search, inspect, and
 * install honour the preference on the server; opening the Marketplace tab
 * never fetched on its own.
 */
export function MarketplaceFetchSettings(props: MarketplaceFetchSettingsProps) {
  return (
    <div className="marketplace-fetch-settings">
      <div className="marketplace-fetch-settings__automatic">
        <OctantSwitch
          checked={props.enabled}
          label="Allow marketplace fetches"
          onCheckedChange={props.onEnabledChange}
        />
      </div>
      <p className="marketplace-fetch-settings__disclosure">
        When on, Search skills contacts skills.sh and the npm registry with the text you typed, and
        Inspect or install for catalog packages fetches from GitHub. Opening the Marketplace tab
        does not fetch. Off means those requests are not made.
      </p>
      <ul className="marketplace-fetch-settings__list">
        <li>User-Agent is a fixed string with no app or runtime version.</li>
        <li>
          Local skills under .agents/skills/ and local plugin folders never contact a registry.
        </li>
      </ul>
    </div>
  );
}
