import { decodeBrowserCapture, decodeBrowserStep, type BrowserStep } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  bodyWithBrowserProof,
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
        changed: "The page's text changed.",
      }),
    ).toEqual({
      operation: "click",
      element: { role: "button", name: "Save" },
      origin: "https://example.com",
      path: "/settings/profile",
      changed: "The page's text changed.",
    });
  });

  it("redacts an address inside the result line the way a diagnostic does", () => {
    const record = browserStepRecord({
      operation: "navigate",
      url: "https://example.com/cb",
      changed: "Now at https://user:pw@example.com/cb?code=s3cr3t&page=2#frag.",
    });
    expect(record.changed).toContain("page=2");
    expect(record.changed).not.toContain("s3cr3t");
    expect(record.changed).not.toContain("pw@");
    expect(record.changed).not.toContain("#frag");
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

  it("bounds an element name and a result line", () => {
    const record = browserStepRecord({
      operation: "click",
      element: { role: "link", name: "n".repeat(500) },
      changed: "c".repeat(5000),
    });
    expect(record.element?.name).toHaveLength(160);
    expect(record.changed).toHaveLength(1024);
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
          changed: "The page's text changed.",
        }),
        step(2, { operation: "screenshot", captureId: shot.captureId }),
      ],
      [shot],
    );
    expect(section).toBe(
      [
        "## Browser check",
        "",
        '1. click button "Save" on https://example.com/a — The page\'s text changed.',
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
