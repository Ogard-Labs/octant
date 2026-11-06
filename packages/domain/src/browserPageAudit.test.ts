import { BrowserPageAudit } from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BROWSER_RESOURCE_TIMING_BUFFER,
  browserAccessibilityAuditResult,
  browserAuditRating,
  browserPageCounters,
  browserPerformanceAuditResult,
  browserResourceType,
  cumulativeLayoutShift,
  totalBlockingTime,
  type BrowserAccessibilityReading,
  type BrowserPerformanceReading,
} from "./browserPageAudit";

const quietPage: BrowserAccessibilityReading = {
  findings: [],
  found: [],
  touch: false,
  contrastNotMeasured: 0,
  frames: 0,
  truncated: false,
};

const loaded: BrowserPerformanceReading = {
  now: 12_345.6,
  navigation: {
    type: "navigate",
    responseStart: 120.4,
    domContentLoaded: 640,
    load: 900,
    transferSize: 4_000,
  },
  firstContentfulPaint: 700,
  largestContentfulPaint: {
    startTime: 2_600,
    selector: "#hero",
    url: "https://shop.test/hero.jpg",
  },
  layoutShifts: [],
  longTasks: [],
  resources: [],
};

describe("an accessibility audit's answer", () => {
  it("names a finding by the ref the latest snapshot gave its element, and by selector otherwise", () => {
    const audit = browserAccessibilityAuditResult(
      {
        ...quietPage,
        findings: [
          { rule: "button-name", selector: "#close", role: "button" },
          { rule: "image-alt", selector: "main > img:nth-of-type(2)", role: "img" },
        ],
        found: [
          { rule: "button-name", count: 1 },
          { rule: "image-alt", count: 1 },
        ],
      },
      new Map([["#close", "e7"]]),
    );
    expect(audit.findings).toEqual([
      expect.objectContaining({
        rule: "image-alt",
        severity: "serious",
        selector: "main > img:nth-of-type(2)",
      }),
      expect.objectContaining({ rule: "button-name", ref: "e7", role: "button" }),
    ]);
    expect(audit.findings[1]).not.toHaveProperty("selector");
    expect(audit.truncated).toBe(false);
  });

  it("lists at most ten findings per rule and twenty-five in all, keeps every rule's count, and says it was cut", () => {
    const many = (rule: "color-contrast" | "link-name" | "heading-order", count: number) =>
      Array.from({ length: count }, (_, index) => ({
        rule,
        selector: `#${rule}-${String(index)}`,
      }));
    const audit = browserAccessibilityAuditResult(
      {
        ...quietPage,
        findings: [
          ...many("color-contrast", 10),
          ...many("link-name", 10),
          ...many("heading-order", 10),
        ],
        found: [
          { rule: "color-contrast", count: 140 },
          { rule: "link-name", count: 10 },
          { rule: "heading-order", count: 10 },
        ],
      },
      new Map(),
    );
    expect(audit.findings).toHaveLength(25);
    expect(audit.findings.filter((finding) => finding.rule === "link-name")).toHaveLength(10);
    expect(audit.findings.filter((finding) => finding.rule === "heading-order")).toHaveLength(5);
    expect(audit.found).toContainEqual({ rule: "color-contrast", count: 140 });
    expect(audit.truncated).toBe(true);
  });

  it("words contrast in the host's own message with the measured ratio and what the text needs", () => {
    const audit = browserAccessibilityAuditResult(
      {
        ...quietPage,
        findings: [
          {
            rule: "color-contrast",
            selector: "p",
            text: "Free shipping",
            detail: { ratio: 2.32, required: 4.5, foreground: "#999999", background: "#ffffff" },
          },
        ],
        found: [{ rule: "color-contrast", count: 1 }],
      },
      new Map(),
    );
    expect(audit.findings[0]?.message).toBe(
      "Text contrast is 2.32:1 (#999999 on #ffffff); this text needs 4.50:1 (WCAG 1.4.3).",
    );
    expect(audit.findings[0]?.text).toBe("Free shipping");
  });

  it("leaves out a selector too long to keep whole rather than shortening it into another one", () => {
    const audit = browserAccessibilityAuditResult(
      {
        ...quietPage,
        findings: [{ rule: "link-name", selector: `${"div > ".repeat(60)}a` }],
        found: [{ rule: "link-name", count: 1 }],
      },
      new Map(),
    );
    expect(audit.findings[0]).not.toHaveProperty("selector");
  });

  it("says target size did not run until the page is a touch device", () => {
    expect(browserAccessibilityAuditResult(quietPage, new Map()).notRun).toEqual([
      { rule: "target-size", reason: expect.stringContaining("preset phone") },
    ]);
    expect(
      browserAccessibilityAuditResult({ ...quietPage, touch: true }, new Map()).notRun,
    ).toEqual([]);
  });
});

describe("a performance audit's answer", () => {
  it("rates each vital by the published boundaries", () => {
    expect(browserAuditRating("lcp", 2_500)).toBe("good");
    expect(browserAuditRating("lcp", 2_501)).toBe("needs-improvement");
    expect(browserAuditRating("lcp", 4_001)).toBe("poor");
    expect(browserAuditRating("cls", 0.1)).toBe("good");
    expect(browserAuditRating("cls", 0.26)).toBe("poor");
    expect(browserAuditRating("tbt", 300)).toBe("needs-improvement");
    expect(browserAuditRating("ttfb", 800)).toBe("good");
    expect(browserAuditRating("fcp", 3_100)).toBe("poor");
  });

  it("reports the load's timings and vitals, and names the largest paint's element by ref", () => {
    const audit = browserPerformanceAuditResult(
      loaded,
      { status: "read", domNodes: 812, jsHeapUsedBytes: 2_000_000 },
      new Map([["#hero", "e3"]]),
    );
    expect(audit).toMatchObject({
      documentAgeMs: 12_346,
      navigationType: "navigate",
      domContentLoadedMs: 640,
      loadMs: 900,
      lcpElement: { ref: "e3", url: "https://shop.test/hero.jpg" },
      page: { domNodes: 812, jsHeapUsedBytes: 2_000_000 },
    });
    expect(audit.vitals).toEqual([
      { metric: "ttfb", value: 120, rating: "good" },
      { metric: "fcp", value: 700, rating: "good" },
      { metric: "lcp", value: 2_600, rating: "needs-improvement" },
      { metric: "cls", value: 0, rating: "good" },
      { metric: "tbt", value: 0, rating: "good" },
    ]);
  });

  it("says what it could not measure instead of reporting a number it does not have", () => {
    const audit = browserPerformanceAuditResult(
      {
        now: 50,
        navigation: {
          type: "navigate",
          responseStart: 10,
          domContentLoaded: 0,
          load: 0,
          transferSize: 0,
        },
        resources: [],
      },
      { status: "unavailable", reason: "Someone else holds the developer tools." },
      new Map(),
    );
    expect(audit.vitals.map((vital) => vital.metric)).toEqual(["ttfb"]);
    expect(audit.notMeasured.map((entry) => entry.metric)).toEqual([
      "fcp",
      "lcp",
      "cls",
      "tbt",
      "inp",
      "load",
      "page",
    ]);
    expect(audit).not.toHaveProperty("page");
    expect(audit).not.toHaveProperty("loadMs");
  });

  it("redacts the largest resources' addresses as diagnostics do and totals requests by type", () => {
    const audit = browserPerformanceAuditResult(
      {
        ...loaded,
        resources: [
          {
            url: "https://ada:pw@shop.test/app.js?token=s3cret&v=2#frag",
            initiatorType: "script",
            contentType: "text/javascript",
            transferSize: 90_000,
          },
          {
            url: "https://shop.test/hero.jpg",
            initiatorType: "img",
            contentType: "image/jpeg",
            transferSize: 300_000,
          },
          {
            url: "https://shop.test/api/cart",
            initiatorType: "fetch",
            contentType: "",
            transferSize: 0,
          },
        ],
      },
      { status: "read" },
      new Map(),
    );
    expect(audit.largestResources).toEqual([
      { url: "https://shop.test/hero.jpg", type: "image", transferBytes: 300_000 },
      { url: "https://shop.test/app.js?token=redacted&v=2", type: "script", transferBytes: 90_000 },
    ]);
    expect(audit.requests).toEqual({
      count: 4,
      transferBytes: 394_000,
      byType: [
        { type: "document", count: 1, transferBytes: 4_000 },
        { type: "script", count: 1, transferBytes: 90_000 },
        { type: "image", count: 1, transferBytes: 300_000 },
        { type: "fetch", count: 1, transferBytes: 0 },
      ],
    });
  });

  it("says the request list may be incomplete once the browser's own list is full", () => {
    const resources = Array.from({ length: BROWSER_RESOURCE_TIMING_BUFFER }, (_, index) => ({
      url: `https://shop.test/${String(index)}.png`,
      initiatorType: "img",
      contentType: "image/png",
      transferSize: 10,
    }));
    expect(
      browserPerformanceAuditResult({ ...loaded, resources }, { status: "read" }, new Map())
        .requests.listFull,
    ).toBe(true);
  });

  it("scores layout shift as its largest burst, leaving out shifts right after input", () => {
    expect(
      cumulativeLayoutShift([
        { startTime: 100, value: 0.05, hadRecentInput: false },
        { startTime: 600, value: 0.05, hadRecentInput: false },
        { startTime: 3_000, value: 0.02, hadRecentInput: false },
        { startTime: 3_100, value: 0.5, hadRecentInput: true },
      ]),
    ).toBeCloseTo(0.1);
  });

  it("counts blocking time past fifty milliseconds of each long task after the first paint", () => {
    expect(
      totalBlockingTime(
        [
          { startTime: 50, duration: 300 },
          { startTime: 900, duration: 120 },
          { startTime: 1_500, duration: 51 },
        ],
        700,
      ),
    ).toBe(71);
  });

  it("types a request by what fetched it, its media type, and its address", () => {
    const type = (url: string, initiatorType: string, contentType = "") =>
      browserResourceType({ url, initiatorType, contentType });
    expect(type("https://a.test/data.json", "fetch", "text/javascript")).toBe("fetch");
    expect(type("https://a.test/font", "css", "font/woff2")).toBe("font");
    expect(type("https://a.test/site.css", "link")).toBe("stylesheet");
    expect(type("https://a.test/bg.webp", "css")).toBe("image");
    expect(type("https://a.test/thing", "other")).toBe("other");
  });

  it("answers in the shape the contract decodes, even when the browser reports no usable value", () => {
    const decode = Schema.decodeUnknownSync(BrowserPageAudit);
    const performanceAudit = browserPerformanceAuditResult(
      { ...loaded, firstContentfulPaint: Number.NaN },
      { status: "read", domNodes: 3 },
      new Map(),
    );
    expect(() => decode(performanceAudit)).not.toThrow();
    expect(performanceAudit.notMeasured).toContainEqual(expect.objectContaining({ metric: "fcp" }));
    const accessibilityAudit = browserAccessibilityAuditResult(
      {
        ...quietPage,
        findings: [
          {
            rule: "duplicate-id-aria",
            selector: "span:nth-of-type(2)",
            detail: { id: "hint", count: 2 },
          },
        ],
        found: [{ rule: "duplicate-id-aria", count: 1 }],
      },
      new Map(),
    );
    expect(() => decode(accessibilityAudit)).not.toThrow();
  });

  it("reads the page's present counts from the protocol's metrics and nothing else", () => {
    expect(
      browserPageCounters({
        metrics: [
          { name: "Nodes", value: 44 },
          { name: "JSHeapUsedSize", value: 2_001_480 },
          { name: "JSEventListeners", value: 14 },
          { name: "ScriptDuration", value: 0 },
        ],
      }),
    ).toEqual({ status: "read", domNodes: 44, jsHeapUsedBytes: 2_001_480, jsEventListeners: 14 });
    expect(browserPageCounters(undefined).status).toBe("unavailable");
  });
});
