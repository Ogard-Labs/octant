import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type {
  WebSearchBackendEntry,
  WebSearchBackendKind,
  WebSearchBackendState,
  WebSearchDataPolicy,
  WebSearchSettings,
  WebSearchSettingsView as WebSearchSettingsViewValue,
} from "@octant/contracts/web-search";
import { MAX_WEB_SEARCH_BACKENDS, decodeWebSearchBackendId } from "@octant/contracts/web-search";
import { WEB_SEARCH_BACKEND_OFFERS } from "@octant/domain";
import { useEffect, useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsCompactRow, SettingsSection, SettingsState } from "./primitives";

/**
 * Settings › Web search: where Octant's own `web-search` may send a query.
 * The host decides everything here: this page shows the list it holds, sends
 * the person's changes, and shows the host's answer, a refusal included, as it
 * arrived. A key goes to the host's credential store and is never shown back.
 */

export interface WebSearchSettingsViewProps {
  readonly client?: Pick<HostControlClient, "readWebSearch" | "setWebSearch" | "setWebSearchKey">;
  readonly focusedSetting?: string;
  /** Opens the research route in Settings › Chat. */
  readonly onOpenResearchRoute?: () => void;
  /** Supplies ids for new entries; tests pass a fixed sequence. */
  readonly newId?: () => string;
}

const POLICY_OPTIONS: ReadonlyArray<{ readonly id: WebSearchDataPolicy; readonly label: string }> =
  [
    { id: "any", label: "Any" },
    { id: "zdr-only", label: "ZDR only" },
    { id: "eu-only", label: "EU only" },
    { id: "eu-and-zdr", label: "EU and ZDR" },
  ];

const POLICY_DESCRIPTIONS: Readonly<Record<WebSearchDataPolicy, string>> = {
  any: "Any backend you turned on may receive a query.",
  "zdr-only": "Only a backend you state keeps no record of your queries may receive one.",
  "eu-only": "Only a backend you state processes your queries in the EU or UK may receive one.",
  "eu-and-zdr": "Only a backend you state both of may receive a query.",
};

// The policy covers Octant's own backends only: a provider's own search and a
// vendor runtime's own web tools behave as they do on their own (maintainer
// decision, 2026-11-15), so the page says so once rather than per policy.
const PROVIDER_SEARCH =
  "The policy covers only the backends below. A provider's own search, and a vendor runtime's own web search and fetch, run as they do on their own, under your agreement with that provider; the research route chooses between a provider's search and these backends.";

const INELIGIBLE: Readonly<Record<string, string>> = {
  disabled: "Turned off",
  "zdr-not-stated": "Not eligible under this policy: you have not stated it keeps no record",
  "eu-processing-not-stated":
    "Not eligible under this policy: you have not stated it processes in the EU or UK",
};

const KIND_ORDER: ReadonlyArray<WebSearchBackendKind> = [
  "searxng",
  "staan",
  "mojeek",
  "linkup",
  "brave",
  "exa",
];

const SEARXNG_WARNING =
  "A SearXNG instance passes each query to the engines it enables, most of which are US services. Under an EU policy, enable only European indexes on it.";

function stateText(state: WebSearchBackendState | undefined, dirty: boolean): string {
  if (dirty || state === undefined) return "Not saved";
  if (state.kind === "ready") return "Ready";
  if (state.kind === "needs-key") return "Needs key";
  return INELIGIBLE[state.reason] ?? "Not eligible under this policy";
}

function sameSettings(left: WebSearchSettings, right: WebSearchSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function WebSearchSettingsView(props: WebSearchSettingsViewProps) {
  const ids = useId();
  const [view, setView] = useState<WebSearchSettingsViewValue>();
  const [draft, setDraft] = useState<WebSearchSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [addKind, setAddKind] = useState<WebSearchBackendKind>("searxng");
  const [addAddress, setAddAddress] = useState("");
  const [keys, setKeys] = useState<Readonly<Record<string, string>>>({});
  const client = props.client;
  const newId = props.newId ?? (() => crypto.randomUUID());

  useEffect(() => {
    if (client === undefined) return;
    let live = true;
    client.readWebSearch().then(
      (read) => {
        if (!live) return;
        setView(read);
        setDraft(read.settings);
      },
      () => live && setLoadError("Web search settings could not be read from this host."),
    );
    return () => {
      live = false;
    };
  }, [client]);

  if (client === undefined) {
    return (
      <SettingsSection title="Web search">
        <SettingsState kind="empty">
          Web search is set on the host this window runs on.
        </SettingsState>
      </SettingsSection>
    );
  }
  if (loadError !== undefined) {
    return (
      <SettingsSection title="Web search">
        <SettingsState kind="error">{loadError}</SettingsState>
      </SettingsSection>
    );
  }
  if (view === undefined || draft === undefined) {
    return (
      <SettingsSection title="Web search">
        <SettingsState kind="loading">Reading web search settings…</SettingsState>
      </SettingsSection>
    );
  }

  const dirty = !sameSettings(draft, view.settings);
  const savedIds = new Set(view.settings.backends.map((entry) => String(entry.id)));
  const states = new Map(view.states.map((entry) => [String(entry.id), entry.state]));
  const replace = (next: WebSearchSettings) => {
    setMessage(undefined);
    setDraft(next);
  };
  const updateEntry = (id: string, change: Partial<WebSearchBackendEntry>) =>
    replace({
      ...draft,
      backends: draft.backends.map((entry) =>
        String(entry.id) === id ? { ...entry, ...change } : entry,
      ),
    });
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= draft.backends.length) return;
    const backends = [...draft.backends];
    const [moved] = backends.splice(index, 1);
    if (moved === undefined) return;
    backends.splice(target, 0, moved);
    replace({ ...draft, backends });
  };
  const addOffer = WEB_SEARCH_BACKEND_OFFERS[addKind];
  const add = () => {
    const address = addAddress.trim();
    if (addOffer.address === "required" && address === "") {
      setMessage({ tone: "error", text: `${addOffer.label} needs the address of its instance.` });
      return;
    }
    replace({
      ...draft,
      backends: [
        ...draft.backends,
        {
          id: decodeWebSearchBackendId(newId()),
          kind: addKind,
          ...(address === "" || addOffer.address === "never" ? {} : { address }),
          enabled: true,
          statesZdr: false,
          statesEuProcessing: false,
        },
      ],
    });
    setAddAddress("");
  };

  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const outcome = await client.setWebSearch({ settings: draft });
      if (outcome.kind === "refused") {
        setMessage({ tone: "error", text: outcome.message });
        return;
      }
      setView(outcome.view);
      setDraft(outcome.view.settings);
      setMessage({ tone: "success", text: "Web search saved." });
    } catch {
      setMessage({ tone: "error", text: "Web search could not be saved." });
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (entry: WebSearchBackendEntry, remove: boolean) => {
    const key = keys[String(entry.id)]?.trim() ?? "";
    if (!remove && key === "") return;
    setBusy(true);
    setMessage(undefined);
    try {
      const outcome = await client.setWebSearchKey(
        remove ? { entryId: entry.id } : { entryId: entry.id, key },
      );
      if (outcome.kind === "refused") {
        setMessage({ tone: "error", text: outcome.message });
        return;
      }
      setView(outcome.view);
      setKeys((current) => ({ ...current, [String(entry.id)]: "" }));
      setMessage({ tone: "success", text: remove ? "Key removed." : "Key saved." });
    } catch {
      setMessage({ tone: "error", text: "The key could not be saved." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsSection
        description="Where Octant's own web search may send a query. Octant cannot read your contracts, so it relies on what you state about each vendor."
        title="Data policy"
      >
        <div className="setgroup">
          <SettingRow
            description={POLICY_DESCRIPTIONS[draft.policy]}
            focused={props.focusedSetting === "web-search-policy"}
            htmlFor={`${ids}-policy`}
            label="Data policy"
            scope="host"
            settingId="web-search-policy"
          >
            <OctantSelectField
              aria-label="Data policy"
              className="settings-view__select window-no-drag"
              disabled={busy}
              id={`${ids}-policy`}
              onValueChange={(value) => replace({ ...draft, policy: value as WebSearchDataPolicy })}
              options={POLICY_OPTIONS}
              value={draft.policy}
            />
          </SettingRow>
          <SettingRow
            description={PROVIDER_SEARCH}
            label="A provider's own search"
            scope="host"
            settingId="web-search-provider-search"
          >
            <span className="web-search-settings__links">
              <OctantButton
                onClick={() => props.onOpenResearchRoute?.()}
                size="sm"
                type="button"
                variant="ghost"
              >
                Research route
              </OctantButton>
            </span>
          </SettingRow>
        </div>
      </SettingsSection>
      <SettingsSection
        description="A query goes to the first backend that may receive it, and moves to the next only when one does not answer."
        title="Backends"
      >
        {draft.backends.length === 0 ? (
          <SettingsState kind="empty">
            No backends. With none, Octant offers no web search of its own.
          </SettingsState>
        ) : null}
        <div className="setgroup">
          {draft.backends.length === 0
            ? null
            : draft.backends.map((entry, index) => {
                const id = String(entry.id);
                const offer = WEB_SEARCH_BACKEND_OFFERS[entry.kind];
                const saved = savedIds.has(id);
                const entryDirty = dirty || !saved;
                // Two entries can share a kind (two SearXNG instances), so each
                // control names its entry by position as well as by vendor.
                const entryName = `${index + 1}. ${offer.label}`;
                return (
                  <SettingsCompactRow
                    detail={
                      <div className="web-search-settings__detail">
                        {entry.address === undefined ? null : <p>Address: {entry.address}</p>}
                        {entry.kind === "searxng" ? <p>{SEARXNG_WARNING}</p> : null}
                        <label className="web-search-settings__statement">
                          <OctantCheckbox
                            checked={entry.statesZdr}
                            disabled={busy || !offer.zdr.offered}
                            onChange={() => updateEntry(id, { statesZdr: !entry.statesZdr })}
                          />
                          <span>
                            This vendor keeps no record of my queries
                            {offer.zdr.offered
                              ? ` (${offer.zdr.terms})`
                              : ` — not offered: ${offer.zdr.terms}`}
                          </span>
                        </label>
                        <label className="web-search-settings__statement">
                          <OctantCheckbox
                            checked={entry.statesEuProcessing}
                            disabled={busy || !offer.euProcessing.offered}
                            onChange={() =>
                              updateEntry(id, { statesEuProcessing: !entry.statesEuProcessing })
                            }
                          />
                          <span>
                            This vendor processes my queries only in the EU or UK
                            {offer.euProcessing.offered
                              ? ` (${offer.euProcessing.terms})`
                              : ` — not offered: ${offer.euProcessing.terms}`}
                          </span>
                        </label>
                        <p className="web-search-settings__source">
                          Terms checked {offer.checkedOn} at {offer.source}
                        </p>
                        {offer.takesKey ? (
                          <div className="web-search-settings__key">
                            <OctantInput
                              aria-label={`${entryName} API key`}
                              autoComplete="off"
                              disabled={busy || entryDirty}
                              onChange={(event) => {
                                const value = event.currentTarget.value;
                                setKeys((current) => ({ ...current, [id]: value }));
                              }}
                              placeholder={entryDirty ? "Save the list first" : "API key"}
                              type="password"
                              value={keys[id] ?? ""}
                            />
                            <OctantButton
                              disabled={busy || entryDirty || (keys[id] ?? "").trim() === ""}
                              onClick={() => void saveKey(entry, false)}
                              size="sm"
                              type="button"
                              variant="secondary"
                            >
                              Save key
                            </OctantButton>
                            <OctantButton
                              disabled={busy || entryDirty}
                              onClick={() => void saveKey(entry, true)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Remove key
                            </OctantButton>
                          </div>
                        ) : null}
                        <div className="web-search-settings__actions">
                          <OctantButton
                            aria-label={`Move ${entryName} up`}
                            disabled={busy || index === 0}
                            onClick={() => move(index, -1)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Move up
                          </OctantButton>
                          <OctantButton
                            aria-label={`Move ${entryName} down`}
                            disabled={busy || index === draft.backends.length - 1}
                            onClick={() => move(index, 1)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Move down
                          </OctantButton>
                          <OctantButton
                            aria-label={`Remove ${entryName}`}
                            disabled={busy}
                            onClick={() =>
                              replace({
                                ...draft,
                                backends: draft.backends.filter((other) => String(other.id) !== id),
                              })
                            }
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Remove
                          </OctantButton>
                        </div>
                      </div>
                    }
                    key={id}
                    label={entryName}
                    meta={stateText(states.get(id), entryDirty)}
                    metaWraps
                  >
                    <OctantSwitch
                      checked={entry.enabled}
                      disabled={busy}
                      label={`Use ${offer.label}`}
                      onCheckedChange={(enabled) => updateEntry(id, { enabled })}
                    />
                  </SettingsCompactRow>
                );
              })}
          <SettingRow
            description={
              addOffer.address === "never"
                ? `${addOffer.index}. Its key is asked for once the list is saved.`
                : addKind === "searxng"
                  ? `The instance's address: HTTPS, or HTTP on a loopback address. ${SEARXNG_WARNING}`
                  : `${addOffer.index}. The EU host your agreement names, if it names one.`
            }
            focused={props.focusedSetting === "web-search-add"}
            htmlFor={`${ids}-kind`}
            label="Add backend"
            scope="host"
            settingId="web-search-add"
          >
            <span className="web-search-settings__add">
              <OctantSelectField
                aria-label="Backend kind"
                className="settings-view__select window-no-drag"
                disabled={busy}
                id={`${ids}-kind`}
                onValueChange={(value) => setAddKind(value as WebSearchBackendKind)}
                options={KIND_ORDER.map((kind) => ({
                  id: kind,
                  label: WEB_SEARCH_BACKEND_OFFERS[kind].label,
                }))}
                value={addKind}
              />
              {addOffer.address === "never" ? null : (
                <OctantInput
                  aria-label="Backend address"
                  className="settings-view__text-input"
                  disabled={busy}
                  onChange={(event) => setAddAddress(event.currentTarget.value)}
                  placeholder="https://search.example"
                  type="url"
                  value={addAddress}
                />
              )}
              <OctantButton
                disabled={busy || draft.backends.length >= MAX_WEB_SEARCH_BACKENDS}
                onClick={add}
                size="sm"
                type="button"
                variant="secondary"
              >
                Add
              </OctantButton>
            </span>
          </SettingRow>
        </div>
        <div className="web-search-settings__save">
          <OctantButton
            disabled={busy || !dirty}
            onClick={() => void save()}
            type="button"
            variant="default"
          >
            Save
          </OctantButton>
          {dirty ? (
            <OctantButton
              disabled={busy}
              onClick={() => replace(view.settings)}
              type="button"
              variant="ghost"
            >
              Discard changes
            </OctantButton>
          ) : null}
        </div>
        {message === undefined ? null : (
          <SettingsState kind={message.tone === "error" ? "error" : "success"}>
            {message.text}
          </SettingsState>
        )}
      </SettingsSection>
    </>
  );
}
