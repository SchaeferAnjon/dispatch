/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a project's own icon, the plain part (dispatchProjectLook.ts draws it).
 *--------------------------------------------------------------------------------------------*/

import { DISPATCH_ICON_COLORS } from '../../../../base/common/dispatchPalette.js';

export type DispatchProjectIconKind = 'folder' | 'symbol' | 'emoji' | 'picture';

export interface IDispatchProjectLook {
	readonly icon: DispatchProjectIconKind;
	readonly symbol?: string;
	readonly emoji?: string;
	readonly color?: string;
	/** The picture, inline (a data: URL the CLI made from its 96 px copy). */
	readonly picture_data?: string;
}

/** The app icon's colours (base/common/dispatchPalette.ts, DESIGN.md「图标色即图例」); the CLI offers the same seven. */
export const DISPATCH_PROJECT_COLORS: Readonly<Record<string, string>> = {
	green: DISPATCH_ICON_COLORS.green,
	amber: DISPATCH_ICON_COLORS.amber,
	coral: DISPATCH_ICON_COLORS.coral,
	purple: DISPATCH_ICON_COLORS.purple,
	blue: DISPATCH_ICON_COLORS.blue,
	teal: DISPATCH_ICON_COLORS.teal,
	gray: DISPATCH_ICON_COLORS.gray,
};

/** A look the window can draw, or undefined for the plain folder (anything it does not know is the folder). */
export function dispatchProjectLook(value: unknown): IDispatchProjectLook | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	const color = typeof v.color === 'string' && DISPATCH_PROJECT_COLORS[v.color] ? v.color : undefined;
	if (v.icon === 'symbol' && typeof v.symbol === 'string' && /^[a-z][a-z0-9-]*$/.test(v.symbol)) {
		return { icon: 'symbol', symbol: v.symbol, color };
	}
	if (v.icon === 'emoji' && typeof v.emoji === 'string' && v.emoji.length <= 16) {
		return { icon: 'emoji', emoji: v.emoji, color };
	}
	if (v.icon === 'picture' && typeof v.picture_data === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(v.picture_data)) {
		return { icon: 'picture', picture_data: v.picture_data, color };
	}
	return color ? { icon: 'folder', color } : undefined;
}

