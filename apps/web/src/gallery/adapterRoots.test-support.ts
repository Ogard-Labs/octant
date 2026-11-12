/**
 * For each shared adapter the gallery draws, a selector its own render writes
 * (a `data-slot`, a class the adapter adds itself, or a role). The gallery
 * test looks for it inside the specimen that names the adapter, so naming an
 * adapter without drawing it fails. Parts with no element of their own
 * (a root or a portal) name the element they open or wrap.
 *
 * `portalled` parts render under `document.body`, outside any specimen, so
 * only their presence in the document is checked.
 */
export interface AdapterRoot {
  readonly selector: string;
  readonly portalled?: true;
}

export const ADAPTER_ROOTS: Readonly<Record<string, AdapterRoot>> = {
  OctantAlert: { selector: ".callout" },
  OctantApprovalCard: { selector: ".approval-row" },
  OctantBadge: { selector: '[data-slot="badge"]' },
  OctantButton: { selector: '[data-slot="button"]' },
  OctantIconButton: { selector: ".shell-icon-button" },
  OctantCard: { selector: '[data-slot="card"]' },
  OctantCardHeader: { selector: '[data-slot="card-header"]' },
  OctantCardTitle: { selector: '[data-slot="card-title"]' },
  OctantCardDescription: { selector: '[data-slot="card-description"]' },
  OctantCardContent: { selector: '[data-slot="card-content"]' },
  OctantCardFooter: { selector: '[data-slot="card-footer"]' },
  OctantCheckbox: { selector: '[data-slot="checkbox"]' },
  OctantCombobox: { selector: '[data-slot="combobox-input-group"]' },
  OctantComboboxInputGroup: { selector: '[data-slot="combobox-input-group"]' },
  OctantComboboxInput: { selector: '[data-slot="combobox-input"]' },
  OctantComboboxTrigger: { selector: '[data-slot="combobox-trigger"]' },
  OctantComboboxPortal: { selector: '[data-slot="combobox-positioner"]', portalled: true },
  OctantComboboxPositioner: { selector: '[data-slot="combobox-positioner"]', portalled: true },
  OctantComboboxPopup: { selector: '[data-slot="combobox-content"]', portalled: true },
  OctantComboboxEmpty: { selector: '[data-slot="combobox-empty"]', portalled: true },
  OctantComboboxList: { selector: '[role="listbox"]', portalled: true },
  OctantComboboxItem: { selector: '[data-slot="combobox-item"]', portalled: true },
  OctantComboboxItemIndicator: {
    selector: '[data-slot="combobox-item-indicator"]',
    portalled: true,
  },
  OctantContextMenu: {
    selector:
      '[data-slot="context-menu-trigger"], [aria-expanded][class*="gallery-context-target"]',
  },
  OctantEmpty: { selector: '[data-slot="empty"]' },
  OctantEmptyRoot: { selector: '[data-slot="empty"]' },
  OctantEmptyHeader: { selector: '[data-slot="empty-header"]' },
  OctantEmptyMedia: { selector: '[data-slot="empty-media"]' },
  OctantEmptyEyebrow: { selector: '[data-slot="empty-eyebrow"]' },
  OctantEmptyTitle: { selector: '[data-slot="empty-title"]' },
  OctantEmptyDescription: { selector: '[data-slot="empty-description"]' },
  OctantEmptyContent: { selector: '[data-slot="empty-content"]' },
  OctantField: { selector: '[data-slot="field"]' },
  OctantFieldGroup: { selector: '[data-slot="field-group"]' },
  OctantFieldLabel: { selector: '[data-slot="field-label"]' },
  OctantFieldDescription: { selector: '[data-slot="field-description"]' },
  OctantFieldError: { selector: '[data-slot="field-error"]' },
  OctantInput: { selector: '[data-slot="input"]' },
  OctantMenu: { selector: ".octant-menu__trigger" },
  OctantMenuRoot: { selector: '[data-slot="dropdown-menu-trigger"]' },
  OctantMenuTrigger: { selector: '[data-slot="dropdown-menu-trigger"]' },
  OctantMenuPortal: { selector: '[data-slot="dropdown-menu-content"]', portalled: true },
  OctantMenuPositioner: { selector: '[data-slot="dropdown-menu-content"]', portalled: true },
  OctantMenuPopup: { selector: '[data-slot="dropdown-menu-content"]', portalled: true },
  OctantMenuGroup: { selector: '[role="group"] [role="menuitem"]', portalled: true },
  OctantMenuGroupLabel: {
    selector:
      '[data-slot="dropdown-menu-content"] [role="presentation"], [data-slot="dropdown-menu-content"] [id*="group"]',
    portalled: true,
  },
  OctantMenuItem: { selector: '[role="menuitem"]', portalled: true },
  OctantMenuCheckboxItem: {
    selector: '[data-slot="dropdown-menu-checkbox-item"]',
    portalled: true,
  },
  OctantMenuSeparator: { selector: '[data-slot="dropdown-menu-separator"]', portalled: true },
  OctantMenuIconSlot: { selector: '[data-slot="menu-icon-slot"]', portalled: true },
  OctantNumberStepper: { selector: ".octant-number-stepper" },
  OctantPopover: { selector: '[data-slot="popover-trigger"]' },
  OctantPreviewCard: { selector: '[data-slot="preview-card-trigger"]' },
  OctantSelectField: { selector: '[data-slot="select-trigger"]' },
  OctantSelectRoot: { selector: '[data-slot="select-trigger"]' },
  OctantSelectTrigger: { selector: '[data-slot="select-trigger"]' },
  OctantSelectValue: {
    selector:
      '[data-slot="select-trigger"] [data-slot="select-value"], [data-slot="select-trigger"] span',
  },
  OctantSelectPortal: { selector: '[data-slot="select-content"]', portalled: true },
  OctantSelectPositioner: { selector: '[data-slot="select-content"]', portalled: true },
  OctantSelectPopup: { selector: '[data-slot="select-content"]', portalled: true },
  OctantSelectItem: { selector: '[data-slot="select-item"]', portalled: true },
  OctantSeparator: { selector: '[data-slot="separator"]' },
  OctantSeparatorWithLabel: { selector: '[data-slot="separator-label"]' },
  OctantSlider: { selector: '[data-slot="slider"]' },
  OctantSwitch: { selector: '[data-slot="switch"]' },
  OctantTabs: { selector: '[data-slot="tabs"], [data-slot="tabs-list"]' },
  OctantTabsList: { selector: '[data-slot="tabs-list"]' },
  OctantTabsTab: { selector: '[data-slot="tabs-trigger"]' },
  OctantTabsPanel: { selector: '[data-slot="tabs-content"]' },
  OctantTextarea: { selector: '[data-slot="textarea"]' },
  OctantToast: { selector: ".toast" },
  OctantToggleGroup: { selector: '[data-slot="toggle-group"]' },
  OctantToggleGroupItem: { selector: '[data-slot="toggle-group-item"]' },
  OctantTooltip: { selector: '[data-slot="tooltip-trigger"]' },
};
