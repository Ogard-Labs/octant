import { describe, expect, it } from "vitest";
import { decodeSecretStoresCommand, decodeSecretStoresResult } from "./secretStores";
const selected = {
  store: "onepassword",
  reference: "op://Private/Cloud account/credential",
  serviceAccountEmail: "commands@example.iam.gserviceaccount.com",
  scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
};
describe("explicit Google command-line account consent", () => {
  it("accepts only confirmed public account/scopes references, never signing or token material", () => {
    expect(
      decodeSecretStoresCommand({ kind: "point-google-cli-account", confirmed: true, ...selected }),
    ).toEqual({ kind: "point-google-cli-account", confirmed: true, ...selected });
    expect(
      decodeSecretStoresResult({
        kind: "secret-stores-google-cli-account",
        reference: selected,
        sessionExpiresAt: "2026-11-02T23:00:00.000Z",
      }),
    ).toMatchObject({ reference: selected });
    for (const value of [
      {},
      { confirmed: false },
      { private_key: "secret" },
      { accessToken: "secret" },
      { token_uri: "https://untrusted.invalid" },
      { sub: "delegate@example.com" },
    ]) {
      const { confirmed: _confirmed, ...unconfirmed } = {
        kind: "point-google-cli-account",
        confirmed: true,
        ...selected,
      };
      expect(() =>
        decodeSecretStoresCommand(
          Object.keys(value).length === 0
            ? unconfirmed
            : { ...unconfirmed, confirmed: true, ...value },
        ),
      ).toThrow();
    }
  });
  it.each([
    [],
    ["openid"],
    [
      "https://www.googleapis.com/auth/cloud-platform.read-only",
      "https://www.googleapis.com/auth/cloud-platform.read-only",
    ],
  ])("refuses empty, unrelated or repeated scope selection %j", (scopes) => {
    expect(() =>
      decodeSecretStoresCommand({
        kind: "point-google-cli-account",
        confirmed: true,
        ...selected,
        scopes,
      }),
    ).toThrow();
  });
});
