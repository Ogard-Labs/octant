import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceCodeSignIn } from "./DeviceCodeSignIn";

const instanceId = "71000000-0000-4000-8000-000000000001";
const attemptId = "71000000-0000-4000-8000-000000000002";

type Answer = { readonly status: number; readonly body: unknown };

function panel(request: ((request: unknown) => Promise<Answer>) | undefined) {
  const onSignedIn = vi.fn();
  render(
    <DeviceCodeSignIn
      disabled={false}
      instanceId={instanceId}
      instanceName="Contoso Bedrock"
      onSignedIn={onSignedIn}
      {...(request === undefined ? {} : { request })}
    />,
  );
  return { onSignedIn };
}

const awaitingCode = {
  outcome: "awaiting-code",
  attemptId,
  verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
  userCode: "WXYZ-1234",
  expiresAt: "2026-11-12T12:15:00.000Z",
};

describe("sign-in with a code in a local desktop window", () => {
  afterEach(() => vi.useRealTimers());

  it("offers nothing where the window cannot reach the host-local sign-in", () => {
    // A paired device and a remote browser have no desktop bridge.
    panel(undefined);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/code/i)).toBeNull();
  });

  it("shows the terms, then the code and its page, and reports the sign-in once the host has it", async () => {
    vi.useFakeTimers();
    const answers: Array<Answer> = [
      {
        status: 200,
        body: { outcome: "terms-required", termsSummary: "The fixture terms apply." },
      },
      { status: 200, body: awaitingCode },
      { status: 200, body: { outcome: "waiting" } },
      { status: 200, body: { outcome: "signed-in", accountLabel: "BedrockUser" } },
    ];
    const request = vi.fn(async (_request: unknown) => {
      const next = answers.shift();
      if (next === undefined) throw new Error("no further answer expected");
      return next;
    });
    const { onSignedIn } = panel(request);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a code for Contoso Bedrock" }),
    );
    await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({
      kind: "begin",
      instance: instanceId,
      acknowledgeTerms: false,
    });
    expect(screen.getByText(/The fixture terms apply\./)).toBeVisible();
    // No code is shown before the person accepts the terms.
    expect(screen.queryByText("WXYZ-1234")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Agree and show the code" }));
    await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({
      kind: "begin",
      instance: instanceId,
      acknowledgeTerms: true,
    });
    expect(screen.getByText("WXYZ-1234")).toBeVisible();
    expect(screen.getByText("https://device.sso.us-east-1.amazonaws.com/")).toBeVisible();
    expect(screen.getByText(/Never enter a sign-in code someone sent you/)).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(request).toHaveBeenLastCalledWith({ kind: "poll", instance: instanceId, attemptId });
    expect(onSignedIn).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(screen.queryByText("WXYZ-1234")).toBeNull();
  });

  it("says why the host refused, and shows no code", async () => {
    const request = vi.fn(async () => ({
      status: 409,
      body: {
        category: "device-code-not-enabled",
        message: "That provider does not allow signing in with a device code.",
      },
    }));
    panel(request);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a code for Contoso Bedrock" }),
    );
    await act(async () => {});
    expect(
      screen.getByText("That provider does not allow signing in with a device code."),
    ).toBeVisible();
    expect(request).toHaveBeenCalledOnce();
  });

  it("refuses to show a code whose page is not an https address", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: { ...awaitingCode, verificationUri: "http://device.example.test/" },
    }));
    panel(request);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with a code for Contoso Bedrock" }),
    );
    await act(async () => {});
    expect(screen.queryByText("WXYZ-1234")).toBeNull();
    expect(screen.getByText(/couldn't start the sign-in/i)).toBeVisible();
  });
});
