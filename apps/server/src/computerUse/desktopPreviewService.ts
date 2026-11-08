import { randomUUID } from "node:crypto";
import type {
  DesktopPreviewAnswer,
  DesktopPreviewRequest,
  DesktopPreviewAudit,
} from "@octant/contracts";
import { decodeDesktopLeaseId } from "@octant/contracts";
import type {
  DesktopPreviewRelay,
  DesktopPreviewOpened,
} from "@octant/plugin-api/desktop-provider";
import { relayRequestHeaders, relayWebSocketRequestHeaders } from "@octant/domain";
import {
  DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
  relayToDevServer,
  openDevServerWebSocket,
} from "../remote/remoteServerProxyRelay";
import { WebSocketEndpoint, newWebSocketKey, sendableCloseCode } from "../webSocketRelay";
import type { RemoteServerGrantTarget } from "../localServers/localServerService";
import type { DesktopLeaseCaller, DesktopLeaseService } from "./desktopLeaseService";

type Target = Extract<RemoteServerGrantTarget, { readonly status: "listed" }>;
type Caller = DesktopLeaseCaller & { readonly leaseId: ReturnType<typeof decodeDesktopLeaseId> };
type Lease = NonNullable<ReturnType<DesktopLeaseService["previewTarget"]>>;
interface Review {
  readonly id: string;
  readonly caller: Caller;
  readonly lease: Lease;
  readonly target: Target;
  readonly revision: string;
  readonly deadline: number;
  readonly expiresAt: string;
}
interface Grant {
  readonly id: string;
  readonly review: Review;
  readonly controller: AbortController;
  readonly opened: Promise<DesktopPreviewOpened>;
  opening?: boolean;
  settled?: DesktopPreviewOpened;
  close?: Promise<boolean>;
  pin?: string;
}
const refused = (
  reason: "unavailable" | "stale" | "not-permitted" | "not-owned" | "busy" | "cleanup-unconfirmed",
): DesktopPreviewAnswer => ({ status: "preview-refused", reason });

/** Live-only authority. Journal replay never recreates a relay or guest listener. */
export function createDesktopPreviewService(options: {
  readonly lease: DesktopLeaseService["previewTarget"];
  readonly revision: (caller: Caller) => string | undefined;
  readonly observe: (caller: Caller, port: number) => Promise<RemoteServerGrantTarget>;
  readonly audit: (
    kind: "granted" | "closed",
    payload: typeof DesktopPreviewAudit.Type,
    caller: Caller,
  ) => void;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const reviews = new Map<string, Review>();
  const grants = new Map<string, Grant>();
  let stopped = false;
  const sameCaller = (left: Caller, right: Caller) =>
    left.scopeId === right.scopeId &&
    String(left.leaseId) === String(right.leaseId) &&
    left.owner.threadId === right.owner.threadId;
  const current = (review: Review) => {
    const lease = options.lease(review.caller);
    return (
      !stopped &&
      lease !== undefined &&
      lease.handle === review.lease.handle &&
      lease.provider === review.lease.provider &&
      lease.authority === review.lease.authority &&
      options.revision(review.caller) === review.revision &&
      Date.parse(review.expiresAt) > now()
    );
  };
  const payload = (grant: Grant) => ({
    grantId: grant.id,
    leaseId: String(grant.review.caller.leaseId),
    threadId: grant.review.caller.owner.threadId,
    providerId: String(grant.review.lease.provider.id),
    port: grant.review.target.endpoint.port,
    expiresAt: grant.review.expiresAt,
  });
  const close = (grant: Grant): Promise<boolean> => {
    grant.close ??= (async () => {
      grant.controller.abort();
      const answer = await grant.opened;
      // A deadline ends authority, not the plugin process. Keep this lease
      // reserved until a late opening has actually confirmed its cleanup.
      if (grant.opening && grant.settled === undefined) {
        delete grant.close;
        return false;
      }
      const opened = grant.settled ?? answer;
      try {
        if (opened.close !== undefined && (await opened.close()) !== "closed") {
          delete grant.close;
          return false;
        }
        options.audit("closed", payload(grant), grant.review.caller);
      } catch {
        delete grant.close;
        return false;
      }
      if (grants.get(grant.id) === grant) grants.delete(grant.id);
      return true;
    })();
    return grant.close;
  };
  const check = async (grant: Grant) => {
    if (grant.controller.signal.aborted || !current(grant.review)) return false;
    const target = await options
      .observe(grant.review.caller, grant.review.target.endpoint.port)
      .catch(() => undefined);
    const expected = grant.review.target;
    return (
      target?.status === "listed" &&
      target.ownership === "octant-owned" &&
      target.health === "listening" &&
      target.threadId === expected.threadId &&
      JSON.stringify(target.endpoint) === JSON.stringify(expected.endpoint) &&
      !grant.controller.signal.aborted &&
      current(grant.review)
    );
  };
  const relayFor = (grant: Grant): DesktopPreviewRelay => {
    const endpoint = grant.review.target.endpoint;
    const url = new URL(endpoint.url);
    const origin = `http://127.0.0.1:${endpoint.port}`;
    const certificate = (pin: string) => {
      if (!current(grant.review) || grant.controller.signal.aborted) return false;
      grant.pin ??= pin;
      return grant.pin === pin;
    };
    const headerInput = (headers: ReadonlyArray<readonly [string, string]>) => ({
      headers,
      listenerOrigin: origin,
      grantPath: "",
      upstream: {
        scheme: url.protocol === "https:" ? ("https" as const) : ("http" as const),
        port: endpoint.port,
      },
    });
    return {
      request: async (input) => {
        if (!(await check(grant))) {
          void close(grant);
          return new Response("Preview unavailable.", { status: 403 });
        }
        const answered = await relayToDevServer({
          endpointUrl: endpoint.url,
          request: {
            method: input.method,
            pathQuery: input.pathQuery,
            headers: relayRequestHeaders({
              ...headerInput(input.headers),
              bodyBytes: input.body?.byteLength,
            }),
            body: input.body,
          },
          acceptCertificate: certificate,
          signal: AbortSignal.any([input.signal, grant.controller.signal]),
          onSettled: () => undefined,
          limits: DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
        });
        return answered.kind === "responded"
          ? answered.response
          : new Response("Preview unavailable.", { status: 502 });
      },
      upgrade: async (input) => {
        if (!(await check(grant))) {
          void close(grant);
          return { status: "refused" };
        }
        const protocols = input.headers
          .filter(([name]) => name.toLowerCase() === "sec-websocket-protocol")
          .flatMap(([, value]) => value.split(",").map((part) => part.trim()));
        const key = newWebSocketKey();
        const answered = await openDevServerWebSocket({
          endpointUrl: endpoint.url,
          pathQuery: input.pathQuery,
          key,
          protocols,
          headers: relayWebSocketRequestHeaders({ ...headerInput(input.headers), key }),
          acceptCertificate: certificate,
          signal: AbortSignal.any([input.signal, grant.controller.signal]),
          limits: DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
        });
        if (answered.kind !== "opened") return { status: "refused" };
        const peer = new WebSocketEndpoint(answered.socket, "client", 1024 * 1024);
        let opened = false;
        const timer = setTimeout(() => answered.socket.destroy(), 5000);
        const end = () => {
          clearTimeout(timer);
          answered.socket.destroy();
        };
        grant.controller.signal.addEventListener("abort", end, { once: true });
        answered.socket.once("close", () => {
          clearTimeout(timer);
          grant.controller.signal.removeEventListener("abort", end);
        });
        return {
          status: "opened",
          ...(answered.protocol === undefined ? {} : { protocol: answered.protocol }),
          cancel: end,
          open: (guest) => {
            if (opened || grant.controller.signal.aborted || !current(grant.review)) {
              end();
              return { message: () => undefined, closed: () => undefined };
            }
            opened = true;
            clearTimeout(timer);
            peer.start(
              {
                message: (message) => (current(grant.review) ? guest.send(message) : end()),
                closed: (code, reason) => guest.close(sendableCloseCode(code), reason),
              },
              answered.head,
            );
            return {
              message: (message) => (current(grant.review) ? peer.send(message) : end()),
              closed: (code, reason) => peer.close(sendableCloseCode(code), reason),
            };
          },
        };
      },
    };
  };
  const view = (grant: Grant, guestUrl: string) => ({
    grantId: grant.id,
    port: grant.review.target.endpoint.port,
    expiresAt: grant.review.expiresAt,
    guestUrl,
  });
  const request = async (
    caller: Caller,
    input: DesktopPreviewRequest,
  ): Promise<DesktopPreviewAnswer> => {
    if (
      stopped ||
      caller.actor.kind !== "local-user" ||
      caller.scopeId === undefined ||
      caller.owner.mode !== "code" ||
      caller.owner.threadId !== input.threadId ||
      String(caller.leaseId) !== input.leaseId
    )
      return refused("not-permitted");
    const lease = options.lease(caller);
    if (lease === undefined || lease.provider.openPreview === undefined)
      return refused("unavailable");
    const existing = [...grants.values()].find(
      (grant) => String(grant.review.caller.leaseId) === String(caller.leaseId),
    );
    if (input.kind === "preview-read") {
      if (existing === undefined || !sameCaller(caller, existing.review.caller))
        return { status: "preview-state", available: true };
      if (!(await check(existing)))
        return (await close(existing))
          ? { status: "preview-state", available: true }
          : refused("cleanup-unconfirmed");
      const opened = await existing.opened;
      return {
        status: "preview-state",
        available: true,
        ...(opened.status !== "ready" ? {} : { grant: view(existing, opened.guestUrl) }),
      };
    }
    if (input.kind === "preview-revoke") {
      if (
        existing === undefined ||
        existing.id !== input.grantId ||
        !sameCaller(caller, existing.review.caller)
      )
        return refused("stale");
      return (await close(existing))
        ? { status: "preview-revoked" }
        : refused("cleanup-unconfirmed");
    }
    if (existing !== undefined) return refused("busy");
    if (input.kind === "preview-review") {
      const revision = options.revision(caller);
      const target = await options.observe(caller, input.port).catch(() => undefined);
      if (
        target?.status !== "listed" ||
        target.ownership !== "octant-owned" ||
        target.health !== "listening" ||
        String(target.threadId) !== caller.owner.threadId ||
        revision === undefined
      )
        return refused("not-owned");
      const review: Review = {
        id: randomUUID(),
        caller,
        lease,
        target,
        revision,
        deadline: now() + 120_000,
        expiresAt: lease.lease.expiresAt,
      };
      if (!current(review)) return refused("stale");
      for (const [id, old] of reviews)
        if (old.deadline <= now() || sameCaller(caller, old.caller)) reviews.delete(id);
      if (reviews.size >= 16) return refused("busy");
      reviews.set(review.id, review);
      return {
        status: "preview-review",
        reviewId: review.id,
        port: target.endpoint.port,
        processName: target.endpoint.processName,
        expiresAt: review.expiresAt,
      };
    }
    const review = reviews.get(input.reviewId);
    if (
      review === undefined ||
      !sameCaller(caller, review.caller) ||
      review.deadline <= now() ||
      !current(review)
    )
      return refused("stale");
    const target = await options
      .observe(caller, review.target.endpoint.port)
      .catch(() => undefined);
    if (
      reviews.get(input.reviewId) !== review ||
      review.deadline <= now() ||
      !current(review) ||
      target?.status !== "listed" ||
      JSON.stringify(target) !== JSON.stringify(review.target)
    )
      return refused("stale");
    if (
      [...grants.values()].some(
        (grant) => String(grant.review.caller.leaseId) === String(caller.leaseId),
      )
    )
      return refused("busy");
    reviews.delete(input.reviewId);
    const controller = new AbortController();
    let start: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      start = resolve;
    });
    const grant: Grant = {
      id: randomUUID(),
      review,
      controller,
      opened: gate.then(async () => {
        const open = review.lease.provider.openPreview;
        if (open === undefined || !current(review) || controller.signal.aborted)
          return { status: "unavailable" };
        grant.opening = true;
        const pending = Promise.resolve()
          .then(() =>
            open(review.lease.handle, {
              grantId: grant.id,
              port: review.target.endpoint.port,
              expiresAt: review.expiresAt,
              relay: relayFor(grant),
              signal: controller.signal,
            }),
          )
          .catch(() => ({ status: "unavailable" as const }));
        void pending.then((opened) => {
          grant.settled = opened;
          if (controller.signal.aborted) void close(grant);
        });
        let abort: (() => void) | undefined;
        const abandoned = new Promise<DesktopPreviewOpened>((resolve) => {
          abort = () => resolve({ status: "unavailable" });
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          return await Promise.race([pending, abandoned]);
        } finally {
          clearTimeout(timer);
          if (abort !== undefined) controller.signal.removeEventListener("abort", abort);
        }
      }),
    };
    try {
      options.audit("granted", payload(grant), caller);
    } catch {
      controller.abort();
      start?.();
      return refused("unavailable");
    }
    grants.set(grant.id, grant);
    start?.();
    const opened = await grant.opened;
    if (opened.status !== "ready" || controller.signal.aborted || !current(review))
      return refused((await close(grant)) ? "unavailable" : "cleanup-unconfirmed");
    return { status: "preview-ready", grant: view(grant, opened.guestUrl) };
  };
  return {
    request,
    serverStopped: (target: { readonly pid: number; readonly port: number }) =>
      Promise.allSettled(
        [...grants.values()]
          .filter(
            (grant) =>
              grant.review.target.endpoint.pid === target.pid &&
              grant.review.target.endpoint.port === target.port,
          )
          .map(close),
      ),
    sweep: async () => {
      for (const [id, review] of reviews)
        if (review.deadline <= now() || !current(review)) reviews.delete(id);
      await Promise.allSettled(
        [...grants.values()]
          .filter((grant) => grant.controller.signal.aborted || !current(grant.review))
          .map(close),
      );
    },
    close: async () => {
      stopped = true;
      reviews.clear();
      await Promise.allSettled([...grants.values()].map(close));
    },
  };
}
