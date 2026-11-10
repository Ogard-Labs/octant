import {
  GITHUB_REPOSITORY_PERMISSION_NOTICE,
  googleWorkspaceServiceForResource,
} from "@octant/domain";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { McpClientSetupInput, McpServerSignInView } from "@octant/contracts/extension-rpc";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useSecretStoresClient } from "../settings/SecretStoresClientContext";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

type SetupView = Extract<McpServerSignInView, { kind: "client-setup" }>;
interface Props {
  readonly client: Pick<ExtensionClient, "mcpServerSignIn">;
  readonly extensionId: string;
  readonly componentId: string;
  readonly disabled: boolean;
  readonly onSaved: () => void;
  readonly autoOpen?: boolean;
  readonly onAutoOpen?: () => void;
}

/** Application identity is saved separately from a person's account consent. */
export function McpClientSetupControl(props: Props) {
  const [setup, setSetup] = useState<SetupView>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const prepare = useCallback(async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const next = await props.client.mcpServerSignIn({
        kind: "prepare-client",
        extensionId: props.extensionId as never,
        componentId: props.componentId as never,
      });
      if (!alive.current) return;
      if (next.kind === "client-setup") setSetup(next);
      else
        setProblem(
          next.kind === "refused" ? next.message : "This server does not offer client setup.",
        );
    } catch {
      if (alive.current) setProblem("Client setup could not be read. Try again.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [props.client, props.extensionId, props.componentId]);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (props.autoOpen !== true || props.disabled || autoOpened.current) return;
    autoOpened.current = true;
    props.onAutoOpen?.();
    void prepare();
  }, [props.autoOpen, props.disabled, props.onAutoOpen, prepare]);
  return (
    <>
      <OctantButton
        disabled={props.disabled || busy}
        onClick={() => void prepare()}
        size="sm"
        type="button"
        variant="ghost"
      >
        Client setup
      </OctantButton>
      {problem === undefined ? null : (
        <span className="mcp-sign-in__state" role="status">
          {problem}
        </span>
      )}
      {setup === undefined ? null : (
        <McpClientSetupDialog
          {...props}
          onSaved={() => {
            setProblem("Client setup saved.");
            props.onSaved();
          }}
          onClose={() => setSetup(undefined)}
          setup={setup}
        />
      )}
    </>
  );
}

function McpClientSetupDialog(
  props: Props & { readonly setup: SetupView; readonly onClose: () => void },
) {
  const google = googleWorkspaceServiceForResource(props.setup.resource);
  const ids = useId();
  const clientIdInput = useRef<HTMLInputElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  const secretStores = useSecretStoresClient();
  const [linkedStore, setLinkedStore] = useState(false);
  const [kind, setKind] = useState<McpClientSetupInput["kind"]>(
    google === undefined ? (props.setup.registration?.kind ?? "registered") : "registered",
  );
  const [clientId, setClientId] = useState(props.setup.registration?.clientId ?? "");
  const [authentication, setAuthentication] = useState<McpClientSetupInput["authentication"]>(
    google !== undefined
      ? "none"
      : (props.setup.registration?.clientAuthentication?.method ??
          (props.setup.authenticationMethods.includes("none")
            ? "none"
            : (props.setup.authenticationMethods[0] ?? "none"))),
  );
  const [reference, setReference] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void secretStores?.read().then(
      (view) => {
        if (alive.current && view.kind === "secret-stores-view")
          setLinkedStore(view.stores.some((store) => store.linked));
      },
      () => undefined,
    );
    return () => {
      alive.current = false;
    };
  }, [secretStores]);
  const hasSavedSecret =
    props.setup.registration?.clientId === clientId.trim() &&
    props.setup.registration.clientAuthentication?.method === authentication &&
    props.setup.registration.issuer === props.setup.issuer &&
    props.setup.registration.clientAuthentication.tokenEndpoint === props.setup.tokenEndpoint;
  const needsSecret = authentication !== "none" && !hasSavedSecret;
  const canLinkSecret = props.setup.secretStoreAvailable && linkedStore;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || props.disabled) return;
    if (!clientId.trim()) {
      setProblem("Enter the client ID.");
      clientIdInput.current?.focus();
      return;
    }
    if (needsSecret && (!canLinkSecret || !reference.trim())) {
      setProblem(
        canLinkSecret
          ? "Enter the client secret's item reference."
          : "Link a secret store in Settings before saving a confidential client.",
      );
      secretInput.current?.focus();
      return;
    }
    setProblem(undefined);
    setBusy(true);
    try {
      const view = await props.client.mcpServerSignIn({
        kind: "save-client",
        extensionId: props.extensionId as never,
        componentId: props.componentId as never,
        setup: {
          kind,
          binding: {
            resource: props.setup.resource,
            issuer: props.setup.issuer,
            tokenEndpoint: props.setup.tokenEndpoint,
            callback: props.setup.callback,
            ...(props.setup.mcpPermissionProfile === undefined
              ? {}
              : { mcpPermissionProfile: props.setup.mcpPermissionProfile }),
          },
          clientId: clientId.trim(),
          authentication,
          ...(authentication !== "none" && reference.trim()
            ? { secret: { store: "onepassword", reference: reference.trim() } }
            : {}),
        },
      });
      if (!alive.current) return;
      if (view.kind !== "client-configured")
        setProblem(
          view.kind === "refused"
            ? view.message
            : "The server is no longer available for client setup.",
        );
      else {
        props.onSaved();
        props.onClose();
      }
    } catch {
      if (alive.current)
        setProblem(
          "The save response was not confirmed. Your entries are kept; reopen Client setup to check before saving again.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(props.setup.callback);
      if (alive.current) setCopyMessage("Callback copied.");
    } catch {
      if (alive.current)
        setCopyMessage("Copy is unavailable. Select and copy the callback address above.");
    }
  };
  return (
    <OctantDialog
      className="endpoint-add"
      initialFocus={clientIdInput}
      label="Client setup"
      labelledBy={`${ids}-title`}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      open
    >
      <h2 className="endpoint-add__title" id={`${ids}-title`}>
        Client setup
      </h2>
      <form className="endpoint-flow" noValidate onSubmit={(event) => void submit(event)}>
        <p className="endpoint-flow__hint">
          Use the app identity you registered for this server. Saving does not sign in to an
          account.
        </p>
        {google === undefined ? null : (
          <>
            <p className="endpoint-flow__hint">
              Developer Preview requires an enrolled Google Workspace account and Cloud project. A
              client ID alone does not establish eligibility. Public distribution requires Google's
              permission or general availability.
            </p>
            <p className="endpoint-flow__hint">{google.description}</p>
            <p className="endpoint-flow__hint">
              Create a Desktop app client with Use this client for an AI-powered agent selected.
              Enable {google.api} and {google.mcpApi}. No client secret is needed.
            </p>
            <a
              href="https://developers.google.com/workspace/guides/create-credentials#desktop-app"
              rel="noreferrer"
              target="_blank"
            >
              Google Desktop client setup
            </a>
          </>
        )}
        {props.setup.mcpPermissionProfile === "github-repositories-read-write" ? (
          <p className="endpoint-flow__hint">{GITHUB_REPOSITORY_PERMISSION_NOTICE}</p>
        ) : null}
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-server`}>Server</label>
          <OctantInput id={`${ids}-server`} readOnly value={props.setup.resource} />
        </div>
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-issuer`}>Authorization server</label>
          <OctantInput id={`${ids}-issuer`} readOnly value={props.setup.issuer} />
        </div>
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-callback`}>Callback address</label>
          <OctantInput
            aria-describedby={`${ids}-callback-hint`}
            id={`${ids}-callback`}
            readOnly
            value={props.setup.callback}
          />
          <span className="endpoint-flow__hint" id={`${ids}-callback-hint`}>
            {google === undefined
              ? "Register this exact address with your app. Octant keeps it across restarts; the port must be free when you sign in."
              : "Your Desktop client receives the browser's reply on this computer. Octant keeps this loopback address across restarts; its port must be free when you sign in."}
          </span>
          <OctantButton
            onClick={() => void copyCallback()}
            size="sm"
            type="button"
            variant="outline"
          >
            Copy callback
          </OctantButton>
          <span role="status">{copyMessage}</span>
        </div>
        {google !== undefined ? null : (
          <OctantToggleGroup
            aria-label="Client identity"
            onValueChange={(values) => {
              const value = values[0];
              if (value === "registered" || value === "metadata-document") {
                setKind(value);
                if (value === "metadata-document") setAuthentication("none");
              }
            }}
            value={[kind]}
          >
            <OctantToggleGroupItem value="registered">Registered client</OctantToggleGroupItem>
            <OctantToggleGroupItem
              disabled={!props.setup.metadataClientSupported}
              value="metadata-document"
            >
              Client metadata URL
            </OctantToggleGroupItem>
          </OctantToggleGroup>
        )}
        {google !== undefined || props.setup.metadataClientSupported ? null : (
          <p className="endpoint-flow__hint">
            This authorization server does not advertise client metadata URLs.
          </p>
        )}
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-client`}>
            {kind === "metadata-document"
              ? "Client metadata URL"
              : google === undefined
                ? "Client ID"
                : "Desktop client ID"}
          </label>
          <OctantInput
            aria-describedby={`${ids}-client-hint`}
            aria-invalid={problem !== undefined && clientId.trim().length === 0}
            autoComplete="off"
            id={`${ids}-client`}
            onChange={(event) => setClientId(event.currentTarget.value)}
            ref={clientIdInput}
            spellCheck={false}
            value={clientId}
          />
          <span className="endpoint-flow__hint" id={`${ids}-client-hint`}>
            {kind === "metadata-document"
              ? "An HTTPS client metadata document supported by this authorization server."
              : "The public app identifier from your registration, not its client secret."}
          </span>
        </div>
        {google !== undefined || kind === "metadata-document" ? null : (
          <OctantToggleGroup
            aria-label="Client authentication"
            onValueChange={(values) => {
              const value = values[0];
              if (
                value === "none" ||
                value === "client_secret_post" ||
                value === "client_secret_basic"
              )
                setAuthentication(value);
            }}
            value={[authentication]}
          >
            <OctantToggleGroupItem
              disabled={!props.setup.authenticationMethods.includes("none")}
              value="none"
            >
              Public client
            </OctantToggleGroupItem>
            <OctantToggleGroupItem
              disabled={!props.setup.authenticationMethods.includes("client_secret_post")}
              value="client_secret_post"
            >
              Client secret (POST)
            </OctantToggleGroupItem>
            <OctantToggleGroupItem
              disabled={!props.setup.authenticationMethods.includes("client_secret_basic")}
              value="client_secret_basic"
            >
              Client secret (Basic)
            </OctantToggleGroupItem>
          </OctantToggleGroup>
        )}
        {authentication === "none" ? null : (
          <div className="endpoint-flow__field">
            <label htmlFor={`${ids}-destination`}>Client secret destination</label>
            <OctantInput id={`${ids}-destination`} readOnly value={props.setup.tokenEndpoint} />
            <label htmlFor={`${ids}-secret`}>Client secret item reference</label>
            <OctantInput
              aria-describedby={`${ids}-secret-hint`}
              autoComplete="off"
              disabled={!canLinkSecret}
              id={`${ids}-secret`}
              onChange={(event) => setReference(event.currentTarget.value)}
              placeholder="op://Private/My app/client secret"
              ref={secretInput}
              spellCheck={false}
              value={reference}
            />
            <span className="endpoint-flow__hint" id={`${ids}-secret-hint`}>
              {hasSavedSecret
                ? "The saved secret is kept. Enter another item reference only to replace it."
                : canLinkSecret
                  ? "An item in your linked 1Password store. Octant checks it on this host and keeps only a reference."
                  : "Link a secret store in Settings to choose a client secret. This form never takes the secret value."}
            </span>
          </div>
        )}
        {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
        <div className="endpoint-flow__actions">
          <OctantButton disabled={busy} onClick={props.onClose} type="button" variant="outline">
            Cancel
          </OctantButton>
          <OctantButton
            disabled={
              busy ||
              props.disabled ||
              !props.setup.authenticationMethods.includes(authentication) ||
              (needsSecret && !canLinkSecret)
            }
            type="submit"
          >
            Save client setup
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}
