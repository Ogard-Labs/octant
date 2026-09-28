import { CircleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ProviderUsageLimit } from "@octant/contracts";
import { resetCountdownLabel } from "../lib/relativeTime";

/**
 * What the person is told when a provider's own protocol signal stopped a
 * turn on a usage limit. The copy is keyed on the normalized kind, never on
 * the provider's free-text message — a provider-reported fact chooses one of
 * three honest sentences, and nothing else can grow a countdown.
 */
export function usageLimitExplanation(limit: ProviderUsageLimit, provider: string): string {
  switch (limit.kind) {
    case "temporary":
      return `${provider} reached a temporary rate limit.`;
    case "exhausted":
      return `${provider}'s usage allowance on this account is exhausted.`;
    case "billing":
      return `${provider} reports a billing or credit problem on this account.`;
  }
}

/**
 * The reset line a limit can honestly show. A known absolute time becomes a
 * countdown; an unknown one says so outright rather than fabricating a timer
 * or promising a recovery the provider never announced. Billing stops get no
 * reset line — an account in arrears does not free up on a clock.
 */
export function usageLimitResetLine(limit: ProviderUsageLimit, now: number): string | undefined {
  if (limit.kind === "billing") return undefined;
  if (limit.resetsAt === undefined) {
    return "The provider did not say when this clears.";
  }
  return resetCountdownLabel(limit.resetsAt, now);
}

export function UsageLimitNotice(props: {
  readonly limit: ProviderUsageLimit;
  /** "Codex — luna" style label so the sentence names who stopped the turn. */
  readonly provider: string;
  /** The existing manual retry affordance for the mode; no auto-retry. */
  readonly action?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  // A named reset time becomes a countdown that must keep moving while the
  // notice sits parked; without one the line is static and the tick never
  // needs to run.
  const countdown =
    props.limit.kind !== "billing" && props.limit.resetsAt !== undefined ? true : false;
  useEffect(() => {
    if (!countdown) return;
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [countdown]);
  const reset = usageLimitResetLine(props.limit, now);
  return (
    <div className="callout callout-warn" role="alert">
      <CircleAlert aria-hidden="true" size={16} />
      <div>
        <p>{usageLimitExplanation(props.limit, props.provider)}</p>
        {reset === undefined ? null : <p>{reset}</p>}
        {props.action}
      </div>
    </div>
  );
}
