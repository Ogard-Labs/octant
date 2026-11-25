import { describe, expect, it } from "vitest";
import { MAX_SECRET_STORE_BROWSE_ENTRIES } from "@octant/contracts/secret-stores";
import { onePasswordBrowseArguments, readOnePasswordBrowse } from "./onePasswordBrowse";

const vaultId = "v".repeat(26);
const itemId = "i".repeat(26);
const fields = { kind: "fields", vaultId, itemId } as const;
const item = (list: ReadonlyArray<unknown>) => JSON.stringify({ id: itemId, fields: list });

describe("listing a 1Password store", () => {
  it("passes ids alone to the tool, each as its own argument", () => {
    expect(onePasswordBrowseArguments(fields)).toEqual([
      "item",
      "get",
      itemId,
      "--vault",
      vaultId,
      "--format",
      "json",
    ]);
    for (const bad of ["--reveal", "../x", "short", `${vaultId}x`])
      expect(onePasswordBrowseArguments({ kind: "items", vaultId: bad })).toBeUndefined();
  });

  it("returns an item's field names and addresses, and nothing a field holds", () => {
    const result = readOnePasswordBrowse(
      fields,
      item([
        { id: "username", label: "username", type: "STRING", value: "private-user" },
        { id: "credential", label: "API key", type: "CONCEALED", value: "private-value" },
        {
          id: "f1",
          label: "token",
          type: "CONCEALED",
          value: "private-section",
          section: { id: "Section_1", label: "Deploy" },
        },
        { id: "empty", label: "empty", type: "CONCEALED" },
        { id: "totp", label: "one-time password", type: "OTP", value: "otpauth://private" },
        { id: "bad/id", label: "odd", type: "STRING", value: "private-odd" },
      ]),
    );
    expect(result).toEqual({
      status: "listed",
      truncated: false,
      entries: [
        { id: "username", label: "username", reference: `op://${vaultId}/${itemId}/username` },
        { id: "credential", label: "API key", reference: `op://${vaultId}/${itemId}/credential` },
        {
          id: "Section_1/f1",
          label: "Deploy · token",
          reference: `op://${vaultId}/${itemId}/Section_1/f1`,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reads only a name from a vault or an item", () => {
    expect(
      readOnePasswordBrowse(
        { kind: "items", vaultId },
        JSON.stringify([
          { id: itemId, title: "De\u0007ploy", additional_information: "private-user" },
          { id: "not-an-id", title: "Other" },
          { id: itemId, title: " " },
        ]),
      ),
    ).toEqual({ status: "listed", truncated: false, entries: [{ id: itemId, label: "Deploy" }] });
    expect(readOnePasswordBrowse({ kind: "vaults" }, "")).toEqual({
      status: "listed",
      truncated: false,
      entries: [],
    });
  });

  it("says when more were there, and refuses output it cannot read", () => {
    const many = Array.from({ length: MAX_SECRET_STORE_BROWSE_ENTRIES + 1 }, () => ({
      id: vaultId,
      name: "Vault",
    }));
    expect(readOnePasswordBrowse({ kind: "vaults" }, JSON.stringify(many))).toMatchObject({
      truncated: true,
    });
    for (const output of ["{", "{}", '"x"', "null", "x".repeat(3 * 1024 * 1024)])
      expect(readOnePasswordBrowse({ kind: "vaults" }, output)).toEqual({ status: "unavailable" });
    expect(readOnePasswordBrowse(fields, JSON.stringify({ id: vaultId, fields: [] }))).toEqual({
      status: "unavailable",
    });
  });
});
