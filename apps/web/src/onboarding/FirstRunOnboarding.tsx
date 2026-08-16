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
import { useRef, type ComponentType } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import type {
  FirstRunDiscoveryNotice,
  FirstRunProviderState,
  FirstRunReadinessOverall,
  FirstRunReadinessSummary,
} from "./firstRunReadinessModel";
import type { FirstRunOnboardingController } from "./useFirstRunOnboardingController";
import "./first-run.css";

export interface FirstRunOnboardingProps {
  readonly controller: FirstRunOnboardingController;
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
const CAVEATS: Record<Exclude<FirstRunReadinessOverall, "ready">, string> = {
  checking:
    "Octant is still checking this host, so it cannot say yet whether Chat can answer. You can open the composer while it finishes.",
  "authority-unavailable":
    "Octant cannot reach its own provider registry, so it cannot say whether Chat can answer. You can still open the composer and finish setup later in Settings.",
  "none-configured":
    "No provider is ready, so Chat cannot answer yet. You can still open the composer and finish setup later in Settings.",
  "action-required":
    "No provider is ready, so Chat cannot answer yet. You can still open the composer and finish setup later in Settings.",
};

/**
 * Octant's first-run surface (`BOOT-01`).
 *
 * It exists to get a new user from a clean launch to an ordinary Chat composer
 * without a hidden prerequisite, so it states exactly one thing: whether any
 * provider on this host can answer a message, and what to do when none can.
 * Every status carries an icon *and* a word, and the continue action never
 * implies a capability the host has not confirmed — a user may proceed with no
 * ready provider, but the surface says plainly that Chat cannot answer yet.
 * It says that only when the host actually reported it: while readiness is
 * still being checked, or while the provider registry is unreachable, the
 * surface names the unknown instead of claiming Chat cannot answer
 * (`BOOT-02`). Dismissing the dialog records the same durable "skipped"
 * outcome as the button, so first run never silently repeats.
 *
 * Sending the user to provider settings closes this surface too. A modal that
 * stays open over the destination it just opened traps focus away from the
 * action it advertised, and the only alternative — recording an answer the user
 * did not give — would hide first run from someone who simply backed out of
 * Settings.
 */
export function FirstRunOnboarding(props: FirstRunOnboardingProps) {
  const { controller, readiness } = props;
  const initialFocus = useRef<HTMLButtonElement>(null);
  const busy = controller.submitting !== undefined;
  const SummaryIcon = SUMMARY_ICONS[readiness.overall];

  if (!controller.visible) return null;

  return (
    <OctantDialog
      className="first-run"
      initialFocus={initialFocus}
      label="Welcome to Octant"
      onClose={controller.skip}
      open
    >
      <div className="first-run__body">
        <header className="first-run__header">
          <h2 className="first-run__title">Welcome to Octant</h2>
          <p className="first-run__intro">
            Octant runs on this Mac and talks to the AI providers you choose. Nothing is configured
            for you, so this page reports what the host can actually reach before you start.
          </p>
        </header>

        <section aria-labelledby="first-run-readiness-title" className="first-run__section">
          <h3 className="first-run__section-title" id="first-run-readiness-title">
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
                    <Icon size={15} />
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
            className="first-run__notice"
            data-tone={props.discoveryNotice.tone}
            role={props.discoveryNotice.tone === "attention" ? "alert" : "status"}
          >
            {props.discoveryNotice.message}
          </p>
        )}

        {controller.blockedMessage === undefined ? null : (
          <p className="first-run__notice" data-tone="attention" role="alert">
            {controller.blockedMessage}
          </p>
        )}

        <div className="first-run__setup">
          <OctantButton
            onClick={() => {
              props.onOpenProviderSettings();
              // This modal must not stay over the settings it just opened, and
              // it must not answer for the user either: deferring leaves the
              // host's status `pending`, so someone who backs out of Settings
              // still meets first run on the next launch.
              controller.defer();
            }}
            ref={initialFocus}
            type="button"
          >
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

        <footer className="first-run__actions">
          {readiness.overall === "ready" ? null : (
            <p className="first-run__caveat" role="note">
              {CAVEATS[readiness.overall]}
            </p>
          )}
          <div className="first-run__buttons">
            <OctantButton
              disabled={busy || controller.blockedMessage !== undefined}
              onClick={controller.skip}
              type="button"
              variant="ghost"
            >
              {controller.submitting === "skipped" ? "Skipping…" : "Skip for now"}
            </OctantButton>
            <OctantButton
              disabled={busy || controller.blockedMessage !== undefined}
              onClick={controller.complete}
              type="button"
            >
              {controller.submitting === "completed" ? "Saving…" : "Continue to Chat"}
            </OctantButton>
          </div>
        </footer>
      </div>
    </OctantDialog>
  );
}
