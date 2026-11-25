import type {
  SecretStoreBrowseEntry,
  SecretStoreBrowseResult,
  SecretStoreBrowseStep,
} from "@octant/contracts/secret-stores";
import { MAX_SECRET_STORE_BROWSE_ENTRIES } from "@octant/contracts/secret-stores";

/** A vault of a thousand items is listed in about half of this. */
export const MAX_ONE_PASSWORD_LIST_BYTES = 2 * 1024 * 1024;

const ID = /^[a-z0-9]{26}$/i;
/** What a secret reference may hold between its slashes without being quoted. */
const REFERENCE_PART = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_LABEL_LENGTH = 128;
/** A one-time code's field holds its seed, which is no value a command wants. */
const UNREADABLE_TYPES = new Set(["OTP", "FILE", "SSHKEY"]);

/** The arguments that list one step, or undefined where a step's ids are not ids. */
export function onePasswordBrowseArguments(
  step: SecretStoreBrowseStep,
): ReadonlyArray<string> | undefined {
  switch (step.kind) {
    case "vaults":
      return ["vault", "list", "--format", "json"];
    case "items":
      return ID.test(step.vaultId)
        ? ["item", "list", "--vault", step.vaultId, "--format", "json"]
        : undefined;
    case "fields":
      return ID.test(step.vaultId) && ID.test(step.itemId)
        ? ["item", "get", step.itemId, "--vault", step.vaultId, "--format", "json"]
        : undefined;
  }
}

/**
 * The names in one step's output. An item's output can hold its fields' values,
 * and a list can hold a person's user names: only an id, a label and an
 * address are read from it, and the rest goes no further than this function.
 */
export function readOnePasswordBrowse(
  step: SecretStoreBrowseStep,
  output: string,
): SecretStoreBrowseResult {
  if (Buffer.byteLength(output, "utf8") > MAX_ONE_PASSWORD_LIST_BYTES)
    return { status: "unavailable" };
  let parsed: unknown;
  try {
    // The tool prints nothing at all for an empty vault.
    parsed = output.trim() === "" ? [] : JSON.parse(output);
  } catch {
    return { status: "unavailable" };
  }
  const rows =
    step.kind === "fields"
      ? isRecord(parsed) && parsed.id === step.itemId
        ? parsed.fields
        : undefined
      : parsed;
  if (!Array.isArray(rows)) return { status: "unavailable" };
  const entries: SecretStoreBrowseEntry[] = [];
  for (const row of rows) {
    const entry = isRecord(row)
      ? step.kind === "fields"
        ? fieldEntry(step, row)
        : nameEntry(row, step.kind === "vaults" ? row.name : row.title)
      : undefined;
    if (entry === undefined) continue;
    if (entries.length === MAX_SECRET_STORE_BROWSE_ENTRIES)
      return { status: "listed", entries, truncated: true };
    entries.push(entry);
  }
  return { status: "listed", entries, truncated: false };
}

function nameEntry(
  row: Readonly<Record<string, unknown>>,
  name: unknown,
): SecretStoreBrowseEntry | undefined {
  const label = plainLabel(name);
  return typeof row.id === "string" && ID.test(row.id) && label !== undefined
    ? { id: row.id, label }
    : undefined;
}

function fieldEntry(
  step: Extract<SecretStoreBrowseStep, { readonly kind: "fields" }>,
  row: Readonly<Record<string, unknown>>,
): SecretStoreBrowseEntry | undefined {
  const { id, type, value, section } = row;
  // An empty field answers nothing.
  if (typeof id !== "string" || !REFERENCE_PART.test(id)) return undefined;
  if (typeof value !== "string" || value === "") return undefined;
  if (typeof type === "string" && UNREADABLE_TYPES.has(type)) return undefined;
  const sectionId = isRecord(section) ? section.id : undefined;
  if (sectionId !== undefined && (typeof sectionId !== "string" || !REFERENCE_PART.test(sectionId)))
    return undefined;
  const name = plainLabel(row.label) ?? id;
  const sectionName = isRecord(section) ? plainLabel(section.label) : undefined;
  return {
    id: sectionId === undefined ? id : `${sectionId}/${id}`,
    label: sectionName === undefined ? name : `${sectionName} · ${name}`,
    // By id, so a renamed vault, item or field still answers.
    reference: `op://${step.vaultId}/${step.itemId}/${sectionId === undefined ? "" : `${sectionId}/`}${id}`,
  };
}

function plainLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .slice(0, MAX_LABEL_LENGTH)
    .join("")
    .trim();
  return label === "" ? undefined : label;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
