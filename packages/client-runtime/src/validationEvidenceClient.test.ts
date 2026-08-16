import { describe, expect, it, vi } from "vitest";
import {
  createValidationEvidenceClient,
  ValidationEvidenceClientFailure,
} from "./validationEvidenceClient";
import type { ValidationEvidenceRequest } from "@octant/contracts/validation-rpc";

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

function mockFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

describe("validationEvidenceClient", () => {
  it("returns a decoded snapshot on success", async () => {
    const snapshot = {
      authority,
      sequence: 1,
      snapshotAt: "2026-07-25T10:00:00.000Z",
      timeline: [],
      steps: [],
      overallOutcome: "inconclusive",
    };
    const client = createValidationEvidenceClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch(snapshot),
      windowCapability: "test-cap",
    });
    const result = await client.inspect(request);
    expect(result.overallOutcome).toBe("inconclusive");
  });

  it("calls browser fetch without binding the client options as its receiver", async () => {
    const snapshot = {
      authority,
      sequence: 1,
      snapshotAt: "2026-07-25T10:00:00.000Z",
      timeline: [],
      steps: [],
      overallOutcome: "inconclusive",
    };
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(snapshot),
      } as Response);
    }) as typeof globalThis.fetch;
    const client = createValidationEvidenceClient({
      baseUrl: "http://localhost:3000",
      fetch: browserFetch,
      windowCapability: "test-cap",
    });

    await expect(client.inspect(request)).resolves.toMatchObject({
      overallOutcome: "inconclusive",
    });
  });

  it("throws protocol error on invalid response", async () => {
    const client = createValidationEvidenceClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch({ invalid: true }),
      windowCapability: "test-cap",
    });
    await expect(client.inspect(request)).rejects.toThrow(ValidationEvidenceClientFailure);
  });

  it("throws on network failure", async () => {
    const client = createValidationEvidenceClient({
      baseUrl: "http://localhost:3000",
      fetch: vi.fn(() => Promise.reject(new Error("network"))),
      windowCapability: "test-cap",
    });
    await expect(client.inspect(request)).rejects.toThrow(ValidationEvidenceClientFailure);
  });

  it("throws interrupted on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createValidationEvidenceClient({
      baseUrl: "http://localhost:3000",
      fetch: vi.fn(() => {
        const error = new Error("aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }),
      windowCapability: "test-cap",
    });
    await expect(client.inspect(request, controller.signal)).rejects.toMatchObject({
      category: "interrupted",
    });
  });

  it("throws failure category on server error", async () => {
    const client = createValidationEvidenceClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch({ category: "unauthorized", message: "Not allowed" }, 403),
      windowCapability: "test-cap",
    });
    await expect(client.inspect(request)).rejects.toMatchObject({
      category: "unauthorized",
    });
  });
});
