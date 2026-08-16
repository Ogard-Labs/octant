import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import {
  decodeDiagnosticsExportRequest,
  type DiagnosticsExportOutcome,
  type DiagnosticsExportRequest,
} from "@octant/contracts";
import {
  serializeDiagnosticsEvidencePacket,
  type DiagnosticsExportAuthorization,
} from "@octant/domain";
/**
 * Non-executable command adapter for a future authenticated host boundary.
 * The technical preview deliberately has no standalone diagnostics CLI: a
 * process launched from a shell cannot prove it represents the authenticated
 * local user. The supported product surface is the authenticated Settings
 * route. This module has no `import.meta.main` handler and no package script.
 */

export interface DiagnosticsExportCommandServices {
  readonly runExport: (request: DiagnosticsExportRequest) => DiagnosticsExportOutcome;
  readonly writeFile: (path: string, contents: string) => void;
  readonly authorize?: () => DiagnosticsExportAuthorization;
}

export interface DiagnosticsExportCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const usage = [
  "Diagnostics export is available only through the authenticated Octant Settings flow.",
  "A standalone diagnostics export command is not supported.",
].join("\n");

interface ParsedArgs {
  readonly correlationId: string;
  readonly domain: string;
  readonly summary: string;
  readonly out?: string;
}

function parseArgs(
  args: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly value: ParsedArgs }
  | { readonly ok: false; readonly message: string } {
  const map = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) {
      return { ok: false, message: `Unexpected argument: ${flag ?? ""}` };
    }
    const value = args[index + 1];
    if (value === undefined) {
      return { ok: false, message: `Missing value for ${flag}.` };
    }
    map.set(flag.slice(2), value);
    index += 1;
  }
  const correlationId = map.get("correlation-id");
  const domain = map.get("domain");
  const summary = map.get("summary");
  if (correlationId === undefined) return { ok: false, message: "--correlation-id is required." };
  if (domain === undefined) return { ok: false, message: "--domain is required." };
  if (summary === undefined) return { ok: false, message: "--summary is required." };
  const out = map.get("out");
  return {
    ok: true,
    value:
      out === undefined
        ? { correlationId, domain, summary }
        : { correlationId, domain, summary, out },
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function runDiagnosticsExportCommand(
  args: ReadonlyArray<string>,
  services: DiagnosticsExportCommandServices,
): DiagnosticsExportCommandResult {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${usage}\n` };
  }

  const authorization = services.authorize?.() ?? {
    kind: "denied" as const,
    reason: "actor-not-local-host" as const,
  };
  if (authorization.kind === "denied") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: prettyJson({
        ok: false,
        error: {
          category: "unauthorized",
          message: "Diagnostics export requires a local authenticated user.",
        },
      }),
    };
  }

  let request: DiagnosticsExportRequest;
  try {
    request = decodeDiagnosticsExportRequest({
      correlationId: parsed.value.correlationId,
      domain: parsed.value.domain,
      summary: parsed.value.summary,
    });
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Invalid --domain or --summary.\n${usage}\n`,
    };
  }

  const outcome = services.runExport(request);
  if (outcome.kind === "failed") {
    return { exitCode: 1, stdout: "", stderr: prettyJson({ ok: false, error: outcome.failure }) };
  }

  if (parsed.value.out === undefined) {
    return { exitCode: 0, stdout: prettyJson(outcome), stderr: "" };
  }

  try {
    services.writeFile(parsed.value.out, serializeDiagnosticsEvidencePacket(outcome.packet));
  } catch (error) {
    // The receipt was already persisted server-side before this local write
    // was attempted; report the write failure precisely instead of hiding a
    // successful, already-recorded export behind a generic error.
    return {
      exitCode: 1,
      stdout: "",
      stderr: prettyJson({
        ok: false,
        error: {
          category: "local-write-failed",
          message: error instanceof Error ? error.message : String(error),
        },
        receipt: outcome.receipt,
      }),
    };
  }

  return {
    exitCode: 0,
    stdout: prettyJson({ path: parsed.value.out, receipt: outcome.receipt }),
    stderr: "",
  };
}

/**
 * Atomic write-then-rename with guaranteed temp-file cleanup on any failure,
 * so a failed export never leaves a partial or orphaned file on disk.
 */
export function writeDiagnosticsPacketFile(path: string, contents: string): void {
  const tempPath = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; the original error is what the caller sees.
    }
    throw error;
  }
}
