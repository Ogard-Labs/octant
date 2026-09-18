import {
  NavigatorAssistantClientFailure,
  type NavigatorAssistantClient,
} from "@octant/client-runtime";
import type {
  NavigatorAssistantModelRef,
  NavigatorAssistantSettings,
  NavigatorAssistantSnapshot,
  SettingsDeepLink,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What the host said about Navigator, never what the renderer inferred.
 *
 * `unconfigured` and `unavailable` are separate arms because they are separate
 * facts with separate fixes: the first is a setting the user has not chosen
 * yet, the second is the host refusing right now. Neither collapses into an
 * empty transcript — a surface that showed a blank conversation for either
 * would be claiming Navigator answered with nothing.
 */
export type NavigatorAssistantState =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unconfigured"; readonly settingsTarget: SettingsDeepLink | undefined }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly settingsTarget: SettingsDeepLink | undefined;
    }
  | { readonly kind: "ready"; readonly snapshot: NavigatorAssistantSnapshot };

export interface NavigatorAssistantController {
  readonly state: NavigatorAssistantState;
  readonly busy: boolean;
  readonly send: (prompt: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export interface UseNavigatorAssistantOptions {
  /**
   * The window is a live workspace of this host. Snapshotting before that
   * registration is 403, not 401: the capability already authenticates, but
   * the host has not yet admitted the window. Wait rather than treating the
   * first connect as a denied principal.
   */
  readonly enabled?: boolean;
  /**
   * Identifies the host's current Navigator configuration — which provider and
   * model each role is pinned to.
   *
   * The host decides between `ready` and `unconfigured` from this
   * configuration, and it changes it without telling the renderer: choosing or
   * clearing a default model in Settings is an ordinary settings write. So the
   * previous answer stops being true the moment it changes, and without this
   * the profile menu kept offering a Navigator the host had already withdrawn,
   * or hid one it had just admitted, until the window was reloaded.
   */
  readonly configuration?: string;
}

/**
 * The identity of a Navigator configuration, for callers that watch the
 * shell's settings.
 *
 * Two configurations that pin the same roles to the same provider/model pairs
 * are the same configuration as far as the host's answer is concerned, so the
 * key is built from the roles rather than from object identity — a settings
 * write that changes something else must not look like a Navigator change.
 */
export function navigatorConfigurationKey(
  settings: NavigatorAssistantSettings | undefined,
): string {
  const role = (ref: NavigatorAssistantModelRef | undefined): string =>
    ref === undefined ? "" : `${String(ref.providerInstanceId)}/${String(ref.modelId)}`;
  return `${role(settings?.defaultProvider)}|${role(settings?.visionReviewer)}`;
}

/**
 * The controller for a surface that was given no Navigator at all. It reports
 * `unsupported` and does nothing, so a front rendered without one says so
 * rather than presenting a conversation it cannot reach.
 */
export const UNSUPPORTED_NAVIGATOR_ASSISTANT: NavigatorAssistantController = {
  state: { kind: "unsupported" },
  busy: false,
  send: async () => {},
  refresh: async () => {},
};

/**
 * The renderer's one reader of the host-owned Navigator surface.
 *
 * Both Navigator fronts — the utility dock panel and Zen's assistant — drive
 * this hook against the same client, so they observe one conversation running
 * on the one configured model rather than each keeping their own.
 *
 * There is no polling loop: the snapshot is re-read on mount, after every
 * send, when the host's Navigator configuration changes, and when the user
 * asks, exactly as Zen's assistant already refreshes.
 */
export function useNavigatorAssistant(
  client: NavigatorAssistantClient | undefined,
  options?: UseNavigatorAssistantOptions,
): NavigatorAssistantController {
  const enabled = options?.enabled !== false;
  const [state, setState] = useState<NavigatorAssistantState>(
    client === undefined ? { kind: "unsupported" } : { kind: "loading" },
  );
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (client === undefined) {
      setState({ kind: "unsupported" });
      return;
    }
    if (!enabled) {
      setState({ kind: "loading" });
      return;
    }
    try {
      const snapshot = await client.snapshot();
      if (!mounted.current) return;
      setState(
        snapshot.status === "unconfigured"
          ? { kind: "unconfigured", settingsTarget: snapshot.settingsTarget }
          : { kind: "ready", snapshot },
      );
    } catch (error) {
      if (!mounted.current) return;
      setState(failureState(error));
    }
  }, [client, enabled]);

  useEffect(() => {
    void read();
  }, [read, options?.configuration]);

  const send = useCallback(
    async (prompt: string) => {
      if (client === undefined || !enabled) return;
      setBusy(true);
      try {
        const result = await client.execute({ kind: "send-message", prompt });
        if (!mounted.current) return;
        setState(
          result.snapshot.status === "unconfigured"
            ? { kind: "unconfigured", settingsTarget: result.snapshot.settingsTarget }
            : { kind: "ready", snapshot: result.snapshot },
        );
      } catch (error) {
        if (mounted.current) setState(failureState(error));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [client, enabled],
  );

  return { state, busy, send, refresh: read };
}

/**
 * The host's own category decides the state. A 409 `unconfigured` is the
 * settings gap, not a failure to report as one, so it keeps its deep link and
 * offers the fix.
 */
function failureState(error: unknown): NavigatorAssistantState {
  if (error instanceof NavigatorAssistantClientFailure) {
    return error.category === "unconfigured"
      ? { kind: "unconfigured", settingsTarget: error.settingsTarget }
      : { kind: "unavailable", reason: error.message, settingsTarget: error.settingsTarget };
  }
  return {
    kind: "unavailable",
    reason: error instanceof Error ? error.message : "Navigator is unavailable.",
    settingsTarget: undefined,
  };
}
