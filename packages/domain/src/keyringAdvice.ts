// What to tell a person when their computer's credential store would not take
// a key. The desktop's main process picks the sentence from the store's own
// failure and a window shows only sentences it recognises from this table, so
// it shows a cause it can act on and never a raw store diagnostic.

export type KeyringFailureReason =
  | "locked"
  | "no-login-collection"
  | "no-service"
  | "no-tool"
  | "denied"
  | "timed-out"
  | "unavailable"
  | "failed"
  | "invalid";

const KEYRING_ADVICE: Readonly<Record<KeyringFailureReason, string>> = {
  locked:
    "Your keyring is locked. Unlock it (open Passwords and Keys and unlock Login), then try again.",
  "no-login-collection":
    "Your session has no Login keyring to keep keys in. Create one named Login in Passwords and Keys, set it as default, then try again.",
  "no-service":
    "No keyring is running in your session, so Octant has nowhere to keep keys. Start one that provides Secret Service and unlock it, then try again. Octant notices it without a restart.",
  "no-tool":
    "Octant needs the secret-tool program to reach your keyring, and it is not installed. Install it (the libsecret-tools package on most systems), then try again.",
  denied:
    "Your keyring refused Octant access. Check that Octant runs as the same user as your session, then try again.",
  "timed-out":
    "Your keyring did not answer. If it is waiting for you to unlock it, unlock it (open Passwords and Keys and unlock Login), then try again.",
  unavailable:
    "Octant could not reach a secure credential store on this computer, so the key was not saved. Start and unlock your keyring, then try again.",
  failed:
    "Your keyring refused to keep the key. Try again, and check your keyring in Passwords and Keys if it keeps happening.",
  invalid: "Octant could not use that value as a key. Check it and enter it again.",
};

/** The sentence for a store failure, from its cause when it has one, else its category. */
export function keyringAdvice(failure: {
  readonly category: "failed" | "invalid" | "missing" | "unavailable";
  readonly cause?: string | undefined;
}): string | undefined {
  if (failure.cause !== undefined && failure.cause in KEYRING_ADVICE) {
    return KEYRING_ADVICE[failure.cause as KeyringFailureReason];
  }
  return failure.category === "missing" ? undefined : KEYRING_ADVICE[failure.category];
}

const KEYRING_ADVICE_MESSAGES: ReadonlyArray<string> = Object.values(KEYRING_ADVICE);

/** Whether a message is one of the sentences above, as the host wrote it. */
export function isKeyringAdvice(message: string): boolean {
  return KEYRING_ADVICE_MESSAGES.includes(message);
}
