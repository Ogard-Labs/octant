import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionToolGrant } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { RememberedToolApprovalsPanel } from "./RememberedToolApprovalsPanel";

const projectA = "44000000-0000-4000-8000-0000000000a1";
const projectB = "44000000-0000-4000-8000-0000000000b2";
const extensionId = "44000000-0000-4000-8000-000000000011";
const packageId = "44000000-0000-4000-8000-000000000012";
const projectNames = new Map([
  [projectA, "Octant"],
  [projectB, "Notes"],
]);

function grant(overrides: Partial<ExtensionToolGrant>): ExtensionToolGrant {
  return {
    grantId: `sha256:${"1".repeat(64)}`,
    projectId: projectA,
    extensionId,
    packageId,
    componentId: "files-server",
    mcpToolName: "read_file",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    definitionDigest: `sha256:${"c".repeat(64)}`,
    grantedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  } as ExtensionToolGrant;
}

const grants = [
  grant({ grantId: `sha256:${"1".repeat(64)}` as never, mcpToolName: "read_file" }),
  grant({ grantId: `sha256:${"2".repeat(64)}` as never, mcpToolName: "write_file" }),
  grant({ grantId: `sha256:${"3".repeat(64)}` as never, projectId: projectB as never }),
];

function client(
  overrides: {
    readonly toolGrantsAvailable?: boolean;
    readonly grants?: ReadonlyArray<ExtensionToolGrant>;
  } = {},
): ExtensionClient {
  return {
    toolGrantsAvailable: overrides.toolGrantsAvailable ?? true,
    snapshot: vi.fn(async () => ({
      packages: [
        {
          extensionId,
          packageId,
          displayName: "Project files",
          components: [{ component: { id: "files-server", displayName: "files" } }],
        },
      ],
    })) as never,
    listToolGrants: vi.fn(async () => overrides.grants ?? grants) as never,
    revokeToolGrant: vi.fn(async () => true) as never,
  } as unknown as ExtensionClient;
}

function renderPanel(extensionClient: ExtensionClient) {
  return render(
    <RememberedToolApprovalsPanel client={extensionClient} projectNames={projectNames} />,
  );
}

describe("RememberedToolApprovalsPanel", () => {
  it("lists remembered tools under the Project they were allowed in", async () => {
    renderPanel(client());

    const octant = await screen.findByRole("group", { name: "Octant" });
    expect(within(octant).getByText("read_file")).toBeInTheDocument();
    expect(within(octant).getByText("write_file")).toBeInTheDocument();
    expect(within(octant).getAllByText(/Project files/)).toHaveLength(2);
    const notes = screen.getByRole("group", { name: "Notes" });
    expect(within(notes).getByText("read_file")).toBeInTheDocument();
    expect(within(notes).queryByText("write_file")).not.toBeInTheDocument();
    expect(screen.getAllByText(/without asking/).length).toBeGreaterThan(0);
  });

  it("says plainly that nothing is remembered yet", async () => {
    renderPanel(client({ grants: [] }));

    expect(await screen.findByText(/No remembered tool approvals/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
  });

  it("removes a row at once and tells the host to revoke it", async () => {
    const user = userEvent.setup();
    const extensionClient = client();
    renderPanel(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Revoke write_file in Octant" }));

    expect(extensionClient.revokeToolGrant).toHaveBeenCalledWith(`sha256:${"2".repeat(64)}`);
    await waitFor(() => expect(screen.queryByText("write_file")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Revoke read_file in Octant" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("write_file");
  });

  it("drops the Project's heading when its last approval is revoked", async () => {
    const user = userEvent.setup();
    renderPanel(client());

    await user.click(await screen.findByRole("button", { name: "Revoke read_file in Notes" }));

    await waitFor(() => expect(screen.queryByRole("group", { name: "Notes" })).toBeNull());
  });

  it("keeps the row and reports it when the host refuses the revoke", async () => {
    const user = userEvent.setup();
    const extensionClient = client();
    vi.mocked(extensionClient.revokeToolGrant).mockRejectedValue(new Error("refused"));
    renderPanel(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Revoke write_file in Octant" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("write_file");
    expect(screen.getByRole("alert")).toHaveTextContent("still allowed");
    expect(screen.getByRole("button", { name: "Revoke write_file in Octant" })).toBeEnabled();
  });

  it("reports a list it could not read instead of showing an empty one", async () => {
    const extensionClient = client();
    vi.mocked(extensionClient.listToolGrants).mockRejectedValue(new Error("down"));
    renderPanel(extensionClient);

    expect(await screen.findByRole("alert")).toHaveTextContent("could not load");
    expect(screen.queryByText(/No remembered tool approvals/)).not.toBeInTheDocument();
  });

  it("shows nothing to a client that is not a local window", () => {
    const extensionClient = client({ toolGrantsAvailable: false });
    const { container } = renderPanel(extensionClient);

    expect(container).toBeEmptyDOMElement();
    expect(extensionClient.listToolGrants).not.toHaveBeenCalled();
  });
});
