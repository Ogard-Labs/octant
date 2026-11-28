import { createHash } from "node:crypto";
import { Schema } from "effect";
import { AutomationIntegrationEvent } from "@octant/contracts";
import {
  decodeLinearIssueFilterOptions,
  LINEAR_ISSUE_FILTERS_OPERATION,
} from "@octant/contracts/linear-issues";
import type { IntegrationEventSourceProvider } from "@octant/plugin-api/integration";
import type { IntegrationService } from "../../integration/integrationService";
import { LINEAR_ASSIGNMENT_SOURCE_OPERATION } from "./linearAssignmentSource";

const observation = Schema.Struct({
  identity: Schema.Trimmed.check(Schema.isNonEmpty()),
  label: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(256))),
  events: Schema.Array(AutomationIntegrationEvent).pipe(Schema.check(Schema.isMaxLength(256))),
});

export function linearRoutineEventSources(
  service: Pick<IntegrationService, "snapshot" | "executeOperation" | "connectionRevision">,
  effective: () => boolean,
): IntegrationEventSourceProvider {
  return {
    choices: async () => {
      if (!effective()) return [];
      const snapshot = await service.snapshot("linear", AbortSignal.timeout(10_000));
      if (snapshot.state !== "ready") return [];
      let teamOptions: ReadonlyArray<{ readonly value: string; readonly label: string }> = [];
      let projectOptions: ReadonlyArray<{ readonly value: string; readonly label: string }> = [];
      try {
        const filtersResult = await service.executeOperation(
          "linear",
          { kind: "operation", operationId: LINEAR_ISSUE_FILTERS_OPERATION, input: {} },
          AbortSignal.timeout(10_000),
        );
        if (filtersResult.kind === "ok") {
          const decoded = decodeLinearIssueFilterOptions(filtersResult.value);
          teamOptions = decoded.teams.flatMap((team) =>
            team.key === undefined ? [] : [{ value: team.key, label: team.label }],
          );
          projectOptions = decoded.projects.map((project) => ({
            value: project.id,
            label: project.label,
          }));
        }
      } catch {
        // Filter options are an affordance; keep free-text entry available when unavailable.
      }
      return [
        {
          integrationId: "linear",
          sourceId: "assigned-to-me",
          label: `Linear assignments (${snapshot.account?.login ?? "connected account"})`,
          fields: [
            {
              id: "team",
              label: "Team key (optional)",
              required: false,
              placeholder: "ENG",
              ...(teamOptions.length === 0 ? {} : { options: teamOptions }),
            },
            {
              id: "project",
              label: "Project identifier (optional)",
              required: false,
              ...(projectOptions.length === 0 ? {} : { options: projectOptions }),
            },
          ],
        },
      ];
    },
    bind: async (selection, signal) => {
      if (
        selection.integrationId !== "linear" ||
        selection.sourceId !== "assigned-to-me" ||
        !effective() ||
        signal.aborted ||
        service.connectionRevision === undefined
      )
        return undefined;
      const revision = service.connectionRevision();
      const current = () => effective() && service.connectionRevision?.() === revision;
      const read = async (readSignal: AbortSignal) => {
        if (!current() || readSignal.aborted) return undefined;
        const result = await service.executeOperation(
          "linear",
          {
            kind: "operation",
            operationId: LINEAR_ASSIGNMENT_SOURCE_OPERATION,
            input: selection.filters,
          },
          readSignal,
        );
        if (result.kind !== "ok" || !current() || readSignal.aborted) return undefined;
        try {
          return Schema.decodeUnknownSync(observation)(result.value);
        } catch {
          return undefined;
        }
      };
      let cached = await read(signal);
      if (cached === undefined) return undefined;
      const account = cached.identity;
      const identity = createHash("sha256")
        .update(
          JSON.stringify([
            "linear",
            account,
            Object.entries(selection.filters).sort(([a], [b]) => a.localeCompare(b)),
          ]),
        )
        .digest("hex");
      if (selection.sourceIdentity !== undefined && selection.sourceIdentity !== identity)
        return undefined;
      return {
        identity,
        label: cached.label,
        semantics: "assignment-set",
        current,
        read: async (readSignal) => {
          const result = cached ?? (await read(readSignal));
          cached = undefined;
          if (
            result === undefined ||
            result.identity !== account ||
            !current() ||
            readSignal.aborted
          )
            return { kind: "unavailable", reason: "source-unavailable" };
          return { kind: "complete", events: result.events };
        },
      };
    },
  };
}
