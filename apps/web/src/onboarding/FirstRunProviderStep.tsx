import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  KeyRound,
  Loader,
  ShieldAlert,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { forwardRef, type ComponentType } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type {
  FirstRunDiscoveryNotice,
  FirstRunProviderState,
  FirstRunReadinessOverall,
  FirstRunReadinessSummary,
} from "./firstRunReadinessModel";

export interface FirstRunProviderStepProps {
  readonly readiness: FirstRunReadinessSummary;
  readonly discoveryNotice?: FirstRunDiscoveryNotice;
  readonly onOpenProviderSettings: () => void;
  readonly onRescan: () => void;
  readonly scanning: boolean;
}

const PROVIDER_ICONS: Record<FirstRunProviderState, ComponentType<{ readonly size?: number }>> = {
  ready: CircleCheck,
  "no-models": CircleAlert,
  "authentication-required": KeyRound,
  "credential-unavailable": ShieldAlert,
  unreachable: Unplug,
  incompatible: TriangleAlert,
  degraded: CircleAlert,
  checking: Loader,
  unverified: CircleHelp,
  disabled: CircleSlash,
};

const SUMMARY_ICONS = {
  ready: CircleCheck,
  checking: Loader,
  "authority-unavailable": Unplug,
  "none-configured": CircleDashed,
  "action-required": CircleAlert,
} as const;

/**
 * What continuing means when Chat is not confirmed ready.
 *
 * Only `none-configured` and `action-required` are findings: the host reported
 * on every provider and none can answer. `checking` and `authority-unavailable`
 * are unknowns, so they say so rather than converting a missing answer into a
 * negative one the status above would contradict (`BOOT-02`).
 */
const CAVEATS: Partial<Record<Exclude<FirstRunReadinessOverall, "ready">, string>> = {
  checking:
    "Octant is still checking this host, so it cannot say yet whether Chat can answer. You can open the composer while it finishes.",
  "authority-unavailable":
    "Octant cannot reach its own provider registry, so it cannot say whether Chat can answer. You can still open the composer and finish setup later in Settings.",
};

/**
 * The one thing first run has to get right: whether any provider on this host
 * can answer a message, and what to do when none can.
 *
 * Every status carries an icon *and* a word, so the surface stays readable for
 * colour-blind users and under Increased Contrast. It claims nothing the host
 * has not reported: while readiness is still being checked, or while the
 * provider registry is unreachable, it names the unknown instead of saying
 * Chat cannot answer (`BOOT-02`).
 */
export const FirstRunProviderStep = forwardRef<HTMLButtonElement, FirstRunProviderStepProps>(
  function FirstRunProviderStep(props, ref) {
    const { readiness } = props;
    const SummaryIcon = SUMMARY_ICONS[readiness.overall];
    const caveat = readiness.overall === "ready" ? undefined : CAVEATS[readiness.overall];

    return (
      <div className="first-run__step">
        <p className="first-run__intro">
          Octant runs on this Mac and talks to the AI providers you choose. Nothing is configured
          for you, so this step reports what the host can actually reach.
        </p>

        <section aria-labelledby="first-run-readiness-title" className="setgroup">
          <h3 className="setgroup-head" id="first-run-readiness-title">
            Provider readiness
          </h3>
          <p className="first-run__summary" data-overall={readiness.overall} role="status">
            <SummaryIcon size={16} />
            <span className="first-run__summary-headline">{readiness.headline}</span>
            <span className="first-run__summary-detail">{readiness.detail}</span>
          </p>

          {readiness.providers.length > 0 ? (
            <ul className="first-run__providers" role="list">
              {readiness.providers.map((provider) => {
                const Icon = PROVIDER_ICONS[provider.state];
                return (
                  <li
                    className="first-run__provider"
                    data-state={provider.state}
                    key={String(provider.instanceId)}
                  >
                    <Icon size={16} />
                    <span className="first-run__provider-name">{provider.displayName}</span>
                    <span className="first-run__provider-label">{provider.label}</span>
                    <span className="first-run__provider-detail">{provider.detail}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        {props.discoveryNotice === undefined ? null : (
          <p
            className="first-run__notice callout"
            data-tone={props.discoveryNotice.tone}
            role={props.discoveryNotice.tone === "attention" ? "alert" : "status"}
          >
            {props.discoveryNotice.message}
          </p>
        )}

        <div className="first-run__button-row">
          <OctantButton onClick={props.onOpenProviderSettings} ref={ref} type="button">
            Set up a provider
          </OctantButton>
          <OctantButton
            disabled={props.scanning}
            onClick={props.onRescan}
            type="button"
            variant="ghost"
          >
            {props.scanning ? "Checking…" : "Check this Mac again"}
          </OctantButton>
        </div>

        {caveat === undefined ? null : (
          <p className="first-run__caveat" role="note">
            {caveat}
          </p>
        )}
      </div>
    );
  },
);
