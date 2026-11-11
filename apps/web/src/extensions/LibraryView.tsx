import { PAPER_LOCAL_SETUP } from "@octant/domain";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  DiscoveredAgentToolingListing,
  ExtensionCommandFailure,
  ExtensionPackagePreview,
} from "@octant/contracts/extension-rpc";
import { BookOpen, Check, ChevronRight, Puzzle, Search, Server, X } from "lucide-react";
import {
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { thisComputerName, useHostPlatform } from "../platform";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { SettingsSection } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { connectConnector, connectPaperLocalServer } from "./connectConnector";
import { connectorLogoInks } from "../theme/connectorBrandColors";
import { CONNECTOR_LOGOS } from "./connectorLogos";
import { McpServerSignInControl } from "./McpServerSignInControl";
import { ConnectionStatus, connectionNeedsAttention } from "./ServerConnections";
import {
  ALL_PROVIDERS,
  LIBRARY_KIND_LABEL,
  abilitiesFor,
  authorityFor,
  featuredItems,
  filterLibrary,
  groupLibrary,
  libraryCounts,
  libraryProviders,
  type AuthorityLevel,
  type LibraryFilter,
  type LibraryHandoff,
  type LibraryItem,
  type LibraryKind,
  type LibrarySteps,
} from "./libraryModel";

const KINDS: ReadonlyArray<LibraryKind> = ["connector", "plugin", "skill", "mcp-server"];
const STATE_FILTERS = [
  { value: "all", label: "Any state" },
  { value: "installed", label: "Installed" },
  { value: "available", label: "Not installed" },
  { value: "attention", label: "Needs a decision" },
] as const;

const AUTHORITY_LABEL: Readonly<Record<AuthorityLevel, string>> = {
  none: "Unknown",
  low: "Low authority",
  medium: "Medium authority",
  high: "High authority",
};
const AUTHORITY_SHORT: Readonly<Record<AuthorityLevel, string>> = {
  none: "Unknown",
  low: "Low",
  medium: "Medium",
  high: "High",
};
const AUTHORITY_DOTS: Readonly<Record<AuthorityLevel, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const HANDOFF_ACTION: Readonly<Record<LibraryHandoff, string>> = {
  connectors: "Connect…",
  marketplace: "Review in Marketplace",
  installed: "Open in Installed",
};

/** What a Marketplace item's review is doing, kept by the screen that fetches it. */
export interface LibraryInspection {
  readonly itemId: string;
  readonly status: "loading" | "ready" | "failed";
  readonly preview?: ExtensionPackagePreview;
  readonly message?: string;
}

export interface LibraryViewProps {
  readonly items: ReadonlyArray<LibraryItem>;
  /** The toggle between the views, kept in the section's actions. */
  readonly actions: ReactNode;
  /** Set while the installed set has not been read yet. */
  readonly loading?: boolean;
  /** The local scan of Claude Code and Codex failed or has not answered. */
  readonly scanFailed?: boolean;
  readonly marketplaceFetchesEnabled: boolean;
  readonly disabled: boolean;
  readonly busyExtensionId?: string | undefined;
  readonly onOpen: (target: LibraryHandoff, item: LibraryItem) => void;
  /** Opens the panel for adding tools to Claude Code and Codex; absent when it is unavailable here. */
  readonly onOpenAccountTools?: () => void;
  readonly onTrust: (item: LibraryItem, trusted: boolean) => void;
  readonly onPluginDesired: (item: LibraryItem, desired: boolean) => void;
  /** Connects a catalog connector from the Library; without it a connector can only be opened. */
  readonly connectClient?: Pick<ExtensionClient, "addUserMcpServer" | "mcpServerSignIn">;
  /** Whether this host keeps keys and runs sign-ins: the Octant window on it. */
  readonly localHost?: boolean;
  /** Told after a connector was added, so the installed set is read again. */
  readonly onConnected?: () => void;
  /** Reads what a Marketplace item holds; installing waits for it. */
  readonly onInspect?: (item: LibraryItem) => void;
  readonly inspection?: LibraryInspection | undefined;
  /** Installs a reviewed Marketplace item. Installing never trusts or turns it on. */
  readonly onInstall?: (item: LibraryItem) => void;
  readonly installing?: boolean;
}

export type { DiscoveredAgentToolingListing };

/** A connector connected from here, kept until the installed set shows it. */
interface FreshConnection {
  readonly extensionId: string | undefined;
  readonly componentId: string | undefined;
}

/** Follow an item that changed identity when it was installed or connected. */
function resolveOpen(
  items: ReadonlyArray<LibraryItem>,
  openId: string | undefined,
): LibraryItem | undefined {
  if (openId === undefined) return undefined;
  const exact = items.find((item) => item.id === openId);
  if (exact !== undefined) return exact;
  if (openId.startsWith("marketplace:")) {
    return items.find((item) => item.id === `package:${openId.slice("marketplace:".length)}`);
  }
  if (openId.startsWith("connector:")) {
    const connectorId = openId.slice("connector:".length);
    return items.find((item) => item.connectorId === connectorId && item.id.startsWith("package:"));
  }
  return undefined;
}

/**
 * One searchable place for everything an agent can be given: connectors,
 * plugins, skills and MCP servers, from the bundled list, the installed set
 * and what was already found. It reads only what is in hand and never
 * fetches. A card says what to do next: connect a connector, review a
 * plugin, or where an installed one stands; the detail says what it can do
 * and what that costs, and finishes the job without leaving the page.
 */
export function LibraryView(props: LibraryViewProps) {
  const ids = useId();
  const [filter, setFilter] = useState<LibraryFilter>({
    query: "",
    kind: "all",
    state: "all",
    provider: ALL_PROVIDERS,
  });
  const [openId, setOpenId] = useState<string>();
  const [connectingId, setConnectingId] = useState<string>();
  const [failure, setFailure] = useState<ExtensionCommandFailure>();
  /** Lists the person opened to every item; the rest show their first few. */
  const [everyItem, setEveryItem] = useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<Readonly<Record<string, FreshConnection>>>({});
  const opener = useRef<HTMLElement | null>(null);
  const counts = useMemo(() => libraryCounts(props.items), [props.items]);
  const providers = useMemo(() => libraryProviders(props.items), [props.items]);
  const shown = useMemo(() => filterLibrary(props.items, filter), [props.items, filter]);
  const lead = useMemo(() => featuredItems(shown, filter), [shown, filter]);
  const groups = useMemo(() => groupLibrary(shown, filter), [shown, filter]);
  const open = resolveOpen(props.items, openId);
  const filtering =
    filter.query.trim() !== "" ||
    filter.kind !== "all" ||
    filter.state !== "all" ||
    filter.provider !== ALL_PROVIDERS;
  const canConnect =
    props.connectClient !== undefined && props.localHost === true && !props.disabled;

  const connect = async (item: LibraryItem, secret?: string): Promise<boolean> => {
    if (item.localSetupId === "paper" && props.connectClient !== undefined) {
      setConnectingId(item.id);
      setFailure(undefined);
      const result = await connectPaperLocalServer(props.connectClient);
      setConnectingId(undefined);
      if (result.kind === "failed") {
        setFailure(result.failure);
        return false;
      }
      props.onConnected?.();
      return true;
    }
    if (
      item.connectorId === undefined ||
      item.connectorAuth === undefined ||
      item.address === undefined ||
      props.connectClient === undefined
    ) {
      return false;
    }
    const entry = {
      id: item.connectorId,
      displayName: item.name,
      url: item.address,
      auth: item.connectorAuth,
    };
    setConnectingId(item.id);
    setFailure(undefined);
    const result = await connectConnector(props.connectClient, entry, secret);
    setConnectingId(undefined);
    if (result.kind === "failed") {
      setFailure(result.failure);
      return false;
    }
    setFresh((current) => ({
      ...current,
      [entry.id]: { extensionId: result.extensionId, componentId: result.componentId },
    }));
    props.onConnected?.();
    return true;
  };

  // Connect on a card opens the detail, which states the authority in full
  // and holds the one confirming press, the key field and the sign-in.
  const act = (item: LibraryItem, element: HTMLElement) => {
    opener.current = element;
    setOpenId(item.id);
  };

  const renderRow = (item: LibraryItem) => (
    <li key={item.id}>
      <LibraryRow
        item={item}
        onAct={(element) => act(item, element)}
        onOpen={(element) => {
          opener.current = element;
          setOpenId(item.id);
        }}
      />
    </li>
  );

  const renderList = (key: string, items: ReadonlyArray<LibraryItem>, label: string) => {
    const { shown: rows, hidden } = visibleRows(items, everyItem.has(key));
    const toggle = (all: boolean) =>
      setEveryItem((current) => {
        const next = new Set(current);
        if (all) next.add(key);
        else next.delete(key);
        return next;
      });
    return (
      <>
        <ul aria-label={label} className="library__list">
          {rows.map(renderRow)}
        </ul>
        {hidden > 0 ? (
          <OctantButton
            className="library__more"
            onClick={() => toggle(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Show all {items.length}
          </OctantButton>
        ) : everyItem.has(key) && items.length > LIST_CAP_TRIGGER ? (
          <OctantButton
            className="library__more"
            onClick={() => toggle(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Show fewer
          </OctantButton>
        ) : null}
      </>
    );
  };

  return (
    <SettingsSection
      actions={props.actions}
      className="extensions-settings__section"
      description="Connectors, plugins, skills and MCP servers in one place. Nothing here is fetched to show it."
      title="Library"
    >
      <div className="library">
        <div className="library__search">
          <Search aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
          <OctantInput
            aria-label="Search the library"
            className="library__search-input"
            id={`${ids}-search`}
            onChange={(event) => {
              const query = event.currentTarget.value;
              setFilter((current) => ({ ...current, query }));
            }}
            placeholder="Search the library"
            type="search"
            value={filter.query}
          />
        </div>
        <div className="library__filters">
          <OctantToggleGroup<LibraryFilter["kind"]>
            aria-label="Kind"
            className="library__kinds"
            onValueChange={(value) => {
              const kind = value[0] ?? "all";
              setFilter((current) => ({ ...current, kind }));
            }}
            value={[filter.kind]}
          >
            <OctantToggleGroupItem value="all">All {props.items.length}</OctantToggleGroupItem>
            {KINDS.map((kind) => (
              <OctantToggleGroupItem key={kind} value={kind}>
                {LIBRARY_KIND_LABEL[kind]} {counts[kind]}
              </OctantToggleGroupItem>
            ))}
          </OctantToggleGroup>
          <div className="library__selects">
            <OctantSelectField
              aria-label="State"
              className="library__select"
              onValueChange={(value) => {
                const state = value as LibraryFilter["state"];
                setFilter((current) => ({ ...current, state }));
              }}
              options={STATE_FILTERS.map((option) => ({ id: option.value, label: option.label }))}
              value={filter.state}
            />
            {providers.length > 0 ? (
              <OctantSelectField
                aria-label="Provider"
                className="library__select"
                onValueChange={(provider) => setFilter((current) => ({ ...current, provider }))}
                options={[
                  { id: ALL_PROVIDERS, label: "Any provider" },
                  ...providers.map((provider) => ({ id: provider, label: provider })),
                ]}
                value={filter.provider}
              />
            ) : null}
          </div>
        </div>
        {props.onOpenAccountTools === undefined ? null : (
          <p className="library__note">
            Want a tool inside Claude Code or Codex itself?{" "}
            <OctantButton
              onClick={props.onOpenAccountTools}
              size="xs"
              type="button"
              variant="ghost"
            >
              Add it to an account
            </OctantButton>
          </p>
        )}
        {!props.marketplaceFetchesEnabled ? (
          <p className="library__note" role="status">
            Marketplace fetches are off, so Marketplace search finds nothing new. Installed items
            and the connector list still show.
          </p>
        ) : null}
        {props.scanFailed === true ? (
          <p className="library__note" role="status">
            Octant could not look for tools already set up in Claude Code and Codex on this
            computer.
          </p>
        ) : null}
        {failure === undefined || open !== undefined ? null : (
          <OctantAlert tone="warning">{failure.message}</OctantAlert>
        )}
        {props.loading === true ? (
          <ul aria-label="Loading the library" aria-busy="true" className="library__list">
            {Array.from({ length: 6 }, (_, index) => (
              <li className="library__row library__row--skeleton" key={index} />
            ))}
          </ul>
        ) : shown.length === 0 ? (
          <OctantEmpty
            action={
              filtering ? (
                <OctantButton
                  onClick={() =>
                    setFilter({ query: "", kind: "all", state: "all", provider: ALL_PROVIDERS })
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Clear search and filters
                </OctantButton>
              ) : undefined
            }
            className="library__empty"
            icon={<Search aria-hidden="true" size={20} strokeWidth={1.5} />}
            message={
              filtering
                ? "Try another word, or clear the filters to see everything."
                : "Connectors you can add, and anything installed, will show here."
            }
            role="status"
            title={filtering ? "Nothing matches" : "Nothing here yet"}
          />
        ) : (
          <>
            {lead.length === 0 ? null : (
              <section aria-label="Featured" className="library__group library__group--lead">
                <details className="library__fold" open={filtering}>
                  <summary className="library__group-summary">
                    <ChevronRight aria-hidden="true" className="library__chevron" size={12} />
                    <h3 className="library__group-title">
                      Featured <span className="library__count">{lead.length}</span>{" "}
                      <span className="library__group-note">
                        Picked for everyday agent work; the list ships with Octant
                      </span>
                    </h3>
                  </summary>
                  {renderList("featured", lead, "Featured")}
                </details>
              </section>
            )}
            {groups.map((group) => (
              <section aria-label={group.title} className="library__group" key={group.key}>
                {/* Reference lists (the catalog's categories, what was found on
                    this computer) stay closed until asked for; what a person has
                    installed, and any search or filter, is open. The count stays
                    on the closed line. */}
                <details className="library__fold" open={libraryGroupOpen(group.key, filtering)}>
                  <summary className="library__group-summary">
                    <ChevronRight aria-hidden="true" className="library__chevron" size={12} />
                    <h3 className="library__group-title">
                      {group.title} <span className="library__count">{group.items.length}</span>
                    </h3>
                  </summary>
                  {renderList(group.key, group.items, group.title)}
                </details>
              </section>
            ))}
          </>
        )}
      </div>
      {open === undefined ? null : (
        <LibraryDetail
          busy={
            props.busyExtensionId !== undefined &&
            props.busyExtensionId === open.packageRef?.extensionId
          }
          canConnect={canConnect}
          connecting={connectingId !== undefined}
          connectClient={props.connectClient}
          connectFailure={failure}
          disabled={props.disabled}
          fresh={open.connectorId === undefined ? undefined : fresh[open.connectorId]}
          inspection={props.inspection?.itemId === open.id ? props.inspection : undefined}
          installing={props.installing === true}
          item={open}
          localHost={props.localHost === true}
          marketplaceFetchesEnabled={props.marketplaceFetchesEnabled}
          onClose={() => {
            setOpenId(undefined);
            setFailure(undefined);
            // A sign-in starts on its own only right after the person pressed Connect.
            setFresh({});
          }}
          onConnect={(secret) => connect(open, secret)}
          onInspect={() => props.onInspect?.(open)}
          onInstall={() => props.onInstall?.(open)}
          onOpen={(target) => {
            setOpenId(undefined);
            props.onOpen(target, open);
          }}
          onPluginDesired={(desired) => props.onPluginDesired(open, desired)}
          onTrust={(trusted) => props.onTrust(open, trusted)}
          restoreFocus={opener}
        />
      )}
    </SettingsSection>
  );
}

/** More items than this and a list shows only its first few. */
const LIST_CAP_TRIGGER = 10;
const LIST_CAP = 8;

/** A decision is waiting on it: blocked, awaiting trust, or a server that is not connecting. */
function needsAttention(item: LibraryItem): boolean {
  return (
    item.state === "blocked" ||
    item.state === "needs-trust" ||
    (item.state === "on" &&
      item.connection !== undefined &&
      connectionNeedsAttention(item.connection.state))
  );
}

/**
 * Items that need a decision lead and are never left behind "Show all": a
 * capped list is those, then the first of the rest up to the cap.
 */
function visibleRows(
  items: ReadonlyArray<LibraryItem>,
  everyItem: boolean,
): { readonly shown: ReadonlyArray<LibraryItem>; readonly hidden: number } {
  const attention = items.filter(needsAttention);
  const rest = items.filter((item) => !needsAttention(item));
  const ordered = [...attention, ...rest];
  if (everyItem || items.length <= LIST_CAP_TRIGGER) return { shown: ordered, hidden: 0 };
  const shown = [...attention, ...rest.slice(0, Math.max(0, LIST_CAP - attention.length))];
  return { shown, hidden: ordered.length - shown.length };
}

function libraryGroupOpen(key: string, filtering: boolean): boolean {
  return filtering || key === "installed" || key === "results";
}

interface LibraryRowProps {
  readonly item: LibraryItem;
  readonly onOpen: (element: HTMLElement) => void;
  readonly onAct: (element: HTMLElement) => void;
}

/** What an item offers before anything is installed: the one next step. */
function cardAction(item: LibraryItem): string | undefined {
  if (item.state !== "available") return undefined;
  if (item.localSetupId === "paper") return "Set up…";
  if (item.kind === "connector")
    return item.connectorAuth?.kind === "key" ? "Add key…" : "Connect…";
  return "Review";
}

/**
 * One line per item: its mark, its name (which opens the detail that holds the
 * description, what it can do and what that costs), where it comes from in the
 * meta ink, and at the trailing edge its state or its one next step. Every row
 * is the same height, so a list of fifty reads as a list.
 */
function LibraryRow(props: LibraryRowProps) {
  const { item } = props;
  const action = cardAction(item);
  return (
    <article
      className="library__row"
      data-attention={needsAttention(item) ? "true" : undefined}
      data-state={item.state}
    >
      <LibraryMark item={item} />
      <OctantButton
        className="library__open"
        onClick={(event) => props.onOpen(event.currentTarget)}
        type="button"
        variant="ghost"
      >
        {item.name}
      </OctantButton>
      <span className="library__row-source">
        {item.category ?? item.source}
        {item.provider === "Every provider" ? "" : ` · ${item.provider}`}
      </span>
      <span className="library__row-foot">
        <AuthorityDots level={item.authority.level} showWord={item.authority.level === "high"} />
        {action !== undefined ? (
          <OctantButton
            aria-label={`${action} ${item.name}`}
            onClick={(event) => props.onAct(event.currentTarget)}
            size="sm"
            type="button"
            variant={item.kind === "connector" ? "outline" : "ghost"}
          >
            {action}
          </OctantButton>
        ) : item.state === "on" &&
          item.connection !== undefined &&
          connectionNeedsAttention(item.connection.state) ? (
          // A switched-on server that is not working says so on its row;
          // the detail carries the reason.
          <ConnectionStatus connection={{ state: item.connection.state }} />
        ) : item.state === "on" ? (
          <span className="library__card-on">
            <Check aria-hidden="true" size={12} strokeWidth={2} />
            On
          </span>
        ) : (
          <OctantBadge variant="secondary">{item.stateLabel}</OctantBadge>
        )}
      </span>
    </article>
  );
}

/** Two letters, so "Stripe", "Sentry" and "Supabase" are three different tiles. */
export function monogramFor(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0] ?? "";
  const second = words[1];
  const letters =
    second === undefined || second === ""
      ? first.slice(0, 2)
      : `${first.slice(0, 1)}${second.slice(0, 1)}`;
  const text = letters === "" ? "?" : letters;
  return `${text.slice(0, 1).toLocaleUpperCase()}${text.slice(1).toLocaleLowerCase()}`;
}

function logoInkStyle(connectorId: string): CSSProperties {
  const inks = connectorLogoInks(connectorId);
  return {
    ...(inks.light === undefined ? {} : { "--library-logo-light": inks.light }),
    ...(inks.dark === undefined ? {} : { "--library-logo-dark": inks.dark }),
  } as CSSProperties;
}

export function LibraryMark(props: { readonly item: LibraryItem; readonly large?: boolean }) {
  const { item } = props;
  const size = props.large === true ? 24 : 20;
  const logo = item.connectorId === undefined ? undefined : CONNECTOR_LOGOS[item.connectorId];
  let mark: ReactNode;
  if (item.providerLogo !== undefined) {
    mark = <ProviderGlyph displayName={item.provider} driverKind={item.providerLogo} size={size} />;
  } else if (logo !== undefined) {
    mark = (
      <svg
        aria-hidden="true"
        className="library__logo"
        focusable="false"
        style={logoInkStyle(item.connectorId ?? "")}
        height={size}
        viewBox="0 0 24 24"
        width={size}
      >
        <path d={logo.path} fill="currentColor" />
      </svg>
    );
  } else if (item.kind === "connector") {
    mark = (
      <span aria-hidden="true" className="library__monogram">
        {monogramFor(item.name)}
      </span>
    );
  } else if (item.kind === "skill") {
    mark = <BookOpen aria-hidden="true" size={size} strokeWidth={1.5} />;
  } else if (item.kind === "mcp-server") {
    mark = <Server aria-hidden="true" size={size} strokeWidth={1.5} />;
  } else {
    mark = <Puzzle aria-hidden="true" size={size} strokeWidth={1.5} />;
  }
  return (
    <span
      className={`library__mark${props.large === true ? " library__mark--large" : ""}`}
      data-logo={logo === undefined ? "none" : "mark"}
    >
      {mark}
    </span>
  );
}

function AuthorityDots(props: { readonly level: AuthorityLevel; readonly showWord?: boolean }) {
  const filled = AUTHORITY_DOTS[props.level];
  return (
    <span
      className="library__authority"
      data-level={props.level}
      title={AUTHORITY_LABEL[props.level]}
    >
      <span aria-hidden="true" className="library__dots">
        {[1, 2, 3].map((n) => (
          <span className="library__dot" data-on={n <= filled ? "true" : "false"} key={n} />
        ))}
      </span>
      {props.showWord === false ? null : (
        <span className="library__authority-label">{AUTHORITY_SHORT[props.level]}</span>
      )}
      <span className="sr-only">
        {props.showWord === false ? `${AUTHORITY_SHORT[props.level]} authority` : " authority"}
      </span>
    </span>
  );
}

const STEP_LABEL: ReadonlyArray<readonly [keyof LibrarySteps, string]> = [
  ["install", "Install"],
  ["trust", "Trust"],
  ["enable", "Turn on"],
];

function StepLadder(props: { readonly steps: LibrarySteps }) {
  return (
    <ol aria-label="From install to on" className="library__steps">
      {STEP_LABEL.map(([key, label], index) => (
        <li className="library__step" data-step={props.steps[key]} key={key}>
          <span aria-hidden="true" className="library__step-mark">
            {props.steps[key] === "done" ? <Check size={12} strokeWidth={2} /> : index + 1}
          </span>
          <span>{label}</span>
          <span className="sr-only">
            {props.steps[key] === "done" ? ", done" : props.steps[key] === "next" ? ", next" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface LibraryDetailProps {
  readonly item: LibraryItem;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly canConnect: boolean;
  readonly localHost: boolean;
  readonly connecting: boolean;
  readonly connectClient: LibraryViewProps["connectClient"];
  readonly connectFailure: ExtensionCommandFailure | undefined;
  readonly fresh: FreshConnection | undefined;
  readonly inspection: LibraryInspection | undefined;
  readonly installing: boolean;
  readonly marketplaceFetchesEnabled: boolean;
  readonly onClose: () => void;
  readonly onConnect: (secret?: string) => Promise<boolean>;
  readonly onInspect: () => void;
  readonly onInstall: () => void;
  readonly onOpen: (target: LibraryHandoff) => void;
  readonly onTrust: (trusted: boolean) => void;
  readonly onPluginDesired: (desired: boolean) => void;
  readonly restoreFocus: React.RefObject<HTMLElement | null>;
}

function LibraryDetail(props: LibraryDetailProps) {
  const { item } = props;
  const titleId = useId();
  const hostPlatform = useHostPlatform();
  const [key, setKey] = useState("");
  const ref = item.packageRef;
  const next = item.steps.trust === "next" ? "trust" : item.steps.enable === "next" ? "enable" : "";
  const locked = props.disabled || props.busy;
  const available = ref === undefined;
  const connector = available && item.kind === "connector" && item.connectorId !== undefined;
  const localSetup = item.localSetupId === "paper";
  const reviewable = available && item.marketplaceExtensionId !== undefined;
  const preview = props.inspection?.status === "ready" ? props.inspection.preview : undefined;
  const capabilities = preview?.review.declaredCapabilities;
  const authority = capabilities === undefined ? item.authority : authorityFor(capabilities);
  const abilities = capabilities === undefined ? item.abilities : abilitiesFor(capabilities);
  const signInComponent = item.mcpComponentId ?? props.fresh?.componentId;
  const signInExtension = ref?.extensionId ?? props.fresh?.extensionId;
  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim().length > 0) void props.onConnect(key.trim()).then((ok) => ok && setKey(""));
  };
  return (
    <OctantDialog
      className="library-detail"
      label={item.name}
      labelledBy={titleId}
      onClose={props.onClose}
      open
      restoreFocus={props.restoreFocus}
    >
      <header className="library-detail__head">
        <LibraryMark item={item} large />
        <div className="library-detail__title">
          <h3 id={titleId}>{item.name}</h3>
          <p className="library-detail__meta">
            {item.source}
            {item.provider === "Every provider" ? "" : ` · ${item.provider}`}
            {item.version === undefined ? "" : ` · ${item.version}`}
          </p>
        </div>
        <OctantButton
          aria-label="Close"
          onClick={props.onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={16} strokeWidth={1.5} />
        </OctantButton>
      </header>
      {item.summary === undefined ? null : (
        <p className="library-detail__summary">{item.summary}</p>
      )}
      <StepLadder steps={item.steps} />
      {localSetup ? (
        <section aria-label="Paper Desktop setup" className="library-detail__review">
          <h4 className="library-detail__label">On this computer</h4>
          <p className="library__note">
            Open Paper Desktop and a file before using its tools. Adding the server does not check
            that a document is available.
          </p>
          <p className="library__note">
            This setup connects to Paper Desktop&apos;s local address on this host.
          </p>
          <p className="library__note">
            The Paper CLI is optional for this local-address setup. If Desktop is closed or no file
            is open, open both and retry in your task. Restart the agent session if it needs to
            reload its tools.
          </p>
          <a href={PAPER_LOCAL_SETUP.documentationUrl} target="_blank" rel="noreferrer">
            Paper setup instructions
          </a>
        </section>
      ) : null}
      {item.stateNote === undefined ? null : (
        <p className="library__note" role="status">
          {item.stateNote}
        </p>
      )}
      {item.connection !== undefined && connectionNeedsAttention(item.connection.state) ? (
        <p className="library__note" role="status">
          <ConnectionStatus connection={item.connection} />{" "}
          <OctantButton onClick={() => props.onOpen("installed")} size="sm" variant="link">
            Server connections
          </OctantButton>
        </p>
      ) : null}
      <div className="library-detail__cols">
        <section aria-label="What it can do">
          <h4 className="library-detail__label">What it can do</h4>
          <ul className="library-detail__list">
            {abilities.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section aria-label="What it costs in authority">
          <h4 className="library-detail__label">What it costs in authority</h4>
          <p className="library-detail__level">
            <AuthorityDots level={authority.level} />
          </p>
          <ul className="library-detail__list">
            {authority.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
      {item.address === undefined ? null : (
        <p className="library-detail__address">
          <span className="oct-meta">Address</span> <code>{item.address}</code>
        </p>
      )}
      {item.docsUrl === undefined ? null : (
        <a
          aria-label={`${item.name} setup guide`}
          className="library-detail__guide"
          href={item.docsUrl}
          rel="noreferrer"
          target="_blank"
        >
          Vendor setup guide
        </a>
      )}
      {props.inspection?.status === "loading" ? (
        <p className="library__note" role="status">
          Reading what it holds…
        </p>
      ) : null}
      {preview === undefined ? null : (
        <section aria-label="What it holds" className="library-detail__review">
          <h4 className="library-detail__label">What it holds</h4>
          <ul className="library-detail__list">
            {preview.review.components.map((component) => (
              <li key={component.id}>
                {component.displayName} <span className="oct-meta">{component.kind}</span>
              </li>
            ))}
          </ul>
          <p className="library-detail__meta">
            {preview.review.provenance.publisher === undefined
              ? ""
              : `Publisher ${preview.review.provenance.publisher} · `}
            {preview.review.provenance.reviewed ? "Source reviewed" : "Source not reviewed"}
          </p>
          {preview.diagnostics.length === 0 ? null : (
            <ul className="library-detail__list">
              {preview.diagnostics.map((diagnostic) => (
                <li key={diagnostic.code}>{diagnostic.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      {props.inspection?.status === "failed" ? (
        <OctantAlert tone="warning">
          {props.inspection.message ?? "It could not be read."}
        </OctantAlert>
      ) : null}
      {props.connectFailure === undefined ? null : (
        <OctantAlert tone="warning">{props.connectFailure.message}</OctantAlert>
      )}
      {item.connectorAuth?.kind === "sign-in" &&
      props.connectClient !== undefined &&
      signInComponent !== undefined &&
      signInExtension !== undefined ? (
        <div className="library-detail__signin">
          <McpServerSignInControl
            autoBegin={props.fresh !== undefined && item.connectorAuth.clientSetup !== "registered"}
            autoSetup={props.fresh !== undefined && item.connectorAuth.clientSetup === "registered"}
            {...(item.connectorAuth.clientSetup === "registered" &&
            item.connectorAuth.setupGuide !== undefined
              ? {
                  registration: {
                    guideUrl: item.connectorAuth.setupGuide,
                    requestedScopes: item.connectorAuth.requestedScopes ?? [],
                    ...(item.connectorAuth.permissionNotice === undefined
                      ? {}
                      : { permissionNotice: item.connectorAuth.permissionNotice }),
                  },
                }
              : {})}
            client={props.connectClient}
            componentId={signInComponent}
            disabled={props.disabled}
            extensionId={signInExtension}
          />
        </div>
      ) : null}
      {connector && item.connectorAuth?.kind === "key" && props.canConnect ? (
        <form
          aria-label={`${item.name} key`}
          className="library-detail__key"
          noValidate
          onSubmit={submitKey}
        >
          <OctantInput
            aria-label="Key"
            autoComplete="off"
            onChange={(event) => setKey(event.currentTarget.value)}
            placeholder="Paste the key"
            spellCheck={false}
            type="password"
            value={key}
          />
          <OctantButton disabled={props.connecting || key.trim() === ""} type="submit">
            {props.connecting ? "Connecting…" : "Connect"}
          </OctantButton>
          <span className="oct-meta">
            Create one at{" "}
            <a href={item.connectorAuth.keyPage} rel="noreferrer" target="_blank">
              {new URL(item.connectorAuth.keyPage).host}
            </a>
            . Kept in {thisComputerName(hostPlatform)}&apos;s credential store.
          </span>
        </form>
      ) : null}
      <footer className="library-detail__actions">
        {localSetup && available ? (
          <OctantButton
            disabled={!props.canConnect || props.connecting}
            onClick={() => void props.onConnect()}
            type="button"
          >
            {props.connecting ? "Adding…" : "Add local server"}
          </OctantButton>
        ) : null}
        {connector && item.connectorAuth?.kind !== "key" ? (
          <OctantButton
            disabled={!props.canConnect || props.connecting}
            onClick={() => void props.onConnect()}
            type="button"
          >
            {props.connecting ? "Connecting…" : "Connect"}
          </OctantButton>
        ) : null}
        {reviewable && preview === undefined ? (
          <OctantButton
            disabled={
              !props.marketplaceFetchesEnabled ||
              props.disabled ||
              props.inspection?.status === "loading"
            }
            onClick={props.onInspect}
            type="button"
          >
            Review before installing
          </OctantButton>
        ) : null}
        {reviewable && preview !== undefined ? (
          <OctantButton
            disabled={props.installing || props.disabled}
            onClick={props.onInstall}
            type="button"
          >
            {props.installing ? "Installing…" : "Install"}
          </OctantButton>
        ) : null}
        {ref !== undefined && next === "trust" ? (
          <OctantButton disabled={locked} onClick={() => props.onTrust(true)} type="button">
            Trust this source
          </OctantButton>
        ) : null}
        {ref !== undefined && next === "enable" ? (
          <OctantButton disabled={locked} onClick={() => props.onPluginDesired(true)} type="button">
            Turn on
          </OctantButton>
        ) : null}
        {ref !== undefined && item.state === "on" && item.kind !== "connector" ? (
          <OctantButton
            disabled={locked}
            onClick={() => props.onPluginDesired(false)}
            type="button"
            variant="outline"
          >
            Turn off
          </OctantButton>
        ) : null}
        {available && !connector && !reviewable && !localSetup ? (
          <OctantButton onClick={() => props.onOpen(item.handoff)} type="button">
            {HANDOFF_ACTION[item.handoff]}
          </OctantButton>
        ) : null}
        {ref !== undefined ? (
          <OctantButton
            onClick={() => props.onOpen("installed")}
            type="button"
            variant={item.state === "blocked" ? "outline" : "ghost"}
          >
            Open in Installed
          </OctantButton>
        ) : null}
      </footer>
      <p className="library-detail__foot oct-meta">
        {localSetup
          ? props.localHost
            ? "Adds this local server, trusts it and turns it on after this confirmation. Tool calls still follow the task's approval policy."
            : "Add the local server from the Octant window on this host."
          : connector
            ? props.localHost
              ? "Connect adds this server to this host, trusts it and turns it on after this confirmation. Tool calls still follow the thread's approval policy."
              : "Connect from the Octant window on this host; a browser-hosted Settings cannot keep a key or run a sign-in."
            : reviewable
              ? "Install only adds it. You trust it and turn it on as separate steps afterwards."
              : ref === undefined
                ? "Installing never trusts or turns anything on by itself. You confirm each step, except a server you add directly, whose confirmation covers those steps."
                : "Tool calls follow the thread's approval policy, including approvals you chose to remember."}
      </p>
    </OctantDialog>
  );
}
