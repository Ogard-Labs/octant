import { OctantSwitch } from "../ui/base/OctantSwitch";
import { ChevronRight } from "lucide-react";

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
    <OctantSwitch
      checked={props.enabled}
      label="Allow marketplace fetches"
      onCheckedChange={props.onEnabledChange}
    />
  );
}

export function MarketplaceFetchDisclosure() {
  return (
    <details className="settings-disclosure marketplace-fetch-settings__details">
      <summary>
        <ChevronRight aria-hidden="true" size={12} />
        Network details
      </summary>
      <p className="marketplace-fetch-settings__disclosure">
        Search contacts skills.sh and the npm registry with the text you typed. Inspecting or
        installing catalog packages fetches from GitHub. Opening Marketplace never fetches.
      </p>
      <ul className="marketplace-fetch-settings__list">
        <li>User-Agent is a fixed string with no app or runtime version.</li>
        <li>
          Local skills under .agents/skills/ and local plugin folders never contact a registry.
        </li>
      </ul>
    </details>
  );
}
