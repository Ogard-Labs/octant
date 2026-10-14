import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCommandExtensions, useCommandSkills } from "./useCommandSkills";

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
      .mockResolvedValueOnce({ packages: [], skills: [skillRecord("Writing review", false)] })
      .mockResolvedValue({ packages: [], skills: [skillRecord("Writing review", true)] });
    render(<Harness client={stubClient(snapshot as never)} />);
    await waitFor(() => expect(snapshot).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByLabelText("skills")).toHaveTextContent("Writing review"),
    );
  });

  it("stops offering a skill that was disabled after mount", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ packages: [], skills: [skillRecord("Writing review", true)] })
      .mockResolvedValue({ packages: [], skills: [skillRecord("Writing review", false)] });
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
      const snapshot = vi.fn(async () => ({
        packages: [],
        skills: [skillRecord("Writing review", true)],
      }));
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

  it("offers an enabled plugin MCP server by its exact plugin and component", async () => {
    const snapshot = vi.fn(async () => ({
      skills: [],
      packages: [
        {
          slug: "notes-plugin",
          displayName: "Notes",
          components: [
            {
              component: { id: "mcp-notes", kind: "mcp-server", displayName: "notes" },
              effectiveState: { kind: "effective" },
            },
            {
              component: { id: "mcp-off", kind: "mcp-server", displayName: "off" },
              effectiveState: { kind: "blocked", reason: "component-disabled" },
            },
          ],
        },
      ],
    }));
    function Servers() {
      const { pluginServers } = useCommandExtensions(stubClient(snapshot as never), {
        refreshMs: 10,
      });
      return (
        <output aria-label="servers">
          {pluginServers.map((server) => `${server.reference}|${server.pluginName}`).join(",")}
        </output>
      );
    }
    render(<Servers />);

    await waitFor(() =>
      expect(screen.getByLabelText("servers")).toHaveTextContent("@notes-plugin/mcp-notes|Notes"),
    );
    expect(screen.getByLabelText("servers")).not.toHaveTextContent("mcp-off");
  });

  it("offers a Project-root skill only from its own Project, never from another or from Chat", async () => {
    const projectA = "71000000-0000-4000-8000-000000000001";
    const projectB = "71000000-0000-4000-8000-000000000002";
    const snapshot = vi.fn(async () => ({
      packages: [],
      skills: [
        {
          ...skillRecord("Alpha notes", true),
          projectScope: { mode: "code", projectId: projectA },
        },
        skillRecord("Shared notes", true),
      ],
    }));
    function Scoped(props: { readonly mode: "chat" | "code"; readonly projectId: string | null }) {
      const { skills } = useCommandExtensions(stubClient(snapshot as never), {
        refreshMs: 10,
        audience: { mode: props.mode, projectId: props.projectId, threadId: null },
      });
      return (
        <output aria-label="skills">{skills.map((skill) => skill.displayName).join(",")}</output>
      );
    }
    const { rerender } = render(<Scoped mode="code" projectId={projectA} />);
    await waitFor(() =>
      expect(screen.getByLabelText("skills")).toHaveTextContent("Alpha notes,Shared notes"),
    );

    rerender(<Scoped mode="code" projectId={projectB} />);
    expect(screen.getByLabelText("skills")).toHaveTextContent(/^Shared notes$/);
    rerender(<Scoped mode="chat" projectId={null} />);
    expect(screen.getByLabelText("skills")).toHaveTextContent(/^Shared notes$/);
  });
});
