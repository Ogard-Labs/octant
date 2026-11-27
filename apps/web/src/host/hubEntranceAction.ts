import { useCallback, useState } from "react";
import { failureMessage } from "../lib/failureMessage";
import type { HubAdministrationBridge, HubAdministrationOperation } from "../shell/hostBridge";

/**
 * What the public entrance's window screens share: one loopback request at a
 * time through the hub administration bridge, and one plain line saying what
 * happened or why the host refused. The host decides every action; the window
 * only asks and reports.
 */

export type HubRequest = HubAdministrationBridge["hubAdministrationRequest"];

export interface HubEntranceNotice {
  readonly kind: "success" | "error";
  readonly text: string;
}

export function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

export function list(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

export interface HubEntranceAction {
  readonly busy: boolean;
  readonly notice: HubEntranceNotice | undefined;
  readonly say: (notice: HubEntranceNotice | undefined) => void;
  /**
   * Sends one operation. Answers the reply's body when the host said
   * `expected` (or one of them), else says why it refused (from `refusals`
   * by kind, or the fallback) and answers undefined.
   */
  readonly run: (
    operation: HubAdministrationOperation,
    body: unknown,
    expected: string | ReadonlyArray<string>,
    fallback: string,
    refusals?: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
}

export function useHubEntranceAction(request: HubRequest): HubEntranceAction {
  const [busy, setBusy] = useState(false);
  const [notice, say] = useState<HubEntranceNotice>();
  const run = useCallback<HubEntranceAction["run"]>(
    async (operation, body, expected, fallback, refusals = {}) => {
      say(undefined);
      setBusy(true);
      try {
        const reply = await request(operation, body);
        const status = field(reply.body, "status");
        if (
          reply.status === 200 &&
          typeof status === "string" &&
          (typeof expected === "string" ? status === expected : expected.includes(status))
        )
          return reply.body;
        const kind = field(reply.body, "kind");
        const detail = field(reply.body, "message");
        say({
          kind: "error",
          text:
            typeof kind === "string" && refusals[kind] !== undefined
              ? refusals[kind]
              : typeof detail === "string" && detail !== ""
                ? detail
                : fallback,
        });
      } catch (error) {
        say({ kind: "error", text: failureMessage(error, fallback) });
      } finally {
        setBusy(false);
      }
      return undefined;
    },
    [request],
  );
  return { busy, notice, say, run };
}

/** "3 minutes ago", "yesterday at 14:05": when a delivery or comment arrived, in the window's own words. */
export function formatWhen(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Writes text to the clipboard and says whether it went, never claiming a copy that did not happen. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
