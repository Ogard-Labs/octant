import { sameToolActionAuthority, type ValidationEvidenceRequest } from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { ValidationEvidenceLoadResult } from "../validationEvidenceRoutes";
import {
  readValidationEvidenceSequence,
  readValidationEvidenceSnapshot,
} from "./validationEvidenceProjection";

/**
 * Create a store-backed snapshot loader for the validation evidence route.
 * The loader enforces authority scoping and cursor validity before returning
 * evidence, and never treats unknown data as success.
 *
 * Authority scoping: the projection is indexed by authority fields, so the
 * query only returns evidence whose stored authority matches the request
 * authority. When no evidence exists, the loader returns an honest
 * `unavailable` failure rather than fabricating an empty success.
 *
 * Cursor validity: when `afterSequence` is provided, the loader rejects
 * cursors that point beyond the current journal projection head with
 * distinct `stale` and `superseded` failures without content-derived
 * metadata leakage.
 */
export function createValidationEvidenceLoader(dependencies: {
  readonly connection: SqliteConnection;
  readonly clock: () => string;
}): (request: ValidationEvidenceRequest) => ValidationEvidenceLoadResult {
  return (request) => {
    const snapshot = readValidationEvidenceSnapshot(
      dependencies.connection,
      request.authority,
      dependencies.clock(),
    );

    if (snapshot === undefined) {
      return {
        kind: "failure",
        failure: {
          category: "missing",
          message: "No validation evidence is available for this thread, run, or action scope.",
        },
      };
    }

    // Authority scoping: the projected snapshot authority must match the
    // request authority exactly. This is enforced by the projection query,
    // but we re-check here to fail closed at the boundary.
    if (!sameToolActionAuthority(snapshot.authority, request.authority)) {
      return {
        kind: "failure",
        failure: {
          category: "unauthorized",
          message: "Validation evidence authority does not match the request scope.",
        },
      };
    }

    if (request.planId !== undefined && snapshot.plan?.planId !== request.planId) {
      return {
        kind: "failure",
        failure: {
          category: "superseded",
          message: "Validation evidence belongs to a newer validation run.",
        },
      };
    }

    if (request.afterSequence !== undefined && request.afterSequence > snapshot.sequence) {
      return {
        kind: "failure",
        failure: {
          category: "stale",
          message: "Validation evidence cursor is stale for this authority scope.",
        },
      };
    }

    return { kind: "snapshot", snapshot };
  };
}

export { readValidationEvidenceSequence };
