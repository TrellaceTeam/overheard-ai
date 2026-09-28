/**
 * The assistant picker's rows, as data: one dropdown per provider, each model
 * a checkbox, current models before superseded ones. Every rule about what
 * may be ticked lives here, so the rules are tested without opening a menu.
 *
 * A model the project already asks can always be switched off, whatever else
 * is true: its key gone, its key no longer listing it, the key check still in
 * flight. Only the demo lock stops that.
 */

export interface MenuModel {
  id: string;
  provider: string;
  /** The provider's own id, which the availability report speaks in. */
  model_id: string;
  display_name: string;
  tier: string;
  superseded?: number | undefined;
}

/** One provider's line from the availability report. */
export type AvailabilityView =
  | { status: "ok"; available: string[]; missing: string[] }
  | { status: "no_key" }
  | { status: "mocked" }
  | { status: "error"; message: string };

export interface MenuItem {
  id: string;
  label: string;
  tier: string;
  checked: boolean;
  disabled: boolean;
  /** Why an unticked item cannot be ticked, in a few words, or null. */
  note: string | null;
  older: boolean;
}

export interface ProviderMenu {
  provider: string;
  /** The key check finished and found no key for this provider. */
  noKey: boolean;
  /** What the closed dropdown says. */
  summary: string;
  items: MenuItem[];
  anyChecked: boolean;
  /** A line under the row when the model list could not be read, or null. */
  listProblem: string | null;
}

export function assistantMenus(input: {
  groups: ReadonlyArray<{ provider: string; models: readonly MenuModel[] }>;
  selectedIds: ReadonlySet<string>;
  keyedProviders: ReadonlySet<string>;
  keysUnresolved: boolean;
  locked: boolean;
  availability?: Readonly<Record<string, AvailabilityView | undefined>> | undefined;
}): ProviderMenu[] {
  const { groups, selectedIds, keyedProviders, keysUnresolved, locked, availability } = input;
  return groups.map((group) => {
    const noKey = !keysUnresolved && !keyedProviders.has(group.provider);
    const report = availability?.[group.provider];
    const missing = report?.status === "ok" ? new Set(report.missing) : null;
    const ordered = [
      ...group.models.filter((model) => model.superseded !== 1),
      ...group.models.filter((model) => model.superseded === 1),
    ];
    const items = ordered.map((model): MenuItem => {
      const checked = selectedIds.has(model.id);
      const offKey = missing?.has(model.model_id) ?? false;
      const note = checked
        ? offKey
          ? "not on your key"
          : null
        : noKey
          ? "no key"
          : offKey
            ? "not on your key"
            : null;
      return {
        id: model.id,
        label: model.display_name,
        tier: model.tier,
        checked,
        disabled: locked || (!checked && (keysUnresolved || noKey || offKey)),
        note,
        older: model.superseded === 1,
      };
    });
    const names = items.filter((item) => item.checked).map((item) => item.label);
    return {
      provider: group.provider,
      noKey,
      summary:
        names.length === 0
          ? "None"
          : names.length <= 2
            ? names.join(", ")
            : `${names.length} models`,
      items,
      anyChecked: names.length > 0,
      listProblem: report?.status === "error" ? report.message : null,
    };
  });
}
