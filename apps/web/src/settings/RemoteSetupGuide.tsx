import type { ServerProjectsClient } from "@octant/client-runtime/server-projects-client";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type { PrivateListenerPublicStatus } from "../shell/hostBridge";
import { RemoteSetupChecks } from "./RemoteSetupChecks";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingsPanel } from "./primitives";

export type RemoteSetupIntent = "control-host" | "server-command" | "server-folder";

const CHOICES: ReadonlyArray<{
  readonly intent: RemoteSetupIntent;
  readonly label: string;
  readonly next: string;
}> = [
  { intent: "control-host", label: "Control my Octant host", next: "Continue to pairing" },
  {
    intent: "server-command",
    label: "Run a command on a server",
    next: "Continue to server registration",
  },
  {
    intent: "server-folder",
    label: "Work in a server folder",
    next: "Continue to server Projects",
  },
];

/** Choosing a journey grants no access and starts no connection or command. */
export function RemoteSetupGuide(props: {
  readonly focusedSetting?: string | undefined;
  readonly canConfigureHost: boolean;
  readonly checks?: Pick<ServerProjectsClient, "check"> | undefined;
  readonly servers?: Pick<ShieldServersClient, "read"> | undefined;
  readonly readHostStatus?: (() => Promise<PrivateListenerPublicStatus>) | undefined;
  readonly onContinue: (intent: RemoteSetupIntent) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.focusedSetting !== "remote-setup-checks") return;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    root.current?.scrollIntoView?.({ block: "center" });
  }, [props.focusedSetting]);
  const [intent, setIntent] = useState<RemoteSetupIntent>();
  const chosen = CHOICES.find((choice) => choice.intent === intent);
  return (
    <div ref={root}>
      <SettingsPanel
        description="Choose where the work runs before connecting a device or a server."
        title="What do you want to do remotely?"
      >
        <div
          aria-label="Remote workflow"
          className="shield-servers__actions remote-setup__choices"
          role="group"
        >
          {CHOICES.map((choice) => (
            <OctantButton
              aria-pressed={intent === choice.intent}
              key={choice.intent}
              onClick={() => setIntent(choice.intent)}
              size="sm"
              type="button"
              variant={intent === choice.intent ? "secondary" : "outline"}
            >
              {choice.label}
            </OctantButton>
          ))}
        </div>
        {chosen === undefined ? null : (
          <div aria-live="polite" className="remote-setup__details">
            {intent === "control-host" ? (
              <>
                <p>Files, providers and the journal stay on the Octant host.</p>
                <ol className="remote-setup__steps">
                  <li>
                    Keep Octant running on that computer and enable its private HTTPS listener.
                  </li>
                  <li>Pair this device and confirm the request on the host.</li>
                  <li>Open a thread and read its latest message before sending a first task.</li>
                </ol>
                <p>
                  An unavailable host cannot accept work. Check its network and that it is awake;
                  reconnecting never repeats an uncertain task. Scheduled work needs its executing
                  host awake, or separately configured wake support.
                </p>
              </>
            ) : (
              <>
                <p>
                  {intent === "server-command"
                    ? "The thread and journal stay on the Octant host; the named SSH command runs on the server."
                    : "Only files and commands run on the server. Inference, approvals and the journal stay on the Octant host."}
                </p>
                <ol className="remote-setup__steps">
                  <li>
                    Register the server's SSH alias and login user under Access › Servers.
                    Registration does not test a connection.
                  </li>
                  <li>
                    Verify its identity with your own first SSH connection. Octant refuses unknown
                    or changed host keys; it cannot accept them for you. Resolve a changed identity
                    with the server administrator before reconnecting.
                  </li>
                  <li>
                    Have your SSH agent available on the Octant host. A missing agent or an
                    unavailable key needs fixing there; never paste a private key into a task.
                  </li>
                  {intent === "server-command" ? (
                    <li>
                      Ask a Work or Code task to run a read-only check such as <code>pwd</code> on
                      the registered server, then inspect the host and result.
                    </li>
                  ) : (
                    <li>
                      Bind an absolute server folder below the registry. The host checks that folder
                      over SSH; a missing folder must be corrected there. Open the Project and use
                      Octant Harness for a first read-only task that lists its files.
                    </li>
                  )}
                </ol>
                {intent !== "server-folder" ? null : (
                  <p>
                    Saved actions, extra folders, Project-level guardrail/reviewer settings and some
                    Work panes are unavailable for server Projects. Thread and account levels still
                    apply. Other provider runtimes act on this host and cannot run a server
                    Project's task.
                  </p>
                )}
                <p>
                  After a dropped connection, inspect the last run's status and reconnect
                  explicitly. Never repeat a command whose result is uncertain. The Octant host and
                  server must both be awake for scheduled server work.
                </p>
              </>
            )}
            <RemoteSetupChecks
              key={chosen.intent}
              intent={chosen.intent}
              client={props.checks}
              servers={props.servers}
              readHostStatus={props.readHostStatus}
            />
            {intent === "control-host" && !props.canConfigureHost ? (
              <p>
                Open Settings › Remote access in the Octant desktop app on the host. Listener and
                pairing controls are unavailable in this client.
              </p>
            ) : (
              <OctantButton onClick={() => props.onContinue(chosen.intent)} size="sm" type="button">
                {chosen.next}
              </OctantButton>
            )}
          </div>
        )}
      </SettingsPanel>
    </div>
  );
}
