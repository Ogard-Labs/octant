import type { DiscoveredAgentToolingListing } from "@octant/contracts/extension-rpc";
import { BookOpen, Check, Puzzle, Search, Server, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { SettingsSection } from "../settings/primitives";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  ALL_PROVIDERS,
  LIBRARY_KIND_LABEL,
  filterLibrary,
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
}

export type { DiscoveredAgentToolingListing };

/**
 * One searchable place for everything an agent can be given: connectors,
 * plugins, skills and MCP servers, from the bundled list, the installed set
 * and what was already found. It reads only what is in hand and never
 * fetches; the card shows where an item stands on the ladder from install to
 * trust to on, and the detail says what it can do and what that costs.
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
  const opener = useRef<HTMLElement | null>(null);
  const counts = useMemo(() => libraryCounts(props.items), [props.items]);
  const providers = useMemo(() => libraryProviders(props.items), [props.items]);
  const shown = useMemo(() => filterLibrary(props.items, filter), [props.items, filter]);
  const open = props.items.find((item) => item.id === openId);
  const filtering =
    filter.query.trim() !== "" ||
    filter.kind !== "all" ||
    filter.state !== "all" ||
    filter.provider !== ALL_PROVIDERS;

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
        {props.loading === true ? (
          <ul aria-label="Loading the library" aria-busy="true" className="library__grid">
            {Array.from({ length: 6 }, (_, index) => (
              <li className="library__card library__card--skeleton" key={index} />
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
          groupByKind(shown, filter.kind === "all").map((group) => (
            <section aria-label={group.label} className="library__group" key={group.key}>
              {group.label === undefined ? null : (
                <h3 className="library__group-title">
                  {group.label} <span className="library__count">{group.items.length}</span>
                </h3>
              )}
              <ul className="library__grid">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <article className="library__card" data-state={item.state}>
                      <LibraryMark item={item} />
                      <span className="library__card-text">
                        <OctantButton
                          className="library__open"
                          onClick={(event) => {
                            opener.current = event.currentTarget;
                            setOpenId(item.id);
                          }}
                          type="button"
                          variant="ghost"
                        >
                          {item.name}
                        </OctantButton>
                        <span className="library__card-source">
                          {item.category ?? item.source}
                          {item.provider === "Every provider" ? "" : ` · ${item.provider}`}
                        </span>
                        <span className="library__card-summary">{item.summary}</span>
                      </span>
                      <span className="library__card-foot">
                        {item.state === "available" ? (
                          <span className="library__card-state">{item.stateLabel}</span>
                        ) : (
                          <OctantBadge variant={item.state === "on" ? "success" : "secondary"}>
                            {item.stateLabel}
                          </OctantBadge>
                        )}
                        <AuthorityDots level={item.authority.level} />
                      </span>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {open === undefined ? null : (
        <LibraryDetail
          busy={
            props.busyExtensionId !== undefined &&
            props.busyExtensionId === open.packageRef?.extensionId
          }
          disabled={props.disabled}
          item={open}
          onClose={() => setOpenId(undefined)}
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

interface KindGroup {
  readonly key: string;
  readonly label: string | undefined;
  readonly items: ReadonlyArray<LibraryItem>;
}

function groupByKind(items: ReadonlyArray<LibraryItem>, split: boolean): ReadonlyArray<KindGroup> {
  if (!split) return [{ key: "all", label: undefined, items }];
  return KINDS.map((kind) => ({
    key: kind,
    label: LIBRARY_KIND_LABEL[kind],
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

export function LibraryMark(props: { readonly item: LibraryItem; readonly large?: boolean }) {
  const { item } = props;
  const size = props.large === true ? 24 : 20;
  let mark: ReactNode;
  if (item.providerLogo !== undefined) {
    mark = <ProviderGlyph displayName={item.provider} driverKind={item.providerLogo} size={size} />;
  } else if (item.kind === "connector") {
    mark = (
      <span aria-hidden="true" className="library__monogram">
        {item.name.slice(0, 1).toLocaleUpperCase()}
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
    <span className={`library__mark${props.large === true ? " library__mark--large" : ""}`}>
      {mark}
    </span>
  );
}

function AuthorityDots(props: { readonly level: AuthorityLevel }) {
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
      <span className="library__authority-label">{AUTHORITY_SHORT[props.level]}</span>
      <span className="sr-only"> authority</span>
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
  readonly onClose: () => void;
  readonly onOpen: (target: LibraryHandoff) => void;
  readonly onTrust: (trusted: boolean) => void;
  readonly onPluginDesired: (desired: boolean) => void;
  readonly restoreFocus: React.RefObject<HTMLElement | null>;
}

function LibraryDetail(props: LibraryDetailProps) {
  const { item } = props;
  const titleId = useId();
  const ref = item.packageRef;
  const next = item.steps.trust === "next" ? "trust" : item.steps.enable === "next" ? "enable" : "";
  const locked = props.disabled || props.busy;
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
      <p className="library-detail__summary">{item.summary}</p>
      <StepLadder steps={item.steps} />
      {item.stateNote === undefined ? null : (
        <p className="library__note" role="status">
          {item.stateNote}
        </p>
      )}
      <div className="library-detail__cols">
        <section aria-label="What it can do">
          <h4 className="library-detail__label">What it can do</h4>
          <ul className="library-detail__list">
            {item.abilities.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section aria-label="What it costs in authority">
          <h4 className="library-detail__label">What it costs in authority</h4>
          <p className="library-detail__level">
            <AuthorityDots level={item.authority.level} />
          </p>
          <ul className="library-detail__list">
            {item.authority.lines.map((line) => (
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
      <footer className="library-detail__actions">
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
        {ref !== undefined && item.state === "on" ? (
          <OctantButton
            disabled={locked}
            onClick={() => props.onPluginDesired(false)}
            type="button"
            variant="outline"
          >
            Turn off
          </OctantButton>
        ) : null}
        {ref === undefined || item.state === "blocked" ? (
          <OctantButton
            onClick={() => props.onOpen(item.handoff)}
            type="button"
            variant={ref === undefined ? "default" : "outline"}
          >
            {HANDOFF_ACTION[item.handoff]}
          </OctantButton>
        ) : (
          <OctantButton onClick={() => props.onOpen("installed")} type="button" variant="ghost">
            Open in Installed
          </OctantButton>
        )}
      </footer>
      <p className="library-detail__foot oct-meta">
        {ref === undefined
          ? "Installing never trusts or turns anything on by itself. You confirm each step, except a connector, which installs, trusts and turns on as one confirmed act."
          : "Tool calls follow the thread's approval policy, including approvals you chose to remember."}
      </p>
    </OctantDialog>
  );
}
