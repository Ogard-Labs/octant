import { useEffect, useId, useRef, useState } from "react";
import type { ServerProjectsClient } from "@octant/client-runtime";
import type {
  ServerProject,
  ServerPreviewView,
  ServerProjectListenerList,
} from "@octant/contracts/server-projects";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";

export type ServerProjectRelayedPreviewOpener = (
  view: ServerPreviewView,
) => Promise<
  | { readonly kind: "opened"; readonly notice?: string }
  | { readonly kind: "refused"; readonly message: string }
>;

export function ServerProjectPreviewTunnel(props: {
  readonly project: ServerProject;
  readonly client: Pick<ServerProjectsClient, "previewRead" | "previewCommand" | "listeners">;
  /** Opens a host-relayed preview through the paired desktop app's signed forwarder. */
  readonly onOpenRelayedPreview?: ServerProjectRelayedPreviewOpener;
}) {
  const { project, client } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const sequence = useRef(0);
  const [remotePort, setRemotePort] = useState("5173");
  const [localPort, setLocalPort] = useState("0");
  const [view, setView] = useState<ServerPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [serving, setServing] = useState<ServerProjectListenerList>();
  // What the login serves from this Project's folder, read on the server once
  // the panel opens, so a preview is one click instead of a typed port.
  useEffect(() => {
    if (!open || client.listeners === undefined) return;
    let active = true;
    void client.listeners(String(project.id)).then(
      (listed) => {
        if (active) setServing(listed);
      },
      () => {
        if (active) setServing({ status: "unavailable", message: "The server could not be read." });
      },
    );
    return () => {
      active = false;
    };
  }, [client, project.id, open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      const observed = sequence.current;
      try {
        const next = await client.previewRead?.(String(project.id));
        if (active && observed === sequence.current) {
          setView(next ?? null);
        }
      } catch {
        if (active && observed === sequence.current)
          setProblem("Preview status is unavailable. Refresh before trying again.");
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, project.id, open]);
  if (client.previewCommand === undefined || client.previewRead === undefined) return null;
  async function command(kind: "start" | "stop" | "reconnect", port: string = remotePort) {
    if (client.previewCommand === undefined) return;
    sequence.current += 1;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.previewCommand(
        kind === "start"
          ? {
              kind,
              projectId: project.id,
              remotePort: Number(port),
              localPort: Number(localPort),
            }
          : { kind, projectId: project.id },
      );
      sequence.current += 1;
      if (result.kind === "tunnel") setView(result.view);
      else
        setProblem(
          `Preview refused: ${result.reason}. Check the selected Project, ports, and SSH trust.`,
        );
    } catch {
      setProblem("The preview request lost its reply. Check status before retrying.");
    } finally {
      sequence.current += 1;
      setBusy(false);
    }
  }
  const running = view !== null && view.status !== "stopped" && view.status !== "revoked";
  const localPortValid =
    /^\d+$/.test(localPort) && Number(localPort) >= 0 && Number(localPort) <= 65535;
  const valid =
    /^\d+$/.test(remotePort) &&
    Number(remotePort) > 0 &&
    Number(remotePort) <= 65535 &&
    localPortValid;
  // Only a window on this computer is given the listing; a paired device's
  // preview is relayed through a signed route, not a local TCP port.
  const localWindow = client.listeners !== undefined;
  return (
    <OctantCollapsible
      className="w-full min-w-0"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      summary="Dev server preview"
    >
      <p className="shield-servers__note">
        Open a port already running on this server. If this computer is paired with it, use its
        existing paired-host preview.
      </p>
      <p className="shield-servers__note">
        The remote endpoint is 127.0.0.1 on this Project's server. Opening a preview does not start
        the dev server.
        {localWindow
          ? " Any TCP service works, not only web pages: a database on the server is reached at the local address with its own client."
          : null}
      </p>
      {localWindow ? (
        <p className="shield-servers__note">
          The local address is 127.0.0.1 on this computer. Agents' guarded commands can't reach it
          unless you allow that port for a thread; a Full access thread, and a provider that reaches
          this computer's own ports, can reach it as they can any local service.
        </p>
      ) : null}
      {serving === undefined ? null : serving.status === "unavailable" ? (
        <p className="shield-servers__note">{serving.message}</p>
      ) : serving.listeners.length === 0 ? (
        <p className="shield-servers__note">Nothing is listening from this Project's folder.</p>
      ) : (
        <ul aria-label="Running on the server" className="shield-servers__list">
          {serving.listeners.map((listener) => (
            <li key={listener.port}>
              <span>
                {listener.processName} on port {listener.port}
                {listener.loopbackReachable
                  ? null
                  : " · not on 127.0.0.1, so it can't be previewed"}
              </span>
              {listener.loopbackReachable ? (
                <OctantButton
                  aria-label={`Preview ${listener.processName} on port ${String(listener.port)}`}
                  disabled={busy || running || !localPortValid}
                  onClick={() => {
                    setRemotePort(String(listener.port));
                    void command("start", String(listener.port));
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Preview
                </OctantButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="shield-servers__form">
        <div className="host-settings__field">
          <label htmlFor={`${id}-remote`}>Remote port</label>
          <OctantInput
            id={`${id}-remote`}
            inputMode="numeric"
            value={remotePort}
            disabled={busy || running}
            onChange={(event) => setRemotePort(event.currentTarget.value)}
          />
        </div>
        <div className="host-settings__field">
          <label htmlFor={`${id}-local`}>Local port, 0 chooses an available port</label>
          <OctantInput
            id={`${id}-local`}
            inputMode="numeric"
            value={localPort}
            disabled={busy || running}
            onChange={(event) => setLocalPort(event.currentTarget.value)}
          />
        </div>
      </div>
      <div role="status" aria-live="polite">
        {view === null ? (
          "No preview owned by this window."
        ) : view.localPort === 0 && view.grantId !== undefined ? (
          <p className="shield-servers__note">
            {view.status === "listening"
              ? props.onOpenRelayedPreview !== undefined
                ? "Relayed through this host's private listener. The remote connection is checked when opened."
                : "Relayed through this host's private listener. Open this preview from Octant's desktop app, which signs each proxied request on an isolated origin."
              : `Preview ${view.status}.`}{" "}
            Remote 127.0.0.1:{view.remotePort}. Relay {view.endpoint}.
          </p>
        ) : (
          <p className="shield-servers__note">
            {view.status === "listening"
              ? "Listening locally. The remote connection is checked when opened."
              : `Preview ${view.status}.`}{" "}
            Remote 127.0.0.1:{view.remotePort}. Local {view.endpoint}.
          </p>
        )}
        {problem === undefined ? null : <p>{problem}</p>}
      </div>
      {view?.status === "listening" ? (
        view.localPort === 0 && view.grantId !== undefined ? (
          props.onOpenRelayedPreview !== undefined ? (
            <OctantButton
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setProblem(undefined);
                void props
                  .onOpenRelayedPreview?.(view)
                  .then((outcome) => {
                    if (outcome?.kind === "refused") setProblem(outcome.message);
                    else if (outcome?.notice !== undefined) setProblem(outcome.notice);
                  })
                  .catch(() => setProblem("The relayed preview could not be opened."))
                  .finally(() => setBusy(false));
              }}
              type="button"
              size="sm"
            >
              Open preview
            </OctantButton>
          ) : null
        ) : (
          <a href={view.endpoint} target="_blank" rel="noreferrer">
            Open preview
          </a>
        )
      ) : null}
      {running ? (
        <>
          {view.status === "lost" ? (
            <OctantButton
              disabled={busy}
              onClick={() => {
                void command("reconnect");
              }}
              type="button"
              size="sm"
            >
              Reconnect same endpoint
            </OctantButton>
          ) : null}
          <OctantButton
            disabled={busy}
            onClick={() => {
              void command("stop");
            }}
            type="button"
            size="sm"
          >
            Stop preview
          </OctantButton>
        </>
      ) : (
        <OctantButton
          disabled={busy || !valid}
          onClick={() => {
            void command("start");
          }}
          type="button"
          size="sm"
        >
          Start preview
        </OctantButton>
      )}
    </OctantCollapsible>
  );
}
