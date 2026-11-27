// This host's public entrance: the person's switch, the loopback listener it
// opens, the Funnel front, and the rules that close both. The entrance opens
// only while the switch is on, remote access is not paused, and the host is a
// hub or a member of one. Pausing remote access closes it and turns Funnel off;
// resuming reopens the listener but never turns Funnel back on, so Octant
// changes Tailscale only for a person's own switch or pause. While Funnel and
// the hub's device relay are both on it also reads the tailnet name from
// `tailscale status`, to tell devices where the relay is. With front
// addresses listed, for the person's own proxy on another machine, it binds
// the hub's Tailscale address with its Tailscale certificate instead of
// loopback, serves only those addresses, and never binds anything else.

import {
  publicFrontOrigin,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type PublicForwardAnswer,
  type PublicForwardEnvelope,
  type PublicFunnelPort,
} from "@octant/contracts";
import { decidePublicEntranceBind, publicFrontAdmitted, readPublicFronts } from "@octant/domain";
import type { HubStatePort, PublicEntranceState } from "./hubStateStore";
import {
  startPublicEntrance,
  type PublicEntrance,
  type PublicEntranceHandlers,
  type PublicEntranceRole,
} from "./publicEntrance";
import { readTailscaleName, type TailscaleExec } from "./tailscaleCliDaemon";
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
  /** Only tests replace the clock that spaces out a refused Funnel off. */
  readonly now?: () => number;
  /**
   * This host's own Tailscale address and the Tailscale certificate it holds,
   * for a front on another machine. Absent, listed fronts never bind.
   */
  readonly tailnet?: () => Promise<{
    readonly address: string | undefined;
    readonly tls: TailnetTls | undefined;
  }>;
}

type TailnetTls = {
  readonly cert: string;
  readonly key: string;
  /** The tailnet name the certificate covers; a front checks it, not the address. */
  readonly name: string;
};
type TailnetBind = NonNullable<Parameters<typeof startPublicEntrance>[0]["tailnet"]>;

export type PublicFrontsOutcome =
  | { readonly status: "changed"; readonly fronts: ReadonlyArray<string> }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-tailscale-address"
        | "too-many"
        | "funnel-on"
        | "no-tailnet-address"
        | "no-tailnet-certificate"
        | "no-front-in-address-family"
        | "listener-failed";
    };

export type PublicEntranceSwitchOutcome =
  | { readonly status: "changed"; readonly enabled: boolean }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-in-a-hub"
        | "remote-access-paused"
        | "listener-failed"
        | "funnel-off-failed";
    };

export type PublicFunnelOutcome =
  | { readonly status: "changed"; readonly enabled: boolean; readonly port?: PublicFunnelPort }
  | {
      readonly status: "refused";
      readonly kind:
        | "entrance-off"
        | "fronts-listed"
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
  /**
   * Where the person points their own front: the loopback address on this
   * machine, or the hub's Tailscale address while fronts are listed.
   */
  readonly address?: string;
  /** The listed front addresses; empty for a front on this machine. */
  readonly fronts: ReadonlyArray<string>;
  readonly funnel: { readonly enabled: boolean; readonly port?: PublicFunnelPort };
  /** This host's own choice, as a standby, to serve the entrance while it stands in. */
  readonly serveWhileStandingIn: boolean;
  /** The public address the person typed for their own front, when they did. */
  readonly ownFrontOrigin?: string;
}

export type PublicAddressOutcome =
  | { readonly status: "changed"; readonly ownFrontOrigin?: string }
  | { readonly status: "refused"; readonly kind: "invalid-address" };

const DEFAULT_FUNNEL_PORT: PublicFunnelPort = 443;

const FUNNEL_OFF_RETRY_MS = 60_000;
/** The entrance looks every few seconds; a machine is renamed far less often. */
const FUNNEL_NAME_REFRESH_MS = 60_000;

export class PublicEntranceService {
  readonly #options: PublicEntranceServiceOptions;
  readonly #funnel: TailscaleFunnel;
  #entrance: PublicEntrance | undefined;
  /** One change at a time, so a pause and a switch cannot open and close the listener out of order. */
  #queue: Promise<unknown> = Promise.resolve();
  #funnelOffRetryAt = 0;
  /** The tailnet name last read from the daemon, and when it was last asked. */
  #funnelName: string | undefined;
  #funnelNameAskedAt: number | undefined;
  /**
   * Set when a pause or a lost role could not turn Funnel off. Resuming must not
   * reopen the port Funnel still points at, since that would put the entrance
   * back on the internet without the person turning Funnel on again.
   */
  #funnelOffOwed = false;
  /** Set once the host stops; no later look reopens the listener. */
  #closed = false;
  /** Where the open listener is bound and whom it admits, so a changed list rebinds it. */
  #bound: { readonly key: string; readonly origin: string } | undefined;
  /** Why the last look could not bind for listed fronts. */
  #bindRefusal:
    | "no-tailnet-address"
    | "no-tailnet-certificate"
    | "no-front-in-address-family"
    | undefined;

  constructor(options: PublicEntranceServiceOptions) {
    this.#options = options;
    this.#funnel = createTailscaleFunnel({ exec: options.exec, platform: options.platform });
  }

  status(): PublicEntranceStatus {
    const saved = this.#saved();
    const port = this.#entrance?.port ?? saved?.port;
    const fronts = saved?.fronts ?? [];
    const origin = this.#bound?.origin ?? (fronts.length === 0 ? "http://127.0.0.1" : undefined);
    return {
      enabled: saved?.enabled === true,
      listening: this.#entrance !== undefined,
      role: this.#options.role(),
      paused: this.#options.remoteAccessPaused(),
      ...(port === undefined ? {} : { port }),
      ...(port === undefined || origin === undefined ? {} : { address: `${origin}:${port}` }),
      fronts,
      funnel:
        saved?.funnel === undefined
          ? { enabled: false }
          : { enabled: true, port: saved.funnel.port },
      serveWhileStandingIn: saved?.serveWhileStandingIn === true,
      ...(saved?.ownFrontOrigin === undefined ? {} : { ownFrontOrigin: saved.ownFrontOrigin }),
    };
  }

  /**
   * Records the public address the person's own front answers on, so the hub
   * can tell paired devices where its relay is. Octant cannot see a front it
   * does not run, so the person types it; only an `https:` origin with a DNS
   * name is taken. It opens nothing: the entrance and its route table are
   * unchanged.
   */
  setOwnFrontAddress(
    url: string | undefined,
    principal: AuditActingPrincipal,
  ): Promise<PublicAddressOutcome> {
    return this.#serially(async (): Promise<PublicAddressOutcome> => {
      const origin = url === undefined ? undefined : publicFrontOrigin(url);
      if (url !== undefined && origin === undefined) {
        return { status: "refused", kind: "invalid-address" };
      }
      const state = this.#options.state.load();
      const current = state.publicEntrance ?? { enabled: false };
      const { ownFrontOrigin: _previous, ...rest } = current;
      this.#options.state.save({
        ...state,
        publicEntrance: origin === undefined ? rest : { ...rest, ownFrontOrigin: origin },
      });
      this.#options.record({ change: "public-address-changed", actingPrincipal: principal });
      return origin === undefined
        ? { status: "changed" }
        : { status: "changed", ownFrontOrigin: origin };
    });
  }

  setEnabled(
    enabled: boolean,
    principal: AuditActingPrincipal,
  ): Promise<PublicEntranceSwitchOutcome> {
    return this.#serially(async () => {
      if (enabled && this.#options.role() === "none") {
        return { status: "refused", kind: "not-in-a-hub" } as const;
      }
      // Saving the switch on while paused would let the next resume open an
      // entrance whose enable was refused.
      if (enabled && this.#options.remoteAccessPaused()) {
        return { status: "refused", kind: "remote-access-paused" } as const;
      }
      const saved = this.#saved();
      if (!enabled && saved?.funnel !== undefined) {
        // Turning the entrance off turns its front off first; a front left
        // pointing at a closed port would only answer 502.
        // A front left on while Settings shows the entrance off would be
        // invisible to the person, so the entrance stays on until it goes.
        const off = await this.#funnel.off(saved.funnel.port);
        if (off.status !== "done") return { status: "refused", kind: "funnel-off-failed" } as const;
        this.#save({ ...saved, funnel: undefined });
      }
      const current = this.#saved();
      this.#save({
        enabled,
        ...(current?.port === undefined ? {} : { port: current.port }),
        ...(current?.funnel === undefined ? {} : { funnel: current.funnel }),
        ...(current?.fronts === undefined ? {} : { fronts: current.fronts }),
      });
      this.#options.record({
        change: "public-entrance-switch-changed",
        actingPrincipal: principal,
      });
      const opened = await this.#reconcile();
      if (enabled && !opened) {
        // A refused enable leaves the switch as it was, so no later look opens it.
        this.#save({ ...this.#savedOrOff(), enabled: current?.enabled === true });
        await this.#reconcile();
        return { status: "refused", kind: "listener-failed" } as const;
      }
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
      // Funnel carries the internet to loopback, where nothing listens while
      // the entrance is bound for a front on another machine.
      if ((saved?.fronts ?? []).length > 0) return { status: "refused", kind: "fronts-listed" };
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

  /**
   * Lists the Tailscale addresses of the person's own proxy on another
   * machine; an empty list goes back to loopback. A list the host cannot bind
   * for while the entrance is on is refused, and the entrance keeps the bind
   * it had.
   */
  setFronts(
    addresses: ReadonlyArray<string>,
    principal: AuditActingPrincipal,
  ): Promise<PublicFrontsOutcome> {
    return this.#serially(async (): Promise<PublicFrontsOutcome> => {
      const read = readPublicFronts(addresses);
      if (read.status === "refused") return { status: "refused", kind: read.kind };
      const previous = this.#savedOrOff();
      if (read.fronts.length > 0 && previous.funnel !== undefined) {
        return { status: "refused", kind: "funnel-on" };
      }
      this.#save({ ...previous, fronts: read.fronts });
      const opened = await this.#reconcile();
      if (!opened && this.#entranceShouldOpen()) {
        const kind = this.#bindRefusal ?? "listener-failed";
        this.#save({ ...this.#savedOrOff(), fronts: previous.fronts });
        await this.#reconcile();
        return { status: "refused", kind };
      }
      this.#options.record({ change: "public-fronts-changed", actingPrincipal: principal });
      return { status: "changed", fronts: read.fronts };
    });
  }

  /** Opens or closes the listener to match the switch, the pause, and the role. */
  reconcile(): Promise<boolean> {
    return this.#serially(() => this.#reconcile());
  }

  /** The tailnet name Funnel serves, as last read; undefined while Funnel is off. */
  funnelName(): string | undefined {
    return this.#saved()?.funnel === undefined ? undefined : this.#funnelName;
  }

  /**
   * Reads the tailnet name from the daemon, at most once a minute, and only on
   * the hub while Funnel and the device relay are on and no address was typed:
   * the one case the name is used. A standby standing in is never asked. A
   * daemon that cannot answer leaves the last name. It runs outside the queue,
   * so a slow tool never delays a pause or a switch.
   */
  async refreshFunnelName(): Promise<void> {
    if (this.#closed) return;
    const state = this.#options.state.load();
    if (
      state.publicEntrance?.funnel === undefined ||
      state.publicEntrance.ownFrontOrigin !== undefined ||
      state.hub?.enabled !== true ||
      state.relayHub?.enabled !== true
    ) {
      return;
    }
    const now = this.#now();
    if (
      this.#funnelNameAskedAt !== undefined &&
      now - this.#funnelNameAskedAt < FUNNEL_NAME_REFRESH_MS
    ) {
      return;
    }
    this.#funnelNameAskedAt = now;
    const name = await readTailscaleName({
      exec: this.#options.exec,
      platform: this.#options.platform,
    });
    if (name !== undefined) this.#funnelName = name;
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
    this.#closed = true;
    return this.#serially(async () => {
      const entrance = this.#entrance;
      this.#entrance = undefined;
      await entrance?.close();
    });
  }

  async #reconcile(): Promise<boolean> {
    // A stopped host runs no Tailscale command and opens nothing on a later look.
    if (this.#closed) return false;
    const saved = this.#saved();
    const paused = this.#options.remoteAccessPaused();
    const role = this.#options.role();
    const open = !this.#closed && saved?.enabled === true && !paused && role !== "none";
    if (saved?.funnel === undefined) this.#funnelOffOwed = false;
    if (!open && saved?.funnel !== undefined && (paused || role === "none")) {
      this.#funnelOffOwed = true;
    }
    if (
      saved?.funnel !== undefined &&
      this.#funnelOffOwed &&
      this.#now() >= this.#funnelOffRetryAt
    ) {
      // The pause or the end of the hub role is the journaled act; the front
      // goes with it, and only the person turns it back on. A refused off is
      // retried once a minute, not on every five-second look, and Settings
      // keeps showing Funnel as on until it goes.
      const off = await this.#funnel.off(saved.funnel.port);
      if (off.status === "done") {
        this.#save({ ...saved, funnel: undefined });
        this.#funnelOffRetryAt = 0;
        this.#funnelOffOwed = false;
      } else {
        this.#funnelOffRetryAt = this.#now() + FUNNEL_OFF_RETRY_MS;
      }
    }
    const bind = open && !this.#funnelOffOwed ? await this.#bindFor(saved) : undefined;
    if (bind === undefined || this.#bound?.key !== bind.key) {
      const entrance = this.#entrance;
      this.#entrance = undefined;
      this.#bound = undefined;
      await entrance?.close();
    }
    if (bind === undefined || !open) return false;
    if (this.#entrance !== undefined) return true;
    try {
      this.#entrance = await this.#start(saved.port ?? 0, bind.tailnet);
    } catch {
      // The saved port is taken. Funnel still sends the internet to it, and so
      // to whatever program holds it now, outside the closed route table; the
      // front goes before a fresh port opens, and only the person turns it on
      // again, at the new port.
      // Read again: an owed off above may already have turned Funnel off.
      const front = this.#saved()?.funnel;
      if (front !== undefined) {
        const off = await this.#funnel.off(front.port);
        if (off.status !== "done") {
          this.#funnelOffOwed = true;
          this.#funnelOffRetryAt = this.#now() + FUNNEL_OFF_RETRY_MS;
          return false;
        }
        this.#save({ ...this.#savedOrOff(), funnel: undefined });
      }
      try {
        this.#entrance = await this.#start(0, bind.tailnet);
      } catch {
        return false;
      }
    }
    this.#bound = { key: bind.key, origin: bind.origin };
    if (saved.port !== this.#entrance.port) {
      this.#save({ ...this.#savedOrOff(), port: this.#entrance.port });
    }
    return true;
  }

  /**
   * Where the listener goes: loopback with no front listed, or the hub's own
   * Tailscale address with its certificate. Undefined when listed fronts
   * cannot be bound for; there is no fallback to another address.
   */
  async #bindFor(
    saved: PublicEntranceState,
  ): Promise<
    { readonly key: string; readonly origin: string; readonly tailnet?: TailnetBind } | undefined
  > {
    const fronts = saved.fronts ?? [];
    this.#bindRefusal = undefined;
    if (fronts.length === 0) return { key: "loopback", origin: "http://127.0.0.1" };
    const tailnet = await this.#options.tailnet?.();
    const tls = tailnet?.tls;
    const decision = decidePublicEntranceBind({
      fronts,
      tailnetAddress: tailnet?.address,
      certificate: tls !== undefined,
    });
    if (decision.kind === "refused") {
      this.#bindRefusal = decision.reason;
      return undefined;
    }
    if (decision.kind !== "tailnet" || tls === undefined) {
      // Unreachable with fronts listed: the decision only says loopback
      // without them, and refuses without a certificate.
      this.#bindRefusal = "no-tailnet-certificate";
      return undefined;
    }
    return {
      // A renewed certificate rebinds too: a TLS server keeps the one it started with.
      key: `tailnet|${decision.address}|${fronts.join(",")}|${tls.cert}`,
      // The listener binds the address, but a front verifies the certificate,
      // which names this computer's tailnet name, so that is what it is told.
      origin: `https://${tls.name}`,
      tailnet: {
        address: decision.address,
        tls,
        admits: (remoteAddress) => publicFrontAdmitted(remoteAddress, fronts),
      },
    };
  }

  #start(port: number, tailnet: TailnetBind | undefined): Promise<PublicEntrance> {
    return startPublicEntrance({
      port,
      role: () => this.#entranceRole(),
      handlers: () => this.#options.handlers?.() ?? {},
      ...(this.#options.forward === undefined ? {} : { forward: this.#options.forward }),
      ...(tailnet === undefined ? {} : { tailnet }),
    });
  }

  /** Whether the switch, the pause and the role want the entrance open now. */
  #entranceShouldOpen(): boolean {
    return (
      !this.#closed &&
      this.#saved()?.enabled === true &&
      !this.#options.remoteAccessPaused() &&
      this.#options.role() !== "none"
    );
  }

  /** Read on every request, so a pause or a lost role closes the door before the listener does. */
  #entranceRole(): PublicEntranceRole {
    if (this.#saved()?.enabled !== true || this.#options.remoteAccessPaused()) return "closed";
    const role = this.#options.role();
    return role === "hub" ? "serve" : role === "member" ? "forward" : "closed";
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
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
    readonly fronts?: PublicEntranceState["fronts"] | undefined;
  }): void {
    const state = this.#options.state.load();
    const serve = state.publicEntrance?.serveWhileStandingIn;
    const ownFrontOrigin = state.publicEntrance?.ownFrontOrigin;
    this.#options.state.save({
      ...state,
      publicEntrance: {
        enabled: next.enabled,
        ...(next.port === undefined ? {} : { port: next.port }),
        ...(next.funnel === undefined ? {} : { funnel: next.funnel }),
        ...(serve === undefined ? {} : { serveWhileStandingIn: serve }),
        ...(next.fronts === undefined || next.fronts.length === 0 ? {} : { fronts: next.fronts }),
        ...(ownFrontOrigin === undefined ? {} : { ownFrontOrigin }),
      },
    });
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
