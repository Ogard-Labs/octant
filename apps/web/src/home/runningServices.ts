import type { LocalServerHealth, RunningService } from "@octant/contracts";

/** More than a glance card holds; the rest are counted, not listed. */
export const RUNNING_SERVICES_ROW_LIMIT = 5;

/**
 * Collapse the host's listing to what the card can show. The host already
 * ordered it (servers Octant owns first, then the rest, each by port), so the
 * card takes the front of the list and says how many it left out.
 */
export function capRunningServices(services: ReadonlyArray<RunningService>): {
  readonly shown: ReadonlyArray<RunningService>;
  readonly hidden: number;
} {
  const shown = services.slice(0, RUNNING_SERVICES_ROW_LIMIT);
  return { shown, hidden: services.length - shown.length };
}

/** The name a person knows the server by: its framework, else its runtime. */
export function runningServiceName(service: RunningService): string {
  return service.framework ?? service.processName;
}

/** Where it came from: the Project, then the branch or thread the host could name. */
export function runningServiceOrigin(service: RunningService): string {
  const place = service.branch ?? service.thread?.title;
  return place === undefined ? service.projectName : `${service.projectName} · ${place}`;
}

/** Health in words; the card pairs it with a glyph, never a colour. */
export function runningServiceHealthLabel(health: LocalServerHealth): string {
  switch (health) {
    case "listening":
      return "Listening";
    case "unresponsive":
      return "Not responding";
    case "unknown":
      return "Not checked";
  }
}

/**
 * A server Octant does not own says so and nothing more. A dev server started
 * in Terminal, by Claude Code, or by Codex in a Project folder looks the same as
 * one an earlier Octant session left behind, so the row cannot say who started
 * it.
 */
export const NOT_OWNED_LABEL = "Not owned by Octant";

/** How the person asks to see a server live from another computer. */
export type RemoteOpenMode = "octant-browser" | "default-browser";

/** What the live opener answers; a refusal carries words fit for the row. */
export type RemoteOpenOutcome =
  /** `notice`: something the person should know about pages opened earlier, said once. */
  | { readonly kind: "opened"; readonly notice?: string }
  | { readonly kind: "refused"; readonly message: string };

/** One line, because the page runs on this computer and its dev server does not. */
export const REMOTE_OPEN_LIMITS =
  "Links to localhost inside the page won't load, and live reload may not connect.";

/**
 * What a row on another computer offers once this window can open a page live.
 * The host decides every grant again; this only keeps the row from offering a
 * control the host is certain to refuse, and says why in the plan's words.
 */
export type RemoteOpenOffer =
  | { readonly kind: "live" }
  | { readonly kind: "explained"; readonly reason: string };

export function remoteOpenOffer(
  service: RunningService,
  host: string,
): RemoteOpenOffer | undefined {
  if (!service.openAvailable || service.health !== "listening") return undefined;
  if (service.ownership !== "octant-owned") {
    return {
      kind: "explained",
      reason: `Octant didn't start this server, so it opens only on ${host}.`,
    };
  }
  if (service.thread === undefined) {
    return {
      kind: "explained",
      reason: `This server isn't in a thread, so it opens only on ${host}.`,
    };
  }
  return { kind: "live" };
}
