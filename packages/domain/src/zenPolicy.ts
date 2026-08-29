import {
  ZenSpace,
  ZenSpaceId,
  ZenElementId,
  ZenElementPayload,
  ZenCommand,
  ZenGeometry,
  ZenViewport,
  ZenAppearance,
  ZenAssistantBinding,
  ZenResearchDock,
  ZenSourceContext,
  ZenWidgetRecipeDraft,
  ZenWidgetPrimitive,
  ZenChecklistItem,
  ZenTimerElementPayload,
  ZenTimerActionCommand,
  DEFAULT_ZEN_APPEARANCE,
  DEFAULT_ZEN_VIEWPORT,
  getZenBuiltinBackground,
  ZEN_BUILTIN_BACKGROUNDS,
  MIN_ZEN_ELEMENT_WIDTH,
  MAX_ZEN_ELEMENT_WIDTH,
  MIN_ZEN_ELEMENT_HEIGHT,
  MAX_ZEN_ELEMENT_HEIGHT,
} from "@octant/contracts/zen";
import {
  decodeUtcTimestamp,
  type AggregateVersion,
  type UtcTimestamp,
} from "@octant/contracts/events";
import type { WindowId, HostId } from "@octant/contracts/shell";

// ── Rejection codes ─────────────────────────────────────────────────────────

export type ZenPolicyRejectionCode =
  | "duplicate-element-id"
  | "duplicate-z-index"
  | "unknown-element"
  | "wrong-widget-kind"
  | "stale-widget-version"
  | "unknown-checklist-item"
  | "stale-version"
  | "invalid-presentation"
  | "invalid-geometry"
  | "invalid-background"
  | "invalid-source-context"
  | "invalid-url"
  | "invalid-recipe"
  | "oversized-recipe"
  | "executable-content"
  | "cross-host"
  | "unsupported-kind"
  | "limit-exceeded"
  | "recovery-required";

export class ZenPolicyRejected extends Error {
  override readonly name = "ZenPolicyRejected";

  constructor(
    readonly code: ZenPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ZenPolicyRejectionCode, message: string): never {
  throw new ZenPolicyRejected(code, message);
}

function utcNow(): UtcTimestamp {
  return decodeUtcTimestamp(new Date().toISOString());
}

function utcTimestampAt(epochMs: number): UtcTimestamp {
  return decodeUtcTimestamp(new Date(epochMs).toISOString());
}

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_ZEN_ELEMENTS = 20;
export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_NOTES_CONTENT_BYTES = 64 * 1024; // 64 KB
export const MAX_RECIPE_STATE_BYTES = 64 * 1024;
export const MAX_ZEN_WIDGET_RECIPE_BYTES = 64 * 1024;
export const MAX_ZEN_ELEMENT_Z_INDEX = 1000;

/**
 * How many pinned thread cards may hold a live transcript at once.
 *
 * `MAX_ZEN_ELEMENTS` was sized for widgets, which cost one render and nothing
 * more. A live card holds its own stream — a thread card its conversation, a
 * terminal card its shell — so a space filled to that ceiling with cards would
 * open twenty concurrent streams against the host for one reader. Cards past
 * this budget stay on their last reading until a live one is minimized, panned
 * away, or gives up focus.
 */
export const MAX_LIVE_ZEN_CARDS = 3;

export interface ZenTimerClockSample {
  readonly wallTimeMs: number;
  readonly monotonicTimeMs: number;
  readonly sessionId: string;
}

// ── Pure policy functions ────────────────────────────────────────────────────

/**
 * Validate that a Zen element payload has unique ID and z-index within the
 * current space's elements. Throws ZenPolicyRejected on conflict.
 */
export function validateElementUniqueness(
  existing: ReadonlyArray<ZenElementPayload>,
  element: ZenElementPayload,
): void {
  for (const existingEl of existing) {
    if (existingEl.elementId === element.elementId) {
      reject("duplicate-element-id", `Element ${element.elementId} already exists`);
    }
    if (existingEl.zIndex === element.zIndex) {
      reject("duplicate-z-index", `z-index ${element.zIndex} already used`);
    }
  }
}

/**
 * Validate that a geometry is within acceptable bounds.
 */
export function validateGeometry(geo: ZenGeometry): void {
  if (
    !Number.isFinite(geo.x) ||
    !Number.isFinite(geo.y) ||
    !Number.isFinite(geo.width) ||
    !Number.isFinite(geo.height)
  ) {
    reject("invalid-geometry", "Geometry contains NaN or Infinity");
  }
  if (geo.width < MIN_ZEN_ELEMENT_WIDTH || geo.width > MAX_ZEN_ELEMENT_WIDTH) {
    reject(
      "invalid-geometry",
      `Width ${geo.width} out of range [${MIN_ZEN_ELEMENT_WIDTH}, ${MAX_ZEN_ELEMENT_WIDTH}]`,
    );
  }
  if (geo.height < MIN_ZEN_ELEMENT_HEIGHT || geo.height > MAX_ZEN_ELEMENT_HEIGHT) {
    reject(
      "invalid-geometry",
      `Height ${geo.height} out of range [${MIN_ZEN_ELEMENT_HEIGHT}, ${MAX_ZEN_ELEMENT_HEIGHT}]`,
    );
  }
}

/**
 * Validate that a source context is for the local host (first-slice invariant).
 */
function sameSourceContext(left: ZenSourceContext, right: ZenSourceContext): boolean {
  return (
    String(left.hostId) === String(right.hostId) &&
    left.mode === right.mode &&
    String(left.projectId) === String(right.projectId) &&
    left.threadKind === right.threadKind &&
    String(left.threadId) === String(right.threadId) &&
    left.worktreeId === right.worktreeId
  );
}

export function validateLocalHostSource(ctx: ZenSourceContext, localHostId: HostId): void {
  if (ctx.hostId !== localHostId) {
    reject(
      "cross-host",
      `Source context references host ${ctx.hostId}; first slice is local-host only`,
    );
  }
}

/**
 * Validate that a URL is safe (http/https only, no javascript/data schemes).
 */
export function validateSafeUrl(url: string): void {
  if (!/^https?:\/\/.+/i.test(url)) {
    reject("invalid-url", `URL does not start with http:// or https://`);
  }
}

/**
 * Validate that a widget recipe only uses first-party primitives and
 * does not contain executable content.
 */
export function validateWidgetRecipe(recipe: ZenWidgetRecipeDraft): void {
  if (new TextEncoder().encode(JSON.stringify(recipe)).byteLength > MAX_ZEN_WIDGET_RECIPE_BYTES) {
    reject("oversized-recipe", "Recipe exceeds the maximum size");
  }
  const allowedPrimitives = new Set<ZenWidgetPrimitive>([
    "notes",
    "checklist",
    "timer",
    "text",
    "link",
    "media",
  ]);

  for (const primitive of recipe.primitives) {
    if (!allowedPrimitives.has(primitive)) {
      reject("invalid-recipe", `Unknown primitive: ${primitive}`);
    }
  }
  if (new Set(recipe.primitives).size !== recipe.primitives.length) {
    reject("invalid-recipe", "Recipe primitives must be unique");
  }
  if (new Set(recipe.fields.map((field) => field.key)).size !== recipe.fields.length) {
    reject("invalid-recipe", "Recipe field keys must be unique");
  }

  for (const field of recipe.fields) {
    const hasOptions = field.options !== undefined;
    if ((field.kind === "select") !== hasOptions) {
      reject("invalid-recipe", "Select fields require options and other fields cannot define them");
    }
    const expectedType = field.kind === "text" || field.kind === "select" ? "string" : field.kind;
    if (field.defaultValue !== undefined && typeof field.defaultValue !== expectedType) {
      reject("invalid-recipe", "Recipe field default value does not match its kind");
    }
    if (
      field.kind === "select" &&
      field.defaultValue !== undefined &&
      !field.options?.includes(field.defaultValue as string)
    ) {
      reject("invalid-recipe", "Select default must be one of its options");
    }
  }

  // Check for executable content in recipe name/description
  const suspiciousPatterns = [
    /<script\b/i,
    /javascript:/i,
    /on\w+\s*=/i, // HTML event handlers
    /<iframe\b/i,
    /<object\b/i,
    /<embed\b/i,
  ];

  const textToCheck = [
    recipe.name,
    recipe.description,
    ...recipe.fields.flatMap((field) => [
      field.key,
      field.label,
      ...(field.options ?? []),
      ...(typeof field.defaultValue === "string" ? [field.defaultValue] : []),
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(textToCheck)) {
      reject("executable-content", "Recipe contains executable content");
    }
  }
}

/**
 * Validate that checklist items stay within bounds.
 */
export function validateChecklistItems(items: ReadonlyArray<ZenChecklistItem>): void {
  if (items.length > MAX_CHECKLIST_ITEMS) {
    reject(
      "oversized-recipe",
      `Checklist has ${items.length} items; max is ${MAX_CHECKLIST_ITEMS}`,
    );
  }
}

/**
 * Validate that notes content stays within byte budget.
 */
export function validateNotesContent(content: string): void {
  const encoder = new TextEncoder();
  if (encoder.encode(content).byteLength > MAX_NOTES_CONTENT_BYTES) {
    reject("oversized-recipe", `Notes content exceeds ${MAX_NOTES_CONTENT_BYTES} bytes`);
  }
}

/**
 * Create a new Zen space from a create-space command.
 * Returns the initial ZenSpace or throws ZenPolicyRejected.
 */
export function createZenSpace(
  windowId: WindowId,
  localHostId: HostId,
  appearance?: ZenAppearance,
): ZenSpace {
  const spaceId = crypto.randomUUID() as ZenSpaceId;
  const now = utcNow();

  if (appearance !== undefined) {
    validateAppearance(appearance);
  }

  return {
    spaceId,
    windowId,
    version: 0 as AggregateVersion,
    elements: [],
    recipes: [],
    viewport: DEFAULT_ZEN_VIEWPORT,
    appearance: appearance ?? DEFAULT_ZEN_APPEARANCE,
    active: true,
    barCollapsed: false,
    assistant: null,
    research: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply an add-element command to a Zen space.
 * Returns the updated space or throws ZenPolicyRejected.
 */
export function addElement(
  space: ZenSpace,
  element: ZenElementPayload,
  expectedVersion: number,
  localHostId: HostId,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  if (space.elements.length >= MAX_ZEN_ELEMENTS) {
    reject("limit-exceeded", `Space already has ${MAX_ZEN_ELEMENTS} elements`);
  }

  validateGeometry(element.geometry);
  validateElementUniqueness(space.elements, element);

  // Validate element-specific constraints
  switch (element.kind) {
    case "thread":
    case "terminal":
      validateLocalHostSource(element.sourceContext, localHostId);
      break;
    case "notes":
      validateNotesContent(element.content);
      break;
    case "checklist":
      validateChecklistItems(element.items);
      break;
    case "reference":
      validateSafeUrl(element.url);
      break;
    case "recipe":
      if (!(space.recipes ?? []).some((recipe) => recipe.recipeId === element.recipeId)) {
        reject("invalid-recipe", "Recipe instance references an unknown recipe");
      }
      if (
        new TextEncoder().encode(JSON.stringify(element.state)).byteLength > MAX_RECIPE_STATE_BYTES
      ) {
        reject("oversized-recipe", "Recipe state exceeds the maximum size");
      }
      break;
  }

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements: [...space.elements, element],
    updatedAt: now,
  };
}

/**
 * Apply an update-element command to a Zen space.
 */
export function updateElement(
  space: ZenSpace,
  element: ZenElementPayload,
  expectedVersion: number,
  localHostId: HostId,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  const existingIndex = space.elements.findIndex((e) => e.elementId === element.elementId);
  if (existingIndex === -1) {
    reject("unknown-element", `Element ${element.elementId} not found`);
  }
  if (space.elements[existingIndex] === undefined) {
    reject("unknown-element", `Element ${element.elementId} not found`);
  }
  const existing = space.elements[existingIndex];
  if (existing.kind !== element.kind) {
    reject("wrong-widget-kind", "Element kinds cannot change during an update");
  }
  if (
    existing.kind === "notes" &&
    element.kind === "notes" &&
    (existing.content !== element.content || existing.widgetVersion !== element.widgetVersion)
  ) {
    reject("unsupported-kind", "Notes data must use a typed widget command");
  }
  if (
    existing.kind === "thread" &&
    element.kind === "thread" &&
    !sameSourceContext(existing.sourceContext, element.sourceContext)
  ) {
    reject("unsupported-kind", "Thread source context cannot change during an update");
  }
  if (
    existing.kind === "terminal" &&
    element.kind === "terminal" &&
    (!sameSourceContext(existing.sourceContext, element.sourceContext) ||
      String(existing.checkoutId) !== String(element.checkoutId) ||
      String(existing.terminalId) !== String(element.terminalId))
  ) {
    reject("unsupported-kind", "Terminal authority cannot change during an update");
  }
  if (
    existing.kind === "checklist" &&
    element.kind === "checklist" &&
    (existing.widgetVersion !== element.widgetVersion ||
      existing.items.length !== element.items.length ||
      existing.items.some((item, index) => {
        const next = element.items[index];
        return (
          next === undefined ||
          next.itemId !== item.itemId ||
          next.text !== item.text ||
          next.done !== item.done
        );
      }))
  ) {
    reject("unsupported-kind", "Checklist data must use a typed widget command");
  }

  validateGeometry(element.geometry);

  // Check z-index uniqueness against other elements (not self)
  for (let i = 0; i < space.elements.length; i++) {
    if (i !== existingIndex && space.elements[i]?.zIndex === element.zIndex) {
      reject("duplicate-z-index", `z-index ${element.zIndex} already used by another element`);
    }
  }

  // Validate element-specific constraints
  switch (element.kind) {
    case "thread":
    case "terminal":
      validateLocalHostSource(element.sourceContext, localHostId);
      break;
    case "notes":
      validateNotesContent(element.content);
      break;
    case "checklist":
      validateChecklistItems(element.items);
      break;
    case "reference":
      validateSafeUrl(element.url);
      break;
  }

  const now = utcNow();
  const updatedElements = [...space.elements];
  updatedElements[existingIndex] =
    existing.kind === "timer" && element.kind === "timer"
      ? {
          ...element,
          durationMs: existing.durationMs,
          remainingMs: existing.remainingMs,
          status: existing.status,
          startedAt: existing.startedAt,
          deadlineAt: existing.deadlineAt,
          clockSessionId: existing.clockSessionId,
          monotonicStartedMs: existing.monotonicStartedMs,
        }
      : element;

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements: updatedElements,
    updatedAt: now,
  };
}

type ZenWidgetKind = "notes" | "checklist";
type ZenWidgetElement<K extends ZenWidgetKind> = Extract<ZenElementPayload, { kind: K }>;

function updateWidgetElement<K extends ZenWidgetKind>(
  space: ZenSpace,
  elementId: ZenElementId,
  expectedVersion: number,
  expectedWidgetVersion: number,
  kind: K,
  update: (element: ZenWidgetElement<K>) => ZenWidgetElement<K>,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }
  const existing = space.elements.find((element) => element.elementId === elementId);
  if (existing === undefined) reject("unknown-element", `Element ${elementId} not found`);
  if (existing.kind !== kind) {
    reject("wrong-widget-kind", `Element ${elementId} is not a ${kind} widget`);
  }
  if (existing.widgetVersion !== expectedWidgetVersion) {
    reject(
      "stale-widget-version",
      `Expected widget version ${expectedWidgetVersion} but widget is at ${existing.widgetVersion}`,
    );
  }

  const next = update(existing as ZenWidgetElement<K>);
  const widget = next as Extract<ZenElementPayload, { kind: "notes" | "checklist" }>;
  if (widget.kind === "notes") validateNotesContent(widget.content);
  else validateChecklistItems(widget.items);

  const now = utcNow();
  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements: space.elements.map((element) => (element.elementId === elementId ? next : element)),
    updatedAt: now,
  };
}

export function saveNotes(
  space: ZenSpace,
  elementId: ZenElementId,
  content: string,
  expectedVersion: number,
  expectedWidgetVersion: number,
): ZenSpace {
  return updateWidgetElement(
    space,
    elementId,
    expectedVersion,
    expectedWidgetVersion,
    "notes",
    (element) => ({
      ...element,
      content,
      widgetVersion: (element.widgetVersion + 1) as AggregateVersion,
    }),
  );
}

export function addChecklistItem(
  space: ZenSpace,
  elementId: ZenElementId,
  itemId: ZenChecklistItem["itemId"],
  text: string,
  expectedVersion: number,
  expectedWidgetVersion: number,
): ZenSpace {
  return updateWidgetElement(
    space,
    elementId,
    expectedVersion,
    expectedWidgetVersion,
    "checklist",
    (element) => ({
      ...element,
      items: [...element.items, { itemId, text, done: false }],
      widgetVersion: (element.widgetVersion + 1) as AggregateVersion,
    }),
  );
}

export function setChecklistItemCompleted(
  space: ZenSpace,
  elementId: ZenElementId,
  itemId: ZenChecklistItem["itemId"],
  done: boolean,
  expectedVersion: number,
  expectedWidgetVersion: number,
): ZenSpace {
  return updateWidgetElement(
    space,
    elementId,
    expectedVersion,
    expectedWidgetVersion,
    "checklist",
    (element) => {
      if (!element.items.some((item) => item.itemId === itemId)) {
        reject("unknown-checklist-item", `Checklist item ${itemId} not found`);
      }
      return {
        ...element,
        items: element.items.map((item) => (item.itemId === itemId ? { ...item, done } : item)),
        widgetVersion: (element.widgetVersion + 1) as AggregateVersion,
      };
    },
  );
}

export function reorderChecklistItem(
  space: ZenSpace,
  elementId: ZenElementId,
  itemId: ZenChecklistItem["itemId"],
  beforeItemId: ZenChecklistItem["itemId"] | null,
  expectedVersion: number,
  expectedWidgetVersion: number,
): ZenSpace {
  return updateWidgetElement(
    space,
    elementId,
    expectedVersion,
    expectedWidgetVersion,
    "checklist",
    (element) => {
      const moving = element.items.find((item) => item.itemId === itemId);
      if (moving === undefined) {
        reject("unknown-checklist-item", `Checklist item ${itemId} not found`);
      }
      if (beforeItemId !== null && !element.items.some((item) => item.itemId === beforeItemId)) {
        reject("unknown-checklist-item", `Checklist item ${beforeItemId} not found`);
      }
      const remaining = element.items.filter((item) => item.itemId !== itemId);
      const targetIndex =
        beforeItemId === null
          ? remaining.length
          : remaining.findIndex((item) => item.itemId === beforeItemId);
      const items = [...remaining];
      items.splice(targetIndex, 0, moving);
      return {
        ...element,
        items,
        widgetVersion: (element.widgetVersion + 1) as AggregateVersion,
      };
    },
  );
}

export function removeChecklistItem(
  space: ZenSpace,
  elementId: ZenElementId,
  itemId: ZenChecklistItem["itemId"],
  expectedVersion: number,
  expectedWidgetVersion: number,
): ZenSpace {
  return updateWidgetElement(
    space,
    elementId,
    expectedVersion,
    expectedWidgetVersion,
    "checklist",
    (element) => {
      if (!element.items.some((item) => item.itemId === itemId)) {
        reject("unknown-checklist-item", `Checklist item ${itemId} not found`);
      }
      return {
        ...element,
        items: element.items.filter((item) => item.itemId !== itemId),
        widgetVersion: (element.widgetVersion + 1) as AggregateVersion,
      };
    },
  );
}

/**
 * Apply a remove-element command to a Zen space.
 */
export function removeElement(
  space: ZenSpace,
  elementId: ZenElementId,
  expectedVersion: number,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  const remaining = space.elements.filter((e) => e.elementId !== elementId);
  if (remaining.length === space.elements.length) {
    reject("unknown-element", `Element ${elementId} not found`);
  }

  // Renumber z-indices to maintain contiguous ordering
  const sorted = [...remaining].sort((a, b) => a.zIndex - b.zIndex);
  const renumbered = sorted.map((el, i) => ({
    ...el,
    zIndex: (i + 1) as typeof el.zIndex,
  }));

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements: renumbered,
    updatedAt: now,
  };
}

/**
 * Apply an update-viewport command to a Zen space.
 */
export function updateViewport(
  space: ZenSpace,
  viewport: ZenViewport,
  expectedVersion: number,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    viewport,
    updatedAt: now,
  };
}

/**
 * Apply an update-appearance command to a Zen space.
 */
export function updateAppearance(
  space: ZenSpace,
  appearance: ZenAppearance,
  expectedVersion: number,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }
  validateAppearance(appearance);

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    appearance,
    updatedAt: now,
  };
}

/**
 * Apply a set-presentation command to a Zen space.
 * Only the supplied flags are mutated; the other flag is preserved.
 */
export function setPresentation(
  space: ZenSpace,
  presentation: {
    readonly active?: boolean | undefined;
    readonly barCollapsed?: boolean | undefined;
  },
  expectedVersion: number,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  if (typeof presentation.active !== "boolean" && typeof presentation.barCollapsed !== "boolean") {
    reject("invalid-presentation", "set-presentation must include active or barCollapsed");
  }

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    ...(typeof presentation.active === "boolean" ? { active: presentation.active } : {}),
    ...(typeof presentation.barCollapsed === "boolean"
      ? { barCollapsed: presentation.barCollapsed }
      : {}),
    updatedAt: now,
  };
}

/**
 * Apply a bind-assistant command to a Zen space.
 */
export function bindAssistant(
  space: ZenSpace,
  assistant: ZenAssistantBinding,
  expectedVersion: number,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    assistant,
    updatedAt: now,
  };
}

/**
 * Apply a dock-research command to a Zen space.
 *
 * The dock holds a bound source context and how the person arranged it, never
 * anything the browsing context itself may do. A space with no dock stores
 * null, so closing one is the same write as opening one.
 */
export function dockResearch(
  space: ZenSpace,
  research: ZenResearchDock | null,
  expectedVersion: number,
): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }
  if (research !== null && research.sourceContext.threadKind === "chat") {
    reject("invalid-source-context", "A Chat thread has no browsing context to dock.");
  }

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    research,
    updatedAt: now,
  };
}

/**
 * Apply a recover command: reset the space to empty elements and defaults
 * while preserving the space identity. This is the safe recovery path for
 * invalid/unreachable Zen state.
 */
export function recoverSpace(space: ZenSpace, expectedVersion: number): ZenSpace {
  if (expectedVersion !== space.version) {
    reject("stale-version", `Expected version ${expectedVersion} but space is at ${space.version}`);
  }

  const now = utcNow();

  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements: [],
    viewport: DEFAULT_ZEN_VIEWPORT,
    appearance: DEFAULT_ZEN_APPEARANCE,
    updatedAt: now,
  };
}

export function timerRemainingMs(
  timer: ZenTimerElementPayload,
  clock: ZenTimerClockSample,
): number {
  if (timer.status !== "running" || timer.startedAt === null) return timer.remainingMs;
  const monotonicElapsed =
    timer.clockSessionId === clock.sessionId &&
    timer.monotonicStartedMs !== null &&
    clock.monotonicTimeMs >= timer.monotonicStartedMs
      ? clock.monotonicTimeMs - timer.monotonicStartedMs
      : undefined;
  const wallElapsed = Math.max(0, clock.wallTimeMs - Date.parse(timer.startedAt));
  const elapsed = monotonicElapsed ?? wallElapsed;
  return Math.max(0, timer.remainingMs - Math.floor(elapsed));
}

function stoppedTimer(
  timer: ZenTimerElementPayload,
  status: "idle" | "paused" | "completed",
  remainingMs: number,
): ZenTimerElementPayload {
  return {
    ...timer,
    status,
    remainingMs,
    startedAt: null,
    deadlineAt: null,
    clockSessionId: null,
    monotonicStartedMs: null,
  };
}

function replaceTimer(
  space: ZenSpace,
  timer: ZenTimerElementPayload,
  clock: ZenTimerClockSample,
): ZenSpace {
  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements: space.elements.map((element) =>
      element.elementId === timer.elementId ? timer : element,
    ),
    updatedAt: utcTimestampAt(clock.wallTimeMs),
  };
}

export function applyTimerAction(
  space: ZenSpace,
  command: ZenTimerActionCommand,
  clock: ZenTimerClockSample,
): ZenSpace {
  if (command.expectedVersion !== space.version) {
    reject(
      "stale-version",
      `Expected version ${command.expectedVersion} but space is at ${space.version}`,
    );
  }
  const element = space.elements.find((candidate) => candidate.elementId === command.elementId);
  if (element === undefined) reject("unknown-element", `Element ${command.elementId} not found`);
  if (element.kind !== "timer") reject("unsupported-kind", "Timer action requires a timer element");

  switch (command.action) {
    case "start": {
      if (element.status === "running" || element.status === "completed") return space;
      const startedAt = utcTimestampAt(clock.wallTimeMs);
      return replaceTimer(
        space,
        {
          ...element,
          status: "running",
          startedAt,
          deadlineAt: utcTimestampAt(clock.wallTimeMs + element.remainingMs),
          clockSessionId: clock.sessionId,
          monotonicStartedMs: clock.monotonicTimeMs,
        },
        clock,
      );
    }
    case "pause": {
      if (element.status !== "running") return space;
      const remainingMs = timerRemainingMs(element, clock);
      return replaceTimer(
        space,
        stoppedTimer(element, remainingMs === 0 ? "completed" : "paused", remainingMs),
        clock,
      );
    }
    case "reset": {
      if (element.status === "idle" && element.remainingMs === element.durationMs) return space;
      return replaceTimer(space, stoppedTimer(element, "idle", element.durationMs), clock);
    }
    case "set-duration": {
      if (element.status === "running") {
        reject("unsupported-kind", "Pause or reset a running timer before changing its duration");
      }
      const durationMs = command.durationMs;
      if (durationMs === undefined) {
        reject("unsupported-kind", "Set-duration requires a duration");
      }
      if (
        element.durationMs === durationMs &&
        element.status === "idle" &&
        element.remainingMs === durationMs
      ) {
        return space;
      }
      return replaceTimer(
        space,
        stoppedTimer({ ...element, durationMs }, "idle", durationMs),
        clock,
      );
    }
  }
}

export function reconcileRunningTimers(space: ZenSpace, clock: ZenTimerClockSample): ZenSpace {
  let changed = false;
  const elements = space.elements.map((element) => {
    if (element.kind !== "timer" || element.status !== "running") return element;
    if (timerRemainingMs(element, clock) > 0) return element;
    changed = true;
    return stoppedTimer(element, "completed", 0);
  });
  if (!changed) return space;
  return {
    ...space,
    version: (space.version + 1) as AggregateVersion,
    elements,
    updatedAt: utcTimestampAt(clock.wallTimeMs),
  };
}

export function reconcileScheduledTimer(
  space: ZenSpace,
  elementId: ZenElementId,
  clock: ZenTimerClockSample,
): ZenSpace {
  const element = space.elements.find((candidate) => candidate.elementId === elementId);
  if (element?.kind !== "timer" || element.status !== "running" || element.deadlineAt === null) {
    return space;
  }
  if (Date.parse(element.deadlineAt) > clock.wallTimeMs && timerRemainingMs(element, clock) > 0) {
    return space;
  }
  return replaceTimer(space, stoppedTimer(element, "completed", 0), clock);
}

/**
 * Process a Zen command against a space. Returns the updated space or
 * throws ZenPolicyRejected.
 */
export function processZenCommand(
  space: ZenSpace,
  command: ZenCommand,
  localHostId: HostId,
  timerClock?: ZenTimerClockSample,
): ZenSpace {
  switch (command.command) {
    case "add-element":
      return addElement(space, command.element, command.expectedVersion, localHostId);
    case "update-element":
      return updateElement(space, command.element, command.expectedVersion, localHostId);
    case "remove-element":
      return removeElement(space, command.elementId, command.expectedVersion);
    case "timer-action":
      if (timerClock === undefined) reject("recovery-required", "Timer clock is unavailable");
      return applyTimerAction(space, command, timerClock);
    case "update-viewport":
      return updateViewport(space, command.viewport, command.expectedVersion);
    case "update-appearance":
      return updateAppearance(space, command.appearance, command.expectedVersion);
    case "bind-assistant":
      return bindAssistant(space, command.assistant, command.expectedVersion);
    case "dock-research":
      return dockResearch(space, command.research, command.expectedVersion);
    case "save-notes":
      return saveNotes(
        space,
        command.elementId,
        command.content,
        command.expectedVersion,
        command.expectedWidgetVersion,
      );
    case "set-checklist-item-completed":
      return setChecklistItemCompleted(
        space,
        command.elementId,
        command.itemId,
        command.done,
        command.expectedVersion,
        command.expectedWidgetVersion,
      );
    case "reorder-checklist-item":
      return reorderChecklistItem(
        space,
        command.elementId,
        command.itemId,
        command.beforeItemId,
        command.expectedVersion,
        command.expectedWidgetVersion,
      );
    case "remove-checklist-item":
      return removeChecklistItem(
        space,
        command.elementId,
        command.itemId,
        command.expectedVersion,
        command.expectedWidgetVersion,
      );
    case "set-presentation":
      return setPresentation(space, command, command.expectedVersion);
    case "recover":
      return recoverSpace(space, command.expectedVersion);
    default:
      // create-space and create-timer are handled by the service because they allocate identities.
      reject("unsupported-kind", `Command ${command.command} not supported as mutation`);
  }
}

/**
 * Check whether a Zen space's checklist items could implicitly enter
 * persistent task or Thread Board projections. Returns true if the space
 * is clean (no implicit task leakage).
 */
export function checkChecklistIsolation(space: ZenSpace): boolean {
  // Zen-local checklist items are bounded by the ZenSpace aggregate and
  // never reference thread IDs or board models. This is a structural invariant.
  for (const element of space.elements) {
    if (element.kind === "checklist") {
      // Checklist items only have itemId, text, and done — no thread/board refs
      for (const item of element.items) {
        if (
          typeof item.itemId !== "string" ||
          typeof item.text !== "string" ||
          typeof item.done !== "boolean"
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Resolve accessibility fallbacks for a Zen appearance given system settings.
 */
export function resolveAccessibilityFallbacks(
  appearance: ZenAppearance,
  systemReducedMotion: boolean,
  systemReducedTransparency: boolean,
  systemIncreasedContrast: boolean,
): ZenAppearance {
  const reducedMotion = appearance.reducedMotion || systemReducedMotion;
  return {
    ...appearance,
    background: reducedMotion ? stillBackground(appearance.background) : appearance.background,
    reducedMotion,
    reducedTransparency: appearance.reducedTransparency || systemReducedTransparency,
    increasedContrast: appearance.increasedContrast || systemIncreasedContrast,
  };
}

function validateAppearance(appearance: ZenAppearance): void {
  const background = appearance.background;
  if (background.kind === "image" && background.assetId.length === 0) {
    reject("invalid-background", "Background asset ID is empty");
  }
  if (background.kind === "builtin") {
    try {
      getZenBuiltinBackground(background.presetId);
    } catch {
      reject("invalid-background", "Unknown Zen built-in background");
    }
  }
}

function stillBackground(background: ZenAppearance["background"]): ZenAppearance["background"] {
  if (background.kind === "image") {
    if (background.stillAssetId === undefined) return background;
    return {
      kind: "image",
      assetId: background.stillAssetId,
      overlay: background.overlay,
      fill: background.fill,
    };
  }
  if (background.kind !== "builtin") return background;
  const preset = getZenBuiltinBackground(background.presetId);
  if (preset.motion !== "animated" || preset.stillSrc === undefined) return background;
  const still = ZEN_BUILTIN_BACKGROUNDS.find(
    (candidate) => candidate.motion === "still" && candidate.src === preset.stillSrc,
  );
  if (still === undefined) return background;
  return { ...background, presetId: still.id };
}

/** Why a pinned thread card is not streaming. */
export type ZenLiveCardFrozenReason = "minimized" | "off-screen" | "budget";

export type ZenLiveCardActivity =
  | { readonly elementId: ZenElementId; readonly activity: "live" }
  | {
      readonly elementId: ZenElementId;
      readonly activity: "frozen";
      readonly reason: ZenLiveCardFrozenReason;
    };

/** The rectangle of a space a reader can currently see, in space coordinates. */
export interface ZenVisibleRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ZenLiveCardActivityInput {
  readonly elements: ReadonlyArray<ZenElementPayload>;
  readonly visibleRegion: ZenVisibleRegion;
  readonly focusedElementId?: ZenElementId;
  readonly budget?: number;
}

/**
 * Decide which pinned thread cards stream and which hold still.
 *
 * A frozen card is not a degraded card: it keeps its identity and its metadata
 * reading, and the reader brings it back by looking at it. Ranking follows what
 * the reader is doing — the focused card first, then the cards stacked nearest
 * the front — so panning or clicking a card is enough to resume it without a
 * separate control.
 *
 * Returns one entry per thread element in input order; widgets are not cards
 * and never appear.
 */
export function resolveZenLiveCardActivity(
  input: ZenLiveCardActivityInput,
): ReadonlyArray<ZenLiveCardActivity> {
  const budget = Math.max(0, input.budget ?? MAX_LIVE_ZEN_CARDS);
  const cards = input.elements.filter(
    (element) => element.kind === "thread" || element.kind === "terminal",
  );
  const frozen = new Map<ZenElementId, ZenLiveCardFrozenReason>();
  const eligible: Array<{ readonly element: ZenElementPayload; readonly order: number }> = [];
  cards.forEach((element, order) => {
    if (element.minimized) {
      frozen.set(element.elementId, "minimized");
      return;
    }
    if (!overlapsVisibleRegion(element.geometry, input.visibleRegion)) {
      frozen.set(element.elementId, "off-screen");
      return;
    }
    eligible.push({ element, order });
  });
  const live = new Set(
    eligible
      .sort((a, b) => {
        const focusedA = String(a.element.elementId) === String(input.focusedElementId) ? 1 : 0;
        const focusedB = String(b.element.elementId) === String(input.focusedElementId) ? 1 : 0;
        if (focusedA !== focusedB) return focusedB - focusedA;
        if (a.element.zIndex !== b.element.zIndex) return b.element.zIndex - a.element.zIndex;
        return a.order - b.order;
      })
      .slice(0, budget)
      .map((candidate) => candidate.element.elementId),
  );
  return cards.map((element) => {
    if (live.has(element.elementId)) {
      return { elementId: element.elementId, activity: "live" as const };
    }
    return {
      elementId: element.elementId,
      activity: "frozen" as const,
      reason: frozen.get(element.elementId) ?? ("budget" as const),
    };
  });
}

function overlapsVisibleRegion(geometry: ZenGeometry, region: ZenVisibleRegion): boolean {
  return (
    geometry.x < region.x + region.width &&
    geometry.x + geometry.width > region.x &&
    geometry.y < region.y + region.height &&
    geometry.y + geometry.height > region.y
  );
}
