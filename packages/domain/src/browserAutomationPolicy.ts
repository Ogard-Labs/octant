import type {
  BrowserActionRequest,
  BrowserContextPolicy,
  BrowserContextRecord,
  BrowserObservation,
  ToolActionAuthority,
} from "@octant/contracts";
import { sameToolActionAuthority } from "@octant/contracts";

export type BrowserPolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

export function evaluateBrowserAction(
  request: BrowserActionRequest,
  context: BrowserContextRecord,
  granted: ToolActionAuthority,
): BrowserPolicyDecision {
  if (!sameToolActionAuthority(request.authority, context.authority)) {
    return { kind: "denied", reason: "Action authority does not match context authority." };
  }
  if (!sameToolActionAuthority(request.authority, granted)) {
    return { kind: "denied", reason: "Action authority does not match granted authority." };
  }
  if (request.contextId !== context.contextId) {
    return { kind: "denied", reason: "Action targets a different browser context." };
  }
  if (request.actionId !== context.actionId) {
    return {
      kind: "denied",
      reason: "Action identity does not match the owning browser context.",
    };
  }
  if (request.correlationId !== context.correlationId) {
    return {
      kind: "denied",
      reason: "Action correlation does not match the owning browser context.",
    };
  }
  if (context.state !== "active") {
    return { kind: "denied", reason: `Browser context is ${context.state}, not active.` };
  }
  if (request.kind === "click") {
    if ((request.target === undefined) === (request.point === undefined)) {
      return {
        kind: "denied",
        reason: "Click action requires exactly one selector or normalized viewport point.",
      };
    }
  }
  if (request.kind === "press") {
    if (request.value === undefined || !SUPPORTED_BROWSER_KEYS.has(request.value)) {
      return { kind: "denied", reason: "Press action requires a supported browser key." };
    }
  }
  if (request.kind !== "scroll" && (request.deltaX !== undefined || request.deltaY !== undefined)) {
    return { kind: "denied", reason: "Scroll deltas are valid only for scroll actions." };
  }
  if (request.kind === "navigate") {
    if (request.target === undefined) {
      return { kind: "denied", reason: "Navigate action requires a target URL." };
    }
    const originAllowed = checkOriginAllowed(request.target, context.policy);
    if (!originAllowed) {
      return { kind: "denied", reason: "Navigation target origin is not in the allowlist." };
    }
  }
  return { kind: "allowed" };
}

const SUPPORTED_BROWSER_KEYS = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function evaluateProfileMode(
  requestedMode: "isolated" | "existing-profile",
  policy: BrowserContextPolicy,
): BrowserPolicyDecision {
  if (requestedMode === "existing-profile" && policy.profileMode !== "existing-profile") {
    return { kind: "denied", reason: "Existing-profile mode requires explicit opt-in in policy." };
  }
  return { kind: "allowed" };
}

export function canRecordBrowserObservation(
  observation: BrowserObservation,
  context: BrowserContextRecord,
): boolean {
  return (
    observation.contextId === context.contextId &&
    observation.actionId === context.actionId &&
    observation.correlationId === context.correlationId &&
    sameToolActionAuthority(observation.authority, context.authority)
  );
}

export function isContextExpired(context: BrowserContextRecord, now: number): boolean {
  if (context.state !== "active" && context.state !== "creating") return false;
  const createdAt = new Date(context.createdAt).getTime();
  return now - createdAt >= context.policy.sessionTimeoutMs;
}

export function shouldProtectCredentialField(
  context: BrowserContextRecord,
  _fieldType: "password" | "otp" | "credit-card" | "ssn",
): boolean {
  return context.policy.credentialFieldProtection;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    // Try auto-prefixing https:// for bare hostnames
    try {
      return new URL(`https://${value}`).origin;
    } catch {
      return undefined;
    }
  }
}

function checkOriginAllowed(target: string, policy: BrowserContextPolicy): boolean {
  if (policy.allowedOrigins.length === 0) return false;
  const targetOrigin = normalizeOrigin(target);
  if (targetOrigin === undefined) return false;
  return policy.allowedOrigins.some((allowed) => {
    const allowedOrigin = normalizeOrigin(allowed);
    return allowedOrigin !== undefined && allowedOrigin === targetOrigin;
  });
}
