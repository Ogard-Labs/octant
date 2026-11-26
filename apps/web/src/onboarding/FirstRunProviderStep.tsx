import { CircleAlert, CircleCheck, CircleDashed, Loader, Unplug } from "../ui/icons";
import type { ProviderInstanceId } from "@octant/contracts";
import { forwardRef, useState } from "react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { thisComputerName, useHostPlatform } from "../platform";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import type {
  FirstRunDiscoveryNotice,
  FirstRunProviderReadiness,
  FirstRunReadinessOverall,
  FirstRunReadinessSummary,
} from "./firstRunReadinessModel";

export interface FirstRunProviderStepProps {
  readonly readiness: FirstRunReadinessSummary;
  readonly discoveryNotice?: FirstRunDiscoveryNotice;
  readonly onOpenProviderSettings: () => void;
  readonly onRescan: () => void;
  readonly scanning: boolean;
  /**
   * Turn a configured provider on or off from this step. First run may enable
   * a detected Claude Code or Codex; every other detected runtime still
   * arrives switched off, so this switch is how those get turned on here.
   */
  readonly onSetProviderEnabled?: (instanceId: ProviderInstanceId, enabled: boolean) => void;
}

/** How many providers show before the rest wait behind "Show N more". */
const PROVIDERS_SHOWN = 5;

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
 * negative one the status above would contradict.
 */
const CAVEATS: Partial<Record<Exclude<FirstRunReadinessOverall, "ready">, string>> = {
  checking:
    "Octant is still checking this host, so it cannot say yet whether Chat can answer. You can open the composer while it finishes.",
  "authority-unavailable":
    "Octant cannot reach its own provider registry, so it cannot say whether Chat can answer. You can still open the composer and finish setup later in Settings.",
};

/**
 * Keeps rows in the order given. Rows the order does not name follow in the
 * model's own order.
 */
function inHeldOrder(
  providers: ReadonlyArray<FirstRunProviderReadiness>,
  held: ReadonlyArray<string> | undefined,
): ReadonlyArray<FirstRunProviderReadiness> {
  if (held === undefined) return providers;
  const place = (provider: FirstRunProviderReadiness) => {
    const index = held.indexOf(String(provider.instanceId));
    return index === -1 ? held.length : index;
  };
  return [...providers].sort((left, right) => place(left) - place(right));
}

/**
 * The one thing first run has to get right: whether any provider on this host
 * can answer a message, and what to do when none can.
 *
 * Every status is a word, so the surface stays readable for
 * colour-blind users and under Increased Contrast. It claims nothing the host
 * has not reported: while readiness is still being checked, or while the
 * provider registry is unreachable, it names the unknown instead of saying
 * Chat cannot answer.
 */
export const FirstRunProviderStep = forwardRef<HTMLButtonElement, FirstRunProviderStepProps>(
  function FirstRunProviderStep(props, ref) {
    const { readiness } = props;
    const computer = thisComputerName(useHostPlatform());
    const SummaryIcon = SUMMARY_ICONS[readiness.overall];
    const caveat = readiness.overall === "ready" ? undefined : CAVEATS[readiness.overall];
    const [showAll, setShowAll] = useState(false);
    // A switch changes its row's rank. Once the person has used one, rows stay
    // put, so the row under the pointer does not jump or fold out of sight.
    const [heldOrder, setHeldOrder] = useState<ReadonlyArray<string>>();
    const ordered = inHeldOrder(readiness.providers, heldOrder);
    const shown = showAll ? ordered : ordered.slice(0, PROVIDERS_SHOWN);
    const folded = ordered.length - PROVIDERS_SHOWN;

    return (
      <div className="first-run__step">
        <div className="first-run__intro">
          <p>Choose the AI providers Octant uses. You can change this later in Settings.</p>
          <OctantCollapsible
            chevronSize={12}
            className="setrow-more"
            summary="More"
            summaryClassName="setrow-more__summary"
            summaryProps={{ "aria-label": "More about providers" }}
          >
            <p className="setrow-more__body">
              Octant runs on {computer} and talks to the AI providers you choose. If Claude Code or
              Codex is already installed, first run enables it so a thread can start without
              visiting Settings; you can turn it off later. Other detected CLIs stay off until you
              enable them.
            </p>
          </OctantCollapsible>
        </div>

        {/* The verdict speaks for the whole list rather than for one provider
            in it, so it stands above the rows. */}
        <section aria-label="Provider readiness" className="first-run__readiness">
          <p className="first-run__summary" data-overall={readiness.overall} role="status">
            <SummaryIcon size={16} />
            <span className="first-run__summary-headline">{readiness.headline}</span>
            <span className="first-run__summary-detail">{readiness.detail}</span>
          </p>

          {ordered.length > 0 ? (
            <ul className="setgroup first-run__providers" role="list">
              {shown.map((provider) => (
                <li
                  className="setrow first-run__provider"
                  data-state={provider.state}
                  key={String(provider.instanceId)}
                >
                  <span className="setrow-label">
                    <ProviderGlyph
                      displayName={provider.displayName}
                      driverKind={provider.driverKind}
                      size={16}
                    />
                    {provider.displayName}
                  </span>
                  <p className="setrow-hint">{provider.label}</p>
                  {props.onSetProviderEnabled === undefined ? null : (
                    <div className="setrow-control">
                      <OctantSwitch
                        checked={provider.state !== "disabled"}
                        label={`Enable ${provider.displayName}, ${provider.label}`}
                        onCheckedChange={(enabled) => {
                          setHeldOrder(ordered.map((row) => String(row.instanceId)));
                          props.onSetProviderEnabled?.(provider.instanceId, enabled);
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {folded > 0 ? (
            <OctantButton
              aria-expanded={showAll}
              className="first-run__fold"
              onClick={() => setShowAll((current) => !current)}
              type="button"
              variant="ghost"
            >
              {showAll ? "Show fewer" : `Show ${String(folded)} more`}
            </OctantButton>
          ) : null}
        </section>

        {props.discoveryNotice === undefined ? null : (
          <OctantAlert
            className="first-run__notice"
            tone={props.discoveryNotice.tone === "attention" ? "warning" : "neutral"}
          >
            {props.discoveryNotice.message}
          </OctantAlert>
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
            {props.scanning ? "Checking…" : `Check ${computer} again`}
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
