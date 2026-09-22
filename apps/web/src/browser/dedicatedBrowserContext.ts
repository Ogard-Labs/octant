import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import {
  MAX_BROWSER_TABS_PER_CONTEXT,
  type BrowserContextId,
  type BrowserThreadId,
} from "@octant/contracts/browser-automation";
import { makeBrowserToolAction } from "./BrowserWorkspace";

export interface DedicatedBrowserOpenTarget {
  /** The one origin this context may reach. */
  readonly allowedOrigin: string;
  /** The page the context navigates to once it exists. */
  readonly url: string;
  /**
   * The host already decided this, and only for a loopback HTTPS origin: an
   * HTTPS dev server's self-signed localhost certificate is accepted by this
   * one context and nowhere else.
   */
  readonly acceptsLocalCertificate?: boolean;
}

/**
 * Realize a prepared Open target as a host-owned Browser context of its own.
 *
 * Every Open mints a fresh context confined to exactly the one prepared origin
 * and returns its identity, so the caller can open a tab bound to *that*
 * context. Nothing is reconciled against the thread's existing context: a
 * second classified server or conversation link neither inherits the first
 * context's origin nor stops its session to take the slot.
 */
export async function openDedicatedBrowserContext(
  client: BrowserAutomationClient,
  threadId: BrowserThreadId,
  mode: "work" | "code",
  target: DedicatedBrowserOpenTarget,
): Promise<BrowserContextId> {
  const scope = await client.resolve({ threadId, mode });
  const snapshot = await client.create({
    threadId,
    action: makeBrowserToolAction(
      scope,
      "Open one prepared page in a host-owned isolated browser context.",
    ),
    policy: {
      profileMode: "isolated",
      allowedOrigins: [target.allowedOrigin],
      credentialFieldProtection: true,
      maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
      sessionTimeoutMs: 300_000,
      ...(target.acceptsLocalCertificate === true ? { acceptsLocalCertificate: true } : {}),
    },
    dedicated: true,
  });
  const context = snapshot.context;
  if (context === undefined || context.state !== "active") {
    throw new Error(snapshot.failure?.message ?? "The host Browser context is unavailable.");
  }
  // Only the returned identity is adopted: the caller names a Browser tab after
  // it, and closing that tab is what stops the context. A context this Open
  // created but never returned is reachable from no tab, so it would hold a
  // host Browser session until the session timeout with no user close path.
  // Release it here and let the honest Open failure reach the user either way.
  try {
    await client.act({
      actionId: context.actionId,
      contextId: context.contextId,
      correlationId: context.correlationId,
      authority: scope.authority,
      kind: "navigate",
      target: target.url,
    });
  } catch (error) {
    await releaseBrowserContext(client, threadId, context.contextId);
    throw error;
  }
  return context.contextId;
}

/**
 * Stop a dedicated Browser context that no tab owns, so it cannot hold a host
 * Browser session no user control can reach.
 *
 * Best-effort by design: a failed release must not replace or swallow the
 * honest Open failure the caller is about to report.
 */
export async function releaseBrowserContext(
  client: BrowserAutomationClient,
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
): Promise<void> {
  await client.stop({ contextId, threadId }).catch(() => undefined);
}
