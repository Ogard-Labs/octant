import { describe, expect, it } from "vitest";
import { SearxngEndpointRejected, validateSearxngEndpoint } from "./searxngEndpoint";

describe("validateSearxngEndpoint", () => {
  it("accepts loopback HTTP and returns a canonical trailing-slash URL", () => {
    expect(validateSearxngEndpoint("http://127.0.0.1:8080/").toString()).toBe(
      "http://127.0.0.1:8080/",
    );
    expect(validateSearxngEndpoint("http://localhost:8080").toString()).toBe(
      "http://localhost:8080/",
    );
    expect(validateSearxngEndpoint("http://[::1]:8080").toString()).toBe("http://[::1]:8080/");
  });

  it("accepts HTTPS endpoints", () => {
    expect(validateSearxngEndpoint("https://search.example.org").toString()).toBe(
      "https://search.example.org/",
    );
  });

  it("rejects non-loopback HTTP", () => {
    expect(() => validateSearxngEndpoint("http://search.example/")).toThrow(
      SearxngEndpointRejected,
    );
  });

  it("rejects credentials, query strings, and fragments", () => {
    expect(() => validateSearxngEndpoint("https://user:pass@example.com/")).toThrow(
      SearxngEndpointRejected,
    );
    expect(() => validateSearxngEndpoint("https://example.com/?q=1")).toThrow(
      SearxngEndpointRejected,
    );
    expect(() => validateSearxngEndpoint("https://example.com/#frag")).toThrow(
      SearxngEndpointRejected,
    );
  });

  it("rejects invalid URLs", () => {
    expect(() => validateSearxngEndpoint("not-a-url")).toThrow(SearxngEndpointRejected);
  });
});
