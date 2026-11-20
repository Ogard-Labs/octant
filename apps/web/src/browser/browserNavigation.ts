import type { BrowserThreadScope } from "@octant/contracts/browser-automation-rpc";
import type { ToolActionRequest } from "@octant/contracts/tool-actions";

/** One tool-action envelope for a host-owned Browser request under `scope`. */
export function makeBrowserToolAction(
  scope: BrowserThreadScope,
  intent: string,
): ToolActionRequest {
  return {
    actionId: crypto.randomUUID() as ToolActionRequest["actionId"],
    correlationId: crypto.randomUUID() as ToolActionRequest["correlationId"],
    capability: { id: "browser-automation" as ToolActionRequest["capability"]["id"], version: 1 },
    authority: scope.authority,
    intent,
    approval: { kind: "not-required" },
  };
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Browser supports HTTP and HTTPS addresses only.");
  }
  return url.toString();
}
