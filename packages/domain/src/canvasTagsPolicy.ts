/**
 * Pure policy for the tags a person puts on a Canvas.
 *
 * Tags are the person's own filing facts: the library reads them to filter and
 * group, and nothing else. Admission and state live here so the service and
 * any future reader cannot disagree about what a tag command may do; authority
 * (who may tag, and only a window on this host) is decided on the server
 * before a command reaches this policy.
 */

import {
  CANVAS_MAX_TAGS_PER_CANVAS,
  CANVAS_TAG_MAX_CHARS,
  type CanvasTagAdded,
  type CanvasTagEvent,
  type CanvasTagRemoved,
  type CanvasTagName,
} from "@octant/contracts/canvas-tags";
import { decodeCanvasTagCommand } from "@octant/contracts/canvas-tags";

export type CanvasTagRejectionCode =
  | "malformed-request"
  | "stale-version"
  | "oversized-payload"
  | "duplicate-tag"
  | "unknown-tag"
  | "tag-budget-exceeded";

export interface CanvasTagRejected {
  readonly kind: "rejected";
  readonly code: CanvasTagRejectionCode;
  readonly message: string;
}

/** Every tag one Canvas carries, and the sequence its tag facts stand at. */
export interface CanvasTagState {
  readonly tags: ReadonlyArray<CanvasTagName>;
  readonly sequence: number;
}

export const EMPTY_CANVAS_TAG_STATE: CanvasTagState = { tags: [], sequence: 0 };

export type CanvasTagAdmitResult =
  | { readonly kind: "accepted"; readonly event: CanvasTagAdded }
  | { readonly kind: "accepted"; readonly event: CanvasTagRemoved }
  | CanvasTagRejected;

function reject(code: CanvasTagRejectionCode, message: string): CanvasTagRejected {
  return { kind: "rejected", code, message };
}

function holdsTag(state: CanvasTagState, tag: CanvasTagName): boolean {
  return state.tags.some((held) => held === tag);
}

/**
 * Admit one tag command against the state the Canvas's tags stand at.
 *
 * The result is a value, not an exception, so a caller must handle the refused
 * case before journaling anything. The schema already bounds a tag's length;
 * the budget check here is what keeps the set closed under removal.
 */
export function admitCanvasTagCommand(input: unknown, state: CanvasTagState): CanvasTagAdmitResult {
  const decoded = decodeCanvasTagCommand(input);
  if (decoded._tag === "Left") {
    return reject("malformed-request", "Canvas tag command is malformed.");
  }
  const command = decoded.right;
  if (command.tag.length > CANVAS_TAG_MAX_CHARS) {
    return reject("oversized-payload", "Canvas tag exceeds the allowed length.");
  }
  switch (command.kind) {
    case "canvas-tag-add": {
      if (holdsTag(state, command.tag)) {
        return reject("duplicate-tag", "Canvas already carries this tag.");
      }
      if (state.tags.length >= CANVAS_MAX_TAGS_PER_CANVAS) {
        return reject(
          "tag-budget-exceeded",
          `A Canvas carries at most ${CANVAS_MAX_TAGS_PER_CANVAS} tags.`,
        );
      }
      return {
        kind: "accepted",
        event: {
          canvasId: command.canvasId,
          tag: command.tag,
          addedAt: command.issuedAt,
          sequence: state.sequence + 1,
        },
      };
    }
    case "canvas-tag-remove": {
      if (!holdsTag(state, command.tag)) {
        return reject("unknown-tag", "Canvas does not carry this tag.");
      }
      return {
        kind: "accepted",
        event: {
          canvasId: command.canvasId,
          tag: command.tag,
          removedAt: command.issuedAt,
          sequence: state.sequence + 1,
        },
      };
    }
  }
}

/**
 * Fold one journaled tag fact into the state it follows. The timestamps are
 * stamped by the host when the event is journaled, never read from a command,
 * so replay needs nothing but the recorded facts.
 */
export function applyCanvasTagEvent(state: CanvasTagState, event: CanvasTagEvent): CanvasTagState {
  const next = { ...state, sequence: event.event.sequence };
  switch (event.kind) {
    case "added":
      // A duplicate replayed fact changes nothing but the sequence it brought.
      return holdsTag(next, event.event.tag)
        ? next
        : { ...next, tags: [...next.tags, event.event.tag] };
    case "removed":
      return { ...next, tags: next.tags.filter((tag) => tag !== event.event.tag) };
  }
}
