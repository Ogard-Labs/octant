import type { AppleDeviceClient } from "@octant/client-runtime/apple-device-client";
import type { AppleDeviceRequest, AppleDeviceResponse } from "@octant/contracts/apple-toolchain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppleUpload } from "./AppleUpload";
import { useAppleUpload, type UseAppleUploadOptions } from "./useAppleUpload";

const scope = {
  authority: {
    hostId: "63000000-0000-4000-8000-000000000001",
    mode: "code",
    projectId: "63000000-0000-4000-8000-000000000002",
    providerInstanceId: "63000000-0000-4000-8000-000000000003",
    extension: { kind: "core" },
  },
  threadId: "63000000-0000-4000-8000-000000000004",
  checkoutId: "63000000-0000-4000-8000-000000000005",
} as unknown as UseAppleUploadOptions["scope"];

const build = {
  bundleIdentifier: "sh.octant.Fixture",
  version: "1.4.0",
  buildNumber: "12",
  signing: { teamId: "A1B2C3D4E5", identity: "3".repeat(40) },
  profileId: "63000000-0000-4000-8000-0000000000aa",
} as never;

let uuid = 0;
const createUuid = () => `63000000-0000-4000-8000-${String((uuid += 1)).padStart(12, "0")}`;

function uploaded(): AppleDeviceResponse {
  return {
    kind: "apple-upload-evidence",
    evidence: {
      actionId: "63000000-0000-4000-8000-000000000020",
      correlationId: "63000000-0000-4000-8000-000000000021",
      authority: scope.authority,
      kind: "upload",
      requestedBy: { kind: "local-user", actorId: "63000000-0000-4000-8000-000000000022" },
      outcome: "succeeded",
      upload: build,
      deliveryId: "63000000-0000-4000-8000-0000000000dd",
      diagnostics: [],
      artifacts: [],
      cleanup: "complete",
      durationMs: 10,
      completedAt: "2026-10-28T12:00:00.000Z",
    },
  } as unknown as AppleDeviceResponse;
}

function fakeClient(prepared: Awaited<ReturnType<AppleDeviceClient["prepareUpload"]>>) {
  const client = {
    request: vi.fn(async (_request: AppleDeviceRequest) => uploaded()),
    readScreenshot: vi.fn(),
    prepareUpload: vi.fn(async () => prepared),
  };
  return client;
}

function Harness(
  props: Omit<UseAppleUploadOptions, "team" | "scope" | "createUuid"> & {
    readonly initialTeam?: string;
  },
) {
  const [team, setTeam] = useState(props.initialTeam ?? "A1B2C3D4E5");
  const upload = useAppleUpload({ ...props, scope, createUuid, team });
  return upload.offered ? (
    <AppleUpload
      onTeamChange={setTeam}
      onUpload={() => void upload.upload()}
      {...(props.projectPath === undefined ? {} : { projectPath: props.projectPath })}
      ready={upload.ready}
      state={upload.state}
      team={team}
    />
  ) : (
    <p>No upload here.</p>
  );
}

const button = () => screen.getByRole("button", { name: "Upload to App Store Connect…" });

describe("AppleUpload", () => {
  it("reads the build, asks the person to confirm exactly it, and uploads only with their answer", async () => {
    const client = fakeClient({ kind: "prepared", upload: build });
    const confirm = vi.fn(
      async (_request: AppleDeviceRequest) => "63000000-0000-4000-8000-0000000000ee",
    );
    render(
      <Harness
        client={client as unknown as AppleDeviceClient}
        projectPath="Fixture.xcodeproj"
        requestConfirmation={confirm}
        scheme="Fixture"
      />,
    );
    await userEvent.setup().click(button());

    expect(
      await screen.findByText(
        "Uploaded sh.octant.Fixture 1.4.0 (12). App Store Connect delivery 63000000-0000-4000-8000-0000000000dd.",
      ),
    ).toBeInTheDocument();
    expect(client.prepareUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "apple-upload-preparation",
        projectPath: "Fixture.xcodeproj",
        scheme: "Fixture",
        teamId: "A1B2C3D4E5",
      }),
    );
    // The confirmation and the upload carry the build the host read, and the
    // upload carries the person's answer.
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: "upload",
      upload: build,
      requestedBy: { kind: "local-user" },
      approval: { kind: "not-required" },
    });
    expect(client.request.mock.calls[0]?.[0]).toMatchObject({
      kind: "upload",
      upload: build,
      approval: { kind: "approved", approvalId: "63000000-0000-4000-8000-0000000000ee" },
    });
  });

  it("uploads nothing when the person declines", async () => {
    const client = fakeClient({ kind: "prepared", upload: build });
    render(
      <Harness
        client={client as unknown as AppleDeviceClient}
        projectPath="Fixture.xcodeproj"
        requestConfirmation={vi.fn(async () => undefined)}
      />,
    );
    await userEvent.setup().click(button());
    expect(await screen.findByText("Nothing was uploaded.")).toBeInTheDocument();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("shows the step Xcode needs and asks nobody when the build cannot be read", async () => {
    const client = fakeClient({ kind: "failed", message: "No App Store profile covers this app." });
    const confirm = vi.fn(async () => "approval");
    render(
      <Harness
        client={client as unknown as AppleDeviceClient}
        projectPath="Fixture.xcodeproj"
        requestConfirmation={confirm}
      />,
    );
    await userEvent.setup().click(button());
    expect(await screen.findByText("No App Store profile covers this app.")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("waits for a Team ID and a project before it offers the upload", async () => {
    const client = fakeClient({ kind: "prepared", upload: build });
    const { rerender } = render(
      <Harness
        client={client as unknown as AppleDeviceClient}
        initialTeam=""
        projectPath="Fixture.xcodeproj"
        requestConfirmation={vi.fn(async () => undefined)}
      />,
    );
    expect(button()).toBeDisabled();
    await userEvent.setup().type(screen.getByLabelText("Team ID"), "a1b2c3d4e5");
    await waitFor(() => expect(button()).toBeEnabled());
    rerender(
      <Harness
        client={client as unknown as AppleDeviceClient}
        requestConfirmation={vi.fn(async () => undefined)}
      />,
    );
    expect(button()).toBeDisabled();
  });

  it("is not offered in a window that cannot raise the desktop confirmation", () => {
    render(
      <Harness
        client={fakeClient({ kind: "prepared", upload: build }) as unknown as AppleDeviceClient}
        projectPath="Fixture.xcodeproj"
      />,
    );
    expect(screen.queryByRole("button", { name: "Upload to App Store Connect…" })).toBeNull();
  });
});
