import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FIRST_PARTY_PLUGIN_CATALOG,
  firstPartyPluginsEffectiveFromSnapshot,
} from "./firstPartyPluginCatalog";
import { useHostFirstPartyPluginsEffective } from "./firstPartyPluginsEffective";

function manifest(slug: string) {
  const found = FIRST_PARTY_PLUGIN_CATALOG.find((plugin) => plugin.slug === slug);
  if (found === undefined) throw new Error(`${slug} is not in the first-party catalog.`);
  return found;
}

/** The row the host writes for a bundled plugin, switched on or off. */
function bundledRow(slug: string, desired: boolean, source = manifest(slug).source) {
  const plugin = manifest(slug);
  const activation = {
    installed: true,
    trusted: true,
    pluginDesired: desired,
    componentDesired: true,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
  return {
    extensionId: plugin.extensionId,
    packageId: plugin.packageId,
    stateVersion: 1,
    version: plugin.version,
    digest: plugin.digest,
    source,
    compatibility: plugin.compatibility,
    activation,
    components: plugin.components.map((component) => ({
      component,
      activation,
      effectiveState: desired
        ? { kind: "effective" }
        : { kind: "blocked", reason: "plugin-disabled" },
    })),
    diagnostics: [],
  };
}

function snapshotOf(...packages: ReadonlyArray<unknown>): ExtensionSnapshot {
  return { packages } as unknown as ExtensionSnapshot;
}

describe("first-party plugins read from the host snapshot", () => {
  it("turns off only the plugin the host reports switched off", () => {
    const effective = firstPartyPluginsEffectiveFromSnapshot(
      snapshotOf(bundledRow("github", false), bundledRow("board", true)),
    );
    expect(effective.get("github-integration")).toBe(false);
    expect(effective.get("board")).toBe(true);
    // No row: the host has no switch for it, so it stays on.
    expect(effective.get("linear-integration")).toBe(true);
  });

  it("keeps every plugin on before the snapshot has loaded", () => {
    const effective = firstPartyPluginsEffectiveFromSnapshot(undefined);
    expect([...effective.values()].every(Boolean)).toBe(true);
    expect(effective.get("github-integration")).toBe(true);
  });

  it("does not let an installed package that reuses a bundled plugin's id switch it off", () => {
    const effective = firstPartyPluginsEffectiveFromSnapshot(
      snapshotOf(
        bundledRow("github", false, {
          kind: "catalog",
          catalogId: "octant",
          entryId: "x",
        } as never),
      ),
    );
    expect(effective.get("github-integration")).toBe(true);
  });
});

function Harness(props: { readonly client: ExtensionClient; readonly revision: number }) {
  const effective = useHostFirstPartyPluginsEffective(props.client, props.revision);
  return <output aria-label="github">{String(effective.get("github-integration"))}</output>;
}

describe("useHostFirstPartyPluginsEffective", () => {
  it("stays on while the snapshot loads, then follows each extension change the host reports", async () => {
    let release: (snapshot: ExtensionSnapshot) => void = () => undefined;
    const snapshot = vi
      .fn<() => Promise<ExtensionSnapshot>>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValue(snapshotOf(bundledRow("github", true)));
    const client = { snapshot } as unknown as ExtensionClient;
    const view = render(<Harness client={client} revision={0} />);
    expect(screen.getByLabelText("github")).toHaveTextContent("true");

    release(snapshotOf(bundledRow("github", false)));
    await waitFor(() => expect(screen.getByLabelText("github")).toHaveTextContent("false"));

    view.rerender(<Harness client={client} revision={1} />);
    await waitFor(() => expect(screen.getByLabelText("github")).toHaveTextContent("true"));
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer when the extension service cannot be reached", async () => {
    const snapshot = vi
      .fn<() => Promise<ExtensionSnapshot>>()
      .mockResolvedValueOnce(snapshotOf(bundledRow("github", false)))
      .mockRejectedValue(new Error("unreachable"));
    const client = { snapshot } as unknown as ExtensionClient;
    const view = render(<Harness client={client} revision={0} />);
    await waitFor(() => expect(screen.getByLabelText("github")).toHaveTextContent("false"));
    view.rerender(<Harness client={client} revision={1} />);
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("github")).toHaveTextContent("false");
  });
});
