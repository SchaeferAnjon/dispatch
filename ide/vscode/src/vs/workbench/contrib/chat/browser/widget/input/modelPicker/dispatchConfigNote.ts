/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the grey word after a Thinking Level (or Context Size) option (task-tpnwq).
 *  "Default" stays on the model's own default. A level you picked in another chat carries over to
 *  new chats (VS Code keeps it in chatLanguageModels.json), so when the checked option is not the
 *  default it says "Last picked": the menu then reads "Medium, Last picked" above "High, Default"
 *  instead of a checked Medium next to a High that claims to be the default.
 *--------------------------------------------------------------------------------------------*/

export type DispatchConfigNote = 'default' | 'lastPicked' | undefined;

/**
 * `defaultIsOption`: the option is itself labelled "Default" (OpenCode's variants), so it gets no second
 * "Default" after it.
 */
export function dispatchConfigNote(value: unknown, current: unknown, schemaDefault: unknown, defaultIsOption: boolean): DispatchConfigNote {
	if (value === schemaDefault) {
		return defaultIsOption ? undefined : 'default';
	}
	return value === current && schemaDefault !== undefined ? 'lastPicked' : undefined;
}
