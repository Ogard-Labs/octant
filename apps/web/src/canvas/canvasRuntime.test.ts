import { describe, expect, it } from "vitest";
import { decodeCanvasForRender, formatScalar, isSafeLinkHref } from "./canvasRuntime";
import { canvasFixture, unsafeLinkFixture } from "./test-fixtures";

describe("decodeCanvasForRender gate", () => {
  it("accepts a validated first-party definition", () => {
    const gate = decodeCanvasForRender(canvasFixture);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.definition.title).toBe("Signed Q3 report");
  });

  it("rejects a payload that is not an object", () => {
    const gate = decodeCanvasForRender("not an object");
    expect(gate).toMatchObject({ ok: false });
  });

  it("fails closed for unsafe content such as a javascript: link", () => {
    const gate = decodeCanvasForRender(unsafeLinkFixture);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBeTruthy();
  });
});

describe("isSafeLinkHref", () => {
  it("allows only credential-free http(s) URLs", () => {
    expect(isSafeLinkHref("https://example.com/a")).toBe(true);
    expect(isSafeLinkHref("http://example.com/a")).toBe(true);
    expect(isSafeLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("data:text/html,<b>hi</b>")).toBe(false);
    expect(isSafeLinkHref("file:///etc/passwd")).toBe(false);
    expect(isSafeLinkHref("//example.com")).toBe(false);
    expect(isSafeLinkHref("https://user:pass@example.com")).toBe(false);
  });
});

describe("formatScalar", () => {
  it("renders booleans, numbers, and bounded text consistently", () => {
    expect(formatScalar(true)).toBe("Yes");
    expect(formatScalar(false)).toBe("No");
    expect(formatScalar(0.75)).toBe("0.75");
    expect(formatScalar("Chat")).toBe("Chat");
    expect(formatScalar(null)).toBe("—");
    expect(formatScalar(undefined)).toBe("—");
  });
});
