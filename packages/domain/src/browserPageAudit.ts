import {
  MAX_BROWSER_AUDIT_FINDINGS,
  MAX_BROWSER_AUDIT_FINDINGS_PER_RULE,
  MAX_BROWSER_AUDIT_LARGEST_RESOURCES,
  type BrowserAccessibilityAudit,
  type BrowserAccessibilityFinding,
  type BrowserAccessibilityRule,
  type BrowserAuditRating,
  type BrowserPageAudit,
  type BrowserPerformanceAudit,
  type BrowserPerformanceMetricName,
  type BrowserResourceType,
} from "@octant/contracts";
import { redactedBrowserUrl } from "./browserAutomationPolicy";

/**
 * The Browser's page audits: what the fixed page reader measured, shaped into
 * the bounded answer the agent reads. The reader (`readBrowserPage` in its
 * `accessibility` and `performance` modes) runs inside the page and returns the
 * readings below; everything here is pure and runs on the server, so both
 * Browsers answer with the same words, bounds, ratings, and redaction.
 */

/** How many elements one accessibility audit reads before it stops and says so. */
export const MAX_BROWSER_AUDIT_ELEMENTS = 6_000;
/** How many entries of each kind the performance reader brings back from the page. */
export const MAX_BROWSER_AUDIT_TIMELINE_ENTRIES = 300;
/**
 * Chromium keeps 250 resource entries unless a page asks for more, so a list
 * that long may have dropped later requests.
 */
export const BROWSER_RESOURCE_TIMING_BUFFER = 250;

/** One problem as the reader found it, before the host words it. */
export interface BrowserAccessibilityReadingFinding {
  readonly rule: BrowserAccessibilityRule;
  /** The element as the snapshot's selector names it, so the host can find its ref. */
  readonly selector: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  /** The facts the host words its message from. */
  readonly detail?: {
    readonly ratio?: number;
    readonly required?: number;
    readonly foreground?: string;
    readonly background?: string;
    readonly level?: number;
    readonly previousLevel?: number;
    readonly id?: string;
    readonly count?: number;
    readonly width?: number;
    readonly height?: number;
  };
}

export interface BrowserAccessibilityReading {
  /** At most the reader's per-rule limit for each rule. */
  readonly findings: ReadonlyArray<BrowserAccessibilityReadingFinding>;
  readonly found: ReadonlyArray<{
    readonly rule: BrowserAccessibilityRule;
    readonly count: number;
  }>;
  /** Whether the page reports a coarse pointer, as it does under touch emulation. */
  readonly touch: boolean;
  readonly contrastNotMeasured: number;
  readonly frames: number;
  /** The page held more elements than one audit reads. */
  readonly truncated: boolean;
}

export interface BrowserPerformanceReading {
  /** `performance.now()`: how long ago the document began loading. */
  readonly now: number;
  readonly navigation?: {
    readonly type: string;
    readonly responseStart: number;
    readonly domContentLoaded: number;
    readonly load: number;
    readonly transferSize: number;
  };
  readonly firstContentfulPaint?: number;
  readonly largestContentfulPaint?: {
    readonly startTime: number;
    readonly selector?: string;
    readonly url?: string;
  };
  /** Absent when the browser does not report layout shifts. */
  readonly layoutShifts?: ReadonlyArray<{
    readonly startTime: number;
    readonly value: number;
    readonly hadRecentInput: boolean;
  }>;
  /** Absent when the browser does not report long tasks. */
  readonly longTasks?: ReadonlyArray<{ readonly startTime: number; readonly duration: number }>;
  readonly resources: ReadonlyArray<{
    readonly url: string;
    readonly initiatorType: string;
    readonly contentType: string;
    readonly transferSize: number;
  }>;
}

/** The browser's own counters, read through its debugging protocol; see each runtime. */
export type BrowserPageCounters =
  | {
      readonly status: "read";
      readonly domNodes?: number;
      readonly jsHeapUsedBytes?: number;
      readonly jsEventListeners?: number;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * The counters a `Performance.getMetrics` answer holds that describe the page
 * now. Its durations count from when the domain was enabled, which an audit
 * does just before reading, so they are not taken.
 */
export function browserPageCounters(answer: unknown): BrowserPageCounters {
  const metrics: unknown =
    typeof answer === "object" && answer !== null ? Reflect.get(answer, "metrics") : undefined;
  if (!Array.isArray(metrics)) {
    return { status: "unavailable", reason: "The browser's counters could not be read." };
  }
  const read = (name: string): number | undefined => {
    for (const metric of metrics) {
      if (typeof metric !== "object" || metric === null) continue;
      const value: unknown = Reflect.get(metric, "value");
      if (Reflect.get(metric, "name") === name && typeof value === "number") return count(value);
    }
    return undefined;
  };
  const domNodes = read("Nodes");
  const jsHeapUsedBytes = read("JSHeapUsedSize");
  const jsEventListeners = read("JSEventListeners");
  return {
    status: "read",
    ...(domNodes === undefined ? {} : { domNodes }),
    ...(jsHeapUsedBytes === undefined ? {} : { jsHeapUsedBytes }),
    ...(jsEventListeners === undefined ? {} : { jsEventListeners }),
  };
}

/** What a runtime hands the server for an `audit` action. */
export type BrowserPageAuditReading =
  | { readonly kind: "accessibility"; readonly reading: BrowserAccessibilityReading }
  | {
      readonly kind: "performance";
      readonly reading: BrowserPerformanceReading;
      readonly counters: BrowserPageCounters;
    };

/**
 * The published boundaries: at most `good` rates good, above `poor` rates
 * poor, between them needs improvement. TTFB, FCP, LCP, and CLS are the web
 * vitals boundaries; TBT uses the lab boundaries commonly published beside them.
 */
export const BROWSER_WEB_VITALS_THRESHOLDS: Readonly<
  Record<BrowserPerformanceMetricName, { readonly good: number; readonly poor: number }>
> = {
  ttfb: { good: 800, poor: 1_800 },
  fcp: { good: 1_800, poor: 3_000 },
  lcp: { good: 2_500, poor: 4_000 },
  cls: { good: 0.1, poor: 0.25 },
  tbt: { good: 200, poor: 600 },
};

export function browserAuditRating(
  metric: BrowserPerformanceMetricName,
  value: number,
): BrowserAuditRating {
  const { good, poor } = BROWSER_WEB_VITALS_THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

/** Rules in the order findings are listed: what blocks a person most first. */
const RULES: ReadonlyArray<{
  readonly rule: BrowserAccessibilityRule;
  readonly severity: BrowserAccessibilityFinding["severity"];
}> = [
  { rule: "image-alt", severity: "serious" },
  { rule: "button-name", severity: "serious" },
  { rule: "link-name", severity: "serious" },
  { rule: "field-name", severity: "serious" },
  { rule: "focusable-hidden", severity: "serious" },
  { rule: "color-contrast", severity: "serious" },
  { rule: "duplicate-id-aria", severity: "serious" },
  { rule: "document-title", severity: "serious" },
  { rule: "document-lang", severity: "serious" },
  { rule: "heading-order", severity: "moderate" },
  { rule: "target-size", severity: "moderate" },
];

function accessibilityMessage(finding: BrowserAccessibilityReadingFinding): string {
  const detail = finding.detail ?? {};
  switch (finding.rule) {
    case "image-alt":
      return 'Image has no text alternative: add alt text, or alt="" if it is decorative (WCAG 1.1.1).';
    case "button-name":
      return "Button has no accessible name: give it text, aria-label, or aria-labelledby (WCAG 4.1.2).";
    case "link-name":
      return "Link has no accessible name: give it text, aria-label, or alt text on its image (WCAG 2.4.4).";
    case "field-name":
      return "Form field has no label: add a <label>, aria-label, or aria-labelledby (WCAG 1.3.1, 4.1.2).";
    case "focusable-hidden":
      return 'Element can take keyboard focus inside aria-hidden="true": screen readers cannot announce it. Remove it from the tab order or unhide it (WCAG 4.1.2).';
    case "color-contrast":
      return `Text contrast is ${formatRatio(detail.ratio)}:1 (${detail.foreground ?? "?"} on ${detail.background ?? "?"}); this text needs ${formatRatio(detail.required)}:1 (WCAG 1.4.3).`;
    case "duplicate-id-aria":
      return `The id ${JSON.stringify(detail.id ?? "")} is used ${String(detail.count ?? 2)} times, and a label or aria reference reaches only the first (WCAG 4.1.2).`;
    case "document-title":
      return "The page has no title (WCAG 2.4.2).";
    case "document-lang":
      return "The page has no lang attribute on <html> (WCAG 3.1.1).";
    case "heading-order":
      return `Heading level ${String(detail.level ?? "?")} follows level ${String(detail.previousLevel ?? "?")}, skipping a level.`;
    case "target-size":
      return `Touch target is ${String(detail.width ?? "?")} by ${String(detail.height ?? "?")} CSS pixels and too close to another; make it at least 24 by 24 or space it out (WCAG 2.5.8).`;
  }
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "?" : value.toFixed(2);
}

const NEEDS_TOUCH =
  "Needs touch emulation: resize with preset phone (or touch true), then audit again.";

/**
 * The accessibility answer: findings worded by the host and named by ref
 * where the latest snapshot has one, at most `MAX_BROWSER_AUDIT_FINDINGS_PER_RULE`
 * per rule and `MAX_BROWSER_AUDIT_FINDINGS` in all, with every rule's count.
 */
export function browserAccessibilityAuditResult(
  reading: BrowserAccessibilityReading,
  refBySelector: ReadonlyMap<string, string>,
): BrowserAccessibilityAudit {
  const findings: BrowserAccessibilityFinding[] = [];
  let truncated = reading.truncated;
  for (const { rule, severity } of RULES) {
    const ofRule = reading.findings.filter((finding) => finding.rule === rule);
    const room = Math.min(
      MAX_BROWSER_AUDIT_FINDINGS_PER_RULE,
      MAX_BROWSER_AUDIT_FINDINGS - findings.length,
    );
    for (const finding of ofRule.slice(0, Math.max(0, room))) {
      const ref = refBySelector.get(finding.selector);
      const name = shortText(finding.name, 120);
      const text = shortText(finding.text, 80);
      const role = shortText(finding.role, 64);
      const selector = usableSelector(finding.selector);
      findings.push({
        rule,
        severity,
        message: accessibilityMessage(finding).slice(0, 300),
        ...(ref === undefined ? (selector === undefined ? {} : { selector }) : { ref }),
        ...(role === undefined ? {} : { role }),
        ...(name === undefined ? {} : { name }),
        ...(text === undefined || text === name ? {} : { text }),
      });
    }
  }
  const found = RULES.flatMap(({ rule }) => {
    const count = reading.found.find((entry) => entry.rule === rule)?.count ?? 0;
    return count > 0 ? [{ rule, count: Math.floor(count) }] : [];
  });
  const listed = new Map<string, number>();
  for (const finding of findings) listed.set(finding.rule, (listed.get(finding.rule) ?? 0) + 1);
  if (found.some((entry) => entry.count > (listed.get(entry.rule) ?? 0))) truncated = true;
  return {
    kind: "accessibility",
    findings,
    found,
    notRun: reading.touch ? [] : [{ rule: "target-size", reason: NEEDS_TOUCH }],
    contrastNotMeasured: count(reading.contrastNotMeasured),
    framesNotAudited: count(reading.frames),
    truncated,
  };
}

/**
 * The performance answer: the load's timings, the vitals with their ratings,
 * the requests by type, the largest resources with their addresses redacted as
 * diagnostics redacts them, and what could not be measured.
 */
export function browserPerformanceAuditResult(
  reading: BrowserPerformanceReading,
  counters: BrowserPageCounters,
  refBySelector: ReadonlyMap<string, string>,
): BrowserPerformanceAudit {
  const notMeasured: Array<{ readonly metric: string; readonly reason: string }> = [];
  const vitals: Array<BrowserPerformanceAudit["vitals"][number]> = [];
  const vital = (metric: BrowserPerformanceMetricName, value: number) => {
    if (!Number.isFinite(value)) {
      notMeasured.push({ metric, reason: "The browser reported no usable value." });
      return;
    }
    const rounded = metric === "cls" ? Math.round(value * 1_000) / 1_000 : Math.round(value);
    vitals.push({ metric, value: Math.max(0, rounded), rating: browserAuditRating(metric, value) });
  };
  const navigation = reading.navigation;
  if (navigation === undefined) {
    notMeasured.push({
      metric: "navigation",
      reason: "The browser kept no record of this document's load.",
    });
  } else if (navigation.responseStart > 0) {
    vital("ttfb", navigation.responseStart);
  }
  const fcp = reading.firstContentfulPaint;
  if (fcp === undefined) {
    notMeasured.push({ metric: "fcp", reason: "The page has painted no text or image yet." });
  } else {
    vital("fcp", fcp);
  }
  const lcp = reading.largestContentfulPaint;
  if (lcp === undefined) {
    notMeasured.push({
      metric: "lcp",
      reason:
        "No largest contentful paint was recorded: the page painted no text or image yet, or loaded while hidden.",
    });
  } else {
    vital("lcp", lcp.startTime);
  }
  if (reading.layoutShifts === undefined) {
    notMeasured.push({ metric: "cls", reason: "This browser does not report layout shifts." });
  } else {
    vital("cls", cumulativeLayoutShift(reading.layoutShifts));
  }
  if (reading.longTasks === undefined) {
    notMeasured.push({ metric: "tbt", reason: "This browser does not report long tasks." });
  } else if (fcp === undefined) {
    notMeasured.push({
      metric: "tbt",
      reason: "Blocking time counts from the first contentful paint.",
    });
  } else {
    vital("tbt", totalBlockingTime(reading.longTasks, fcp));
  }
  notMeasured.push({
    metric: "inp",
    reason:
      "Interaction to Next Paint is not measured: the browser does not record the agent's input as interactions. TBT stands in for responsiveness.",
  });
  if (navigation !== undefined && navigation.load <= 0) {
    notMeasured.push({ metric: "load", reason: "The page has not finished loading." });
  }
  const lcpSelector = lcp?.selector === undefined ? undefined : usableSelector(lcp.selector);
  const lcpRef = lcpSelector === undefined ? undefined : refBySelector.get(lcpSelector);
  const lcpUrl = lcp?.url === undefined || lcp.url === "" ? undefined : shortUrl(lcp.url);
  const lcpElement =
    lcp === undefined
      ? undefined
      : {
          ...(lcpRef === undefined
            ? lcpSelector === undefined
              ? {}
              : { selector: lcpSelector }
            : { ref: lcpRef }),
          ...(lcpUrl === undefined ? {} : { url: lcpUrl }),
        };
  const resources = reading.resources.slice(0, MAX_BROWSER_AUDIT_TIMELINE_ENTRIES).map((entry) => ({
    url: entry.url,
    type: browserResourceType(entry),
    transferBytes: count(entry.transferSize),
  }));
  const requests = [
    ...(navigation === undefined
      ? []
      : [{ type: "document" as const, transferBytes: count(navigation.transferSize) }]),
    ...resources,
  ];
  const byType = new Map<BrowserResourceType, { count: number; transferBytes: number }>();
  for (const request of requests) {
    const entry = byType.get(request.type) ?? { count: 0, transferBytes: 0 };
    entry.count += 1;
    entry.transferBytes += request.transferBytes;
    byType.set(request.type, entry);
  }
  const largestResources = resources
    .filter((resource) => resource.transferBytes > 0)
    .sort((left, right) => right.transferBytes - left.transferBytes)
    .slice(0, MAX_BROWSER_AUDIT_LARGEST_RESOURCES)
    .flatMap((resource) => {
      const url = shortUrl(resource.url);
      return url === undefined
        ? []
        : [{ url, type: resource.type, transferBytes: resource.transferBytes }];
    });
  const longTasks = reading.longTasks;
  if (counters.status === "unavailable") {
    notMeasured.push({ metric: "page", reason: counters.reason.slice(0, 300) });
  }
  const page =
    counters.status === "read"
      ? {
          ...(counters.domNodes === undefined ? {} : { domNodes: count(counters.domNodes) }),
          ...(counters.jsHeapUsedBytes === undefined
            ? {}
            : { jsHeapUsedBytes: count(counters.jsHeapUsedBytes) }),
          ...(counters.jsEventListeners === undefined
            ? {}
            : { jsEventListeners: count(counters.jsEventListeners) }),
        }
      : undefined;
  return {
    kind: "performance",
    documentAgeMs: count(reading.now),
    ...(navigation === undefined ? {} : navigationFacts(navigation)),
    vitals,
    ...(lcpElement === undefined || Object.keys(lcpElement).length === 0 ? {} : { lcpElement }),
    ...(longTasks === undefined
      ? {}
      : {
          longTasks: {
            count: longTasks.length,
            totalMs: count(longTasks.reduce((sum, task) => sum + task.duration, 0)),
            longestMs: count(Math.max(0, ...longTasks.map((task) => task.duration))),
          },
        }),
    requests: {
      count: requests.length,
      transferBytes: requests.reduce((sum, request) => sum + request.transferBytes, 0),
      byType: [...byType].map(([type, entry]) => ({ type, ...entry })),
      ...(reading.resources.length >= BROWSER_RESOURCE_TIMING_BUFFER ? { listFull: true } : {}),
    },
    largestResources,
    ...(page === undefined || Object.keys(page).length === 0 ? {} : { page }),
    notMeasured: notMeasured.slice(0, 12),
  };
}

/** Shape what a runtime read into the answer, naming elements by ref where it can. */
export function browserPageAuditResult(
  reading: BrowserPageAuditReading,
  refBySelector: ReadonlyMap<string, string>,
): BrowserPageAudit {
  return reading.kind === "accessibility"
    ? browserAccessibilityAuditResult(reading.reading, refBySelector)
    : browserPerformanceAuditResult(reading.reading, reading.counters, refBySelector);
}

function navigationFacts(
  navigation: NonNullable<BrowserPerformanceReading["navigation"]>,
): Pick<BrowserPerformanceAudit, "navigationType" | "domContentLoadedMs" | "loadMs"> {
  const type = navigation.type;
  return {
    ...(type === "navigate" || type === "reload" || type === "back_forward" || type === "prerender"
      ? { navigationType: type }
      : {}),
    ...(navigation.domContentLoaded > 0
      ? { domContentLoadedMs: count(navigation.domContentLoaded) }
      : {}),
    ...(navigation.load > 0 ? { loadMs: count(navigation.load) } : {}),
  };
}

/**
 * The largest burst of layout shifts, as the web vitals define it: shifts
 * less than a second apart form one window of at most five seconds, shifts
 * right after input do not count, and the score is the largest window's sum.
 */
export function cumulativeLayoutShift(
  shifts: ReadonlyArray<{
    readonly startTime: number;
    readonly value: number;
    readonly hadRecentInput: boolean;
  }>,
): number {
  let largest = 0;
  let windowSum = 0;
  let windowStart = Number.NEGATIVE_INFINITY;
  let previous = Number.NEGATIVE_INFINITY;
  const counted = shifts
    .filter((shift) => !shift.hadRecentInput && Number.isFinite(shift.value) && shift.value > 0)
    .sort((left, right) => left.startTime - right.startTime);
  for (const shift of counted) {
    if (shift.startTime - previous >= 1_000 || shift.startTime - windowStart >= 5_000) {
      windowSum = 0;
      windowStart = shift.startTime;
    }
    windowSum += shift.value;
    previous = shift.startTime;
    largest = Math.max(largest, windowSum);
  }
  return largest;
}

/** Each long task after the first contentful paint blocks input for its time past 50 ms. */
export function totalBlockingTime(
  tasks: ReadonlyArray<{ readonly startTime: number; readonly duration: number }>,
  firstContentfulPaint: number,
): number {
  return tasks
    .filter((task) => task.startTime >= firstContentfulPaint)
    .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0);
}

const SCRIPT_EXTENSION = /\.m?js$/;
const STYLE_EXTENSION = /\.css$/;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/;
const FONT_EXTENSION = /\.(?:woff2?|ttf|otf|eot)$/;
const MEDIA_EXTENSION = /\.(?:mp4|webm|ogg|mp3|wav|m4a|m3u8)$/;

/**
 * What a request fetched. A fetch is a fetch whatever it returned; otherwise
 * the response's own media type decides when the browser reports one, then
 * what asked for it, then the address's extension.
 */
export function browserResourceType(entry: {
  readonly url: string;
  readonly initiatorType: string;
  readonly contentType: string;
}): BrowserResourceType {
  const initiator = entry.initiatorType.toLowerCase();
  if (initiator === "fetch" || initiator === "xmlhttprequest" || initiator === "beacon") {
    return "fetch";
  }
  const media = entry.contentType.toLowerCase();
  if (media !== "") {
    if (media.startsWith("text/css")) return "stylesheet";
    if (media.includes("javascript") || media.includes("ecmascript")) return "script";
    if (media.startsWith("image/")) return "image";
    if (media.startsWith("font/") || media.includes("font-woff")) return "font";
    if (media.startsWith("video/") || media.startsWith("audio/")) return "media";
    if (media.startsWith("text/html")) return "document";
    if (media.includes("json")) return "fetch";
  }
  let path = "";
  try {
    path = new URL(entry.url).pathname.toLowerCase();
  } catch {
    path = "";
  }
  if (initiator === "script" || SCRIPT_EXTENSION.test(path)) return "script";
  if (initiator === "img" || initiator === "image" || initiator === "input") return "image";
  if (initiator === "iframe" || initiator === "frame") return "document";
  if (initiator === "video" || initiator === "audio" || initiator === "track") return "media";
  if (STYLE_EXTENSION.test(path)) return "stylesheet";
  if (FONT_EXTENSION.test(path)) return "font";
  if (IMAGE_EXTENSION.test(path)) return "image";
  if (MEDIA_EXTENSION.test(path)) return "media";
  return "other";
}

function shortUrl(value: string): string | undefined {
  const redacted = redactedBrowserUrl(value).trim();
  return redacted === "" ? undefined : redacted.slice(0, 1_024);
}

function shortText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length <= maximum ? flat : `${flat.slice(0, maximum - 1)}…`;
}

/** A shortened selector would name another element or none, so a long one is left out. */
function usableSelector(value: string): string | undefined {
  return value.trim() !== "" && value.length <= 256 ? value : undefined;
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
