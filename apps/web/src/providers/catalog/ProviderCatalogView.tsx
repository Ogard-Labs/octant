import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
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
import { SettingsSection } from "../../settings/primitives";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { ProviderGlyph } from "../ProviderGlyph";
import { PROVIDER_LOGOS } from "../providerLogoPaths";
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
}

const BUNDLED_LISTINGS = bundledProviderDriverCatalog();

interface CatalogEntry {
  readonly listing: ProviderDriverCatalogListing;
  readonly name: string;
  readonly state: ProviderCatalogState;
}

/**
 * Settings › Provider catalog: every provider driver bundled with Octant, what
 * this host already has of each, and a guided setup that continues the
 * provider already configured. Browsing reads the registry and the last scan
 * only; every step that runs something is a button.
 */
export function ProviderCatalogView(props: ProviderCatalogViewProps) {
  const listings = props.listings ?? BUNDLED_LISTINGS;
  const [openKind, setOpenKind] = useState<ProviderDriverKind>();
  const [returnFocusTo, setReturnFocusTo] = useState<ProviderDriverKind>();
  const list = useRef<HTMLDivElement>(null);
  const snapshot = props.discovery?.snapshot;
  const entries = useMemo<ReadonlyArray<CatalogEntry>>(
    () =>
      listings.map((listing) => ({
        listing,
        name: listing.entry.manifest.displayName,
        state: resolveProviderCatalogState(
          {
            driverKind: listing.entry.driverKind,
            installed: listing.installed,
            trusted: listing.trusted,
            available: listing.activation.kind === "effective",
          },
          {
            instances: props.instances,
            observedByInstance: props.observedByInstance,
            probingIds: props.probingIds,
            discovery: snapshot,
          },
        ),
      })),
    [listings, props.instances, props.observedByInstance, props.probingIds, snapshot],
  );
  const open = entries.find((entry) => entry.listing.entry.driverKind === openKind);

  const { onDetailChange } = props;
  const openName = open?.name;
  useEffect(() => {
    onDetailChange?.(openName);
  }, [onDetailChange, openName]);
  useEffect(() => () => onDetailChange?.(undefined), [onDetailChange]);

  // Back returns focus to the row the setup was opened from.
  useEffect(() => {
    if (open !== undefined || returnFocusTo === undefined) return;
    list.current?.querySelector<HTMLElement>(`[data-catalog-kind="${returnFocusTo}"]`)?.focus();
    setReturnFocusTo(undefined);
  }, [open, returnFocusTo]);

  if (open !== undefined) {
    return (
      <ProviderCatalogDetail
        {...props}
        entry={open}
        onBack={() => {
          setReturnFocusTo(open.listing.entry.driverKind);
          setOpenKind(undefined);
        }}
      />
    );
  }

  const runtimes = entries.filter((entry) => entry.state.setup === "runtime");
  const endpoints = entries.filter((entry) => entry.state.setup === "endpoint");
  const ready = entries.filter((entry) => entry.state.next.kind === "done").length;
  const needsYou = entries.filter((entry) => {
    const tone = providerCatalogStatus(entry.state).tone;
    return tone === "needs-you" || tone === "failed";
  }).length;
  const renderRow = (entry: CatalogEntry) => (
    <CatalogRow
      entry={entry}
      key={entry.listing.entry.driverKind}
      onOpen={() => setOpenKind(entry.listing.entry.driverKind)}
    />
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
          Every provider driver here ships with Octant, so each is already installed and trusted.
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

function CatalogRow(props: { readonly entry: CatalogEntry; readonly onOpen: () => void }) {
  const { entry } = props;
  const driverKind = entry.listing.entry.driverKind;
  const status = providerCatalogStatus(entry.state);
  const configured =
    entry.state.instanceCount > 1 ? ` · ${entry.state.instanceCount} configured` : "";
  return (
    <li className="endpoint-row" data-tone={status.tone}>
      <a
        aria-label={`${entry.name}, ${status.label.toLowerCase()}. Open setup`}
        className="endpoint-row__link window-no-drag"
        data-catalog-kind={driverKind}
        href={`#provider-catalog-${driverKind}`}
        onClick={(event) => {
          event.preventDefault();
          props.onOpen();
        }}
      >
        <CatalogMark driverKind={driverKind} name={entry.name} />
        <span className="endpoint-row__text">
          <span className="endpoint-row__name">{entry.name}</span>
          <span className="endpoint-row__sub">
            {kindLabel(entry.state)} · Bundled{configured}
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
  const { manifest } = entry.listing.entry;
  const driverKind = entry.listing.entry.driverKind;
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
  const runtimeCard =
    state.setup === "runtime" && state.instance !== undefined
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
      {state.setup === "endpoint" && state.instance !== undefined ? (
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

      <SettingsSection title="Package">
        <p className="settings-section-line">
          Bundled with Octant, so it is already installed and trusted. There is nothing to download
          or approve here, and the catalog cannot change what it is allowed to do.
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
    </div>
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
      sentence = `Add it under Octant Harness › Model endpoints: choose ${name} in Add endpoint and give its address. A key you enter is stored in the system keychain.`;
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
      sentence =
        state.setup === "endpoint"
          ? "Its last check says it needs a sign-in or a key. Add it on its Model endpoints page; a key is stored in the system keychain, never in the catalog."
          : "Its last check says it needs a sign-in. Sign in from its card below, then check again. A key you enter there is stored in the system keychain, never in the catalog.";
      action =
        state.setup === "endpoint" ? (
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
      secondary = state.setup === "endpoint" ? openEndpoints : null;
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
