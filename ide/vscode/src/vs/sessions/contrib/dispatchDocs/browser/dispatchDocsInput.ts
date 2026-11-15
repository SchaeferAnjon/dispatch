/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Docs tab's editor input (patches/435-docs.patch). One tab per group,
 *  next to Changes, Files and Tasks; the pane itself is dispatchDocsEditor.ts.
 *
 *  A document opened from Docs (or by `dispatch.openDoc`) is a tab of its own in the same strip
 *  ({@link DispatchDocTabInput}): its title, the list's format icon, a close button, the whole path in
 *  its hover. The session's working set keeps these tabs like any other (the serializer below).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput, Verbosity } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { dispatchDocKind, dispatchDocKindIcon, dispatchDocShortName } from './dispatchDocKind.js';

export class DispatchDocsEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.dispatch.docs';
	static readonly EDITOR_ID = 'workbench.editor.dispatch.docs';

	override get typeId(): string {
		return DispatchDocsEditorInput.ID;
	}

	override get editorId(): string {
		return DispatchDocsEditorInput.EDITOR_ID;
	}

	override get resource(): undefined {
		return undefined;
	}

	override get capabilities(): EditorInputCapabilities {
		// one tab, closable like Changes and Files; the + menu offers it again once closed
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ExcludeFromEditorLimit;
	}

	override getName(): string {
		return localize('dispatchDocs.name', "Docs");
	}

	override getIcon(): ThemeIcon {
		return Codicon.book;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof DispatchDocsEditorInput;
	}
}

export class DispatchDocsEditorSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(DispatchDocsEditorInput);
	}
}

/** Why a document tab was opened: shown on the reader's second line ("Delivered just now for …"). */
export interface IDispatchDocTabContext {
	/** The task it belongs to: the reader's second line names it first. */
	readonly task?: string;
	readonly reason?: 'delivered' | 'task' | 'list';
	/** Open its Where to look on this spot. */
	readonly mark?: number;
}

const isHtmlPath = (p: string) => /\.html?$/i.test(p);

/** The name a document has before its reader knows its title: the file name, or the folder of a README / index.html. */
export function dispatchDocFallbackTitle(path: string): string {
	const parts = path.split('/').filter(Boolean);
	const file = parts[parts.length - 1] ?? path;
	if (/^(readme\.md|index\.html?)$/i.test(file) && parts.length > 1) {
		return parts[parts.length - 2];
	}
	return file.replace(/\.(md|markdown|html?)$/i, '');
}

/** One document of Docs in a tab of its own, next to Changes, Files, Docs and Tasks. */
export class DispatchDocTabInput extends EditorInput {

	static readonly ID = 'workbench.editors.dispatch.doc';
	static readonly EDITOR_ID = 'workbench.editor.dispatch.doc';

	private _title: string;
	/** Set by whoever opened it, read once by the reader (not kept with the session). */
	context: IDispatchDocTabContext | undefined;

	constructor(readonly path: string, title: string | undefined, context?: IDispatchDocTabContext) {
		super();
		this._title = title?.trim() || dispatchDocFallbackTitle(path);
		this.context = context;
	}

	override get typeId(): string {
		return DispatchDocTabInput.ID;
	}

	override get editorId(): string {
		return DispatchDocTabInput.EDITOR_ID;
	}

	/** No resource: a file opened from Files or Open in Editor is a tab of its own, never this one. */
	override get resource(): undefined {
		return undefined;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.ExcludeFromEditorLimit;
	}

	get isPage(): boolean {
		return isHtmlPath(this.path);
	}

	/** The whole title (the Docs list's Open group); the tab has the part before its colon. */
	get fullTitle(): string {
		return this._title;
	}

	override getName(): string {
		return dispatchDocShortName(this._title, this.path);
	}

	override getTitle(verbosity?: Verbosity): string {
		// the tab's hover: the whole title and where the file is
		return verbosity === Verbosity.LONG ? `${this._title}\n${this.path}` : this.getName();
	}

	override getDescription(): string | undefined {
		return undefined;
	}

	override getIcon(): ThemeIcon {
		// what it is (notes, a handoff …), not only its format
		return dispatchDocKindIcon(dispatchDocKind(this.path));
	}

	override getLabelExtraClasses(): string[] {
		return ['dispatch-doc-tab'];
	}

	/** The reader found the document's title (its heading, the page's <title>, the list's name). */
	setTitle(title: string): void {
		const t = title.trim();
		if (t && t !== this._title) {
			this._title = t;
			this._onDidChangeLabel.fire();
		}
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof DispatchDocTabInput && other.path === this.path);
	}
}

export class DispatchDocTabSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string | undefined {
		return input instanceof DispatchDocTabInput ? JSON.stringify({ path: input.path, title: input.fullTitle }) : undefined;
	}
	deserialize(_instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const { path, title } = JSON.parse(raw) as { path?: unknown; title?: unknown };
			return typeof path === 'string' && path ? new DispatchDocTabInput(path, typeof title === 'string' ? title : undefined) : undefined;
		} catch {
			return undefined;
		}
	}
}
