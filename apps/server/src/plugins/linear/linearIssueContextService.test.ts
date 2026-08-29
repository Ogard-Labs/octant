import { describe, expect, it, vi } from "vitest";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import type { LinearIssueDetail } from "@octant/contracts/linear-issues";
import {
  EXTERNAL_CONTENT_FRAME_CLOSE,
  EXTERNAL_CONTENT_FRAME_OPEN_PREFIX,
} from "../../context/externalContentFraming";
import {
  LINEAR_ISSUE_CONTEXT_REFUSED_MESSAGE,
  LinearIssueContextService,
  composeLinearIssueContextBlock,
  redactLinearIssueContextText,
} from "./linearIssueContextService";

const readySnapshot: IntegrationAuthenticationSnapshot = {
  state: "ready",
  capabilities: [
    { operationId: "list-issues", available: true },
    { operationId: "get-issue", available: true },
  ],
};

const unauthorizedSnapshot: IntegrationAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [{ operationId: "list-issues", available: false }],
};

const detail: LinearIssueDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-12",
  title: "Browse issues in the workspace",
  state: { name: "In Progress", type: "started" },
  assignee: "Ada",
  url: "https://linear.app/ogard-labs/issue/ENG-12",
  description: "Read-only description.",
  descriptionTruncated: false,
  comments: [
    {
      author: "Ada",
      createdAt: "2026-08-11T10:00:00Z",
      body: "Still happening",
      truncated: false,
    },
  ],
};

function service(options: {
  readonly snapshot?: IntegrationAuthenticationSnapshot;
  readonly result?:
    | { readonly kind: "ok"; readonly value: unknown }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "failed"; readonly reason: string; readonly retryable: boolean };
  readonly isEffective?: () => boolean;
}) {
  const reader = {
    snapshot: vi.fn(async () => options.snapshot ?? readySnapshot),
    executeGetIssue: vi.fn(async () => options.result ?? { kind: "ok" as const, value: detail }),
  };
  const ingestion = {
    record: vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: ["linear-issue"] },
    })),
  };
  return {
    reader,
    ingestion,
    service: new LinearIssueContextService({
      reader,
      ingestion,
      uuid: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ...(options.isEffective === undefined ? {} : { isEffective: options.isEffective }),
    }),
  };
}

describe("Linear issue context", () => {
  it("redacts token-shaped strings, NUL, and control characters from composed issue text", () => {
    const composed = composeLinearIssueContextBlock({
      identifier: "ENG-12",
      stateName: "In Progress",
      stateType: "started",
      title: "Fix lin_api_abcdefghijklmnop leak",
      url: "https://linear.app/ogard-labs/issue/ENG-12",
      description: "bearer abcdefghijklmnopqrstuvwxyz012345\u0000more",
      descriptionTruncated: false,
      comments: [
        {
          author: "Ada",
          createdAt: "2026-08-11T10:00:00Z",
          body: "access_token=supersecretvalue",
          truncated: false,
        },
      ],
    });
    expect(composed).toContain("[redacted]");
    expect(composed).not.toContain("lin_api_");
    expect(composed).not.toContain("supersecretvalue");
    expect(composed).not.toContain("\u0000");
    const authorization = redactLinearIssueContextText("authorization: Bearer secret-token-value");
    expect(authorization).toContain("[redacted]");
    expect(authorization).not.toContain("secret-token-value");
    expect(authorization).not.toContain("Bearer");
  });

  it("redacts an authorization header without consuming the following line", () => {
    const redacted = redactLinearIssueContextText(
      "authorization: Bearer secret-token-value\nIssue description stays",
    );
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("secret-token-value");
    expect(redacted).not.toContain("Bearer");
    expect(redacted).toContain("Issue description stays");
  });

  it("frames prepared issue context as untrusted external workspace data", async () => {
    const { service: context } = service({});
    const prepared = await context.prepare(
      { id: "11111111-1111-4111-8111-111111111111" },
      new AbortController().signal,
    );
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.framed.section).toBe("workspace-context");
    expect(prepared.framed.text).toContain(EXTERNAL_CONTENT_FRAME_OPEN_PREFIX);
    expect(prepared.framed.text).toContain('source="linear-issue"');
    expect(prepared.framed.text).toContain(EXTERNAL_CONTENT_FRAME_CLOSE);
    expect(prepared.framed.text).toContain("ENG-12");
    expect(prepared.framed.text).toContain("Still happening");
  });

  it("refuses create-from-issue without framed content when the Linear integration is not effective", async () => {
    const { service: context, reader } = service({ isEffective: () => false });
    const prepared = await context.prepare(
      { id: "11111111-1111-4111-8111-111111111111" },
      new AbortController().signal,
    );
    expect(prepared).toEqual({
      status: "refused",
      reason: "unavailable",
      message: LINEAR_ISSUE_CONTEXT_REFUSED_MESSAGE,
    });
    expect(reader.snapshot).not.toHaveBeenCalled();
    expect(reader.executeGetIssue).not.toHaveBeenCalled();
    expect(context.peekFramedForFirstTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeUndefined();
  });

  it("refuses when Linear issue browse is unavailable", async () => {
    const { service: context } = service({ snapshot: unauthorizedSnapshot });
    const prepared = await context.prepare(
      { id: "11111111-1111-4111-8111-111111111111" },
      new AbortController().signal,
    );
    expect(prepared).toEqual({
      status: "refused",
      reason: "unauthorized",
      message: LINEAR_ISSUE_CONTEXT_REFUSED_MESSAGE,
    });
  });

  it("binds framed context for the first turn and clears it after take", async () => {
    const { service: context, ingestion } = service({});
    const prepared = await context.prepare(
      { id: "11111111-1111-4111-8111-111111111111" },
      new AbortController().signal,
    );
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    context.bindCreatedThread({
      threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      framed: prepared.framed,
      request: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(ingestion.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contentReference: "linear-issue-11111111-1111-4111-8111-111111111111",
        provenance: { origin: "external-content", sourceLabel: "linear-issue" },
      }),
    );
    expect(context.takeFramedForFirstTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")?.text).toBe(
      prepared.framed.text,
    );
    expect(context.takeFramedForFirstTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeUndefined();
  });
});
