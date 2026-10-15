import { describe, expect, it } from "vitest";
import {
  buildPairingCode,
  PAIRING_CODE_PREFIX,
  PAIRING_CODE_REFUSAL_COPY,
  readPairingCode,
  type PairingCodeContents,
} from "./remotePairingCode";

const contents: PairingCodeContents = {
  origin: "https://100.101.102.103:8443",
  ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
  ticketProof: Buffer.alloc(32, 7).toString("base64url"),
  pin: `sha256-${Buffer.alloc(32, 9).toString("base64url")}`,
};

function codeOf(value: PairingCodeContents): string {
  const built = buildPairingCode(value);
  if (built.status !== "built") throw new Error(`refused: ${built.reason}`);
  return built.code;
}

/** A code with the right prefix around any JSON text, for shapes the builder never makes. */
function rawCode(json: string, prefix = PAIRING_CODE_PREFIX): string {
  return `${prefix}${Buffer.from(json, "utf8").toString("base64url")}`;
}

describe("the app pairing code", () => {
  it("reads back exactly what the host put in it", () => {
    const code = codeOf(contents);
    expect(code.startsWith("octant-pair-1.")).toBe(true);
    expect(code).toMatch(/^octant-pair-1\.[A-Za-z0-9_-]+$/);
    expect(readPairingCode(code)).toEqual({ status: "read", contents });
    // Pasted text often carries a trailing newline or leading spaces.
    expect(readPairingCode(`  ${code}\n`)).toEqual({ status: "read", contents });
  });

  it("carries only the origin, ticket, proof, and pin, never key material", () => {
    const payload = codeOf(contents).slice(PAIRING_CODE_PREFIX.length);
    const json = Buffer.from(payload, "base64url").toString("utf8");
    expect(JSON.parse(json)).toEqual({
      origin: contents.origin,
      ticketId: contents.ticketId,
      ticketProof: contents.ticketProof,
      pin: contents.pin,
    });
    expect(json).not.toMatch(/PRIVATE|BEGIN|KEY/i);
  });

  it("builds the same code for a bracketed IPv6 and a Tailscale name", () => {
    for (const origin of ["https://[fd7a:115c:a1e0::1]:8443", "https://mac.tailnet.ts.net"]) {
      expect(readPairingCode(codeOf({ ...contents, origin }))).toEqual({
        status: "read",
        contents: { ...contents, origin },
      });
    }
  });

  it("refuses a later code version as needing a newer Octant, and anything else as not a code", () => {
    const payload = codeOf(contents).slice(PAIRING_CODE_PREFIX.length);
    expect(readPairingCode(`octant-pair-2.${payload}`)).toEqual({
      status: "refused",
      reason: "newer-version",
    });
    for (const text of [
      `octant-pair-0.${payload}`,
      `octant-pair-01.${payload}`,
      `octant-pair-v1.${payload}`,
      `octant://pair/${payload}`,
      `https://100.101.102.103:8443/#${payload}`,
      payload,
      "",
      `${codeOf(contents)}${"A".repeat(1_024)}`,
    ]) {
      expect(readPairingCode(text)).toEqual({ status: "refused", reason: "not-a-pairing-code" });
    }
    expect(PAIRING_CODE_REFUSAL_COPY["newer-version"]).toBe(
      "This pairing code needs a newer version of Octant.",
    );
  });

  it("refuses a pin algorithm it does not know instead of skipping the check", () => {
    const pin = `sha512-${Buffer.alloc(64, 9).toString("base64url")}`;
    expect(readPairingCode(rawCode(JSON.stringify({ ...contents, pin })))).toEqual({
      status: "refused",
      reason: "newer-version",
    });
    expect(buildPairingCode({ ...contents, pin })).toEqual({
      status: "refused",
      reason: "newer-version",
    });
  });

  it("refuses a code with a missing, extra, repeated, or malformed field", () => {
    const { pin: _pin, ...withoutPin } = contents;
    const cases = [
      JSON.stringify(withoutPin),
      JSON.stringify({ ...contents, pin: "" }),
      JSON.stringify({ ...contents, pin: Buffer.alloc(32, 9).toString("base64url") }),
      JSON.stringify({ ...contents, pin: `sha256-${Buffer.alloc(31, 9).toString("base64url")}` }),
      JSON.stringify({ ...contents, privateKeyPem: "-----BEGIN PRIVATE KEY-----" }),
      JSON.stringify({ ...contents, sourceClass: "tailscale" }),
      JSON.stringify({ ...contents, ticketId: contents.ticketId.toUpperCase() }),
      JSON.stringify({ ...contents, ticketProof: "short" }),
      JSON.stringify({ ...contents, ticketId: 7 }),
      JSON.stringify([contents]),
      JSON.stringify(contents, null, 1),
      // A repeated key parses as its last value; the code still is not the canonical one.
      JSON.stringify(contents).replace("{", `{"pin":"sha256-x",`),
      "not json",
    ];
    for (const json of cases) {
      expect(readPairingCode(rawCode(json))).toEqual({ status: "refused", reason: "damaged" });
    }
  });

  it("refuses a padded or non-canonical base64url spelling of a valid code", () => {
    // Pick a port whose JSON length leaves spare bits in the final character.
    const code =
      ["https://100.101.102.103:8443", "https://100.101.102.103:844", "https://100.101.102.103:84"]
        .map((origin) => codeOf({ ...contents, origin }))
        .find((candidate) => (candidate.length - PAIRING_CODE_PREFIX.length) % 4 !== 0) ?? "";
    const last = code.at(-1) ?? "";
    // The final character carries spare bits; setting one decodes to the same
    // bytes but is not the code the host made.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = `${code.slice(0, -1)}${alphabet.charAt(alphabet.indexOf(last) + 1)}`;
    expect(Buffer.from(twin.slice(PAIRING_CODE_PREFIX.length), "base64url")).toEqual(
      Buffer.from(code.slice(PAIRING_CODE_PREFIX.length), "base64url"),
    );
    expect(readPairingCode(twin)).toEqual({ status: "refused", reason: "damaged" });
    expect(readPairingCode(`${code}=`)).toEqual({ status: "refused", reason: "damaged" });
    expect(readPairingCode(`${code.slice(0, 20)} ${code.slice(20)}`)).toEqual({
      status: "refused",
      reason: "damaged",
    });
  });

  it("refuses an origin that is not exactly a private HTTPS listener origin", () => {
    for (const origin of [
      "https://example.com:8443",
      "https://8.8.8.8:8443",
      "https://127.0.0.1:8443",
      "https://localhost:8443",
    ]) {
      expect(buildPairingCode({ ...contents, origin })).toEqual({
        status: "refused",
        reason: "not-private",
      });
      expect(readPairingCode(rawCode(JSON.stringify({ ...contents, origin })))).toEqual({
        status: "refused",
        reason: "not-private",
      });
    }
    for (const origin of [
      "http://100.101.102.103:8443",
      "https://100.101.102.103:8443/",
      "https://100.101.102.103:8443/pair",
      "https://user@100.101.102.103:8443",
      "https://100.101.102.103:443",
      "100.101.102.103:8443",
    ]) {
      expect(buildPairingCode({ ...contents, origin })).toEqual({
        status: "refused",
        reason: "damaged",
      });
    }
  });
});
