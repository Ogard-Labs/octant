import {
  MAX_PROVIDER_SLASH_COMMANDS,
  ProviderSlashCommand,
  type ProviderSlashCommand as ProviderSlashCommandValue,
} from "@octant/contracts";
import { Schema } from "effect";

const isSlashCommand = Schema.is(ProviderSlashCommand);

/**
 * The slash commands a runtime listed, read leniently: an entry whose name
 * Octant cannot send as `/name` is left out rather than failing the list,
 * because the list only labels a menu and grants nothing. Claude Code names
 * the argument hint `argumentHint`; an ACP agent puts it under `input.hint`.
 */
export function advertisedSlashCommands(value: unknown): ReadonlyArray<ProviderSlashCommandValue> {
  if (!Array.isArray(value)) return [];
  const commands = new Map<string, ProviderSlashCommandValue>();
  for (const entry of value) {
    if (commands.size >= MAX_PROVIDER_SLASH_COMMANDS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    const name = record.name.trim().replace(/^\//u, "");
    const description = text(record.description, 512);
    const input = record.input;
    const hint =
      text(record.argumentHint, 256) ??
      (typeof input === "object" && input !== null
        ? text((input as Record<string, unknown>).hint, 256)
        : undefined);
    const command = {
      name,
      ...(description === undefined ? {} : { description }),
      ...(hint === undefined ? {} : { argumentHint: hint }),
    };
    if (isSlashCommand(command) && !commands.has(name)) commands.set(name, command);
  }
  return [...commands.values()];
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, limit);
}
