import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { ShipPanel } from "../ship/ShipPanel";

type Props = Pick<ThreadUtilityDockContentProps, "shipClient" | "subject">;

export default function DeliveryModule(props: Props) {
  if (props.shipClient === undefined) {
    return unavailable("Delivery", "This thread has no delivery yet.");
  }
  return <ShipPanel client={props.shipClient} threadId={props.subject.threadId} />;
}
