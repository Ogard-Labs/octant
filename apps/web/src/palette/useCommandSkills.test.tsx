import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCommandSkills } from "./useCommandSkills";

function skillRecord(name: string, effective: boolean) {
  return {
    skill: { qualifiedId: `skill:${name}`, name, available: true, digest: `sha256:${name}` },
    displayName: name,
    effectiveState: { kind: effective ? "effective" : "disabled" },
  };
}

function stubClient(snapshot: ExtensionClient["snapshot"]): ExtensionClient {
  return { snapshot } as unknown as ExtensionClient;
}

function Harness(props: { readonly client: ExtensionClient }) {
  const skills = useCommandSkills(props.client, { refreshMs: 10 });
  return <output aria-label="skills">{skills.map((skill) => skill.displayName).join(",")}</output>;
}

describe("useCommandSkills", () => {
  it("offers a skill enabled after mount without an app reload", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ skills: [skillRecord("Writing review", false)] })
      .mockResolvedValue({ skills: [skillRecord("Writing review", true)] });
    render(<Harness client={stubClient(snapshot as never)} />);
    await waitFor(() => expect(snapshot).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByLabelText("skills")).toHaveTextContent("Writing review"),
    );
  });

  it("stops offering a skill that was disabled after mount", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ skills: [skillRecord("Writing review", true)] })
      .mockResolvedValue({ skills: [skillRecord("Writing review", false)] });
    render(<Harness client={stubClient(snapshot as never)} />);
    await waitFor(() =>
      expect(screen.getByLabelText("skills")).toHaveTextContent("Writing review"),
    );

    // A disabled skill offered here is a row the host will refuse later.
    await waitFor(() => expect(screen.getByLabelText("skills")).toBeEmptyDOMElement());
  });
});
