import {
  ShieldServersClientFailure,
  type ShieldServersClient,
} from "@octant/client-runtime/shield-servers-client";
import type {
  MemberBuildDownload,
  MemberBuildDownloadRefusal,
} from "@octant/contracts/shield-servers";
import { useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";

/** How often the sheet reads a running download. */
const DOWNLOAD_POLL_MS = 1_000;

type StageState = "waiting" | "running" | "succeeded" | "failed";

const STATE_LABELS: Readonly<Record<StageState, string>> = {
  waiting: "Waiting",
  running: "Running…",
  succeeded: "Done",
  failed: "Failed",
};

/** Refusals that stop the download before any byte is kept; the rest fail its checks. */
const DOWNLOAD_REFUSALS: ReadonlySet<MemberBuildDownloadRefusal> = new Set([
  "unreachable",
  "no-release",
  "no-newer-release",
]);

function stagesOf(download: MemberBuildDownload): readonly [StageState, StageState, StageState] {
  switch (download.state) {
    case "downloading":
      return ["running", "waiting", "waiting"];
    case "verifying":
      return ["succeeded", "running", "waiting"];
    case "ready":
      return ["succeeded", "succeeded", "succeeded"];
    case "refused":
      return download.refusal !== undefined && DOWNLOAD_REFUSALS.has(download.refusal)
        ? ["failed", "waiting", "waiting"]
        : ["succeeded", "failed", "waiting"];
  }
}

/**
 * No suitable build is on this computer, so the host is downloading one from
 * its ring: downloading, verifying, ready. Reads the download every second
 * until it ends; once it is ready the sheet reads its plan again, and a
 * refusal says where to place a build by hand.
 */
export function MemberBuildDownloadStatus(props: {
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly download: MemberBuildDownload;
  readonly onReady: () => void;
}) {
  const { onReady } = props;
  // Settings hands a fresh `client` object on every render; the effects read
  // the latest one through this ref and are keyed on the download alone, so a
  // re-render never tells the host this sheet stopped reading.
  const client = useRef(props.client);
  client.current = props.client;
  const [download, setDownload] = useState(props.download);
  const running = download.state === "downloading" || download.state === "verifying";

  const [stopped, setStopped] = useState<string | undefined>(undefined);

  // The host asks the release feed only while a sheet is open, so closing
  // the sheet mid-download tells the host this sheet stopped reading; the
  // download stops once no open sheet reads it.
  const stillRunning = useRef(running);
  stillRunning.current = running;
  const downloadId = download.downloadId;
  useEffect(
    () => () => {
      if (!stillRunning.current) return;
      client.current
        .memberInstall({ kind: "leave-member-build-download", downloadId })
        .catch(() => undefined);
    },
    [downloadId],
  );

  useEffect(() => {
    if (!running || stopped !== undefined) return;
    // A failed read (a paired device briefly offline) reads again on the next
    // tick instead of leaving the sheet on "Running…"; the host refusing this
    // window does not pass by waiting, so it ends the polling and says so.
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(() => {
        client.current
          .memberInstall({ kind: "read-member-build-download", downloadId: download.downloadId })
          .then(
            (result) => {
              if (!current) return;
              if (result.kind === "member-build-download") setDownload(result.download);
              else if (result.kind === "member-install-refused") setStopped(result.message);
              else poll();
            },
            (error: unknown) => {
              if (!current) return;
              if (
                error instanceof ShieldServersClientFailure &&
                (error.status === 401 || error.status === 403)
              ) {
                setStopped(
                  "This computer no longer accepts this window, so the download cannot be read here.",
                );
              } else {
                poll();
              }
            },
          );
      }, DOWNLOAD_POLL_MS);
    };
    poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [download, running, stopped]);

  const ready = download.state === "ready";
  useEffect(() => {
    if (ready) onReady();
    // Read the plan once per download that became ready.
  }, [ready]);

  const [fetched, verified, done] = stagesOf(download);
  const version = download.version === undefined ? "" : ` ${download.version}`;
  const stages: ReadonlyArray<readonly [string, StageState, string]> = [
    [
      "download",
      fetched,
      `Download Octant${version} for ${download.target} from the ${download.ring} release`,
    ],
    [
      "verify",
      verified,
      "Verify the release's signed listing, the digest and the build's signature",
    ],
    ["ready", done, "Ready"],
  ];
  return (
    <>
      <p className="member-install__note">
        No suitable signed Octant build for {download.target} is on this computer, so Octant is
        downloading one from the release this computer follows.
      </p>
      <ol aria-label="Download" className="member-install__steps">
        {stages.map(([key, state, label]) => (
          <li data-state={state} key={key}>
            <span className="member-install__step-name">{label}</span>
            <span className="member-install__step-state">{STATE_LABELS[state]}</span>
          </li>
        ))}
      </ol>
      {stopped !== undefined ? <OctantAlert tone="danger">{stopped}</OctantAlert> : null}
      {download.state === "refused" && download.message !== undefined ? (
        <OctantAlert tone="danger">{download.message}</OctantAlert>
      ) : null}
    </>
  );
}
