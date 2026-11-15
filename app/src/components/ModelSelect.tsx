import { matchModel, modelGroups, type ModelOption } from "../models";
import { useT } from "../i18n";

/** The model picker every start dialog shares: default and the newest first, older releases in their own group. */
export function ModelSelect({ options, value, onChange, disabled, label }: { options: ModelOption[] | undefined; value: string; onChange: (id: string) => void; disabled?: boolean; label?: string }) {
  const t = useT();
  // The agent may report the full dated id ("claude-haiku-4-5-20251001"): show the catalog entry it stands for.
  const shown = matchModel(options, value)?.id ?? value;
  const { latest, older } = modelGroups(options, shown);
  const name = (o: ModelOption) => (o.id === "" ? (o.default ? t("默认（{name}）", { name: o.default }) : t("默认模型")) : o.label);
  const item = (o: ModelOption) => <option key={o.id} value={o.id} title={o.note || undefined}>{name(o)}</option>;
  return <select aria-label={label ?? t("模型")} value={shown} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    {latest.map(item)}
    {older.length > 0 && <optgroup label={t("更早的版本")}>{older.map(item)}</optgroup>}
  </select>;
}
