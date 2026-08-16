import { useId, useState } from "react";
import type { AgentRunCreationPosture, AgentRunRole } from "@octant/contracts/agent-run";
import type { ProviderExecutionPolicy, PermissionPersistence } from "@octant/contracts/providers";
import "./agent-hierarchy.css";

export interface AgentRunCreateFormValues {
  readonly role: AgentRunRole;
  readonly task: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly reasoning?: string;
  /**
   * Ask the host to admit this child with the parent thread's own recent
   * conversation. The form carries the ask only; the content is read and
   * bounded server-side from the parent thread the host already authorized.
   */
  readonly includeParentContext?: boolean;
  readonly authority: {
    readonly filesystem: boolean;
    readonly shell: boolean;
    readonly git: boolean;
    readonly network: boolean;
    readonly tools: boolean;
    readonly subagents: boolean;
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly permissionPersistence: PermissionPersistence;
  };
}

const ROLES: ReadonlyArray<AgentRunRole> = ["research"];
const EXECUTION_POLICIES: ReadonlyArray<ProviderExecutionPolicy> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
  "full-access",
];

/**
 * Explicit one-off child-creation form. Only chat-workspace
 * children are offered here: Work requires a bound project root and Code
 * requires a verified isolated worktree, neither of which this component has
 * access to, so both remain deferred rather than half-wired.
 *
 * The requested authority facts shown here are a *proposal* only — the
 * server always clamps them against the parent's authority ceiling
 * (`clampAgentRunAuthority`) before a run is admitted, so this form can never
 * widen authority no matter what a caller selects.
 */
export function AgentRunCreateForm(props: {
  readonly posture: AgentRunCreationPosture;
  readonly submitting?: boolean;
  readonly errorMessage?: string;
  readonly onSubmit: (values: AgentRunCreateFormValues) => void;
}) {
  const formId = useId();
  const [role, setRole] = useState<AgentRunRole>("research");
  const [task, setTask] = useState("");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [includeParentContext, setIncludeParentContext] = useState(false);
  const [filesystem, setFilesystem] = useState(false);
  const [shell, setShell] = useState(false);
  const [git, setGit] = useState(false);
  const [network, setNetwork] = useState(false);
  const [tools, setTools] = useState(true);
  const [subagents, setSubagents] = useState(false);
  const [executionPolicy, setExecutionPolicy] = useState<ProviderExecutionPolicy>("plan");
  const [permissionPersistence, setPermissionPersistence] =
    useState<PermissionPersistence>("current-session");

  if (props.posture === "off") {
    return (
      <p className="agent-run-create-form__disabled" role="status">
        Subagent creation posture is Off. Turn on Ask or Automatic in Settings → Agents to create a
        child.
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
          role,
          task,
          providerInstanceId,
          modelId,
          ...(reasoning.trim().length === 0 ? {} : { reasoning: reasoning.trim() }),
          ...(includeParentContext ? { includeParentContext: true } : {}),
          authority: {
            filesystem,
            shell,
            git,
            network,
            tools,
            subagents,
            executionPolicy,
            permissionPersistence,
          },
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
          value={role}
          onChange={(event) => setRole(event.target.value as AgentRunRole)}
        >
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {value}
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

      <label htmlFor={`${formId}-provider`}>
        Provider instance ID
        <input
          id={`${formId}-provider`}
          required
          value={providerInstanceId}
          onChange={(event) => setProviderInstanceId(event.target.value)}
        />
      </label>

      <label htmlFor={`${formId}-model`}>
        Model ID
        <input
          id={`${formId}-model`}
          required
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        />
      </label>

      <label htmlFor={`${formId}-reasoning`}>
        Reasoning (optional)
        <input
          id={`${formId}-reasoning`}
          value={reasoning}
          onChange={(event) => setReasoning(event.target.value)}
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

      <fieldset>
        <legend>Requested authority (clamped server-side, never widened)</legend>
        <label>
          <input
            type="checkbox"
            checked={filesystem}
            onChange={(event) => setFilesystem(event.target.checked)}
          />
          Filesystem
        </label>
        <label>
          <input
            type="checkbox"
            checked={shell}
            onChange={(event) => setShell(event.target.checked)}
          />
          Shell
        </label>
        <label>
          <input type="checkbox" checked={git} onChange={(event) => setGit(event.target.checked)} />
          Git
        </label>
        <label>
          <input
            type="checkbox"
            checked={network}
            onChange={(event) => setNetwork(event.target.checked)}
          />
          Network
        </label>
        <label>
          <input
            type="checkbox"
            checked={tools}
            onChange={(event) => setTools(event.target.checked)}
          />
          Tools
        </label>
        <label>
          <input
            type="checkbox"
            checked={subagents}
            onChange={(event) => setSubagents(event.target.checked)}
          />
          Subagents
        </label>
      </fieldset>

      <label htmlFor={`${formId}-execution-policy`}>
        Execution policy
        <select
          id={`${formId}-execution-policy`}
          value={executionPolicy}
          onChange={(event) => setExecutionPolicy(event.target.value as ProviderExecutionPolicy)}
        >
          {EXECUTION_POLICIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor={`${formId}-permission-persistence`}>
        Permission persistence
        <select
          id={`${formId}-permission-persistence`}
          value={permissionPersistence}
          onChange={(event) =>
            setPermissionPersistence(event.target.value as PermissionPersistence)
          }
        >
          <option value="current-session">current-session</option>
          <option value="project-default">project-default</option>
        </select>
      </label>

      <button type="submit" disabled={props.submitting === true}>
        {props.submitting === true ? "Creating…" : "Create subagent"}
      </button>
    </form>
  );
}
