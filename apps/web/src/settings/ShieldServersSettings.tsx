import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type {
  ShieldServer,
  ShieldServerFields,
  ShieldServerProfile,
  ShieldServersCommand,
  ShieldServersView,
} from "@octant/contracts/shield-servers";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
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
}

export const SHIELD_SERVERS_INTRO =
  "Agents reach these servers with your own SSH agent. Octant never reads your key files.";
export const SHIELD_SSH_AGENT_MISSING_NOTE =
  "No SSH agent is running for Octant, so SSH commands cannot sign in.";
export const SHIELD_SERVERS_ALWAYS_ASK_NOTE =
  "Lock-out and destructive actions (firewall changes, removing users or keys, disk changes, deleting data, reboots) always ask you.";

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

interface ServerFormProps {
  readonly editing: ShieldServer | undefined;
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const runbookPath = runbook.trim();
    props.onSubmit({
      alias: alias.trim(),
      user: user.trim(),
      profile,
      deployCommands: profileAllowsDeploys(profile) ? deployLines(deploys) : [],
      ...(runbookPath === "" ? {} : { runbookPath }),
    });
  }

  return (
    <form
      aria-label={editing === undefined ? "Add a server" : `Change ${editing.alias}`}
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

/**
 * Settings › Servers: the servers a person registers with Octant Shield, each
 * with the profile that bounds what a thread may do there without asking.
 * Only a local window edits the registry; a refusal from the host is shown
 * beside the form exactly as it arrived.
 */
export function ShieldServersSettings(props: ShieldServersSettingsProps) {
  const { client } = props;
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ShieldServersView | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  /** Bumped after a successful add so the form remounts empty. */
  const [formKey, setFormKey] = useState(0);

  const focused = props.focusedSetting?.startsWith("shield-servers") === true;
  useEffect(() => {
    if (!focused || root.current === null) return;
    root.current.focus();
    root.current.scrollIntoView?.({ block: "center" });
  }, [focused]);

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setView(await client.read());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(command: ShieldServersCommand): Promise<boolean> {
    if (client === undefined) return false;
    setProblem(undefined);
    setBusy(true);
    try {
      const result = await client.command(command);
      if (result.kind === "shield-servers-updated") {
        setView(result.view);
        return true;
      }
      setProblem(result.message);
      return false;
    } catch {
      setProblem("Servers could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
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

  const editing = view.servers.find((server) => String(server.serverId) === editingId);

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
        {view.servers.length === 0 ? (
          <p className="shield-servers__empty">No servers registered.</p>
        ) : (
          <ul aria-label="Registered servers" className="shield-servers__list">
            {view.servers.map((server) => (
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
                <span className="shield-servers__row-actions">
                  <OctantButton
                    aria-label={`Change ${server.alias}`}
                    disabled={busy}
                    onClick={() => {
                      setProblem(undefined);
                      setEditingId(String(server.serverId));
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Change
                  </OctantButton>
                  <OctantButton
                    aria-label={`Remove ${server.alias}`}
                    disabled={busy}
                    onClick={() => {
                      void send({ kind: "remove-server", serverId: server.serverId }).then(
                        (removed) => {
                          if (removed && editingId === String(server.serverId)) {
                            setEditingId(undefined);
                          }
                        },
                      );
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </OctantButton>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsPanel>
      <SettingsPanel
        description={
          editing === undefined
            ? "Use a host alias from your SSH config."
            : `Changing ${editing.alias}.`
        }
        title={editing === undefined ? "Add a server" : "Change a server"}
      >
        <div data-setting-id="shield-servers-add">
          <ServerForm
            busy={busy}
            editing={editing}
            key={editing === undefined ? `add:${String(formKey)}` : String(editing.serverId)}
            onCancel={() => {
              setProblem(undefined);
              setEditingId(undefined);
            }}
            onSubmit={(fields) => {
              const command: ShieldServersCommand =
                editing === undefined
                  ? { kind: "register-server", server: fields }
                  : { kind: "change-server", serverId: editing.serverId, server: fields };
              void send(command).then((saved) => {
                if (!saved) return;
                setEditingId(undefined);
                setFormKey((key) => key + 1);
              });
            }}
            problem={problem}
          />
        </div>
      </SettingsPanel>
    </div>
  );
}
