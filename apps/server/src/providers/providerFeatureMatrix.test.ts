import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderCapabilities, ProviderDriverKind } from "@octant/contracts";
import { isImageProfileDriverKind, providerCatalogCapabilities } from "@octant/domain";
import { unsupportedChatCapabilities } from "@octant/provider-sdk/chat-conformance";
import { describe, expect, it } from "vitest";

/**
 * The "degraded on" matrix in the architecture's security section tells a
 * person what each provider can do beside Claude Code and Codex. Nothing else
 * makes the providers match, so a driver that changes a declaration, or a new
 * driver kind, would leave the matrix quietly wrong.
 *
 * What this proves: every `ProviderCapabilities` field has a row, every
 * non-image driver kind sits in exactly one column, the first token of each cell
 * equals what that driver's static capability block declares, and the mode
 * columns equal the provider catalog policy. What it does not prove: the words
 * after the first token, which describe what a probe or a first reply
 * refines, and the compaction rows, which drivers assign outside the static
 * blocks. A block is read from source because the declarations are module
 * constants that no driver exports and that a probe overwrites at run time;
 * building every driver to ask it would test the fixtures, not the declaration.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..", "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const architecture = read(join(repositoryRoot, "docs", "architecture.md"));
const matrixStart = architecture.indexOf('- **Provider capability matrix ("degraded on").**');
const matrixEnd = architecture.indexOf("- **ACP client capabilities.**");
const matrixSection = architecture.slice(matrixStart, matrixEnd);

type Declaration = "supported" | "unsupported" | "unavailable" | "absent" | "varies";
const declarations: ReadonlySet<string> = new Set<Declaration>([
  "supported",
  "unsupported",
  "unavailable",
  "absent",
  "varies",
]);

function tableRows(section: string, firstHeader: string): ReadonlyArray<ReadonlyArray<string>> {
  const lines = section.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith(`| ${firstHeader} `));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  // Drop the header rule.
  return [rows[0] ?? [], ...rows.slice(2)];
}

function leadingToken(cell: string): string | undefined {
  return /^`([a-z-]+)`/.exec(cell)?.[1] ?? /^(as)\b/.exec(cell)?.[1];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Index just past the brace that closes the one at `open`. */
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "`" || char === "'") {
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === "\\" ? 2 : 1;
      }
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced braces in a capability block.");
}

function topLevelEntries(body: string): ReadonlyArray<string> {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' || char === "`" || char === "'") {
      index += 1;
      while (index < body.length && body[index] !== char) index += body[index] === "\\" ? 2 : 1;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(body.slice(start));
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * What a static capability block declares, key by key. A value that is not a
 * single string literal is `varies`; a key the block never names is absent.
 */
function declaredCapabilities(
  file: string,
  anchors: ReadonlyArray<string>,
): ReadonlyMap<string, Declaration> {
  const source = stripComments(read(join(here, file)));
  let cursor = 0;
  for (const anchor of anchors) {
    const found = source.indexOf(anchor, cursor);
    if (found < 0) throw new Error(`${file} no longer contains \`${anchor}\`.`);
    cursor = found + anchor.length;
  }
  const open = cursor - 1;
  if (source[open] !== "{") throw new Error(`${file}: the last anchor must end at an open brace.`);
  const values = new Map<string, Declaration>();
  for (const entry of topLevelEntries(source.slice(open + 1, closingBrace(source, open)))) {
    if (entry.startsWith("...")) {
      const name = entry.slice(3).trim();
      const spread =
        name === "unsupportedChatCapabilities"
          ? new Map<string, Declaration>(
              Object.entries(unsupportedChatCapabilities).map(([key, value]) => [key, value]),
            )
          : declaredCapabilities(file, [`const ${name} = {`]);
      for (const [key, value] of spread) values.set(key, value);
      continue;
    }
    const colon = entry.indexOf(":");
    if (colon < 0) {
      values.set(entry, "varies");
      continue;
    }
    const literal = /^"(supported|unsupported|unavailable)"$/.exec(entry.slice(colon + 1).trim());
    values.set(entry.slice(0, colon).trim(), (literal?.[1] as Declaration | undefined) ?? "varies");
  }
  return values;
}

interface ColumnSource {
  readonly file: string;
  readonly anchors: ReadonlyArray<string>;
}

const COLUMN_SOURCES: Readonly<Record<string, ReadonlyArray<ColumnSource>>> = {
  "Claude Code": [
    {
      file: "claudeDriver.ts",
      anchors: ["const availableCapabilities: ProviderCapabilities = {"],
    },
  ],
  Codex: [{ file: "codexDriver.ts", anchors: ["const capabilities = {"] }],
  OpenCode: [{ file: "openCodeDriver.ts", anchors: ["const capabilities = {"] }],
  Pi: [{ file: "piDriver.ts", anchors: ["const capabilities = {"] }],
  "ACP agents": [{ file: "acpDriver.ts", anchors: ["function baseCapabilities(", "return {"] }],
  Ollama: [{ file: "ollamaEndpoint.ts", anchors: ["capabilities: {"] }],
  "Harness endpoints": [
    {
      file: "openAiCompatibleDriver.ts",
      anchors: ["const initialCapabilities: ProviderCapabilities = {"],
    },
    {
      file: "anthropicCompatibleDriver.ts",
      anchors: ["const initialCapabilities: ProviderCapabilities = {"],
    },
  ],
  // An outside driver package ships no capability block Octant reads; its
  // column is the host's ceiling clamp, which no driver claim can exceed.
  "Outside harness endpoints": [
    {
      file: "outsideDriverCeiling.ts",
      anchors: ["const outsideHarnessEndpointCeiling: ProviderCapabilities = {"],
    },
  ],
  "Oh My Pi": [{ file: "ohMyPiDriver.ts", anchors: ["const capabilities = {"] }],
};

const capabilityRows = tableRows(matrixSection, "Capability");
const columnNames = (capabilityRows[0] ?? []).slice(1);
const bodyRows = capabilityRows.slice(1);
const columnRows = tableRows(matrixSection, "Column").slice(1);

const compactionRows = ["chat", "work", "code"].map((mode) => `sessionCompaction.${mode}`);
const expectedRowKeys = [
  ...Object.keys(ProviderCapabilities.fields).filter((key) => key !== "sessionCompaction"),
  ...compactionRows,
];

describe("provider capability matrix", () => {
  it("is present in the architecture beside the confinement matrix", () => {
    expect(matrixStart).toBeGreaterThan(architecture.indexOf("\n## Security and authority\n"));
    expect(matrixEnd).toBeGreaterThan(matrixStart);
    expect(columnNames.length).toBeGreaterThan(0);
  });

  it("has a row for every capability a driver can declare", () => {
    const rowKeys = bodyRows.map(([cell]) => cell?.replace(/`/g, ""));
    expect([...rowKeys].sort()).toEqual([...expectedRowKeys].sort());
  });

  it("opens every cell with a declaration word and covers every column", () => {
    for (const row of bodyRows) {
      expect(row.length).toBe(columnNames.length + 1);
      for (const cell of row.slice(1)) {
        expect(declarations.has(leadingToken(cell) ?? "") || leadingToken(cell) === "as").toBe(
          true,
        );
      }
    }
  });

  it("names exactly the columns that have a capability block to compare", () => {
    expect([...columnNames].sort()).toEqual(Object.keys(COLUMN_SOURCES).sort());
    expect(columnRows.map(([name]) => name).sort()).toEqual([...columnNames].sort());
  });

  it("states each cell as its driver's static capability block declares it", () => {
    const disagreements: string[] = [];
    for (const [columnIndex, column] of columnNames.entries()) {
      for (const source of COLUMN_SOURCES[column] ?? []) {
        const declared = declaredCapabilities(source.file, source.anchors);
        for (const row of bodyRows) {
          const key = row[0]?.replace(/`/g, "") ?? "";
          if (key.startsWith("sessionCompaction.")) continue;
          const documented = leadingToken(row[columnIndex + 1] ?? "");
          const actual = declared.get(key) ?? "absent";
          if (documented !== actual) {
            disagreements.push(
              `${column} ${key}: matrix says ${documented}, ${source.file} ${actual}`,
            );
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("places every non-image driver kind in exactly one column and no image kind", () => {
    const listed = columnRows.flatMap((row) =>
      (row[1] ?? "").split(",").map((kind) => kind.replace(/`/g, "").trim()),
    );
    const turnDrivers = ProviderDriverKind.literals.filter(
      (kind) => !isImageProfileDriverKind(kind),
    );
    expect([...listed].sort()).toEqual([...turnDrivers].sort());
  });

  it("gives each column the modes and agent loop the provider catalog policy holds", () => {
    for (const [, kinds, chat, work, code, agentLoop] of columnRows) {
      for (const kind of (kinds ?? "").split(",").map((entry) => entry.replace(/`/g, "").trim())) {
        const policy = providerCatalogCapabilities(kind as ProviderDriverKind);
        expect({
          chat: `\`${policy.modes.chat}\``,
          work: `\`${policy.modes.work}\``,
          code: `\`${policy.modes.code}\``,
          agentLoop: `\`${policy.agentLoop}\``,
        }).toEqual({ chat, work, code, agentLoop });
      }
    }
  });

  it("is the one place the specifications say which providers are first-class", () => {
    const agents = read(join(repositoryRoot, "AGENTS.md"));
    const guide = read(join(repositoryRoot, "apps", "docs", "advanced", "providers.md"));
    expect(agents).not.toMatch(/matrix is not written/i);
    expect(architecture).not.toMatch(/matrix is not written/i);
    expect(agents).toContain("Claude Code and Codex are the first-class");
    expect(guide).toContain("### What each provider can do");
  });
});
