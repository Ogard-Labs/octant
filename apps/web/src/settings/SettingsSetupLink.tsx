import { OctantButton } from "../ui/base/OctantButton";
import { openExternalUrl, type ExternalUrlHost } from "../shell/openExternalUrl";

interface SettingsSetupLinkProps {
  readonly host: ExternalUrlHost | undefined;
  readonly href: string;
  readonly children: string;
}

/**
 * Setup links are fixed product URLs opened in the person's browser. The
 * desktop shell refuses `target="_blank"` popups, so a middle click goes
 * through the same open-external route as a click instead of doing nothing.
 */
export function SettingsSetupLink(props: SettingsSetupLinkProps) {
  return (
    <a
      className="settings-setup-link"
      href={props.href}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        event.preventDefault();
        openExternalUrl(props.host, props.href);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        openExternalUrl(props.host, props.href);
      }}
    >
      {props.children}
    </a>
  );
}

/**
 * A setup step's own action, such as getting a network provider's app. It
 * stands after the step's sentences rather than inside one, so the design
 * system makes it a button, not bare link text.
 */
export function SettingsSetupAction(props: SettingsSetupLinkProps) {
  return (
    <OctantButton
      className="settings-setup-action"
      onClick={() => openExternalUrl(props.host, props.href)}
      size="sm"
      type="button"
      variant="secondary"
    >
      {props.children}
    </OctantButton>
  );
}
