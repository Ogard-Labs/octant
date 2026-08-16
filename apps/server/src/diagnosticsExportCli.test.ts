import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeDiagnosticsExportOutcome,
  type DiagnosticsExportOutcome,
  type DiagnosticsExportRequest,
} from "@octant/contracts";
import {
  runDiagnosticsExportCommand,
  writeDiagnosticsPacketFile,
  type DiagnosticsExportCommandServices,
} from "./diagnosticsExportCli";

const directories: Array<string> = [];
const correlationId = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-diagnostics-cli-"));
  directories.push(directory);
  return directory;
}

const exportedOutcome: DiagnosticsExportOutcome = decodeDiagnosticsExportOutcome({
  kind: "exported",
  packet: {
    packetVersion: 1,
    packetId: "00000000-0000-4000-8000-0000000000aa",
    domain: "provider",
    failureCode: "provider-support-export",
    summary: "Provider request timed out.",
    hostVersions: [{ component: "runtime", version: "v22.1.0" }],
    candidateVersions: [{ component: "runtime", version: "v22.1.0" }],
    correlations: [
      {
        correlationId: "00000000-0000-4000-8000-000000000001",
        observedAt: "2026-08-10T12:00:00.000Z",
      },
    ],
    recovery: [
      {
        action: "Verify provider credentials and network connectivity, then retry.",
        automated: false,
      },
    ],
    redactions: [],
    redacted: true,
    generatedAt: "2026-08-10T12:00:00.000Z",
  },
  receipt: {
    packetId: "00000000-0000-4000-8000-0000000000aa",
    domain: "provider",
    failureCode: "provider-support-export",
    redactions: [],
    contentDigest: "a".repeat(64),
    generatedAt: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T12:00:01.000Z",
  },
});

const failedOutcome: DiagnosticsExportOutcome = decodeDiagnosticsExportOutcome({
  kind: "failed",
  failure: { category: "incomplete", message: "A diagnostic summary is required." },
});

function servicesFor(outcome: DiagnosticsExportOutcome): DiagnosticsExportCommandServices {
  return {
    runExport: (_request: DiagnosticsExportRequest) => outcome,
    writeFile: writeDiagnosticsPacketFile,
    authorize: () => ({ kind: "allowed" }),
  };
}

describe("runDiagnosticsExportCommand", () => {
  it("fails closed without a trusted local-user authorization", () => {
    const runExport = vi.fn<DiagnosticsExportCommandServices["runExport"]>();
    const result = runDiagnosticsExportCommand(
      [
        "--correlation-id",
        correlationId,
        "--domain",
        "provider",
        "--summary",
        "Provider request timed out.",
      ],
      { runExport, writeFile: writeDiagnosticsPacketFile },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires a local authenticated user");
    expect(runExport).not.toHaveBeenCalled();
  });

  it("requires --domain and --summary", () => {
    const result = runDiagnosticsExportCommand([], servicesFor(exportedOutcome));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("standalone diagnostics export command is not supported");
  });

  it("prints the sealed outcome to stdout when no --out is given", () => {
    const result = runDiagnosticsExportCommand(
      [
        "--correlation-id",
        correlationId,
        "--domain",
        "provider",
        "--summary",
        "Provider request timed out.",
      ],
      servicesFor(exportedOutcome),
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { kind: string };
    expect(parsed.kind).toBe("exported");
  });

  it("writes the sealed packet to --out and reports the receipt", () => {
    const directory = tempDir();
    const outPath = join(directory, "packet.json");
    const result = runDiagnosticsExportCommand(
      [
        "--correlation-id",
        correlationId,
        "--domain",
        "provider",
        "--summary",
        "Provider request timed out.",
        "--out",
        outPath,
      ],
      servicesFor(exportedOutcome),
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    expect(written.packetId).toBe(
      exportedOutcome.kind === "exported" ? exportedOutcome.packet.packetId : undefined,
    );
    expect(readdirSync(directory)).toEqual(["packet.json"]);
  });

  it("exits 1 and writes no file when the domain policy rejects the input", () => {
    const directory = tempDir();
    const outPath = join(directory, "packet.json");
    const result = runDiagnosticsExportCommand(
      [
        "--correlation-id",
        correlationId,
        "--domain",
        "provider",
        "--summary",
        "x",
        "--out",
        outPath,
      ],
      servicesFor(failedOutcome),
    );
    expect(result.exitCode).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("leaves no partial or temporary file when the local write fails after a successful export", () => {
    const directory = tempDir();
    // A path inside a nonexistent subdirectory makes the rename step fail.
    const outPath = join(directory, "missing-subdir", "packet.json");
    const result = runDiagnosticsExportCommand(
      [
        "--correlation-id",
        correlationId,
        "--domain",
        "provider",
        "--summary",
        "Provider request timed out.",
        "--out",
        outPath,
      ],
      servicesFor(exportedOutcome),
    );
    expect(result.exitCode).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    // No stray `.tmp-*` file left behind in the parent directory either.
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("writeDiagnosticsPacketFile", () => {
  it("writes atomically and leaves no temp file on success", () => {
    const directory = tempDir();
    const outPath = join(directory, "packet.json");
    writeDiagnosticsPacketFile(outPath, JSON.stringify({ a: 1 }));
    expect(readdirSync(directory)).toEqual(["packet.json"]);
  });

  it("cleans up its temp file when the write target is unwritable", () => {
    const directory = tempDir();
    const outPath = join(directory, "missing-subdir", "packet.json");
    expect(() => writeDiagnosticsPacketFile(outPath, JSON.stringify({ a: 1 }))).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});
