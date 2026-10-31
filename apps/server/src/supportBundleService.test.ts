import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeProviderInstance, decodeProviderObservedState } from "@octant/contracts";
import { SUPPORT_BUNDLE_SECTIONS } from "@octant/domain";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { recordDiagnosticsFailureIncident } from "./diagnosticsExportService";
import {
  exportSupportBundle,
  previewSupportBundle,
  type SupportBundleSources,
} from "./supportBundleService";

const HOME = "/Users/ada";
const SEEDED_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const MESSAGE_BODY = "please summarise the Q3 layoff plan for Ada";
const NOW = "2026-10-31T10:00:00.000Z";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store(): { readonly connection: SqliteConnection; readonly journal: Journal } {
  const directory = mkdtempSync(join(tmpdir(), "octant-support-bundle-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const runtime = createPhase1RuntimeRegistries();
  return {
    connection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => NOW,
    }),
  };
}

const CLAUDE_ID = "80000000-0000-4000-8000-000000000001";
const instances = [
  decodeProviderInstance({
    id: CLAUDE_ID,
    displayName: `Provider for ${MESSAGE_BODY}`,
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: `${HOME}/bin/codex` },
  }),
  decodeProviderInstance({
    id: "80000000-0000-4000-8000-000000000002",
    displayName: "Off",
    enabled: false,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: `${HOME}/bin/opencode` },
  }),
];
const observed = [
  decodeProviderObservedState({
    instanceId: CLAUDE_ID,
    readiness: "ready",
    processState: "running",
    detectedVersion: "2.1.211",
    models: [],
    capabilities: Object.fromEntries(
      [
        "streaming",
        "resume",
        "interruption",
        "approvals",
        "userQuestions",
        "reasoning",
        "usage",
        "toolActivity",
        "fileChanges",
        "diffs",
        "taskProgress",
        "nativeChildAgents",
        "nativeAttachments",
        "nativeWebResearch",
        "appManagedTools",
        "citations",
        "harnessAutoReview",
      ].map((name) => [name, "supported"]),
    ),
    message: `Signed in as ada, token ${SEEDED_KEY}`,
    observedAt: NOW,
  }),
];

function sources(
  base: ReturnType<typeof store>,
  overrides: Partial<SupportBundleSources> = {},
): SupportBundleSources {
  return {
    connection: base.connection,
    journal: base.journal,
    octantVersion: "0.9.0-test",
    homeDirectories: [HOME],
    clock: () => NOW,
    idGenerator: () => "00000000-0000-4000-8000-0000000000b1",
    eventIdGenerator: () => "00000000-0000-4000-8000-0000000000e1",
    providers: () => ({ instances, observed }),
    readHostLog: async () => [
      {
        timestamp: "2026-10-31T09:59:00.000Z",
        level: "error",
        event: "provider.failed",
        message: `Refused with api_key=${SEEDED_KEY} opening ${HOME}/Dev/private-plan/notes.md`,
      },
    ],
    codeSettings: () => undefined,
    codeThreadPolicies: () => ["approval-gated", "approval-gated", "full-access"],
    platformCapabilities: ["platform:sandbox-exec"],
    hostDiagnostics: () => ({
      identity: { hostId: "h", instanceId: "i", endpoint: "e", serviceMode: "foreground" },
      version: { server: "0.9.0-test", wire: "1" },
      store: { state: "ready", integrity: "ok" },
      replay: { journalHead: 1, projections: 1 },
      clients: { connected: 1 },
      capabilities: ["local-loopback"],
      work: { active: 0, attentionRequired: false },
      uptimeSeconds: 120,
    }),
    hostHealth: () => ({
      slowStatementCount: 0,
      slowStatementWorstMs: 0,
      eventLoopLagCount: 0,
      eventLoopLagWorstMs: 0,
    }),
    ...overrides,
  };
}

function seedJournalWithMessageBody(base: ReturnType<typeof store>): void {
  recordDiagnosticsFailureIncident(
    {
      correlationId: "00000000-0000-4000-8000-000000000001" as never,
      domain: "provider",
      failureCode: "provider-failed" as never,
      observedAt: NOW,
    },
    { journal: base.journal, eventIdGenerator: () => "00000000-0000-4000-8000-0000000000fe" },
  );
  // A real journal row carries the person's text in its payload; the bundle
  // must read the event's name and time and never the payload column.
  base.connection
    .prepare("UPDATE event_journal SET payload_json = ?")
    .run(JSON.stringify({ text: MESSAGE_BODY, token: SEEDED_KEY, path: `${HOME}/Dev/x` }));
}

function filesOf(outcome: Awaited<ReturnType<typeof exportSupportBundle>>) {
  if (outcome.kind !== "exported") throw new Error("expected an exported bundle");
  return outcome.files;
}

describe("exportSupportBundle", () => {
  it("writes every listed section and journals the export by category without a path", async () => {
    const base = store();
    seedJournalWithMessageBody(base);
    const outcome = await exportSupportBundle({ destinationCategory: "downloads" }, sources(base));
    const files = filesOf(outcome);
    expect(files.map((file) => file.path)).toEqual([
      "readme.txt",
      ...SUPPORT_BUNDLE_SECTIONS.map((section) => section.file),
    ]);
    const byPath = (path: string) =>
      JSON.parse(files.find((file) => file.path === path)!.contents) as Record<string, any>;
    expect(byPath("versions.json").octant).toBe("0.9.0-test");
    expect(byPath("system.json").architecture).toBeTypeOf("string");
    expect(byPath("providers.json").enabled).toHaveLength(1);
    expect(byPath("providers.json").enabled[0]).toMatchObject({
      ref: "codex-1",
      readiness: "ready",
      detectedVersion: "2.1.211",
    });
    expect(byPath("providers.json").enabled[0].capabilities.streaming).toBe("supported");
    expect(byPath("providers.json").disabledCount).toBe(1);
    expect(byPath("host-log.json").lines[0].event).toBe("provider.failed");
    expect(byPath("journal-events.json").events[0].name).toBe(
      "diagnostics.failure-incident-recorded@2",
    );
    expect(byPath("confinement.json").threadsByExecutionPolicy).toEqual({
      "approval-gated": 2,
      "full-access": 1,
    });
    expect(byPath("process.json").uptimeSeconds).toBe(120);

    const row = base.connection
      .prepare(
        "SELECT event_name AS name, occurred_at AS at, payload_json AS payload FROM event_journal WHERE event_name = ?",
      )
      .get("diagnostics.support-bundle-exported@1") as {
      name: string;
      at: string;
      payload: string;
    };
    expect(row.at).toBe(NOW);
    const recorded = JSON.parse(row.payload).receipt;
    expect(recorded.destinationCategory).toBe("downloads");
    expect(recorded.fileCount).toBe(files.length);
    expect(row.payload).not.toContain(MESSAGE_BODY);
    expect(row.payload).not.toContain(HOME);
    expect(row.payload).not.toContain("readiness");
  });

  it("never carries a seeded secret, a message body, or the full home path", async () => {
    const base = store();
    seedJournalWithMessageBody(base);
    const text = filesOf(
      await exportSupportBundle({ destinationCategory: "browser-download" }, sources(base)),
    )
      .map((file) => file.contents)
      .join("\n");
    expect(text).not.toContain(SEEDED_KEY);
    expect(text).not.toContain(MESSAGE_BODY);
    expect(text).not.toContain(HOME);
    expect(text).not.toContain("layoff");
    expect(text).toContain("~/Dev/private-plan/notes.md");
  });

  it("leaves a section that cannot be read marked not available and still saves the rest", async () => {
    const base = store();
    const outcome = await exportSupportBundle(
      { destinationCategory: "other-folder" },
      sources(base, {
        readHostLog: async () => {
          throw new Error(`cannot open ${HOME}/log`);
        },
        providers: () => {
          throw new Error("registry offline");
        },
      }),
    );
    const files = filesOf(outcome);
    expect(JSON.parse(files.find((f) => f.path === "host-log.json")!.contents)).toEqual({
      available: false,
    });
    expect(JSON.parse(files.find((f) => f.path === "providers.json")!.contents)).toEqual({
      available: false,
    });
    expect(JSON.parse(files.find((f) => f.path === "versions.json")!.contents).available).toBe(
      true,
    );
    if (outcome.kind === "exported") {
      expect(outcome.receipt.sections).not.toContain("host-log");
    }
  });

  it("offers no bundle when the export cannot be recorded", async () => {
    const base = store();
    const outcome = await exportSupportBundle(
      { destinationCategory: "downloads" },
      sources(base, {
        journal: {
          append: () => {
            throw new Error("disk full");
          },
        },
      }),
    );
    expect(outcome).toEqual({
      kind: "failed",
      message: "The support bundle could not be recorded, so nothing was saved.",
    });
  });
});

describe("exportSupportBundle with a staged write", () => {
  const stage = () => {
    const calls: string[] = [];
    return {
      calls,
      stage: () => {
        calls.push("stage");
        return {
          commit: () => calls.push("commit"),
          abort: () => calls.push("abort"),
        };
      },
    };
  };

  it("puts the file in place only after the export is journaled", async () => {
    const base = store();
    const staged = stage();
    const outcome = await exportSupportBundle(
      { destinationCategory: "chosen-by-person" },
      sources(base),
      staged.stage,
    );
    expect(outcome.kind).toBe("exported");
    expect(staged.calls).toEqual(["stage", "commit"]);
  });

  it("takes the staged file back when the export cannot be recorded", async () => {
    const base = store();
    const staged = stage();
    const outcome = await exportSupportBundle(
      { destinationCategory: "chosen-by-person" },
      sources(base, {
        journal: {
          append: () => {
            throw new Error("disk full");
          },
        },
      }),
      staged.stage,
    );
    expect(outcome.kind).toBe("failed");
    expect(staged.calls).toEqual(["stage", "abort"]);
  });
});

describe("previewSupportBundle", () => {
  it("lists the sections with live counts and records nothing", async () => {
    const base = store();
    const preview = await previewSupportBundle(sources(base));
    expect(preview.sections.map((section) => section.id)).toEqual(
      SUPPORT_BUNDLE_SECTIONS.map((section) => section.id),
    );
    expect(preview.sections.find((section) => section.id === "providers")?.entries).toBe(1);
    expect(preview.sections.find((section) => section.id === "host-log")?.entries).toBe(1);
    const recorded = base.connection
      .prepare("SELECT count(*) AS n FROM event_journal WHERE event_name = ?")
      .get("diagnostics.support-bundle-exported@1") as { n: number };
    expect(recorded.n).toBe(0);
  });
});
