/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a project's own icon (patches/445-project-custom.patch, kanban task-7gtm).
 *
 *  A project is a plain folder until the person picks something in its Customize page (the user,
 *  10-01: no letters, no colour picked for them). `look` comes from `dispatch projects --json`
 *  (kanban app/cli/project_custom.py): a symbol (a codicon), an emoji or a picture (inline, a data:
 *  URL), and a colour that goes on the icon only. `paintDispatchProjectLook` draws it into an icon
 *  slot: the sessions list's project row, the Customize page's preview and its choices.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchProjectLook.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DISPATCH_PROJECT_COLORS, IDispatchProjectLook } from './dispatchProjectLookModel.js';

const CLASSES = ['dispatch-project-look', 'dispatch-project-look-emoji', 'dispatch-project-look-picture', 'dispatch-project-look-colored'];

/**
 * Draws a project's icon into `el` (an icon slot that already has its own class and size). Only adds: the
 * caller clears the slot first. The colour tints a folder or a symbol; an emoji and a picture keep their own.
 */
export function paintDispatchProjectLook(el: HTMLElement, look: IDispatchProjectLook | undefined, folder: ThemeIcon = Codicon.folder): void {
	el.classList.add('dispatch-project-look');
	const color = look?.color ? DISPATCH_PROJECT_COLORS[look.color] : undefined;
	if (look?.icon === 'emoji' && look.emoji) {
		el.classList.add('dispatch-project-look-emoji');
		el.textContent = look.emoji;
		return;
	}
	if (look?.icon === 'picture' && look.picture_data) {
		el.classList.add('dispatch-project-look-picture');
		const img = el.ownerDocument.createElement('img');
		img.src = look.picture_data;
		img.alt = '';
		img.draggable = false;
		el.appendChild(img);
		return;
	}
	const icon = look?.icon === 'symbol' && look.symbol ? ThemeIcon.fromId(look.symbol) : folder;
	el.classList.add(...ThemeIcon.asClassNameArray(icon));
	if (color) {
		el.classList.add('dispatch-project-look-colored');
		el.style.setProperty('--dispatch-project-color', color);
	}
}

/** Takes back what `paintDispatchProjectLook` added (a slot the list reuses for another row). */
export function clearDispatchProjectLook(el: HTMLElement): void {
	el.classList.remove(...CLASSES);
	el.style.removeProperty('--dispatch-project-color');
}
