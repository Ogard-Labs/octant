import { describe, expect, it } from "vitest";
import { parseListenerRequestHost } from "./listenerRequestHost";

const listener = new URL("http://127.0.0.1:52693/");

describe("parseListenerRequestHost", () => {
  it("accepts the listener, the configured hostname, and loopback aliases on the same port", () => {
    expect(parseListenerRequestHost("127.0.0.1:52693", listener, "127.0.0.1")?.origin).toBe(
      "http://127.0.0.1:52693",
    );
    expect(parseListenerRequestHost("localhost:52693", listener, "127.0.0.1")?.origin).toBe(
      "http://localhost:52693",
    );
    expect(parseListenerRequestHost("[::1]:52693", listener, "127.0.0.1")?.origin).toBe(
      "http://[::1]:52693",
    );
  });

  it("rejects a mismatched, malformed, or empty Host before dispatch", () => {
    expect(
      parseListenerRequestHost("attacker.example:52693", listener, "127.0.0.1"),
    ).toBeUndefined();
    expect(parseListenerRequestHost("localhost:not-a-port", listener, "127.0.0.1")).toBeUndefined();
    expect(parseListenerRequestHost("", listener, "127.0.0.1")).toBeUndefined();
    expect(parseListenerRequestHost(" 127.0.0.1:52693", listener, "127.0.0.1")).toBeUndefined();
    expect(
      parseListenerRequestHost("user:pass@127.0.0.1:52693", listener, "127.0.0.1"),
    ).toBeUndefined();
    expect(parseListenerRequestHost(null, listener, "127.0.0.1")).toBeUndefined();
  });

  it("rejects a Host that names the listener on a different port", () => {
    expect(parseListenerRequestHost("127.0.0.1:80", listener, "127.0.0.1")).toBeUndefined();
  });
});
