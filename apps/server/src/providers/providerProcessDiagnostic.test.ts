import { describe, expect, it } from "vitest";
import { classifyProviderStderr } from "./providerProcessDiagnostic";

describe("provider stderr classification", () => {
  it("reads a TLS or certificate failure as a trust failure", () => {
    expect(classifyProviderStderr("Error: TLS handshake failed")).toBe(
      "Provider TLS trust verification failed.",
    );
    expect(classifyProviderStderr("unable to verify the first certificate")).toBe(
      "Provider TLS trust verification failed.",
    );
  });

  // A random server password printed to stderr contained "tls" by chance and
  // was reported as a trust failure.
  it("does not read letters inside a token as a TLS failure", () => {
    expect(classifyProviderStderr("password=q8TlsZ0vYk3_hTLSa2")).toBe(
      "Provider process wrote redacted diagnostic output.",
    );
  });
});
