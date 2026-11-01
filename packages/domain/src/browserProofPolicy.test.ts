import { decodeBrowserCapture, decodeBrowserStep, type BrowserStep } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  bodyWithBrowserProof,
  browserStepChange,
  browserProofPullRequestSection,
  browserProofScreenshotFileName,
  browserProofTimeline,
  browserStepRecord,
  browserStepRetention,
} from "./browserProofPolicy";

const threadId = "b0000000-0000-4000-8000-000000000002";

function step(index: number, overrides: Record<string, unknown> = {}): BrowserStep {
  return decodeBrowserStep({
    stepId: `b1000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
    threadId,
    operation: "click",
    recordedAt: `2026-10-12T09:00:0${index}.000Z`,
    ...overrides,
  });
}

function capture(index: number, capturedAt: string) {
  return decodeBrowserCapture({
    captureId: `b2000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
    threadId,
    origin: "https://example.com",
    url: "https://example.com/",
    hash: "a".repeat(64),
    size: 10,
    mime: "image/png",
    capturedAt,
  });
}

describe("browserStepRecord", () => {
  it("names the operation, the element, and the page by origin and path only", () => {
    expect(
      browserStepRecord({
        operation: "click",
        element: { role: "button", name: "Save" },
        url: "https://example.com/settings/profile?tab=2&token=abc#top",
        change: {
          before: { url: "https://example.com/", title: "A", contentHash: "1" },
          after: {
            url: "https://example.com/settings/profile?tab=2&token=abc#top",
            title: "A",
            contentHash: "2",
          },
        },
      }),
    ).toEqual({
      operation: "click",
      element: { role: "button", name: "Save" },
      origin: "https://example.com",
      path: "/settings/profile",
      changed: "Address changed to https://example.com/settings/profile. Page content changed.",
    });
  });

  it("says what changed in fixed words and never copies a title or page text", () => {
    const typed = "my secret search";
    const record = browserStepRecord({
      operation: "type",
      url: "https://example.com/search?q=my+secret+search",
      change: {
        before: { url: "https://example.com/search", title: "Search", contentHash: "1" },
        after: {
          url: "https://example.com/search?q=my+secret+search",
          title: `Results for "${typed}"`,
          contentHash: "2",
        },
      },
    });
    expect(record.changed).toBe(
      "Address changed to https://example.com/search. Title changed. Page content changed.",
    );
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("records the failure category and leaves a non-web page without an origin", () => {
    const record = browserStepRecord({
      operation: "type",
      element: { role: "textbox", name: "Email" },
      url: "about:blank",
      failure: "credential-protected",
    });
    expect(record).toEqual({
      operation: "type",
      element: { role: "textbox", name: "Email" },
      failure: "credential-protected",
    });
  });

  it("bounds an element name", () => {
    const record = browserStepRecord({
      operation: "click",
      element: { role: "link", name: "n".repeat(500) },
    });
    expect(record.element?.name).toHaveLength(160);
  });
});

describe("browserStepChange", () => {
  const page = { url: "https://example.com/a", title: "T", contentHash: "h" };
  it("says nothing for a read and 'Nothing changed' when nothing did", () => {
    expect(browserStepChange("snapshot", page, { ...page, contentHash: "x" })).toBeUndefined();
    expect(browserStepChange("click", page, page)).toBe("Nothing changed.");
  });
  it("says a credential page's content was not compared", () => {
    expect(browserStepChange("click", page, { ...page, contentHash: undefined })).toBe(
      "Page content not compared.",
    );
  });
});

describe("browserStepRetention", () => {
  it("keeps the newest fifty", () => {
    expect(browserStepRetention(50)).toEqual({ firstRetainedVersion: 1 });
    expect(browserStepRetention(51)).toEqual({ firstRetainedVersion: 2 });
  });
});

describe("browserProofTimeline", () => {
  it("places a capture after the step that took it and a person's capture after the step before it", () => {
    const shot = capture(1, "2026-10-12T09:00:02.500Z");
    const mine = capture(2, "2026-10-12T09:00:03.500Z");
    const steps = [
      step(1),
      step(2, { operation: "screenshot", captureId: shot.captureId }),
      step(3),
      step(4),
    ];
    const kinds = browserProofTimeline(steps, [mine, shot]).map((entry) =>
      entry.kind === "step" ? `step ${entry.number}` : `file ${entry.fileNumber}`,
    );
    expect(kinds).toEqual(["step 1", "step 2", "file 1", "step 3", "file 2", "step 4"]);
  });

  it("leads with a capture that predates every retained step", () => {
    const early = capture(1, "2026-10-12T08:00:00.000Z");
    const entries = browserProofTimeline([step(1)], [early]);
    expect(entries[0]?.kind).toBe("capture");
  });
});

describe("browserProofPullRequestSection", () => {
  it("lists the numbered steps and names each screenshot file", () => {
    const shot = capture(1, "2026-10-12T09:00:02.500Z");
    const section = browserProofPullRequestSection(
      [
        step(1, {
          element: { role: "button", name: "Save" },
          origin: "https://example.com",
          path: "/a",
          changed: "Page content changed.",
        }),
        step(2, { operation: "screenshot", captureId: shot.captureId }),
      ],
      [shot],
    );
    expect(section).toBe(
      [
        "## Browser check",
        "",
        '1. click button "Save" on https://example.com/a — Page content changed.',
        "2. screenshot",
        "   - Screenshot: browser-check-01.png",
        "",
        "Screenshots are not embedded. Drag the saved files of the same names into this description.",
      ].join("\n"),
    );
  });

  it("adds nothing when the thread has no steps", () => {
    expect(browserProofPullRequestSection([], [])).toBeUndefined();
    expect(bodyWithBrowserProof("Body", undefined)).toBe("Body");
  });

  it("escapes a backslash so it cannot cancel the escape after it", () => {
    const section = browserProofPullRequestSection(
      [step(1, { element: { role: "link", name: "a\\[b](c)" } })],
      [],
    );
    expect(section).toContain("a\\\\\\[b\\](c)");
  });

  it("keeps a page's title from opening a link or block in the body", () => {
    const section = browserProofPullRequestSection(
      [step(1, { changed: 'Title is now "[x](https://evil.test) <b>".' })],
      [],
    );
    expect(section).toContain("\\[x\\]");
    expect(section).not.toContain("[x](");
  });

  it("appends after the body with one blank line", () => {
    expect(bodyWithBrowserProof("Body\n\n", "## Browser check")).toBe("Body\n\n## Browser check");
    expect(bodyWithBrowserProof("", "## Browser check")).toBe("## Browser check");
  });
});

describe("browserProofScreenshotFileName", () => {
  it("numbers the file from its position and takes the extension from the media type", () => {
    expect(browserProofScreenshotFileName(3, "image/jpeg")).toBe("browser-check-03.jpg");
  });
});
