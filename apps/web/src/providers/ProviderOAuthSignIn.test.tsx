import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderOAuthSignIn, ProviderOAuthSignInPanel } from "./ProviderOAuthSignIn";

const handlers = () => ({
  onAcknowledge: vi.fn(),
  onSignIn: vi.fn(),
  onUseApiKey: vi.fn(),
  onSignOut: vi.fn(),
});

describe("provider sign-in", () => {
  it("shows Sign in beside Use an API key and asks for terms before starting", async () => {
    const user = userEvent.setup();
    const props = handlers();
    render(
      <ProviderOAuthSignIn
        {...props}
        accountLabel="Fixture account"
        state={{ kind: "signed-out" }}
        termsRequired
        termsSummary="Acknowledge the terms before this sign-in continues."
      />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use an API key" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Acknowledge and continue" }));
    expect(props.onAcknowledge).toHaveBeenCalledOnce();
    expect(props.onSignIn).not.toHaveBeenCalled();
  });

  it("shows the consent step without a token", () => {
    render(
      <ProviderOAuthSignIn
        {...handlers()}
        accountLabel="Fixture account"
        state={{
          kind: "awaiting-consent",
          detail: "Enter the one-time code at the verification page.",
        }}
        termsRequired={false}
        termsSummary="Terms"
      />,
    );
    expect(
      screen.getByText("Enter the one-time code at the verification page."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it("shows the signed-in account label and Sign out", async () => {
    const user = userEvent.setup();
    const props = handlers();
    render(
      <ProviderOAuthSignIn
        {...props}
        accountLabel="Fixture account"
        state={{ kind: "signed-in", accountLabel: "Fixture account" }}
        termsRequired={false}
        termsSummary="Terms"
      />,
    );
    expect(screen.getByText("Fixture account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use an API key" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(props.onSignOut).toHaveBeenCalledOnce();
  });

  it("asks to sign in again when the grant is expired and shows a refusal without a secret", () => {
    const { rerender } = render(
      <ProviderOAuthSignIn
        {...handlers()}
        accountLabel="Fixture account"
        state={{ kind: "expired" }}
        termsRequired={false}
        termsSummary="Terms"
      />,
    );
    expect(screen.getByText("Sign in again to use this provider.")).toBeInTheDocument();
    rerender(
      <ProviderOAuthSignIn
        {...handlers()}
        accountLabel="Fixture account"
        state={{ kind: "refused", message: "Sign-in was refused." }}
        termsRequired={false}
        termsSummary="Terms"
      />,
    );
    expect(screen.getByText("Sign-in was refused.")).toBeInTheDocument();
  });
});

describe("provider sign-in panel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the consent URL once while polling awaiting-consent", async () => {
    vi.useFakeTimers();
    const openUrl = vi.fn();
    const run = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "status") return { kind: "signed-out" as const, termsRequired: false };
      return {
        kind: "awaiting-consent" as const,
        attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        authorizationUrl: "http://127.0.0.1/consent",
      };
    });
    render(
      <ProviderOAuthSignInPanel
        accountLabel="Fixture account"
        descriptorId="fixture-oauth"
        instanceId="00000000-0000-4000-8000-000000000901"
        onUseApiKey={() => undefined}
        openUrl={openUrl}
        run={run}
        termsSummary="Terms"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1/consent");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(openUrl).toHaveBeenCalledOnce();
    expect(run.mock.calls.some((call) => call[0].kind === "poll")).toBe(true);
  });
});
