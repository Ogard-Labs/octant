import { describe, expect, it } from "vitest";
import {
  SUPPORT_BUNDLE_SECTIONS,
  buildSupportBundleFiles,
  buildSupportBundleZip,
  categorizeSupportBundleDestination,
  describeSupportBundle,
  sanitizeSupportBundleText,
  type SupportBundleFacts,
} from "./supportBundlePolicy";

const HOME = "/Users/ada";
const SEEDED_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const MESSAGE_BODY = "please summarise the Q3 layoff plan for Ada";

const facts: SupportBundleFacts = {
  bundleId: "00000000-0000-4000-8000-000000000001",
  generatedAt: "2026-10-31T10:00:00.000Z",
  versions: { octant: "0.9.0", wire: "1", runtime: "bun 1.3.14" },
  system: {
    platform: "darwin",
    osRelease: "27.0.0",
    architecture: "arm64",
    cpuCount: 10,
    totalMemoryMb: 32768,
  },
  providers: {
    enabled: [
      {
        ref: "claude-1",
        driverKind: "claude",
        readiness: "ready",
        processState: "running",
        modelCount: 3,
        capabilities: { streaming: "supported", resume: "unsupported" },
      },
    ],
    disabledCount: 2,
  },
  hostLog: {
    lines: [
      {
        timestamp: "2026-10-31T09:59:00.000Z",
        level: "error",
        event: "provider.failed",
        message: `Provider refused with Authorization: Bearer ${SEEDED_KEY} while reading ${HOME}/Dev/secret-project/notes.md`,
      },
      {
        timestamp: "2026-10-31T09:59:30.000Z",
        level: "warn",
        event: "store.slow",
        message: "password is hunter2",
      },
    ],
  },
  journalEvents: {
    head: 41,
    events: [
      { sequence: 41, name: "chat.turn-accepted@1", occurredAt: "2026-10-31T09:58:00.000Z" },
    ],
  },
  confinement: {
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "ask",
    threadsByExecutionPolicy: { "approval-gated": 4, "full-access": 1 },
    platformCapabilities: ["platform:sandbox-exec"],
    remoteListenerEnabled: false,
  },
  process: {
    uptimeSeconds: 3600,
    memoryMb: { rss: 410, heapUsed: 120, heapTotal: 180, external: 12 },
    cpuMs: { user: 9000, system: 2000 },
    eventLoopLagCount: 0,
    eventLoopLagWorstMs: 0,
    slowStatementCount: 1,
    slowStatementWorstMs: 41,
    connectedClients: 1,
    activeSessions: 0,
    storeState: "ready",
    storeIntegrity: "ok",
    databaseBytes: 1_048_576,
  },
};

const allText = (files: ReadonlyArray<{ readonly contents: string }>): string =>
  files.map((file) => file.contents).join("\n");

describe("buildSupportBundleFiles", () => {
  it("writes a readme and one file per listed section", () => {
    const files = buildSupportBundleFiles(facts, [HOME]);
    expect(files.map((file) => file.path)).toEqual([
      "readme.txt",
      ...SUPPORT_BUNDLE_SECTIONS.map((section) => section.file),
    ]);
    const providers = JSON.parse(files.find((file) => file.path === "providers.json")!.contents);
    expect(providers.enabled[0]).toMatchObject({ driverKind: "claude", readiness: "ready" });
    const journal = JSON.parse(files.find((file) => file.path === "journal-events.json")!.contents);
    expect(journal.events).toEqual([
      { sequence: 41, name: "chat.turn-accepted@1", occurredAt: "2026-10-31T09:58:00.000Z" },
    ]);
  });

  it("never carries a seeded key, a natural-language password, or a full home path", () => {
    const text = allText(buildSupportBundleFiles(facts, [HOME]));
    expect(text).not.toContain(SEEDED_KEY);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(HOME);
    expect(text).toContain("~/Dev/secret-project/notes.md");
  });

  it("has no field a message body could travel in", () => {
    const text = allText(buildSupportBundleFiles(facts, [HOME]));
    expect(text).not.toContain(MESSAGE_BODY);
    const withBody = {
      ...facts,
      hostLog: {
        lines: [
          {
            timestamp: "2026-10-31T09:59:00.000Z",
            level: "info",
            event: "turn.done",
            message: "Turn finished.",
            content: MESSAGE_BODY,
            details: { prompt: MESSAGE_BODY },
          },
        ],
      },
    } as unknown as SupportBundleFacts;
    const log = JSON.parse(
      buildSupportBundleFiles(withBody, [HOME]).find((file) => file.path === "host-log.json")!
        .contents,
    );
    expect(Object.keys(log.lines[0]).sort()).toEqual(
      ["event", "level", "message", "timestamp"].sort(),
    );
  });

  it("says a section is not available instead of leaving it empty", () => {
    const { process: _process, ...withoutProcess } = facts;
    const files = buildSupportBundleFiles(withoutProcess, [HOME]);
    expect(JSON.parse(files.find((file) => file.path === "process.json")!.contents)).toEqual({
      available: false,
    });
    expect(files[0]!.contents).toContain("process.json: Process.");
    expect(files[0]!.contents).toContain("not available");
  });
});

describe("describeSupportBundle", () => {
  it("lists every section with its live entry count and what is never included", () => {
    const preview = describeSupportBundle(facts);
    expect(preview.sections.map((section) => section.id)).toEqual(
      SUPPORT_BUNDLE_SECTIONS.map((section) => section.id),
    );
    expect(preview.sections.find((section) => section.id === "host-log")).toMatchObject({
      entries: 2,
      available: true,
    });
    expect(preview.neverIncluded.join(" ")).toContain("API keys");
  });
});

describe("sanitizeSupportBundleText", () => {
  it("shortens the longest matching home first and redacts another person's home", () => {
    expect(sanitizeSupportBundleText("at /Users/ada/Dev/x", ["/Users/ada"])).toBe("at ~/Dev/x");
    expect(sanitizeSupportBundleText("at /Users/bob/Dev/x", ["/Users/ada"])).not.toContain("bob");
  });
});

describe("categorizeSupportBundleDestination", () => {
  it.each([
    ["/Users/ada/Downloads/octant.zip", "downloads"],
    ["/Users/ada/Desktop/out", "desktop"],
    ["/Users/ada/Documents/a/b.zip", "documents"],
    ["/Users/ada/octant.zip", "home-folder"],
    ["/private/var/folders/ab/T/octant", "temporary-folder"],
    ["/Volumes/Backup/octant.zip", "other-folder"],
    ["/Users/ada/Dev/octant.zip", "other-folder"],
  ])("files %s as %s", (path, category) => {
    expect(categorizeSupportBundleDestination(path, HOME)).toBe(category);
  });
});

describe("buildSupportBundleZip", () => {
  it("writes an archive whose central directory names every file and sizes", () => {
    const files = buildSupportBundleFiles(facts, [HOME]);
    const zip = buildSupportBundleZip(files, new Date("2026-10-31T10:00:00.000Z"));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const endOffset = zip.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(endOffset + 10, true)).toBe(files.length);
    let position = view.getUint32(endOffset + 16, true);
    const names: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      expect(view.getUint32(position, true)).toBe(0x02014b50);
      const size = view.getUint32(position + 24, true);
      const nameLength = view.getUint16(position + 28, true);
      names.push(new TextDecoder().decode(zip.subarray(position + 46, position + 46 + nameLength)));
      expect(size).toBe(new TextEncoder().encode(files[index]!.contents).length);
      position += 46 + nameLength;
    }
    expect(names).toEqual(files.map((file) => file.path));
  });
});
