import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderOAuthSignIn, ProviderOAuthSignInPanel } from "./ProviderOAuthSignIn";

const handlers = () => ({
  onSignIn: vi.fn(),
  onUseApiKey: vi.fn(),
  onSignOut: vi.fn(),
  onSignOutLocally: vi.fn(),
});

describe("provider sign-in", () => {
  it("carries the terms as one consent line under Sign in, so one click starts the sign-in", async () => {
    const user = userEvent.setup();
    const props = handlers();
    render(
      <ProviderOAuthSignIn
        {...props}
        accountLabel="Fixture account"
        signInLabel="Sign in with Fixture"
        state={{ kind: "signed-out" }}
        termsRequired
        termsSummary="The fixture terms apply."
      />,
    );
    const signIn = screen.getByRole("button", { name: "Sign in with Fixture" });
    expect(signIn).toBeEnabled();
    expect(signIn).toHaveAccessibleDescription(
      "Opens your browser. Signing in accepts these terms: The fixture terms apply.",
    );
    expect(screen.getByRole("button", { name: "Use an API key" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Acknowledge and continue" })).toBeNull();
    await user.click(signIn);
    expect(props.onSignIn).toHaveBeenCalledOnce();
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
    expect(screen.getByText("Your sign-in expired. Sign in again to use it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
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

  it("records the terms and begins a sign-in it is asked to start, and only once", async () => {
    let acknowledged = false;
    const run = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "acknowledge") {
        acknowledged = true;
        return { kind: "signed-out" as const, termsRequired: false };
      }
      if (command.kind === "begin") {
        return { kind: "awaiting-consent" as const, attemptId: "attempt-1" };
      }
      return { kind: "signed-out" as const, termsRequired: !acknowledged };
    });
    const { rerender } = render(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000902"
        consentShown
        run={run}
        startSignIn
        termsSummary="Terms"
      />,
    );

    expect(await screen.findByText(/Continue in the browser/)).toBeInTheDocument();
    rerender(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000902"
        consentShown
        run={run}
        startSignIn
        termsSummary="Terms"
      />,
    );
    expect(run.mock.calls.map((call) => call[0].kind)).toEqual(["status", "acknowledge", "begin"]);
    expect(screen.queryByRole("button", { name: "Use an API key" })).toBeNull();
  });

  it.each([
    ["an expired sign-in", { kind: "expired" as const }],
    ["terms the person has not been shown", { kind: "signed-out" as const, termsRequired: true }],
  ])("waits for a click beside the consent line instead of starting %s", async (_case, status) => {
    const run = vi.fn(async (_command: { readonly kind: string }) => status);
    render(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000904"
        run={run}
        startSignIn
        termsSummary="The plan terms apply."
      />,
    );
    expect(await screen.findByText(/Signing in accepts these terms/)).toBeInTheDocument();
    expect(run.mock.calls.map((call) => call[0].kind)).toEqual(["status"]);
  });

  it("does not begin a sign-in when the host does not record the acknowledgment", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async (command: { readonly kind: string }) =>
      command.kind === "acknowledge"
        ? { kind: "refused" as const, reason: "unavailable" }
        : { kind: "signed-out" as const, termsRequired: true },
    );
    render(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000903"
        run={run}
        termsSummary="Terms"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Octant couldn't finish the sign-in/)).toBeInTheDocument();
    expect(run.mock.calls.map((call) => call[0].kind)).toEqual(["status", "acknowledge"]);
  });

  it("offers a sign-out on this computer only when the sign-in service cannot be told, and says so afterwards", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "status") {
        return { kind: "signed-in" as const, accountLabel: "ChatGPT plan" };
      }
      if (command.kind === "sign-out") {
        return { kind: "not-revoked" as const, accountLabel: "ChatGPT plan" };
      }
      return { kind: "signed-out-locally" as const, termsRequired: false };
    });
    render(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000901"
        onUseApiKey={() => undefined}
        run={run}
        termsSummary="Terms"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/so it is still active/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out on this computer only" }));
    expect(
      await screen.findByText(/wasn't told, so the sign-in stays valid there until it expires/),
    ).toBeInTheDocument();
    expect(run.mock.calls.map((call) => call[0].kind)).toEqual([
      "status",
      "sign-out",
      "sign-out-locally",
    ]);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
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

  it("keeps polling a sign-in in the browser when the settings around it re-render, and shows who signed in", async () => {
    vi.useFakeTimers();
    let signedInAtIssuer = false;
    const calls: string[] = [];
    // The settings controller hands the panel a new command function on every
    // render. A re-render while the person is in the browser must not reset
    // the attempt, or the finished sign-in is never collected.
    const makeRun = () => async (command: { readonly kind: string }) => {
      calls.push(command.kind);
      if (command.kind === "status") return { kind: "signed-out" as const, termsRequired: false };
      if (command.kind === "begin") {
        return {
          kind: "awaiting-consent" as const,
          attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          authorizationUrl: "http://127.0.0.1/consent",
        };
      }
      if (!signedInAtIssuer) {
        return {
          kind: "awaiting-consent" as const,
          attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          authorizationUrl: "http://127.0.0.1/consent",
        };
      }
      return { kind: "signed-in" as const, accountLabel: "ChatGPT plan" };
    };
    const panel = () => (
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000903"
        openUrl={() => undefined}
        run={makeRun()}
        termsSummary="Terms"
      />
    );
    const { rerender } = render(panel());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Continue in the browser/)).toBeInTheDocument();
    rerender(panel());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Continue in the browser/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    signedInAtIssuer = true;
    rerender(panel());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText("ChatGPT plan", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/Signed in as/)).toBeInTheDocument();
    expect(calls.filter((kind) => kind === "status")).toEqual(["status"]);
  });

  it("shows a plain refusal when the host cannot read the sign-in, instead of going back to idle", async () => {
    const run = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "status") return { kind: "signed-out" as const, termsRequired: false };
      return { kind: "refused" as const, reason: "unavailable" };
    });
    const user = userEvent.setup();
    render(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000904"
        run={run}
        termsSummary="Terms"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("Octant couldn't finish the sign-in. Try signing in again."),
    ).toBeInTheDocument();
  });

  it("shows a refusal when the sign-in request gets no answer the panel can read", async () => {
    const run = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "status") return { kind: "signed-out" as const, termsRequired: false };
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <ProviderOAuthSignInPanel
        accountLabel="ChatGPT plan"
        descriptorId="chatgpt-plan"
        instanceId="00000000-0000-4000-8000-000000000905"
        run={run}
        termsSummary="Terms"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("Octant couldn't finish the sign-in. Try signing in again."),
    ).toBeInTheDocument();
  });
});
