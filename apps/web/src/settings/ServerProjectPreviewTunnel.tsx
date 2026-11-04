import { useEffect, useId, useRef, useState } from "react";
import type { ServerProjectsClient } from "@octant/client-runtime";
import type { ServerProject, ServerPreviewView } from "@octant/contracts/server-projects";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export function ServerProjectPreviewTunnel(props: {
  readonly project: ServerProject;
  readonly client: Pick<ServerProjectsClient, "previewRead" | "previewCommand">;
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
  async function command(kind: "start" | "stop" | "reconnect") {
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
              remotePort: Number(remotePort),
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
  const valid =
    /^\d+$/.test(remotePort) &&
    Number(remotePort) > 0 &&
    Number(remotePort) <= 65535 &&
    /^\d+$/.test(localPort) &&
    Number(localPort) >= 0 &&
    Number(localPort) <= 65535;
  return (
    <details className="w-full min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Dev server preview</summary>
      <p className="shield-servers__note">
        Open a port already running on this server. If this computer is paired with it, use its
        existing paired-host preview.
      </p>
      <p className="shield-servers__note">
        The remote endpoint is 127.0.0.1 on this Project's server. The local address is private to
        this computer. Opening a preview does not start the dev server.
      </p>
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
        <a href={view.endpoint} target="_blank" rel="noreferrer">
          Open preview
        </a>
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
    </details>
  );
}
