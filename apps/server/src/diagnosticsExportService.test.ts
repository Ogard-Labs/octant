import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decodeDiagnosticsExportRequest } from "@octant/contracts";
import {
  decodeCodeDebugSessionEnded,
  decodeCodeDebugSessionStarted,
} from "@octant/contracts/code-debug";
import { serializeDiagnosticsEvidencePacket } from "@octant/domain";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { readDiagnosticsExportReceipt } from "./persistence/diagnosticsExportProjection";
import { Journal } from "./persistence/journal";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { DebugSessionRecords } from "./code/debugSessionRecords";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";
import {
  exportDiagnosticsEvidence,
  recordDiagnosticsFailureIncident,
} from "./diagnosticsExportService";

const directories: Array<string> = [];
let counter = 0;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): { readonly connection: SqliteConnection; readonly journal: Journal } {
  const directory = mkdtempSync(join(tmpdir(), "octant-diagnostics-export-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-08-10T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  return {
    connection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-08-10T12:00:00.000Z",
    }),
  };
}

function deps(store: { readonly connection: SqliteConnection; readonly journal: Journal }) {
  return {
    connection: store.connection,
    journal: store.journal,
    octantVersion: "0.0.0-test",
    clock: () => "2026-08-10T12:00:00.000Z",
    idGenerator: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
  };
}

function request(input: {
  readonly correlationId: string;
  readonly domain: string;
  readonly summary: string;
}) {
  return decodeDiagnosticsExportRequest(input);
}

function recordFailure(
  store: { readonly connection: SqliteConnection; readonly journal: Journal },
  correlationId: string,
  domain: "provider" | "network",
  observedAt = "2026-08-10T11:59:00.000Z",
): void {
  recordDiagnosticsFailureIncident(
    {
      correlationId: correlationId as never,
      domain,
      failureCode: (domain === "provider" ? "provider-failed" : "network-unavailable") as never,
      observedAt,
    },
    { journal: store.journal, eventIdGenerator: () => "00000000-0000-4000-8000-0000000000fe" },
  );
}

describe("exportDiagnosticsEvidence", () => {
  it("builds a sealed, redacted packet and persists a bounded receipt", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000001", "provider");
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "provider",
          summary: "Provider stopped responding after retrying twice.",
        }),
        deps(store),
      );
      expect(outcome.kind).toBe("exported");
      if (outcome.kind !== "exported") throw new Error("expected exported outcome");
      expect(outcome.packet.redacted).toBe(true);
      expect(outcome.packet.domain).toBe("provider");
      expect(outcome.packet.failureCode).toBe("provider-failed");
      expect(outcome.receipt.packetId).toBe(outcome.packet.packetId);
      expect(outcome.receipt.contentDigest).toMatch(/^[0-9a-f]{64}$/);

      expect(outcome.packet.candidateVersions).toContainEqual({
        component: "octant-server",
        version: "0.0.0-test",
      });
      expect(outcome.receipt.contentDigest).toBe(
        createHash("sha256")
          .update(serializeDiagnosticsEvidencePacket(outcome.packet))
          .digest("hex"),
      );

      const stored = readDiagnosticsExportReceipt(store.connection, outcome.packet.packetId);
      expect(stored).toEqual(outcome.receipt);
    } finally {
      store.connection.close();
    }
  });

  it("carries journal growth as kind names and counts only, inside the digested packet", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000001", "provider");
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "provider",
          summary: "Provider stopped responding after retrying twice.",
        }),
        deps(store),
      );
      if (outcome.kind !== "exported") throw new Error("expected exported outcome");
      expect(outcome.packet.packetVersion).toBe(2);
      const growth = outcome.packet.journalGrowth;
      expect(growth?.days.at(-1)).toBe("2026-08-10");
      expect(growth?.kinds.map((entry) => entry.kind)).toContain("diagnostics-incident");
      expect(growth?.journalHead).toBeGreaterThan(0);
      expect(Object.keys(growth ?? {}).sort()).toEqual([
        "databaseBytes",
        "days",
        "generatedAt",
        "journalHead",
        "kinds",
      ]);
      const serialized = serializeDiagnosticsEvidencePacket(outcome.packet);
      expect(serialized).toContain('"journalGrowth"');
      expect(outcome.receipt.contentDigest).toBe(
        createHash("sha256").update(serialized).digest("hex"),
      );
    } finally {
      store.connection.close();
    }
  });

  it("carries the host's counters beside journal growth in one version 2 packet", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000001", "provider");
      const health = {
        slowStatementCount: 3,
        slowStatementWorstMs: 120,
        eventLoopLagCount: 1,
        eventLoopLagWorstMs: 340,
      };
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "provider",
          summary: "Provider stopped responding after retrying twice.",
        }),
        { ...deps(store), hostHealth: () => health },
      );
      if (outcome.kind !== "exported") throw new Error("expected exported outcome");
      expect(outcome.packet.packetVersion).toBe(2);
      expect(outcome.packet.hostHealth).toEqual(health);
      expect(outcome.packet.journalGrowth).toBeDefined();
      const serialized = serializeDiagnosticsEvidencePacket(outcome.packet);
      expect(outcome.receipt.contentDigest).toBe(
        createHash("sha256").update(serialized).digest("hex"),
      );
    } finally {
      store.connection.close();
    }
  });

  it("counts debug sessions by end reason in a version 3 packet, naming no session", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000001", "provider");
      let ids = 0;
      const actor = { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID };
      const records = (occurredAt: string) =>
        new DebugSessionRecords({
          journal: store.journal,
          personActor: actor,
          hostActor: actor,
          uuid: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`,
          clock: () => occurredAt,
        });
      const session = (index: number, endReason?: "stopped" | "program-exited") => {
        const named = {
          sessionId: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
          projectId: "00000000-0000-4000-8000-0000000000b1",
          threadId: "00000000-0000-4000-8000-0000000000c1",
          configurationDigest: `sha256:${"a".repeat(64)}`,
        };
        // One session started before the window: only its end is counted.
        const startedAt = index === 0 ? "2026-07-01T00:00:00.000Z" : "2026-08-09T10:00:00.000Z";
        records(startedAt).started(
          decodeCodeDebugSessionStarted({
            ...named,
            checkoutId: "00000000-0000-4000-8000-0000000000d1",
            network: "proxied",
          }),
        );
        if (endReason !== undefined) {
          records("2026-08-09T10:05:00.000Z").ended(
            decodeCodeDebugSessionEnded({ ...named, endReason }),
          );
        }
      };
      session(0, "stopped");
      session(1, "stopped");
      session(2, "program-exited");
      session(3);

      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "provider",
          summary: "Provider stopped responding after retrying twice.",
        }),
        deps(store),
      );
      if (outcome.kind !== "exported") throw new Error("expected exported outcome");
      expect(outcome.packet.packetVersion).toBe(3);
      expect(outcome.packet.debugSessions).toEqual({
        since: "2026-07-28",
        started: 3,
        ended: [
          { endReason: "stopped", count: 2 },
          { endReason: "program-exited", count: 1 },
        ],
      });
      const serialized = serializeDiagnosticsEvidencePacket(outcome.packet);
      expect(serialized).not.toContain("00000000-0000-4000-9000-");
      expect(serialized).not.toContain("0000000000c1");
      expect(outcome.receipt.contentDigest).toBe(
        createHash("sha256").update(serialized).digest("hex"),
      );
    } finally {
      store.connection.close();
    }
  });

  it("redacts a secret embedded in the user-supplied summary before sealing", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000001", "provider");
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "provider",
          summary: "Failed with Authorization: Bearer abcdef123456 while calling the provider.",
        }),
        deps(store),
      );
      expect(outcome.kind).toBe("exported");
      if (outcome.kind !== "exported") throw new Error("expected exported outcome");
      expect(outcome.packet.summary).not.toContain("abcdef123456");
      expect(outcome.packet.redactions).toContain("credential");
    } finally {
      store.connection.close();
    }
  });

  it("anchors the packet to the reported failure correlation", () => {
    const store = setup();
    const correlationId = "00000000-0000-4000-8000-000000000099";
    try {
      recordFailure(store, correlationId, "provider", "2026-08-10T11:58:00.000Z");
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId,
          domain: "provider",
          summary: "Provider stopped responding.",
        }),
        deps(store),
      );
      expect(outcome.kind).toBe("exported");
      if (outcome.kind !== "exported") throw new Error("expected exported outcome");
      expect(outcome.packet.correlations).toEqual([
        { correlationId, observedAt: "2026-08-10T11:58:00.000Z" },
      ]);
    } finally {
      store.connection.close();
    }
  });

  it("fails closed without persisting anything when the domain policy rejects the input", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000001", "provider");
      const outcome = exportDiagnosticsEvidence(
        // A multi-line summary cannot be reduced to the single-line safe-text
        // allowlist, which the redaction policy must refuse rather than seal.
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "provider",
          summary: "line one\nline two",
        }),
        deps(store),
      );
      expect(outcome.kind).toBe("failed");
      const rows = store.connection
        .prepare("SELECT COUNT(*) AS count FROM diagnostics_export_receipt_projection")
        .get() as { readonly count: number };
      expect(rows.count).toBe(0);
    } finally {
      store.connection.close();
    }
  });

  it("fails closed and reports no fabricated packet when persistence fails", () => {
    const store = setup();
    recordFailure(store, "00000000-0000-4000-8000-000000000001", "network");
    store.connection.close();
    try {
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000001",
          domain: "network",
          summary: "Connection reset while streaming a response.",
        }),
        deps(store),
      );
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("expected failed outcome");
      expect(outcome.failure.category).toBe("persistence-failed");
    } finally {
      // already closed
    }
  });

  it("fails closed when the correlation is not a journal-recorded failed incident", () => {
    const store = setup();
    try {
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000099",
          domain: "provider",
          summary: "Provider stopped responding.",
        }),
        deps(store),
      );
      expect(outcome).toMatchObject({
        kind: "failed",
        failure: { category: "incomplete" },
      });
    } finally {
      store.connection.close();
    }
  });

  it("fails closed when the reported failure domain does not match the journal", () => {
    const store = setup();
    try {
      recordFailure(store, "00000000-0000-4000-8000-000000000099", "network");
      const outcome = exportDiagnosticsEvidence(
        request({
          correlationId: "00000000-0000-4000-8000-000000000099",
          domain: "provider",
          summary: "Provider stopped responding.",
        }),
        deps(store),
      );
      expect(outcome).toMatchObject({
        kind: "failed",
        failure: { category: "invalid-input" },
      });
    } finally {
      store.connection.close();
    }
  });
});
