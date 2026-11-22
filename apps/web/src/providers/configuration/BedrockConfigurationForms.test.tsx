import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderOAuthCommand, ProviderOAuthCommandResult } from "../ProviderOAuthSignIn";
import { CloudEndpointSignIn } from "./BedrockConfigurationForms";

function bedrockInstance() {
  const instance: ProviderInstance = decodeProviderInstance({
    id: "80000000-0000-4000-8000-000000000b11",
    displayName: "Contoso Bedrock",
    driverKind: "amazon-bedrock",
    configuration: {
      kind: "amazon-bedrock-converse-http",
      region: "us-west-2",
      authentication: "cloud-iam",
      cloudIam: {
        startUrl: "https://contoso.awsapps.com/start",
        ssoRegion: "us-east-1",
        accountId: "123456789012",
        roleName: "BedrockInvoke",
      },
      manualModelIds: ["anthropic.claude-sonnet-4-20250514-v1:0"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:00.000Z",
  });
  if (instance.driverKind !== "amazon-bedrock") throw new Error("fixture");
  return instance;
}

describe("Amazon Bedrock sign-in", () => {
  it("asks for an MFA code when a role profile requires one, surfaces validation and refusal errors, and completes sign-in with a valid code", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const onSignedOut = vi.fn();
    const run = vi.fn(
      async (command: ProviderOAuthCommand): Promise<ProviderOAuthCommandResult> => {
        if (command.kind === "status") {
          return signedIn
            ? { kind: "signed-in", accountLabel: "BedrockInvoke in account 123456789012" }
            : { kind: "signed-out", termsRequired: false };
        }
        if (command.kind === "connect-aws-profile") {
          if (command.mfaCode === undefined) {
            return { kind: "refused", reason: "aws-mfa-required" };
          }
          if (command.mfaCode === "12") {
            return { kind: "refused", reason: "aws-mfa-invalid" };
          }
          if (command.mfaCode === "000000") {
            return { kind: "refused", reason: "aws-mfa-refused" };
          }
          if (command.mfaCode === "654321") {
            signedIn = true;
            return { kind: "signed-in", accountLabel: "BedrockInvoke in account 123456789012" };
          }
        }
        return { kind: "refused", reason: "invalid" };
      },
    );

    render(
      <CloudEndpointSignIn
        disabled={false}
        instance={bedrockInstance()}
        onProviderOAuth={run}
        onSignedOut={onSignedOut}
      />,
    );

    const profileInput = await screen.findByLabelText("Use my AWS profile");
    await user.type(profileInput, "mfa-bedrock");
    await user.click(screen.getByRole("button", { name: "Connect profile" }));

    expect(
      await screen.findByText(
        "This profile's role requires an MFA code. Enter the 6-digit code from your authenticator device.",
      ),
    ).toBeVisible();
    const mfaInput = screen.getByLabelText("MFA code");
    expect(mfaInput).toBeVisible();
    expect(screen.getByText(/stay in memory only/i)).toBeVisible();

    // Malformed code reports validation guidance and keeps the MFA input visible.
    await user.type(mfaInput, "12");
    await user.click(screen.getByRole("button", { name: "Connect profile" }));
    expect(
      await screen.findByText("Enter the 6-digit MFA code from your authenticator device."),
    ).toBeVisible();

    // Rejected 6-digit code reports the STS refusal and clears the field for retry.
    await user.clear(mfaInput);
    await user.type(mfaInput, "000000");
    await user.click(screen.getByRole("button", { name: "Connect profile" }));
    expect(
      await screen.findByText(
        "AWS rejected the MFA code or refused to assume the role. Check your 6-digit code and try again.",
      ),
    ).toBeVisible();
    expect(mfaInput).toHaveValue("");

    // Valid 6-digit code completes sign-in and refreshes the endpoint.
    await user.type(mfaInput, "654321");
    await user.click(screen.getByRole("button", { name: "Connect profile" }));
    expect(await screen.findByText(/Signed in as/)).toBeVisible();
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "connect-aws-profile",
        awsProfile: "mfa-bedrock",
        mfaCode: "654321",
      }),
    );
  });

  it("shows the exact metadata refusal message when a profile reads unreachable EC2 or ECS metadata", async () => {
    const user = userEvent.setup();
    const run = vi.fn(
      async (command: ProviderOAuthCommand): Promise<ProviderOAuthCommandResult> => {
        if (command.kind === "status") return { kind: "signed-out", termsRequired: false };
        return { kind: "refused", reason: "aws-metadata-unreachable" };
      },
    );

    render(
      <CloudEndpointSignIn disabled={false} instance={bedrockInstance()} onProviderOAuth={run} />,
    );

    await user.type(await screen.findByLabelText("Use my AWS profile"), "ec2-bedrock");
    await user.click(screen.getByRole("button", { name: "Connect profile" }));

    expect(
      await screen.findByText(
        "This profile reads credentials from EC2/ECS metadata, which this computer can't reach.",
      ),
    ).toBeVisible();
  });

  it("offers the profile and MFA sign-in again when the last check found the session expired", async () => {
    const user = userEvent.setup();
    const run = vi.fn(
      async (command: ProviderOAuthCommand): Promise<ProviderOAuthCommandResult> => {
        if (command.kind === "status") {
          return { kind: "signed-in", accountLabel: "BedrockInvoke in account 123456789012" };
        }
        return { kind: "refused", reason: "aws-mfa-required" };
      },
    );

    render(
      <CloudEndpointSignIn
        disabled={false}
        instance={bedrockInstance()}
        lastCheckRefusedSignIn
        onProviderOAuth={run}
      />,
    );

    expect(await screen.findByText(/no longer works/i)).toBeVisible();
    await user.type(screen.getByLabelText("Use my AWS profile"), "mfa-bedrock");
    await user.click(screen.getByRole("button", { name: "Connect profile" }));
    expect(await screen.findByLabelText("MFA code")).toBeVisible();
  });
});
