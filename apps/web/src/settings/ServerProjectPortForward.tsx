import { useEffect, useId, useRef, useState } from "react";
import type { ServerProjectsClient } from "@octant/client-runtime";
import type { ServerProject, ServerPortForwardView } from "@octant/contracts/server-projects";
import { remoteForwardNote } from "../home/runningServices";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { OctantInput } from "../ui/base/OctantInput";

/**
 * Forwards any TCP port on a server Project's server, such as a database, to
 * this computer's loopback as raw TCP. Unlike the dev-server preview it opens
 * no page, so nothing checks that a web server answers.
 */
export function ServerProjectPortForward(props: {
  readonly project: ServerProject;
  readonly client: Pick<ServerProjectsClient, "forwardRead" | "forwardCommand">;
}) {
  const { project, client } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const sequence = useRef(0);
  const [remotePort, setRemotePort] = useState("");
  const [view, setView] = useState<ServerPortForwardView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      const observed = sequence.current;
      try {
        const next = await client.forwardRead?.(String(project.id));
        if (active && observed === sequence.current) setView(next ?? null);
      } catch {
        if (active && observed === sequence.current)
          setProblem("Forward status is unavailable. Refresh before trying again.");
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
  if (client.forwardCommand === undefined || client.forwardRead === undefined) return null;
  async function command(kind: "start" | "stop") {
    if (client.forwardCommand === undefined) return;
    sequence.current += 1;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.forwardCommand(
        kind === "start"
          ? { kind, projectId: project.id, remotePort: Number(remotePort) }
          : { kind, projectId: project.id },
      );
      sequence.current += 1;
      if (result.kind === "forward") setView(result.view);
      else setProblem(`Forward refused: ${result.reason}. Check the port and SSH trust.`);
    } catch {
      setProblem("The forward request lost its reply. Check status before retrying.");
    } finally {
      sequence.current += 1;
      setBusy(false);
    }
  }
  const running = view !== null && (view.status === "listening" || view.status === "lost");
  const valid = /^\d+$/.test(remotePort) && Number(remotePort) > 0 && Number(remotePort) <= 65535;
  return (
    <OctantCollapsible
      className="w-full min-w-0"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      summary="Forward a port"
    >
      <p className="shield-servers__note">
        Reach any TCP port on 127.0.0.1 of this Project's server, such as a database, from tools on
        this computer. It ends after an hour.
      </p>
      <div className="shield-servers__form">
        <div className="host-settings__field">
          <label htmlFor={`${id}-remote`}>Port on the server</label>
          <OctantInput
            id={`${id}-remote`}
            inputMode="numeric"
            placeholder="5432"
            value={remotePort}
            disabled={busy || running}
            onChange={(event) => setRemotePort(event.currentTarget.value)}
          />
        </div>
      </div>
      <div role="status" aria-live="polite">
        {view === null || view.status === "stopped" ? null : view.status === "listening" ? (
          <p className="shield-servers__note">
            Server port {view.remotePort}. {remoteForwardNote(view.localPort)}
          </p>
        ) : (
          <p className="shield-servers__note">
            {view.status === "lost"
              ? `The connection to the server was lost, so server port ${String(view.remotePort)} is no longer forwarded.`
              : `The forward of server port ${String(view.remotePort)} ended.`}
          </p>
        )}
        {problem === undefined ? null : <p>{problem}</p>}
      </div>
      {running ? (
        <OctantButton
          disabled={busy}
          onClick={() => {
            void command("stop");
          }}
          type="button"
          size="sm"
        >
          Stop forward
        </OctantButton>
      ) : (
        <OctantButton
          disabled={busy || !valid}
          onClick={() => {
            void command("start");
          }}
          type="button"
          size="sm"
        >
          Forward port
        </OctantButton>
      )}
    </OctantCollapsible>
  );
}
