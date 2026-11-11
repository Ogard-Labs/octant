import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  decodeCanvasVersion,
  type CanvasVersion,
} from "@octant/contracts/canvas";
import {
  admitCanvasDesignSystemApply,
  canvasDesignSystemProperties,
  canvasDesignSystemSeries,
} from "./canvasDesignSystemPolicy";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  nextVersion: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
  thread: "55555555-5555-4555-8555-555555555555",
  provider: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
} as const;
const actor = { kind: "local-user" as const, actorId: ids.actor };
const now = "2026-08-01T21:00:00.000Z" as never;

const acme = {
  name: "Acme",
  source: "DESIGN.md",
  brand: { "color-primary": "#1a73e8", "color-secondary": "#0b8043", "color-chart-3": "#f9ab00" },
};
const site = { name: "Site", source: "apps/site/DESIGN.md", brand: { "color-primary": "#7c3aed" } };

function version(definitionExtras: Record<string, unknown> = {}): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Launch review",
      provenance: {
        mode: "work",
        hostId: "local",
        projectId: ids.project,
        threadId: ids.thread,
        actor,
        providerInstanceId: ids.provider,
        modelId: "octant-test-model",
        createdAt: now,
      },
      sourceManifest: [],
      blocks: [
        {
          blockId: "signups",
          schemaVersion: 1,
          kind: "metric",
          label: "Weekly signups",
          value: 1284,
        },
        {
          blockId: "cover",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "design",
          title: "Cover",
          size: "slide",
          theme: "brand",
          brand: acme.brand,
          frames: [{ frameId: "one", title: "One", html: "<h1>Launch</h1>" }],
        },
        {
          blockId: "own",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "design",
          title: "Own palette",
          size: "phone",
          frames: [{ frameId: "one", title: "One", html: "<p>Mine</p>" }],
        },
      ],
      ...definitionExtras,
    },
    createdBy: actor,
    createdAt: now,
  });
}

function apply(designSystem: unknown, resolved: typeof acme | undefined, current = version()) {
  return admitCanvasDesignSystemApply(
    {
      kind: "canvas-design-system-apply",
      canvasId: ids.canvas,
      versionId: ids.nextVersion,
      actor,
      expectedSequence: current.sequence,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      issuedAt: now,
      designSystem,
    },
    current,
    resolved,
    now,
  );
}

describe("a Canvas's design system", () => {
  it("gives typed blocks its chart palette, led by its primary and secondary colours", () => {
    expect(canvasDesignSystemSeries(acme.brand)).toEqual([
      "#1a73e8",
      "#0b8043",
      "#f9ab00",
      undefined,
      undefined,
      undefined,
    ]);
    expect(canvasDesignSystemProperties(acme)).toEqual([
      ["--oct-series-1", "#1a73e8"],
      ["--oct-series-2", "#0b8043"],
      ["--oct-series-3", "#f9ab00"],
      ["--oct-accent", "#1a73e8"],
    ]);
    // A chart palette the file names wins over the primary colour.
    expect(
      canvasDesignSystemSeries({ "color-primary": "#111111", "color-chart-1": "#222222" })[0],
    ).toBe("#222222");
  });

  it("writes no property a value could escape from", () => {
    expect(
      canvasDesignSystemProperties({ brand: { "color-primary": "red; } body { display: none" } }),
    ).toEqual([]);
    expect(canvasDesignSystemProperties(undefined)).toEqual([]);
  });

  it("is refused under a schema version that predates it", () => {
    const current = version({ designSystem: acme });
    expect(() => decodeCanvasDefinition({ ...current.definition, schemaVersion: 27 })).toThrow(
      /design system requires Canvas schema version 28/,
    );
  });

  it("swaps the whole document to another design system, redrawing brand designs and leaving others", () => {
    const result = apply(
      { folder: "/p", path: "apps/site/DESIGN.md" },
      { ...site, brand: site.brand } as never,
      version({ designSystem: acme }),
    );
    if (result.kind !== "accepted") throw new Error(result.message);
    expect(result.next.sequence).toBe(2);
    expect(result.next.definition.designSystem).toEqual(site);
    const designs = result.next.definition.blocks.filter((block) => block.kind === "design");
    expect(designs.map((block) => (block.kind === "design" ? block.brand : undefined))).toEqual([
      site.brand,
      undefined,
    ]);
  });

  it("stops following a design system without touching a design's own brand", () => {
    const result = apply(null, undefined, version({ designSystem: acme }));
    if (result.kind !== "accepted") throw new Error(result.message);
    expect(result.next.definition).not.toHaveProperty("designSystem");
    const cover = result.next.definition.blocks.find((block) => block.blockId === "cover");
    expect(cover?.kind === "design" ? cover.brand : undefined).toEqual(acme.brand);
  });

  it("refuses a stale head, an unresolved file, and switching off what is already off", () => {
    const current = version();
    expect(
      admitCanvasDesignSystemApply(
        {
          kind: "canvas-design-system-apply",
          canvasId: ids.canvas,
          versionId: ids.nextVersion,
          actor,
          expectedSequence: 7,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          issuedAt: now,
          designSystem: null,
        },
        current,
        undefined,
        now,
      ),
    ).toMatchObject({ code: "stale-version" });
    expect(apply({ folder: "/p", path: "DESIGN.md" }, undefined)).toMatchObject({
      code: "malformed-request",
    });
    expect(apply(null, undefined)).toMatchObject({ code: "malformed-request" });
  });
});
