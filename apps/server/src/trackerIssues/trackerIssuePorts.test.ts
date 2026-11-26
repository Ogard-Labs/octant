import { describe, expect, it } from "vitest";
import { resolveLinearIdentifier } from "./trackerIssuePorts";

const signal = new AbortController().signal;

describe("resolveLinearIdentifier", () => {
  it("says Linear is unavailable, not that the issue is missing, when Linear is not connected", async () => {
    const disconnected = async () =>
      ({ kind: "refused", reason: "Connect Linear to authorize this host." }) as const;
    expect(await resolveLinearIdentifier(disconnected, "ENG-12", signal)).toEqual({
      status: "unavailable",
    });
    const missing = async () =>
      ({ kind: "refused", reason: "That Linear issue is not available." }) as const;
    expect(await resolveLinearIdentifier(missing, "ENG-12", signal)).toEqual({
      status: "not-found",
    });
  });
});
