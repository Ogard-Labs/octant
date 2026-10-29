import { describe, expect, it, vi } from "vitest";
import { decodeHubOfferBody, type ExtensionCommand } from "@octant/contracts";
import { createProvisionHostPorts } from "./provisionHostPorts";

const entry = {
  extensionId: "review-helper",
  packageId: "review-helper",
  slug: "review-helper",
  displayName: "Review helper",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  source: { kind: "catalog", catalogId: "octant", entryId: "review-helper" },
};

function ports(execute: (command: ExtensionCommand) => Promise<unknown>) {
  return createProvisionHostPorts({
    shell: { currentRing: () => undefined, setReleaseRing: vi.fn() },
    extensions: { execute: execute as never },
    profiles: { execute: vi.fn() },
    providers: { execute: vi.fn() },
    userScopeRef: "user",
    uuid: () => "55555555-5555-4555-8555-555555555555",
  });
}

describe("what this host does for an offered plugin", () => {
  it("inspects the catalog entry and installs it, and asks for no trust and no switch", async () => {
    const sent: ExtensionCommand[] = [];
    const host = ports(async (command) => {
      sent.push(command);
      return command.kind === "inspect-package"
        ? { kind: "package-inspected", preview: { entry } }
        : { kind: "extension-state-updated", snapshot: {} };
    });
    const offer = decodeHubOfferBody({
      kind: "plugin",
      catalogId: "octant",
      entryId: "review-helper",
      expectedDigest: entry.digest,
    });
    if (offer.kind !== "plugin") throw new Error("not a plugin offer");

    expect(await host.plugin?.install(offer)).toEqual({ status: "applied" });

    expect(sent.map((command) => command.kind)).toEqual(["inspect-package", "install-package"]);
  });

  it("refuses a package whose digest is not the one the offer named", async () => {
    const sent: ExtensionCommand[] = [];
    const host = ports(async (command) => {
      sent.push(command);
      return {
        kind: "package-inspected",
        preview: { entry: { ...entry, digest: `sha256:${"b".repeat(64)}` } },
      };
    });
    const offer = decodeHubOfferBody({
      kind: "plugin",
      catalogId: "octant",
      entryId: "review-helper",
      expectedDigest: entry.digest,
    });
    if (offer.kind !== "plugin") throw new Error("not a plugin offer");

    expect(await host.plugin?.install(offer)).toEqual({ status: "failed", kind: "apply-failed" });

    expect(sent.map((command) => command.kind)).toEqual(["inspect-package"]);
  });

  it("offers no routine port, so a host without a routine builder refuses the kind", () => {
    expect(ports(async () => ({})).routine).toBeUndefined();
  });
});
