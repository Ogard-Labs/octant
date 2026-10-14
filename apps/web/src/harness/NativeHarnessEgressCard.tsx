import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ToolEgressCommand,
  ToolEgressGrantChoice,
  ToolEgressProposalView,
  ToolEgressRuleView,
  ToolEgressThreadView,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import "./native-harness.css";

export interface NativeHarnessEgressCardProps {
  readonly client: Pick<NativeHarnessClient, "egress" | "egressCommand">;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
  /** For tests: the time rule expiries are counted from. */
  readonly now?: () => number;
}

const DECLINE = "decline";
const DEFAULT_CHOICE = "thread:8h";

const CHOICES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly choice: ToolEgressGrantChoice;
}> = [
  { id: "thread:1h", label: "This thread, 1 hour", choice: { kind: "thread", lifetime: "1h" } },
  { id: "thread:8h", label: "This thread, 8 hours", choice: { kind: "thread", lifetime: "8h" } },
  { id: "thread:7d", label: "This thread, 7 days", choice: { kind: "thread", lifetime: "7d" } },
  { id: "project:7d", label: "Project, 7 days", choice: { kind: "project", lifetime: "7d" } },
  { id: "project:30d", label: "Project, 30 days", choice: { kind: "project", lifetime: "30d" } },
];

function choiceOptions(view: ToolEgressThreadView): ReadonlyArray<OctantSelectOption> {
  const projectReason =
    view.projectGrant === "needs-local-window"
      ? "A Project rule needs you at this computer."
      : view.projectGrant === "thread-tainted"
        ? "This thread read outside content."
        : undefined;
  return CHOICES.map((entry) =>
    entry.choice.kind === "project" && projectReason !== undefined
      ? { id: entry.id, label: entry.label, disabled: true, disabledReason: projectReason }
      : { id: entry.id, label: entry.label },
  );
}

function grantChoice(id: string): ToolEgressGrantChoice | undefined {
  return CHOICES.find((entry) => entry.id === id)?.choice;
}

function remaining(expiresAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 60_000));
  if (minutes < 60) return `${String(minutes)} min left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h left`;
  return `${String(Math.round(hours / 24))} days left`;
}

function grantedBy(rule: ToolEgressRuleView): string {
  switch (rule.grantedBy) {
    case "local-window":
      return "allowed at this computer";
    case "remote-device":
      return "allowed from a paired device";
    case "reviewer":
      return "allowed by the reviewer";
  }
}

function destination(entry: { readonly host: string; readonly port: number }): string {
  return entry.port === 443 ? entry.host : `${entry.host}:${String(entry.port)}`;
}

/**
 * The hosts a Code thread's harness commands may reach, and the hosts a
 * command was refused that wait for a person. A refusal is only ever a
 * proposal here: nothing is allowed until a person picks a scope and answers.
 * Shown once the thread's commands run through these rules, or once the
 * thread holds a rule or a proposal.
 */
export function NativeHarnessEgressCard(props: NativeHarnessEgressCardProps) {
  const [view, setView] = useState<ToolEgressThreadView | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const [draftHost, setDraftHost] = useState("");
  const [draftPort, setDraftPort] = useState("443");
  const [draftChoice, setDraftChoice] = useState(DEFAULT_CHOICE);
  const generation = useRef(0);
  const now = props.now ?? Date.now;

  const load = useCallback(async () => {
    const asked = ++generation.current;
    try {
      const next = await props.client.egress(props.threadId);
      if (generation.current !== asked) return;
      setView(next);
    } catch (failure) {
      if (generation.current !== asked) return;
      setError(
        failure instanceof NativeHarnessClientFailure
          ? failure.message
          : "Network rules are unavailable.",
      );
    }
  }, [props.client, props.threadId]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      void load().finally(() => {
        inFlight = false;
      });
    };
    tick();
    return scheduleVisibleInterval(tick, props.refreshIntervalMs ?? 5_000);
  }, [load, props.refreshIntervalMs]);

  const send = useCallback(
    async (command: ToolEgressCommand): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      try {
        const result = await props.client.egressCommand(props.threadId, command);
        if (result.kind === "tool-egress-refused") {
          setError(result.message);
          await load();
          return false;
        }
        generation.current += 1;
        setView(result.view);
        setError(undefined);
        return true;
      } catch (failure) {
        setError(
          failure instanceof NativeHarnessClientFailure
            ? failure.message
            : "The answer could not be sent.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, props.client, props.threadId, load],
  );

  if (view === undefined || view === null) {
    return error === undefined ? null : <OctantAlert tone="warning">{error}</OctantAlert>;
  }
  if (
    !view.enforced &&
    view.threadRules.length === 0 &&
    view.projectRules.length === 0 &&
    view.proposals.length === 0
  ) {
    return null;
  }

  const answerProposals = (proposals: ReadonlyArray<ToolEgressProposalView>) => {
    const grants: Array<{ host: string; port: number; choice: ToolEgressGrantChoice }> = [];
    const declineProposalIds: Array<ToolEgressProposalView["proposalId"]> = [];
    for (const proposal of proposals) {
      const choice = grantChoice(choices[String(proposal.proposalId)] ?? DEFAULT_CHOICE);
      if (choice === undefined) declineProposalIds.push(proposal.proposalId);
      else grants.push({ host: proposal.host, port: proposal.port, choice });
    }
    void send(
      grants.length === 0
        ? { kind: "decline-proposals", proposalIds: declineProposalIds }
        : { kind: "grant-rules", grants, declineProposalIds },
    ).then((sent) => {
      if (sent) setChoices({});
    });
  };

  const addRule = () => {
    const choice = grantChoice(draftChoice);
    const port = Number(draftPort);
    if (choice === undefined || draftHost.trim().length === 0) return;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setError("A port is a whole number from 1 to 65535.");
      return;
    }
    void send({
      kind: "grant-rules",
      grants: [{ host: draftHost.trim(), port, choice }],
      declineProposalIds: [],
    }).then((sent) => {
      if (sent) {
        setDraftHost("");
        setDraftPort("443");
      }
    });
  };

  const options = choiceOptions(view);
  const proposalOptions: ReadonlyArray<OctantSelectOption> = [
    ...options,
    { id: DECLINE, label: "Don't allow" },
  ];

  const ruleList = (rules: ReadonlyArray<ToolEgressRuleView>, empty: string, label: string) =>
    rules.length === 0 ? (
      <p className="native-harness-card__detail native-harness-egress__empty">{empty}</p>
    ) : (
      <ul aria-label={label} className="native-harness-egress__rules">
        {rules.map((rule) => (
          <li className="native-harness-egress__rule" key={String(rule.ruleId)}>
            <span className="native-harness-egress__label">
              <span className="native-harness-egress__host">{destination(rule)}</span>
              <span className="native-harness-egress__meta">
                {rule.scope === "call" ? "One command" : remaining(rule.expiresAt, now())} ·{" "}
                {grantedBy(rule)}
              </span>
            </span>
            <OctantButton
              aria-label={`Revoke ${destination(rule)}`}
              disabled={busy}
              onClick={() => void send({ kind: "revoke-rule", ruleId: rule.ruleId })}
              size="sm"
              type="button"
              variant="ghost"
            >
              Revoke
            </OctantButton>
          </li>
        ))}
      </ul>
    );

  return (
    <section aria-label="Network access" className="native-harness-card native-harness-egress">
      <div className="native-harness-card__head">
        <h3>Network access</h3>
        <label className="native-harness-egress__learn">
          <span>Propose refused hosts</span>
          <OctantSwitch
            checked={view.learnMode}
            disabled={busy}
            label="Propose refused hosts"
            onCheckedChange={(enabled) => void send({ kind: "set-learn-mode", enabled })}
          />
        </label>
      </div>
      {view.enforced ? null : (
        <p className="native-harness-card__detail">
          Commands on this thread do not go through these rules yet.
        </p>
      )}
      {view.proposals.length === 0 ? null : (
        <section aria-label="Hosts a command was refused" className="native-harness-question">
          <p className="native-harness-question__prompt">
            <strong>
              A command was refused {view.proposals.length === 1 ? "a host" : "these hosts"}.
            </strong>{" "}
            Nothing is allowed until you choose.
          </p>
          {view.threadTainted ? (
            <p className="native-harness-card__detail">
              This thread read outside content, so a host can be allowed only for one command you
              confirm.
            </p>
          ) : null}
          <ul className="native-harness-egress__rules">
            {view.proposals.map((proposal) => (
              <li
                className="native-harness-egress__rule native-harness-egress__rule--proposal"
                key={String(proposal.proposalId)}
              >
                <span className="native-harness-egress__label">
                  <span className="native-harness-egress__host">{destination(proposal)}</span>
                  <span className="native-harness-egress__meta">
                    {proposal.reason === "expired" ? "Rule expired" : "No rule"} ·{" "}
                    {proposal.attempts === 1 ? "1 try" : `${String(proposal.attempts)} tries`}
                    {proposal.childThreadId === undefined
                      ? ""
                      : ` · subagent ${String(proposal.childThreadId).slice(0, 8)}`}
                  </span>
                </span>
                {view.threadTainted ? null : (
                  <OctantSelectField
                    aria-label={`Allow ${destination(proposal)}`}
                    className="native-harness-egress__choice"
                    disabled={busy}
                    onValueChange={(value) =>
                      setChoices((current) => ({
                        ...current,
                        [String(proposal.proposalId)]: value,
                      }))
                    }
                    options={proposalOptions}
                    value={choices[String(proposal.proposalId)] ?? DEFAULT_CHOICE}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="native-harness-chips">
            {view.threadTainted ? null : (
              <OctantButton
                disabled={busy}
                onClick={() => answerProposals(view.proposals)}
                size="sm"
                type="button"
                variant="default"
              >
                Apply
              </OctantButton>
            )}
            <OctantButton
              disabled={busy}
              onClick={() =>
                void send({
                  kind: "decline-proposals",
                  proposalIds: view.proposals.map((proposal) => proposal.proposalId),
                })
              }
              size="sm"
              type="button"
              variant="secondary"
            >
              Decline all
            </OctantButton>
          </div>
        </section>
      )}
      <h4>This thread</h4>
      {ruleList(view.threadRules, "No hosts allowed.", "Hosts this thread may reach")}
      {view.threadTainted ? null : (
        <form
          aria-label="Allow a host"
          className="native-harness-egress__add"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            addRule();
          }}
        >
          <OctantInput
            aria-label="Host"
            className="native-harness-egress__host-input"
            disabled={busy}
            onChange={(event) => setDraftHost(event.target.value)}
            placeholder="registry.npmjs.org"
            value={draftHost}
          />
          <OctantInput
            aria-label="Port"
            className="native-harness-egress__port-input"
            disabled={busy}
            inputMode="numeric"
            onChange={(event) => setDraftPort(event.target.value)}
            value={draftPort}
          />
          <OctantSelectField
            aria-label="How long"
            className="native-harness-egress__choice"
            disabled={busy}
            onValueChange={setDraftChoice}
            options={options}
            value={draftChoice}
          />
          <OctantButton
            disabled={busy || draftHost.trim().length === 0}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Allow
          </OctantButton>
        </form>
      )}
      <h4>Project</h4>
      {ruleList(
        view.projectRules,
        "No hosts allowed for the Project.",
        "Hosts the Project may reach",
      )}
      {error === undefined ? null : (
        <OctantAlert className="native-harness-panel__error" tone="warning">
          {error}
        </OctantAlert>
      )}
    </section>
  );
}
