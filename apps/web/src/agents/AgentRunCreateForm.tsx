import { useId, useState } from "react";
import type {
  AgentRunControlResolvedFacts,
  AgentRunCreationPosture,
  AgentRunRole,
} from "@octant/contracts";
import "./agent-hierarchy.css";

export interface AgentRunCreateFormValues {
  readonly role: AgentRunRole;
  readonly task: string;
  readonly includeParentContext?: boolean;
}

const ROLE_LABELS: Readonly<Record<AgentRunRole, string>> = {
  research: "Research",
  implementation: "Implement",
  review: "Review",
  custom: "Custom",
};

function factLabel(kind: AgentRunControlResolvedFacts["workspaceKind"]): string {
  if (kind === "chat-virtual") return "Research-only virtual workspace";
  if (kind === "work-root") return "Bound Project root";
  return "Confirmed isolated worktree";
}

/**
 * One-off child creation. The user picks a mode-valid role and a task; every
 * other fact is server-derived and shown read-only. Provider, model,
 * workspace, and authority are never typed here.
 */
export function AgentRunCreateForm(props: {
  readonly posture: AgentRunCreationPosture;
  readonly facts?: AgentRunControlResolvedFacts;
  readonly factsStatus?: "loading" | "ready" | "error";
  readonly submitting?: boolean;
  readonly errorMessage?: string;
  readonly onRoleChange?: (role: AgentRunRole) => void;
  readonly onSubmit: (values: AgentRunCreateFormValues) => void;
}) {
  const formId = useId();
  const allowed = props.facts?.allowedRoles ?? ["research"];
  const [role, setRole] = useState<AgentRunRole>(allowed[0] ?? "research");
  const [task, setTask] = useState("");
  const [includeParentContext, setIncludeParentContext] = useState(false);
  const selectedRole = allowed.includes(role) ? role : (allowed[0] ?? "research");

  if (props.posture === "off") {
    return (
      <p className="agent-run-create-form__disabled" role="status">
        Subagent creation posture is Off. Turn on Ask or Automatic in Settings → Agents to create a
        child.
      </p>
    );
  }

  if (props.factsStatus === "loading" && props.facts === undefined) {
    return (
      <p className="agent-run-create-form__disabled" role="status">
        Loading server-derived child facts…
      </p>
    );
  }

  return (
    <form
      aria-label="Create subagent"
      className="agent-run-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit({
          role: selectedRole,
          task,
          ...(includeParentContext ? { includeParentContext: true } : {}),
        });
      }}
    >
      <h3>New subagent</h3>
      {props.posture === "ask" ? (
        <p className="agent-run-create-form__hint">
          Creation posture is Ask: submitting this form is the explicit confirmation.
        </p>
      ) : null}
      {props.errorMessage === undefined ? null : (
        <p className="agent-run-create-form__error" role="alert">
          {props.errorMessage}
        </p>
      )}

      <label htmlFor={`${formId}-role`}>
        Role
        <select
          id={`${formId}-role`}
          value={selectedRole}
          onChange={(event) => {
            const next = event.target.value as AgentRunRole;
            setRole(next);
            props.onRoleChange?.(next);
          }}
        >
          {allowed.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor={`${formId}-task`}>
        Task
        <textarea
          id={`${formId}-task`}
          required
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={includeParentContext}
          onChange={(event) => setIncludeParentContext(event.target.checked)}
        />
        Include this thread&rsquo;s recent conversation
      </label>

      {props.facts === undefined ? null : <ResolvedFacts facts={props.facts} />}

      <button type="submit" disabled={props.submitting === true || props.facts === undefined}>
        {props.submitting === true ? "Creating…" : "Create subagent"}
      </button>
    </form>
  );
}

function ResolvedFacts(props: { readonly facts: AgentRunControlResolvedFacts }) {
  const facts = props.facts;
  return (
    <section aria-label="Resolved child facts" className="agent-run-create-form__facts">
      <h4>Resolved by the host</h4>
      <dl>
        <div>
          <dt>Mode</dt>
          <dd>{facts.mode}</dd>
        </div>
        {facts.projectId === undefined ? null : (
          <div>
            <dt>Project</dt>
            <dd>{String(facts.projectId)}</dd>
          </div>
        )}
        <div>
          <dt>Provider</dt>
          <dd>{String(facts.providerInstanceId)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{String(facts.modelId)}</dd>
        </div>
        {facts.reasoning === undefined ? null : (
          <div>
            <dt>Reasoning</dt>
            <dd>{facts.reasoning}</dd>
          </div>
        )}
        <div>
          <dt>Workspace</dt>
          <dd>{factLabel(facts.workspaceKind)}</dd>
        </div>
        <div>
          <dt>Maximum authority</dt>
          <dd>
            {facts.authority.executionPolicy}
            {facts.authority.filesystem ? " · filesystem" : ""}
            {facts.authority.shell ? " · shell" : ""}
            {facts.authority.git ? " · git" : ""}
          </dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>
            {facts.executionKind === "provider-native" ? "Provider-native" : "Octant-managed"}
          </dd>
        </div>
      </dl>
      {facts.nativeFallbackReason === undefined ? null : (
        <p className="agent-run-create-form__hint" role="status">
          Native execution is ineligible ({facts.nativeFallbackReason}). This child will run as
          Octant-managed.
        </p>
      )}
    </section>
  );
}
