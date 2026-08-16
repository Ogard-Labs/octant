export interface UnlockAttemptGuard {
  readonly begin: () => number;
  readonly invalidate: () => void;
  readonly isCurrent: (attempt: number) => boolean;
}

export function shouldSuppressAutoUnlockAfterPrompt(promptInFlight: boolean): boolean {
  return promptInFlight;
}

export type UnlockAppState = "active" | "background" | "inactive" | "unknown" | "extension" | null;

export function shouldPreserveVaultForAppState(input: {
  readonly nextState: UnlockAppState;
  readonly highRiskPromptInFlight: boolean;
  readonly vaultUnlockInFlight?: boolean;
}): boolean {
  return (
    input.nextState === "inactive" &&
    (input.highRiskPromptInFlight || input.vaultUnlockInFlight === true)
  );
}

export function resolveUnlockCompletion(input: {
  readonly appState: UnlockAppState;
  readonly attemptCurrent: boolean;
  readonly resultStatus: "unlocked" | "locked";
}): "unlock" | "lock" | "ignore" {
  if (!input.attemptCurrent) return "ignore";
  if (input.appState === null) return "lock";
  if (input.appState !== "active") return "ignore";
  return input.resultStatus === "unlocked" ? "unlock" : "lock";
}

export function createUnlockAttemptGuard(): UnlockAttemptGuard {
  let generation = 0;

  return {
    begin: () => {
      generation += 1;
      return generation;
    },
    invalidate: () => {
      generation += 1;
    },
    isCurrent: (attempt) => attempt === generation,
  };
}
