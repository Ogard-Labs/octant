import { CANVAS_SCHEMA_VERSION, decodeCanvasVersion } from "@octant/contracts/canvas";
import { decodeCanvasComment } from "@octant/contracts/canvas-board";
import {
  decodeCanvasStaticExportDocument,
  decodeCanvasStaticExportRequest,
} from "@octant/contracts/canvas-share";
import { describe, expect, it } from "vitest";
import { barListExamples } from "./canvasBarListExamples";
import { chartExamples } from "./canvasChartExamples";
import { comparisonMatrixExamples } from "./canvasComparisonMatrixExamples";
import { mathExamples } from "./canvasMathExamples";
import { launchDeckExample, onboardingFlowExample } from "./canvasDesignExamples";
import {
  loginSequenceExample,
  orderSchemaExample,
  orderStateExample,
  releaseMindmapExample,
  supportFlowExample,
} from "./canvasDiagramExamples";
import { heatmapExamples } from "./canvasHeatmapExamples";
import { metricExamples } from "./canvasMetricExamples";
import { mockupExamples } from "./canvasMockupExamples";
import { treemapExamples } from "./canvasTreemapExamples";
import {
  buildCanvasStaticExportDocument,
  buildCanvasStaticExportReceipt,
  CanvasSharePolicyRejected,
  CANVAS_SHARE_THREAT_MODEL,
  validateCanvasStaticExportRequest,
} from "./canvasSharePolicy";

const ids = {
  exportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  actor: "66666666-6666-4666-8666-666666666666",
  source: "77777777-7777-4777-8777-777777777777",
  provider: "55555555-5555-4555-8555-555555555555",
} as const;

const current = {
  schemaVersion: 1,
  canvasId: ids.canvas,
  versionId: ids.version,
  sequence: 2,
  createdBy: { kind: "local-user", actorId: ids.actor },
  createdAt: "2026-08-04T11:00:00.000Z",
  definition: {
    schemaVersion: 1,
    title: "Weekly plan",
    provenance: {
      hostId: "local",
      projectId: ids.project,
      actor: { kind: "local-user", actorId: ids.actor },
      providerInstanceId: ids.provider,
      modelId: "octant-test-model",
      createdAt: "2026-08-04T11:00:00.000Z",
      mode: "chat",
      threadId: ids.thread,
    },
    sourceManifest: [
      {
        sourceId: ids.source,
        kind: "artifact",
        hostId: "local",
        projectId: ids.project,
        opaqueRef: "artifact:one",
        displayName: "Artifact",
      },
    ],
    blocks: [
      {
        blockId: "heading-1",
        schemaVersion: 1,
        kind: "heading",
        level: 1,
        text: "Weekly plan",
      },
      {
        blockId: "source-1",
        schemaVersion: 1,
        kind: "source-reference",
        label: "Artifact",
        sourceId: ids.source,
      },
    ],
  },
} as const;

const request = {
  schemaVersion: 1,
  kind: "canvas-static-export",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  expectedSequence: 2,
  hostId: "local",
  projectId: ids.project,
  channel: "static-export",
  consent: {
    acknowledgedOfflineSnapshot: true,
    acknowledgedNoCredentials: true,
    acknowledgedAt: "2026-08-04T12:00:00.000Z",
    acknowledgedBy: { kind: "local-user", actorId: ids.actor },
  },
} as const;

const context = {
  sharingEnabled: true,
  hostId: "local",
  projectId: ids.project,
  nowIso: "2026-08-04T12:00:01.000Z",
  actor: { kind: "local-user" as const, actorId: ids.actor },
} as const;

/** The denial a share policy refused with, or undefined when it admitted the share. */
function shareDenial(share: () => unknown): string | undefined {
  try {
    share();
  } catch (error) {
    if (error instanceof CanvasSharePolicyRejected) return error.denialCode;
    throw error;
  }
  return undefined;
}

describe("Canvas share policy", () => {
  it("builds a sanitized static export when consent and scope match", () => {
    const receipt = buildCanvasStaticExportReceipt({ request, current, context });
    expect(receipt.consent).toEqual(request.consent);
    expect(receipt.document.threatModelId).toBe(CANVAS_SHARE_THREAT_MODEL.id);
    expect(receipt.document.provenance).toEqual({
      hostId: "local",
      projectId: ids.project,
      mode: "chat",
      threadId: ids.thread,
      createdAt: "2026-08-04T11:00:00.000Z",
      providerLabel: "provider",
      modelLabel: "octant-test-model",
      actorKind: "local-user",
    });
    expect(receipt.document.sourceManifest).toEqual([
      {
        sourceId: ids.source,
        kind: "artifact",
        displayName: "Artifact",
        opaqueRef: "artifact:one",
      },
    ]);
    expect(receipt.document.blocks).toEqual([
      {
        blockId: "heading-1",
        schemaVersion: 1,
        kind: "heading",
        level: 1,
        text: "Weekly plan",
      },
      {
        blockId: "source-1",
        schemaVersion: 1,
        kind: "source-reference",
        label: "Artifact",
      },
    ]);
  });

  it("shares a plan's phases and tasks without the source ids that only resolve on this host", () => {
    const plan = {
      blockId: "plan-1",
      schemaVersion: 1,
      kind: "plan",
      title: "Launch plan",
      phases: [{ phaseId: "build", title: "Build" }],
      tasks: [
        {
          taskId: "api",
          phaseId: "build",
          title: "Ship the API",
          status: "doing",
          sourceIds: [ids.source],
        },
      ],
    } as const;
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: { ...current, definition: { ...current.definition, blocks: [plan] } },
      context,
    });
    expect(receipt.document.blocks).toEqual([
      {
        ...plan,
        tasks: [{ taskId: "api", phaseId: "build", title: "Ship the API", status: "doing" }],
      },
    ]);
  });

  it("shares a table's rows as their cells, without the row ids comments anchor to", () => {
    const table = {
      blockId: "vendors",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "table",
      columns: [
        { id: "vendor", label: "Vendor", type: "text" },
        { id: "price", label: "Price", type: "number" },
      ],
      rows: [{ id: "acme", cells: ["Acme", 12] }, ["Globex", 9]],
    } as const;
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: decodeCanvasVersion({
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: {
          ...current.definition,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          blocks: [table],
        },
      }),
      context,
    });
    expect(receipt.document.blocks).toEqual([
      {
        ...table,
        rows: [
          ["Acme", 12],
          ["Globex", 9],
        ],
      },
    ]);
  });

  it("round-trips entity-relationship, swimlane, and mind map blocks through the static export", () => {
    const blocks = [
      {
        blockId: "order-schema",
        schemaVersion: 8,
        kind: "er",
        entities: [
          {
            entityId: "person",
            label: "Person",
            attributes: [{ attributeId: "person-id", name: "id", type: "uuid", key: true }],
          },
          {
            entityId: "order",
            label: "Order",
            attributes: [{ attributeId: "order-id", name: "id", type: "uuid", key: true }],
          },
        ],
        relationships: [
          {
            relationshipId: "person-places-order",
            source: "person",
            target: "order",
            sourceCardinality: "one",
            targetCardinality: "many",
            label: "places",
          },
        ],
      },
      {
        blockId: "support-flow",
        schemaVersion: 8,
        kind: "swimlane",
        lanes: [{ laneId: "support", label: "Support", kind: "team" }],
        steps: [{ stepId: "triage", laneId: "support", label: "Is it a defect?", decision: true }],
        connections: [],
      },
      {
        blockId: "release-mindmap",
        schemaVersion: 8,
        kind: "mindmap",
        nodes: [
          { nodeId: "release", label: "Release" },
          { nodeId: "tests", label: "Tests", parentId: "release", note: "green on head" },
        ],
      },
    ];
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: {
        ...current,
        schemaVersion: 8,
        definition: { ...current.definition, schemaVersion: 8, blocks },
      },
      context,
    });
    expect(receipt.document.blocks).toEqual(blocks);
  });

  it("shares every block an agent is shown as an example, and refuses a design", () => {
    const atCurrentVersion = (blocks: ReadonlyArray<unknown>) => ({
      ...current,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      definition: { ...current.definition, schemaVersion: CANVAS_SCHEMA_VERSION, blocks },
    });
    const examples = [
      ...chartExamples,
      ...metricExamples,
      ...treemapExamples,
      ...heatmapExamples,
      ...barListExamples,
      ...comparisonMatrixExamples,
      ...mathExamples,
      loginSequenceExample,
      orderStateExample,
      orderSchemaExample,
      supportFlowExample,
      releaseMindmapExample,
      ...mockupExamples,
    ];
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: atCurrentVersion(examples),
      context,
    });
    // The snapshot record and the share panel both read a shared document
    // through this decode, so an example it refuses is one nobody can share.
    expect(decodeCanvasStaticExportDocument(receipt.document).blocks).toEqual(examples);

    for (const design of [onboardingFlowExample, launchDeckExample]) {
      expect(
        shareDenial(() =>
          buildCanvasStaticExportReceipt({ request, current: atCurrentVersion([design]), context }),
        ),
      ).toBe("unsafe-payload");
    }
  });

  it("excludes board comments from a static export by default", () => {
    const comment = decodeCanvasComment({
      commentId: "88888888-8888-4888-8888-888888888888",
      anchor: { kind: "block", blockId: "heading-1" },
      author: { kind: "local-user", actorId: ids.actor },
      body: "Keep this discussion local.",
      createdAt: "2026-08-04T11:30:00.000Z",
    });
    const commentBearingCurrent = {
      ...decodeCanvasVersion(current),
      comments: [comment],
    };
    expect(commentBearingCurrent.comments).toHaveLength(1);

    const document = buildCanvasStaticExportDocument({
      request: decodeCanvasStaticExportRequest(request),
      current: commentBearingCurrent,
      exportedAt: context.nowIso,
    });
    expect("comments" in document).toBe(false);
  });

  it("keeps local Canvas usable when sharing is disabled", () => {
    expect(() =>
      validateCanvasStaticExportRequest({
        request,
        current: current as never,
        context: { ...context, sharingEnabled: false },
      }),
    ).toThrowError(CanvasSharePolicyRejected);
    try {
      validateCanvasStaticExportRequest({
        request,
        current: current as never,
        context: { ...context, sharingEnabled: false },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasSharePolicyRejected);
      expect((error as CanvasSharePolicyRejected).denialCode).toBe("sharing-disabled");
    }
  });

  it("rejects stale versions and secret-shaped block payloads", () => {
    expect(() =>
      buildCanvasStaticExportReceipt({
        request: { ...request, expectedSequence: 1 },
        current,
        context,
      }),
    ).toThrowError(/stale/i);

    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "kv-1",
                schemaVersion: 1,
                kind: "key-value",
                entries: [{ key: "api_key", value: "sk-1234567890abcdef" }],
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);
  });

  it("rejects credential-bearing URLs embedded in export fields", () => {
    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "link-1",
                schemaVersion: 1,
                kind: "link",
                label: "Signed artifact",
                href: "https://example.test/file?token=opaque-secret",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);

    try {
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "link-2",
                schemaVersion: 1,
                kind: "link",
                label: "Signed artifact",
                href: "https://example.test/file?X-Amz-Signature=abc123&X-Amz-Credential=AKIA",
              },
            ],
          },
        },
        context,
      });
      throw new Error("expected credential-bearing signed URL rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasSharePolicyRejected);
      expect((error as CanvasSharePolicyRejected).denialCode).toBe("unsafe-payload");
    }
  });

  it("rejects broader credential shapes outside the sk-/Bearer/private-key subset", () => {
    for (const secret of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "Basic dXNlcjpwYXNzd29yZA==",
    ]) {
      expect(() =>
        buildCanvasStaticExportReceipt({
          request,
          current: {
            ...current,
            definition: {
              ...current.definition,
              blocks: [
                {
                  blockId: "rich-1",
                  schemaVersion: 1,
                  kind: "rich-text",
                  text: `token ${secret}`,
                },
              ],
            },
          },
          context,
        }),
      ).toThrowError(CanvasSharePolicyRejected);
    }
  });

  it("rejects embedded credential-bearing URLs in prose and absolute host paths", () => {
    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "rich-url",
                schemaVersion: 1,
                kind: "rich-text",
                text: "Download from https://example.test/file?token=opaque-secret",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);

    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "file-1",
                schemaVersion: 1,
                kind: "file-reference",
                label: "Plan",
                detail: "/Volumes/Private/plan.md",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);
  });

  it("requires authenticated local-user consent bound to the caller", () => {
    expect(() =>
      validateCanvasStaticExportRequest({
        request: {
          ...request,
          consent: {
            ...request.consent,
            acknowledgedBy: { kind: "system", actorId: ids.actor },
          },
        },
        current: current as never,
        context,
      }),
    ).toThrowError(/consent|local-user|malformed/i);

    expect(() =>
      validateCanvasStaticExportRequest({
        request: {
          ...request,
          consent: {
            ...request.consent,
            acknowledgedBy: {
              kind: "local-user",
              actorId: "99999999-9999-4999-8999-999999999999",
            },
          },
        },
        current: current as never,
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);
  });

  it("rejects secret-bearing model labels and non-http credential URLs", () => {
    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            provenance: {
              ...current.definition.provenance,
              modelId: "sk-1234567890abcdef",
            },
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);

    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "rich-1",
                schemaVersion: 1,
                kind: "rich-text",
                text: "postgres://alice:password@db.example.com/app",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);
  });

  it("preserves optional operator notes on receipts", () => {
    const receipt = buildCanvasStaticExportReceipt({
      request: { ...request, note: "Offline board pack for review" },
      current,
      context,
    });
    expect(receipt.note).toBe("Offline board pack for review");
  });

  it("records the static-export threat model surface", () => {
    expect(CANVAS_SHARE_THREAT_MODEL.threats.map((threat) => threat.id)).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
    ]);
  });

  it("rejects filesystem URLs and absolute host paths outside the old root allowlist", () => {
    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "rich-file",
                schemaVersion: 1,
                kind: "rich-text",
                text: "Open file:///etc/passwd",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);

    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "rich-path",
                schemaVersion: 1,
                kind: "rich-text",
                text: "Config at /Library/Preferences/com.example.plist",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);
  });

  it("rejects OAuth-style code and session query parameters in export payloads", () => {
    expect(() =>
      buildCanvasStaticExportReceipt({
        request,
        current: {
          ...current,
          definition: {
            ...current.definition,
            blocks: [
              {
                blockId: "link-oauth",
                schemaVersion: 1,
                kind: "link",
                label: "Callback",
                href: "https://idp.example/callback?code=oauth-secret",
              },
            ],
          },
        },
        context,
      }),
    ).toThrowError(CanvasSharePolicyRejected);
  });
});
