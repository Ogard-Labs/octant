import type {
  ProviderToolingEntry,
  ProviderToolingProvider,
  ProviderToolingSection,
  ProviderToolingSectionKind,
} from "@octant/contracts";

/**
 * Reads what a provider's list commands print. Everything here is data from a
 * program Octant does not control: each field is read by name, bounded, and
 * stripped of control characters, and anything in a shape this code does not
 * know becomes plain lines rather than a guess.
 */

const MAXIMUM_ENTRIES = 200;
const MAXIMUM_LINES = 20;
const MAXIMUM_TEXT = 300;

export interface ListCommand {
  readonly kind: ProviderToolingSectionKind;
  readonly argv: ReadonlyArray<string>;
}

export const LIST_COMMANDS: Readonly<Record<ProviderToolingProvider, ReadonlyArray<ListCommand>>> =
  {
    claude: [
      { kind: "mcp-servers", argv: ["mcp", "list"] },
      { kind: "plugins", argv: ["plugin", "list", "--json"] },
      { kind: "marketplaces", argv: ["plugin", "marketplace", "list", "--json"] },
    ],
    codex: [
      { kind: "mcp-servers", argv: ["mcp", "list", "--json"] },
      { kind: "plugins", argv: ["plugin", "list", "--json"] },
      { kind: "marketplaces", argv: ["plugin", "marketplace", "list", "--json"] },
    ],
  };

const MISSING_COMMAND =
  /unknown command|unrecognized subcommand|no such (sub)?command|invalid subcommand/i;

export function readSection(input: {
  readonly provider: ProviderToolingProvider;
  readonly kind: ProviderToolingSectionKind;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}): ProviderToolingSection {
  const lines = textLines(input.output);
  if (input.timedOut) {
    return section(input.kind, "failed", [], [], "The provider did not answer in time.");
  }
  if (input.exitCode !== 0) {
    if (MISSING_COMMAND.test(input.output)) {
      return section(
        input.kind,
        "no-command",
        [],
        [],
        "This version of the command line tool has no command for this.",
      );
    }
    return section(
      input.kind,
      "failed",
      [],
      lines.slice(0, MAXIMUM_LINES),
      "The provider's command did not succeed.",
    );
  }
  const entries = parse(input.provider, input.kind, input.output);
  if (entries === undefined) {
    return section(input.kind, "unreadable", [], lines.slice(0, MAXIMUM_LINES));
  }
  return section(input.kind, "listed", entries.slice(0, MAXIMUM_ENTRIES), []);
}

function section(
  kind: ProviderToolingSectionKind,
  status: ProviderToolingSection["status"],
  entries: ReadonlyArray<ProviderToolingEntry>,
  lines: ReadonlyArray<string>,
  message?: string,
): ProviderToolingSection {
  return { kind, status, entries, lines, ...(message === undefined ? {} : { message }) };
}

function parse(
  provider: ProviderToolingProvider,
  kind: ProviderToolingSectionKind,
  output: string,
): ReadonlyArray<ProviderToolingEntry> | undefined {
  if (provider === "claude" && kind === "mcp-servers") return parseClaudeMcpText(output);
  const json = parseJson(output);
  if (json === undefined) return undefined;
  if (provider === "claude") {
    return kind === "plugins" ? claudePlugins(json) : claudeMarketplaces(json);
  }
  if (kind === "mcp-servers") return codexServers(json);
  return kind === "plugins" ? codexPlugins(json) : codexMarketplaces(json);
}

/** `name: command or address - status`, one server per line, after a health-check line. */
export function parseClaudeMcpText(
  output: string,
): ReadonlyArray<ProviderToolingEntry> | undefined {
  const lines = textLines(output);
  if (lines.length === 0) return [];
  if (lines.some((line) => /^no mcp servers configured/i.test(line))) return [];
  const entries: ProviderToolingEntry[] = [];
  for (const line of lines) {
    if (/^checking mcp server health/i.test(line)) continue;
    const separator = line.indexOf(": ");
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator);
    if (/\s/.test(name)) return undefined;
    entries.push({ name: clip(name), detail: clip(line.slice(separator + 2)) });
  }
  return entries;
}

function claudePlugins(json: unknown): ReadonlyArray<ProviderToolingEntry> | undefined {
  if (!Array.isArray(json)) return undefined;
  const entries: ProviderToolingEntry[] = [];
  for (const item of json) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    if (id === undefined) continue;
    const at = id.lastIndexOf("@");
    const version = text(item.version);
    entries.push({
      name: at > 0 ? id.slice(0, at) : id,
      ...(at > 0 ? { marketplace: id.slice(at + 1) } : {}),
      ...(version === undefined ? {} : { detail: `Version ${version}` }),
      ...optional("scope", text(item.scope)),
      ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    });
  }
  return entries;
}

function claudeMarketplaces(json: unknown): ReadonlyArray<ProviderToolingEntry> | undefined {
  if (!Array.isArray(json)) return undefined;
  return json.flatMap((item): ProviderToolingEntry[] => {
    if (!isRecord(item)) return [];
    const name = text(item.name);
    if (name === undefined) return [];
    const where = text(item.repo) ?? text(item.url) ?? text(item.path);
    return [{ name, ...(where === undefined ? {} : { detail: where }) }];
  });
}

function codexServers(json: unknown): ReadonlyArray<ProviderToolingEntry> | undefined {
  if (!Array.isArray(json)) return undefined;
  return json.flatMap((item): ProviderToolingEntry[] => {
    if (!isRecord(item)) return [];
    const name = text(item.name);
    if (name === undefined) return [];
    const transport = isRecord(item.transport) ? item.transport : {};
    const url = text(transport.url);
    const command = text(transport.command);
    const args = Array.isArray(transport.args)
      ? transport.args.flatMap((argument) => text(argument) ?? [])
      : [];
    const detail = url ?? (command === undefined ? undefined : [command, ...args].join(" "));
    return [
      {
        name,
        ...(detail === undefined ? {} : { detail: clip(detail) }),
        ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
      },
    ];
  });
}

function codexPlugins(json: unknown): ReadonlyArray<ProviderToolingEntry> | undefined {
  if (!isRecord(json) || !Array.isArray(json.installed)) return undefined;
  return json.installed.flatMap((item): ProviderToolingEntry[] => {
    if (!isRecord(item)) return [];
    const name = text(item.name);
    if (name === undefined) return [];
    const version = text(item.version);
    return [
      {
        name,
        ...optional("marketplace", text(item.marketplaceName)),
        ...(version === undefined ? {} : { detail: `Version ${version}` }),
        ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
      },
    ];
  });
}

function codexMarketplaces(json: unknown): ReadonlyArray<ProviderToolingEntry> | undefined {
  if (!isRecord(json) || !Array.isArray(json.marketplaces)) return undefined;
  return json.marketplaces.flatMap((item): ProviderToolingEntry[] => {
    if (!isRecord(item)) return [];
    const name = text(item.name);
    if (name === undefined) return [];
    const source = isRecord(item.marketplaceSource)
      ? text(item.marketplaceSource.source)
      : undefined;
    const where = source ?? text(item.root);
    return [{ name, ...(where === undefined ? {} : { detail: where }) }];
  });
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = clip(value);
  return clean.length === 0 ? undefined : clean;
}

function clip(value: string): string {
  let clean = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? " " : character;
  }
  clean = clean.trim();
  return clean.length > MAXIMUM_TEXT ? `${clean.slice(0, MAXIMUM_TEXT)}…` : clean;
}

function textLines(output: string): ReadonlyArray<string> {
  return output
    .split(/\r?\n/)
    .map((line) => clip(line))
    .filter((line) => line.length > 0);
}
