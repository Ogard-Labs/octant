import type {
  BrowserActionKind,
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
    if (request.value === undefined || parseBrowserKeyChord(request.value) === undefined) {
      return {
        kind: "denied",
        reason: "Press action requires a supported browser key or key chord.",
      };
    }
  }
  if (
    (request.kind === "hover" ||
      request.kind === "select" ||
      request.kind === "drag" ||
      request.kind === "upload") &&
    request.target === undefined
  ) {
    return { kind: "denied", reason: `A ${request.kind} action requires an element.` };
  }
  if (request.kind === "select" && request.value === undefined) {
    return { kind: "denied", reason: "Select action requires the option to choose." };
  }
  if (request.kind === "drag" && request.destination === undefined) {
    return { kind: "denied", reason: "Drag action requires where to drop." };
  }
  if (request.kind === "upload" && (request.files === undefined || request.files.length === 0)) {
    return { kind: "denied", reason: "Upload action requires the files to send." };
  }
  if (
    (request.kind === "tab-select" || request.kind === "tab-close") &&
    request.tabId === undefined
  ) {
    return { kind: "denied", reason: `A ${request.kind} action requires a tab.` };
  }
  if (request.kind === "tab-open" && request.target !== undefined) {
    // A new tab reaches its page through the same admission as a navigation.
    if (!checkOriginAllowed(request.target, context.policy)) {
      return { kind: "denied", reason: "Navigation target origin is not in the allowlist." };
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

const BROWSER_KEY_MODIFIERS = ["Control", "Alt", "Shift", "Meta"] as const;
export type BrowserKeyModifier = (typeof BROWSER_KEY_MODIFIERS)[number];

/**
 * A key, or a chord of modifiers and one key, such as `Control+A` or
 * `Meta+Shift+K`. The key is a named key, a letter, a digit, or F1 to F12;
 * each modifier appears at most once. Anything else is not a key an agent may
 * press.
 */
export function parseBrowserKeyChord(
  value: string,
): { readonly modifiers: ReadonlyArray<BrowserKeyModifier>; readonly key: string } | undefined {
  const parts = value.split("+");
  const key = parts.pop();
  if (key === undefined || parts.length > BROWSER_KEY_MODIFIERS.length) return undefined;
  const modifiers: BrowserKeyModifier[] = [];
  for (const part of parts) {
    const modifier = BROWSER_KEY_MODIFIERS.find((candidate) => candidate === part);
    if (modifier === undefined || modifiers.includes(modifier)) return undefined;
    modifiers.push(modifier);
  }
  const named = SUPPORTED_BROWSER_KEYS.has(key) || key === "Space";
  if (!named && !/^(?:[A-Za-z0-9]|F[1-9]|F1[0-2])$/.test(key)) return undefined;
  return { modifiers, key };
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

/**
 * How far a paired device reaches into the host's browser.
 *
 * Watching a page and acting inside it are one thing; deciding what page the
 * host is on is another. A companion client taps, presses, and scrolls within
 * the view the host already opened, and reads what came back. Navigating,
 * typing, and closing tabs stay with the person at the machine, so a phone can
 * never point the host's browser at a new origin or put text into a field.
 */
export function remoteBrowserActionReach(kind: BrowserActionKind): BrowserPolicyDecision {
  if (kind === "navigate") {
    return { kind: "denied", reason: "Navigating the host's browser is not a remote action." };
  }
  if (kind === "type") {
    return { kind: "denied", reason: "Typing into the host's browser is not a remote action." };
  }
  if (kind === "close-tab") {
    return { kind: "denied", reason: "Closing a host browser tab is not a remote action." };
  }
  // Choosing an option, dragging, sending a file, and changing tabs decide what
  // the page holds or shows, as typing and navigating do.
  if (
    kind === "select" ||
    kind === "drag" ||
    kind === "upload" ||
    kind === "tab-open" ||
    kind === "tab-select" ||
    kind === "tab-close"
  ) {
    return { kind: "denied", reason: `A ${kind} action is not a remote action.` };
  }
  return { kind: "allowed" };
}

/**
 * Whether a page may sit at `target` under a context whose allowlist names
 * `allowedOrigins`. The allowlist is the context's whole authority, so the
 * match is by origin — with two readings a person means by one entry: a site's
 * `www.` host and its bare host are the same place, and a page an allowed
 * `http:` origin upgraded to `https:` is where it was headed anyway. Every
 * other host, and every port, stays exact. A redirect from `vg.no` to
 * `www.vg.no` used to leave the page blank with a notice to open the address
 * the person had just typed.
 */
export function originAllowed(target: string, allowedOrigins: ReadonlyArray<string>): boolean {
  const page = httpOrigin(target);
  if (page === undefined) return false;
  return allowedOrigins.some((allowed) => {
    const entry = httpOrigin(allowed);
    if (entry === undefined || entry.port !== page.port) return false;
    if (bareHost(entry.host) !== bareHost(page.host)) return false;
    return (
      entry.protocol === page.protocol || (entry.protocol === "http:" && page.protocol === "https:")
    );
  });
}

function bareHost(host: string): string {
  return host.startsWith("www.") ? host.slice("www.".length) : host;
}

function httpOrigin(
  value: string,
): { readonly protocol: string; readonly host: string; readonly port: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return { protocol: url.protocol, host: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return undefined;
  }
}
