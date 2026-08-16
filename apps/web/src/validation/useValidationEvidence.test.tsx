import { describe, expect, it, vi } from "vitest";
import { render, renderHook, waitFor } from "@testing-library/react";
import {
  createValidationEvidenceClient,
  ValidationEvidenceClientFailure,
  type ValidationEvidenceClient,
} from "@octant/client-runtime/validation-evidence-client";
import type {
  ValidationEvidenceRequest,
  ValidationEvidenceSnapshot,
} from "@octant/contracts/validation-rpc";
import { ValidationEvidencePane } from "./ValidationEvidencePane";
import { useValidationEvidence } from "./useValidationEvidence";

const authority = {
  hostId: "00000000-0000-0000-0000-000000000001",
  mode: "code" as const,
  projectId: "00000000-0000-0000-0000-000000000002",
  providerInstanceId: "00000000-0000-0000-0000-000000000003",
  extension: { kind: "core" as const },
};

const request: ValidationEvidenceRequest = {
  authority: authority as ValidationEvidenceRequest["authority"],
};

function makeSnapshot(
  overrides: Partial<ValidationEvidenceSnapshot> = {},
): ValidationEvidenceSnapshot {
  return {
    authority,
    sequence: 1,
    snapshotAt: "2026-07-25T10:00:00.000Z",
    timeline: [],
    steps: [],
    overallOutcome: "unavailable",
    ...overrides,
  } as unknown as ValidationEvidenceSnapshot;
}

function mockFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

function makeClient(fetch: typeof globalThis.fetch): ValidationEvidenceClient {
  return createValidationEvidenceClient({
    baseUrl: "http://127.0.0.1:3000",
    fetch,
    windowCapability: "test-cap",
  });
}

describe("useValidationEvidence", () => {
  it("renders loading initially then ready with a snapshot", async () => {
    const snapshot = makeSnapshot({
      timeline: [
        {
          sequence: 2 as never,
          correlationId: "00000000-0000-4000-8000-000000000012" as never,
          evidenceId: "00000000-0000-4000-8000-000000000010" as never,
          planId: "00000000-0000-4000-8000-000000000011" as never,
          stepId: "step-1",
          outcome: "passed",
          sourceKind: "repository-test",
          sourceReference: "opaque-token-abc",
          redacted: false,
          observedAt: "2026-07-25T10:00:00.000Z" as never,
        },
      ],
      steps: [
        {
          stepId: "step-1",
          description: "Run tests",
          outcome: "passed",
          evidenceCount: 1,
          sourceKinds: ["repository-test"],
        },
      ],
      overallOutcome: "passed",
    });
    const client = makeClient(mockFetch(snapshot));
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshot?.overallOutcome).toBe("passed");
  });

  it("renders unavailable when the snapshot has no evidence", async () => {
    const client = makeClient(mockFetch(makeSnapshot({ overallOutcome: "unavailable" })));
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.snapshot).toBeUndefined();
  });

  it("renders denied on unauthorized server response", async () => {
    const client = makeClient(mockFetch({ category: "unauthorized", message: "Not allowed" }, 401));
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(result.current.errorMessage).toBe("Not allowed");
  });

  it("renders unavailable on server unavailable response", async () => {
    const client = makeClient(mockFetch({ category: "unavailable", message: "No evidence" }, 503));
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it.each([
    ["missing", 404],
    ["stale", 409],
    ["superseded", 409],
  ] as const)("renders distinct %s state", async (category, status) => {
    const client = makeClient(mockFetch({ category, message: `${category} evidence` }, status));
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe(category));
    expect(result.current.snapshot).toBeUndefined();
  });

  it("sends the last plan and sequence cursor when reconnecting", async () => {
    const snapshot = makeSnapshot({
      plan: {
        planId: "00000000-0000-4000-8000-000000000011" as never,
        authority: authority as never,
        steps: [{ stepId: "step-1", description: "Run tests", sources: [] }],
        createdAt: "2026-07-25T10:00:00.000Z" as never,
      },
      sequence: 9 as never,
      timeline: [
        {
          sequence: 9 as never,
          correlationId: "00000000-0000-4000-8000-000000000012" as never,
          evidenceId: "00000000-0000-4000-8000-000000000010" as never,
          planId: "00000000-0000-4000-8000-000000000011" as never,
          stepId: "step-1",
          outcome: "passed",
          sourceKind: "repository-test",
          sourceReference: "opaque-token-abc",
          redacted: false,
          observedAt: "2026-07-25T10:00:00.000Z" as never,
        },
      ],
    });
    const client = {
      inspect: vi.fn(async () => snapshot),
    } satisfies ValidationEvidenceClient;
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    result.current.retry();
    await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
    expect(client.inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        planId: snapshot.plan!.planId,
        afterSequence: 9,
      }),
      expect.any(AbortSignal),
    );
  });

  it("clears prior evidence and cursor when the authority scope changes", async () => {
    const first = makeSnapshot({
      plan: {
        planId: "00000000-0000-4000-8000-000000000011" as never,
        authority: authority as never,
        steps: [{ stepId: "step-1", description: "Run tests", sources: [] }],
        createdAt: "2026-07-25T10:00:00.000Z" as never,
      },
      sequence: 9 as never,
      timeline: [
        {
          sequence: 9 as never,
          correlationId: "00000000-0000-4000-8000-000000000012" as never,
          evidenceId: "00000000-0000-4000-8000-000000000010" as never,
          planId: "00000000-0000-4000-8000-000000000011" as never,
          stepId: "step-1",
          outcome: "passed",
          sourceKind: "repository-test",
          sourceReference: "opaque-token-abc",
          redacted: false,
          observedAt: "2026-07-25T10:00:00.000Z" as never,
        },
      ],
    });
    const client = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new ValidationEvidenceClientFailure("unauthorized", "Scope denied")),
    } satisfies ValidationEvidenceClient;
    const nextRequest = {
      authority: {
        ...request.authority,
        projectId: "00000000-0000-4000-8000-000000000099" as never,
      },
    } satisfies ValidationEvidenceRequest;
    const { result, rerender } = renderHook(
      ({ currentRequest }) => useValidationEvidence({ client, request: currentRequest }),
      { initialProps: { currentRequest: request } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ currentRequest: nextRequest });
    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(result.current.snapshot).toBeUndefined();
    expect(client.inspect).toHaveBeenLastCalledWith(nextRequest, expect.any(AbortSignal));
  });

  it("does not let an aborted prior request overwrite its replacement", async () => {
    const replacement = makeSnapshot({
      timeline: [
        {
          sequence: 2 as never,
          correlationId: "00000000-0000-4000-8000-000000000012" as never,
          evidenceId: "00000000-0000-4000-8000-000000000010" as never,
          planId: "00000000-0000-4000-8000-000000000011" as never,
          stepId: "step-1",
          outcome: "passed",
          sourceKind: "repository-test",
          sourceReference: "replacement",
          redacted: false,
          observedAt: "2026-07-25T10:00:00.000Z" as never,
        },
      ],
      overallOutcome: "passed",
    });
    const client = {
      inspect: vi
        .fn()
        .mockImplementationOnce(
          (_input: ValidationEvidenceRequest, signal?: AbortSignal) =>
            new Promise<ValidationEvidenceSnapshot>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                setTimeout(
                  () =>
                    reject(
                      new ValidationEvidenceClientFailure("interrupted", "Prior request aborted"),
                    ),
                  20,
                );
              });
            }),
        )
        .mockResolvedValueOnce(replacement),
    } satisfies ValidationEvidenceClient;
    const nextRequest = {
      authority: {
        ...request.authority,
        projectId: "00000000-0000-4000-8000-000000000099" as never,
      },
    } satisfies ValidationEvidenceRequest;
    const { result, rerender } = renderHook(
      ({ currentRequest }) => useValidationEvidence({ client, request: currentRequest }),
      { initialProps: { currentRequest: request } },
    );

    rerender({ currentRequest: nextRequest });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(result.current.status).toBe("ready");
    expect(result.current.snapshot?.timeline[0]?.sourceReference).toBe("replacement");
  });

  it("renders interrupted on abort", async () => {
    const client = makeClient(
      vi.fn(() => {
        const error = new Error("aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }),
    );
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe("interrupted"));
  });

  it("does not fabricate zero or success for an empty timeline", async () => {
    const snapshot = makeSnapshot({
      overallOutcome: "inconclusive",
      timeline: [],
      steps: [],
    });
    const client = makeClient(mockFetch(snapshot));
    const { result } = renderHook(() => useValidationEvidence({ client, request }));
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    expect(result.current.snapshot).toBeUndefined();
  });
});

describe("ValidationEvidencePane wired to controller", () => {
  it("renders the ready pane with evidence from the server route", async () => {
    const snapshot = makeSnapshot({
      timeline: [
        {
          sequence: 2 as never,
          correlationId: "00000000-0000-4000-8000-000000000012" as never,
          evidenceId: "00000000-0000-4000-8000-000000000010" as never,
          planId: "00000000-0000-4000-8000-000000000011" as never,
          stepId: "step-1",
          outcome: "passed",
          sourceKind: "repository-test",
          sourceReference: "opaque-token-abc",
          redacted: false,
          observedAt: "2026-07-25T10:00:00.000Z" as never,
        },
      ],
      steps: [
        {
          stepId: "step-1",
          description: "Run tests",
          outcome: "passed",
          evidenceCount: 1,
          sourceKinds: ["repository-test"],
        },
      ],
      overallOutcome: "passed",
    });
    const client = makeClient(mockFetch(snapshot));
    function Harness() {
      const state = useValidationEvidence({ client, request });
      return (
        <ValidationEvidencePane
          status={state.status}
          {...(state.snapshot ? { snapshot: state.snapshot } : {})}
          {...(state.errorMessage ? { errorMessage: state.errorMessage } : {})}
          {...(state.retry ? { onRetry: state.retry } : {})}
        />
      );
    }
    const html = render(<Harness />);
    await waitFor(() => expect(html.container.textContent).toContain("All checks passed"));
    expect(html.container.textContent).toContain("opaque-token-abc");
  });
});
