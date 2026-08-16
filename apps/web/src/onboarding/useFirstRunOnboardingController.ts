import type { FirstRunOnboardingStatus } from "@octant/contracts/shell";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellControllerStatus } from "../shell/useShellController";

export type FirstRunOnboardingOutcome = "completed" | "skipped";

export interface UseFirstRunOnboardingControllerOptions {
  /**
   * Projected host state. `pending` is the only value that means first run;
   * `undefined` means no authoritative settings have arrived yet.
   */
  readonly onboarding: FirstRunOnboardingStatus | undefined;
  readonly shellStatus: ShellControllerStatus;
  /**
   * Record the outcome on the host. Resolving does not imply the host accepted
   * it; the authoritative `onboarding` value does.
   */
  readonly resolve: (outcome: FirstRunOnboardingOutcome) => Promise<void>;
}

export interface FirstRunOnboardingController {
  readonly visible: boolean;
  readonly submitting: FirstRunOnboardingOutcome | undefined;
  /** Honest reason the host cannot record an answer, when there is one. */
  readonly blockedMessage: string | undefined;
  readonly complete: () => void;
  readonly skip: () => void;
  /**
   * Stand the surface down for this session without answering. Used when the
   * surface sends the user somewhere else to finish setup: the modal must not
   * stay over the destination, and the host's `pending` status must stay
   * truthful, because the user has neither completed nor skipped first run.
   */
  readonly defer: () => void;
}

const BLOCKED_COPY: Partial<Record<ShellControllerStatus, string>> = {
  disconnected:
    "Octant cannot reach the host right now, so your answer cannot be recorded. First-run setup will appear again until it is.",
  "recovery-required":
    "The host store needs recovery before it can record your answer. First-run setup will appear again until it is.",
  "conflict-reload":
    "Another window changed this host's settings. Reload to see the current state before answering.",
};

/**
 * Drive the first-run surface from host state (`BOOT-01`).
 *
 * Whether first run is *answered* is derived from the projected shell settings
 * alone, never from renderer storage, so a store that has recorded an answer
 * never shows the surface again and a clean store always does. A superseded
 * attempt is discarded by generation, so a slow first answer cannot clear the
 * busy state of the answer that replaced it or report its own outcome
 * afterwards.
 *
 * `defer` is the one renderer-local part, and deliberately records nothing: it
 * stands the surface down for this session only, so a user sent to Settings is
 * not answered for. A clean store still shows first run on the next launch.
 */
export function useFirstRunOnboardingController(
  options: UseFirstRunOnboardingControllerOptions,
): FirstRunOnboardingController {
  const [submitting, setSubmitting] = useState<FirstRunOnboardingOutcome | undefined>(undefined);
  const [deferred, setDeferred] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { onboarding, shellStatus, resolve } = options;

  const record = useCallback(
    (outcome: FirstRunOnboardingOutcome) => {
      if (shellStatus !== "ready") return;
      const attempt = ++generation.current;
      setSubmitting(outcome);
      void resolve(outcome).finally(() => {
        if (!mounted.current || generation.current !== attempt) return;
        setSubmitting(undefined);
      });
    },
    [resolve, shellStatus],
  );

  const complete = useCallback(() => {
    record("completed");
  }, [record]);
  const skip = useCallback(() => {
    record("skipped");
  }, [record]);
  const defer = useCallback(() => {
    setDeferred(true);
  }, []);

  return {
    // Without authoritative settings the store's answer is unknown, so the
    // surface stays hidden rather than flashing over it.
    visible: shellStatus !== "loading" && onboarding === "pending" && !deferred,
    submitting,
    blockedMessage: BLOCKED_COPY[shellStatus],
    complete,
    skip,
    defer,
  };
}
