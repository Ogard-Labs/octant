import { Check, CircleDashed, CircleX } from "lucide-react";
import { useId } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { DeviceSetupCheck } from "./deviceModel";

/**
 * What stands between this Mac and a running device, one row per check. A row
 * that failed says the one thing to do about it. Octant installs nothing.
 */
export function DeviceSetup(props: {
  readonly title: string;
  readonly checks: ReadonlyArray<DeviceSetupCheck>;
  readonly note?: string;
  readonly checking: boolean;
  readonly onCheckAgain?: () => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="device-card">
      <h2 className="device-card__title" id={headingId}>
        {props.title}
      </h2>
      <p className="device-card__lede">
        {props.note ?? "Octant checks these on this Mac. Nothing is installed for you."}
      </p>
      <ul className="device-checks">
        {props.checks.map((check) => (
          <li data-state={check.state} key={check.id}>
            <span className="device-checks__mark">
              {check.state === "ok" ? (
                <Check aria-hidden="true" size={16} />
              ) : check.state === "missing" ? (
                <CircleX aria-hidden="true" size={16} />
              ) : (
                <CircleDashed aria-hidden="true" size={16} />
              )}
            </span>
            <span className="device-checks__body">
              <span>
                {check.label}
                <span className="sr-only">
                  {check.state === "ok"
                    ? ", done"
                    : check.state === "missing"
                      ? ", missing"
                      : ", not checked yet"}
                </span>
              </span>
              {check.detail === undefined ? null : (
                <span className="device-checks__detail">{check.detail}</span>
              )}
              {check.fix === undefined ? null : (
                <span className="device-checks__fix">{check.fix}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {props.onCheckAgain === undefined ? null : (
        <div className="device-card__actions">
          <OctantButton disabled={props.checking} onClick={props.onCheckAgain} type="button">
            {props.checking ? "Checking…" : "Check again"}
          </OctantButton>
        </div>
      )}
    </section>
  );
}
