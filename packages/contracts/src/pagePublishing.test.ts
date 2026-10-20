import { describe, expect, it } from "vitest";
import {
  decodePagePublishAvailability,
  decodePagePublishOutcome,
  decodePagePublishRequest,
  PAGE_PUBLISH_HTML_MAX_BYTES,
} from "./pagePublishing";

describe("page publishing shapes", () => {
  it("accepts a published outcome only with a credential-free http(s) address", () => {
    expect(
      decodePagePublishOutcome({ kind: "published", address: "https://pages.example/p/1" }),
    ).toEqual({ kind: "published", address: "https://pages.example/p/1" });
    expect(() => decodePagePublishOutcome({ kind: "published" })).toThrow();
    expect(() =>
      decodePagePublishOutcome({ kind: "published", address: "https://u:p@pages.example/p" }),
    ).toThrow();
    expect(() =>
      decodePagePublishOutcome({ kind: "published", address: "file:///Users/me/page.html" }),
    ).toThrow();
  });

  it("refuses a refusal or availability whose text carries a path or a secret", () => {
    expect(() =>
      decodePagePublishOutcome({ kind: "refused", message: "See /Users/me/secret.txt" }),
    ).toThrow();
    expect(() =>
      decodePagePublishAvailability({ kind: "refused", reason: "token sk-ant-abcdefghijklmnop" }),
    ).toThrow();
    expect(decodePagePublishAvailability({ kind: "ready", account: "Work account" })).toEqual({
      kind: "ready",
      account: "Work account",
    });
  });

  it("refuses a request whose file name names a folder or whose page is empty or oversized", () => {
    const request = { fileName: "launch-plan.html", title: "Launch plan", html: "<p>hi</p>" };
    expect(decodePagePublishRequest(request)).toEqual(request);
    expect(() => decodePagePublishRequest({ ...request, fileName: "../launch.html" })).toThrow();
    expect(() => decodePagePublishRequest({ ...request, fileName: "a/b.html" })).toThrow();
    expect(() => decodePagePublishRequest({ ...request, html: "" })).toThrow();
    expect(() =>
      decodePagePublishRequest({ ...request, html: "x".repeat(PAGE_PUBLISH_HTML_MAX_BYTES + 1) }),
    ).toThrow();
  });
});
