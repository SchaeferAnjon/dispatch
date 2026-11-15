/*---------------------------------------------------------------------------------------------
 *  Dispatch: default Codex threads to the largest context window their model supports.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatTokenCount } from '../../../../base/common/numbers.js';
import { localize } from '../../../../nls.js';
import type { ConfigPropertySchema } from '../../common/state/protocol/state.js';

/**
 * The Context Size picker property of a native Codex model.
 *
 * Codex uses 272K unless a window is configured, and compacts near it. The picker's default is the model's
 * largest window, so a session nobody touched starts with it. When the user's own Codex config sets
 * `model_context_window`, that value is the default instead (clamped to the model's maximum, as Codex does)
 * and is offered as its own option when it lies between the known sizes: the picker stores its default as
 * the session's explicit choice, so a default of 272K would silently override the user's config.
 */
export function codexContextSizeProperty(defaultSize: number, maxSize: number, userWindow?: number): ConfigPropertySchema | undefined {
	if (!defaultSize || !maxSize || defaultSize >= maxSize) {
		return undefined;
	}
	const user = userWindow !== undefined && Number.isFinite(userWindow) && userWindow > 0 ? Math.min(userWindow, maxSize) : undefined;
	const sizes = [...new Set([defaultSize, maxSize, ...(user !== undefined ? [user] : [])])].sort((a, b) => a - b);
	return {
		type: 'number',
		title: localize('codex.modelContextSize.title', "Context Size"),
		description: localize('codex.modelContextSize.description', "Selects the context window size for this model."),
		default: user ?? maxSize,
		enum: sizes,
		enumLabels: sizes.map(formatTokenCount),
		enumDescriptions: sizes.map(size => size === defaultSize
			? localize('codex.modelContextSize.default', "Default")
			: size === maxSize
				? localize('codex.modelContextSize.longerSessions', "Longer sessions")
				: localize('codex.modelContextSize.fromConfig', "From your Codex config")),
	};
}

/**
 * The `model_context_window` a Codex thread is started with: the picked size when the model still offers
 * it, otherwise the picker's default. Codex clamps the value to the model's maximum
 * (codex-rs/models-manager/src/model_info.rs), so it is always safe.
 */
export function resolveCodexContextSize(selected: number | undefined, offered: readonly number[] | undefined, pickerDefault: number | undefined): number | undefined {
	const size = selected ?? pickerDefault;
	return size !== undefined && offered?.includes(size) ? size : undefined;
}
