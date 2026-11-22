import {
  createAccessActivityClient,
  type AccessActivityPort,
} from "@octant/client-runtime/access-activity-client";
import { useMemo } from "react";
import { OctantToast } from "../ui/base/OctantToast";
import { describeNotice, useChangeNotices } from "./changeNoticeState";

/**
 * The newest change notice in a window's notice stack: a paired device or an
 * agent raised a thread's level or changed a provider key. Undo and revoke
 * live in Settings › Remote access, which Review opens. Loaded on its own
 * chunk, so the window's first load carries none of it.
 */
export function ChangeNoticeToast(props: {
  readonly port: AccessActivityPort;
  readonly changeRevision: number;
  readonly onReview: () => void;
}) {
  const client = useMemo(() => createAccessActivityClient(props.port), [props.port]);
  const { notices, act } = useChangeNotices(client, props.changeRevision);
  const newest = notices[0];
  if (newest === undefined) return null;
  return (
    <OctantToast
      action={{ label: "Review", onSelect: props.onReview }}
      detail={
        newest.kind === "provider-key-replaced"
          ? "Revoke who did it in Settings › Remote access. A replaced key has no Undo."
          : "Undo it or revoke who did it in Settings › Remote access."
      }
      key={newest.noticeId}
      onDismiss={() => void act("dismiss", newest.noticeId)}
      title={describeNotice(newest)}
      tone="warning"
    />
  );
}
