import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { decodeCodeTerminalId, type CodeTerminalId, type ProjectId } from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { ZenProjectTerminalCard } from "../zen/ZenProjectTerminalCard";

interface OwnedSession {
  readonly terminalId: CodeTerminalId;
  readonly projectId: ProjectId;
  readonly client: ProjectTerminalClient;
  closed: boolean;
}

function stop(session: OwnedSession) {
  return session.client
    .execute({
      kind: "stop",
      projectId: session.projectId,
      terminalId: session.terminalId,
    })
    .catch(() => undefined);
}

/** This panel owns only the SSH session opened by its explicit person action. */
export function ServerWorkProjectTerminal(props: {
  readonly client: ProjectTerminalClient;
  readonly projectId: ProjectId;
  readonly login: string;
  readonly folder: string;
}) {
  const owned = useRef<OwnedSession | undefined>(undefined);
  const [terminalId, setTerminalId] = useState<CodeTerminalId>();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [closed, setClosed] = useState(false);

  useEffect(
    () => () => {
      const session = owned.current;
      if (session !== undefined) {
        session.closed = true;
        void stop(session);
      }
    },
    [props.client, props.projectId],
  );

  function open() {
    if (owned.current !== undefined && !owned.current.closed) return;
    const session: OwnedSession = {
      terminalId: decodeCodeTerminalId(crypto.randomUUID()),
      projectId: props.projectId,
      client: props.client,
      closed: false,
    };
    owned.current = session;
    setOpening(true);
    setClosed(false);
    setFailure(undefined);
    void session.client
      .execute({
        kind: "start",
        projectId: session.projectId,
        terminalId: session.terminalId,
        columns: 100,
        rows: 24,
      })
      .then((result) => {
        // An awaited acquisition can finish after the panel has closed. It still
        // belongs to this panel, so join its stop rather than displaying it again.
        if (session.closed) return stop(session);
        setOpening(false);
        if (result.kind === "project-terminal") setTerminalId(session.terminalId);
        else {
          setFailure(
            result.kind === "project-terminal-refused"
              ? result.message
              : "This terminal is unavailable.",
          );
          session.closed = true;
          void stop(session);
        }
      })
      .catch(() => {
        if (session.closed) return;
        setOpening(false);
        setFailure(
          "The SSH start could not be confirmed. Nothing was retried; check the server before opening another session.",
        );
        session.closed = true;
        void stop(session);
      });
  }

  function close() {
    const session = owned.current;
    if (session === undefined) return;
    session.closed = true;
    void stop(session);
    setTerminalId(undefined);
    setOpening(false);
    setClosed(true);
  }

  return (
    <div className="basis-full min-w-0">
      <p>
        <span className="break-all">
          {props.login}:{props.folder}
        </span>{" "}
        · Your SSH shell has Full access on this server.
      </p>
      {opening || terminalId !== undefined ? (
        <>
          <div className="shield-servers__row-actions min-w-0 max-w-full flex-wrap">
            <OctantButton type="button" size="sm" variant="ghost" onClick={close}>
              Close terminal
            </OctantButton>
          </div>
          <p>Full remote SSH shell, operated by you. It does not change any task's access.</p>
          {terminalId === undefined ? (
            <p role="status">Opening SSH session…</p>
          ) : (
            <div className="relative h-[20rem] min-h-0 w-full min-w-0 overflow-hidden">
              <div className="absolute inset-0 min-h-0 min-w-0">
                <ZenProjectTerminalCard
                  key={terminalId}
                  client={props.client}
                  projectId={props.projectId}
                  terminalId={terminalId}
                  live
                  serverConnection
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <OctantButton type="button" size="sm" variant="ghost" onClick={open}>
          Open terminal
        </OctantButton>
      )}
      {failure === undefined ? null : <OctantAlert tone="warning">{failure}</OctantAlert>}
      {closed ? (
        <p role="status">
          SSH session close requested. Programs may still be running on the server.
        </p>
      ) : null}
    </div>
  );
}
