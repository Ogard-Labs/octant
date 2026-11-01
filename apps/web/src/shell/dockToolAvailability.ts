import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { ShipPlan, ShipTarget, ThreadPlan } from "@octant/contracts";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/**
 * Whether the dock may offer Plan: a current artifact, not a withdrawn or
 * empty proposal form.
 */
export function isCurrentPlanArtifact(plan: ThreadPlan | null | undefined): boolean {
  return plan != null && plan.status !== "withdrawn";
}

/**
 * Whether Delivery may appear: an enabled target, or a plan the host already
 * asked the reader to approve.
 */
export function hasActionableDelivery(input: {
  readonly targets: ReadonlyArray<Pick<ShipTarget, "enabled">>;
  readonly plan?: ShipPlan;
}): boolean {
  return input.plan !== undefined || input.targets.some((target) => target.enabled);
}

/**
 * A Canvas the dock can open in place. Unauthorized or failed cards are not
 * documents this thread can address.
 */
export function isAuthorizedCanvasDocument(
  card: Pick<CanvasThreadReferenceCard, "status">,
): boolean {
  return card.status !== "unauthorized" && card.status !== "invalid" && card.status !== "failed";
}

export interface DockToolCapabilities {
  readonly hasPlanArtifact: boolean | "unknown";
  readonly hasDelivery: boolean | "unknown";
  readonly hasCanvasDocument: boolean | "unknown";
  /** A turn wrote a Markdown or text document this thread can show. */
  readonly hasWrittenDocument: boolean;
  readonly hasAppleSimulator: boolean;
  readonly hasChildRuns: boolean | "unknown";
  readonly addAgentInvoked: boolean;
  /** An existing Chat, Work, or Code thread, including one with zero children. */
  readonly hasExistingThread: boolean;
  /**
   * The thread is a Code thread in a Project on one of the person's servers.
   * Absent for every other thread.
   */
  readonly serverCheckout?: boolean;
}

/**
 * The tools a thread in a server Project keeps. Every other tool reads or acts
 * on a folder, a browser, a device, or a desktop of this host, which the host
 * refuses for such a thread, so the dock does not offer them.
 */
const SERVER_CHECKOUT_TOOLS: ReadonlySet<RightUtilityDockSurfaceId> = new Set([
  "side-chat",
  "document",
  "canvas",
  "plan",
  "agents",
  "terminal",
]);

/**
 * Capability-gated tools stay off the launcher until the host says they exist.
 * Unknown keeps an already-open tool mounted so a loading read cannot close it.
 */
export function isDockToolLaunchable(
  surface: RightUtilityDockSurfaceId,
  capabilities: DockToolCapabilities,
): boolean {
  if (capabilities.serverCheckout === true && !SERVER_CHECKOUT_TOOLS.has(surface)) return false;
  if (surface === "plan") return capabilities.hasPlanArtifact === true;
  if (surface === "delivery") return capabilities.hasDelivery === true;
  if (surface === "canvas") return capabilities.hasCanvasDocument === true;
  if (surface === "document") return capabilities.hasWrittenDocument;
  if (surface === "ios-simulator") return capabilities.hasAppleSimulator;
  if (surface === "agents") {
    return (
      capabilities.hasExistingThread ||
      capabilities.hasChildRuns === true ||
      capabilities.addAgentInvoked
    );
  }
  return true;
}

export function isDockToolStillOpenable(
  surface: RightUtilityDockSurfaceId,
  capabilities: DockToolCapabilities,
): boolean {
  if (capabilities.serverCheckout === true && !SERVER_CHECKOUT_TOOLS.has(surface)) return false;
  if (surface === "plan") return capabilities.hasPlanArtifact !== false;
  if (surface === "delivery") return capabilities.hasDelivery !== false;
  if (surface === "canvas") return capabilities.hasCanvasDocument !== false;
  if (surface === "document") return capabilities.hasWrittenDocument;
  if (surface === "ios-simulator") return capabilities.hasAppleSimulator;
  if (surface === "agents") {
    return (
      capabilities.hasExistingThread ||
      capabilities.hasChildRuns !== false ||
      capabilities.addAgentInvoked
    );
  }
  return true;
}
