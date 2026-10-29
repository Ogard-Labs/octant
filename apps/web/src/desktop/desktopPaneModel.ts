import type {
  DesktopInputEvent,
  DesktopLease,
  DesktopLeaseEndReason,
  DesktopLeaseRefusalReason,
  DesktopPaneAnswer,
  DesktopViewRefusalReason,
  LeasableDesktopProvider,
} from "@octant/contracts";

export type DesktopOverview = Extract<DesktopPaneAnswer, { readonly status: "overview" }>;

/**
 * What this tab holds of the selected lease's screen. `none` is a tab that
 * has not shown it in this window session, restored tabs included: it never
 * reconnects on its own. `lost` is a view that stopped while on screen.
 * `readable` is a view the host would not show because the connection to the
 * desktop could be read on its way.
 */
export type DesktopViewPresence = "none" | "opening" | "open" | "lost" | "readable";

/**
 * The pane's states. Each says what the host reports, never more:
 * `not-shown` is a running desktop this tab is not showing, which only the
 * person's Show desktop changes.
 */
export type DesktopPaneState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "setup"; readonly start: DesktopOverview["start"] }
  | { readonly kind: "acquiring"; readonly lease?: DesktopLease }
  | { readonly kind: "not-shown"; readonly lease: DesktopLease }
  | { readonly kind: "live"; readonly lease: DesktopLease }
  | { readonly kind: "interrupted"; readonly lease: DesktopLease }
  | { readonly kind: "session-readable"; readonly lease: DesktopLease }
  | { readonly kind: "releasing"; readonly lease: DesktopLease }
  | { readonly kind: "release-failed"; readonly lease: DesktopLease }
  | {
      readonly kind: "ended";
      readonly lease: DesktopLease;
      readonly start: DesktopOverview["start"];
    };

const HOLDS_DESKTOP: ReadonlySet<DesktopLease["state"]> = new Set([
  "requested",
  "provisioning",
  "ready",
  "releasing",
  "release-failed",
]);

/** Leases that may still hold a desktop: the tabs the pane offers, oldest first. */
export function runningDesktops(overview: DesktopOverview): ReadonlyArray<DesktopLease> {
  return overview.leases.filter((lease) => HOLDS_DESKTOP.has(lease.state));
}

/** The lease the pane shows: the one chosen if it is still listed, else the first running, else the last ended. */
export function selectedDesktop(
  overview: DesktopOverview,
  chosen: string | undefined,
): DesktopLease | undefined {
  const listed =
    chosen === undefined
      ? undefined
      : overview.leases.find((lease) => String(lease.leaseId) === chosen);
  return listed ?? runningDesktops(overview)[0] ?? overview.leases.at(-1);
}

export function desktopPaneState(input: {
  readonly overview: DesktopOverview | undefined;
  readonly failure?: string;
  readonly chosen?: string;
  readonly acquiring: boolean;
  readonly view: DesktopViewPresence;
}): DesktopPaneState {
  if (input.overview === undefined) {
    return input.failure === undefined
      ? { kind: "loading" }
      : { kind: "unavailable", message: input.failure };
  }
  const lease = selectedDesktop(input.overview, input.chosen);
  if (input.acquiring && (lease === undefined || !HOLDS_DESKTOP.has(lease.state))) {
    return { kind: "acquiring" };
  }
  if (lease === undefined) return { kind: "setup", start: input.overview.start };
  switch (lease.state) {
    case "requested":
    case "provisioning":
      return { kind: "acquiring", lease };
    case "ready":
      if (input.view === "open" || input.view === "opening") return { kind: "live", lease };
      if (input.view === "lost") return { kind: "interrupted", lease };
      if (input.view === "readable") return { kind: "session-readable", lease };
      return { kind: "not-shown", lease };
    case "releasing":
      return { kind: "releasing", lease };
    case "release-failed":
      return { kind: "release-failed", lease };
    case "released":
    case "refused":
    case "failed":
      return { kind: "ended", lease, start: input.overview.start };
  }
}

/** The provider's name for a lease, from the host's list; its id when the host no longer lists it. */
export function providerName(
  providers: ReadonlyArray<LeasableDesktopProvider>,
  providerId: string,
): string {
  return (
    providers.find((provider) => String(provider.providerId) === providerId)?.displayName ??
    providerId
  );
}

/**
 * Where a lease's desktop runs, for a provider with placements: the person's
 * machine the recipe named, or the placement's own name. Undefined for a
 * provider with no placements, whose name already says where.
 */
export function desktopWhere(
  providers: ReadonlyArray<LeasableDesktopProvider>,
  lease: DesktopLease,
): string | undefined {
  if (lease.machine !== undefined) return lease.machine.displayName;
  if (lease.placementId === undefined) return undefined;
  const placement = providers
    .find((provider) => String(provider.providerId) === String(lease.providerId))
    ?.placements?.find((entry) => String(entry.placementId) === String(lease.placementId));
  return placement?.displayName ?? String(lease.placementId);
}

/** Whole US cents as the person reads money: `$4.00`. */
export function desktopDollars(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** A worst-case duration in plain words: `8 hours`, `1 day`. */
export function desktopHours(minutes: number): string {
  if (minutes === 1_440) return "1 day";
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** Why the thread cannot start a desktop, in one sentence a person can act on or accept. */
export function startRefusalMessage(
  reason: DesktopLeaseRefusalReason | DesktopViewRefusalReason,
): string {
  switch (reason) {
    case "no-provider-configured":
      return "This Project has no desktop recipe yet, or its provider isn't on this host. Set one under Disposable desktop in the Project's settings.";
    case "provider-disabled":
      return "The desktop provider for this Project is turned off.";
    case "provider-unavailable":
      return "The desktop provider isn't ready on this host.";
    case "computer-use-off":
      return "Computer use is off in Settings.";
    case "plan-mode":
      return "A thread in Plan can't start a desktop.";
    case "thread-not-active":
      return "This thread is archived or completed.";
    case "not-permitted":
      return "This window can't open this thread's desktops.";
    case "not-leasable-mode":
      return "Only Work and Code threads can lease a desktop.";
    case "lease-limit":
      return "This thread or this host already runs as many desktops as it may.";
    case "release-pending":
      return "A desktop from this provider may still be running. No new one starts until Octant confirms it is gone.";
    case "declined":
      return "Starting a desktop was declined.";
    case "leased-by-another-thread":
      return "That desktop belongs to another thread.";
    case "lease-ended":
      return "That desktop has ended.";
    case "agent-cannot-extend":
      return "Only a person can extend a desktop.";
    case "beyond-maximum":
      return "The desktop can't run longer than its recipe allows.";
    case "extension-unconfirmed":
      return "The provider didn't confirm the new end time, so the desktop still ends when it was going to.";
    case "spend-unestimated":
      return "This desktop bills you, and its recipe has no cost per hour yet. Enter one under Disposable desktop in the Project's settings.";
    case "spend-cap-unset":
      return "Desktops that bill you are off until you set a monthly cap in Settings › Computer use.";
    case "spend-cap-reached":
      return "Starting this desktop could take this month's spending past your cap. Desktops already running keep running; raise the cap in Settings › Computer use, or wait for next month.";
    case "spend-cap-local-only":
      return "The monthly cap for desktops that bill you is set on the computer Octant runs on.";
    case "view-ended":
      return "This view of the desktop has ended.";
    case "view-limit":
      return "This desktop is already open in as many tabs as it may be.";
    case "session-readable":
      return "The connection to this desktop could be read on its way right now, so Octant shows nothing and sends nothing.";
  }
}

export function endedMessage(lease: DesktopLease): string {
  if (lease.credentialMissing === true) {
    return "The desktop could not be started: the key saved for it is no longer in this computer's credential store. Enter it again in the Project's desktop recipe.";
  }
  if (lease.state === "refused" || lease.state === "failed") {
    return lease.endReason === undefined
      ? "The desktop could not be started."
      : `The desktop stopped before it was ready. ${endReasonMessage(lease.endReason, lease.idleMinutes)}`;
  }
  return lease.endReason === undefined
    ? "The desktop was destroyed."
    : endReasonMessage(lease.endReason, lease.idleMinutes);
}

function endReasonMessage(reason: DesktopLeaseEndReason, idleMinutes: number): string {
  switch (reason) {
    case "released":
      return "It was released and destroyed.";
    case "expired":
      return "It reached its time limit and was destroyed.";
    case "idle":
      return `Nobody used it for ${idleMinutes} minutes, so it was destroyed.`;
    case "thread-ended":
      return "Its thread ended, so it was destroyed.";
    case "recipe-removed":
      return "The Project's desktop recipe changed, so it was destroyed.";
    case "provider-disabled":
      return "Its provider was turned off, so it was destroyed.";
    case "computer-use-off":
      return "Computer use was turned off, so it was destroyed.";
    case "host-restart":
      return "The host restarted, which destroys every desktop. A tab never reconnects to a desktop that ended.";
  }
}

/** Minutes a person may still add, up to the lease's maximum, in steps of 30. */
export function extensionMinutes(lease: DesktopLease): number {
  const room = Math.floor(
    (Date.parse(lease.maximumExpiresAt) - Date.parse(lease.expiresAt)) / 60_000,
  );
  return Math.max(0, Math.min(30, room));
}

/** A point on the shown picture, in the desktop's own pixels, or undefined off the picture. */
export function screenPoint(
  client: { readonly x: number; readonly y: number },
  shown: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  natural: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } | undefined {
  if (shown.width <= 0 || shown.height <= 0 || natural.width <= 0 || natural.height <= 0) {
    return undefined;
  }
  const x = Math.floor(((client.x - shown.left) * natural.width) / shown.width);
  const y = Math.floor(((client.y - shown.top) * natural.height) / shown.height);
  if (x < 0 || y < 0 || x >= natural.width || y >= natural.height) return undefined;
  return { x, y };
}

export type DesktopKeyIntent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly event: Extract<DesktopInputEvent, { kind: "key" }> }
  /** Leave the screen for the next control without sending anything. */
  | { readonly kind: "leave" }
  | { readonly kind: "ignore" };

/**
 * What one key press on a focused screen sends. A printable character with no
 * command modifier is typed as text, so any layout's characters arrive as
 * typed; everything else crosses as a named key the desktop maps or refuses.
 * Mod+Escape is never sent: it moves focus out, so the screen never traps the
 * keyboard.
 */
export function desktopKeyIntent(event: {
  readonly key: string;
  readonly type: "keydown" | "keyup";
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): DesktopKeyIntent {
  if (event.key === "Escape" && (event.ctrlKey || event.metaKey)) {
    return event.type === "keydown" ? { kind: "leave" } : { kind: "ignore" };
  }
  if (event.key === "Dead" || event.key === "Unidentified" || event.key === "Process") {
    return { kind: "ignore" };
  }
  const command = event.ctrlKey || event.metaKey || event.altKey;
  if ([...event.key].length === 1 && event.key !== " " && !command) {
    return event.type === "keydown" ? { kind: "text", text: event.key } : { kind: "ignore" };
  }
  return {
    kind: "key",
    event: { kind: "key", action: event.type === "keydown" ? "down" : "up", key: event.key },
  };
}
