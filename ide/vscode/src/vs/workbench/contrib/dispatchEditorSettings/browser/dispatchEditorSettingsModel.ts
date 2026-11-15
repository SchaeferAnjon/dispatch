/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Tab completion and ⌘K in the editor window's own Settings (patches/530-editor-settings.patch,
 *  kanban design/settings direction B: "Editor 归到编辑器窗口的设置"). The plain part: the four settings, and how
 *  the Dispatch settings (`dispatch ide editor-settings`, saved with `dispatch settings --save`) map onto them.
 *--------------------------------------------------------------------------------------------*/

export const TAB_ENABLED = 'dispatch.editor.tabCompletion';
export const TAB_MODEL = 'dispatch.editor.tabCompletionModel';
export const TAB_CAP = 'dispatch.editor.tabCompletionDailyCap';
export const EDIT_MODEL = 'dispatch.editor.rewriteModel';
export const EDITOR_SETTING_KEYS = [TAB_ENABLED, TAB_MODEL, TAB_CAP, EDIT_MODEL] as const;
/** What Settings is searched for to show the four: they share this prefix. */
export const EDITOR_SETTINGS_QUERY = 'dispatch.editor.';

export interface IModelOption { readonly id: string; readonly label: string; readonly hint?: string }

export interface IEditorSettings {
	readonly tab: {
		readonly enabled: boolean; readonly model: string; readonly cap_usd: number; readonly has_key?: boolean;
		readonly today: { readonly count: number; readonly usd: number }; readonly month: { readonly count: number; readonly usd: number };
	};
	readonly tab_models: readonly IModelOption[];
	readonly edit_model: string;
	readonly edit_models: readonly IModelOption[];
}

/** The value each setting has in Dispatch. */
export function settingValues(s: IEditorSettings): Record<string, boolean | string | number> {
	return { [TAB_ENABLED]: s.tab.enabled, [TAB_MODEL]: s.tab.model, [TAB_CAP]: s.tab.cap_usd, [EDIT_MODEL]: s.edit_model };
}

/** What `dispatch settings --save` gets when `key` changed to `value` here; undefined for a value it would refuse. */
export function savePatch(key: string, value: unknown): Record<string, unknown> | undefined {
	switch (key) {
		case TAB_ENABLED: return typeof value === 'boolean' ? { ide_tab_completion: value } : undefined;
		case TAB_MODEL: return typeof value === 'string' && value ? { ide_tab_model: value } : undefined;
		case EDIT_MODEL: return typeof value === 'string' && value ? { ide_edit_model: value } : undefined;
		case TAB_CAP: return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000 ? { ide_tab_daily_cap_usd: Math.round(value * 100) / 100 } : undefined;
		default: return undefined;
	}
}

/** "$0.03", "$0.0004": two decimals from a cent up, otherwise enough to see it move. */
export function money(usd: number): string {
	if (usd >= 0.01 || usd <= 0) {
		return '$' + Math.max(0, usd).toFixed(2);
	}
	return usd < 0.0001 ? '<$0.0001' : '$' + usd.toFixed(4);
}

export const isSubscription = (model: string) => /^(claude|codex):/.test(model);
