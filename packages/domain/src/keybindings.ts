/**
 * The chords that reach Octant's global surfaces, and the rules for changing
 * them.
 *
 * Keybindings are a preference about this client's own keyboard, not an
 * authority: rebinding a chord changes which panel a key opens and nothing
 * else. Every effect a surface can reach is still decided on the server, so
 * this module stays pure — it parses, formats, matches, and merges, and never
 * reads a keyboard or a file.
 */

/** An action a chord can be bound to. Ids are durable: overrides name them. */
export type OctantKeybindingActionId =
  | "command-palette"
  | "code-file-search"
  | "code-content-search"
  | "zen-mode";

export interface OctantKeybindingAction {
  readonly id: OctantKeybindingActionId;
  readonly label: string;
  /** Where the action lives, so the settings list can group it. */
  readonly area: "Shell" | "Code";
  readonly defaultChord: string;
}

/**
 * `Mod` is Command on Apple hardware and Control elsewhere. Writing the
 * defaults with it keeps one binding correct on both rather than shipping two
 * tables that can drift apart.
 */
export const OCTANT_KEYBINDING_ACTIONS: ReadonlyArray<OctantKeybindingAction> = [
  {
    id: "command-palette",
    label: "Open the command palette",
    area: "Shell",
    defaultChord: "Mod+K",
  },
  { id: "zen-mode", label: "Toggle Zen mode", area: "Shell", defaultChord: "Mod+Shift+Z" },
  { id: "code-file-search", label: "Find a file by name", area: "Code", defaultChord: "Mod+P" },
  {
    id: "code-content-search",
    label: "Find text across the repository",
    area: "Code",
    defaultChord: "Mod+Shift+F",
  },
];

export interface OctantChord {
  /** Command on Apple hardware, Control elsewhere. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** The printable key, lowercased, or a named key such as `Escape`. */
  readonly key: string;
}

/**
 * Keys a binding may not take over.
 *
 * A chord that is just a letter, or one qualified only by Shift, is ordinary
 * typing; accepting it would make the app swallow characters in every text
 * field. Tab and Escape are how a keyboard user leaves a surface, so they stay
 * with the platform whatever modifiers are held.
 */
const RESERVED_KEYS = new Set(["tab", "escape", "enter", " "]);

export type OctantChordParse =
  | { readonly status: "ok"; readonly chord: OctantChord }
  | { readonly status: "invalid"; readonly reason: string };

/**
 * Read a chord written as `Mod+Shift+F`.
 *
 * Deliberately strict: an override the user typed by hand is rejected with a
 * reason rather than silently becoming a chord they did not ask for.
 */
export function parseChord(text: string): OctantChordParse {
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { status: "invalid", reason: "Write a chord, such as Mod+K." };
  let mod = false;
  let shift = false;
  let alt = false;
  let key: string | undefined;
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "mod" || normalized === "cmd" || normalized === "ctrl") {
      mod = true;
      continue;
    }
    if (normalized === "shift") {
      shift = true;
      continue;
    }
    if (normalized === "alt" || normalized === "option") {
      alt = true;
      continue;
    }
    if (key !== undefined) {
      return { status: "invalid", reason: "A chord may name only one key." };
    }
    key = normalized;
  }
  if (key === undefined) return { status: "invalid", reason: "A chord must name a key." };
  if (RESERVED_KEYS.has(key)) {
    return { status: "invalid", reason: `${part(key)} is reserved for the platform.` };
  }
  if (!mod && !alt) {
    return {
      status: "invalid",
      reason: "A chord must hold Mod or Alt, so it cannot swallow ordinary typing.",
    };
  }
  return { status: "ok", chord: { mod, shift, alt, key } };
}

function part(key: string): string {
  return key.length === 1 ? key.toUpperCase() : `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
}

/** Write a chord back out in the form {@link parseChord} reads. */
export function formatChord(chord: OctantChord): string {
  return [
    ...(chord.mod ? ["Mod"] : []),
    ...(chord.alt ? ["Alt"] : []),
    ...(chord.shift ? ["Shift"] : []),
    part(chord.key),
  ].join("+");
}

/**
 * Read the chord a keyboard event carries.
 *
 * On Apple hardware `Mod` is Command alone: Control there is Cocoa's own text
 * editing (Ctrl+K deletes to end of line, Ctrl+A goes to line start), so
 * treating it as `Mod` would take those away from every field in the app.
 */
export function chordFromEvent(
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
  },
  apple: boolean,
): OctantChord {
  return {
    mod: apple ? event.metaKey : event.metaKey || event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: event.key.toLowerCase(),
  };
}

export function sameChord(left: OctantChord, right: OctantChord): boolean {
  return (
    left.mod === right.mod &&
    left.shift === right.shift &&
    left.alt === right.alt &&
    left.key === right.key
  );
}

export interface OctantKeybindingRejection {
  readonly actionId: string;
  readonly chord: string;
  readonly reason: string;
}

export interface OctantKeybindings {
  /** The chord each action answers to, defaults included. */
  readonly bindings: ReadonlyMap<OctantKeybindingActionId, OctantChord>;
  /**
   * Overrides that were not applied, each with why. Reporting them is what
   * keeps a typo in the JSON from silently leaving an action unreachable.
   */
  readonly rejected: ReadonlyArray<OctantKeybindingRejection>;
  /**
   * Actions that ended up sharing a chord. The first one listed for a chord
   * keeps it; the rest are reported so the user can see the collision instead
   * of discovering it by pressing the key.
   */
  readonly conflicts: ReadonlyArray<{
    readonly chord: string;
    readonly actionIds: ReadonlyArray<OctantKeybindingActionId>;
  }>;
}

/**
 * Merge the user's overrides onto the defaults.
 *
 * Every action always ends up bound: an override that cannot be read, names an
 * action that does not exist, or collides with one already taken leaves that
 * action on its default rather than unreachable.
 */
export function resolveKeybindings(
  overrides: Readonly<Record<string, string>> = {},
): OctantKeybindings {
  const bindings = new Map<OctantKeybindingActionId, OctantChord>();
  const rejected: OctantKeybindingRejection[] = [];
  const known = new Map(OCTANT_KEYBINDING_ACTIONS.map((action) => [String(action.id), action]));

  for (const [actionId, chord] of Object.entries(overrides)) {
    const action = known.get(actionId);
    if (action === undefined) {
      rejected.push({ actionId, chord, reason: "No such action." });
      continue;
    }
    const parsed = parseChord(chord);
    if (parsed.status !== "ok") {
      rejected.push({ actionId, chord, reason: parsed.reason });
      continue;
    }
    bindings.set(action.id, parsed.chord);
  }

  for (const action of OCTANT_KEYBINDING_ACTIONS) {
    if (bindings.has(action.id)) continue;
    const fallback = parseChord(action.defaultChord);
    if (fallback.status === "ok") bindings.set(action.id, fallback.chord);
  }

  const byChord = new Map<string, OctantKeybindingActionId[]>();
  // Iterate the action table, not the map, so a conflict resolves the same way
  // whatever order the override JSON happened to list its keys in.
  for (const action of OCTANT_KEYBINDING_ACTIONS) {
    const chord = bindings.get(action.id);
    if (chord === undefined) continue;
    const key = formatChord(chord);
    byChord.set(key, [...(byChord.get(key) ?? []), action.id]);
  }
  const conflicts = [...byChord.entries()]
    .filter(([, actionIds]) => actionIds.length > 1)
    .map(([chord, actionIds]) => ({ chord, actionIds: [...actionIds] }));

  return { bindings, rejected, conflicts };
}

/**
 * Which action a keyboard event runs, if any.
 *
 * When two actions share a chord the first in the action table wins, matching
 * what {@link resolveKeybindings} reports, so the warning the user sees names
 * the action that is actually being shadowed.
 */
export function matchKeybinding(
  keybindings: OctantKeybindings,
  event: Parameters<typeof chordFromEvent>[0],
  apple: boolean,
): OctantKeybindingActionId | undefined {
  const chord = chordFromEvent(event, apple);
  if (!chord.mod && !chord.alt) return undefined;
  for (const action of OCTANT_KEYBINDING_ACTIONS) {
    const bound = keybindings.bindings.get(action.id);
    if (bound !== undefined && sameChord(bound, chord)) return action.id;
  }
  return undefined;
}

/**
 * Read overrides out of the JSON document the user edits.
 *
 * A document that is not an object of strings is refused whole: applying half
 * of a malformed file would leave the user guessing which half took effect.
 */
export function parseKeybindingOverrides(text: string):
  | { readonly status: "ok"; readonly overrides: Record<string, string> }
  | {
      readonly status: "invalid";
      readonly reason: string;
    } {
  if (text.trim().length === 0) return { status: "ok", overrides: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", reason: "This is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "Keybindings must be a JSON object of action to chord." };
  }
  const overrides: Record<string, string> = {};
  for (const [actionId, chord] of Object.entries(parsed)) {
    if (typeof chord !== "string") {
      return { status: "invalid", reason: `The chord for ${actionId} must be text.` };
    }
    overrides[actionId] = chord;
  }
  return { status: "ok", overrides };
}

/** How the chord reads on this platform's keyboard. */
export function describeChord(chord: OctantChord, apple: boolean): string {
  return [
    ...(chord.mod ? [apple ? "⌘" : "Ctrl"] : []),
    ...(chord.alt ? [apple ? "⌥" : "Alt"] : []),
    ...(chord.shift ? [apple ? "⇧" : "Shift"] : []),
    part(chord.key),
  ].join(apple ? "" : "+");
}
