import { useContext, useLayoutEffect, type ComponentProps } from "react";
import * as Web from "../shadcn/dropdown-menu";
import { Native, NativeRoot } from "./NativeContextMenu";

export function DropdownMenu(props: ComponentProps<typeof Web.DropdownMenu>) {
  const popup = window.octantHost?.popupNativeMenu;
  return popup === undefined ? (
    <Web.DropdownMenu {...props} />
  ) : (
    <NativeRoot {...props} kind="dropdown" popup={popup} />
  );
}
export function DropdownMenuTrigger(props: ComponentProps<typeof Web.DropdownMenuTrigger>) {
  const native = useContext(Native);
  return (
    <Web.DropdownMenuTrigger
      {...props}
      {...(native === undefined
        ? {}
        : {
            "data-native-menu-trigger": "",
            "aria-expanded": native.open,
          })}
    />
  );
}
export function DropdownMenuPopup(props: ComponentProps<typeof Web.DropdownMenuPopup>) {
  const native = useContext(Native);
  return native === undefined ? (
    <Web.DropdownMenuPopup {...props} />
  ) : native.open ? (
    <div hidden ref={native.content}>
      {props.children}
    </div>
  ) : null;
}
export function DropdownMenuPortal(props: ComponentProps<typeof Web.DropdownMenuPortal>) {
  return useContext(Native) === undefined ? (
    <Web.DropdownMenuPortal {...props} />
  ) : (
    <>{props.children}</>
  );
}
export function DropdownMenuPositioner(props: ComponentProps<typeof Web.DropdownMenuPositioner>) {
  const native = useContext(Native);
  useLayoutEffect(() => {
    if (native !== undefined) native.side.current = props.side ?? "bottom";
  }, [native, props.side]);
  return native === undefined ? (
    <Web.DropdownMenuPositioner {...props} />
  ) : (
    <div>{props.children}</div>
  );
}
export function DropdownMenuItem(props: ComponentProps<typeof Web.DropdownMenuItem>) {
  return (
    <Web.DropdownMenuItem
      {...props}
      data-native-menu-kind="item"
      data-native-menu-label={props.label}
      data-native-menu-enabled={props.disabled !== true}
    />
  );
}
export function DropdownMenuGroup(props: ComponentProps<typeof Web.DropdownMenuGroup>) {
  return <Web.DropdownMenuGroup {...props} />;
}
export function DropdownMenuGroupLabel(props: ComponentProps<typeof Web.DropdownMenuGroupLabel>) {
  return <Web.DropdownMenuGroupLabel {...props} data-native-menu-kind="label" />;
}
export function DropdownMenuSeparator(props: ComponentProps<typeof Web.DropdownMenuSeparator>) {
  return <Web.DropdownMenuSeparator {...props} data-native-menu-kind="separator" />;
}
export function DropdownMenuCheckboxItem(
  props: ComponentProps<typeof Web.DropdownMenuCheckboxItem>,
) {
  return (
    <Web.DropdownMenuCheckboxItem
      {...props}
      data-native-menu-kind="checkbox"
      data-native-menu-label={props.label}
      data-native-menu-enabled={props.disabled !== true}
    />
  );
}
export function DropdownMenuRadioGroup(props: ComponentProps<typeof Web.DropdownMenuRadioGroup>) {
  return <Web.DropdownMenuRadioGroup {...props} />;
}
export function DropdownMenuRadioItem(props: ComponentProps<typeof Web.DropdownMenuRadioItem>) {
  return (
    <Web.DropdownMenuRadioItem
      {...props}
      data-native-menu-kind="radio"
      data-native-menu-label={props.label}
      data-native-menu-enabled={props.disabled !== true}
    />
  );
}
export function DropdownMenuSub(props: ComponentProps<typeof Web.DropdownMenuSub>) {
  return useContext(Native) === undefined ? (
    <Web.DropdownMenuSub {...props} />
  ) : (
    <div data-native-menu-kind="submenu">{props.children}</div>
  );
}
export function DropdownMenuSubTrigger(props: ComponentProps<typeof Web.DropdownMenuSubTrigger>) {
  return useContext(Native) === undefined ? (
    <Web.DropdownMenuSubTrigger {...props} />
  ) : (
    <div
      data-native-menu-sub-trigger=""
      data-native-menu-label={props.label}
      data-native-menu-enabled={props.disabled !== true}
    >
      {props.children}
    </div>
  );
}
export function DropdownMenuSubPopup(props: ComponentProps<typeof Web.DropdownMenuSubPopup>) {
  return useContext(Native) === undefined ? (
    <Web.DropdownMenuSubPopup {...props} />
  ) : (
    <div>{props.children}</div>
  );
}
