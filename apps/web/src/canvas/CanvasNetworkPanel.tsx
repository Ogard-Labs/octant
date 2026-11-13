import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import type { CanvasNetworkAccessState } from "./useCanvasNetworkAccess";

/**
 * One Canvas's "Allow network" switch, beside what turning it on gives away.
 *
 * The sentence is the confirmation: a person reads it where they flip the
 * switch. With the switch on, a running prototype can send the Canvas's own
 * content to the open internet; that is what the person is choosing. The host
 * holds the switch and decides who may set it.
 */
export function CanvasNetworkPanel(props: { readonly network: CanvasNetworkAccessState }) {
  const { network } = props;
  const allowed = network.allowed === true;
  return (
    <section aria-label="Canvas network">
      <OctantAlert
        action={
          <OctantSwitch
            checked={allowed}
            disabled={network.busy}
            label="Allow network"
            onCheckedChange={(checked) => void network.set(checked)}
          />
        }
        role="status"
        title="Allow network"
        tone="warning"
      >
        While this is on, a running prototype can send anything this Canvas holds to any public
        address on the internet, through this computer&apos;s connection. It still cannot reach
        Octant, your files, or your local network.
      </OctantAlert>
      {allowed ? (
        <p>
          Run a prototype again for it to use the network. Turning this off stops its requests at
          once.
        </p>
      ) : null}
      {network.message === undefined ? null : (
        <OctantAlert tone="danger">{network.message}</OctantAlert>
      )}
    </section>
  );
}
