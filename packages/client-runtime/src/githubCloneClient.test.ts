import { describe, expect, it, vi } from "vitest";
import { createGithubCloneClient, GithubCloneClientFailure } from "./githubCloneClient";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetch: ReturnType<typeof vi.fn>) {
  return createGithubCloneClient({
    baseUrl: "http://127.0.0.1:4317",
    fetch: fetch as never,
    windowCapability: "capability-token",
  });
}

const REQUEST_ID = "6f8a2f6e-6a1d-4b0e-9a37-0f6f3a3d1a2b";
const DIGEST = "a".repeat(64);

const awaitingOperation = {
  requestId: REQUEST_ID,
  state: "awaiting-confirmation",
  mode: "clone",
  repository: {
    nodeId: "R_kgDOG8x1Aa",
    owner: "octant",
    name: "octant",
    visibility: "private",
    defaultBranch: "development",
  },
  destination: {
    inventoryPath: "/home/user/Octant/Repositories",
    destinationPath: "/home/user/Octant/Repositories/github.com/octant/octant",
    digest: DIGEST,
  },
  version: 1,
  requestedAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("createGithubCloneClient", () => {
  it("posts a validated clone command and decodes the operation response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kind: "operation", operation: awaitingOperation }));
    const response = await client(fetch).execute({
      kind: "request-clone",
      requestId: REQUEST_ID,
      nodeId: "R_kgDOG8x1Aa",
      expectedOwner: "octant",
      expectedName: "octant",
    });
    expect(response).toMatchObject({
      kind: "operation",
      operation: { state: "awaiting-confirmation", mode: "clone" },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4317/api/github/clone/commands");
    expect(init.method).toBe("POST");
    expect(init.headers["x-octant-window-capability"]).toBe("capability-token");
    expect(JSON.parse(init.body)).toEqual({
      kind: "request-clone",
      requestId: REQUEST_ID,
      nodeId: "R_kgDOG8x1Aa",
      expectedOwner: "octant",
      expectedName: "octant",
    });
  });

  it("lists in-flight operations from the authenticated operations route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        operations: [{ operation: { ...awaitingOperation, state: "cloning", version: 3 } }],
      }),
    );
    const list = await client(fetch).listOperations();
    expect(list.operations[0]!.operation.state).toBe("cloning");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4317/api/github/clone/operations");
    expect(init.method).toBe("GET");
  });

  it("refuses to send a command the clone contract rejects", async () => {
    const fetch = vi.fn();
    await expect(
      client(fetch).execute({
        kind: "confirm-clone",
        requestId: REQUEST_ID,
        nodeId: "R_kgDOG8x1Aa",
        confirmation: "yes-please",
        destinationDigest: DIGEST,
      } as never),
    ).rejects.toBeInstanceOf(GithubCloneClientFailure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("decodes a refusal with its reason and remediation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: "refused",
        reason: "collision",
        remediation: "The destination already contains a different checkout.",
      }),
    );
    await expect(
      client(fetch).execute({ kind: "cancel-clone", requestId: REQUEST_ID }),
    ).resolves.toMatchObject({ kind: "refused", reason: "collision" });
  });

  it("surfaces server failure messages with their status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { category: "unauthorized", message: "GitHub clone request is unauthorized." },
          403,
        ),
      );
    const failure = await client(fetch)
      .listOperations()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubCloneClientFailure);
    expect((failure as GithubCloneClientFailure).status).toBe(403);
    expect((failure as GithubCloneClientFailure).message).toBe(
      "GitHub clone request is unauthorized.",
    );
  });

  it("fails closed on a response that violates the clone contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: "operation",
        operation: { ...awaitingOperation, token: "ghp_" + "a".repeat(30) },
      }),
    );
    await expect(
      client(fetch).execute({ kind: "cancel-clone", requestId: REQUEST_ID }),
    ).rejects.toBeInstanceOf(GithubCloneClientFailure);
  });

  it("only accepts loopback base URLs", () => {
    expect(() =>
      createGithubCloneClient({
        baseUrl: "https://attacker.example",
        fetch: vi.fn() as never,
        windowCapability: "capability-token",
      }),
    ).toThrow(GithubCloneClientFailure);
  });
});
