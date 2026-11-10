import type { ServerProjectsClient } from "@octant/client-runtime/server-projects-client";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type {
  RemoteSetupCheckReason,
  RemoteSetupCheckResult,
} from "@octant/contracts/remote-setup";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { useEffect, useId, useRef, useState } from "react";
import type { PrivateListenerPublicStatus } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { RemoteSetupIntent } from "./RemoteSetupGuide";

const REMEDIES: Readonly<Record<RemoteSetupCheckReason, string>> = {
  ready:
    "The read-only SSH check completed. This proves this connection only; no task was started.",
  "needs-local-window":
    "Run server checks in the Octant window on the host. A paired client cannot administer its servers.",
  "server-not-registered": "Register this server under Access › Servers before checking it.",
  "registration-changed":
    "The registered server changed during the check. Inspect its alias and login user, then check again.",
  "missing-agent":
    "No SSH agent is available to Octant. Start or unlock your agent on the Octant host and load the intended key, then check again.",
  "authentication-refused":
    "SSH could not authenticate. Check the agent's loaded key and the registered login user on the Octant host. Never paste a private key into a task.",
  "kept-key-unsupported":
    "This check uses the host's SSH agent. It cannot verify a key Octant keeps. Use the existing server key controls; no key was created or changed.",
  "unknown-identity":
    "SSH reports an unknown server identity. Make your own first SSH connection on the Octant host and verify its fingerprint independently, then check again. Octant cannot accept it for you.",
  "changed-identity":
    "SSH reports a changed or revoked server identity. Stop and verify the change with the server administrator before correcting your known hosts. Octant has accepted nothing.",
  "host-unavailable":
    "The server did not answer this check. Check its address, network and awake state, then check again. No uncertain command is restarted.",
  "directory-unavailable":
    "SSH answered, but that directory could not be opened. Correct the absolute path or its access on the server, then check again.",
  "unsupported-runtime":
    "Server Projects use Octant Harness. Native provider runtimes run on the Octant host and cannot execute this server Project. Choose Octant Harness; this does not test a provider installation.",
  "probe-unavailable":
    "The server did not return the expected POSIX shell and directory response. Check that its login can run sh and pwd. No task was started.",
  cancelled:
    "The check stopped. Its last result does not establish connectivity. Check again when ready.",
  busy: "Other setup checks are still finishing. Wait briefly, then check again.",
};

type Phase = "idle" | "checking" | "reconnecting" | "connected" | "disconnected" | "stopped";
export function RemoteSetupChecks(props: {
  readonly intent: RemoteSetupIntent;
  readonly client?: Pick<ServerProjectsClient, "check"> | undefined;
  readonly servers?: Pick<ShieldServersClient, "read"> | undefined;
  readonly readHostStatus?: (() => Promise<PrivateListenerPublicStatus>) | undefined;
}) {
  const id = useId();
  const [servers, setServers] = useState<ReadonlyArray<ShieldServer>>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [serverId, setServerId] = useState("");
  const [folder, setFolder] = useState("");
  const [runtime, setRuntime] = useState("octant-harness");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<RemoteSetupCheckResult>();
  const [hostMessage, setHostMessage] = useState<string>();
  const active = useRef<AbortController>(undefined);
  const sequence = useRef(0);
  const host = props.intent === "control-host";
  const busy = phase === "checking" || phase === "reconnecting";
  const invalidate = () => {
    sequence.current++;
    active.current?.abort();
    active.current = undefined;
    setResult(undefined);
    setHostMessage(undefined);
    setPhase("idle");
  };
  useEffect(() => {
    if (host || props.servers === undefined) return;
    const abort = new AbortController();
    let current = true;
    const timer = setTimeout(() => {
      abort.abort();
      if (current) setLoadFailed(true);
    }, 5_000);
    void props.servers
      .read(undefined, abort.signal)
      .then((view) => {
        if (!current || abort.signal.aborted) return;
        setServers(view.servers);
        setServerId((current) =>
          view.servers.some((entry) => String(entry.serverId) === current) ? current : "",
        );
        setLoadFailed(false);
      })
      .catch(() => {
        if (current) setLoadFailed(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      current = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [host, props.servers, registryRevision]);
  useEffect(
    () => () => {
      sequence.current++;
      active.current?.abort();
    },
    [],
  );

  const run = async () => {
    if (busy) return;
    const selected = servers?.find((entry) => String(entry.serverId) === serverId);
    if (!host && (selected === undefined || props.client?.check === undefined)) return;
    const attempt = ++sequence.current;
    const abort = new AbortController();
    active.current = abort;
    setPhase(phase === "disconnected" || phase === "stopped" ? "reconnecting" : "checking");
    setResult(undefined);
    setHostMessage(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve("timeout");
        }, 15_000);
      });
      if (host) {
        const read = props.readHostStatus;
        if (read === undefined) return;
        const answer = await Promise.race([read(), timeout]);
        if (sequence.current !== attempt) return;
        const ready = answer !== "timeout" && answer.enabled && answer.state === "ready";
        setPhase(ready ? "connected" : "stopped");
        setHostMessage(
          ready
            ? "The host reports its private listener ready now. Pair a device through the existing controls to verify access from that device; this is not a remote reachability test."
            : "The host listener is stopped or unavailable. Check its network and awake state, then use the listener controls below. Rechecking does not enable or restart it.",
        );
      } else if (selected !== undefined && props.client?.check !== undefined) {
        const answer = await Promise.race([
          props.client.check(
            {
              serverId: selected.serverId,
              runtime: runtime === "octant-harness" ? "octant-harness" : "native-provider",
              ...(props.intent === "server-folder" ? { folder: folder.trim() } : {}),
            },
            abort.signal,
          ),
          timeout,
        ]);
        if (sequence.current !== attempt) return;
        const checked: RemoteSetupCheckResult =
          answer === "timeout" ? { status: "disconnected", reason: "host-unavailable" } : answer;
        setResult(checked);
        setPhase(checked.status);
      }
    } catch {
      if (sequence.current !== attempt) return;
      setPhase("disconnected");
      setHostMessage(
        "The Octant host could not answer. Check that it is running, awake and reachable, then recheck. No task or command is restarted.",
      );
    } finally {
      clearTimeout(timer);
      if (sequence.current === attempt) active.current = undefined;
    }
  };
  return (
    <div className="remote-setup__details" aria-label="Read-only setup checks">
      <p>Check readiness without starting a task or changing registration, keys or SSH trust.</p>
      {host ? null : (
        <ol className="remote-setup__steps">
          <li>Check registration, runtime support and the host’s SSH agent.</li>
          <li>
            Open a fresh SSH connection with strict identity checking and noninteractive
            authentication.
          </li>
          <li>
            Read the server’s current directory
            {props.intent === "server-folder" ? " after opening the directory below" : ""}.
          </li>
        </ol>
      )}
      {host ? (
        props.readHostStatus === undefined ? (
          <p>
            Host readiness checks need the Octant desktop window on that host. Open its Remote
            access settings and check the listener there.
          </p>
        ) : null
      ) : (
        <>
          {props.servers === undefined ? (
            <p>
              Server registration is unavailable in this client. Use the Octant window on the host.
            </p>
          ) : loadFailed ? (
            <OctantAlert tone="danger">
              The Octant host could not load registered servers. Reload to recheck; no SSH
              connection was started.
            </OctantAlert>
          ) : servers === undefined ? (
            <p>Loading registered servers…</p>
          ) : servers.length === 0 ? (
            <p>Register a server under Access › Servers, then return here to check it.</p>
          ) : (
            <>
              <div className="host-settings__field">
                <label htmlFor={`${id}-server`}>Registered server to check</label>
                <OctantSelectField
                  id={`${id}-server`}
                  value={serverId}
                  placeholder="Choose a server"
                  options={servers.map((entry) => ({
                    id: String(entry.serverId),
                    label: `${entry.user}@${entry.alias}`,
                  }))}
                  onValueChange={(value) => {
                    invalidate();
                    setServerId(value);
                  }}
                  disabled={busy}
                />
              </div>
              {props.intent === "server-folder" ? (
                <>
                  <div className="host-settings__field">
                    <label htmlFor={`${id}-folder`}>Directory to check on the server</label>
                    <OctantInput
                      id={`${id}-folder`}
                      value={folder}
                      onChange={(event) => {
                        invalidate();
                        setFolder(event.currentTarget.value);
                      }}
                      placeholder="/srv/website"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                    />
                  </div>
                  <div className="host-settings__field">
                    <label htmlFor={`${id}-runtime`}>Runtime for this server Project</label>
                    <OctantSelectField
                      id={`${id}-runtime`}
                      value={runtime}
                      options={[
                        { id: "octant-harness", label: "Octant Harness" },
                        { id: "native-provider", label: "Native provider runtime" },
                      ]}
                      onValueChange={(value) => {
                        invalidate();
                        setRuntime(value);
                      }}
                      disabled={busy}
                    />
                  </div>
                </>
              ) : null}
            </>
          )}
          {props.client?.check === undefined ? (
            <p>
              Read-only connection checks are unavailable from this host version or client. Use the
              existing server controls; no connection has been proved.
            </p>
          ) : null}
        </>
      )}
      <div className="shield-servers__actions">
        {!host && props.servers !== undefined ? (
          <OctantButton
            size="sm"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              invalidate();
              setLoadFailed(false);
              setServers(undefined);
              setRegistryRevision((value) => value + 1);
            }}
          >
            Reload registered servers
          </OctantButton>
        ) : null}
        <OctantButton
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => void run()}
          disabled={
            busy ||
            (host
              ? props.readHostStatus === undefined
              : props.client?.check === undefined ||
                serverId === "" ||
                (props.intent === "server-folder" && !folder.trim().startsWith("/")))
          }
        >
          {phase === "idle" ? "Run read-only checks" : "Recheck read-only"}
        </OctantButton>
        {busy ? (
          <OctantButton
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              sequence.current++;
              active.current?.abort();
              active.current = undefined;
              setPhase("stopped");
              setResult({ status: "stopped", reason: "cancelled" });
            }}
          >
            Stop check
          </OctantButton>
        ) : null}
      </div>
      <div aria-live="polite" aria-busy={busy}>
        <p>
          {phase === "idle"
            ? "Not checked"
            : phase === "checking"
              ? "Checking prerequisites and a fresh connection…"
              : phase === "reconnecting"
                ? "Reconnecting for a read-only check…"
                : phase === "connected"
                  ? host
                    ? "Host readiness checked"
                    : "Connected for this check"
                  : phase === "disconnected"
                    ? "Disconnected"
                    : "Stopped"}
        </p>
        {result === undefined ? null : <p>{REMEDIES[result.reason]}</p>}
        {result?.folder === undefined ? null : (
          <p>
            Server directory: <code>{result.folder}</code>
          </p>
        )}
        {hostMessage === undefined ? null : <p>{hostMessage}</p>}
      </div>
    </div>
  );
}
