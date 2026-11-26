// This host's public entrance: the person's switch, the loopback listener it
// opens, the Funnel front, and the rules that close both. The entrance opens
// only while the switch is on, remote access is not paused, and the host is a
// hub or a member of one. Pausing remote access closes it and turns Funnel off;
// resuming reopens the listener but never turns Funnel back on, so Octant runs
// a Tailscale command only for a person's own switch or pause.

import {
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type PublicForwardAnswer,
  type PublicForwardEnvelope,
  type PublicFunnelPort,
} from "@octant/contracts";
import type { HubStatePort, PublicEntranceState } from "./hubStateStore";
import {
  startPublicEntrance,
  type PublicEntrance,
  type PublicEntranceHandlers,
  type PublicEntranceRole,
} from "./publicEntrance";
import type { TailscaleExec } from "./tailscaleCliDaemon";
import { createTailscaleFunnel, type TailscaleFunnel } from "./tailscaleFunnel";

/** Whether this host acts as the hub, is a member that forwards to it, or is in no hub at all. */
export type PublicEntranceHostRole = "hub" | "member" | "none";

export interface PublicEntranceServiceOptions {
  readonly state: HubStatePort;
  readonly exec: TailscaleExec;
  readonly platform: NodeJS.Platform;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly remoteAccessPaused: () => boolean;
  /** The private listener's port, when it runs; Funnel must not shadow it. */
  readonly privateListenerPort: () => number | undefined;
  readonly role: () => PublicEntranceHostRole;
  /** The features that plug into the route table; absent ones answer 404. */
  readonly handlers?: () => PublicEntranceHandlers;
  /** Hands a request to the acting hub over the pinned private transport. */
  readonly forward?: (envelope: PublicForwardEnvelope) => Promise<PublicForwardAnswer | undefined>;
}

export type PublicEntranceSwitchOutcome =
  | { readonly status: "changed"; readonly enabled: boolean }
  | { readonly status: "refused"; readonly kind: "not-in-a-hub" | "listener-failed" };

export type PublicFunnelOutcome =
  | { readonly status: "changed"; readonly enabled: boolean; readonly port?: PublicFunnelPort }
  | {
      readonly status: "refused";
      readonly kind:
        | "entrance-off"
        | "remote-access-paused"
        | "port-shadows-private-listener"
        | "funnel-not-allowed"
        | "daemon-not-reachable"
        | "funnel-off-failed";
    };

export interface PublicEntranceStatus {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly role: PublicEntranceHostRole;
  readonly paused: boolean;
  readonly port?: number;
  /** Where the person points their own front: the loopback address on this machine. */
  readonly address?: string;
  readonly funnel: { readonly enabled: boolean; readonly port?: PublicFunnelPort };
}

const DEFAULT_FUNNEL_PORT: PublicFunnelPort = 443;

export class PublicEntranceService {
  readonly #options: PublicEntranceServiceOptions;
  readonly #funnel: TailscaleFunnel;
  #entrance: PublicEntrance | undefined;
  /** One change at a time, so a pause and a switch cannot open and close the listener out of order. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PublicEntranceServiceOptions) {
    this.#options = options;
    this.#funnel = createTailscaleFunnel({ exec: options.exec, platform: options.platform });
  }

  status(): PublicEntranceStatus {
    const saved = this.#saved();
    const port = this.#entrance?.port ?? saved?.port;
    return {
      enabled: saved?.enabled === true,
      listening: this.#entrance !== undefined,
      role: this.#options.role(),
      paused: this.#options.remoteAccessPaused(),
      ...(port === undefined ? {} : { port, address: `http://127.0.0.1:${port}` }),
      funnel:
        saved?.funnel === undefined
          ? { enabled: false }
          : { enabled: true, port: saved.funnel.port },
    };
  }

  setEnabled(
    enabled: boolean,
    principal: AuditActingPrincipal,
  ): Promise<PublicEntranceSwitchOutcome> {
    return this.#serially(async () => {
      if (enabled && this.#options.role() === "none") {
        return { status: "refused", kind: "not-in-a-hub" } as const;
      }
      const saved = this.#saved();
      if (!enabled && saved?.funnel !== undefined) {
        // Turning the entrance off turns its front off first; a front left
        // pointing at a closed port would only answer 502.
        const off = await this.#funnel.off(saved.funnel.port);
        if (off.status === "done") this.#save({ ...saved, funnel: undefined });
      }
      const current = this.#saved();
      this.#save({
        enabled,
        ...(current?.port === undefined ? {} : { port: current.port }),
        ...(current?.funnel === undefined ? {} : { funnel: current.funnel }),
      });
      this.#options.record({
        change: "public-entrance-switch-changed",
        actingPrincipal: principal,
      });
      const opened = await this.#reconcile();
      if (enabled && !opened) return { status: "refused", kind: "listener-failed" } as const;
      return { status: "changed", enabled } as const;
    });
  }

  setFunnel(
    input: { readonly enabled: boolean; readonly port?: PublicFunnelPort },
    principal: AuditActingPrincipal,
  ): Promise<PublicFunnelOutcome> {
    return this.#serially(async (): Promise<PublicFunnelOutcome> => {
      const saved = this.#saved();
      if (!input.enabled) {
        if (saved?.funnel === undefined) return { status: "changed", enabled: false };
        const off = await this.#funnel.off(saved.funnel.port);
        if (off.status !== "done") return { status: "refused", kind: "funnel-off-failed" };
        this.#save({ ...saved, funnel: undefined });
        this.#options.record({ change: "public-funnel-changed", actingPrincipal: principal });
        return { status: "changed", enabled: false };
      }
      if (saved?.enabled !== true) return { status: "refused", kind: "entrance-off" };
      if (this.#options.remoteAccessPaused()) {
        return { status: "refused", kind: "remote-access-paused" };
      }
      const port = input.port ?? DEFAULT_FUNNEL_PORT;
      // Funnel on a port the private listener serves on the same tailnet name
      // would take that port over and hide the private listener behind it.
      if (port === this.#options.privateListenerPort()) {
        return { status: "refused", kind: "port-shadows-private-listener" };
      }
      await this.#reconcile();
      const localPort = this.#entrance?.port;
      if (localPort === undefined) return { status: "refused", kind: "entrance-off" };
      if (saved.funnel !== undefined && saved.funnel.port !== port) {
        const off = await this.#funnel.off(saved.funnel.port);
        if (off.status !== "done") return { status: "refused", kind: "funnel-off-failed" };
      }
      const on = await this.#funnel.on({ publicPort: port, localPort });
      if (on.status !== "done") {
        this.#save({ ...this.#savedOrOff(), funnel: undefined });
        return { status: "refused", kind: on.kind };
      }
      this.#save({ ...this.#savedOrOff(), funnel: { port } });
      this.#options.record({ change: "public-funnel-changed", actingPrincipal: principal });
      return { status: "changed", enabled: true, port };
    });
  }

  /** Opens or closes the listener to match the switch, the pause, and the role. */
  reconcile(): Promise<boolean> {
    return this.#serially(() => this.#reconcile());
  }

  /** A request another member's entrance forwarded; only the acting hub with its entrance on runs it. */
  async dispatchForwarded(envelope: PublicForwardEnvelope): Promise<PublicForwardAnswer> {
    const entrance = this.#entrance;
    if (entrance === undefined || this.#entranceRole() !== "serve") {
      return { status: 404, headers: {}, body: "" };
    }
    return entrance.dispatchForwarded(envelope);
  }

  close(): Promise<void> {
    return this.#serially(async () => {
      const entrance = this.#entrance;
      this.#entrance = undefined;
      await entrance?.close();
    });
  }

  async #reconcile(): Promise<boolean> {
    const saved = this.#saved();
    const paused = this.#options.remoteAccessPaused();
    const role = this.#options.role();
    const open = saved?.enabled === true && !paused && role !== "none";
    if (!open && saved?.funnel !== undefined && (paused || role === "none")) {
      // The pause or the end of the hub role is the journaled act; the front
      // goes with it, and only the person turns it back on.
      const off = await this.#funnel.off(saved.funnel.port);
      if (off.status === "done") this.#save({ ...saved, funnel: undefined });
    }
    if (!open) {
      const entrance = this.#entrance;
      this.#entrance = undefined;
      await entrance?.close();
      return false;
    }
    if (this.#entrance !== undefined) return true;
    try {
      this.#entrance = await this.#start(saved.port ?? 0);
    } catch {
      // The saved port is taken; a fresh one changes the front's target, which
      // the status shows the person.
      try {
        this.#entrance = await this.#start(0);
      } catch {
        return false;
      }
    }
    if (saved.port !== this.#entrance.port) {
      this.#save({ ...this.#savedOrOff(), port: this.#entrance.port });
    }
    return true;
  }

  #start(port: number): Promise<PublicEntrance> {
    return startPublicEntrance({
      port,
      role: () => this.#entranceRole(),
      handlers: () => this.#options.handlers?.() ?? {},
      ...(this.#options.forward === undefined ? {} : { forward: this.#options.forward }),
    });
  }

  /** Read on every request, so a pause or a lost role closes the door before the listener does. */
  #entranceRole(): PublicEntranceRole {
    if (this.#saved()?.enabled !== true || this.#options.remoteAccessPaused()) return "closed";
    const role = this.#options.role();
    return role === "hub" ? "serve" : role === "member" ? "forward" : "closed";
  }

  #saved(): PublicEntranceState | undefined {
    return this.#options.state.load().publicEntrance;
  }

  #savedOrOff(): PublicEntranceState {
    return this.#saved() ?? { enabled: false };
  }

  #save(next: {
    readonly enabled: boolean;
    readonly port?: number | undefined;
    readonly funnel?: PublicEntranceState["funnel"] | undefined;
  }): void {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      publicEntrance: {
        enabled: next.enabled,
        ...(next.port === undefined ? {} : { port: next.port }),
        ...(next.funnel === undefined ? {} : { funnel: next.funnel }),
      },
    });
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
