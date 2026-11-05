import { OctantAlert } from "../ui/base/OctantAlert";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createCommandCredentialsClient,
  type CommandCredentialsClient,
} from "@octant/client-runtime/command-credentials-client";
import {
  decodeCommandCredentialCommand,
  type CommandCredentialCommand,
  type CommandCredentialReceipt,
  type CommandCredentialView,
} from "@octant/contracts/command-credentials";
import { OctantButton } from "../ui/base/OctantButton";
import "./credentialRequests.css";

export function CommandCredentialRequests(props: {
  readonly threadId: string;
  readonly projectId: string | undefined;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly client?: CommandCredentialsClient;
}) {
  const client = useMemo(() => {
    if (props.client !== undefined) return props.client;
    if (props.serverUrl === undefined || props.windowCapability === undefined) return undefined;
    try {
      return createCommandCredentialsClient({
        baseUrl: props.serverUrl,
        windowCapability: props.windowCapability,
        fetch: globalThis.fetch,
      });
    } catch {
      return undefined;
    }
  }, [props.client, props.serverUrl, props.windowCapability]);
  const identity = useRef({ client, projectId: props.projectId, threadId: props.threadId });
  if (
    identity.current.client !== client ||
    identity.current.projectId !== props.projectId ||
    identity.current.threadId !== props.threadId
  )
    identity.current = { client, projectId: props.projectId, threadId: props.threadId };
  const [view, setView] = useState<CommandCredentialView>();
  const [receipt, setReceipt] = useState<CommandCredentialReceipt>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setView(undefined);
    setReceipt(undefined);
    setMessage(undefined);
    setBusy(false);
    const refresh = async () => {
      if (client === undefined || props.projectId === undefined) return;
      try {
        const result = await client.read(props.projectId, abort.signal, props.threadId);
        if (!abort.signal.aborted) {
          if (result.kind === "command-credential-view") {
            setView(result);
            // A lost approval reply or a task switch clears the shown receipt while the
            // server still holds this thread's outcome; show its newest one rather than
            // offering another run with the earlier exit status and effects hidden.
            setReceipt((previous) =>
              previous !== undefined &&
              result.receipts.some((current) => current.requestId === previous.requestId)
                ? previous
                : result.receipts.at(-1),
            );
            setMessage(undefined);
          } else {
            setView(undefined);
            setReceipt(undefined);
            if (result.kind === "command-credential-refused") setMessage(result.message);
          }
        }
      } catch {
        if (!abort.signal.aborted) {
          setView(undefined);
          setReceipt(undefined);
          setMessage(
            "Credential command status is unavailable. Do not assume an earlier process stopped.",
          );
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [client, props.projectId, props.threadId]);
  const send = async (command: CommandCredentialCommand) => {
    if (client === undefined) return;
    const captured = identity.current;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await client.execute(command);
      if (identity.current !== captured) return;
      if (result.kind === "command-credential-view") {
        setView(result);
        setReceipt(undefined);
      } else if (result.kind === "command-credential-receipt") setReceipt(result);
      else {
        setMessage(result.message);
        setView(undefined);
        setReceipt(undefined);
      }
    } catch {
      if (identity.current !== captured) return;
      setMessage(
        "The result could not be confirmed. Refresh before requesting another run; an earlier process may still have effects.",
      );
      setReceipt(undefined);
    } finally {
      if (identity.current === captured) setBusy(false);
    }
  };
  if (client === undefined || props.projectId === undefined) return null;
  const requests =
    view?.requests.filter((request) => String(request.threadId) === props.threadId) ?? [];
  return (
    <details className="credential-requests">
      <summary>Credential commands{requests.length > 0 ? " · Review required" : ""}</summary>
      <p>
        Saved commands for this Code Project. Each run needs current Full access and a separate
        human approval. Other access levels are unsupported here.
      </p>
      {view?.bindings.length === 0 ? (
        <p>Save a fixed binding in Settings → Secret stores.</p>
      ) : null}
      {view?.bindings.map((binding) => (
        <div className="credential-request-result" key={binding.bindingId}>
          <span>{binding.definition.label}</span>
          <OctantButton
            variant="secondary"
            disabled={busy || requests.length > 0}
            onClick={() =>
              void send(
                decodeCommandCredentialCommand({
                  kind: "review",
                  bindingId: binding.bindingId,
                  threadId: props.threadId,
                  operationId: crypto.randomUUID(),
                }),
              )
            }
          >
            Review {binding.definition.label}
          </OctantButton>
        </div>
      ))}
      {requests.map((request) => (
        <section
          className="credential-request-card command-credential-card"
          key={request.requestId}
          aria-label={`Review ${request.binding.definition.label}`}
        >
          <h3>{request.binding.definition.label}</h3>
          <code className="credential-request-code">
            {request.binding.definition.executable}{" "}
            {request.binding.definition.args.map((arg) => JSON.stringify(arg)).join(" ")}
          </code>
          <p>
            Directory: {request.binding.definition.directory || "Project root"} · Limit{" "}
            {request.binding.definition.timeoutMs / 1000}s
          </p>
          <p>
            Account {request.binding.definition.accountId} · {request.binding.credentialExecutable}{" "}
            ({request.binding.credentialVersion})
          </p>
          <ul>
            {request.binding.definition.environment.map((field) => (
              <li key={field.name}>
                <code className="credential-request-code">
                  {field.name}=op://{field.vaultId}/{field.itemId}/
                  {field.sectionId === undefined ? "" : `${field.sectionId}/`}
                  {field.fieldId}
                </code>
              </li>
            ))}
          </ul>
          <p>
            This executable and its descendants receive the credentials and ordinary Full access,
            including network access. Output masking cannot prevent deliberate disclosure. Approval
            expires at {new Date(request.expiresAt).toLocaleTimeString()} if the process has not
            started. A fresh request does not mean an earlier process stopped.
          </p>
          <div className="credential-request-card__actions command-credential-actions">
            {request.state === "pending" ? (
              <>
                <OctantButton
                  disabled={busy}
                  onClick={() => void send({ kind: "approve", requestId: request.requestId })}
                >
                  Approve one run
                </OctantButton>
                <OctantButton
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void send({ kind: "deny", requestId: request.requestId })}
                >
                  Deny
                </OctantButton>
              </>
            ) : null}
            <OctantButton
              variant="secondary"
              onClick={() => void send({ kind: "cancel", requestId: request.requestId })}
            >
              Cancel command
            </OctantButton>
          </div>
        </section>
      ))}
      {receipt === undefined ? null : (
        <section className="credential-request-card command-credential-card" role="status">
          <strong>
            {receipt.status}
            {receipt.exitCode === undefined ? "" : ` · Exit ${receipt.exitCode}`}
          </strong>
          <p>Effect: {receipt.effect}. Cancellation cannot undo completed effects.</p>
          {receipt.output ? <pre className="credential-request-code">{receipt.output}</pre> : null}
          {receipt.truncated ? <p>Output was truncated.</p> : null}
        </section>
      )}
      {message === undefined ? null : <OctantAlert tone="danger">{message}</OctantAlert>}
    </details>
  );
}
