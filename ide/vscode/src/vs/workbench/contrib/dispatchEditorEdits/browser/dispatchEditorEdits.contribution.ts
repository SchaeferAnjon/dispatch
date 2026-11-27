/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the editor's record of your typing, for "who wrote which line" (kanban app/cli/attribution.py,
 *  task-m6hek). Only a change this record vouches for is called yours; a change no agent's turn covers and no
 *  Dispatch editor saw typed (a tool writing its hook scripts, a script, git, another app) is nobody's.
 *
 *  The window keeps each open file's text as it was last loaded or saved. When you save a file you changed by hand,
 *  it hands dispatch-bridge that text, the text you saved, and when you began and when you saved by its own clock
 *  (`attribution edit`): the lines that differ are yours. An agent writing into the same open file through the
 *  editor meanwhile makes the save `mixed`, which vouches for nothing. Both windows, so typing in the editor window
 *  counts as well as typing in the Agents window's Changes.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { editKinds } from './dispatchEditorEditsModel.js';

const EDIT_COMMAND = 'dispatch.attributionEdit';
/** characters; a larger file is not kept (the CLI does not attribute files over 2 MB either) */
const MAX_TEXT = 2 * 1024 * 1024;

interface IEditing {
	/** the text before your first change since the file was last loaded or saved */
	readonly before: string;
	/** when you began, in seconds */
	readonly since: number;
	/** an agent wrote into it through the editor since then */
	agent: boolean;
}

class DispatchEditorEditsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchEditorEdits';

	/** each open file's text as last loaded or saved; undefined while it has unsaved changes from before we saw it */
	private readonly _clean = new Map<string, string | undefined>();
	private readonly _editing = new Map<string, IEditing>();
	private readonly _listeners = this._register(new DisposableMap<ITextModel>());

	constructor(
		@IModelService modelService: IModelService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		for (const model of modelService.getModels()) {
			this.watch(model);
		}
		this._register(modelService.onModelAdded(model => this.watch(model)));
		this._register(modelService.onModelRemoved(model => {
			this._listeners.deleteAndDispose(model);
			this._clean.delete(model.uri.toString());
			this._editing.delete(model.uri.toString());
		}));
		this._register(_textFiles.files.onDidSave(e => {
			const model = e.model.textEditorModel;
			if (!model) {
				return;
			}
			const key = model.uri.toString();
			const state = this._editing.get(key);
			this._editing.delete(key);
			const saved = this.text(model);
			this._clean.set(key, saved);
			if (state && saved !== undefined && saved !== state.before) {
				this.record(model.uri.fsPath, state, saved, Date.now() / 1000);
			}
		}));
		this._register(_textFiles.files.onDidRevert(fileModel => {
			const key = fileModel.resource.toString();
			this._editing.delete(key);
			this._clean.set(key, fileModel.textEditorModel ? this.text(fileModel.textEditorModel) : undefined);
		}));
	}

	private text(model: ITextModel): string | undefined {
		return model.getValueLength() <= MAX_TEXT ? model.getValue() : undefined;
	}

	private watch(model: ITextModel): void {
		if (model.uri.scheme !== Schemas.file || this._listeners.has(model)) {
			return;
		}
		const key = model.uri.toString();
		this._clean.set(key, this._textFiles.files.get(model.uri)?.isDirty() ? undefined : this.text(model));
		this._listeners.set(model, model.onDidChangeContent(e => {
			const sources = e.detailedReasons.map(r => r.metadata.source);
			if (e.isFlush || sources.includes('reloadFromDisk')) {
				// loaded again from disk (nothing here was unsaved): what you start from next is that
				this._editing.delete(key);
				this._clean.set(key, this.text(model));
				return;
			}
			const kinds = editKinds({ sources, isUndoing: e.isUndoing, isRedoing: e.isRedoing, isFlush: e.isFlush });
			const state = this._editing.get(key);
			if (state) {
				state.agent ||= kinds.agent;
				return;
			}
			const before = this._clean.get(key);
			if (kinds.hand && before !== undefined) {
				this._editing.set(key, { before, since: Date.now() / 1000, agent: kinds.agent });
			} else if (kinds.agent) {
				// an agent's edit with no typing of yours before it: what is saved next is not vouched for
				this._editing.set(key, { before: before ?? '', since: Date.now() / 1000, agent: true });
			}
		}));
	}

	private record(path: string, state: IEditing, saved: string, at: number): void {
		if (state.agent) {
			return; // the save holds an agent's lines too: it vouches for nothing
		}
		this._commands.executeCommand(EDIT_COMMAND, path, state.before, saved, state.since, at)
			.catch(e => this._log.trace(`[dispatchEditorEdits] ${path}: ${e}`)); // no bridge: no record
	}
}

registerWorkbenchContribution2(DispatchEditorEditsContribution.ID, DispatchEditorEditsContribution, WorkbenchPhase.AfterRestored);
