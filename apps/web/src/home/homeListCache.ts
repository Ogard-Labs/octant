import {
  HOME_LIST_SECTIONS,
  type HomeListGlyph,
  type HomeListRow,
  type HomeListSection,
  type HomeListSectionId,
  type HomeListTone,
} from "./homeListModel";

/**
 * The start list's last answer, kept in the client so the next start paints it
 * on its first frame and replaces it in place when the fresh read lands. Only
 * what the list already shows is kept (titles, ids, tones, meta); no token,
 * body or URL, and nothing that could act: a cached row cannot be opened, so
 * it is never mistaken for a live one.
 */

/** Bumped whenever the stored shape changes; an entry of another version is ignored. */
export const HOME_LIST_CACHE_VERSION = 1;
const STORAGE_KEY = "octant.homeList.cache";
/** One entry per host and Project; the least recently saved go first. */
const MAX_SCOPES = 8;
/** Characters of stored JSON the whole cache may take. */
const MAX_CHARACTERS = 48_000;
const MAX_TEXT = 240;
const MAX_ROW_HEIGHT = 400;

export interface CachedHomeListRow {
  readonly id: string;
  readonly section: HomeListSectionId;
  readonly glyph: HomeListGlyph;
  readonly tone: HomeListTone;
  readonly label: string;
  readonly title: string;
  readonly meta: ReadonlyArray<string>;
  readonly trailing?: string;
  readonly at?: string;
  /** A row that draws itself (an approval, a service) was this tall; its stored stand-in keeps the height. */
  readonly height?: number;
}

export interface CachedHomeListSection {
  readonly id: HomeListSectionId;
  readonly total: number;
  readonly rows: ReadonlyArray<CachedHomeListRow>;
  /** The See all link's words; the link itself comes with the fresh read. */
  readonly seeAll?: string;
}

interface StoredScope {
  readonly savedAt: number;
  readonly sections: ReadonlyArray<CachedHomeListSection>;
}

interface StoredCache {
  readonly version: number;
  readonly scopes: Readonly<Record<string, StoredScope>>;
}

type CacheStorage = Pick<Storage, "getItem" | "setItem">;

const SECTION_IDS: ReadonlySet<string> = new Set(HOME_LIST_SECTIONS.map((section) => section.id));
const GLYPHS: ReadonlySet<string> = new Set<HomeListGlyph>([
  "pull-request",
  "pull-request-draft",
  "issue",
  "thread",
  "running",
  "service",
  "ask",
]);
const TONES: ReadonlySet<string> = new Set<HomeListTone>([
  "neutral",
  "positive",
  "warning",
  "negative",
  "running",
]);

/** Reading `localStorage` throws when a client blocks site data. */
export function homeListCacheStorage(): CacheStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRow(value: unknown): CachedHomeListRow | undefined {
  if (!isRecord(value)) return undefined;
  const { id, section, glyph, tone, label, title, meta, trailing, at, height } = value;
  if (
    typeof id !== "string" ||
    typeof section !== "string" ||
    !SECTION_IDS.has(section) ||
    typeof glyph !== "string" ||
    !GLYPHS.has(glyph) ||
    typeof tone !== "string" ||
    !TONES.has(tone) ||
    typeof label !== "string" ||
    typeof title !== "string" ||
    !Array.isArray(meta) ||
    !meta.every((fact) => typeof fact === "string")
  ) {
    return undefined;
  }
  return {
    id,
    section: section as HomeListSectionId,
    glyph: glyph as HomeListGlyph,
    tone: tone as HomeListTone,
    label,
    title,
    meta: meta as ReadonlyArray<string>,
    ...(typeof trailing === "string" ? { trailing } : {}),
    ...(typeof at === "string" ? { at } : {}),
    ...(typeof height === "number" && height > 0 && height <= MAX_ROW_HEIGHT ? { height } : {}),
  };
}

function readSection(value: unknown): CachedHomeListSection | undefined {
  if (!isRecord(value)) return undefined;
  const { id, total, rows, seeAll } = value;
  if (
    typeof id !== "string" ||
    !SECTION_IDS.has(id) ||
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    !Array.isArray(rows)
  ) {
    return undefined;
  }
  const kept: CachedHomeListRow[] = [];
  for (const candidate of rows) {
    const row = readRow(candidate);
    if (row === undefined) return undefined;
    kept.push(row);
  }
  return {
    id: id as HomeListSectionId,
    total,
    rows: kept,
    ...(typeof seeAll === "string" ? { seeAll } : {}),
  };
}

function readStored(storage: CacheStorage | undefined): StoredCache | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed["version"] !== HOME_LIST_CACHE_VERSION) return undefined;
    const scopes = parsed["scopes"];
    if (!isRecord(scopes)) return undefined;
    const clean: Record<string, StoredScope> = {};
    for (const [key, scope] of Object.entries(scopes)) {
      if (!isRecord(scope) || typeof scope["savedAt"] !== "number") continue;
      const sections = scope["sections"];
      if (!Array.isArray(sections)) continue;
      const kept = sections.flatMap((section) => {
        const read = readSection(section);
        return read === undefined ? [] : [read];
      });
      clean[key] = { savedAt: scope["savedAt"], sections: kept };
    }
    return { version: HOME_LIST_CACHE_VERSION, scopes: clean };
  } catch {
    return undefined;
  }
}

/** The sections last stored for one host and Project, in reading order; absent when none. */
export function readHomeListCache(
  storage: CacheStorage | undefined,
  scope: string,
): ReadonlyArray<CachedHomeListSection> | undefined {
  return readStored(storage)?.scopes[scope]?.sections;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** What a live row keeps once it is stored: its words, never its actions. */
export function cacheableRow(row: HomeListRow, height?: number): CachedHomeListRow {
  return {
    id: row.id,
    section: row.section,
    glyph: row.glyph,
    tone: row.tone,
    label: clip(row.label),
    title: clip(row.title),
    meta: row.meta.map(clip),
    ...(row.trailing === undefined ? {} : { trailing: clip(row.trailing) }),
    ...(row.at === undefined ? {} : { at: row.at }),
    ...(height === undefined ? {} : { height }),
  };
}

export function cacheableSection(
  section: HomeListSection,
  heights: ReadonlyMap<string, number>,
): CachedHomeListSection {
  return {
    id: section.id,
    total: section.total,
    rows: section.rows.map((row) =>
      cacheableRow(row, row.custom === undefined ? undefined : heights.get(row.id)),
    ),
    ...(section.seeAll === undefined ? {} : { seeAll: section.seeAll.label }),
  };
}

/**
 * Stores a settled list for one host and Project. A write that would pass the
 * size cap drops the oldest other scopes first, and is skipped when this entry
 * alone is too big; a refused write (a full or blocked store) is ignored,
 * because the cache only ever speeds up a start.
 */
export function writeHomeListCache(
  storage: CacheStorage | undefined,
  scope: string,
  sections: ReadonlyArray<HomeListSection>,
  options: {
    readonly now?: number;
    /** The measured height of each row that draws itself, by row id. */
    readonly heights?: ReadonlyMap<string, number>;
  } = {},
): void {
  if (storage === undefined) return;
  const scopes: Record<string, StoredScope> = { ...readStored(storage)?.scopes };
  const heights = options.heights ?? new Map<string, number>();
  scopes[scope] = {
    savedAt: options.now ?? Date.now(),
    sections: sections.map((section) => cacheableSection(section, heights)),
  };
  const ordered = Object.entries(scopes).sort((a, b) => b[1].savedAt - a[1].savedAt);
  let kept = ordered.slice(0, MAX_SCOPES);
  const serialize = (entries: typeof kept) =>
    JSON.stringify({ version: HOME_LIST_CACHE_VERSION, scopes: Object.fromEntries(entries) });
  let text = serialize(kept);
  while (text.length > MAX_CHARACTERS && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = serialize(kept);
  }
  if (text.length > MAX_CHARACTERS) return;
  try {
    storage.setItem(STORAGE_KEY, text);
  } catch {
    // A full or blocked store leaves the next start without a cached paint.
  }
}
