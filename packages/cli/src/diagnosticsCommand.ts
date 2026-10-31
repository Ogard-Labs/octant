import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  decodeSupportBundleOutcome,
  decodeSupportBundlePreview,
  type SupportBundleFile,
} from "@octant/contracts";
import {
  buildSupportBundleZip,
  categorizeSupportBundleDestination,
  supportBundleEntriesLabel,
} from "@octant/domain";
import type { OpenedLocalControlSession } from "./localControl";

export interface DiagnosticsCliCommand {
  readonly action: "export";
  /** Where to save: a `.zip` file, or a folder that is new or empty. Absent with `--list`. */
  readonly out?: string;
  /** Print what a bundle would hold and save nothing. */
  readonly listOnly: boolean;
}

export function resolveDiagnosticsCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): DiagnosticsCliCommand | undefined {
  if (positional.length !== 1 || positional[0] !== "export") return undefined;
  const names = Object.keys(flags);
  if (names.some((name) => name !== "out" && name !== "list")) return undefined;
  const listOnly = flags.list === true;
  if (flags.list !== undefined && flags.list !== true) return undefined;
  const out = flags.out;
  if (listOnly) return out === undefined ? { action: "export", listOnly } : undefined;
  if (typeof out !== "string" || out.trim() === "") return undefined;
  return { action: "export", out: out.trim(), listOnly };
}

export interface RunDiagnosticsCliCommandInput {
  readonly command: DiagnosticsCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly cwd: string;
  readonly home: string;
  readonly now?: () => Date;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

function errorText(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["error", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return fallback;
}

function writeFolder(
  directory: string,
  files: ReadonlyArray<SupportBundleFile>,
): string | undefined {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    return "That folder already has files in it. Choose a new or empty folder.";
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    writeFileSync(join(directory, file.path), file.contents, { encoding: "utf8", mode: 0o600 });
  }
  return undefined;
}

export async function runDiagnosticsCliCommand(
  input: RunDiagnosticsCliCommandInput,
): Promise<number> {
  const { command, session } = input;

  const listing = await session.send({ path: "/api/diagnostics/bundle/preview", method: "GET" });
  if (listing.status !== 200) {
    input.stderr.write(`${errorText(listing.body, "Octant could not list the support bundle.")}\n`);
    return 1;
  }
  let preview;
  try {
    preview = decodeSupportBundlePreview(listing.body);
  } catch {
    input.stderr.write("Octant returned an unusable support bundle list.\n");
    return 1;
  }
  input.stdout.write("A support bundle holds:\n");
  for (const section of preview.sections) {
    const count = section.available ? supportBundleEntriesLabel(section.entries) : "not available";
    input.stdout.write(`  ${section.title} (${count}): ${section.includes}\n`);
  }
  input.stdout.write("It never holds:\n");
  for (const line of preview.neverIncluded) input.stdout.write(`  ${line}\n`);
  if (command.listOnly || command.out === undefined) return 0;

  const target = resolve(input.cwd, command.out);
  const asZip = target.toLowerCase().endsWith(".zip");
  if (asZip && existsSync(target)) {
    input.stderr.write("That file already exists. Choose a new file name.\n");
    return 1;
  }
  const exported = await session.send({
    path: "/api/diagnostics/bundle",
    method: "POST",
    body: { destinationCategory: categorizeSupportBundleDestination(target, input.home) },
  });
  if (exported.status !== 200 && exported.status !== 422) {
    input.stderr.write(
      `${errorText(exported.body, "Octant could not build the support bundle.")}\n`,
    );
    return 1;
  }
  let outcome;
  try {
    outcome = decodeSupportBundleOutcome(exported.body);
  } catch {
    input.stderr.write("Octant returned an unusable support bundle.\n");
    return 1;
  }
  if (outcome.kind === "failed") {
    input.stderr.write(`${outcome.message}\n`);
    return 1;
  }
  try {
    if (asZip) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        buildSupportBundleZip(outcome.files, (input.now ?? (() => new Date()))()),
        { mode: 0o600, flag: "wx" },
      );
    } else {
      const refusal = writeFolder(target, outcome.files);
      if (refusal !== undefined) {
        input.stderr.write(`${refusal}\n`);
        return 1;
      }
    }
  } catch {
    input.stderr.write("Octant could not write the support bundle there. Nothing was saved.\n");
    return 1;
  }
  input.stdout.write(`Saved ${outcome.files.length} files to ${command.out}. Nothing was sent.\n`);
  return 0;
}
