import { createHash } from "node:crypto";
import type { IntegrationEventSourceProvider } from "@octant/plugin-api/integration";
import type { AutomationIntegrationEvent, UtcTimestamp } from "@octant/contracts";
import type { McpServerSignIn } from "./mcpServerSignIn";

/** The integration adapter alone knows the broker's repository/run metadata vocabulary. */
export function githubRoutineEventSources(
  signIns: () =>
    | Pick<McpServerSignIn, "githubActionsConnections" | "bindGithubActionsSource">
    | undefined,
): IntegrationEventSourceProvider {
  return {
    choices: async () =>
      ((await signIns()?.githubActionsConnections()) ?? []).map((connection) => ({
        integrationId: connection.extensionId,
        sourceId: connection.componentId,
        label: connection.label,
        fields: [
          { id: "owner", label: "Repository owner", required: true },
          { id: "repository", label: "Repository name", required: true },
          { id: "workflow", label: "Workflow number (optional)", required: false },
          { id: "branch", label: "Branch (optional)", required: false },
          {
            id: "conclusions",
            label: "Conclusions (comma separated, optional)",
            required: false,
            placeholder: "failure, timed_out",
          },
        ],
      })),
    bind: async (selection, signal) => {
      if (
        signal.aborted ||
        Object.keys(selection.filters).some(
          (key) => !["owner", "repository", "workflow", "branch", "conclusions"].includes(key),
        )
      )
        return undefined;
      const workflow = selection.filters.workflow?.trim();
      if (workflow !== undefined && workflow !== "" && !/^[1-9]\d{0,14}$/.test(workflow))
        return undefined;
      const conclusions = (selection.filters.conclusions ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .sort();
      if (
        conclusions.some(
          (part) =>
            ![
              "success",
              "failure",
              "neutral",
              "cancelled",
              "skipped",
              "timed_out",
              "action_required",
              "stale",
              "startup_failure",
            ].includes(part),
        )
      )
        return undefined;
      const host = signIns();
      const source = await host?.bindGithubActionsSource(
        selection.integrationId,
        selection.sourceId,
        {
          owner: selection.filters.owner?.trim() ?? "",
          name: selection.filters.repository?.trim() ?? "",
        },
      );
      if (source === undefined || signal.aborted || !source.current()) return undefined;
      const branch = selection.filters.branch?.trim();
      const identity = createHash("sha256")
        .update(
          JSON.stringify([
            selection.integrationId,
            selection.sourceId,
            source.accountId,
            source.repository,
            workflow ?? "",
            branch ?? "",
            conclusions,
          ]),
        )
        .digest("hex");
      if (selection.sourceIdentity !== undefined && selection.sourceIdentity !== identity)
        return undefined;
      return {
        identity,
        label: `Recent completed CI in ${source.repository.owner}/${source.repository.name} (latest 100)`,
        semantics: "append",
        current: () => signIns() === host && source.current(),
        read: async (pollSignal) => {
          const events: AutomationIntegrationEvent[] = [];
          if (pollSignal.aborted || !source.current())
            return { kind: "unavailable", reason: "source-unavailable" };
          const result = await source.runs({
            page: 1,
            ...(workflow === undefined || workflow === "" ? {} : { workflowId: Number(workflow) }),
            ...(branch === undefined || branch === "" ? {} : { branch }),
          });
          if (result.kind !== "page")
            return {
              kind: "unavailable",
              reason: "source-unavailable",
              ...(result.kind === "refused" && result.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: result.retryAfterSeconds }
                : {}),
            };
          for (const run of result.runs) {
            if (conclusions.length > 0 && !conclusions.includes(run.conclusion)) continue;
            events.push({
              id: `${source.repository.id}:${run.id}:${run.attempt}`,
              label: `CI ${run.id}, attempt ${run.attempt}: ${run.conclusion}`,
              occurredAt: run.updatedAt as UtcTimestamp,
              url: run.url,
              data: JSON.stringify({
                repository: `${source.repository.owner}/${source.repository.name}`,
                workflowId: run.workflowId,
                runId: run.id,
                attempt: run.attempt,
                headSha: run.headSha,
                branch: run.branch,
                conclusion: run.conclusion,
              }),
              routineOutput: run.branch?.startsWith("automation/") === true,
            });
          }
          if (events.length > 256) return { kind: "unavailable", reason: "source-limit" };
          return { kind: "complete", events };
        },
      };
    },
  };
}
