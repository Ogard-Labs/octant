import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCodeCheckoutId, decodeEventActor, decodeProjectId } from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { LanguageServerApprovalStore } from "./languageServerApprovals";

const now = "2026-10-27T12:00:00.000Z";
const project = decodeProjectId("40000000-0000-4000-8000-000000000001");
const otherProject = decodeProjectId("40000000-0000-4000-8000-000000000002");
const checkout = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const otherCheckout = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000002");
const component = "extension:language-server:sha256:abc@4";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journal(): Journal {
  const root = mkdtempSync(join(tmpdir(), "octant-language-server-approvals-"));
  roots.push(root);
  const connection = openSqlite(join(root, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
}

function store(source: Pick<Journal, "append" | "replayAggregateType">) {
  return new LanguageServerApprovalStore({
    journal: source,
    personActor: decodeEventActor({
      kind: "local-user",
      actorId: "50000000-0000-4000-8000-000000000001",
    }),
    uuid: randomUUID,
    clock: () => now,
  });
}

describe("language server approvals", () => {
  it("covers one checkout, or every checkout of one Project, for the package state approved, and survives a restart", () => {
    const shared = journal();
    const approvals = store(shared);
    expect(approvals.holds({ projectId: project, checkoutId: checkout, component })).toBe(false);

    expect(
      approvals.record({ projectId: project, checkoutId: checkout, component, scope: "checkout" }),
    ).toBe("recorded");
    expect(approvals.holds({ projectId: project, checkoutId: checkout, component })).toBe(true);
    expect(approvals.holds({ projectId: project, checkoutId: otherCheckout, component })).toBe(
      false,
    );
    // Another package state of the same server, after an update or a switch, is not covered.
    expect(
      approvals.holds({
        projectId: project,
        checkoutId: checkout,
        component: "extension:language-server:sha256:abc@5",
      }),
    ).toBe(false);

    expect(
      approvals.record({
        projectId: project,
        checkoutId: checkout,
        component,
        scope: "project",
      }),
    ).toBe("recorded");
    expect(approvals.holds({ projectId: project, checkoutId: otherCheckout, component })).toBe(
      true,
    );
    expect(approvals.holds({ projectId: otherProject, checkoutId: checkout, component })).toBe(
      false,
    );

    // A restarted host rebuilds the same approvals from the journal, and its
    // next approval lands after them.
    const restarted = store(shared);
    expect(restarted.holds({ projectId: project, checkoutId: otherCheckout, component })).toBe(
      true,
    );
    expect(
      restarted.record({
        projectId: project,
        checkoutId: otherCheckout,
        component: "other",
        scope: "checkout",
      }),
    ).toBe("recorded");
  });

  it("holds nothing it could not journal", () => {
    const shared = journal();
    const approvals = store({
      replayAggregateType: (cursor) => shared.replayAggregateType(cursor),
      append: () => {
        throw new Error("journal unavailable");
      },
    });
    expect(
      approvals.record({ projectId: project, checkoutId: checkout, component, scope: "project" }),
    ).toBe("not-recorded");
    expect(approvals.holds({ projectId: project, checkoutId: checkout, component })).toBe(false);
  });
});
