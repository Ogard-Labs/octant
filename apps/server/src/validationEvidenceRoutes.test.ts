import { describe, expect, it } from "vitest";
import { createValidationEvidenceRouteHandler } from "./validationEvidenceRoutes";
import type { ValidationEvidenceLoadResult } from "./validationEvidenceRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";
import { WindowAuthorityError } from "./windowAuthorityStore";
import type { ValidationCompositionFailure } from "@octant/contracts/validation-composition";
import type { ValidationEvidenceSnapshot } from "@octant/contracts/validation-rpc";

function makeStore(ok = true): WindowAuthorityStore {
  return {
    authenticate: () => {
      if (!ok) throw new WindowAuthorityError("unauthorized", "nope");
      return "window-1";
    },
  } as unknown as WindowAuthorityStore;
}

function makeRequest(
  path: string,
  options: { method?: string; body?: unknown; origin?: string; capability?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "x-octant-window-capability": options.capability ?? "test-capability",
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const authority = {
  hostId: "00000000-0000-0000-0000-000000000001",
  mode: "code",
  projectId: "00000000-0000-0000-0000-000000000002",
  providerInstanceId: "00000000-0000-0000-0000-000000000003",
  extension: { kind: "core" },
};

const mismatchedAuthority = {
  hostId: "00000000-0000-0000-0000-000000000021",
  mode: "code",
  projectId: "00000000-0000-0000-0000-000000000022",
  providerInstanceId: "00000000-0000-0000-0000-000000000023",
  extension: { kind: "core" },
};

const validBody = { authority };
const authorize = async () => true;

function makeSnapshot(
  auth = authority,
  overrides: Partial<ValidationEvidenceSnapshot> = {},
): ValidationEvidenceSnapshot {
  return {
    authority: auth,
    sequence: 5,
    snapshotAt: "2026-07-25T10:00:00.000Z",
    timeline: [],
    steps: [],
    overallOutcome: "unavailable",
    ...overrides,
  } as unknown as ValidationEvidenceSnapshot;
}

function snapshotResult(snapshot: ValidationEvidenceSnapshot): ValidationEvidenceLoadResult {
  return { kind: "snapshot", snapshot };
}

function failureResult(
  category: ValidationCompositionFailure["category"],
  message: string,
): ValidationEvidenceLoadResult {
  return { kind: "failure", failure: { category, message } };
}

describe("validationEvidenceRoutes", () => {
  it("returns undefined for non-matching paths", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
    });
    expect(await handler(makeRequest("/api/usage/query"))).toBeUndefined();
  });

  it("rejects unauthorized requests", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(false),
      authorize,
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    expect(response?.status).toBe(401);
  });

  it("rejects an authenticated window that cannot access the requested evidence scope", async () => {
    let loaded = false;
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize: async () => false,
      loadSnapshot: async () => {
        loaded = true;
        return snapshotResult(makeSnapshot());
      },
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    expect(response?.status).toBe(401);
    expect(loaded).toBe(false);
  });

  it("fails closed with unavailable when no evidence store is wired", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    expect(response?.status).toBe(503);
    const body = await response!.json();
    expect(body.category).toBe("unavailable");
  });

  it("returns a store snapshot when loadSnapshot provides one", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
      loadSnapshot: async () => snapshotResult(makeSnapshot()),
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.overallOutcome).toBe("unavailable");
  });

  it("returns unauthorized when the loader reports an authority mismatch", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
      loadSnapshot: async () => failureResult("unauthorized", "authority mismatch"),
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    expect(response?.status).toBe(401);
    const body = await response!.json();
    expect(body.category).toBe("unauthorized");
  });

  it.each([
    ["missing", 404],
    ["stale", 409],
    ["superseded", 409],
  ] as const)("returns distinct %s failures", async (category, status) => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
      loadSnapshot: async () => failureResult(category, `${category} evidence`),
    });
    const response = await handler(
      makeRequest("/api/validation/evidence", { body: { ...validBody, afterSequence: 99 } }),
    );
    expect(response?.status).toBe(status);
    const body = await response!.json();
    expect(body.category).toBe(category);
  });

  it("returns unavailable when the loader reports no evidence", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
      loadSnapshot: async () => failureResult("unavailable", "no evidence"),
    });
    const response = await handler(
      makeRequest("/api/validation/evidence", { body: { authority: mismatchedAuthority } }),
    );
    expect(response?.status).toBe(503);
    const body = await response!.json();
    expect(body.category).toBe("unavailable");
  });

  it("does not fabricate success when the snapshot has no evidence", async () => {
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
      loadSnapshot: async () =>
        snapshotResult(
          makeSnapshot(undefined, {
            overallOutcome: "unavailable",
            timeline: [],
            steps: [],
          } as unknown as ValidationEvidenceSnapshot),
        ),
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.overallOutcome).toBe("unavailable");
    expect(body.timeline).toHaveLength(0);
  });

  it("never returns raw filesystem paths, prompt bodies, or credentials in the response", async () => {
    const snapshot = makeSnapshot(undefined, {
      timeline: [
        {
          sequence: 5,
          correlationId: "00000000-0000-4000-8000-000000000012",
          evidenceId: "00000000-0000-4000-8000-000000000010",
          planId: "00000000-0000-4000-8000-000000000011",
          stepId: "step-1",
          outcome: "passed",
          sourceKind: "repository-test",
          sourceReference: "opaque-token-abc",
          redacted: true,
          observedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
    } as unknown as ValidationEvidenceSnapshot);
    const handler = createValidationEvidenceRouteHandler({
      windowAuthorityStore: makeStore(),
      authorize,
      loadSnapshot: async () => snapshotResult(snapshot),
    });
    const response = await handler(makeRequest("/api/validation/evidence", { body: validBody }));
    const json = await response!.text();
    expect(json).not.toContain("/Users/");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("password");
    expect(json).not.toContain("Bearer ");
  });
});
