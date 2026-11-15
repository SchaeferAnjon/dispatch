/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the projects under the Projects row sit one level in (task-e1qsa, preference
 *  「Projects 在上、项目缩进」). The sessions list stays a flat tree with the Projects row as a
 *  sibling of the project groups, so drag, collapse and the saved order work as before; the rows that
 *  belong to a project are marked here when the list is built and the row gets a class when it is drawn.
 *--------------------------------------------------------------------------------------------*/

import { ITreeElementRenderDetails, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';

/** The class on a list row that belongs to a project (dispatchProjects.css indents it). */
export const DISPATCH_PROJECT_ROW_CLASS = 'dispatch-in-project';

let inProjects = new WeakSet<object>();

interface ITreeChild {
	readonly element: unknown;
	readonly children?: Iterable<ITreeChild>;
}

/**
 * Marks every row after the Projects row, and everything inside it, as belonging to a project; the
 * top-level rows named in `outside` (Pinned, Chats, Done) do not.
 */
export function markProjectRows(children: readonly ITreeChild[], projectsId: string, outside: ReadonlySet<string>): void {
	inProjects = new WeakSet<object>();
	const start = children.findIndex(c => (c.element as { id?: string }).id === projectsId);
	if (start < 0) {
		return;
	}
	const mark = (child: ITreeChild): void => {
		if (typeof child.element === 'object' && child.element !== null) {
			inProjects.add(child.element);
		}
		for (const grandchild of child.children ?? []) {
			mark(grandchild);
		}
	};
	for (const child of children.slice(start + 1)) {
		if (!outside.has((child.element as { id?: string }).id ?? '')) {
			mark(child);
		}
	}
}

export function isProjectRow(element: unknown): boolean {
	return typeof element === 'object' && element !== null && inProjects.has(element);
}

interface IIndentTemplate {
	readonly row: HTMLElement | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly inner: any;
}

/** The renderer as it is, plus the project class on the row it draws. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withProjectIndent<T, F>(renderer: ITreeRenderer<T, F, any>): ITreeRenderer<T, F, IIndentTemplate> {
	return {
		templateId: renderer.templateId,
		rowClassName: renderer.rowClassName,
		onDidChangeTwistieState: renderer.onDidChangeTwistieState,
		// the tree hands the renderer `.monaco-tl-contents`; the row is two levels up
		renderTemplate: container => ({ row: container.parentElement?.parentElement ?? undefined, inner: renderer.renderTemplate(container) }),
		renderElement: (node: ITreeNode<T, F>, index: number, template: IIndentTemplate, details?: ITreeElementRenderDetails) => {
			template.row?.classList.toggle(DISPATCH_PROJECT_ROW_CLASS, isProjectRow(node.element));
			renderer.renderElement(node, index, template.inner, details);
		},
		disposeElement: renderer.disposeElement && ((node, index, template, details) => renderer.disposeElement!(node, index, template.inner, details)),
		disposeTemplate: template => renderer.disposeTemplate(template.inner),
		renderTwistie: renderer.renderTwistie && ((element, twistie) => renderer.renderTwistie!(element, twistie)),
	};
}
