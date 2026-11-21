import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type {
  MemberBuildDownload,
  MemberBuildDownloadRefusal,
} from "@octant/contracts/shield-servers";
import { useEffect, useState } from "react";
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
  const { client, onReady } = props;
  const [download, setDownload] = useState(props.download);
  const running = download.state === "downloading" || download.state === "verifying";

  useEffect(() => {
    if (!running) return;
    let current = true;
    const timer = setTimeout(() => {
      void client
        .memberInstall({ kind: "read-member-build-download", downloadId: download.downloadId })
        .then((result) => {
          if (current && result.kind === "member-build-download") setDownload(result.download);
        })
        .catch(() => undefined);
    }, DOWNLOAD_POLL_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, download, running]);

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
      {download.state === "refused" && download.message !== undefined ? (
        <OctantAlert tone="danger">{download.message}</OctantAlert>
      ) : null}
    </>
  );
}
