import type { ProviderInstance } from "@octant/contracts";
import { AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { thisComputerName, useHostPlatform } from "../../platform";
import { SettingRow } from "../../settings/primitives";
import { getInjectedHostBridge } from "../../shell/hostBridge";
import { DeviceCodeSignIn } from "../DeviceCodeSignIn";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import type {
  ProviderOAuthCommand,
  ProviderOAuthCommandResult,
  ProviderOAuthSignInState,
} from "../ProviderOAuthSignIn";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import { bedrockConfigurationFrom } from "./configurationValues";

type BedrockInstance = Extract<ProviderInstance, { driverKind: "amazon-bedrock" }>;

/** What the person is told when a Bedrock field is not one the host takes. */
export const BEDROCK_FIELDS_PROBLEM =
  "Enter the region the models run in (such as us-west-2), your organization's access portal (https://<name>.awsapps.com/start), the portal's region, the 12-digit account ID, the role (permission set) name, and at least one model ID.";

/** The command that signs an Amazon Bedrock endpoint in, as the person types it on the host. */
export function bedrockSignInCommand(displayName: string): string {
  return `octant provider sign-in "${displayName}"`;
}

/**
 * An Amazon Bedrock endpoint's region, single sign-on portal, account, role,
 * and models. None of it is secret. Changing anything but the models ends the
 * portal session and deletes the sign-in on the host before the change is
 * saved, so the note says so before Save.
 */
export function BedrockConfigurationForm(props: {
  readonly instance: BedrockInstance;
  readonly disabled: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeAmazonBedrockConfiguration"];
}) {
  const saved = props.instance.configuration;
  const name = props.instance.displayName;
  const id = String(props.instance.id);
  const [problem, setProblem] = useState<string>();
  const text = (label: string, field: string, value: string, placeholder?: string) => (
    <SettingRow label={label} scope="host" settingId={`provider-${id}-bedrock-${field}`}>
      <OctantInput
        aria-label={`${label} for ${name}`}
        autoComplete="off"
        className="settings-view__text-input"
        defaultValue={value}
        name={field}
        {...(placeholder === undefined ? {} : { placeholder })}
        spellCheck={false}
      />
    </SettingRow>
  );
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = bedrockConfigurationFrom(new FormData(event.currentTarget));
        if (configuration === undefined) {
          setProblem(BEDROCK_FIELDS_PROBLEM);
          return;
        }
        setProblem(undefined);
        void props.onChange(props.instance.id, configuration);
      }}
    >
      {text("Region", "region", String(saved.region), "us-west-2")}
      {text(
        "Access portal",
        "startUrl",
        String(saved.cloudIam.startUrl),
        "https://<name>.awsapps.com/start",
      )}
      {text("Portal region", "ssoRegion", String(saved.cloudIam.ssoRegion), "us-east-1")}
      {text("Account ID", "accountId", String(saved.cloudIam.accountId), "123456789012")}
      {text("Role", "roleName", String(saved.cloudIam.roleName))}
      <SettingRow label="Model IDs" scope="host" settingId={`provider-${id}-bedrock-models`}>
        <OctantTextarea
          aria-label={`Model IDs for ${name}`}
          className="settings-view__text-input"
          defaultValue={saved.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p className="provider-settings__field-guidance" id={`endpoint-guidance-${id}`}>
        The role is the permission set your organization assigns you in that account. Bedrock
        doesn't list the models a role may use, so name each one, in the order the model picker
        shows them. Changing the region, portal, account, or role signs this endpoint out; changing
        only the models keeps the sign-in.
      </p>
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="provider-card__edit-actions">
        <OctantButton
          aria-label={`Save Amazon Bedrock settings for ${name}`}
          disabled={props.disabled}
          size="sm"
          type="submit"
          variant="secondary"
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}

type CloudSignInState =
  | { readonly kind: "checking" }
  | { readonly kind: "check-failed" }
  | { readonly kind: "signing-out" }
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  | { readonly kind: "signed-out"; readonly notice?: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * An Amazon Bedrock endpoint's sign-in. It begins only on the host: in a
 * terminal, where `octant provider sign-in` shows the portal's code, or in a
 * local desktop window, which reaches the host-local sign-in through the
 * desktop app. A code shown on a page someone else can reach is how
 * device-code phishing works, so a paired device and a remote browser are
 * offered the command and never a code. The panel also reads whether the host
 * holds a sign-in, names the role and account, and signs out, which asks the
 * portal to end the session and deletes the sign-in on the host.
 */
export function CloudEndpointSignIn(props: {
  readonly instance: BedrockInstance;
  readonly disabled: boolean;
  /**
   * The host's last check of this endpoint was refused for want of a sign-in
   * (it ended, or the broker no longer holds it). The host's status answer
   * reads only whether this endpoint names a sign-in, not whether the broker
   * still holds it, so without this the panel said "Signed in as" while the
   * row said Signed out.
   */
  readonly lastCheckRefusedSignIn?: boolean;
  readonly onStateChange?: (state: ProviderOAuthSignInState) => void;
  /** Checks the endpoint again, so its state follows a sign-out or a sign-in at once. */
  readonly onSignedOut?: () => void;
  readonly onOpenExternalUrl?: (url: string) => void;
  readonly onProviderOAuth?: (
    command: ProviderOAuthCommand,
  ) => Promise<ProviderOAuthCommandResult | undefined>;
}) {
  const computer = thisComputerName(useHostPlatform());
  const [state, setState] = useState<CloudSignInState>({ kind: "checking" });
  const [checks, setChecks] = useState(0);
  const instanceId = String(props.instance.id);
  const { descriptorId } = AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN;
  // The settings controller hands a new callback on every render; reading
  // the latest keeps the status check from running again on each one.
  const runRef = useRef(props.onProviderOAuth);
  runRef.current = props.onProviderOAuth;
  const onStateChangeRef = useRef(props.onStateChange);
  onStateChangeRef.current = props.onStateChange;
  const canRun = props.onProviderOAuth !== undefined;

  useEffect(() => {
    onStateChangeRef.current?.(state);
  }, [state]);

  useEffect(() => {
    const run = runRef.current;
    if (run === undefined) return undefined;
    let cancelled = false;
    setState({ kind: "checking" });
    void run({ kind: "status", instanceId, descriptorId })
      .catch(() => undefined)
      .then((result) => {
        if (cancelled) return;
        if (result?.kind === "signed-in") {
          setState({ kind: "signed-in", accountLabel: result.accountLabel ?? "your role" });
        } else if (result?.kind === "signed-out") {
          setState({ kind: "signed-out" });
        } else {
          setState({ kind: "check-failed" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canRun, checks, descriptorId, instanceId]);

  const signOut = () => {
    const run = runRef.current;
    if (run === undefined) return;
    setState({ kind: "signing-out" });
    void run({ kind: "sign-out", instanceId, descriptorId })
      .catch(() => undefined)
      .then((result) => {
        if (result?.kind === "signed-out") {
          setState({
            kind: "signed-out",
            notice: "Signed out. This computer no longer holds a sign-in for this endpoint.",
          });
          props.onSignedOut?.();
          return;
        }
        setState({
          kind: "refused",
          message:
            result?.reason === "local-host-required"
              ? `Sign out from Octant on ${computer}.`
              : "Octant couldn't sign out. Try again.",
        });
      });
  };

  const busy = state.kind === "checking" || state.kind === "signing-out";
  const ended = state.kind === "signed-in" && props.lastCheckRefusedSignIn === true;
  const disabled = props.disabled || busy;
  const command = bedrockSignInCommand(props.instance.displayName);
  // Present only in a local desktop window.
  const deviceSignIn = getInjectedHostBridge()?.providerDeviceSignIn;
  return (
    <div aria-busy={busy} className="provider-card__edit-actions provider-oauth-sign-in">
      {busy ? (
        <p role="status">{state.kind === "checking" ? "Checking sign-in…" : "Signing out…"}</p>
      ) : null}
      {state.kind === "check-failed" ? (
        <OctantAlert tone="warning">
          Couldn't confirm your sign-in status. Check again before signing in or out.
        </OctantAlert>
      ) : null}
      {state.kind === "refused" ? <OctantAlert tone="warning">{state.message}</OctantAlert> : null}
      {state.kind === "signed-in" && ended ? (
        <p role="status">
          The last check found the sign-in as{" "}
          <span className="oct-meta--mono">{state.accountLabel}</span> no longer works. Sign out
          removes what is left of it on this computer.
        </p>
      ) : null}
      {state.kind === "signed-in" && !ended ? (
        <>
          <p role="status">
            Signed in as <span className="oct-meta--mono">{state.accountLabel}</span>
          </p>
          <p className="provider-oauth-sign-in__consent">
            Sign out removes this computer's sign-in and asks your organization's portal to end the
            session.
          </p>
          <OctantButton
            disabled={disabled}
            onClick={signOut}
            size="sm"
            type="button"
            variant="destructive"
          >
            Sign out
          </OctantButton>
        </>
      ) : null}
      {state.kind === "signed-out" || ended ? (
        <>
          {state.kind === "signed-out" && state.notice !== undefined ? (
            <p role="status">{state.notice}</p>
          ) : null}
          {deviceSignIn === undefined ? (
            <p>
              Sign in from a terminal on {computer}: run <code>{command}</code> and enter the code
              it shows at your organization's access portal. Settings never shows the code. Then
              check again.
            </p>
          ) : (
            <>
              <DeviceCodeSignIn
                disabled={disabled}
                instanceId={instanceId}
                instanceName={props.instance.displayName}
                onSignedIn={() => {
                  setChecks((count) => count + 1);
                  props.onSignedOut?.();
                }}
                request={deviceSignIn}
                {...(props.onOpenExternalUrl === undefined
                  ? {}
                  : { onOpenExternalUrl: props.onOpenExternalUrl })}
              />
              <p>
                Or sign in from a terminal on {computer}: run <code>{command}</code> and enter the
                code it shows at your organization's access portal. Then check again.
              </p>
            </>
          )}
        </>
      ) : null}
      {(state.kind === "signed-out" || ended) && props.onProviderOAuth !== undefined ? (
        <PersonAwsCredentials
          disabled={disabled}
          instanceId={instanceId}
          run={props.onProviderOAuth}
          onConnected={() => {
            setChecks((count) => count + 1);
            props.onSignedOut?.();
          }}
        />
      ) : null}
      {ended ? (
        <OctantButton
          disabled={disabled}
          onClick={signOut}
          size="sm"
          type="button"
          variant="secondary"
        >
          Sign out
        </OctantButton>
      ) : null}
      {state.kind === "signed-out" ||
      ended ||
      state.kind === "check-failed" ||
      state.kind === "refused" ? (
        <OctantButton
          disabled={disabled || !canRun}
          onClick={() => setChecks((count) => count + 1)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Check again
        </OctantButton>
      ) : null}
    </div>
  );
}

/** What the host answered when a profile or key pair could not be connected. */
function connectRefusal(reason: string | undefined): string {
  switch (reason) {
    case "aws-sso-sign-in-needed":
      return "That profile's single sign-on has no current session. Run aws sso login for it, then connect again.";
    case "aws-profile-missing":
      return "No AWS profile by that name was found in the AWS config or credentials file on this computer.";
    case "aws-process-failed":
      return "The profile's credential_process did not print credentials.";
    case "aws-unsupported":
      return "That profile only assumes a role or names a source Octant does not read yet. Use a profile with keys, single sign-on or credential_process.";
    case "aws-not-authorized":
      return "Your organization's portal does not give you that profile's account and role.";
    case "local-host-required":
      return "Connect your AWS profile or keys from Octant on this computer.";
    default:
      return "Octant couldn't connect these credentials. Check them and try again.";
  }
}

/**
 * The person's own AWS credentials in place of the portal sign-in: a named
 * AWS profile, read in place by the host's credential broker on every
 * renewal, or a long-lived access key pair, which the broker keeps and which
 * the page warns about. Neither is stored or journaled by the server.
 */
function PersonAwsCredentials(props: {
  readonly instanceId: string;
  readonly disabled: boolean;
  readonly run: (command: ProviderOAuthCommand) => Promise<ProviderOAuthCommandResult | undefined>;
  readonly onConnected: () => void;
}) {
  const [profile, setProfile] = useState("");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const { descriptorId } = AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN;
  const connect = async (
    command:
      | { readonly kind: "connect-aws-profile"; readonly awsProfile: string }
      | {
          readonly kind: "connect-access-keys";
          readonly accessKeys: { readonly accessKeyId: string; readonly secretAccessKey: string };
        },
  ) => {
    setBusy(true);
    setMessage(undefined);
    const result = await props
      .run({ ...command, instanceId: props.instanceId, descriptorId })
      .catch(() => undefined);
    setBusy(false);
    if (result?.kind === "signed-in") {
      setSecret("");
      props.onConnected();
      return;
    }
    setMessage(
      result?.kind === "signed-out" && result.termsRequired === true
        ? "Accept the sign-in terms with a portal sign-in first, then connect again."
        : connectRefusal(result?.reason),
    );
  };
  const disabled = props.disabled || busy;
  return (
    <div className="provider-oauth-sign-in__aws">
      <p>Or use credentials you already have on this computer.</p>
      <label htmlFor={`${props.instanceId}-aws-profile`}>Use my AWS profile</label>
      <OctantInput
        autoComplete="off"
        className="input"
        disabled={disabled}
        id={`${props.instanceId}-aws-profile`}
        onChange={(event) => setProfile(event.target.value)}
        placeholder="default"
        value={profile}
      />
      <OctantButton
        disabled={disabled || profile.trim().length === 0}
        onClick={() => void connect({ kind: "connect-aws-profile", awsProfile: profile.trim() })}
        size="sm"
        type="button"
        variant="secondary"
      >
        Connect profile
      </OctantButton>
      <OctantAlert tone="warning">
        Long-lived access keys work until someone revokes them, so anyone who copies them can sign
        Bedrock requests as you. Prefer a profile with single sign-on. Octant keeps the keys in this
        computer's credential store and never shows or records them.
      </OctantAlert>
      <label htmlFor={`${props.instanceId}-aws-key-id`}>Access key ID</label>
      <OctantInput
        autoComplete="off"
        className="input"
        disabled={disabled}
        id={`${props.instanceId}-aws-key-id`}
        onChange={(event) => setKeyId(event.target.value)}
        value={keyId}
      />
      <label htmlFor={`${props.instanceId}-aws-secret`}>Secret access key</label>
      <OctantInput
        autoComplete="off"
        className="input"
        disabled={disabled}
        id={`${props.instanceId}-aws-secret`}
        onChange={(event) => setSecret(event.target.value)}
        type="password"
        value={secret}
      />
      <OctantButton
        disabled={disabled || keyId.trim().length === 0 || secret.length === 0}
        onClick={() =>
          void connect({
            kind: "connect-access-keys",
            accessKeys: { accessKeyId: keyId.trim(), secretAccessKey: secret },
          })
        }
        size="sm"
        type="button"
        variant="secondary"
      >
        Connect keys
      </OctantButton>
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </div>
  );
}
