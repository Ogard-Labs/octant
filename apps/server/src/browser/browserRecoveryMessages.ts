import type { BrowserAutomationFailure, BrowserContextPolicy } from "@octant/contracts";

const ORIGIN_RECOVERY =
  "Call stop, then navigate to the intended URL, keeping the same profile argument if one was used, to request that site's approval. For SSO in the Octant app's Browser, call sign-in so the person can finish signing in.";

export function browserOriginRefusal(origin?: string): BrowserAutomationFailure {
  return {
    category: "policy-denied",
    reason: "origin-not-approved",
    message: `${origin === undefined ? "The requested site" : `The page moved to ${origin}, which`} is outside this page's approved origins. ${ORIGIN_RECOVERY}`,
  };
}

export function browserSignInOriginRefusal(): BrowserAutomationFailure {
  return {
    category: "policy-denied",
    reason: "origin-not-approved",
    message: `The person left the page on an unapproved site after Continue. Ask them to return to the approved site, or use the Browser tool to recover. ${ORIGIN_RECOVERY}`,
  };
}

export function browserExpiryFailure(
  profile: BrowserContextPolicy["profile"],
): BrowserAutomationFailure {
  if (profile?.kind === "account")
    return {
      category: "context-expired",
      message: `The Browser page expired in the selected named account profile. Call navigate without changing the task profile to reuse it; approval may be required. No page has been reopened.`,
    };
  const stored =
    profile?.kind === "project" || profile?.kind === "personal" ? profile.kind : undefined;
  return {
    category: "context-expired",
    message:
      stored === undefined
        ? "The Browser page expired. It used the Private profile. Call navigate with the intended URL to open a new Private page."
        : `The Browser page expired. It used the ${stored === "project" ? "Project" : "Personal"} profile. Call navigate with profile "${stored}" and the intended URL to reuse that profile; approval may be required. No page has been reopened.`,
  };
}
