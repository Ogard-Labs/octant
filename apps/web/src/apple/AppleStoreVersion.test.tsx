import type { AppleDeviceRequest, AppleDeviceResponse } from "@octant/contracts/apple-toolchain";
import type { AppleStoreVersionPreparation } from "@octant/contracts/apple-toolchain-rpc";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppleStoreVersion } from "./AppleStoreVersion";
import { useAppleStoreVersion, type UseAppleStoreVersionOptions } from "./useAppleStoreVersion";

const scope: UseAppleStoreVersionOptions["scope"] = {
  authority: {
    hostId: "64000000-0000-4000-8000-000000000001",
    mode: "code",
    projectId: "64000000-0000-4000-8000-000000000002",
    providerInstanceId: "64000000-0000-4000-8000-000000000003",
    extension: { kind: "core" },
  } as never,
  threadId: "64000000-0000-4000-8000-000000000004" as never,
  checkoutId: "64000000-0000-4000-8000-000000000005" as never,
};

const storeVersion = {
  bundleIdentifier: "sh.octant.Fixture",
  version: "1.4.0",
  buildNumber: "12",
  platform: "ios",
} as never;

let uuid = 0;
const createUuid = () => `64000000-0000-4000-8000-${String((uuid += 1)).padStart(12, "0")}`;

function released(): AppleDeviceResponse {
  return {
    kind: "apple-store-version-evidence",
    evidence: {
      actionId: "64000000-0000-4000-8000-000000000020",
      correlationId: "64000000-0000-4000-8000-000000000021",
      authority: scope.authority,
      kind: "release-version",
      requestedBy: { kind: "local-user", actorId: "64000000-0000-4000-8000-000000000022" },
      outcome: "succeeded",
      storeVersion,
      appStoreConnectId: "rel-1",
      diagnostics: [],
      durationMs: 10,
      completedAt: "2026-10-28T12:00:00.000Z",
    },
  } as never;
}

function fakeClient(prepared: AppleStoreVersionPreparation) {
  return {
    request: vi.fn(async (_request: AppleDeviceRequest) => released()),
    readScreenshot: vi.fn(),
    prepareUpload: vi.fn(),
    prepareStoreVersion: vi.fn(async () => prepared),
  };
}

function Harness(props: Omit<UseAppleStoreVersionOptions, "scope" | "createUuid">) {
  const controller = useAppleStoreVersion({ ...props, scope, createUuid });
  return controller.offered ? (
    <AppleStoreVersion
      onCarryOut={() => void controller.carryOut()}
      onCheck={() => void controller.check()}
      {...(props.projectPath === undefined ? {} : { projectPath: props.projectPath })}
      state={controller.state}
    />
  ) : (
    <p>Not offered here.</p>
  );
}

describe("AppleStoreVersion", () => {
  it("offers Release only for an approved version, and releases only with the person's answer", async () => {
    const client = fakeClient({
      kind: "prepared",
      storeVersion,
      ready: "release-version",
      state: "PENDING_DEVELOPER_RELEASE",
    } as never);
    const confirm = vi.fn(
      async (_request: AppleDeviceRequest) => "64000000-0000-4000-8000-0000000000ee",
    );
    render(
      <Harness
        client={client as never}
        projectPath="Fixture.xcodeproj"
        requestConfirmation={confirm}
      />,
    );
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: "Release…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check App Store Connect" }));
    expect(
      await screen.findByText(
        "sh.octant.Fixture 1.4.0 (12) is approved and waiting for you to release it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for App Review…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Release…" }));

    expect(
      await screen.findByText("Released sh.octant.Fixture 1.4.0 (12) to the App Store."),
    ).toBeInTheDocument();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: "release-version",
      storeVersion,
      requestedBy: { kind: "local-user" },
    });
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "release-version",
        storeVersion,
        approval: { kind: "approved", approvalId: "64000000-0000-4000-8000-0000000000ee" },
      }),
    );
  });

  it("sends nothing when the person declines, and offers no step for a version in review", async () => {
    const declined = fakeClient({
      kind: "prepared",
      storeVersion,
      ready: "submit-for-review",
      state: "PREPARE_FOR_SUBMISSION",
    } as never);
    const user = userEvent.setup();
    const { unmount } = render(
      <Harness
        client={declined as never}
        projectPath="Fixture.xcodeproj"
        requestConfirmation={async () => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Check App Store Connect" }));
    await user.click(await screen.findByRole("button", { name: "Submit for App Review…" }));
    expect(await screen.findByText("Nothing was submitted.")).toBeInTheDocument();
    expect(declined.request).not.toHaveBeenCalled();
    unmount();

    const inReview = fakeClient({
      kind: "prepared",
      storeVersion,
      ready: "neither",
      state: "WAITING_FOR_REVIEW",
    } as never);
    render(
      <Harness
        client={inReview as never}
        projectPath="Fixture.xcodeproj"
        requestConfirmation={async () => "64000000-0000-4000-8000-0000000000ef"}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Check App Store Connect" }));
    expect(await screen.findByText(/as WAITING_FOR_REVIEW/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for App Review…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Release…" })).toBeNull();
  });

  it("is not offered in a window that cannot raise the desktop confirmation", () => {
    render(
      <Harness
        client={fakeClient({ kind: "failed", message: "unused" }) as never}
        projectPath="Fixture.xcodeproj"
      />,
    );
    expect(screen.getByText("Not offered here.")).toBeInTheDocument();
  });
});
