/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a Claude background sub-agent ends when Claude Code says so, from any of the places it says it
 *  (task-518qw; the sources are in dispatchSubagentEndModel.ts).
 *
 *  - `endSignals`: the `subagent_completed` signals for ends a message reports, each once (the spawn's own guard).
 *    ClaudeSdkMessageRouter calls it for messages that come outside a turn the host started, which it used to drop.
 *    A killed, stopped or failed one ends stopped (its chat shows stopped, not done).
 *  - `endOpenBackground`: the Claude Code process went (the person stopped the session, it crashed, it was restarted):
 *    every background sub-agent still open went with it and ends stopped (ClaudeSdkPipeline calls it then).
 *  - `DispatchSubagentMetaWatch`: while a background spawn is open, its `agent-<id>.meta.json` is read every 15 s; a
 *    `"finished": true` there ends it too, for a note that never came; one silent for `SILENT_MS` (30 min) with no
 *    process left to run it ends stopped, so nothing shows Working for ever.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentSignal } from '../../common/agent.js';
import type { SubagentRegistry } from './claudeSubagentRegistry.js';
import { isSilent, metaOf, SILENT_MS, stoppedReason, subagentEndsIn, subagentFolder } from './dispatchSubagentEndModel.js';

const META_EVERY_MS = 15_000;

/**
 * `subagent_completed` for each spawn of `toolUseIds` still open in `registry`; it leaves the registry. `stopped`:
 * why it ended without finishing (it shows stopped, not done).
 */
export function endSpawns(toolUseIds: readonly string[], chat: URI, registry: SubagentRegistry, stopped?: string): AgentSignal[] {
	const signals: AgentSignal[] = [];
	for (const toolUseId of toolUseIds) {
		const spawn = registry.getSpawn(toolUseId);
		if (!spawn || !spawn.markCompleted()) {
			continue;
		}
		registry.removeSpawn(toolUseId);
		signals.push({ kind: 'subagent_completed', chat, toolCallId: toolUseId, ...(stopped ? { stopped } : {}) });
	}
	return signals;
}

/** The ends a message from the SDK reports, as signals: killed, stopped and failed ones stopped. */
export function endSignals(message: unknown, chat: URI, registry: SubagentRegistry): AgentSignal[] {
	return subagentEndsIn(message).flatMap(end => {
		// a note that names the agent only: the open spawn that ran it
		const toolUseId = end.toolUseId || registry.openBackgroundSpawns().find(id => registry.getSpawn(id)?.agentId === end.agentId);
		return toolUseId ? endSpawns([toolUseId], chat, registry, stoppedReason(end.status)) : [];
	});
}

/**
 * Every background sub-agent still open, stopped: the Claude Code process that ran them is gone (stopped by the
 * person, crashed, or replaced on a restart), and they went with it.
 */
export function endOpenBackground(chat: URI, registry: SubagentRegistry, why: string): AgentSignal[] {
	return endSpawns(registry.openBackgroundSpawns(), chat, registry, why);
}

/**
 * While a background spawn is open, every 15 s: its `agent-<id>.meta.json` saying `"finished": true` ends it done; and
 * one whose record and whose session's record have been silent for `SILENT_MS` while no Claude Code process is left to
 * run it ends stopped (a stop, a crash or a restart whose note never came).
 */
export class DispatchSubagentMetaWatch extends Disposable {

	private _reading = false;

	constructor(
		private readonly _folder: () => string | undefined,
		private readonly _processAlive: () => boolean,
		private readonly _chat: URI,
		private readonly _registry: SubagentRegistry,
		private readonly _fire: (signal: AgentSignal) => void,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) {
		super();
		const timer = setInterval(() => void this.read(), META_EVERY_MS);
		this._register({ dispose: () => clearInterval(timer) });
	}

	static folder(configDir: string, cwd: string | undefined, sessionId: string): string | undefined {
		return cwd ? subagentFolder(configDir, cwd, sessionId) : undefined;
	}

	async read(): Promise<void> {
		const open = this._registry.openBackgroundSpawns();
		const folder = this._folder();
		if (!open.length || !folder || this._reading) {
			return;
		}
		this._reading = true;
		try {
			const dir = URI.file(folder);
			if (!await this._fileService.exists(dir)) {
				return;
			}
			const stat = await this._fileService.resolve(dir, { resolveMetadata: true });
			const files = stat.children ?? [];
			const parent = await this._fileService.stat(URI.file(`${folder.replace(/\/subagents\/?$/, '')}.jsonl`)).catch(() => undefined);
			const now = Date.now();
			for (const meta of files.filter(child => child.name.endsWith('.meta.json'))) {
				const said = metaOf(await this._fileService.readFile(meta.resource).then(content => content.value.toString(), () => ''));
				if (!said || !open.includes(said.toolUseId)) {
					continue;
				}
				const record = files.find(child => child.name === meta.name.replace(/\.meta\.json$/, '.jsonl'));
				const signals = said.finished
					? endSpawns([said.toolUseId], this._chat, this._registry)
					: isSilent([record?.mtime, parent?.mtime], now, this._processAlive())
						? endSpawns([said.toolUseId], this._chat, this._registry, `Stopped: no word from it for ${SILENT_MS / 60_000} min and its Claude Code process is gone.`)
						: [];
				for (const signal of signals) {
					this._logService.info(`[Claude] background sub-agent ${said.toolUseId} ${said.finished ? 'finished by its meta.json' : 'silent with no process: stopped'}`);
					this._fire(signal);
				}
			}
		} catch (err) {
			this._logService.warn(`[Claude] reading sub-agent meta.json in ${folder} failed: ${err}`);
		} finally {
			this._reading = false;
		}
	}
}
