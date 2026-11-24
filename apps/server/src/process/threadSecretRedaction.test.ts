import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@octant/contracts";
import { redactProviderRuntimeEvent } from "../providers/secretRedactingDriver";
import {
  holdSecretValue,
  noteIssuedSecret,
  redactHostSecrets,
  redactHostSecretsInValue,
} from "./secretRedaction";

const releases: Array<() => void> = [];
const hold = (value: string) => {
  const release = holdSecretValue(value);
  releases.push(release);
  return release;
};
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

describe("a value a person gave a thread", () => {
  it("is removed from text while it is held and left alone afterwards", () => {
    const release = hold("s3cret-Value");
    expect(redactHostSecrets("token=s3cret-Value;")).toBe("token=[redacted secret];");
    release();
    expect(redactHostSecrets("token=s3cret-Value;")).toBe("token=s3cret-Value;");
  });

  it("stays removed while another thread still holds the same value", () => {
    const first = hold("s3cret-Value");
    hold("s3cret-Value");
    first();
    first();
    expect(redactHostSecrets("s3cret-Value")).toBe("[redacted secret]");
  });

  it.each([0, 1, 2])("is removed from base64 after %i other bytes", (alignment) => {
    hold("s3cret-Value?~");
    const encoded = Buffer.from(`${"u".repeat(alignment)}s3cret-Value?~`).toString("base64");
    const url = Buffer.from(`${"u".repeat(alignment)}s3cret-Value?~`).toString("base64url");
    expect(redactHostSecrets(encoded)).toContain("[redacted secret]");
    expect(redactHostSecrets(url)).toContain("[redacted secret]");
  });

  it("is removed from basic authentication built around it", () => {
    hold("s3cret-Value");
    const header = Buffer.from("person@example.com:s3cret-Value").toString("base64");
    expect(redactHostSecrets(header)).toContain("[redacted secret]");
  });

  it("is removed from a URL and from JSON", () => {
    hold('a b/c"d\\e');
    expect(redactHostSecrets("?p=a%20b%2Fc%22d%5Ce")).toBe("?p=[redacted secret]");
    expect(redactHostSecrets("?p=a+b%2Fc%22d%5Ce")).toBe("?p=[redacted secret]");
    expect(redactHostSecrets('{"p":"a b/c\\"d\\\\e"}')).toBe('{"p":"[redacted secret]"}');
  });

  it("is removed when a command prints it without its outer spaces or one line at a time", () => {
    hold("  spaced pass  ");
    hold("line-one-of-a-long-key\nline-two-of-a-long-key");
    expect(redactHostSecrets("spaced pass")).toBe("[redacted secret]");
    expect(redactHostSecrets("> line-two-of-a-long-key")).toBe("> [redacted secret]");
  });

  it("takes a value that is not well-formed text", () => {
    expect(() => hold("broken-\ud800-value")).not.toThrow();
  });

  it("is removed at every depth and from keys, and leaves what says which event this is", () => {
    hold("correct-horse-battery");
    expect(
      redactHostSecretsInValue({
        input: { status: "correct-horse-battery", deep: [{ type: "correct-horse-battery" }] },
        "correct-horse-battery": 1,
      }),
    ).toEqual({
      input: { status: "[redacted secret]", deep: [{ type: "[redacted secret]" }] },
      "[redacted secret]": 1,
    });
    hold("tool-failure");
    expect(
      redactProviderRuntimeEvent({
        kind: "tool-failure",
        message: "tool-failure",
      } as unknown as ProviderRuntimeEvent),
    ).toEqual({ kind: "tool-failure", message: "[redacted secret]" });
  });

  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  const pem = (middle: string) =>
    `-----BEGIN PRIVATE KEY-----\n${middle}\n-----END PRIVATE KEY-----`;

  it("does not stop another private key from being removed whole", () => {
    hold(pem(body));
    expect(redactHostSecrets(pem("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo="))).toBe(
      "[redacted secret]",
    );
  });

  it("is removed whole where one occurrence begins inside another", () => {
    hold("abcXYZab");
    expect(redactHostSecrets("<abcXYZabcXYZab>")).toBe("<[redacted secret]>");
  });

  it("does not leave the rest of a longer secret it begins", () => {
    hold("ghp_abcd");
    noteIssuedSecret("issued-value-and-more");
    hold("issued-value");
    expect(redactHostSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted secret]");
    expect(redactHostSecrets("issued-value-and-more")).toBe("[redacted secret]");
  });

  it("is removed when a command prints a passphrase of plain words and nothing else", () => {
    hold("correct-horse-battery");
    expect(redactHostSecretsInValue({ stdout: "correct-horse-battery" })).toEqual({
      stdout: "[redacted secret]",
    });
    expect(redactHostSecretsInValue(["correct-horse-battery"])).toEqual(["[redacted secret]"]);
  });

  it("leaves ordinary text alone for a value too short or too plain to replace", () => {
    hold("abc");
    hold("main");
    hold("failed");
    hold("123456");
    expect(redactHostSecrets("abc failed on main 123456")).toBe("abc failed on main 123456");
  });

  it("is removed when it is short but mixes letters with digits or symbols", () => {
    hold("h4!unt");
    expect(redactHostSecrets("password: h4!unt")).toBe("password: [redacted secret]");
  });

  it.each(["redacted", "secret] ", "[redacted"])(
    "does not grow the text when %j is part of the replacement itself",
    (value) => {
      hold(value);
      const once = redactHostSecrets("[redacted secret]");
      expect(once).toBe("[redacted secret]");
      expect(redactHostSecrets(once)).toBe(once);
    },
  );
});
