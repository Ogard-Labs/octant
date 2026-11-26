// Visitor links on the spoke that owns the thread (decisions H31 and H32). The
// spoke mints each link, signs its grant with this host's identity key, and
// hands the hub only that grant: never the thread, the secret, or the
// conversation. The hub asks here on every visitor request, so a link the
// person stopped, one that expired, and one whose thread was archived or moved
// stop at the next fetch on the hub and on any standby alike. A visitor's
// comment waits as a Request; only the person's Send delivers it, and then as
// outside content that taints the thread.

import { randomBytes } from "node:crypto";
import {
  HubMemberId,
  VISITOR_COMMENT_MAX_CHARACTERS,
  VISITOR_LINK_DEFAULT_LIFETIME_MS,
  VISITOR_LINK_MAX_PENDING_COMMENTS,
  VisitorLinkId,
  type HubMembershipChangedPayload,
  type HubVisitorGrantsUpdate,
  type HubVisitorShareRequest,
  type VisitorFetchAnswer,
  type VisitorFetchRequest,
  type VisitorLinkGrant,
  type VisitorProjection,
  type VisitorThreadMode,
} from "@octant/contracts";
import { redactForVisitor, visitorLinkSigningPayload } from "@octant/domain";
import { Schema } from "effect";
import { frameExternalContentForModel } from "../context/externalContentFraming";
import type {
  HubStatePort,
  SpokeVisitorComment,
  SpokeVisitorLink,
  SpokeVisitorState,
} from "./hubStateStore";
import { mintPublicId, mintVisitorLinkSecret, visitorLinkSecretHash } from "./publicEntranceCrypto";

const decodeLinkId = Schema.decodeUnknownSync(VisitorLinkId);
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const MAX_LINKS = 256;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARACTERS = 32_000;
const LOCAL_WINDOW = { kind: "local-window" } as const;

/** What the spoke reads of a thread for a visitor; each mode's adapter fills it in. */
export type VisitorThreadRead =
  | {
      readonly status: "found";
      readonly title: string;
      readonly archived: boolean;
      readonly state: VisitorProjection["state"];
      readonly messages: ReadonlyArray<{
        readonly role: "person" | "agent";
        readonly text: string;
      }>;
    }
  | { readonly status: "missing" };

export interface VisitorThreadSource {
  readonly read: (mode: VisitorThreadMode, threadId: string) => VisitorThreadRead;
}

export interface SpokeVisitorHubPort {
  readonly target: () => { readonly memberId: string } | undefined;
  readonly sendGrants: (update: HubVisitorGrantsUpdate) => Promise<boolean>;
}

export interface SpokeVisitorServiceOptions {
  readonly state: HubStatePort;
  /** Whether this spoke's person ticked Public in the hub grant. Read on every request. */
  readonly publicGranted: () => boolean;
  readonly hub: SpokeVisitorHubPort | undefined;
  /** This host's member id and identity key; the grant is signed with it. */
  readonly signing: () => {
    readonly memberId: string | undefined;
    readonly publicKey: string;
    readonly sign: (payload: string) => string;
  };
  readonly source: VisitorThreadSource;
  /** Journals that the thread now carries outside content; false when it could not. */
  readonly taint: (input: {
    readonly mode: VisitorThreadMode;
    readonly threadId: string;
    readonly contentReference: string;
  }) => boolean;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
}

export type SpokeVisitorShared =
  | {
      readonly status: "shared";
      readonly linkId: string;
      /** The path with the secret in its fragment; shown to the person once. */
      readonly url: string;
      readonly expiresAt: number;
      readonly published: boolean;
    }
  | { readonly status: "refused"; readonly kind: "public-not-granted" | "not-a-member" | "full" };

export type SpokeVisitorCommentDecision =
  | {
      readonly status: "sent";
      readonly mode: VisitorThreadMode;
      readonly threadId: string;
      /** The comment framed as outside content, for the person's next message in the thread. */
      readonly text: string;
    }
  | { readonly status: "dismissed" }
  | { readonly status: "refused"; readonly kind: "unknown-comment" | "taint-refused" };

export interface SpokeVisitorView {
  readonly links: ReadonlyArray<{
    readonly linkId: string;
    readonly mode: VisitorThreadMode;
    readonly threadId: string;
    readonly scope: VisitorLinkGrant["scope"];
    readonly expiresAt: number;
    readonly opened: boolean;
  }>;
  readonly comments: ReadonlyArray<SpokeVisitorComment>;
  readonly published: boolean;
}

function empty(): SpokeVisitorState {
  return { links: [], comments: [] };
}

export class SpokeVisitorService {
  readonly #options: SpokeVisitorServiceOptions;
  #publishedGranted: boolean | undefined;

  constructor(options: SpokeVisitorServiceOptions) {
    this.#options = options;
  }

  view(): SpokeVisitorView {
    const held = this.#load();
    const now = this.#options.now();
    return {
      links: held.links
        .filter((link) => link.stoppedAt === undefined && link.signed.grant.expiresAt > now)
        .map((link) => ({
          linkId: String(link.signed.grant.linkId),
          mode: link.mode,
          threadId: link.threadId,
          scope: link.signed.grant.scope,
          expiresAt: link.signed.grant.expiresAt,
          opened: link.binding !== undefined,
        })),
      comments: held.comments,
      published: held.unpublished !== true,
    };
  }

  /** Mints a link for one thread; the secret is in the returned path's fragment and nowhere else. */
  async share(input: HubVisitorShareRequest): Promise<SpokeVisitorShared> {
    if (!this.#options.publicGranted()) return { status: "refused", kind: "public-not-granted" };
    const signing = this.#options.signing();
    if (signing.memberId === undefined) return { status: "refused", kind: "not-a-member" };
    const now = this.#options.now();
    const held = this.#prune(this.#load(), now);
    if (held.links.length >= MAX_LINKS) return { status: "refused", kind: "full" };
    const linkId = mintPublicId();
    const secret = mintVisitorLinkSecret();
    const grant: VisitorLinkGrant = {
      v: 1,
      kind: "visitor-link",
      linkId: decodeLinkId(linkId),
      spokeMemberId: decodeMemberId(signing.memberId),
      scope: input.scope,
      issuedAt: now,
      expiresAt: now + (input.lifetimeMs ?? VISITOR_LINK_DEFAULT_LIFETIME_MS),
      revision: 1,
      secretHash: visitorLinkSecretHash(linkId, secret),
    };
    const link: SpokeVisitorLink = {
      signed: {
        grant,
        signerPublicKey: signing.publicKey,
        signature: signing.sign(visitorLinkSigningPayload(grant)),
      },
      mode: input.mode,
      threadId: input.threadId,
    };
    this.#save({ ...held, links: [...held.links, link], unpublished: true });
    this.#options.record({ change: "visitor-link-shared", actingPrincipal: LOCAL_WINDOW });
    const published = await this.publish();
    return {
      status: "shared",
      linkId,
      url: `/v/${linkId}#k=${secret}`,
      expiresAt: grant.expiresAt,
      published,
    };
  }

  /** Stops a link at once: the next fetch on any hub is refused, whether or not the hub heard. */
  async stop(
    linkId: string,
  ): Promise<
    { readonly status: "stopped" } | { readonly status: "refused"; readonly kind: "unknown-link" }
  > {
    const held = this.#load();
    const link = held.links.find((entry) => String(entry.signed.grant.linkId) === linkId);
    if (link === undefined || link.stoppedAt !== undefined) {
      return { status: "refused", kind: "unknown-link" };
    }
    this.#save({
      ...held,
      links: held.links.map((entry) =>
        entry === link ? { ...entry, stoppedAt: this.#options.now() } : entry,
      ),
      comments: held.comments.filter((comment) => comment.linkId !== linkId),
      unpublished: true,
    });
    this.#options.record({ change: "visitor-link-stopped", actingPrincipal: LOCAL_WINDOW });
    await this.publish();
    return { status: "stopped" };
  }

  /** What the hub, or a standing-in standby, asks on every visitor request. */
  fetch(request: VisitorFetchRequest, askedBy: string): VisitorFetchAnswer {
    if (!this.#options.publicGranted()) return { status: "refused", kind: "public-not-granted" };
    const now = this.#options.now();
    const held = this.#load();
    const linkId = String(request.linkId);
    const link = held.links.find((entry) => String(entry.signed.grant.linkId) === linkId);
    if (link === undefined) return { status: "refused", kind: "unknown-link" };
    const grant = link.signed.grant;
    // An older revision is a grant the spoke replaced; it opens nothing.
    if (link.stoppedAt !== undefined || request.revision !== grant.revision) {
      return { status: "refused", kind: "revoked" };
    }
    if (now >= grant.expiresAt) return { status: "refused", kind: "expired" };
    const thread = this.#options.source.read(link.mode, link.threadId);
    if (thread.status === "missing" || thread.archived) return { status: "refused", kind: "ended" };
    if (link.binding === undefined) {
      if (request.kind !== "open") return { status: "refused", kind: "not-bound" };
      this.#save({
        ...held,
        links: held.links.map((entry) =>
          entry === link ? { ...entry, binding: request.binding } : entry,
        ),
      });
      this.#options.record({
        change: "visitor-link-bound",
        actingPrincipal: { kind: "hub", memberId: decodeMemberId(askedBy) },
      });
    } else if (link.binding !== request.binding) {
      return { status: "refused", kind: "bound-elsewhere" };
    }
    if (request.kind === "comment") {
      const refusal = this.#takeComment(linkId, grant.scope, request.comment ?? "", now, askedBy);
      if (refusal !== undefined) return { status: "refused", kind: refusal };
    }
    return {
      status: "ok",
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      projection: projectionOf(thread),
    };
  }

  /** The person's Send or Dismiss. Send taints the thread first; a thread it cannot taint gets nothing. */
  decideComment(commentId: string, action: "send" | "dismiss"): SpokeVisitorCommentDecision {
    const held = this.#load();
    const comment = held.comments.find((entry) => entry.commentId === commentId);
    if (comment === undefined) return { status: "refused", kind: "unknown-comment" };
    const link = held.links.find((entry) => String(entry.signed.grant.linkId) === comment.linkId);
    const remaining = held.comments.filter((entry) => entry.commentId !== commentId);
    if (action === "dismiss" || link === undefined) {
      this.#save({ ...held, comments: remaining });
      this.#options.record({ change: "visitor-comment-dismissed", actingPrincipal: LOCAL_WINDOW });
      return { status: "dismissed" };
    }
    const tainted = this.#options.taint({
      mode: link.mode,
      threadId: link.threadId,
      contentReference: `visitor-comment-${comment.linkId}-${commentId}`,
    });
    if (!tainted) return { status: "refused", kind: "taint-refused" };
    this.#save({ ...held, comments: remaining });
    this.#options.record({ change: "visitor-comment-sent", actingPrincipal: LOCAL_WINDOW });
    return {
      status: "sent",
      mode: link.mode,
      threadId: link.threadId,
      text: frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "visitor-comment",
        body: comment.text,
        section: "conversation",
      }).text,
    };
  }

  /** Hands the hub every live grant; without Public, an empty list withdraws them all. */
  async publish(): Promise<boolean> {
    const hub = this.#options.hub;
    if (hub === undefined || hub.target() === undefined) return false;
    const granted = this.#options.publicGranted();
    const now = this.#options.now();
    const held = this.#prune(this.#load(), now);
    const grants = granted
      ? held.links
          .filter((link) => link.stoppedAt === undefined && link.signed.grant.expiresAt > now)
          .map((link) => link.signed)
      : [];
    const sent = await hub.sendGrants({ grants });
    if (sent) {
      this.#publishedGranted = granted;
      const { unpublished: _unpublished, ...rest } = this.#prune(this.#load(), now);
      this.#save(rest);
    }
    return sent;
  }

  /** Sends the list again when the hub has not taken it, or when the Public item changed since. */
  async look(): Promise<void> {
    const granted = this.#options.publicGranted();
    if (this.#load().unpublished !== true && granted === this.#publishedGranted) return;
    await this.publish();
  }

  #takeComment(
    linkId: string,
    scope: VisitorLinkGrant["scope"],
    text: string,
    now: number,
    askedBy: string,
  ): "comment-not-allowed" | "comments-full" | undefined {
    if (scope !== "comment" || text.trim() === "") return "comment-not-allowed";
    const held = this.#load();
    const waiting = held.comments.filter((comment) => comment.linkId === linkId).length;
    if (waiting >= VISITOR_LINK_MAX_PENDING_COMMENTS) return "comments-full";
    this.#save({
      ...held,
      comments: [
        ...held.comments,
        {
          commentId: randomBytes(16).toString("base64url"),
          linkId,
          text: text.slice(0, VISITOR_COMMENT_MAX_CHARACTERS),
          at: now,
        },
      ],
    });
    this.#options.record({
      change: "visitor-comment-received",
      actingPrincipal: { kind: "hub", memberId: decodeMemberId(askedBy) },
    });
    return undefined;
  }

  /** Links past their expiry are dropped with their comments; a stopped one keeps answering "revoked" until then. */
  #prune(held: SpokeVisitorState, now: number): SpokeVisitorState {
    const links = held.links.filter((link) => link.signed.grant.expiresAt > now);
    const live = new Set(links.map((link) => String(link.signed.grant.linkId)));
    return { ...held, links, comments: held.comments.filter((c) => live.has(c.linkId)) };
  }

  #load(): SpokeVisitorState {
    return this.#options.state.load().visitors ?? empty();
  }

  #save(visitors: SpokeVisitorState): void {
    this.#options.state.save({ ...this.#options.state.load(), visitors });
  }
}

/** The visitor's view of a thread: titles and messages only, redacted, newest last. */
function projectionOf(thread: Extract<VisitorThreadRead, { status: "found" }>): VisitorProjection {
  return {
    title: redactForVisitor(thread.title).slice(0, 256),
    state: thread.state,
    messages: thread.messages.slice(-MAX_MESSAGES).map((message) => ({
      role: message.role,
      text: redactForVisitor(message.text).slice(0, MAX_MESSAGE_CHARACTERS),
    })),
  };
}
