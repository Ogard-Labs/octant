import {
  MAX_TOOL_EGRESS_HOST_LENGTH,
  TOOL_EGRESS_HOST_NAME_PATTERN,
  type AggregateId,
  type ToolEgressLaunchId,
  type ToolEgressRuleId,
} from "@octant/contracts";

/**
 * The decision the host's forward proxy makes for every request a confined
 * harness command sends: may this launch reach this host and port now.
 * Canonical: docs/architecture.md § Harness tool egress rules.
 *
 * The input holds the launch, the destination, the rules, and the time, and
 * nothing else. Learn-mode proposals are a separate record this decision never
 * reads, so no number of refused attempts and no unanswered proposal can turn
 * into an allowance. Resolution and the private-address check come after this
 * decision, in the proxy.
 */

export type ToolEgressRuleScope =
  | {
      readonly kind: "call";
      readonly threadId: AggregateId;
      readonly launchId: ToolEgressLaunchId;
    }
  | { readonly kind: "thread"; readonly threadId: AggregateId }
  | { readonly kind: "project"; readonly projectId: AggregateId };

export interface ToolEgressRule {
  readonly id: ToolEgressRuleId;
  readonly scope: ToolEgressRuleScope;
  /** An exact name or `*.name`, in the canonical form rules are stored in. */
  readonly host: string;
  readonly port: number;
  readonly expiresAt: string;
}

/**
 * The launch asking. A child names its parent and the parent's taint: it
 * holds no rules of its own, so it reaches exactly what its parent may.
 */
export interface ToolEgressLaunchFacts {
  readonly launchId: ToolEgressLaunchId;
  readonly threadId: AggregateId;
  readonly projectId: AggregateId;
  readonly threadTainted: boolean;
  readonly parent?: { readonly threadId: AggregateId; readonly tainted: boolean };
}

export interface ToolEgressRequest {
  readonly launch: ToolEgressLaunchFacts;
  readonly destination: { readonly host: string; readonly port: number };
  readonly rules: ReadonlyArray<ToolEgressRule>;
  readonly now: string;
}

export type ToolEgressDecision =
  | {
      readonly kind: "allow";
      readonly host: string;
      readonly port: number;
      readonly ruleId: ToolEgressRuleId;
      readonly scope: ToolEgressRuleScope["kind"];
    }
  | {
      readonly kind: "refuse";
      readonly reason: "ip-literal" | "invalid-port" | "invalid-name";
    }
  | {
      /** The two refusals learn mode may propose a rule for. */
      readonly kind: "refuse";
      readonly reason: "no-rule" | "expired";
      readonly host: string;
      readonly port: number;
    };

export type ToolEgressHostName =
  | { readonly kind: "name"; readonly host: string }
  | { readonly kind: "refused"; readonly reason: "ip-literal" | "invalid-name" };

// Characters that are never part of a host name: whitespace, controls, and
// URL delimiters a caller could use to make the parser read a different host.
const NON_HOST_CHARACTER = /[\s\u0000-\u001f\u007f/\\@?#%]/;
const DOTTED_IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * The name a destination is compared under: lowercase IDNA ASCII with no
 * trailing dot. An IPv4 literal in any spelling the URL host parser accepts
 * (`2130706433`, `0x7f.1`) and any IPv6 literal refuse as `ip-literal`; a
 * single-label name, `localhost` and names under it, a name carrying a port
 * (`example.com:443`), and anything else that is not a DNS name refuse as
 * `invalid-name`.
 */
export function canonicalToolEgressHost(raw: string): ToolEgressHostName {
  if (raw.includes(":") || raw.startsWith("[")) {
    return { kind: "refused", reason: isIpv6Literal(raw) ? "ip-literal" : "invalid-name" };
  }
  if (raw.length === 0 || NON_HOST_CHARACTER.test(raw)) {
    return { kind: "refused", reason: "invalid-name" };
  }
  const withoutRoot = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  let host: string;
  try {
    host = new URL(`http://${withoutRoot}/`).hostname;
  } catch {
    return { kind: "refused", reason: "invalid-name" };
  }
  if (DOTTED_IPV4.test(host) || host.startsWith("[")) {
    return { kind: "refused", reason: "ip-literal" };
  }
  if (host.length > MAX_TOOL_EGRESS_HOST_LENGTH || !TOOL_EGRESS_HOST_NAME_PATTERN.test(host)) {
    return { kind: "refused", reason: "invalid-name" };
  }
  return { kind: "name", host };
}

/** `::1` or `[::1]`: a colon alone does not make an address (`example.com:443` is a name with a port). */
function isIpv6Literal(raw: string): boolean {
  const address = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (address.includes("[") || address.includes("]") || NON_HOST_CHARACTER.test(address)) {
    return false;
  }
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The canonical form of what a rule may name, or `undefined` when it may not
 * be a rule. `*.name` needs `name` to be a valid name of at least two labels,
 * so `*.com` and `*.localhost` are not rules.
 */
export function canonicalToolEgressRuleHost(raw: string): string | undefined {
  const wildcard = raw.startsWith("*.");
  const name = canonicalToolEgressHost(wildcard ? raw.slice(2) : raw);
  if (name.kind !== "name") return undefined;
  return wildcard ? `*.${name.host}` : name.host;
}

export function decideToolEgress(request: ToolEgressRequest): ToolEgressDecision {
  const name = canonicalToolEgressHost(request.destination.host);
  if (name.kind === "refused" && name.reason === "ip-literal") {
    return { kind: "refuse", reason: "ip-literal" };
  }
  const port = request.destination.port;
  if (!isPort(port)) return { kind: "refuse", reason: "invalid-port" };
  if (name.kind === "refused") return { kind: "refuse", reason: "invalid-name" };

  const nowMs = Date.parse(request.now);
  let matchedExpired = false;
  for (const rule of request.rules) {
    if (!ruleApplies(rule.scope, request.launch)) continue;
    if (rule.port !== port || !ruleHostMatches(rule.host, name.host)) continue;
    const expiresMs = Date.parse(rule.expiresAt);
    // An unreadable time on either side counts as expired, never as live.
    if (!(nowMs < expiresMs)) {
      matchedExpired = true;
      continue;
    }
    return { kind: "allow", host: name.host, port, ruleId: rule.id, scope: rule.scope.kind };
  }
  return { kind: "refuse", reason: matchedExpired ? "expired" : "no-rule", host: name.host, port };
}

/**
 * Whose rules a launch may use. A child uses its parent's thread rules and
 * none of its own. Taint on the launching thread or its parent suspends
 * thread and Project rules for the launch; only `call` rules a person
 * confirmed for this very launch still apply.
 */
function ruleApplies(scope: ToolEgressRuleScope, launch: ToolEgressLaunchFacts): boolean {
  const ruleThreadId = launch.parent?.threadId ?? launch.threadId;
  const tainted = launch.threadTainted || launch.parent?.tainted === true;
  switch (scope.kind) {
    case "call":
      return (
        String(scope.launchId) === String(launch.launchId) &&
        String(scope.threadId) === String(ruleThreadId)
      );
    case "thread":
      return !tainted && String(scope.threadId) === String(ruleThreadId);
    case "project":
      return !tainted && String(scope.projectId) === String(launch.projectId);
  }
}

function ruleHostMatches(ruleHost: string, host: string): boolean {
  if (canonicalToolEgressRuleHost(ruleHost) !== ruleHost) return false;
  if (ruleHost.startsWith("*.")) return host.endsWith(ruleHost.slice(1));
  return ruleHost === host;
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Who answered a `network-access` approval. */
export type ToolEgressGrantPrincipalKind = "local-window" | "remote-device" | "reviewer";

export type ToolEgressGrantDecision =
  | { readonly kind: "grant" }
  | {
      readonly kind: "refuse";
      readonly reason:
        /** A tainted thread may be granted `call` rules only. */
        | "thread-tainted"
        /** Project rules need the person at a local window. */
        | "needs-local-window"
        /** A reviewer's answer yields `call` rules for one launch, nothing wider. */
        | "reviewer-call-only"
        /** A tainted thread's confirmation needs a person; a reviewer grants nothing there. */
        | "needs-person";
    };

/**
 * Whether this principal may grant a rule of this scope on a thread with
 * this taint. Read with the taint at the moment of granting, never an older
 * copy, so a thread tainted while a person looked at a proposal is refused
 * the standing rule they picked.
 */
export function decideToolEgressGrant(input: {
  readonly principal: ToolEgressGrantPrincipalKind;
  readonly scope: ToolEgressRuleScope["kind"];
  readonly threadTainted: boolean;
}): ToolEgressGrantDecision {
  if (input.principal === "reviewer") {
    if (input.threadTainted) return { kind: "refuse", reason: "needs-person" };
    if (input.scope !== "call") return { kind: "refuse", reason: "reviewer-call-only" };
    return { kind: "grant" };
  }
  if (input.threadTainted && input.scope !== "call") {
    return { kind: "refuse", reason: "thread-tainted" };
  }
  if (input.scope === "project" && input.principal !== "local-window") {
    return { kind: "refuse", reason: "needs-local-window" };
  }
  return { kind: "grant" };
}

/**
 * How long a rule lives from the moment it is granted. A `call` rule ends with
 * its launch; its lifetime only bounds a launch that never ends.
 */
export const TOOL_EGRESS_RULE_LIFETIME_MS = {
  call: 8 * 3_600_000,
  "1h": 3_600_000,
  "8h": 8 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
} as const;
export type ToolEgressRuleLifetime = keyof typeof TOOL_EGRESS_RULE_LIFETIME_MS;

/** The absolute expiry of a rule granted at `now`, or `undefined` when `now` is unreadable. */
export function toolEgressRuleExpiresAt(
  lifetime: ToolEgressRuleLifetime,
  now: string,
): string | undefined {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return undefined;
  return new Date(nowMs + TOOL_EGRESS_RULE_LIFETIME_MS[lifetime]).toISOString();
}

/** Whether a rule is still in force at `now`. An unreadable time on either side is not live. */
export function toolEgressRuleLive(expiresAt: string, now: string): boolean {
  return Date.parse(now) < Date.parse(expiresAt);
}
