import type { AggregateId } from "@octant/contracts/events";
import type { SafeNetworksClient } from "@octant/client-runtime/safe-networks-client";
import type {
  SafeNetworkPlace,
  SafeNetworkPrivateTag,
  SafeNetworkRefusalView,
  SafeNetworksCommand,
  SafeNetworksView,
} from "@octant/contracts/safe-networks";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsPanel, SettingsState } from "./primitives";

export interface SafeNetworksSettingsProps {
  /** Absent where the host has no Safe networks route. */
  readonly client: Pick<SafeNetworksClient, "read" | "command"> | undefined;
  /** Project names by Project id, for the Project picker. */
  readonly projectNames: ReadonlyMap<string, string>;
  readonly focusedSetting?: string | undefined;
}

export const SAFE_NETWORKS_INTRO =
  "Below Full access, provider runtimes and Claude's commands reach only their provider's own endpoints, the Project's network rules, and the places listed here. Anything else is refused and shows under Recently refused.";

export const NETWORK_LIMITS_ON_NOTE =
  "Network limits are on. Runtimes launched from now on reach only the places below.";
export const NETWORK_LIMITS_OFF_NOTE =
  "Network limits are off. Runtimes have open network, and the places below are saved but not applied.";
export const NETWORK_LIMITS_TIMING_NOTE =
  "A change applies to the next runtime you start. Runtimes already running keep the network they began with.";

const NOT_ENFORCED_NOTE =
  "Runtimes on this computer do not run through these rules yet, so the lists below are saved but not applied.";

type PlaceKind = SafeNetworkPlace["kind"];

const KIND_OPTIONS: ReadonlyArray<{ readonly id: PlaceKind; readonly label: string }> = [
  { id: "host", label: "Host" },
  { id: "domain", label: "Domain" },
  { id: "range", label: "Address range" },
  { id: "private-network", label: "Private network" },
];

const TAG_LABELS: Readonly<Record<SafeNetworkPrivateTag, string>> = {
  "this-mac": "This Mac",
  "local-network": "Local network",
  "overlay-network": "Overlay network",
};

const TAG_OPTIONS = (Object.keys(TAG_LABELS) as ReadonlyArray<SafeNetworkPrivateTag>).map((id) => ({
  id,
  label: TAG_LABELS[id],
}));

const VALUE_PLACEHOLDERS: Readonly<Record<Exclude<PlaceKind, "private-network">, string>> = {
  host: "api.example.com",
  domain: "example.com",
  range: "192.168.1.0/24",
};

const RUNTIME_LABELS: Readonly<Record<SafeNetworkRefusalView["runtime"], string>> = {
  "claude-sandbox": "Claude commands",
  codex: "Codex",
  opencode: "OpenCode",
  acp: "ACP agent",
  pi: "Pi",
};

function placeKindLabel(place: SafeNetworkPlace): string {
  return KIND_OPTIONS.find((option) => option.id === place.kind)?.label ?? place.kind;
}

function placeValue(place: SafeNetworkPlace): string {
  switch (place.kind) {
    case "host":
      return place.host;
    case "domain":
      return place.domain;
    case "range":
      return place.range;
    case "private-network":
      return TAG_LABELS[place.tag];
  }
}

function placeName(place: SafeNetworkPlace): string {
  return `${placeKindLabel(place)} ${placeValue(place)}${place.port === undefined ? "" : `, port ${place.port}`}`;
}

function samePlaces(
  a: ReadonlyArray<SafeNetworkPlace>,
  b: ReadonlyArray<SafeNetworkPlace>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Problem = {
  readonly scope: "account" | "project";
  readonly message: string;
  readonly placeIndex?: number | undefined;
};

interface PlaceListProps {
  /** Names the list for assistive technology: "Every Project" or the Project's name. */
  readonly label: string;
  readonly saveLabel: string;
  readonly places: ReadonlyArray<SafeNetworkPlace>;
  readonly saved: ReadonlyArray<SafeNetworkPlace>;
  readonly busy: boolean;
  readonly problem: Problem | undefined;
  readonly onChange: (places: ReadonlyArray<SafeNetworkPlace>) => void;
  readonly onSave: () => void;
}

/**
 * One scope's list of trusted places. Remove and Add change a draft; Save
 * sends the whole list, which the host canonicalizes or refuses with a
 * message that this list shows beside the place it concerns.
 */
function PlaceList(props: PlaceListProps) {
  const fieldId = useId();
  const [kind, setKind] = useState<PlaceKind>("host");
  const [tag, setTag] = useState<SafeNetworkPrivateTag>("this-mac");
  const [value, setValue] = useState("");
  const [port, setPort] = useState("");
  const [formProblem, setFormProblem] = useState<string | undefined>(undefined);

  const dirty = !samePlaces(props.places, props.saved);

  function add() {
    const trimmedPort = port.trim();
    let parsedPort: number | undefined;
    if (trimmedPort !== "") {
      parsedPort = Number(trimmedPort);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
        setFormProblem("A port is a number from 1 to 65535.");
        return;
      }
    }
    const withPort = parsedPort === undefined ? {} : { port: parsedPort };
    const trimmed = value.trim();
    let place: SafeNetworkPlace;
    if (kind === "private-network") {
      place = { kind, tag, ...withPort };
    } else {
      if (trimmed === "") {
        setFormProblem("Enter a name or address to trust.");
        return;
      }
      place =
        kind === "host"
          ? { kind, host: trimmed, ...withPort }
          : kind === "domain"
            ? { kind, domain: trimmed, ...withPort }
            : { kind, range: trimmed, ...withPort };
    }
    setFormProblem(undefined);
    props.onChange([...props.places, place]);
    setValue("");
    setPort("");
  }

  return (
    <div className="safe-networks__list" role="group" aria-label={`${props.label} places`}>
      {props.places.length === 0 ? (
        <p className="safe-networks__empty">No places trusted.</p>
      ) : (
        <ul className="safe-networks__places">
          {props.places.map((place, index) => {
            const refused = props.problem?.placeIndex === index;
            return (
              <li
                className="safe-networks__place"
                data-refused={refused ? "true" : "false"}
                key={`${placeName(place)}:${String(index)}`}
              >
                <span className="safe-networks__kind">{placeKindLabel(place)}</span>
                <span className="safe-networks__value">{placeValue(place)}</span>
                {place.port === undefined ? null : (
                  <span className="safe-networks__port">port {place.port}</span>
                )}
                {refused ? <span className="safe-networks__refused-mark">Refused</span> : null}
                <OctantButton
                  aria-label={`Remove ${placeName(place)} from ${props.label}`}
                  disabled={props.busy}
                  onClick={() => props.onChange(props.places.filter((_, at) => at !== index))}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              </li>
            );
          })}
        </ul>
      )}
      <div className="safe-networks__add">
        <div className="host-settings__field">
          <label htmlFor={`${fieldId}-kind`}>Kind</label>
          <OctantSelectField
            id={`${fieldId}-kind`}
            aria-label={`Kind of place for ${props.label}`}
            onValueChange={(next) => {
              const chosen = KIND_OPTIONS.find((option) => option.id === next);
              if (chosen !== undefined) setKind(chosen.id);
              setFormProblem(undefined);
            }}
            options={KIND_OPTIONS}
            value={kind}
          />
        </div>
        {kind === "private-network" ? (
          <div className="host-settings__field">
            <label htmlFor={`${fieldId}-tag`}>Network</label>
            <OctantSelectField
              id={`${fieldId}-tag`}
              aria-label={`Private network for ${props.label}`}
              onValueChange={(next) => {
                const chosen = TAG_OPTIONS.find((option) => option.id === next);
                if (chosen !== undefined) setTag(chosen.id);
              }}
              options={TAG_OPTIONS}
              value={tag}
            />
          </div>
        ) : (
          <div className="host-settings__field">
            <label htmlFor={`${fieldId}-value`}>
              {kind === "range" ? "Address range" : kind === "domain" ? "Domain" : "Host"}
            </label>
            <OctantInput
              autoCapitalize="off"
              autoComplete="off"
              id={`${fieldId}-value`}
              onChange={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
              placeholder={VALUE_PLACEHOLDERS[kind]}
              spellCheck={false}
              type="text"
              value={value}
            />
          </div>
        )}
        <div className="host-settings__field safe-networks__port-field">
          <label htmlFor={`${fieldId}-port`}>Port (optional)</label>
          <OctantInput
            id={`${fieldId}-port`}
            inputMode="numeric"
            onChange={(event) => setPort(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            placeholder="Any"
            type="text"
            value={port}
          />
        </div>
        <OctantButton
          disabled={props.busy}
          onClick={add}
          size="sm"
          type="button"
          variant="secondary"
        >
          Add place
        </OctantButton>
      </div>
      {kind === "private-network" ? (
        <p className="safe-networks__hint">
          This Mac is its own loopback address, Local network covers private home and office
          addresses, and Overlay network covers the addresses private overlay networks hand out.
        </p>
      ) : null}
      {formProblem === undefined ? null : <SettingsState kind="error">{formProblem}</SettingsState>}
      {props.problem === undefined ? null : (
        <SettingsState kind="error">{props.problem.message}</SettingsState>
      )}
      <div className="safe-networks__actions">
        <OctantButton
          disabled={props.busy || !dirty}
          onClick={props.onSave}
          size="sm"
          type="button"
          variant="secondary"
        >
          {props.saveLabel}
        </OctantButton>
      </div>
    </div>
  );
}

/**
 * Settings › Access › Safe networks: the places provider runtimes may reach
 * beyond their own endpoints, for every Project and for one Project that
 * keeps its own list, with the hosts they were recently refused so a person
 * can trust one in a click. Only a local window changes places; the host
 * canonicalizes a list or refuses it with a message shown as it arrived.
 */
export function SafeNetworksSettings(props: SafeNetworksSettingsProps) {
  const { client } = props;
  const pickerId = useId();
  const root = useRef<HTMLDivElement>(null);
  const requestNumber = useRef(0);
  /**
   * The Project the picker names now. An answer read or saved for another
   * selection is dropped when it arrives, so a slow answer about Project A
   * never lands on Project B.
   */
  const selected = useRef("");
  const [projectId, setProjectId] = useState("");
  const [view, setView] = useState<SafeNetworksView | undefined>(undefined);
  /** The selection `view` was read for; Project controls show only when it is the picker's. */
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [accountDraft, setAccountDraft] = useState<ReadonlyArray<SafeNetworkPlace>>([]);
  /** `null` while the Project follows the every-Project list. */
  const [projectDraft, setProjectDraft] = useState<ReadonlyArray<SafeNetworkPlace> | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [limitsProblem, setLimitsProblem] = useState<string | undefined>(undefined);

  const focused = props.focusedSetting === "safe-networks";
  useEffect(() => {
    if (!focused || root.current === null) return;
    root.current.focus();
    root.current.scrollIntoView?.({ block: "center" });
  }, [focused]);

  const apply = useCallback(
    (next: SafeNetworksView, scopes: ReadonlyArray<"account" | "project">) => {
      setView(next);
      if (scopes.includes("account")) setAccountDraft(next.account);
      if (scopes.includes("project")) setProjectDraft(next.project?.override ?? null);
    },
    [],
  );

  const load = useCallback(
    async (chosen: string) => {
      if (client === undefined) return;
      const mine = ++requestNumber.current;
      try {
        const next = await client.read(chosen === "" ? undefined : chosen);
        if (mine !== requestNumber.current || chosen !== selected.current) return;
        apply(next, ["account", "project"]);
        setLoadedFor(chosen);
        setLoadFailed(false);
      } catch {
        if (mine === requestNumber.current) setLoadFailed(true);
      }
    },
    [client, apply],
  );

  useEffect(() => {
    void load(projectId);
  }, [load, projectId]);

  const projectOptions = useMemo(
    () => [
      { id: "", label: "No Project chosen" },
      ...[...props.projectNames.entries()]
        .map(([id, name]) => ({ id, label: name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [props.projectNames],
  );
  const projectName = props.projectNames.get(projectId) ?? "this Project";

  async function send(command: SafeNetworksCommand, scope: "account" | "project") {
    if (client === undefined) return;
    const sentFor = projectId;
    setProblem(undefined);
    setBusy(true);
    try {
      const result = await client.command(command, sentFor === "" ? undefined : sentFor);
      // The person picked another Project while this was saved: the answer
      // describes the old one, so only the every-Project list may be taken
      // from it.
      if (sentFor !== selected.current) {
        if (result.kind === "safe-networks-updated" && scope === "account") {
          setAccountDraft(result.view.account);
          setView((current) =>
            current === undefined ? current : { ...current, account: result.view.account },
          );
        }
        return;
      }
      if (result.kind === "safe-networks-updated") {
        apply(result.view, [scope]);
        return;
      }
      setProblem({
        scope,
        message: result.message,
        ...(result.placeIndex === undefined ? {} : { placeIndex: result.placeIndex }),
      });
    } catch {
      setProblem({ scope, message: "Safe networks could not be saved." });
    } finally {
      setBusy(false);
    }
  }

  async function setLimits(enabled: boolean) {
    if (client === undefined) return;
    setLimitsProblem(undefined);
    setBusy(true);
    try {
      const result = await client.command({ kind: "set-limits", enabled });
      if (result.kind === "safe-networks-updated") {
        // Only the switch is taken from the answer: it describes no Project
        // and must not overwrite a list being edited.
        setView((current) =>
          current === undefined ? current : { ...current, limitsOn: result.view.limitsOn },
        );
      } else {
        setLimitsProblem(result.message);
      }
    } catch {
      setLimitsProblem("Network limits could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  /** The picker only offers the host's own Project ids. */
  const chosenProject = () => projectId as AggregateId;
  /** Whether what is shown for the Project is the picker's Project, read for it. */
  const showsChosenProject =
    projectId !== "" &&
    loadedFor === projectId &&
    view?.project !== undefined &&
    String(view.project.projectId) === projectId;

  const saveAccount = (places: ReadonlyArray<SafeNetworkPlace>) =>
    send({ kind: "set-places", scope: { kind: "account" }, places }, "account");
  const saveProject = async (places: ReadonlyArray<SafeNetworkPlace>) => {
    // A list is only ever saved to the Project it was read for.
    if (!showsChosenProject) return;
    await send(
      { kind: "set-places", scope: { kind: "project", projectId: chosenProject() }, places },
      "project",
    );
  };

  function chooseProject(next: string) {
    if (next === selected.current) return;
    selected.current = next;
    setProblem(undefined);
    setProjectDraft(null);
    setLoadedFor(undefined);
    setProjectId(next);
  }

  function followEveryProject() {
    if (!showsChosenProject) return;
    if (view?.project?.override == null) {
      setProjectDraft(null);
      setProblem(undefined);
      return;
    }
    void send({ kind: "clear-project-override", projectId: chosenProject() }, "project");
  }

  function trust(refusal: SafeNetworkRefusalView) {
    const place: SafeNetworkPlace =
      refusal.port >= 1
        ? { kind: "host", host: refusal.host, port: refusal.port }
        : { kind: "host", host: refusal.host };
    if (loadedFor !== projectId) return;
    const editingProject = showsChosenProject;
    const current = editingProject ? (projectDraft ?? accountDraft) : accountDraft;
    const places = current.some((entry) => JSON.stringify(entry) === JSON.stringify(place))
      ? current
      : [...current, place];
    if (editingProject) {
      setProjectDraft(places);
      void saveProject(places);
    } else {
      setAccountDraft(places);
      void saveAccount(places);
    }
  }

  if (client === undefined) {
    return (
      <SettingsState kind="empty">Safe networks are set up on the host machine.</SettingsState>
    );
  }
  if (view === undefined) {
    return (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed ? "Safe networks could not be read from this host." : "Reading safe networks…"}
      </SettingsState>
    );
  }

  const projectView = showsChosenProject ? view.project : undefined;
  const readingProject = loadedFor !== projectId;
  const ownList = projectDraft !== null;
  const problemFor = (scope: "account" | "project") =>
    problem?.scope === scope ? problem : undefined;

  return (
    <div
      className="safe-networks"
      data-focused={focused ? "true" : "false"}
      data-setting-id="safe-networks"
      ref={root}
      tabIndex={-1}
    >
      {view.enforced ? null : <SettingsState kind="empty">{NOT_ENFORCED_NOTE}</SettingsState>}
      <SettingsPanel
        description={view.limitsOn ? NETWORK_LIMITS_ON_NOTE : NETWORK_LIMITS_OFF_NOTE}
        title="Network limits"
      >
        <SettingRow
          description={NETWORK_LIMITS_TIMING_NOTE}
          label="Limit runtime network"
          scope="host"
          settingId="network-limits"
        >
          <OctantSwitch
            checked={view.limitsOn}
            disabled={busy || !view.enforced}
            label="Limit runtime network"
            onCheckedChange={(checked) => void setLimits(checked)}
          />
        </SettingRow>
        {limitsProblem === undefined ? null : (
          <SettingsState kind="error">{limitsProblem}</SettingsState>
        )}
      </SettingsPanel>
      <SettingsPanel description={SAFE_NETWORKS_INTRO} title="Safe networks">
        <h3 className="safe-networks__heading">Every Project</h3>
        <PlaceList
          busy={busy}
          label="Every Project"
          onChange={(places) => {
            setAccountDraft(places);
            setProblem(undefined);
          }}
          onSave={() => void saveAccount(accountDraft)}
          places={accountDraft}
          problem={problemFor("account")}
          saveLabel="Save every-Project list"
          saved={view.account}
        />
      </SettingsPanel>
      <SettingsPanel
        description="A Project follows the every-Project list unless you give it a list of its own."
        title="Project"
      >
        <div className="host-settings__field">
          <label htmlFor={pickerId}>Project</label>
          <OctantSelectField
            id={pickerId}
            aria-label="Project"
            onValueChange={chooseProject}
            options={projectOptions}
            value={projectId}
          />
        </div>
        {projectId !== "" && readingProject ? (
          <SettingsState kind="loading">Reading this Project's list…</SettingsState>
        ) : null}
        {projectView === undefined ? null : (
          <>
            <div className="safe-networks__status">
              <p>
                {ownList
                  ? `${projectName} has its own list.`
                  : `${projectName} follows the every-Project list.`}
              </p>
              {ownList ? (
                <OctantButton
                  disabled={busy}
                  onClick={followEveryProject}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Follow every-Project list
                </OctantButton>
              ) : (
                <OctantButton
                  disabled={busy}
                  onClick={() => setProjectDraft(accountDraft)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Use its own list
                </OctantButton>
              )}
            </div>
            {projectDraft === null ? null : (
              <PlaceList
                busy={busy}
                label={projectName}
                onChange={(places) => {
                  setProjectDraft(places);
                  setProblem(undefined);
                }}
                onSave={() => void saveProject(projectDraft)}
                places={projectDraft}
                problem={problemFor("project")}
                saveLabel="Save Project list"
                saved={projectView.override ?? []}
              />
            )}
          </>
        )}
      </SettingsPanel>
      <SettingsPanel
        description={
          projectView !== undefined
            ? `Trusting a host adds it to ${projectName}'s own list.`
            : "Trusting a host adds it to the every-Project list."
        }
        title="Recently refused"
      >
        {readingProject ? (
          <SettingsState kind="loading">Reading recent refusals…</SettingsState>
        ) : view.refused.length === 0 ? (
          <SettingsState kind="empty">Nothing has been refused lately.</SettingsState>
        ) : (
          <ul className="safe-networks__refusals">
            {view.refused.map((refusal) => {
              const target = refusal.port >= 1 ? `${refusal.host}:${refusal.port}` : refusal.host;
              return (
                <li className="safe-networks__refusal" key={`${refusal.runtime}:${target}`}>
                  <span className="safe-networks__value">{target}</span>
                  <span className="safe-networks__detail">
                    {RUNTIME_LABELS[refusal.runtime]} ·{" "}
                    {refusal.requests === 1 ? "1 request" : `${refusal.requests} requests`} ·{" "}
                    {relativeTimeLabel(refusal.lastRefusedAt)}
                  </span>
                  <OctantButton
                    aria-label={`Trust ${target}`}
                    disabled={busy}
                    onClick={() => trust(refusal)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Trust
                  </OctantButton>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsPanel>
    </div>
  );
}
