import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
  OutsideHarnessEndpointProviderConfiguration,
  OutsideProviderDriverListing,
  ProviderDriverKind,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import {
  resolveProviderCatalogState,
  type ProviderCatalogState,
} from "@octant/domain/provider-catalog-policy";
import {
  bundledProviderDriverCatalog,
  type ProviderDriverCatalogListing,
} from "@octant/plugin-host/provider-drivers";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { hostCredentialStore, useHostPlatform } from "../../platform";
import { SettingsSection } from "../../settings/primitives";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { ProviderGlyph } from "../ProviderGlyph";
import { PROVIDER_LOGOS } from "../providerLogoPaths";
import type { TransientProviderCredential } from "../useProviderController";
import { OutsideDriverAddForm } from "./OutsideDriverAddForm";
import {
  agentLoopLabel,
  modeSupportLabel,
  providerCatalogFacts,
  providerCatalogStatus,
  providerCatalogSteps,
  type ProviderCatalogStatus,
} from "./providerCatalogPresentation";
import "../../styles/provider-catalog.css";

/** Discovery as this window has it. Absent where the window cannot scan the host. */
export interface ProviderCatalogDiscovery {
  readonly snapshot: DiscoverySnapshot | undefined;
  readonly scanning: boolean;
  readonly message?: string;
  readonly connectingPaths: ReadonlySet<string>;
  /**
   * Looks on the host. Resolves to the scan's snapshot, or `undefined` when the
   * request itself failed; a failed or cancelled snapshot is a failure too.
   */
  readonly onScan: () => Promise<DiscoverySnapshot | undefined>;
  readonly onConnect: (candidate: DiscoveryCandidate) => Promise<boolean>;
}

export interface ProviderCatalogViewProps {
  readonly status: "loading" | "ready" | "disconnected";
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly probingIds: ReadonlySet<ProviderInstanceId>;
  readonly busy: boolean;
  /** The provider controller's last refusal, said where the step that caused it is. */
  readonly message?: string;
  readonly discovery?: ProviderCatalogDiscovery;
  readonly onSetEnabled: (instanceId: ProviderInstanceId, enabled: boolean) => Promise<boolean>;
  readonly onProbe: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onOpenModelEndpoints: () => void;
  readonly onOpenProviders: () => void;
  /**
   * The runtime's own Providers & Models card, so sign-in, Locate binary, and
   * connection details are the card's and not a second copy of them.
   */
  readonly renderRuntimeCard?: (instance: ProviderInstance) => ReactNode;
  readonly onDetailChange?: (entryName: string | undefined) => void;
  /** The listings to show; the bundled drivers unless a test supplies others. */
  readonly listings?: ReadonlyArray<ProviderDriverCatalogListing>;
  /** The outside drivers the host admits, which a provider may be added from. */
  readonly outsideDrivers?: ReadonlyArray<OutsideProviderDriverListing>;
  /** Whether this window can put a key in the host's keychain. */
  readonly credentialManagementAvailable?: boolean;
  /** Adds a provider from an outside driver; the host creates it off. */
  readonly onAddOutsideProvider?: (
    displayName: string,
    configuration: OutsideHarnessEndpointProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
}

const BUNDLED_LISTINGS = bundledProviderDriverCatalog();

/**
 * One catalog row. A bundled driver is keyed by its kind; an outside driver by
 * its package and component, since every outside driver shares one family
 * kind.
 */
interface CatalogEntry {
  readonly key: string;
  readonly driverKind: ProviderDriverKind;
  readonly source:
    | { readonly kind: "bundled"; readonly listing: ProviderDriverCatalogListing }
    | { readonly kind: "outside"; readonly listing: OutsideProviderDriverListing };
  readonly name: string;
  readonly state: ProviderCatalogState;
}

function outsideEntryKey(listing: OutsideProviderDriverListing): string {
  return `outside-${String(listing.driver.extensionId)}-${String(listing.driver.componentId)}`;
}

/** Whether an instance runs this outside driver, at the exact digest it lists. */
function bindsOutsideDriver(
  instance: ProviderInstance,
  listing: OutsideProviderDriverListing,
): boolean {
  if (instance.driverKind !== "outside-harness-endpoint") return false;
  const driver = instance.configuration.driver;
  return (
    String(driver.extensionId) === String(listing.driver.extensionId) &&
    String(driver.componentId) === String(listing.driver.componentId) &&
    String(driver.digest) === String(listing.driver.digest)
  );
}

/**
 * Settings › Provider catalog: every provider driver bundled with Octant, what
 * this host already has of each, and a guided setup that continues the
 * provider already configured. Browsing reads the registry and the last scan
 * only; every step that runs something is a button.
 */
export function ProviderCatalogView(props: ProviderCatalogViewProps) {
  const listings = props.listings ?? BUNDLED_LISTINGS;
  const [openKey, setOpenKey] = useState<string>();
  const [returnFocusTo, setReturnFocusTo] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const snapshot = props.discovery?.snapshot;
  const outsideDrivers = props.outsideDrivers;
  const entries = useMemo<ReadonlyArray<CatalogEntry>>(() => {
    const host = {
      instances: props.instances,
      observedByInstance: props.observedByInstance,
      probingIds: props.probingIds,
      discovery: snapshot,
    };
    const bundled = listings.map(
      (listing): CatalogEntry => ({
        key: listing.entry.driverKind,
        driverKind: listing.entry.driverKind,
        source: { kind: "bundled", listing },
        name: listing.entry.manifest.displayName,
        state: resolveProviderCatalogState(
          {
            driverKind: listing.entry.driverKind,
            installed: listing.installed,
            trusted: listing.trusted,
            available: listing.activation.kind === "effective",
          },
          host,
        ),
      }),
    );
    // The host lists only the outside drivers it admits; each continues the
    // providers bound to its own package and digest.
    const outside = (outsideDrivers ?? []).map(
      (listing): CatalogEntry => ({
        key: outsideEntryKey(listing),
        driverKind: "outside-harness-endpoint",
        source: { kind: "outside", listing },
        name: listing.displayName,
        state: resolveProviderCatalogState(
          {
            driverKind: "outside-harness-endpoint",
            installed: listing.installed,
            trusted: listing.trusted,
            available: true,
          },
          {
            ...host,
            instances: props.instances.filter((instance) => bindsOutsideDriver(instance, listing)),
          },
        ),
      }),
    );
    return [...bundled, ...outside];
  }, [
    listings,
    outsideDrivers,
    props.instances,
    props.observedByInstance,
    props.probingIds,
    snapshot,
  ]);
  const open = entries.find((entry) => entry.key === openKey);

  const { onDetailChange } = props;
  const openName = open?.name;
  useEffect(() => {
    onDetailChange?.(openName);
  }, [onDetailChange, openName]);
  useEffect(() => () => onDetailChange?.(undefined), [onDetailChange]);

  // Back returns focus to the row the setup was opened from.
  useEffect(() => {
    if (open !== undefined || returnFocusTo === undefined) return;
    list.current?.querySelector<HTMLElement>(`[data-catalog-key="${returnFocusTo}"]`)?.focus();
    setReturnFocusTo(undefined);
  }, [open, returnFocusTo]);

  if (open !== undefined) {
    return (
      <ProviderCatalogDetail
        {...props}
        entry={open}
        onBack={() => {
          setReturnFocusTo(open.key);
          setOpenKey(undefined);
        }}
        // The catalog shares a page with Providers & Models, so sending a
        // person there means closing this setup to show the providers list.
        onOpenProviders={() => {
          setOpenKey(undefined);
          props.onOpenProviders();
        }}
      />
    );
  }

  const bundledEntries = entries.filter((entry) => entry.source.kind === "bundled");
  const runtimes = bundledEntries.filter((entry) => entry.state.setup === "runtime");
  const endpoints = bundledEntries.filter((entry) => entry.state.setup === "endpoint");
  const outsideEntries = entries.filter((entry) => entry.source.kind === "outside");
  const ready = entries.filter((entry) => entry.state.next.kind === "done").length;
  const needsYou = entries.filter((entry) => {
    const tone = providerCatalogStatus(entry.state).tone;
    return tone === "needs-you" || tone === "failed";
  }).length;
  const renderRow = (entry: CatalogEntry) => (
    <CatalogRow entry={entry} key={entry.key} onOpen={() => setOpenKey(entry.key)} />
  );

  return (
    <div className="provider-settings provider-catalog" ref={list}>
      <div aria-live="polite" className="provider-settings__message-slot">
        {props.status === "loading" ? <p role="status">Loading providers…</p> : null}
      </div>
      {/* The catalog shares Providers & Models with the providers this host
          has, so it names itself before its two lists. */}
      <SettingsSection title="Provider catalog">
        <p className="settings-section-line provider-catalog__intro">
          {outsideEntries.length === 0
            ? "Every provider driver here ships with Octant, so each is already installed and trusted."
            : "Bundled drivers ship with Octant, so each is already installed and trusted. Outside drivers are listed once you have trusted and switched them on under Plugins."}{" "}
          Opening one reads what this host already knows; nothing runs until you choose a step.
          <span
            aria-label="Provider catalog summary"
            className="endpoint-list__summary provider-catalog__summary"
            role="status"
          >
            {entries.length} drivers · {ready} ready · {needsYou} need you
          </span>
        </p>
      </SettingsSection>
      <SettingsSection
        description="Runtimes run their own agent loop. Octant finds them on this host and drives them."
        title="Agent runtimes"
      >
        <ul aria-label="Agent runtimes" className="endpoint-list">
          {runtimes.map(renderRow)}
        </ul>
      </SettingsSection>
      <SettingsSection
        description="Endpoints Octant calls over an API itself. They are added with an address under Octant Harness."
        title="Model endpoints"
      >
        <ul aria-label="Model endpoints" className="endpoint-list">
          {endpoints.map(renderRow)}
        </ul>
      </SettingsSection>
      {outsideEntries.length === 0 ? null : (
        <SettingsSection
          description="Drivers you installed from outside Octant and trusted. Each runs in its own confined process with no network, and Octant makes every request it asks for."
          title="Outside drivers"
        >
          <ul aria-label="Outside drivers" className="endpoint-list">
            {outsideEntries.map(renderRow)}
          </ul>
        </SettingsSection>
      )}
    </div>
  );
}

function CatalogMark(props: { readonly driverKind: ProviderDriverKind; readonly name: string }) {
  // A monogram's letters scale with its box, so it takes the larger step.
  const size = PROVIDER_LOGOS[props.driverKind] === undefined ? 24 : 16;
  return (
    <span aria-hidden="true" className="endpoint-mark">
      <ProviderGlyph displayName={props.name} driverKind={props.driverKind} size={size} />
    </span>
  );
}

function CatalogState(props: { readonly status: ProviderCatalogStatus }) {
  return (
    <span className="endpoint-state" data-tone={props.status.tone}>
      <span aria-hidden="true" className="endpoint-state__dot" />
      {props.status.label}
    </span>
  );
}

function kindLabel(state: ProviderCatalogState): string {
  return state.setup === "endpoint" ? "Model endpoint" : "Agent runtime";
}

/** An outside driver never borrows the bundled label: it says where it came from. */
function originLabel(entry: CatalogEntry): string {
  return entry.source.kind === "outside" ? "Outside driver" : "Bundled";
}

function CatalogRow(props: { readonly entry: CatalogEntry; readonly onOpen: () => void }) {
  const { entry } = props;
  const driverKind = entry.driverKind;
  const status = providerCatalogStatus(entry.state);
  const configured =
    entry.state.instanceCount > 1 ? ` · ${entry.state.instanceCount} configured` : "";
  return (
    <li className="endpoint-row" data-tone={status.tone}>
      <a
        aria-label={`${entry.name}, ${status.label.toLowerCase()}. Open setup`}
        className="endpoint-row__link window-no-drag"
        data-catalog-key={entry.key}
        href={`#provider-catalog-${entry.key}`}
        onClick={(event) => {
          event.preventDefault();
          props.onOpen();
        }}
      >
        <CatalogMark driverKind={driverKind} name={entry.name} />
        <span className="endpoint-row__text">
          <span className="endpoint-row__name">{entry.name}</span>
          <span className="endpoint-row__sub">
            {kindLabel(entry.state)} · {originLabel(entry)}
            {configured}
          </span>
        </span>
        <span className="endpoint-row__state">
          <CatalogState status={status} />
        </span>
        <ChevronRight aria-hidden="true" className="endpoint-row__chevron" size={16} />
      </a>
    </li>
  );
}

function ProviderCatalogDetail(
  props: ProviderCatalogViewProps & { readonly entry: CatalogEntry; readonly onBack: () => void },
) {
  const { entry } = props;
  const { state } = entry;
  const driverKind = entry.driverKind;
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    heading.current?.focus();
    // Focus moves once, when the setup opens; later renders leave it alone.
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return;
    event.preventDefault();
    props.onBack();
  };
  const status = providerCatalogStatus(state);
  const { modes, agentLoop, sandbox } = state.capabilities;
  // An outside driver's provider has no Model endpoints page: its card on
  // Providers & Models holds its key, its models, and Verify tools.
  const runtimeCard =
    (state.setup === "runtime" || entry.source.kind === "outside") && state.instance !== undefined
      ? props.renderRuntimeCard?.(state.instance)
      : undefined;

  return (
    <div
      aria-labelledby={headingId}
      className="endpoint-detail provider-catalog__detail"
      onKeyDown={onKeyDown}
      ref={root}
      role="region"
    >
      <OctantButton
        aria-label="Back to Provider catalog"
        className="endpoint-detail__back window-no-drag"
        onClick={props.onBack}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeft aria-hidden="true" size={16} />
        Provider catalog
      </OctantButton>
      <header className="endpoint-detail__head">
        <CatalogMark driverKind={driverKind} name={entry.name} />
        <div className="endpoint-detail__title">
          <h1 className="endpoint-detail__name" id={headingId} ref={heading} tabIndex={-1}>
            {entry.name}
          </h1>
          <p className="endpoint-detail__state">
            <CatalogState status={status} />
            <span>· {kindLabel(state)}</span>
          </p>
        </div>
      </header>

      <SettingsSection title="Set up">
        <SetupSteps {...props} />
      </SettingsSection>

      {runtimeCard}
      {state.setup === "endpoint" &&
      entry.source.kind === "bundled" &&
      state.instance !== undefined ? (
        <SettingsSection title="Its endpoint">
          <p className="settings-section-line">
            {state.instance.displayName} is configured under Octant Harness › Model endpoints, where
            its address, key, and models are.
          </p>
          <div className="provider-catalog__actions">
            <OctantButton
              onClick={props.onOpenModelEndpoints}
              size="sm"
              type="button"
              variant="outline"
            >
              Open Model endpoints
            </OctantButton>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection title="State">
        <dl className="provider-catalog__facts">
          {providerCatalogFacts(state).map((fact) => (
            <div className="provider-catalog__fact" key={fact.id}>
              <dt>{fact.name}</dt>
              <dd>
                <CatalogState status={fact} />
              </dd>
            </div>
          ))}
        </dl>
      </SettingsSection>

      <SettingsSection
        description="Tool use, activity, and resume for a configured provider are confirmed by its connection check, on its card."
        title="What it can do"
      >
        <dl className="provider-catalog__facts">
          <div className="provider-catalog__fact">
            <dt>Chat</dt>
            <dd>{modeSupportLabel(modes.chat)}</dd>
          </div>
          <div className="provider-catalog__fact">
            <dt>Work</dt>
            <dd>{modeSupportLabel(modes.work)}</dd>
          </div>
          <div className="provider-catalog__fact">
            <dt>Code</dt>
            <dd>{modeSupportLabel(modes.code)}</dd>
          </div>
          <div className="provider-catalog__fact">
            <dt>Agent loop</dt>
            <dd>{agentLoopLabel(agentLoop, sandbox)}</dd>
          </div>
        </dl>
      </SettingsSection>

      {entry.source.kind === "bundled" ? (
        <BundledPackageFacts listing={entry.source.listing} state={state} />
      ) : (
        <OutsidePackageFacts listing={entry.source.listing} state={state} />
      )}
    </div>
  );
}

function BundledPackageFacts(props: {
  readonly listing: ProviderDriverCatalogListing;
  readonly state: ProviderCatalogState;
}) {
  const { manifest } = props.listing.entry;
  const { state } = props;
  return (
    <SettingsSection title="Package">
      <p className="settings-section-line">
        Bundled with Octant, so it is already installed and trusted. There is nothing to download or
        approve here, and the catalog cannot change what it is allowed to do.
      </p>
      <dl className="provider-catalog__facts">
        <div className="provider-catalog__fact">
          <dt>Source</dt>
          <dd>Bundled with Octant</dd>
        </div>
        <div className="provider-catalog__fact">
          <dt>Installed</dt>
          <dd>{state.installed ? "Yes" : "No"}</dd>
        </div>
        <div className="provider-catalog__fact">
          <dt>Trusted</dt>
          <dd>
            {state.trusted
              ? manifest.provenance.reviewed
                ? `Yes, reviewed by ${manifest.provenance.publisher ?? "Octant"}`
                : "Yes"
              : "No"}
          </dd>
        </div>
        <div className="provider-catalog__fact">
          <dt>Driver version</dt>
          <dd className="oct-meta--mono">{manifest.version}</dd>
        </div>
      </dl>
    </SettingsSection>
  );
}

/**
 * An outside driver's package as the person admitted it. A local folder is
 * developer input: nobody but the person reviewed it, and trust holds for
 * this digest only. A signed folder also names the publisher key Octant
 * verified and pinned.
 */
function OutsidePackageFacts(props: {
  readonly listing: OutsideProviderDriverListing;
  readonly state: ProviderCatalogState;
}) {
  const { listing, state } = props;
  const signed = listing.publisherKey !== undefined;
  return (
    <SettingsSection title="Package">
      <p className="settings-section-line">
        {signed
          ? "Installed from a folder on this computer and signed by its publisher: Octant verified the signature and checked its files against the digest you trusted. Nobody else reviewed it. Trust, switches, and removal are under Plugins."
          : "Installed from a folder on this computer. It is unsigned developer input: Octant checked its files against the digest you trusted, and nobody else reviewed it. Trust, switches, and removal are under Plugins."}
      </p>
      <dl className="provider-catalog__facts">
        <div className="provider-catalog__fact">
          <dt>Source</dt>
          <dd>{signed ? "Local folder, signed" : "Local folder, unsigned"}</dd>
        </div>
        {listing.publisherKey === undefined ? null : (
          <div className="provider-catalog__fact">
            <dt>Publisher key</dt>
            <dd className="oct-meta--mono">{listing.publisherKey}</dd>
          </div>
        )}
        <div className="provider-catalog__fact">
          <dt>Installed</dt>
          <dd>{state.installed ? "Yes" : "No"}</dd>
        </div>
        <div className="provider-catalog__fact">
          <dt>Trusted</dt>
          <dd>{state.trusted ? "Yes, by you, at this digest" : "No"}</dd>
        </div>
        <div className="provider-catalog__fact">
          <dt>Driver version</dt>
          <dd className="oct-meta--mono">{String(listing.driver.version)}</dd>
        </div>
        <div className="provider-catalog__fact">
          <dt>Digest</dt>
          <dd className="oct-meta--mono">{String(listing.driver.digest)}</dd>
        </div>
      </dl>
    </SettingsSection>
  );
}

function SetupSteps(
  props: ProviderCatalogViewProps & { readonly entry: CatalogEntry; readonly onBack: () => void },
) {
  const steps = providerCatalogSteps(props.entry.state);
  return (
    <ol className="provider-catalog__steps">
      {steps.map((step, index) => (
        <li
          aria-current={step.progress === "current" ? "step" : undefined}
          className="provider-catalog__step"
          data-progress={step.progress}
          key={step.id}
        >
          <span aria-hidden="true" className="provider-catalog__step-marker">
            {step.progress === "done" ? <Check size={14} strokeWidth={2} /> : index + 1}
          </span>
          <div className="provider-catalog__step-body">
            <span className="provider-catalog__step-title">
              {step.title}
              {step.progress === "done" ? <span className="sr-only"> (done)</span> : null}
            </span>
            {/* A sign-in is only known once a check reaches the runtime, so an
                open Sign in step ahead of the check says so rather than
                reading as skipped. */}
            {step.id === "sign-in" &&
            step.progress === "upcoming" &&
            props.entry.state.authenticated === "not-checked" ? (
              <span className="provider-catalog__step-note">
                Known once the connection check reaches it.
              </span>
            ) : null}
            {step.progress === "current" ? (
              <CurrentStep {...props} key={props.entry.state.next.kind} />
            ) : null}
          </div>
        </li>
      ))}
      {props.entry.state.next.kind === "done" ? (
        <li className="provider-catalog__step" data-progress="done">
          <span aria-hidden="true" className="provider-catalog__step-marker">
            <Check size={14} strokeWidth={2} />
          </span>
          <div className="provider-catalog__step-body">
            <p className="provider-catalog__sentence" role="status">
              Ready. {props.entry.name} is offered in the model picker.
            </p>
          </div>
        </li>
      ) : null}
      {props.entry.state.next.kind === "unavailable" ? (
        <li className="provider-catalog__step" data-progress="current">
          <div className="provider-catalog__step-body">
            <p className="provider-catalog__sentence">
              Octant is not offering this driver on this host, so it cannot be set up here.
            </p>
          </div>
        </li>
      ) : null}
    </ol>
  );
}

/**
 * The one thing the current step asks for: a sentence, one action, and what
 * came of it in a polite live region. A refused action says why and keeps its
 * button, now Try again, so a failure is never a dead end.
 */
function CurrentStep(
  props: ProviderCatalogViewProps & { readonly entry: CatalogEntry; readonly onBack: () => void },
) {
  const { entry, discovery } = props;
  const { state, name } = entry;
  const next = state.next;
  const keyStore = hostCredentialStore(useHostPlatform());
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setPending(true);
    setFailure(undefined);
    try {
      const outcome = await action();
      if (outcome === false) setFailure(fallback);
    } catch {
      setFailure(fallback);
    } finally {
      setPending(false);
    }
  };
  const disabled = pending || props.busy || props.status !== "ready";
  // Amazon Bedrock signs in only at the organization's single sign-on portal,
  // from a terminal on the host; Settings adds it but never begins its sign-in.
  const signsInFromHostTerminal = entry.driverKind === "amazon-bedrock";
  const retryLabel = (label: string) => (failure === undefined ? label : "Try again");

  let sentence: ReactNode;
  let action: ReactNode = null;
  let secondary: ReactNode = null;
  const openProviders = (
    <OctantButton onClick={props.onOpenProviders} size="sm" type="button" variant="ghost">
      Open Providers &amp; Models
    </OctantButton>
  );
  const openEndpoints = (
    <OctantButton onClick={props.onOpenModelEndpoints} size="sm" type="button" variant="outline">
      Open Model endpoints
    </OctantButton>
  );
  const scan = (label: string) =>
    discovery === undefined ? null : (
      <OctantButton
        disabled={disabled || discovery.scanning}
        onClick={() =>
          void run(async () => {
            const scanned = await discovery.onScan();
            return (
              scanned !== undefined && scanned.status !== "failed" && scanned.status !== "cancelled"
            );
          }, "Octant could not look on this host.")
        }
        size="sm"
        type="button"
        variant="default"
      >
        {discovery.scanning ? "Looking…" : retryLabel(label)}
      </OctantButton>
    );

  switch (next.kind) {
    case "check-host":
      sentence =
        discovery === undefined
          ? "This window cannot look for runtimes on the host. Open Octant on the host to find it."
          : `Octant has not looked for ${name} on this host yet. Looking reads each runtime's version under confinement; it starts no session and changes nothing.`;
      action = scan("Look on this host");
      break;
    case "install":
      sentence = `${name} is not in the places Octant looks. Octant does not install runtimes: install it from its maker, then look again. If it is installed somewhere unusual, add it with its path on Providers & Models.`;
      action = scan("Look again");
      secondary = openProviders;
      break;
    case "add-detected": {
      const { candidate } = next;
      const connecting = discovery?.connectingPaths.has(candidate.binaryPath) === true;
      sentence = `Found ${name}${candidate.version === undefined ? "" : ` ${candidate.version}`} in ${candidate.pathSummary}. Adding it makes one provider for this runtime and switches it on.`;
      action =
        discovery === undefined ? null : (
          <OctantButton
            disabled={disabled || connecting}
            onClick={() =>
              void run(() => discovery.onConnect(candidate), `Octant could not add ${name}.`)
            }
            size="sm"
            type="button"
            variant="default"
          >
            {connecting ? "Adding…" : retryLabel(`Add ${name}`)}
          </OctantButton>
        );
      break;
    }
    case "add-endpoint":
      if (signsInFromHostTerminal) {
        sentence = `Add it under Octant Harness › Model endpoints: choose ${name} in Add endpoint and give your organization's access portal, account, role, and models. It takes no key; you sign in from a terminal on this host.`;
        action = openEndpoints;
        break;
      }
      if (entry.source.kind === "outside") {
        const listing = entry.source.listing;
        const onAdd = props.onAddOutsideProvider;
        sentence = `Add a provider from ${name}: give the address of the service it speaks to and the models to offer. It is added off; its process starts only when you check the connection.`;
        action =
          onAdd === undefined ? null : (
            <OutsideDriverAddForm
              credentialManagementAvailable={props.credentialManagementAvailable === true}
              disabled={disabled}
              listing={listing}
              onAdd={(displayName, configuration, credential) =>
                void run(
                  () => onAdd(displayName, configuration, credential),
                  `Octant could not add a provider from ${name}.`,
                )
              }
              pending={pending}
            />
          );
        break;
      }
      sentence = `Add it under Octant Harness › Model endpoints: choose ${name} in Add endpoint and give its address. A key you enter is stored in ${keyStore}.`;
      action = openEndpoints;
      break;
    case "turn-on":
      sentence = "It is added but off, so no thread can use it.";
      action = (
        <OctantButton
          disabled={disabled}
          onClick={() =>
            void run(
              () => props.onSetEnabled(next.instanceId, true),
              `Octant could not turn ${name} on.`,
            )
          }
          size="sm"
          type="button"
          variant="default"
        >
          {pending ? "Turning on…" : retryLabel("Turn on")}
        </OctantButton>
      );
      break;
    case "sign-in":
      if (signsInFromHostTerminal) {
        sentence =
          "It signs in at your organization's single sign-on portal: run octant provider sign-in with its name in a terminal on this host, then check again.";
        action = (
          <CheckButton {...props} instanceId={next.instanceId} label="Check again" run={run} />
        );
        break;
      }
      sentence =
        entry.source.kind === "outside"
          ? `Its last check says the service refused the key or has none. Add or replace it on its card below, then check again. The key is stored in ${keyStore} and never reaches the driver.`
          : state.setup === "endpoint"
            ? `Its last check says it needs a sign-in or a key. Add it on its Model endpoints page; a key is stored in ${keyStore}, never in the catalog.`
            : `Its last check says it needs a sign-in. Sign in from its card below, then check again. A key you enter there is stored in ${keyStore}, never in the catalog.`;
      action =
        state.setup === "endpoint" && entry.source.kind === "bundled" ? (
          openEndpoints
        ) : (
          <CheckButton {...props} instanceId={next.instanceId} label="Check again" run={run} />
        );
      break;
    case "check-connection":
      sentence =
        state.ready === "checking"
          ? "Checking the connection…"
          : "It has not been checked since it was turned on. A check starts it once to read its models and sign-in.";
      action = (
        <CheckButton
          {...props}
          instanceId={next.instanceId}
          label={retryLabel("Check connection")}
          run={run}
          pending={pending || state.ready === "checking"}
        />
      );
      break;
    case "fix-runtime":
      sentence =
        next.readiness === "incompatible"
          ? "This version is not one Octant can drive. Update it from its maker, then check again."
          : next.readiness === "degraded"
            ? "It answered but reported a problem. Its card has what it said; check again once it is fixed."
            : entry.source.kind === "outside"
              ? "Octant could not start the driver or reach the service. Its card below has what the host answered."
              : state.setup === "endpoint"
                ? "Octant could not reach it. Its Model endpoints page has what the host answered."
                : "Octant could not start it at its configured path. If it moved, use Locate binary… on its card below, then check again.";
      action = (
        <CheckButton
          {...props}
          instanceId={next.instanceId}
          label={retryLabel("Check again")}
          run={run}
          pending={pending}
        />
      );
      secondary =
        state.setup === "endpoint" && entry.source.kind === "bundled" ? openEndpoints : null;
      break;
    case "done":
    case "unavailable":
      return null;
  }

  // The controller's own sentence names the precise refusal; the step's
  // fallback stands in when it has none.
  const failureText =
    failure === undefined
      ? undefined
      : ((next.kind === "check-host" || next.kind === "install" || next.kind === "add-detected"
          ? (discovery?.message ?? discovery?.snapshot?.message)
          : props.message) ?? failure);

  return (
    <div className="provider-catalog__current">
      <p className="provider-catalog__sentence">{sentence}</p>
      {action === null && secondary === null ? null : (
        <div className="provider-catalog__actions">
          {action}
          {secondary}
        </div>
      )}
      <div aria-live="polite" className="provider-catalog__result">
        {failureText === undefined ? null : <OctantAlert tone="warning">{failureText}</OctantAlert>}
      </div>
    </div>
  );
}

function CheckButton(
  props: ProviderCatalogViewProps & {
    readonly instanceId: ProviderInstanceId;
    readonly label: string;
    readonly pending?: boolean;
    readonly run: (action: () => Promise<unknown>, fallback: string) => Promise<void>;
    readonly entry: CatalogEntry;
  },
) {
  const checking = props.pending === true || props.probingIds.has(props.instanceId);
  return (
    <OctantButton
      disabled={checking || props.busy || props.status !== "ready"}
      onClick={() =>
        void props.run(
          () => props.onProbe(props.instanceId),
          `Octant could not check ${props.entry.name}.`,
        )
      }
      size="sm"
      type="button"
      variant="default"
    >
      {checking ? "Checking…" : props.label}
    </OctantButton>
  );
}
