import { randomUUID } from "node:crypto";
import type { WindowId } from "@octant/contracts";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createUsageRouteHandler } from "../usageRoutes";
import { SpendCeilingService } from "../spendCeilingService";
import { createSpendCeilingRouteHandler } from "../spendCeilingRoutes";
import { createUsageDashboardRouteHandler } from "../usageDashboardRoutes";
import { resolveWindowProjectScope, type UsageProjectScope } from "../usageProjectScope";
import { createDiagnosticsExportRouteHandler } from "../diagnosticsExportRoutes";
import { createValidationEvidenceRouteHandler } from "../validationEvidenceRoutes";
import { createValidationEvidenceLoader } from "../validation/validationEvidenceLoader";
import { ValidationEventStore } from "../validation/validationEventStore";
import { ZenEventStore } from "../zen/zenEventStore";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";

export type UsageDependencies = Pick<ServerStart, "latencyStats" | "persistence" | "version"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "spendCeilingHolder" | "turnMetrics"> &
  Pick<IntegrationsWiring, "cacheStats">;

export function wireUsage(deps: UsageDependencies) {
  const {
    cacheStats,
    latencyStats,
    persistence,
    spendCeilingHolder,
    turnMetrics,
    version,
    windowAuthorityStore,
  } = deps;

  const zenEventStore = new ZenEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  // Same shape as the Goal and AgentRun checks: read the window's own
  // workspace, never a scope the caller supplied. Every usage surface —
  // dashboard, query, and export — shares this one resolver so they cannot
  // disagree about what a window may see.
  const readWindowUsageProjectScope = (windowId: WindowId): UsageProjectScope =>
    resolveWindowProjectScope(persistence.readWindowWorkspace(windowId)?.workspace);
  const spendCeilingRoutes = createSpendCeilingRouteHandler({
    service: {
      snapshot: (input) => spendCeilingHolder.service!.snapshot(input),
      execute: (principal, command) => spendCeilingHolder.service!.execute(principal, command),
    } as SpendCeilingService,
    windowAuthorityStore,
  });
  const usageDashboardRoutes = createUsageDashboardRouteHandler({
    connection: persistence.connection,
    windowAuthorityStore,
    readWindowProjectScope: readWindowUsageProjectScope,
    cacheStats,
    latencyStats: () => latencyStats.read(),
  });
  const usageRoutes = createUsageRouteHandler({
    connection: persistence.connection,
    windowAuthorityStore,
    readWindowProjectScope: readWindowUsageProjectScope,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    latencyStats: () => latencyStats.read(),
    turnMetrics,
  });
  const diagnosticsExportRoutes = createDiagnosticsExportRouteHandler({
    connection: persistence.connection,
    journal: persistence.journal,
    windowAuthorityStore,
    octantVersion: version,
  });
  const validationEvidenceRoutes = createValidationEvidenceRouteHandler({
    windowAuthorityStore,
    authorize: (windowId, authority) => {
      const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
      const context = workspace?.contextByMode[authority.mode];
      return (
        context !== undefined &&
        context.projectId === authority.projectId &&
        String(context.host) === String(authority.hostId)
      );
    },
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    loadSnapshot: createValidationEvidenceLoader({
      connection: persistence.connection,
      clock: () => new Date().toISOString(),
    }),
  });
  const validationEventStore = new ValidationEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  return {
    diagnosticsExportRoutes,
    spendCeilingRoutes,
    usageDashboardRoutes,
    usageRoutes,
    validationEventStore,
    validationEvidenceRoutes,
    zenEventStore,
  };
}

export type UsageWiring = ReturnType<typeof wireUsage>;
