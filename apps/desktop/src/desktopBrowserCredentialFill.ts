import { randomUUID } from "node:crypto";
import {
  decodeBrowserCredentialHostResult,
  type BrowserCredentialHostCommand,
  type BrowserCredentialHostResult,
} from "@octant/contracts/browser-credential-use";
import type {
  BrowserCredentialFillHostPort,
  BrowserCredentialValues,
  LinkedSecretStores,
} from "@octant/host-runtime";
import type { ReturnTypeOfBrowserSurfaceHost } from "./browserSurfaceHost";

type NativeFill = Pick<
  ReturnTypeOfBrowserSurfaceHost,
  | "reserveCredentialFill"
  | "validateCredentialFill"
  | "commitCredentialFill"
  | "cancelCredentialFill"
>;
interface Custody {
  readonly command: Extract<
    BrowserCredentialHostCommand,
    { readonly kind: "stage-browser-credential-fill" }
  >;
  readonly native: NativeFill;
  cancelled: boolean;
  readonly deadline: number;
  effectStarted: boolean;
  phase: "reading" | "ready" | "committing";
  values: BrowserCredentialValues | undefined;
  custodyId: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Credential values remain between the selected-store consumer and the native form effect. */
export function createDesktopBrowserCredentialFill(options: {
  readonly stores: LinkedSecretStores;
  readonly surface: () => NativeFill | undefined;
}): BrowserCredentialFillHostPort {
  const custody = new Map<string, Custody>();
  const receipts = new Map<
    string,
    {
      readonly command: BrowserCredentialHostCommand;
      readonly result: BrowserCredentialHostResult;
      readonly expires: number;
    }
  >();
  let closed = false;
  const receipt = (held: Custody, result: BrowserCredentialHostResult) => {
    while (receipts.size >= 64) {
      const first = receipts.keys().next().value;
      if (first === undefined) break;
      receipts.delete(first);
    }
    receipts.set(held.command.planId, {
      command: held.command,
      result,
      expires: Date.now() + 30_000,
    });
  };
  const cancel = (held: Custody, settled = false) => {
    held.cancelled = true;
    held.values = undefined;
    if (held.timer !== undefined) clearTimeout(held.timer);
    if (held.effectStarted) receipt(held, { status: "cancelled", effect: "possible" });
    if (held.phase === "reading" && !settled) return;
    held.native.cancelCredentialFill(
      held.command.contextId,
      held.command.owner,
      held.command.planId,
    );
    if (custody.get(held.command.planId) === held) custody.delete(held.command.planId);
  };
  const owns = (held: Custody, command: BrowserCredentialHostCommand) =>
    held.command.contextId === command.contextId &&
    String(held.command.owner.windowId) === String(command.owner.windowId) &&
    String(held.command.owner.threadId) === String(command.owner.threadId);
  return {
    close: () => {
      closed = true;
      for (const held of custody.values()) cancel(held);
    },
    execute: async (command): Promise<BrowserCredentialHostResult> => {
      for (const [id, saved] of receipts) if (saved.expires <= Date.now()) receipts.delete(id);
      const saved = receipts.get(command.planId);
      if (
        saved !== undefined &&
        command.kind !== "stage-browser-credential-fill" &&
        saved.command.contextId === command.contextId &&
        String(saved.command.owner.windowId) === String(command.owner.windowId) &&
        String(saved.command.owner.threadId) === String(command.owner.threadId)
      )
        return saved.result;
      if (command.kind === "cancel-browser-credential-fill") {
        const held = custody.get(command.planId);
        if (held !== undefined && owns(held, command)) {
          cancel(held);
          return { status: "cancelled", effect: held.effectStarted ? "possible" : "none" };
        } else
          options.surface()?.cancelCredentialFill(command.contextId, command.owner, command.planId);
        return { status: "cancelled", effect: "none" };
      }
      if (command.kind === "stage-browser-credential-fill") {
        const native = options.surface();
        if (
          closed ||
          Date.now() >= Date.parse(command.expiresAt) ||
          native === undefined ||
          options.stores.consumeBrowserCredential === undefined ||
          options.stores.browserRevisionCurrent === undefined ||
          custody.size >= 32 ||
          custody.has(command.planId)
        )
          return { status: "refused", reason: "unavailable" };
        const held: Custody = {
          command,
          native,
          cancelled: false,
          deadline: Date.parse(command.expiresAt),
          effectStarted: false,
          phase: "reading",
          values: undefined,
          custodyId: undefined,
          timer: undefined,
        };
        custody.set(command.planId, held);
        try {
          if (
            (
              await native.reserveCredentialFill(
                command.contextId,
                command.owner,
                command.planId,
                command.metadata.websiteOrigins,
              )
            ).status !== "reserved"
          ) {
            cancel(held, true);
            return { status: "refused", reason: "stale" };
          }
          if (held.cancelled) {
            cancel(held, true);
            return { status: "refused", reason: "cancelled" };
          }
          const result = await options.stores.consumeBrowserCredential(
            command.metadata,
            async (values) => {
              if (
                !held.cancelled &&
                Date.now() < held.deadline &&
                custody.get(command.planId) === held
              )
                held.values = values;
            },
          );
          if (
            held.cancelled ||
            Date.now() >= held.deadline ||
            custody.get(command.planId) !== held
          ) {
            cancel(held, true);
            return { status: "refused", reason: "cancelled" };
          }
          if (result.status !== "consumed") {
            cancel(held, true);
            return { status: "refused", reason: result.status };
          }
          if (
            held.values === undefined ||
            !(await native.validateCredentialFill(
              command.contextId,
              command.owner,
              command.planId,
            )) ||
            !options.stores.browserRevisionCurrent(command.metadata.storeRevision) ||
            held.cancelled ||
            Date.now() >= held.deadline
          ) {
            cancel(held, true);
            return { status: "refused", reason: "stale" };
          }
          held.phase = "ready";
          const custodyId = randomUUID();
          held.custodyId = custodyId;
          held.timer = setTimeout(
            () => cancel(held),
            Math.max(0, Math.min(30_000, held.deadline - Date.now())),
          );
          held.timer.unref();
          return decodeBrowserCredentialHostResult({ status: "ready", custodyId });
        } catch {
          cancel(held, true);
          return { status: "refused", reason: "unavailable" };
        }
      }
      const held = custody.get(command.planId);
      if (held !== undefined && owns(held, command) && held.phase === "committing")
        return { status: "refused", reason: "stale" };
      if (
        held === undefined ||
        !owns(held, command) ||
        held.phase !== "ready" ||
        held.custodyId !== command.custodyId ||
        held.values === undefined ||
        held.cancelled ||
        Date.now() >= held.deadline ||
        options.stores.browserRevisionCurrent?.(held.command.metadata.storeRevision) !== true
      ) {
        if (held !== undefined && owns(held, command)) cancel(held);
        return { status: "cancelled", effect: "none" };
      }
      held.phase = "committing";
      if (held.timer !== undefined) clearTimeout(held.timer);
      try {
        const result = await held.native.commitCredentialFill(
          command.contextId,
          command.owner,
          command.planId,
          held.values,
          () =>
            !held.cancelled &&
            Date.now() < held.deadline &&
            custody.get(command.planId) === held &&
            options.stores.browserRevisionCurrent?.(held.command.metadata.storeRevision) === true,
          () => {
            held.effectStarted = true;
          },
        );
        receipt(held, result);
        return result;
      } catch {
        const result = {
          status: "failed" as const,
          effect: held.effectStarted ? ("possible" as const) : ("none" as const),
        };
        receipt(held, result);
        return result;
      } finally {
        held.values = undefined;
        if (custody.get(command.planId) === held) custody.delete(command.planId);
      }
    },
  };
}
