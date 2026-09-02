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

function Harness(props: { readonly client: ExtensionClient; readonly refreshMs?: number }) {
  const skills = useCommandSkills(props.client, { refreshMs: props.refreshMs ?? 10 });
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

  it("loads change-driven skills when a hidden document becomes visible", async () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      const snapshot = vi.fn(async () => ({ skills: [skillRecord("Writing review", true)] }));
      render(<Harness client={stubClient(snapshot as never)} refreshMs={0} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(snapshot).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));

      await waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
      expect(screen.getByLabelText("skills")).toHaveTextContent("Writing review");
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: originalVisibility,
      });
    }
  });
});
