import { describe, expect, it } from "vitest";
import { DEVICE_OPEN_URL_MAX_LENGTH, DeviceHostCapabilities, isDeviceOpenUrl } from "./deviceHost";
import { Schema } from "effect";

describe("DeviceOpenUrl", () => {
  it("accepts http and https addresses in the form the device receives", () => {
    expect(isDeviceOpenUrl("https://example.com/")).toBe(true);
    expect(isDeviceOpenUrl("http://localhost:3000/sign-in?next=%2Fhome#top")).toBe(true);
  });

  it("refuses every other scheme, including script, file, data, and app links", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<p>hi</p>",
      "myapp://open/settings",
      "intent://scan/#Intent;scheme=zxing;end",
      "ftp://example.com/",
    ]) {
      expect(isDeviceOpenUrl(url), url).toBe(false);
    }
  });

  it("refuses credentials, and any text the parser would rewrite before sending", () => {
    expect(isDeviceOpenUrl("https://person:secret@example.com/")).toBe(false);
    expect(isDeviceOpenUrl("https://example.com")).toBe(false);
    expect(isDeviceOpenUrl("https://EXAMPLE.com/")).toBe(false);
    expect(isDeviceOpenUrl(" https://example.com/")).toBe(false);
    expect(isDeviceOpenUrl("https://example.com/a b")).toBe(false);
    expect(isDeviceOpenUrl("https://example.com/\n")).toBe(false);
    expect(isDeviceOpenUrl("")).toBe(false);
  });

  it("refuses an address longer than the limit", () => {
    const base = "https://example.com/";
    const atLimit = base + "a".repeat(DEVICE_OPEN_URL_MAX_LENGTH - base.length);
    expect(isDeviceOpenUrl(atLimit)).toBe(true);
    expect(isDeviceOpenUrl(`${atLimit}a`)).toBe(false);
  });
});

describe("DeviceHostCapabilities", () => {
  const decode = Schema.decodeUnknownSync(DeviceHostCapabilities);

  it("reads the flags a host reports and ignores ones this renderer does not know", () => {
    expect(decode({ openUrl: true })).toEqual({ openUrl: true });
    expect(decode({ openUrl: true, recordScreen: true })).toEqual({ openUrl: true });
    expect(decode({})).toEqual({});
  });
});
