import type { OctantMode } from "@octant/contracts/modes";

/**
 * The modes a person sees. Chat and Work stay separate server domains with
 * their own authority (Chat has no filesystem or shell; Work binds one
 * confined folder), but the shell presents them as one Work mode whose
 * composer chooses which kind of thread to start.
 */
export type VisibleMode = "work" | "code";

/** The kind of thread a Work composer starts: a Chat, or Work in a folder. */
export type WorkKind = "chat" | "work";

export const VISIBLE_MODE_ORDER: ReadonlyArray<VisibleMode> = ["work", "code"];

export function visibleModeOf(mode: OctantMode): VisibleMode {
  return mode === "code" ? "code" : "work";
}

/** Work is offered while either of its kinds is enabled; Code always is. */
export function visibleModes(enabled: ReadonlyArray<OctantMode>): ReadonlyArray<VisibleMode> {
  return VISIBLE_MODE_ORDER.filter((mode) =>
    mode === "code"
      ? enabled.includes("code")
      : enabled.includes("chat") || enabled.includes("work"),
  );
}

export function enabledWorkKinds(enabled: ReadonlyArray<OctantMode>): ReadonlyArray<WorkKind> {
  return (["chat", "work"] as const).filter((kind) => enabled.includes(kind));
}

/**
 * Which kind Work opens on: the last one the person used while it is still
 * enabled, else Chat, else Work. Undefined only when both are off, and then
 * Work is not offered at all.
 */
export function resolveWorkKind(
  preferred: WorkKind | undefined,
  enabled: ReadonlyArray<OctantMode>,
): WorkKind | undefined {
  const kinds = enabledWorkKinds(enabled);
  if (preferred !== undefined && kinds.includes(preferred)) return preferred;
  return kinds[0];
}

const WORK_KIND_KEY = "octant.shell.work-kind.v1";

export function readPreferredWorkKind(
  storage: Pick<Storage, "getItem"> | undefined,
): WorkKind | undefined {
  try {
    const value = storage?.getItem(WORK_KIND_KEY);
    return value === "chat" || value === "work" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writePreferredWorkKind(
  kind: WorkKind,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(WORK_KIND_KEY, kind);
  } catch {
    // A window without storage simply opens Work on its default kind next time.
  }
}
