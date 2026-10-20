import { Schema } from "effect";
import { isCanvasShareSafeText } from "./canvasShare";

// Publishing one HTML document as a private page on the person's own account
// with a provider. A driver that declares `artifactPublish: "supported"`
// answers these shapes; the host hands them to an export destination through
// a port that names no vendor. Every string here is shown to the person on a
// card or in a receipt, so it is bounded and free of paths and secrets, and
// every expected failure is a value, never a thrown error.
const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The largest page a provider is asked to hold. */
export const PAGE_PUBLISH_HTML_MAX_BYTES = 16 * 1024 * 1024;
export const PAGE_PUBLISH_TITLE_MAX_CHARS = 256;
export const PAGE_PUBLISH_MESSAGE_MAX_CHARS = 1_024;
export const PAGE_PUBLISH_ACCOUNT_MAX_CHARS = 128;

const htmlEncoder = new TextEncoder();

const safeBounded = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maximum),
    Schema.filter((value) => isCanvasShareSafeText(value), {
      message: () => "Page text must not contain a secret or a file path.",
    }),
  );

/** Text a provider or the host shows the person about one publish. */
export const PagePublishMessage = safeBounded(PAGE_PUBLISH_MESSAGE_MAX_CHARS);
export type PagePublishMessage = typeof PagePublishMessage.Type;

/**
 * The name the page's file is written under at the provider: one path
 * segment, so a request can never name a folder.
 */
export const PagePublishFileName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(255),
  Schema.pattern(/^[^/\\]+$/),
  Schema.filter((value) => !value.includes("\0") && value !== "." && value !== "..", {
    message: () => "A page file name must name a file.",
  }),
);
export type PagePublishFileName = typeof PagePublishFileName.Type;

export const PagePublishRequest = Schema.Struct({
  fileName: PagePublishFileName,
  title: safeBounded(PAGE_PUBLISH_TITLE_MAX_CHARS),
  html: Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((value) => htmlEncoder.encode(value).length <= PAGE_PUBLISH_HTML_MAX_BYTES, {
      message: () => "A page must fit the UTF-8 byte budget.",
    }),
  ),
}).annotations(strict);
export type PagePublishRequest = typeof PagePublishRequest.Type;

/** Where a published page can be opened: a credential-free http(s) address. */
export const PagePublishAddress = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.username === "" &&
          parsed.password === "" &&
          isCanvasShareSafeText(value)
        );
      } catch {
        return false;
      }
    },
    { message: () => "A page address must be a credential-free http(s) URL." },
  ),
);
export type PagePublishAddress = typeof PagePublishAddress.Type;

/**
 * Whether one provider instance can publish a page right now. Read while an
 * offer or an approval card is built, so a driver answers it synchronously
 * from what it already knows and starts nothing to find out.
 */
export const PagePublishAvailability = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    /** The account the page goes out under, as the card names it. */
    account: safeBounded(PAGE_PUBLISH_ACCOUNT_MAX_CHARS),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("not-signed-in") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    /** An account is signed in but cannot publish pages, and this says why. */
    reason: PagePublishMessage,
  }).annotations(strict),
  /** The driver knows no such instance, or the instance publishes nothing. */
  Schema.Struct({ kind: Schema.Literal("absent") }).annotations(strict),
);
export type PagePublishAvailability = typeof PagePublishAvailability.Type;

export const PagePublishOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("published"),
    address: PagePublishAddress,
  }).annotations(strict),
  /** The provider, or the host's own gate, refused. Nothing was published. */
  Schema.Struct({
    kind: Schema.Literal("refused"),
    message: PagePublishMessage,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("not-signed-in") }).annotations(strict),
  /** The provider could not be asked to completion. Nothing is known to be published. */
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    message: PagePublishMessage,
  }).annotations(strict),
);
export type PagePublishOutcome = typeof PagePublishOutcome.Type;

export const decodePagePublishRequest = Schema.decodeUnknownSync(PagePublishRequest);
export const decodePagePublishAvailability = Schema.decodeUnknownSync(PagePublishAvailability);
export const decodePagePublishOutcome = Schema.decodeUnknownSync(PagePublishOutcome);
export const isPagePublishAvailability = Schema.is(PagePublishAvailability);
export const isPagePublishOutcome = Schema.is(PagePublishOutcome);
