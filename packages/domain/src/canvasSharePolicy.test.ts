import {
  CANVAS_MAX_TEXT_LENGTH,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasVersion,
} from "@octant/contracts/canvas";
import { decodeCanvasComment } from "@octant/contracts/canvas-board";
import {
  CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION,
  CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION,
  CANVAS_SHARE_SCHEMA_VERSION,
  decodeCanvasStaticExportDocument,
  decodeCanvasStaticExportRequest,
} from "@octant/contracts/canvas-share";
import { describe, expect, it } from "vitest";
import { barListExamples } from "./canvasBarListExamples";
import {
  chartExamples,
  serviceProfileRadarExample,
  signupFunnelExample,
  trafficSankeyExample,
} from "./canvasChartExamples";
import { comparisonMatrixExamples } from "./canvasComparisonMatrixExamples";
import { opsDashboardExample } from "./canvasDashboardExamples";
import { mathExamples } from "./canvasMathExamples";
import {
  cartPrototypeExample,
  launchDeckExample,
  onboardingFlowExample,
} from "./canvasDesignExamples";
import {
  loginSequenceExample,
  orderSchemaExample,
  orderStateExample,
  releaseMindmapExample,
  supportFlowExample,
} from "./canvasDiagramExamples";
import { heatmapExamples } from "./canvasHeatmapExamples";
import { designBriefExample, launchGanttExample } from "./canvasLayoutExamples";
import { metricExamples } from "./canvasMetricExamples";
import { mockupExamples } from "./canvasMockupExamples";
import { treemapExamples } from "./canvasTreemapExamples";
import {
  buildCanvasPublicShareDocument,
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
    expect(receipt.document.schemaVersion).toBe(CANVAS_SHARE_SCHEMA_VERSION);
    expect(receipt.document.blocks).toEqual([
      {
        ...table,
        schemaVersion: CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION,
        rows: [
          ["Acme", 12],
          ["Globex", 9],
        ],
      },
    ]);
  });

  it("shares a funnel, a radar, and a sankey with every stage, axis, and flow", () => {
    const blocks = [signupFunnelExample, serviceProfileRadarExample, trafficSankeyExample];
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: decodeCanvasVersion({
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: { ...current.definition, schemaVersion: CANVAS_SCHEMA_VERSION, blocks },
      }),
      context,
    });
    expect(receipt.document.schemaVersion).toBe(CANVAS_SHARE_SCHEMA_VERSION);
    expect(receipt.document.blocks).toEqual(
      blocks.map((block) => ({ ...block, schemaVersion: CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION })),
    );
  });

  it("shares a mockup with its library components and definitions at share version 13, refused by version 12", () => {
    const library = {
      blockId: "inbox",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "mockup",
      device: "phone",
      title: "Inbox",
      definitions: [
        {
          defId: "row",
          label: "Row",
          nodes: [{ nodeId: "r1", component: "list-row", label: "One" }],
        },
      ],
      nodes: [
        { nodeId: "window", component: "window", label: "Inbox" },
        { nodeId: "load", parentId: "window", component: "progress", label: "Sync", progress: 40 },
        { nodeId: "first", parentId: "window", component: "instance", label: "Row", defId: "row" },
      ],
    };
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: decodeCanvasVersion({
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: {
          ...current.definition,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          blocks: [library],
        },
      }),
      context,
    });
    expect(receipt.document.schemaVersion).toBe(CANVAS_SHARE_SCHEMA_VERSION);
    expect(receipt.document.blocks).toEqual([
      {
        ...library,
        schemaVersion: Math.min(library.schemaVersion, CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION),
      },
    ]);
    expect(() =>
      decodeCanvasStaticExportDocument({ ...receipt.document, schemaVersion: 12 }),
    ).toThrow();
  });

  it("shares a deck's slides without the presenter's notes", () => {
    const metric = {
      blockId: "signups",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric",
      label: "Signups",
      value: 1200,
    };
    const chartBlock = {
      blockId: "trend",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "line",
      series: [{ seriesId: "s", label: "Signups", points: [{ x: "Q1", y: 3 }] }],
    };
    const deck = {
      blockId: "talk",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "deck",
      title: "Review",
      slides: [
        { slideId: "one", blockId: "signups", notes: "Pause here for questions." },
        { slideId: "two", blockId: "trend" },
      ],
    };
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: decodeCanvasVersion({
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: {
          ...current.definition,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          blocks: [metric, chartBlock, deck],
        },
      }),
      context,
    });
    const shared = receipt.document.blocks.find((block) => block.blockId === "talk");
    expect(shared).toEqual({
      ...deck,
      schemaVersion: Math.min(deck.schemaVersion, CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION),
      slides: [
        { slideId: "one", blockId: "signups" },
        { slideId: "two", blockId: "trend" },
      ],
    });
    expect(JSON.stringify(receipt.document)).not.toContain("Pause here");
  });

  it("shares a dashboard with the blocks it places, so a reader draws the same grid", () => {
    const blocks = [...opsDashboardExample];
    const receipt = buildCanvasStaticExportReceipt({
      request,
      current: decodeCanvasVersion({
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: { ...current.definition, schemaVersion: CANVAS_SCHEMA_VERSION, blocks },
      }),
      context,
    });
    expect(receipt.document.schemaVersion).toBe(CANVAS_SHARE_SCHEMA_VERSION);
    expect(receipt.document.blocks[0]).toEqual({
      ...opsDashboardExample[0],
      schemaVersion: CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION,
    });
    expect(receipt.document.blocks.map((block) => block.blockId)).toEqual(
      blocks.map((block) => block.blockId),
    );
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

  it("shares every block an agent is shown as an example, and a design only once its markup is acknowledged", () => {
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
    // Each block names at most the newest Canvas version this share version
    // represents, and a chart leaves without the callouts a share predates.
    expect(decodeCanvasStaticExportDocument(receipt.document).blocks).toEqual(
      examples.map((block) => ({
        ...withoutChartCallouts(block),
        schemaVersion: Math.min(block.schemaVersion, CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION),
      })),
    );

    const acknowledged = {
      ...request,
      consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
    };
    for (const design of [onboardingFlowExample, launchDeckExample, cartPrototypeExample]) {
      // The secret filter reads values, not markup, so a design leaves only
      // when the sharer has said they know it leaves as written.
      expect(
        shareDenial(() =>
          buildCanvasStaticExportReceipt({ request, current: atCurrentVersion([design]), context }),
        ),
      ).toBe("consent-required");
      const shared = buildCanvasStaticExportReceipt({
        request: acknowledged,
        current: atCurrentVersion([design]),
        context,
      });
      expect(decodeCanvasStaticExportDocument(shared.document).blocks).toEqual([
        {
          ...design,
          schemaVersion: Math.min(design.schemaVersion, CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION),
        },
      ]);
    }
  });

  it("shares a design without the images it declares, which resolve only on this host", () => {
    const design = {
      ...onboardingFlowExample,
      assets: [{ assetId: "shot", source: { kind: "project-file", path: "screens/home.png" } }],
    };
    const shared = buildCanvasStaticExportReceipt({
      request: {
        ...request,
        consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
      },
      current: {
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: {
          ...current.definition,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          provenance: { ...current.definition.provenance, mode: "work" },
          blocks: [design],
        },
      },
      context,
    });
    expect(shared.document.blocks[0]).not.toHaveProperty("assets");
    expect(JSON.stringify(shared.document)).not.toContain("screens/home.png");
  });

  it("shares a validated brand and richer diagram fields at share version 14, and leaves presenter notes and a captured page behind", () => {
    const captureId = "66666666-6666-4666-8666-666666666666";
    const design = {
      ...onboardingFlowExample,
      theme: "brand",
      brand: { "color-primary": "#1a73e8", "radius-card": "8px" },
      frames: [{ ...onboardingFlowExample.frames[0], notes: "Open with the demo." }],
      assets: [{ assetId: "shot", source: { kind: "browser-capture", captureId } }],
    };
    const diagram = {
      blockId: "arch",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "diagram",
      nodes: [{ nodeId: "db", label: "Orders", icon: "database", detail: "Postgres" }],
      edges: [],
      groups: [
        { groupId: "region", label: "Region", nodeIds: [] },
        { groupId: "data", label: "Data", nodeIds: ["db"], parentGroupId: "region" },
      ],
    };
    const share = (blocks: ReadonlyArray<unknown>) =>
      buildCanvasStaticExportReceipt({
        request: {
          ...request,
          consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
        },
        current: {
          ...current,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          definition: {
            ...current.definition,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            provenance: { ...current.definition.provenance, mode: "work" },
            blocks,
          },
        },
        context,
      });
    const receipt = share([design, diagram]);
    expect(receipt.document.schemaVersion).toBe(CANVAS_SHARE_SCHEMA_VERSION);
    expect(CANVAS_SHARE_SCHEMA_VERSION).toBe(14);
    expect(CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION).toBe(25);
    const { assets: _assets, ...withoutAssets } = design;
    expect(receipt.document.blocks).toEqual([
      {
        ...withoutAssets,
        schemaVersion: CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION,
        frames: [onboardingFlowExample.frames[0]],
      },
      { ...diagram, schemaVersion: CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION },
    ]);
    expect(JSON.stringify(receipt.document)).not.toContain(captureId);
    expect(JSON.stringify(receipt.document)).not.toContain("Open with the demo.");
  });

  it("refuses a brand value that could load something, and never lets private notes block or leave with a share", () => {
    const share = (design: unknown) =>
      shareDenial(() =>
        buildCanvasStaticExportReceipt({
          request: {
            ...request,
            consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
          },
          current: {
            ...current,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            definition: {
              ...current.definition,
              schemaVersion: CANVAS_SCHEMA_VERSION,
              blocks: [design],
            },
          },
          context,
        }),
      );
    expect(
      share({
        ...onboardingFlowExample,
        theme: "brand",
        brand: { "color-primary": "url(https://example.test/a.png)" },
      }),
    ).toBe("unsafe-payload");
    const receipt = buildCanvasStaticExportReceipt({
      request: {
        ...request,
        consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
      },
      current: {
        ...current,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        definition: {
          ...current.definition,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          blocks: [
            {
              ...onboardingFlowExample,
              frames: [
                {
                  ...onboardingFlowExample.frames[0],
                  notes: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                },
              ],
            },
          ],
        },
      },
      context,
    });
    expect(JSON.stringify(receipt.document)).not.toContain("ghp_");
  });

  it("refuses an acknowledged design whose own id or frame id reads as a credential", () => {
    const share = (design: unknown) =>
      shareDenial(() =>
        buildCanvasStaticExportReceipt({
          request: {
            ...request,
            consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
          },
          current: {
            ...current,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            definition: {
              ...current.definition,
              schemaVersion: CANVAS_SCHEMA_VERSION,
              blocks: [design],
            },
          },
          context,
        }),
      );
    // An id is not markup, so the acknowledgement does not cover it.
    expect(
      share({ ...onboardingFlowExample, blockId: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
    ).toBe("unsafe-payload");
    expect(
      share({
        ...onboardingFlowExample,
        frames: [
          {
            frameId: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            title: "Welcome",
            html: "<p>Hello</p>",
          },
        ],
      }),
    ).toBe("unsafe-payload");
  });

  it("refuses an acknowledged design whose markup holds what reads as a credential", () => {
    const leaking = {
      ...onboardingFlowExample,
      frames: [
        {
          frameId: "welcome",
          title: "Welcome",
          html: "<p>Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to sign in.</p>",
        },
      ],
    };
    expect(
      shareDenial(() =>
        buildCanvasStaticExportReceipt({
          request: {
            ...request,
            consent: { ...request.consent, acknowledgedMarkupSharedAsWritten: true },
          },
          current: {
            ...current,
            schemaVersion: CANVAS_SCHEMA_VERSION,
            definition: {
              ...current.definition,
              schemaVersion: CANVAS_SCHEMA_VERSION,
              blocks: [leaking],
            },
          },
          context,
        }),
      ),
    ).toBe("unsafe-payload");
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

  it("scans a long run of scheme letters in linear time and still finds a URL after it", () => {
    const rich = (text: string) => ({
      request,
      current: {
        ...current,
        definition: {
          ...current.definition,
          blocks: [{ blockId: "rich-long", schemaVersion: 1, kind: "rich-text" as const, text }],
        },
      },
      context,
    });
    const started = performance.now();
    expect(() =>
      buildCanvasStaticExportReceipt(rich("A".repeat(CANVAS_MAX_TEXT_LENGTH))),
    ).not.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
    expect(() =>
      buildCanvasStaticExportReceipt(
        rich(`${"A".repeat(20_000)} see 1https://example.test/file?token=opaque-secret`),
      ),
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

describe("Canvas share of tabs, columns, diagram styles, and the Gantt view", () => {
  const brief = decodeCanvasVersion({
    ...current,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    definition: {
      ...current.definition,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      blocks: [...designBriefExample, launchGanttExample],
    },
  });

  it("round-trips the tabs, columns, every block they name, the styled diagrams, and the Gantt plan", () => {
    const receipt = buildCanvasStaticExportReceipt({ request, current: brief, context });
    expect(receipt.document.schemaVersion).toBeGreaterThanOrEqual(
      CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION,
    );
    const decoded = decodeCanvasStaticExportDocument(JSON.parse(JSON.stringify(receipt.document)));
    // A share names each block at most the newest version share version 9 represents.
    expect(decoded.blocks).toEqual(
      [...designBriefExample, launchGanttExample].map((block) => ({
        ...block,
        schemaVersion: Math.min(block.schemaVersion, CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION),
      })),
    );
  });

  it("is refused by a decoder that declares the previous share version", () => {
    const receipt = buildCanvasStaticExportReceipt({ request, current: brief, context });
    // The same diagram without its styles is one an older decoder reads...
    const plainLoop = receipt.document.blocks
      .filter((block) => block.blockId === "loop")
      .map((block) =>
        block.kind === "diagram"
          ? {
              ...block,
              schemaVersion: 14,
              edges: block.edges.map(({ style: _style, tone: _tone, ...edge }) => edge),
            }
          : block,
      );
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...receipt.document,
        schemaVersion: CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION - 1,
        blocks: plainLoop,
      }),
    ).not.toThrow();
    // ...but a styled diagram or a Gantt view alone is refused.
    for (const blockId of ["loop", "launch-plan"]) {
      expect(() =>
        decodeCanvasStaticExportDocument({
          ...receipt.document,
          schemaVersion: CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION - 1,
          blocks: receipt.document.blocks
            .filter((block) => block.blockId === blockId)
            .map((block) => ({ ...block, schemaVersion: 14 })),
        }),
      ).toThrow();
    }
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...receipt.document,
        schemaVersion: CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION - 1,
      }),
    ).toThrow();
  });
});

describe("a public link's payload", () => {
  const atVersion = (blocks: ReadonlyArray<unknown>) =>
    decodeCanvasVersion({
      ...current,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      definition: {
        ...current.definition,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        provenance: { ...current.definition.provenance, mode: "work" },
        blocks,
      },
    });
  const publishedAt = "2026-10-20T10:00:00.000Z";

  it("is the filtered share document without host, Project, thread, Canvas, or source identity", () => {
    const payload = buildCanvasPublicShareDocument({
      definition: atVersion(current.definition.blocks).definition,
      publishedAt,
      markupAcknowledged: false,
    });
    const snapshot = buildCanvasStaticExportDocument({
      request: decodeCanvasStaticExportRequest(request),
      current: atVersion(current.definition.blocks),
      exportedAt: publishedAt,
    });
    expect(payload.blocks).toEqual(snapshot.blocks);
    const wire = JSON.stringify(payload);
    for (const id of [ids.canvas, ids.version, ids.project, ids.thread, ids.source, ids.provider]) {
      expect(wire).not.toContain(id);
    }
    expect(payload).not.toHaveProperty("provenance");
    expect(payload).not.toHaveProperty("sourceManifest");
  });

  it("carries a design's frames only with the acknowledgement, and never its declared images", () => {
    const design = {
      ...onboardingFlowExample,
      assets: [{ assetId: "shot", source: { kind: "project-file", path: "screens/home.png" } }],
    };
    expect(
      shareDenial(() =>
        buildCanvasPublicShareDocument({
          definition: atVersion([design]).definition,
          publishedAt,
          markupAcknowledged: false,
        }),
      ),
    ).toBe("consent-required");
    const payload = buildCanvasPublicShareDocument({
      definition: atVersion([design]).definition,
      publishedAt,
      markupAcknowledged: true,
    });
    expect(payload.blocks[0]).not.toHaveProperty("assets");
    expect(JSON.stringify(payload)).not.toContain("screens/home.png");
  });

  it("refuses an action block", () => {
    const action = {
      blockId: "action-1",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "action",
      label: "Refresh",
      command: { command: "canvas.request-refresh" },
    };
    expect(
      shareDenial(() =>
        buildCanvasPublicShareDocument({
          definition: atVersion([action]).definition,
          publishedAt,
          markupAcknowledged: true,
        }),
      ),
    ).toBe("unsafe-payload");
  });

  it("takes its link-preview summary from the first reading text", () => {
    const payload = buildCanvasPublicShareDocument({
      definition: atVersion([
        ...current.definition.blocks,
        { blockId: "body", schemaVersion: 1, kind: "rich-text", text: "We **ship** on Friday." },
      ]).definition,
      publishedAt,
      markupAcknowledged: false,
    });
    expect(payload.summary).toBe("We ship on Friday.");
  });
});

/** A chart as share version 11 carries it: its readings, without title or callouts. */
function withoutChartCallouts(block: {
  readonly kind: string;
  readonly schemaVersion: number;
}): Record<string, unknown> {
  if (block.kind !== "chart" || !("series" in block) || !Array.isArray(block.series)) {
    return block;
  }
  const { title: _title, subtitle: _subtitle, ...chart } = block as Record<string, unknown>;
  return {
    ...chart,
    series: block.series.map((series: { readonly points: ReadonlyArray<object> }) => ({
      ...series,
      points: series.points.map((point) => {
        const { note: _note, emphasis: _emphasis, ...reading } = point as Record<string, unknown>;
        return reading;
      }),
    })),
  };
}
