import { describe, expect, it } from "vitest";
import {
  decodeGithubCloneCommand,
  decodeGithubCloneCommandResponse,
  decodeGithubCloneOperation,
  decodeGithubCloneOperationList,
  decodeGithubCloneRequested,
  decodeGithubCloneTransitioned,
} from "./githubClone";

const requestId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const operation = {
  requestId,
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
    inventoryPath: "/Users/host/Octant/Repositories",
    destinationPath: "/Users/host/Octant/Repositories/github.com/octant/octant",
    digest,
  },
  version: 1,
  requestedAt: "2026-08-11T10:00:00.000Z",
  updatedAt: "2026-08-11T10:00:00.000Z",
} as const;

describe("GitHub managed clone contracts", () => {
  it("accepts a strict clone operation snapshot", () => {
    expect(decodeGithubCloneOperation(operation)).toMatchObject({
      requestId,
      state: "awaiting-confirmation",
      destination: { digest },
    });
  });

  it("rejects unknown operation fields and unknown states", () => {
    expect(() => decodeGithubCloneOperation({ ...operation, token: "x" })).toThrow();
    expect(() => decodeGithubCloneOperation({ ...operation, state: "adopting" })).toThrow();
  });

  it("rejects non-absolute, traversing, or credential-bearing destination paths", () => {
    const withDestination = (destinationPath: string) => ({
      ...operation,
      destination: { ...operation.destination, destinationPath },
    });
    expect(() => decodeGithubCloneOperation(withDestination("relative/path"))).toThrow();
    expect(() =>
      decodeGithubCloneOperation(withDestination("/inventory/../outside/checkout")),
    ).toThrow();
    expect(() =>
      decodeGithubCloneOperation(
        withDestination("/inventory/github.com/token=ghp_0123456789abcdef/name"),
      ),
    ).toThrow();
    expect(() => decodeGithubCloneOperation(withDestination("/inventory/a\0b"))).toThrow();
  });

  it("keeps failure facts bounded and free of secret material", () => {
    expect(
      decodeGithubCloneOperation({
        ...operation,
        state: "failed",
        failure: { code: "wrong-origin", remediation: "Reselect the repository and retry." },
      }),
    ).toMatchObject({ failure: { code: "wrong-origin" } });
    expect(() =>
      decodeGithubCloneOperation({
        ...operation,
        state: "failed",
        failure: { code: "wrong-origin", remediation: "authorization: bearer abc" },
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCloneOperation({
        ...operation,
        state: "failed",
        failure: { code: "credential-leaked" },
      }),
    ).toThrow();
  });

  it("records the explicit empty-repository verification outcome", () => {
    expect(
      decodeGithubCloneOperation({
        ...operation,
        repository: { ...operation.repository, empty: true },
      }),
    ).toMatchObject({ repository: { empty: true } });
  });

  it("decodes the clone request command with strict repository identity", () => {
    expect(
      decodeGithubCloneCommand({
        kind: "request-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        expectedOwner: "octant",
        expectedName: "octant",
      }),
    ).toMatchObject({ kind: "request-clone" });
    expect(() =>
      decodeGithubCloneCommand({
        kind: "request-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        expectedOwner: "..",
        expectedName: "octant",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCloneCommand({
        kind: "request-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        expectedOwner: "octant",
        expectedName: "../escape",
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCloneCommand({
        kind: "request-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        expectedOwner: "octant",
        expectedName: "nested/name",
      }),
    ).toThrow();
  });

  it("requires the exact confirmation literal and destination digest to confirm", () => {
    expect(
      decodeGithubCloneCommand({
        kind: "confirm-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        confirmation: "confirm-github-managed-clone",
        destinationDigest: digest,
      }),
    ).toMatchObject({ kind: "confirm-clone" });
    expect(() =>
      decodeGithubCloneCommand({
        kind: "confirm-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        confirmation: "yes",
        destinationDigest: digest,
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCloneCommand({
        kind: "confirm-clone",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        confirmation: "confirm-github-managed-clone",
        destinationDigest: "not-a-digest",
      }),
    ).toThrow();
  });

  it("requires an explicit confirmation and digest to attach an existing checkout", () => {
    expect(
      decodeGithubCloneCommand({
        kind: "attach-existing",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        confirmation: "confirm-github-attach-existing",
        destinationDigest: digest,
      }),
    ).toMatchObject({ kind: "attach-existing" });
    expect(() =>
      decodeGithubCloneCommand({
        kind: "attach-existing",
        requestId,
        nodeId: "R_kgDOG8x1Aa",
        confirmation: "confirm-github-managed-clone",
        destinationDigest: digest,
      }),
    ).toThrow();
  });

  it("decodes cancel with only the request identity", () => {
    expect(decodeGithubCloneCommand({ kind: "cancel-clone", requestId })).toMatchObject({
      kind: "cancel-clone",
    });
    expect(() =>
      decodeGithubCloneCommand({ kind: "cancel-clone", requestId, force: true }),
    ).toThrow();
  });

  it("journals requested and transitioned event payloads strictly", () => {
    expect(decodeGithubCloneRequested({ operation })).toMatchObject({
      operation: { state: "awaiting-confirmation" },
    });
    expect(
      decodeGithubCloneTransitioned({
        requestId,
        fromState: "cloning",
        toState: "verifying",
        version: 4,
      }),
    ).toMatchObject({ toState: "verifying", version: 4 });
    expect(() =>
      decodeGithubCloneTransitioned({
        requestId,
        fromState: "cloning",
        toState: "verifying",
        version: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeGithubCloneTransitioned({
        requestId,
        fromState: "cloning",
        toState: "verifying",
        version: 4,
        stdout: "raw",
      }),
    ).toThrow();
  });

  it("returns the binding receipt only through the live response, never the journal payloads", () => {
    const response = decodeGithubCloneCommandResponse({
      kind: "operation",
      operation: { ...operation, state: "completed", bindingIssued: true, version: 7 },
      binding: { receiptId: "r".repeat(43), projectType: "code", expiresAt: 1754906400000 },
    });
    expect(response).toMatchObject({ kind: "operation", binding: { projectType: "code" } });
    expect(() =>
      decodeGithubCloneRequested({
        operation: { ...operation, binding: { receiptId: "r".repeat(43) } },
      }),
    ).toThrow();
  });

  it("keeps refusals to a closed reason set with bounded remediation", () => {
    expect(
      decodeGithubCloneCommandResponse({
        kind: "refused",
        reason: "collision",
        remediation: "The destination already contains different content.",
      }),
    ).toMatchObject({ kind: "refused", reason: "collision" });
    expect(() =>
      decodeGithubCloneCommandResponse({ kind: "refused", reason: "token-required" }),
    ).toThrow();
  });

  it("bounds operation listings and bounded in-flight progress text", () => {
    expect(
      decodeGithubCloneOperationList({
        operations: [
          {
            operation: { ...operation, state: "cloning", version: 3 },
            progress: { phase: "cloning", message: "Receiving objects" },
          },
        ],
      }),
    ).toMatchObject({ operations: [{ progress: { phase: "cloning" } }] });
    expect(() =>
      decodeGithubCloneOperationList({
        operations: [
          {
            operation: { ...operation, state: "cloning", version: 3 },
            progress: { phase: "cloning", message: `token=ghp_${"a".repeat(20)}` },
          },
        ],
      }),
    ).toThrow();
  });
});
