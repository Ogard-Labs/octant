import type { AgentGrantClient } from "@octant/client-runtime/agent-grant-client";
import {
  AGENT_GRANT_LEVELS,
  AGENT_GRANT_MODES,
  AGENT_GRANT_TOOLS,
  AgentAccessResult,
  DEFAULT_AGENT_GRANT_LIMITS,
  decodeHostAnswer,
  decodeProjectId,
  type AgentAccessCommand,
  type AgentGrantLevel,
  type AgentGrantMode,
  type AgentGrantScope,
  type AgentGrantView,
} from "@octant/contracts";
import { useCallback, useId, useRef, useState } from "react";
import { failureMessage } from "../lib/failureMessage";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import type { AgentAccessAdministrationBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/**
 * A key that has just claimed a connection code waits for the person to
 * confirm it, and the code lapses after five minutes, so the list is read
 * every few seconds while it is in view.
 */
const REFRESH_MS = 5_000;

const LEVEL_LABELS: Readonly<Record<AgentGrantLevel, string>> = {
  "ask-first": "Ask first",
  "accept-edits": "Accept edits",
  auto: "Auto",
  plan: "Plan",
  "full-access": "Full access",
};
const MODE_LABELS: Readonly<Record<AgentGrantMode, string>> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

type Answer = AgentAccessResult;
type Message = { readonly kind: "success" | "error"; readonly text: string };
/** Shown once after a grant is made or a code or key is issued, then gone. */
type OneTime = {
  readonly grantName: string;
  readonly connectionCode?: string;
  readonly directKey?: { readonly key: string; readonly endpoint: string };
};

/**
 * Settings › Remote access › Agent access. On a local window it makes,
 * changes, and revokes grants, issues connection codes, and confirms the keys
 * that claim them. A paired device sees the same list and can revoke, because
 * revoking only takes authority away; everything else stays at the computer.
 */
export function AgentAccessSettingsSection(props: {
  readonly administration?: AgentAccessAdministrationBridge;
  readonly client?: AgentGrantClient;
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const { administration, client } = props;
  const [grants, setGrants] = useState<ReadonlyArray<AgentGrantView>>();
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [oneTime, setOneTime] = useState<OneTime>();
  const [editing, setEditing] = useState<AgentGrantView | "new">();
  const [revoking, setRevoking] = useState<AgentGrantView>();
  const [stopTurns, setStopTurns] = useState(false);
  const revokeOpener = useRef<HTMLElement | null>(null);

  const send = useCallback(
    async (command: AgentAccessCommand): Promise<Answer> => {
      if (administration === undefined) throw new Error("Only this computer can do that.");
      const answer = await administration.agentAccessRequest({ kind: "command", command });
      return decodeHostAnswer(AgentAccessResult)(answer.body);
    },
    [administration],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      let answer: Answer;
      if (administration !== undefined) {
        const listed = await administration.agentAccessRequest({ kind: "list" });
        answer = decodeHostAnswer(AgentAccessResult)(listed.body);
      } else if (client !== undefined) {
        answer = await client.grants(signal);
      } else {
        return;
      }
      if (answer.kind === "grants") setGrants(answer.grants);
    },
    [administration, client],
  );
  useVisibleRefresh(refresh, undefined, REFRESH_MS);

  const act = async (work: () => Promise<Message | undefined>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const next = await work();
      if (next !== undefined) setMessage(next);
    } catch (error) {
      setMessage({ kind: "error", text: failureMessage(error, "Agent access is unavailable.") });
    } finally {
      setBusy(false);
      await refresh().catch(() => undefined);
    }
  };

  const refusal = (answer: Answer): Message | undefined =>
    answer.kind === "refused" ? { kind: "error", text: answer.message } : undefined;

  const save = (draft: GrantDraft) =>
    act(async () => {
      if (editing === "new") {
        const created = await send({
          kind: "create",
          draft: { name: draft.name, scope: draft.scope, days: draft.days },
        });
        if (created.kind !== "grant") return refusal(created);
        const grantId = created.grant.grant.grantId;
        const ticket = await send({ kind: "issue-ticket", grantId });
        const direct = draft.scope.direct
          ? await send({ kind: "rotate-direct-key", grantId })
          : undefined;
        setEditing(undefined);
        setOneTime({
          grantName: draft.name,
          ...(ticket.kind === "ticket" ? { connectionCode: ticket.connectionCode } : {}),
          ...(direct?.kind === "direct-key"
            ? { directKey: { key: direct.key, endpoint: direct.endpoint } }
            : {}),
        });
        return ticket.kind === "ticket" ? undefined : refusal(ticket);
      }
      if (editing === undefined) return undefined;
      const changed = await send({
        kind: "change",
        grantId: editing.grant.grantId,
        expectedGeneration: editing.grant.generation,
        name: draft.name,
        scope: draft.scope,
      });
      if (changed.kind === "refused") return refusal(changed);
      setEditing(undefined);
      return { kind: "success", text: `Changed ${draft.name}.` };
    });

  const revoke = (view: AgentGrantView) =>
    act(async () => {
      const request = { grantId: view.grant.grantId, stopRunningTurns: stopTurns };
      const answer =
        administration !== undefined
          ? await send({ kind: "revoke", ...request })
          : client !== undefined
            ? await client.revoke(request)
            : undefined;
      setRevoking(undefined);
      if (answer === undefined) return undefined;
      return answer.kind === "done"
        ? { kind: "success", text: `Revoked ${view.grant.name}.` }
        : refusal(answer);
    });

  const active = grants?.filter((view) => view.grant.state === "active") ?? [];
  const revoked = grants?.filter((view) => view.grant.state === "revoked") ?? [];

  return (
    <SettingsSection title="Agent access">
      <div className="setgroup">
        <SettingRow
          description={
            administration === undefined
              ? "Agents on other computers on your network that may start work here. You can revoke one from this device; make or change a grant on the computer running Octant."
              : "Let an agent on another computer on your network, such as a bot or a coding tool, start and follow work here, within what you choose. Its approvals wait for you, and it never gets Full access."
          }
          label="Agents on other computers"
          scope="app"
          settingId="agent-access"
        >
          {administration === undefined ? null : (
            <div className="host-settings__controls">
              <OctantButton
                disabled={busy || editing !== undefined}
                onClick={() => {
                  setOneTime(undefined);
                  setEditing("new");
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                New agent grant…
              </OctantButton>
            </div>
          )}
        </SettingRow>
        {editing === undefined ? null : (
          <SettingRow
            label={editing === "new" ? "New agent grant" : `Change ${editing.grant.name}`}
            scope="app"
            settingId="agent-access-edit"
          >
            <GrantForm
              busy={busy}
              initial={editing === "new" ? undefined : editing}
              onCancel={() => setEditing(undefined)}
              onSave={(draft) => void save(draft)}
              projectNames={props.projectNames}
            />
          </SettingRow>
        )}
        {oneTime === undefined ? null : (
          <SettingRow
            description="Shown once. The code works for five minutes; then confirm the key it sends below."
            label={`Connect ${oneTime.grantName}`}
            scope="app"
            settingId="agent-access-code"
          >
            <OneTimeCredentials oneTime={oneTime} onDone={() => setOneTime(undefined)} />
          </SettingRow>
        )}
        {grants === undefined ? (
          <SettingsState kind="loading">Reading agent grants…</SettingsState>
        ) : grants.length === 0 ? (
          <SettingsState kind="empty">No agent has a grant.</SettingsState>
        ) : null}
        {[...active, ...revoked].map((view) => (
          <SettingRow
            description={grantSummary(view, props.projectNames)}
            key={String(view.grant.grantId)}
            label={
              view.grant.state === "revoked" ? `${view.grant.name} (revoked)` : view.grant.name
            }
            scope="app"
            settingId={`agent-grant-${String(view.grant.grantId)}`}
          >
            {view.grant.state === "revoked" ? null : (
              <div className="settings-panel__stack">
                {administration === undefined
                  ? null
                  : view.pendingClaims.map((claim) => (
                      <div className="host-settings__controls" key={claim.fingerprint}>
                        <span className="oct-meta">
                          {`${claim.label} wants to connect with key ${shortFingerprint(claim.fingerprint)}. Confirm only if the agent's computer shows the same.`}
                        </span>
                        <OctantButton
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const answer = await send({
                                kind: "confirm-key",
                                grantId: view.grant.grantId,
                                fingerprint: claim.fingerprint,
                              });
                              return answer.kind === "refused"
                                ? refusal(answer)
                                : { kind: "success", text: `${view.grant.name} can connect now.` };
                            })
                          }
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Confirm key
                        </OctantButton>
                      </div>
                    ))}
                {administration === undefined
                  ? null
                  : view.grant.keys.map((key) => (
                      <div className="host-settings__controls" key={key.fingerprint}>
                        <span className="oct-meta">{`${key.label} · key ${shortFingerprint(key.fingerprint)}`}</span>
                        <OctantButton
                          aria-label={`Remove ${key.label}'s key`}
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              refusal(
                                await send({
                                  kind: "remove-key",
                                  grantId: view.grant.grantId,
                                  fingerprint: key.fingerprint,
                                }),
                              ),
                            )
                          }
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Remove key
                        </OctantButton>
                      </div>
                    ))}
                <div className="host-settings__controls">
                  {administration === undefined ? null : (
                    <>
                      <OctantButton
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const ticket = await send({
                              kind: "issue-ticket",
                              grantId: view.grant.grantId,
                            });
                            if (ticket.kind !== "ticket") return refusal(ticket);
                            setOneTime({
                              grantName: view.grant.name,
                              connectionCode: ticket.connectionCode,
                            });
                            return undefined;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        New connection code
                      </OctantButton>
                      {view.grant.scope.direct ? (
                        <OctantButton
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const direct = await send({
                                kind: "rotate-direct-key",
                                grantId: view.grant.grantId,
                              });
                              if (direct.kind !== "direct-key") return refusal(direct);
                              setOneTime({
                                grantName: view.grant.name,
                                directKey: { key: direct.key, endpoint: direct.endpoint },
                              });
                              return undefined;
                            })
                          }
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {view.directKey ? "Rotate direct key" : "Make direct key"}
                        </OctantButton>
                      ) : null}
                      <OctantButton
                        disabled={busy || editing !== undefined}
                        onClick={() => setEditing(view)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Change…
                      </OctantButton>
                    </>
                  )}
                  <OctantButton
                    aria-haspopup="dialog"
                    aria-label={`Revoke ${view.grant.name}`}
                    disabled={busy}
                    onClick={(event) => {
                      revokeOpener.current = event.currentTarget;
                      setStopTurns(false);
                      setRevoking(view);
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Revoke…
                  </OctantButton>
                </div>
              </div>
            )}
          </SettingRow>
        ))}
      </div>
      {revoking === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Keep it"
          confirmLabel="Revoke grant"
          destructive
          onCancel={() => setRevoking(undefined)}
          onConfirm={() => void revoke(revoking)}
          restoreFocus={revokeOpener}
          title={`Revoke ${revoking.grant.name}?`}
        >
          <p>
            Its keys stop working at once and its open connections end. The threads it started stay
            yours, and turns already running keep running unless you stop them.
          </p>
          <label className="host-settings__controls">
            <OctantCheckbox
              checked={stopTurns}
              onChange={(event) => setStopTurns(event.currentTarget.checked)}
            />
            Also stop its running turns
          </label>
        </OctantConfirmDialog>
      )}
      {message === undefined ? null : (
        <SettingsState kind={message.kind}>{message.text}</SettingsState>
      )}
    </SettingsSection>
  );
}

interface GrantDraft {
  readonly name: string;
  readonly scope: AgentGrantScope;
  readonly days: number;
}

function GrantForm(props: {
  readonly initial: AgentGrantView | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly onSave: (draft: GrantDraft) => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const scope = props.initial?.grant.scope;
  const [name, setName] = useState(props.initial?.grant.name ?? "");
  const [projects, setProjects] = useState<ReadonlyArray<string>>(
    scope?.projects.map(String) ?? [],
  );
  const [modes, setModes] = useState<ReadonlyArray<AgentGrantMode>>(
    scope?.modes ?? ["code", "work"],
  );
  const [level, setLevel] = useState<AgentGrantLevel>(scope?.highestLevel ?? "ask-first");
  const [threads, setThreads] = useState<"own" | "project">(scope?.threads ?? "own");
  const [answers, setAnswers] = useState(scope?.tools.includes("answer_question") ?? false);
  const [direct, setDirect] = useState(scope?.direct ?? false);
  const [days, setDays] = useState("30");
  const toggle = <T,>(values: ReadonlyArray<T>, value: T, on: boolean): ReadonlyArray<T> =>
    on
      ? [...values.filter((entry) => entry !== value), value]
      : values.filter((entry) => entry !== value);
  const needsProject = modes.some((mode) => mode !== "chat");
  const dayCount = Number(days);
  const valid =
    name.trim().length > 0 &&
    modes.length > 0 &&
    (!needsProject || projects.length > 0) &&
    (props.initial !== undefined ||
      (Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 90));

  return (
    <form
      className="settings-panel__stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        props.onSave({
          name: name.trim(),
          days: dayCount,
          scope: {
            projects: projects.map((projectId) => decodeProjectId(projectId)),
            modes,
            highestLevel: level,
            threads,
            tools: AGENT_GRANT_TOOLS.filter((tool) => answers || tool !== "answer_question"),
            ...(scope?.models === undefined ? {} : { models: scope.models }),
            limits: scope?.limits ?? DEFAULT_AGENT_GRANT_LIMITS,
            direct,
          },
        });
      }}
    >
      <OctantField>
        <OctantFieldLabel htmlFor={`${id}-name`}>Name</OctantFieldLabel>
        <OctantInput
          id={`${id}-name`}
          onChange={(event) => setName(event.target.value)}
          placeholder="Home bot"
          value={name}
        />
      </OctantField>
      <fieldset className="settings-panel__stack">
        <legend>Projects it may work in</legend>
        {[...props.projectNames].map(([projectId, projectName]) => (
          <label className="host-settings__controls" key={projectId}>
            <OctantCheckbox
              checked={projects.includes(projectId)}
              onChange={(event) =>
                setProjects(toggle(projects, projectId, event.currentTarget.checked))
              }
            />
            {projectName}
          </label>
        ))}
      </fieldset>
      <fieldset className="host-settings__controls">
        <legend>Modes</legend>
        {AGENT_GRANT_MODES.map((mode) => (
          <label className="host-settings__controls" key={mode}>
            <OctantCheckbox
              checked={modes.includes(mode)}
              onChange={(event) => setModes(toggle(modes, mode, event.currentTarget.checked))}
            />
            {MODE_LABELS[mode]}
          </label>
        ))}
      </fieldset>
      <OctantField>
        <OctantFieldLabel htmlFor={`${id}-level`}>Highest access level</OctantFieldLabel>
        <OctantSelectField
          id={`${id}-level`}
          onValueChange={(value) => {
            const next = AGENT_GRANT_LEVELS.find((entry) => entry === value);
            if (next !== undefined) setLevel(next);
          }}
          options={AGENT_GRANT_LEVELS.map((entry) => ({ id: entry, label: LEVEL_LABELS[entry] }))}
          value={level}
        />
      </OctantField>
      <OctantField>
        <OctantFieldLabel htmlFor={`${id}-threads`}>
          Threads it may read and continue
        </OctantFieldLabel>
        <OctantSelectField
          id={`${id}-threads`}
          onValueChange={(value) => setThreads(value === "project" ? "project" : "own")}
          options={[
            { id: "own", label: "Only threads it started" },
            { id: "project", label: "Every thread in its Projects" },
          ]}
          value={threads}
        />
      </OctantField>
      <label className="host-settings__controls">
        <OctantCheckbox
          checked={answers}
          onChange={(event) => setAnswers(event.currentTarget.checked)}
        />
        Let it answer its threads' questions
      </label>
      <label className="host-settings__controls">
        <OctantCheckbox
          checked={direct}
          onChange={(event) => setDirect(event.currentTarget.checked)}
        />
        Also allow a direct key, for clients that can only reach a web address
      </label>
      {props.initial === undefined ? (
        <OctantField>
          <OctantFieldLabel htmlFor={`${id}-days`}>
            Days until it ends (at most 90)
          </OctantFieldLabel>
          <OctantInput
            id={`${id}-days`}
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          />
        </OctantField>
      ) : null}
      <div className="host-settings__controls">
        <OctantButton disabled={props.busy || !valid} size="sm" type="submit" variant="secondary">
          {props.initial === undefined ? "Make grant" : "Save"}
        </OctantButton>
        <OctantButton onClick={props.onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}

function OneTimeCredentials(props: { readonly oneTime: OneTime; readonly onDone: () => void }) {
  const id = useId();
  const { connectionCode, directKey } = props.oneTime;
  return (
    <div className="settings-panel__stack">
      {connectionCode === undefined ? null : (
        <OctantField>
          <OctantFieldLabel htmlFor={`${id}-code`}>
            On the agent's computer, run this within five minutes
          </OctantFieldLabel>
          <OctantTextarea
            id={`${id}-code`}
            readOnly
            rows={3}
            spellCheck={false}
            value={`octant agent-access join ${connectionCode}`}
          />
        </OctantField>
      )}
      {directKey === undefined ? null : (
        <OctantField>
          <OctantFieldLabel htmlFor={`${id}-direct`}>
            Direct key and address. Copy it now; Octant keeps only a fingerprint of it.
          </OctantFieldLabel>
          <OctantTextarea
            id={`${id}-direct`}
            readOnly
            rows={3}
            spellCheck={false}
            value={`${directKey.endpoint}\nAuthorization: Bearer ${directKey.key}`}
          />
        </OctantField>
      )}
      <div className="host-settings__controls">
        <OctantButton onClick={props.onDone} size="sm" type="button" variant="secondary">
          Done
        </OctantButton>
      </div>
    </div>
  );
}

function grantSummary(view: AgentGrantView, projectNames: ReadonlyMap<string, string>): string {
  const { grant } = view;
  const projects = grant.scope.projects.map(
    (projectId) => projectNames.get(String(projectId)) ?? "a removed Project",
  );
  const connections = [
    grant.keys.length === 0
      ? undefined
      : `${String(grant.keys.length)} ${grant.keys.length === 1 ? "key" : "keys"}`,
    view.directKey ? "direct key" : undefined,
  ].filter((entry) => entry !== undefined);
  const lastUse =
    view.lastUsedAt === undefined
      ? "never used"
      : `last used ${new Date(view.lastUsedAt).toLocaleString()} over ${view.lastSourceClass === "tailscale" ? "Tailscale" : "your LAN"}`;
  return [
    `${grant.scope.modes.map((mode) => MODE_LABELS[mode]).join(", ")}${projects.length === 0 ? "" : ` in ${projects.join(", ")}`}`,
    `up to ${LEVEL_LABELS[grant.scope.highestLevel]}`,
    grant.scope.threads === "own" ? "only its own threads" : "every thread in its Projects",
    grant.state === "revoked"
      ? undefined
      : connections.length === 0
        ? "no key yet"
        : connections.join(" and "),
    lastUse,
    `${String(view.threadsStarted)} ${view.threadsStarted === 1 ? "thread" : "threads"} started`,
    `${String(view.turnsToday)} ${view.turnsToday === 1 ? "turn" : "turns"} today`,
    grant.state === "active" ? `ends ${new Date(grant.expiresAt).toLocaleDateString()}` : undefined,
  ]
    .filter((entry) => entry !== undefined)
    .join(" · ");
}

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16);
}
