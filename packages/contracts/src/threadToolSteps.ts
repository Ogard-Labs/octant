import { Schema } from "effect";
import { ToolOutsideContentMark } from "./shieldWatcherMark";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** How many tool calls one Chat or Work turn keeps, as many as a Code turn does. */
export const MAX_THREAD_TOOL_STEPS_PER_TURN = 64;
/** The most a step's progress or result message keeps. */
export const MAX_THREAD_TOOL_STEP_SUMMARY_BYTES = 2_048;

export const ThreadToolStepState = Schema.Literal("started", "running", "completed", "failed");
export type ThreadToolStepState = typeof ThreadToolStepState.Type;

/**
 * The most of a published file the host keeps as its snapshot: the size an
 * HTML page brought into a Canvas may have (`CANVAS_HTML_IMPORT_MAX_BYTES`),
 * since the snapshot is drawn through that same import. A larger file keeps
 * only its link.
 */
export const MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES = 262_144;

/**
 * The Project file a publish sent, as the host read it when the person
 * approved the publish: what the page held then. Later edits on the service
 * never reach it, and nothing here is fetched from the service.
 */
export const ThreadPublishedSnapshot = Schema.Struct({
  format: Schema.Literal("html", "markdown"),
  content: Schema.String.pipe(
    Schema.filter(
      (value) =>
        value.length > 0 && encoder.encode(value).byteLength <= MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES,
    ),
  ),
}).annotations(strict);
export type ThreadPublishedSnapshot = typeof ThreadPublishedSnapshot.Type;

/**
 * A page a tool published outside this host, such as a Claude artifact on the
 * person's claude.ai account: its `https` address, the title the service gave
 * it, and the host's snapshot of the file it sent. The live page is never
 * fetched or framed; a transcript links to it, opening in the person's
 * browser, and draws the snapshot.
 */
export const ThreadPublishedPage = Schema.Struct({
  url: boundedNonEmptyText(2_048).pipe(
    Schema.filter((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    }),
  ),
  title: Schema.optional(boundedNonEmptyText(256)),
  snapshot: Schema.optional(ThreadPublishedSnapshot),
}).annotations(strict);
export type ThreadPublishedPage = typeof ThreadPublishedPage.Type;

/**
 * One tool call a Chat or Work turn made: its id, its name, how it stands, and
 * the provider's latest progress or result message. The same fields a Code
 * turn's tool step carries, and nothing more: no tool input and no tool output
 * is captured beyond a page the call published.
 */
export const ThreadToolStep = Schema.Struct({
  toolCallId: boundedNonEmptyText(255),
  toolName: boundedNonEmptyText(255),
  state: ThreadToolStepState,
  summary: Schema.optional(boundedNonEmptyText(MAX_THREAD_TOOL_STEP_SUMMARY_BYTES)),
  published: Schema.optional(ThreadPublishedPage),
  /** The call's result brought outside content into the thread, and what the Watcher found in it. */
  outsideContent: Schema.optional(ToolOutsideContentMark),
}).annotations(strict);
export type ThreadToolStep = typeof ThreadToolStep.Type;

/** In arrival order. The first steps are kept when a turn calls more tools than fit. */
export const ThreadToolStepList = Schema.Array(ThreadToolStep).pipe(
  Schema.filter((steps) => steps.length <= MAX_THREAD_TOOL_STEPS_PER_TURN),
);
export type ThreadToolStepList = typeof ThreadToolStepList.Type;

export const decodeThreadToolStep = Schema.decodeUnknownSync(ThreadToolStep);
export const decodeThreadToolStepList = Schema.decodeUnknownSync(ThreadToolStepList);

/**
 * How a Work or Code thread delivers a document it makes: as a Canvas, or
 * with the runtime's own artifact tool, which publishes it to the person's
 * account with the model's provider (Claude artifacts). Absent on a thread
 * means the person has not chosen: it delivers Canvases, and Octant may offer
 * the choice once. Only a thread whose provider account enabled the tool can
 * use `native-artifacts`; anywhere else it delivers Canvases too.
 */
export const ThreadDocumentDelivery = Schema.Literal("canvas", "native-artifacts");
export type ThreadDocumentDelivery = typeof ThreadDocumentDelivery.Type;
