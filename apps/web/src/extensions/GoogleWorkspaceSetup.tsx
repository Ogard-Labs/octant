import { useId, useRef, useState } from "react";
import type { GoogleWorkspaceService } from "@octant/domain";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantField, OctantFieldDescription, OctantFieldError, OctantFieldGroup, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";

export interface GoogleWorkspaceSetupProps {
  readonly service: GoogleWorkspaceService;
  readonly disabled: boolean;
  readonly configure: (input: { readonly clientId: string; readonly redirectPort: number }) => Promise<
    { readonly kind: "configured" } | { readonly kind: "refused"; readonly message: string }
  >;
}

/** Application setup is separate from the selected account's service consent. */
export function GoogleWorkspaceSetup(props: GoogleWorkspaceSetupProps) {
  const id = useId();
  const clientInput = useRef<HTMLInputElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  const [clientId, setClientId] = useState("");
  const [port, setPort] = useState("43125");
  const [invalid, setInvalid] = useState<"client" | "port">();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  return (
    <form aria-label={`${props.service.displayName} application setup`} className="connectors__key" noValidate onSubmit={async (event) => {
      event.preventDefault();
      if (busy || props.disabled) return;
      const client = clientId.trim();
      const redirectPort = Number(port);
      if (!/^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(client)) {
        setInvalid("client");
        clientInput.current?.focus();
        return;
      }
      if (!/^\d+$/.test(port) || !Number.isInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535) {
        setInvalid("port");
        portInput.current?.focus();
        return;
      }
      setInvalid(undefined);
      setFailure(undefined);
      setBusy(true);
      try {
        const result = await props.configure({ clientId: client, redirectPort });
        if (result.kind === "refused") setFailure(result.message);
      } catch {
        setFailure("Google setup could not be saved. Your details are kept here; try again.");
      } finally {
        setBusy(false);
      }
    }}>
      <p className="connectors__detail">Developer Preview requires an enrolled Google Workspace account and Google Cloud project. Your administrator may restrict access.</p>
      <p className="connectors__detail">{props.service.description}</p>
      <p className="connectors__detail">Create a Desktop app OAuth client in your enrolled project with <strong>Use this client for an AI-powered agent</strong> selected. Enable {props.service.api} and {props.service.mcpApi}. No client secret is needed.</p>
      <a href="https://developers.google.com/workspace/guides/create-credentials#desktop-app" rel="noreferrer" target="_blank">Google Desktop client setup</a>
      <OctantFieldGroup>
        <OctantField data-invalid={invalid === "client"}>
          <OctantFieldLabel htmlFor={`${id}-client`}>Desktop client ID</OctantFieldLabel>
          <OctantInput ref={clientInput} id={`${id}-client`} aria-describedby={`${id}-client-description${invalid === "client" ? ` ${id}-client-error` : ""}`} aria-invalid={invalid === "client"} autoComplete="off" spellCheck={false} value={clientId} onChange={(event) => setClientId(event.currentTarget.value)} />
          <OctantFieldDescription id={`${id}-client-description`}>Use your own Desktop client, ending in .apps.googleusercontent.com. Saving it does not sign in or enable another Google service.</OctantFieldDescription>
          {invalid === "client" ? <OctantFieldError id={`${id}-client-error`}>Enter the Desktop client ID from Google Cloud.</OctantFieldError> : null}
        </OctantField>
        <OctantField data-invalid={invalid === "port"}>
          <OctantFieldLabel htmlFor={`${id}-port`}>Local callback port</OctantFieldLabel>
          <OctantInput ref={portInput} id={`${id}-port`} aria-describedby={`${id}-port-description${invalid === "port" ? ` ${id}-port-error` : ""}`} aria-invalid={invalid === "port"} inputMode="numeric" value={port} onChange={(event) => setPort(event.currentTarget.value)} />
          <OctantFieldDescription id={`${id}-port-description`}>Octant receives the browser's sign-in reply on this computer. If this port is busy, choose another between 1024 and 65535.</OctantFieldDescription>
          {invalid === "port" ? <OctantFieldError id={`${id}-port-error`}>Choose a port between 1024 and 65535.</OctantFieldError> : null}
        </OctantField>
      </OctantFieldGroup>
      {failure === undefined ? null : <OctantAlert tone="warning">{failure}</OctantAlert>}
      <OctantButton aria-busy={busy} disabled={props.disabled || busy} size="sm" type="submit">Save Google setup</OctantButton>
    </form>
  );
}
