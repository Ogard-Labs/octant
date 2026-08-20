import { decodeProviderInstanceId, type ProviderCredentialStatus } from "@octant/contracts";
import { act, render, renderHook, screen } from "@testing-library/react";
import { useRef } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  emptyTransientCredential,
  HttpCredentialFields,
  transientCredential,
  useCredentialStatus,
} from "./ProviderSettingsCredentials";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-000000000092");

describe("provider credential entry", () => {
  it("reads the typed secret and clears the field on settle", () => {
    const input = document.createElement("input");
    input.value = "private-value";
    const credential = transientCredential(input);

    expect(credential.value).toBe("private-value");
    credential.clear();
    expect(input.value).toBe("");
  });

  it("treats a missing input as an empty credential that can still settle", () => {
    const credential = transientCredential(null);
    expect(credential.value).toBe("");
    credential.clear();
  });

  it("discards a typed or injected secret immediately when the submit path must not store one", () => {
    const input = document.createElement("input");
    input.value = "injected-secret";
    const discarded = emptyTransientCredential(transientCredential(input));

    expect(discarded.value).toBe("");
    expect(input.value).toBe("");
    discarded.clear();
    expect(input.value).toBe("");
  });

  it("keeps the entered secret in a password field and out of rendered text", async () => {
    const user = userEvent.setup();
    render(<CredentialFieldsHarness authentication="bearer" />);
    const key = screen.getByLabelText("API key");

    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "private-value");
    expect(key).toHaveValue("private-value");
    expect(document.body.textContent).not.toContain("private-value");
  });

  it("clears and disables the credential when authentication changes to none", async () => {
    const user = userEvent.setup();
    render(<CredentialFieldsHarness authentication="bearer" />);
    const authentication = screen.getByLabelText("Authentication");
    const key = screen.getByLabelText("API key");

    await user.type(key, "must-not-linger");
    await user.selectOptions(authentication, "none");
    expect(key).toBeDisabled();
    expect(key).toHaveValue("");
    expect(document.body.textContent).not.toContain("must-not-linger");

    await user.selectOptions(authentication, "bearer");
    expect(key).toBeEnabled();
    expect(key).toHaveValue("");
  });

  it("disables credential entry when the host cannot manage secrets", () => {
    render(
      <CredentialFieldsHarness authentication="bearer" credentialManagementAvailable={false} />,
    );
    expect(screen.getByLabelText("API key")).toBeDisabled();
  });
});

describe("provider credential status", () => {
  it("shows a pending Keychain check without claiming the secret is missing", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    const onProviderCredentialStatus = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useCredentialStatus(
        {
          instance: { id },
          credentialManagementAvailable: true,
          onProviderCredentialStatus,
        },
        false,
      ),
    );

    expect(result.current.status).toBe("checking");
    expect(onProviderCredentialStatus).toHaveBeenCalledWith(id);

    await act(async () => pending.resolve("missing"));
    expect(result.current.status).toBe("missing");
  });

  it("keeps an authoritative observed status over a stale check", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    const onProviderCredentialStatus = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      (observed?: { readonly credentialStatus?: ProviderCredentialStatus }) =>
        useCredentialStatus(
          {
            instance: { id },
            credentialManagementAvailable: true,
            onProviderCredentialStatus,
            ...(observed === undefined ? {} : { observed }),
          },
          false,
        ),
    );

    expect(result.current.status).toBe("checking");
    rerender({ credentialStatus: "stored" });
    expect(result.current.status).toBe("stored");

    await act(async () => pending.resolve("missing"));
    expect(result.current.status).toBe("stored");
  });

  it("does not let a stale Keychain check overwrite a successful clear", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    const onProviderCredentialStatus = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useCredentialStatus(
        {
          instance: { id },
          credentialManagementAvailable: true,
          observed: { credentialStatus: "stored" },
          onProviderCredentialStatus,
        },
        false,
      ),
    );

    let generation = 0;
    act(() => {
      generation = result.current.beginMutation();
    });
    expect(result.current.status).toBe("checking");
    act(() => {
      result.current.finishMutation(generation, true, "missing");
    });
    expect(result.current.status).toBe("missing");

    await act(async () => pending.resolve("stored"));
    expect(result.current.status).toBe("missing");
  });

  it("does not request Keychain status for a credentialless provider", () => {
    const onProviderCredentialStatus = vi.fn(async () => "missing" as const);
    const { result } = renderHook(() =>
      useCredentialStatus(
        {
          instance: { id },
          credentialManagementAvailable: true,
          onProviderCredentialStatus,
        },
        true,
      ),
    );

    expect(onProviderCredentialStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBe("checking");
  });
});

function CredentialFieldsHarness(props: {
  readonly authentication: "api-key" | "bearer" | "none";
  readonly credentialManagementAvailable?: boolean;
}) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <HttpCredentialFields
      authentication={props.authentication}
      authenticationLabel="Authentication"
      credentialInput={credentialInput}
      credentialLabel="API key"
      credentialManagementAvailable={props.credentialManagementAvailable ?? true}
    />
  );
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
