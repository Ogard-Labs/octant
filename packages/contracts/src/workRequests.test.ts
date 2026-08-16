import { describe, expect, it } from "vitest";
import {
  decodeWorkRequest,
  decodeWorkRequestCommand,
  decodeWorkRequestCommandResult,
  decodeWorkRequestDetail,
  decodeWorkRequestFailure,
  decodeWorkRequestFrame,
  decodeWorkRequestList,
  decodeWorkRequestRecordInput,
  decodeWorkRequestResolution,
} from "./workRequests";

const ids = {
  request: "11111111-1111-4111-8111-111111111111",
  otherRequest: "77777777-7777-4777-8777-777777777777",
  project: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  session: "55555555-5555-4555-8555-555555555555",
} as const;

const requestedAt = "2026-08-10T08:00:00.000Z";
const settledAt = "2026-08-10T08:05:00.000Z";

const approvalDetail = {
  kind: "approval",
  action: "run-terminal-command",
  description: "Run `bun install` to refresh dependencies.",
} as const;

const userInputDetail = {
  kind: "user-input",
  prompt: "Which export format do you want?",
  options: ["PDF", "DOCX"],
} as const;

const pendingApproval = {
  requestId: ids.request,
  projectId: ids.project,
  threadId: ids.thread,
  providerInstanceId: ids.provider,
  providerSessionId: ids.session,
  providerRequestId: "provider-req-1",
  detail: approvalDetail,
  status: "pending",
  requestedAt,
  version: 1,
} as const;

describe("WorkRequestDetail", () => {
  it("decodes an approval detail", () => {
    expect(decodeWorkRequestDetail(approvalDetail).kind).toBe("approval");
  });

  it("decodes a user-input detail", () => {
    expect(decodeWorkRequestDetail(userInputDetail).kind).toBe("user-input");
  });

  it("rejects a description that looks like a host path", () => {
    expect(() =>
      decodeWorkRequestDetail({
        kind: "approval",
        action: "read-file",
        description: "/Users/example/secret/file.txt",
      }),
    ).toThrow();
  });

  it("rejects a prompt that carries a file: URL", () => {
    expect(() =>
      decodeWorkRequestDetail({
        kind: "user-input",
        prompt: "Open file:///etc/passwd instead?",
        options: [],
      }),
    ).toThrow();
  });

  it("rejects more than 8 user-input options", () => {
    expect(() =>
      decodeWorkRequestDetail({
        kind: "user-input",
        prompt: "Pick one",
        options: Array.from({ length: 9 }, (_, index) => `option-${index}`),
      }),
    ).toThrow();
  });
});

describe("WorkRequest", () => {
  it("decodes a pending request with no resolution or settledAt", () => {
    const request = decodeWorkRequest(pendingApproval);
    expect(request.status).toBe("pending");
    expect(request.resolution).toBeUndefined();
    expect(request.settledAt).toBeUndefined();
  });

  it("persists the originating provider session identity", () => {
    const request = decodeWorkRequest({ ...pendingApproval, providerSessionId: ids.session });
    expect(request.providerSessionId).toBe(ids.session);
  });

  it("rejects an oversized renderer-facing provider surrogate", () => {
    expect(() =>
      decodeWorkRequest({ ...pendingApproval, providerRequestId: "x".repeat(257) }),
    ).toThrow();
  });

  it("rejects private provider option values on the renderer-facing request", () => {
    expect(() =>
      decodeWorkRequest({
        ...pendingApproval,
        providerOptionValues: ["file:///private/source"],
      }),
    ).toThrow();
  });

  it("rejects a pending request that already carries a resolution", () => {
    expect(() =>
      decodeWorkRequest({
        ...pendingApproval,
        resolution: { kind: "approval", approved: true },
        settledAt,
      }),
    ).toThrow();
  });

  it("decodes a resolved approval request with a matching resolution kind", () => {
    const request = decodeWorkRequest({
      ...pendingApproval,
      status: "resolved",
      resolution: { kind: "approval", approved: true },
      settledAt,
      version: 2,
    });
    expect(request.status).toBe("resolved");
  });

  it("rejects a resolved request whose resolution kind does not match its detail kind", () => {
    expect(() =>
      decodeWorkRequest({
        ...pendingApproval,
        status: "resolved",
        resolution: { kind: "user-input", answer: "PDF" },
        settledAt,
        version: 2,
      }),
    ).toThrow();
  });

  it("rejects a resolved request with no settledAt", () => {
    expect(() =>
      decodeWorkRequest({
        ...pendingApproval,
        status: "resolved",
        resolution: { kind: "approval", approved: true },
        version: 2,
      }),
    ).toThrow();
  });

  it("decodes a cancelled request with no resolution", () => {
    const request = decodeWorkRequest({
      ...pendingApproval,
      status: "cancelled",
      settledAt,
      version: 2,
    });
    expect(request.status).toBe("cancelled");
  });

  it("rejects a cancelled request that carries a resolution", () => {
    expect(() =>
      decodeWorkRequest({
        ...pendingApproval,
        status: "cancelled",
        resolution: { kind: "approval", approved: true },
        settledAt,
        version: 2,
      }),
    ).toThrow();
  });
});

describe("WorkRequestResolution", () => {
  it("decodes an approval resolution", () => {
    expect(decodeWorkRequestResolution({ kind: "approval", approved: false }).kind).toBe(
      "approval",
    );
  });

  it("decodes a user-input resolution", () => {
    expect(decodeWorkRequestResolution({ kind: "user-input", answer: "PDF" }).kind).toBe(
      "user-input",
    );
  });

  it("rejects an answer that carries a path separator", () => {
    expect(() =>
      decodeWorkRequestResolution({ kind: "user-input", answer: "../etc/passwd" }),
    ).toThrow();
  });
});

describe("WorkRequestCommand", () => {
  it("decodes a resolve command", () => {
    const command = decodeWorkRequestCommand({
      kind: "resolve-work-request",
      requestId: ids.request,
      expectedVersion: 1,
      resolution: { kind: "approval", approved: true },
    });
    expect(command.kind).toBe("resolve-work-request");
  });

  it("decodes a cancel command", () => {
    const command = decodeWorkRequestCommand({
      kind: "cancel-work-request",
      requestId: ids.request,
      expectedVersion: 1,
    });
    expect(command.kind).toBe("cancel-work-request");
  });

  it("rejects a command that supplies an unknown property", () => {
    expect(() =>
      decodeWorkRequestCommand({
        kind: "cancel-work-request",
        requestId: ids.request,
        expectedVersion: 1,
        windowId: "sneaky",
      }),
    ).toThrow();
  });
});

describe("WorkRequestCommandResult", () => {
  it("decodes a resolved result", () => {
    const result = decodeWorkRequestCommandResult({
      kind: "work-request-resolved",
      request: {
        ...pendingApproval,
        status: "resolved",
        resolution: { kind: "approval", approved: true },
        settledAt,
        version: 2,
      },
    });
    expect(result.kind).toBe("work-request-resolved");
  });

  it("rejects a resolved result whose request is still pending", () => {
    expect(() =>
      decodeWorkRequestCommandResult({
        kind: "work-request-resolved",
        request: pendingApproval,
      }),
    ).toThrow();
  });
});

describe("WorkRequestFailure", () => {
  it("decodes a failure", () => {
    const failure = decodeWorkRequestFailure({ code: "not-found", message: "missing" });
    expect(failure.code).toBe("not-found");
  });
});

describe("WorkRequestList", () => {
  it("decodes a bounded list of requests", () => {
    const list = decodeWorkRequestList({ requests: [pendingApproval] });
    expect(list.requests).toHaveLength(1);
  });

  it("rejects more than 128 requests", () => {
    const requests = Array.from({ length: 129 }, (_, index) => ({
      ...pendingApproval,
      requestId: index === 0 ? ids.request : ids.otherRequest,
    }));
    expect(() => decodeWorkRequestList({ requests })).toThrow();
  });
});

describe("WorkRequestFrame", () => {
  it("decodes a requested frame whose request is pending", () => {
    const frame = decodeWorkRequestFrame({ kind: "requested", request: pendingApproval });
    expect(frame.kind).toBe("requested");
  });

  it("rejects a requested frame whose request is not pending", () => {
    expect(() =>
      decodeWorkRequestFrame({
        kind: "requested",
        request: { ...pendingApproval, status: "cancelled", settledAt, version: 2 },
      }),
    ).toThrow();
  });

  it("persists private provider option values only with the requested journal frame", () => {
    const frame = decodeWorkRequestFrame({
      kind: "requested",
      request: {
        ...pendingApproval,
        detail: {
          kind: "user-input",
          prompt: "Pick a source",
          options: ["Option 1: [redacted reference]"],
        },
      },
      providerOptionValues: ["file:///private/source"],
    });
    expect(frame.kind).toBe("requested");
    if (frame.kind === "requested") {
      expect(frame.providerOptionValues).toEqual(["file:///private/source"]);
    }
  });

  it("keeps an opaque provider callback only in the private requested frame", () => {
    const providerCallbackId = "postgres://alice:secret@host/request";
    const frame = decodeWorkRequestFrame({
      kind: "requested",
      request: { ...pendingApproval, providerRequestId: ids.request },
      providerCallbackId,
    });
    expect(frame.kind).toBe("requested");
    if (frame.kind === "requested") {
      expect(frame.request.providerRequestId).toBe(ids.request);
      expect(frame.providerCallbackId).toBe(providerCallbackId);
    }
    expect(() => decodeWorkRequest({ ...pendingApproval, providerCallbackId })).toThrow();
  });
});

describe("WorkRequestRecordInput", () => {
  it("decodes a record input", () => {
    const input = decodeWorkRequestRecordInput({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(input.detail.kind).toBe("approval");
  });

  it("accepts bounded private provider option values for server-side recording", () => {
    const input = decodeWorkRequestRecordInput({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: {
        kind: "user-input",
        prompt: "Pick a source",
        options: ["Option 1: [redacted reference]"],
      },
      providerOptionValues: [" file:///private/source "],
    });
    expect(input.providerOptionValues).toEqual([" file:///private/source "]);
  });
});
