import { useId, useState } from "react";
import type {
  AgentRunControlResolvedFacts,
  AgentRunCreationPosture,
  AgentRunRole,
} from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
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
        Helper agents are off. Choose another option under Settings → Octant Harness → Helper agents
        to create a child.
      </p>
    );
  }

  if (props.factsStatus === "loading" && props.facts === undefined) {
    return (
      <p className="agent-run-create-form__disabled" role="status">
        Checking what a subagent can use here…
      </p>
    );
  }

  return (
    <form
      aria-label="Create subagent"
      className="agent-run-create-form"
      noValidate
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
          Nothing starts until you create it; that is the confirmation.
        </p>
      ) : null}
      {props.errorMessage === undefined ? null : (
        <p className="agent-run-create-form__error" role="alert">
          {props.errorMessage}
        </p>
      )}

      <label htmlFor={`${formId}-role`}>
        Role
        <OctantSelectField
          id={`${formId}-role`}
          onValueChange={(value) => {
            const next = value as AgentRunRole;
            setRole(next);
            props.onRoleChange?.(next);
          }}
          options={allowed.map((value) => ({ id: value, label: ROLE_LABELS[value] }))}
          value={selectedRole}
        />
      </label>

      <label htmlFor={`${formId}-task`}>
        Task
        <OctantTextarea
          className="agent-run-create-form__task resize-none"
          id={`${formId}-task`}
          required
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
      </label>

      <label className="agent-run-create-form__context">
        <OctantCheckbox
          checked={includeParentContext}
          onChange={(event) => setIncludeParentContext(event.target.checked)}
        />
        Include this thread&rsquo;s recent conversation
      </label>

      {props.facts === undefined ? null : <ResolvedFacts facts={props.facts} />}

      <OctantButton type="submit" disabled={props.submitting === true || props.facts === undefined}>
        {props.submitting === true ? "Creating…" : "Create subagent"}
      </OctantButton>
    </form>
  );
}

/** What the subagent may do, in the words the access menus use. */
function accessLabel(authority: AgentRunControlResolvedFacts["authority"]): string {
  const policy =
    authority.executionPolicy === "plan"
      ? "Read only"
      : authority.executionPolicy === "approval-gated"
        ? "Asks first"
        : authority.executionPolicy === "auto-accept-edits"
          ? "Edits without asking"
          : "Full access";
  const reach = [
    authority.filesystem ? "files" : undefined,
    authority.shell ? "commands" : undefined,
    authority.git ? "Git" : undefined,
  ].filter((part): part is string => part !== undefined);
  return reach.length === 0 ? policy : `${policy} · ${reach.join(", ")}`;
}

/**
 * What the host resolved for a new subagent, folded under one line naming the
 * model and the workspace. It had been a second card of raw identifiers
 * (Project and provider ids, policy keys) open under every form.
 */
function ResolvedFacts(props: { readonly facts: AgentRunControlResolvedFacts }) {
  const facts = props.facts;
  const runsIn =
    facts.executionKind === "provider-native" ? "The provider itself" : "Octant-managed";
  return (
    <details className="agent-run-create-form__facts-disclosure">
      <summary>
        Runs on {String(facts.modelId)} · {factLabel(facts.workspaceKind)}
      </summary>
      <section aria-label="Resolved child facts" className="agent-run-create-form__facts">
        <dl>
          <div>
            <dt>Model</dt>
            <dd>
              {String(facts.modelId)}
              {facts.reasoning === undefined ? "" : ` · ${facts.reasoning}`}
            </dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{factLabel(facts.workspaceKind)}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{accessLabel(facts.authority)}</dd>
          </div>
          <div>
            <dt>Runs in</dt>
            <dd>{runsIn}</dd>
          </div>
        </dl>
        {facts.nativeFallbackReason === undefined ? null : (
          // The host's reason code stays out of the sentence; it names a
          // capability check, not something the person can act on.
          <p className="agent-run-create-form__hint" role="status">
            The provider can&rsquo;t run this subagent natively, so Octant runs it instead.
          </p>
        )}
      </section>
    </details>
  );
}
