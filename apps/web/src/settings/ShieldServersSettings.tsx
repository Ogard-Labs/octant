import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type { AggregateId } from "@octant/contracts/events";
import type {
  ShieldServer,
  ShieldServerFields,
  ShieldServerProfile,
  ShieldServerSignIn,
  ShieldServersCommand,
  ShieldServersView,
} from "@octant/contracts/shield-servers";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingsPanel, SettingsState } from "./primitives";

export interface ShieldServersSettingsProps {
  /** Absent off this computer: the registry is host authority. */
  readonly client: Pick<ShieldServersClient, "read" | "command"> | undefined;
  readonly focusedSetting?: string | undefined;
  /** Project names by id, for the picker; the host's own ids. */
  readonly projectNames: ReadonlyMap<string, string>;
}

export const SHIELD_SERVERS_INTRO =
  "Agents reach these servers with your own SSH agent, or with a key Octant makes and keeps for one server. Octant never reads your key files.";
export const SHIELD_SSH_AGENT_MISSING_NOTE =
  "No SSH agent is running for Octant, so SSH commands cannot sign in.";
export const SHIELD_SERVERS_ALWAYS_ASK_NOTE =
  "Lock-out and destructive actions (firewall changes, removing users or keys, disk changes, deleting data, reboots) always ask you.";

export const SHIELD_PROJECT_SERVERS_NOTE =
  "A Project's own list replaces the account list for that Project's threads.";

const PROFILE_LABELS: Readonly<Record<ShieldServerProfile, string>> = {
  "read-only": "Read-only",
  operate: "Operate",
  admin: "Admin",
};

const PROFILE_EXPLANATIONS: Readonly<Record<ShieldServerProfile, string>> = {
  "read-only": "status, logs, disk, processes and service status.",
  operate: "also restarts services, updates packages and runs the deploys you describe.",
  admin: "also edits configuration.",
};

const PROFILE_ORDER: ReadonlyArray<ShieldServerProfile> = ["read-only", "operate", "admin"];

const SIGN_IN_OPTIONS: ReadonlyArray<{ readonly id: ShieldServerSignIn; readonly label: string }> =
  [
    { id: "ssh-agent", label: "Your SSH agent" },
    { id: "octant-key", label: "A key Octant keeps" },
  ];

/** What the row shows once the host answers "Show key". */
type KeyShown =
  | { readonly kind: "key"; readonly publicKey: string }
  | { readonly kind: "problem"; readonly message: string };

const PROFILE_OPTIONS = PROFILE_ORDER.map((id) => ({ id, label: PROFILE_LABELS[id] }));

function profileAllowsDeploys(profile: ShieldServerProfile): boolean {
  return profile !== "read-only";
}

function deployLines(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function fieldsOf(server: ShieldServer): ShieldServerFields {
  return {
    alias: server.alias,
    user: server.user,
    profile: server.profile,
    deployCommands: server.deployCommands,
    ...(server.runbookPath === undefined ? {} : { runbookPath: server.runbookPath }),
    ...(server.signIn === undefined ? {} : { signIn: server.signIn }),
  };
}

interface ServerFormProps {
  readonly editing: ShieldServer | undefined;
  /** Names the form when two lists can be on screen: the Project's name. */
  readonly forProject?: string | undefined;
  readonly busy: boolean;
  readonly problem: string | undefined;
  readonly onSubmit: (fields: ShieldServerFields) => void;
  readonly onCancel: () => void;
}

function ServerForm(props: ServerFormProps) {
  const { editing } = props;
  const fieldId = useId();
  const [alias, setAlias] = useState(editing?.alias ?? "");
  const [user, setUser] = useState(editing?.user ?? "");
  const [profile, setProfile] = useState<ShieldServerProfile>(editing?.profile ?? "read-only");
  const [deploys, setDeploys] = useState((editing?.deployCommands ?? []).join("\n"));
  const [runbook, setRunbook] = useState(editing?.runbookPath ?? "");
  const [signIn, setSignIn] = useState<ShieldServerSignIn>(editing?.signIn ?? "ssh-agent");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const runbookPath = runbook.trim();
    props.onSubmit({
      alias: alias.trim(),
      user: user.trim(),
      profile,
      deployCommands: profileAllowsDeploys(profile) ? deployLines(deploys) : [],
      ...(runbookPath === "" ? {} : { runbookPath }),
      ...(signIn === "octant-key" ? { signIn } : {}),
    });
  }

  return (
    <form
      aria-label={
        editing === undefined
          ? props.forProject === undefined
            ? "Add a server"
            : `Add a server to ${props.forProject}`
          : props.forProject === undefined
            ? `Change ${editing.alias}`
            : `Change ${editing.alias} for ${props.forProject}`
      }
      className="shield-servers__form"
      noValidate
      onSubmit={submit}
    >
      <div className="host-settings__field">
        <label htmlFor={`${fieldId}-alias`}>Host alias</label>
        <OctantInput
          autoCapitalize="off"
          autoComplete="off"
          id={`${fieldId}-alias`}
          onChange={(event) => setAlias(event.currentTarget.value)}
          placeholder="web-1"
          spellCheck={false}
          type="text"
          value={alias}
        />
      </div>
      <div className="host-settings__field">
        <label htmlFor={`${fieldId}-user`}>Login user</label>
        <OctantInput
          autoCapitalize="off"
          autoComplete="off"
          id={`${fieldId}-user`}
          onChange={(event) => setUser(event.currentTarget.value)}
          placeholder="deploy"
          spellCheck={false}
          type="text"
          value={user}
        />
      </div>
      <div className="host-settings__field">
        <label htmlFor={`${fieldId}-profile`}>Profile</label>
        <OctantSelectField
          id={`${fieldId}-profile`}
          aria-label="Profile"
          onValueChange={(next) => {
            const chosen = PROFILE_OPTIONS.find((option) => option.id === next);
            if (chosen !== undefined) setProfile(chosen.id);
          }}
          options={PROFILE_OPTIONS}
          value={profile}
        />
      </div>
      <div className="host-settings__field">
        <label htmlFor={`${fieldId}-sign-in`}>Sign in with</label>
        <OctantSelectField
          id={`${fieldId}-sign-in`}
          aria-label="Sign in with"
          onValueChange={(next) => {
            const chosen = SIGN_IN_OPTIONS.find((option) => option.id === next);
            if (chosen !== undefined) setSignIn(chosen.id);
          }}
          options={SIGN_IN_OPTIONS}
          value={signIn}
        />
      </div>
      {profileAllowsDeploys(profile) ? (
        <div className="host-settings__field">
          <label htmlFor={`${fieldId}-deploys`}>Deploy commands (one per line)</label>
          <OctantTextarea
            autoCapitalize="off"
            id={`${fieldId}-deploys`}
            onChange={(event) => setDeploys(event.currentTarget.value)}
            placeholder="cd /srv/app && ./deploy.sh"
            rows={3}
            spellCheck={false}
            value={deploys}
          />
        </div>
      ) : null}
      <div className="host-settings__field">
        <label htmlFor={`${fieldId}-runbook`}>Runbook notes file (optional)</label>
        <OctantInput
          autoCapitalize="off"
          autoComplete="off"
          id={`${fieldId}-runbook`}
          onChange={(event) => setRunbook(event.currentTarget.value)}
          placeholder="/Users/you/notes/web-1.md"
          spellCheck={false}
          type="text"
          value={runbook}
        />
      </div>
      <div aria-live="polite">
        {props.problem === undefined ? null : (
          <OctantAlert className="shield-servers__problem" tone="danger">
            {props.problem}
          </OctantAlert>
        )}
      </div>
      <div className="shield-servers__actions">
        <OctantButton disabled={props.busy} size="sm" type="submit" variant="secondary">
          {editing === undefined ? "Add server" : "Save changes"}
        </OctantButton>
        {editing === undefined ? null : (
          <OctantButton
            disabled={props.busy}
            onClick={props.onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </OctantButton>
        )}
      </div>
    </form>
  );
}

interface ServerEditorProps {
  readonly servers: ReadonlyArray<ShieldServer>;
  readonly busy: boolean;
  readonly problem: string | undefined;
  /** The Project whose list this is; absent for the account list. */
  readonly forProject?: string | undefined;
  readonly onClearProblem: () => void;
  readonly onAdd: (fields: ShieldServerFields) => Promise<boolean>;
  readonly onChange: (server: ShieldServer, fields: ShieldServerFields) => Promise<boolean>;
  readonly onRemove: (server: ShieldServer) => Promise<boolean>;
  readonly onShowKey: (server: ShieldServer) => Promise<KeyShown>;
}

/**
 * One list of servers with the add, change and remove controls over it. The
 * account list and a Project's own list share it; each edit is handed to the
 * owner, which decides what whole command to send.
 */
function ServerEditor(props: ServerEditorProps) {
  const { servers, forProject } = props;
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  /** Bumped after a successful add so the form remounts empty. */
  const [formKey, setFormKey] = useState(0);
  const editing = servers.find((server) => String(server.serverId) === editingId);
  const suffix = forProject === undefined ? "" : ` for ${forProject}`;
  const [shownKeys, setShownKeys] = useState<ReadonlyMap<string, KeyShown>>(new Map());
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined);

  return (
    <>
      {servers.length === 0 ? (
        <p className="shield-servers__empty">No servers registered.</p>
      ) : (
        <ul
          aria-label={forProject === undefined ? "Registered servers" : `${forProject} servers`}
          className="shield-servers__list"
        >
          {servers.map((server) => (
            <li className="shield-servers__server" key={String(server.serverId)}>
              <span className="shield-servers__name">{server.alias}</span>
              <span className="shield-servers__login">
                {server.user}@{server.alias}
              </span>
              <span className="shield-servers__profile">{PROFILE_LABELS[server.profile]}</span>
              {server.runbookPath === undefined ? null : (
                <span className="shield-servers__runbook">{server.runbookPath}</span>
              )}
              {server.deployCommands.length === 0 ? null : (
                <span className="shield-servers__deploys">
                  {server.deployCommands.length === 1
                    ? "1 deploy command"
                    : `${server.deployCommands.length} deploy commands`}
                </span>
              )}
              {server.signIn === "octant-key" ? (
                <span className="shield-servers__deploys">Key Octant keeps</span>
              ) : null}
              <span className="shield-servers__row-actions">
                {server.signIn === "octant-key" ? (
                  <OctantButton
                    aria-label={`Show the key for ${server.alias}${suffix}`}
                    disabled={props.busy}
                    onClick={() => {
                      const id = String(server.serverId);
                      void props.onShowKey(server).then((shown) => {
                        setShownKeys((current) => new Map(current).set(id, shown));
                      });
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Show key
                  </OctantButton>
                ) : null}
                <OctantButton
                  aria-label={`Change ${server.alias}${suffix}`}
                  disabled={props.busy}
                  onClick={() => {
                    props.onClearProblem();
                    setEditingId(String(server.serverId));
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Change
                </OctantButton>
                <OctantButton
                  aria-label={`Remove ${server.alias}${suffix}`}
                  disabled={props.busy}
                  onClick={() => {
                    void props.onRemove(server).then((removed) => {
                      if (removed && editingId === String(server.serverId)) {
                        setEditingId(undefined);
                      }
                    });
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              </span>
              <ServerKey
                copied={copiedId === String(server.serverId)}
                onCopied={() => setCopiedId(String(server.serverId))}
                server={server}
                shown={
                  server.signIn === "octant-key"
                    ? shownKeys.get(String(server.serverId))
                    : undefined
                }
              />
            </li>
          ))}
        </ul>
      )}
      <h3 className="shield-servers__heading">
        {editing === undefined ? "Add a server" : "Change a server"}
      </h3>
      <p className="shield-servers__note">
        {editing === undefined
          ? "Use a host alias from your SSH config."
          : `Changing ${editing.alias}.`}
      </p>
      <div data-setting-id={forProject === undefined ? "shield-servers-add" : undefined}>
        <ServerForm
          busy={props.busy}
          editing={editing}
          forProject={forProject}
          key={editing === undefined ? `add:${String(formKey)}` : String(editing.serverId)}
          onCancel={() => {
            props.onClearProblem();
            setEditingId(undefined);
          }}
          onSubmit={(fields) => {
            const saved =
              editing === undefined ? props.onAdd(fields) : props.onChange(editing, fields);
            void saved.then((ok) => {
              if (!ok) return;
              setEditingId(undefined);
              setFormKey((key) => key + 1);
            });
          }}
          problem={props.problem}
        />
      </div>
    </>
  );
}

/**
 * The public line of the key Octant keeps for a server, for the person to add
 * to that server's `authorized_keys`. The private key never reaches this page.
 */
function ServerKey(props: {
  readonly server: ShieldServer;
  readonly shown: KeyShown | undefined;
  readonly copied: boolean;
  readonly onCopied: () => void;
}) {
  const { server, shown } = props;
  if (shown === undefined) return null;
  if (shown.kind === "problem") {
    return (
      <OctantAlert className="shield-servers__key" tone="danger">
        {shown.message}
      </OctantAlert>
    );
  }
  return (
    <div className="shield-servers__key">
      <p className="shield-servers__note">
        Add this line to <code>~/.ssh/authorized_keys</code> for {server.user} on {server.alias}.
      </p>
      <code className="shield-servers__public-key">{shown.publicKey}</code>
      <OctantButton
        aria-label={`Copy the key for ${server.alias}`}
        onClick={() => {
          void navigator.clipboard?.writeText(shown.publicKey).then(props.onCopied, () => {});
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        {props.copied ? "Copied" : "Copy"}
      </OctantButton>
    </div>
  );
}

type Problem = { readonly scope: "account" | "project"; readonly message: string };

/**
 * Settings › Servers: the servers a person registers with Octant Shield, each
 * with the profile that bounds what a thread may do there without asking, and
 * a Project that keeps a list of its own in their place. Only a local window
 * edits the registry; a refusal from the host is shown beside the form
 * exactly as it arrived.
 */
export function ShieldServersSettings(props: ShieldServersSettingsProps) {
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
  const [view, setView] = useState<ShieldServersView | undefined>(undefined);
  /** The selection `view` was read for; Project controls show only when it is the picker's. */
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const focused = props.focusedSetting?.startsWith("shield-servers") === true;
  useEffect(() => {
    if (!focused || root.current === null) return;
    root.current.focus();
    root.current.scrollIntoView?.({ block: "center" });
  }, [focused]);

  const load = useCallback(
    async (chosen: string) => {
      if (client === undefined) return;
      const mine = ++requestNumber.current;
      try {
        const next = await client.read(chosen === "" ? undefined : chosen);
        if (mine !== requestNumber.current || chosen !== selected.current) return;
        setView(next);
        setLoadedFor(chosen);
        setLoadFailed(false);
      } catch {
        if (mine === requestNumber.current) setLoadFailed(true);
      }
    },
    [client],
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

  async function send(command: ShieldServersCommand, scope: "account" | "project") {
    if (client === undefined) return false;
    const sentFor = projectId;
    setProblem(undefined);
    setBusy(true);
    try {
      const result = await client.command(command);
      if (result.kind === "shield-servers-refused") {
        if (sentFor === selected.current) setProblem({ scope, message: result.message });
        return false;
      }
      if (result.kind !== "shield-servers-updated") return false;
      // The answer to an account command describes no Project, and the answer
      // to a Project command is about the Project it was sent for, which the
      // person may have left while it was saved. Either way only what it
      // describes is taken.
      if (scope === "account") {
        const { servers, sshAgent } = result.view;
        setView((current) =>
          current === undefined ? result.view : { ...current, servers, sshAgent },
        );
      } else if (sentFor === selected.current) {
        setView(result.view);
      }
      return true;
    } catch {
      if (sentFor === selected.current) {
        setProblem({ scope, message: "Servers could not be saved." });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function showKey(server: ShieldServer): Promise<KeyShown> {
    if (client === undefined) return { kind: "problem", message: "Servers are unavailable." };
    try {
      const result = await client.command({ kind: "show-server-key", serverId: server.serverId });
      if (result.kind === "shield-server-key") return { kind: "key", publicKey: result.publicKey };
      if (result.kind === "shield-servers-refused") return { kind: "problem", message: result.message };
    } catch {
      // Shown below as the same plain problem.
    }
    return { kind: "problem", message: "The key could not be shown." };
  }

  /** The picker only offers the host's own Project ids. */
  const chosenProject = () => projectId as AggregateId;
  /** Whether what is shown for the Project is the picker's Project, read for it. */
  const showsChosenProject =
    projectId !== "" &&
    loadedFor === projectId &&
    view?.project !== undefined &&
    String(view.project.projectId) === projectId;

  function chooseProject(next: string) {
    if (next === selected.current) return;
    selected.current = next;
    setProblem(undefined);
    setLoadedFor(undefined);
    setProjectId(next);
  }

  if (client === undefined) {
    return (
      <SettingsState kind="empty">
        Servers are managed on the host computer. Open Octant there to add or change them.
      </SettingsState>
    );
  }
  if (view === undefined) {
    return (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed ? "Servers could not be read from this host." : "Reading servers…"}
      </SettingsState>
    );
  }

  const projectView = showsChosenProject ? view.project : undefined;
  const readingProject = projectId !== "" && loadedFor !== projectId;
  const override = projectView?.override ?? null;
  const problemFor = (scope: "account" | "project") =>
    problem?.scope === scope ? problem.message : undefined;

  // A Project's list is only ever saved whole, and only to the Project it was read for.
  const saveProject = (servers: ReadonlyArray<ShieldServerFields>) =>
    showsChosenProject
      ? send({ kind: "set-project-servers", projectId: chosenProject(), servers }, "project")
      : Promise.resolve(false);

  return (
    <div
      className="shield-servers"
      data-focused={focused ? "true" : "false"}
      data-setting-id="shield-servers-list"
      ref={root}
      tabIndex={-1}
    >
      <SettingsPanel description={SHIELD_SERVERS_INTRO} title="Your servers">
        {view.sshAgent === "missing" ? (
          <SettingsState kind="empty">{SHIELD_SSH_AGENT_MISSING_NOTE}</SettingsState>
        ) : null}
        <ul className="shield-servers__profiles">
          {PROFILE_ORDER.map((id) => (
            <li key={id}>
              <strong>{PROFILE_LABELS[id]}:</strong> {PROFILE_EXPLANATIONS[id]}
            </li>
          ))}
        </ul>
        <p className="shield-servers__note">{SHIELD_SERVERS_ALWAYS_ASK_NOTE}</p>
        <ServerEditor
          busy={busy}
          onAdd={(fields) => send({ kind: "register-server", server: fields }, "account")}
          onChange={(server, fields) =>
            send({ kind: "change-server", serverId: server.serverId, server: fields }, "account")
          }
          onClearProblem={() => setProblem(undefined)}
          onRemove={(server) =>
            send({ kind: "remove-server", serverId: server.serverId }, "account")
          }
          onShowKey={showKey}
          problem={problemFor("account")}
          servers={view.servers}
        />
      </SettingsPanel>
      <SettingsPanel description={SHIELD_PROJECT_SERVERS_NOTE} title="Project">
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
        {readingProject ? (
          <SettingsState kind="loading">Reading this Project's servers…</SettingsState>
        ) : null}
        {projectView === undefined ? null : (
          <>
            <div
              aria-label={`Servers for ${projectName}`}
              className="shield-servers__choice"
              role="group"
            >
              <OctantButton
                aria-pressed={override === null}
                disabled={busy}
                onClick={() => {
                  if (override === null) return;
                  void send(
                    { kind: "clear-project-override", projectId: chosenProject() },
                    "project",
                  );
                }}
                size="sm"
                type="button"
                variant={override === null ? "secondary" : "ghost"}
              >
                Use the account's servers
              </OctantButton>
              <OctantButton
                aria-pressed={override !== null}
                disabled={busy}
                onClick={() => {
                  if (override !== null) return;
                  // The own list starts as a copy of the account list.
                  void saveProject(view.servers.map(fieldsOf));
                }}
                size="sm"
                type="button"
                variant={override !== null ? "secondary" : "ghost"}
              >
                Use servers for this Project only
              </OctantButton>
            </div>
            {override === null ? (
              <p className="shield-servers__note">
                {projectName} uses the account's servers. Choose its own list to change them for
                this Project only.
              </p>
            ) : (
              <>
                <p className="shield-servers__note">{projectName} has its own servers.</p>
                <ServerEditor
                  busy={busy}
                  forProject={projectName}
                  onAdd={(fields) => saveProject([...override.map(fieldsOf), fields])}
                  onChange={(server, fields) =>
                    saveProject(
                      override.map((entry) =>
                        entry.serverId === server.serverId ? fields : fieldsOf(entry),
                      ),
                    )
                  }
                  onClearProblem={() => setProblem(undefined)}
                  onRemove={(server) =>
                    saveProject(
                      override.filter((entry) => entry.serverId !== server.serverId).map(fieldsOf),
                    )
                  }
                  onShowKey={showKey}
                  problem={problemFor("project")}
                  servers={override}
                />
              </>
            )}
          </>
        )}
      </SettingsPanel>
    </div>
  );
}
