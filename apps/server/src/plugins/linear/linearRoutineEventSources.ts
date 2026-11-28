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

const ASSIGNED_SOURCE_ID = "assigned-to-me";
const ASSIGNED_SOURCE_PREFIX = `${ASSIGNED_SOURCE_ID}:`;

const observation = Schema.Struct({
  identity: Schema.NonEmptyTrimmedString,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  events: Schema.Array(AutomationIntegrationEvent).pipe(Schema.maxItems(256)),
});

type RoutineIntegrationService = Pick<
  IntegrationService,
  "snapshot" | "accountsSnapshot" | "storedAccounts" | "executeOperation" | "connectionRevision"
>;

export function linearRoutineEventSources(
  service: RoutineIntegrationService,
  effective: () => boolean,
): IntegrationEventSourceProvider {
  return {
    choices: async () => {
      if (!effective()) return [];
      const accountsSnapshot =
        service.accountsSnapshot === undefined
          ? undefined
          : await service.accountsSnapshot("linear", AbortSignal.timeout(10_000));
      if (accountsSnapshot !== undefined) {
        const ready = accountsSnapshot.accounts.filter((entry) => entry.state === "ready");
        if (ready.length === 0) return [];
        const single = ready.length === 1;
        return Promise.all(
          ready.map(async (entry) => {
            const filters = await loadFilterChoices(service, entry.accountRef);
            const workspaceLabel =
              entry.account?.workspace ?? entry.account?.login ?? "connected account";
            return {
              integrationId: "linear",
              sourceId:
                single && entry.isLegacy === true
                  ? ASSIGNED_SOURCE_ID
                  : `${ASSIGNED_SOURCE_PREFIX}${entry.accountRef}`,
              label: `Linear assignments (${workspaceLabel})`,
              fields: filterFields(filters.teamOptions, filters.projectOptions),
            };
          }),
        );
      }

      const snapshot = await service.snapshot("linear", AbortSignal.timeout(10_000));
      if (snapshot.state !== "ready") return [];
      const filters = await loadFilterChoices(service, undefined);
      return [
        {
          integrationId: "linear",
          sourceId: ASSIGNED_SOURCE_ID,
          label: `Linear assignments (${snapshot.account?.login ?? "connected account"})`,
          fields: filterFields(filters.teamOptions, filters.projectOptions),
        },
      ];
    },
    bind: async (selection, signal) => {
      if (
        selection.integrationId !== "linear" ||
        !effective() ||
        signal.aborted ||
        service.connectionRevision === undefined
      ) {
        return undefined;
      }
      const parsedSource = parseLinearAssignmentSourceId(selection.sourceId);
      if (parsedSource === undefined) return undefined;

      const resolvedAccount = resolveRoutineAccountRef(service, parsedSource.accountRef, selection);
      if (resolvedAccount.kind === "none") return undefined;
      const targetAccountRef = resolvedAccount.accountRef;

      const revision = service.connectionRevision(targetAccountRef);
      const current = () =>
        effective() && service.connectionRevision?.(targetAccountRef) === revision;
      const read = async (readSignal: AbortSignal) => {
        if (!current() || readSignal.aborted) return undefined;
        const result = await service.executeOperation(
          "linear",
          {
            kind: "operation",
            operationId: LINEAR_ASSIGNMENT_SOURCE_OPERATION,
            input: selection.filters,
            ...(targetAccountRef === undefined ? {} : { accountRef: targetAccountRef }),
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
      const identity = computeLinearRoutineIdentity(account, selection.filters);
      if (selection.sourceIdentity !== undefined && selection.sourceIdentity !== identity) {
        return undefined;
      }
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
          ) {
            return { kind: "unavailable", reason: "source-unavailable" };
          }
          return { kind: "complete", events: result.events };
        },
      };
    },
  };
}

function parseLinearAssignmentSourceId(
  sourceId: string,
): { readonly accountRef?: string } | undefined {
  if (sourceId === ASSIGNED_SOURCE_ID) return {};
  if (!sourceId.startsWith(ASSIGNED_SOURCE_PREFIX)) return undefined;
  const accountRef = sourceId.slice(ASSIGNED_SOURCE_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(accountRef) ? { accountRef } : undefined;
}

function resolveRoutineAccountRef(
  service: RoutineIntegrationService,
  explicitAccountRef: string | undefined,
  selection: {
    readonly filters: Readonly<Record<string, string>>;
    readonly sourceIdentity?: string | undefined;
  },
): { readonly kind: "use"; readonly accountRef: string | undefined } | { readonly kind: "none" } {
  if (explicitAccountRef !== undefined) {
    return { kind: "use", accountRef: explicitAccountRef };
  }
  const stored = service.storedAccounts?.("linear");
  if (stored === undefined) {
    return { kind: "use", accountRef: undefined };
  }
  if (selection.sourceIdentity !== undefined) {
    // Match the routine's stored `(viewer, workspace)` identity against known
    // accounts locally so we read ONLY the matching account and never probe others.
    for (const account of stored) {
      if (account.viewerId === undefined || account.workspaceId === undefined) continue;
      const candidate = JSON.stringify([account.viewerId, account.workspaceId]);
      if (computeLinearRoutineIdentity(candidate, selection.filters) === selection.sourceIdentity) {
        return { kind: "use", accountRef: account.accountRef };
      }
    }
    // Before a migrated legacy account has completed its first identity read,
    // allow binding only against that legacy account so its identity can be verified.
    const unidentifiedLegacy = stored.find(
      (account) =>
        account.isLegacy && (account.viewerId === undefined || account.workspaceId === undefined),
    );
    if (unidentifiedLegacy !== undefined) {
      return { kind: "use", accountRef: unidentifiedLegacy.accountRef };
    }
    return { kind: "none" };
  }
  const legacy = stored.find((account) => account.isLegacy);
  if (legacy !== undefined) return { kind: "use", accountRef: legacy.accountRef };
  return stored.length === 1
    ? { kind: "use", accountRef: stored[0]?.accountRef }
    : { kind: "none" };
}

function computeLinearRoutineIdentity(
  accountIdentity: string,
  filters: Readonly<Record<string, string>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "linear",
        accountIdentity,
        Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

async function loadFilterChoices(
  service: RoutineIntegrationService,
  accountRef: string | undefined,
): Promise<{
  readonly teamOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly projectOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}> {
  try {
    const filtersResult = await service.executeOperation(
      "linear",
      {
        kind: "operation",
        operationId: LINEAR_ISSUE_FILTERS_OPERATION,
        input: {},
        ...(accountRef === undefined ? {} : { accountRef }),
      },
      AbortSignal.timeout(10_000),
    );
    if (filtersResult.kind === "ok") {
      const decoded = decodeLinearIssueFilterOptions(filtersResult.value);
      return {
        teamOptions: decoded.teams.flatMap((team) =>
          team.key === undefined ? [] : [{ value: team.key, label: team.label }],
        ),
        projectOptions: decoded.projects.map((project) => ({
          value: project.id,
          label: project.label,
        })),
      };
    }
  } catch {
    // Filter options are an affordance; keep free-text entry available when unavailable.
  }
  return { teamOptions: [], projectOptions: [] };
}

function filterFields(
  teamOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  projectOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>,
) {
  return [
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
  ];
}
