import type {
  ProviderObservedActivity,
  ProviderObservedState,
  ProviderResumeQuality,
  ProviderRuntimeIntegration,
  ProviderToolTransport,
  ProviderToolsUnavailableReason,
} from "@octant/contracts";

/**
 * Three facts about a runtime that a picker mention cannot establish: whether
 * Octant's tools reach its session and how, what its session reports, and how
 * a follow-up continues. Every line is read from the integration the server
 * reported; with none reported this says nothing rather than guessing.
 */
export function ProviderRuntimeIntegrationFacts(props: {
  readonly instanceId: string;
  readonly observed: Pick<ProviderObservedState, "integration" | "verifiedToolModelIds">;
}) {
  const integration = props.observed.integration;
  if (integration === undefined) return null;
  const headingId = `integration-${props.instanceId}`;
  const tools = toolsFact(integration.tools, props.observed.verifiedToolModelIds?.length ?? 0);
  const activity = activityFact(integration.activity);
  const resume = resumeFact(integration.resume, integration.activity.source === "none");
  return (
    <section
      aria-labelledby={headingId}
      className="provider-details__section provider-details__section--integration"
    >
      <h4 className="oct-section-label" id={headingId}>
        Integration
      </h4>
      <p className="oct-row-detail">
        From the last connection check. Octant never writes this runtime’s MCP or hook
        configuration.
      </p>
      <dl>
        <IntegrationFact label="Octant tools" fact={tools} />
        <IntegrationFact label="Activity" fact={activity} />
        <IntegrationFact label="Resume" fact={resume} />
      </dl>
    </section>
  );
}

interface Fact {
  readonly value: string;
  readonly detail: string;
}

function IntegrationFact(props: { readonly label: string; readonly fact: Fact }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>
        <span className="provider-integration__value">{props.fact.value}</span>
        <span className="provider-integration__detail">{props.fact.detail}</span>
      </dd>
    </div>
  );
}

const TRANSPORT_LABELS: Readonly<Record<ProviderToolTransport, string>> = {
  "request-tool-calls": "tool calls in each request",
  "sdk-tool-server": "a tool server inside the SDK connection",
  "app-server-dynamic-tools": "dynamic tools on the app-server thread",
  "session-mcp-bridge": "a loopback MCP server registered for each session",
  "session-tool-bridge": "a loopback bridge the runtime’s extension calls for each session",
};

const UNAVAILABLE_REASONS: Readonly<Record<ProviderToolsUnavailableReason, string>> = {
  "not-confirmed": "The last connection check did not confirm them.",
  "model-verification-required": "Verify a model’s tools to offer them.",
  "runtime-not-confirmed": "This runtime’s version, platform, or setup did not confirm",
  "no-transport": "Octant has no way to offer its tools to this runtime.",
};

const NO_BROWSER_OR_COMPUTER = "Browser and Computer cannot be used here.";

function toolsFact(tools: ProviderRuntimeIntegration["tools"], verifiedModels: number): Fact {
  if (tools.status === "available") {
    return {
      value: "Available",
      detail: `Through ${TRANSPORT_LABELS[tools.transport]}. Browser and Computer reach the session this way.`,
    };
  }
  const through = tools.transport === undefined ? undefined : TRANSPORT_LABELS[tools.transport];
  if (tools.reason === "model-verification-required" && verifiedModels > 0) {
    return {
      value: "Verified models only",
      detail: `${verifiedModels} verified ${verifiedModels === 1 ? "model" : "models"}, through ${through ?? "tool calls"}. Other models are Chat only, without Browser or Computer.`,
    };
  }
  const reason =
    tools.reason === "runtime-not-confirmed"
      ? `${UNAVAILABLE_REASONS[tools.reason]} ${through ?? "its tool transport"}.`
      : UNAVAILABLE_REASONS[tools.reason];
  return { value: "Not available on this runtime", detail: `${reason} ${NO_BROWSER_OR_COMPUTER}` };
}

const ACTIVITY_LABELS: Readonly<Record<ProviderObservedActivity, string>> = {
  replies: "replies",
  "tool-calls": "tool calls",
  approvals: "approvals",
  "file-changes": "file changes",
  "task-progress": "task progress",
};

function activityFact(activity: ProviderRuntimeIntegration["activity"]): Fact {
  if (activity.source === "none") {
    return { value: "Nothing observed", detail: "No session runs on this runtime here." };
  }
  const listed = listJoin(activity.observes.map((value) => ACTIVITY_LABELS[value]));
  return {
    value: "Session events",
    detail: `${capitalize(listed)}, as the live session reports them.`,
  };
}

function resumeFact(resume: ProviderResumeQuality, noSession: boolean): Fact {
  if (resume === "precise") {
    return { value: "Precise", detail: "A follow-up reopens the runtime’s own session." };
  }
  if (resume === "best-effort") {
    return {
      value: "Best effort",
      detail:
        "The endpoint keeps no session, so Octant sends the thread’s history again, fitted to the model’s context window.",
    };
  }
  // A runtime that is not running here may resume fine once it starts; saying
  // it cannot would claim more than a failed check established.
  return {
    value: "None",
    detail: noSession
      ? "No session runs on this runtime here, so there is none to reopen."
      : "This runtime cannot reopen an earlier session.",
  };
}

function listJoin(values: ReadonlyArray<string>): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
