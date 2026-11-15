/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's models as the Agents window's model picker lists them. The list is
 *  OpenCode's own (`opencode models --verbose`: every model of every provider it has a key or a login
 *  for), the provider names come from OpenCode's models.dev cache, the default is the `model` of its
 *  global config. Pure helpers (no process, no DI) so they can be tested.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import { parse, type ParseError } from '../../../../base/common/json.js';
import { localize } from '../../../../nls.js';
import type { IAgentModelInfo } from '../../common/agent.js';
import { AGENT_MODEL_GROUP_LABEL_META_KEY, createAgentModelGroupMeta } from '../../common/agentModelSource.js';
import { getReasoningEffortDescription, getReasoningEffortLabel } from '../../common/reasoningEffort.js';
import type { ConfigSchema, ModelSelection } from '../../common/state/protocol/state.js';

export const OPENCODE_PROVIDER_ID = 'opencode' as const;


/** Key in `ModelSelection.config` the picker writes the thinking level to (same as Claude and Codex). */
export const OPENCODE_THINKING_LEVEL_KEY = 'thinkingLevel';

/** OpenCode's own "no variant": the model's default options. */
export const OPENCODE_DEFAULT_EFFORT = 'default';

export interface IOpenCodeModel {
	/** `provider/model`, what OpenCode takes as a model id */
	readonly id: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly vision: boolean;
	/** OpenCode's variants for the model (reasoning effort levels: low, medium, high, max, …) */
	readonly variants: readonly string[];
}

const MODEL_ID = /^[\w.@-]+\/\S+$/;

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * `opencode models --verbose`: each model is its `provider/model` line followed by the model as
 * pretty-printed JSON (the top-level object closes with a `}` at the start of a line). Plain
 * `opencode models` output (ids only) parses too, with the id as the name.
 */
export function parseOpenCodeModels(stdout: string): IOpenCodeModel[] {
	const lines = stdout.split(/\r?\n/);
	const models: IOpenCodeModel[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const id = lines[i].trim();
		if (!MODEL_ID.test(id) || lines[i].startsWith(' ')) {
			continue;
		}
		let data: Record<string, unknown> = {};
		if (lines[i + 1]?.startsWith('{')) {
			let end = i + 1;
			while (end < lines.length && lines[end] !== '}') {
				end++;
			}
			try {
				data = obj(JSON.parse(lines.slice(i + 1, end + 1).join('\n')));
			} catch {
				data = {};
			}
			i = end;
		}
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		const slash = id.indexOf('/');
		const providerId = typeof data['providerID'] === 'string' ? data['providerID'] as string : id.slice(0, slash);
		const modelId = typeof data['id'] === 'string' ? data['id'] as string : id.slice(slash + 1);
		const limit = obj(data['limit']);
		const input = obj(obj(data['capabilities'])['input']);
		const variants = Object.keys(obj(data['variants'])).filter(v => /^[\w.-]+$/.test(v));
		models.push({
			id, providerId, modelId,
			name: typeof data['name'] === 'string' && (data['name'] as string).trim() ? (data['name'] as string).trim() : modelId,
			contextWindow: num(limit['context']),
			maxOutputTokens: num(limit['output']),
			vision: input['image'] === true,
			variants,
		});
	}
	return models;
}

/** OpenCode's folders (it follows the XDG variables on every platform). */
export function opencodePaths(env: NodeJS.ProcessEnv = process.env): { config: string; data: string; cache: string } {
	const home = os.homedir();
	return {
		config: path.join(env['XDG_CONFIG_HOME'] || path.join(home, '.config'), 'opencode'),
		data: path.join(env['XDG_DATA_HOME'] || path.join(home, '.local', 'share'), 'opencode'),
		cache: path.join(env['XDG_CACHE_HOME'] || path.join(home, '.cache'), 'opencode'),
	};
}

/** The global config files OpenCode merges, lowest precedence first. */
export function opencodeConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
	const dir = opencodePaths(env).config;
	const files = [path.join(dir, 'config.json'), path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
	if (env['OPENCODE_CONFIG']) {
		files.push(env['OPENCODE_CONFIG']);
	}
	return files;
}

/** JSON with comments and trailing commas, as OpenCode reads its config; undefined when it is not an object. */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The default model from OpenCode's global config: the last file that sets `model` wins, then
 * `OPENCODE_CONFIG_CONTENT` (an inline config). `read` returns a file's text or undefined.
 */
export function readDefaultModel(read: (file: string) => string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	let model: string | undefined;
	const texts = opencodeConfigFiles(env).map(read);
	if (env['OPENCODE_CONFIG_CONTENT']) {
		texts.push(env['OPENCODE_CONFIG_CONTENT']);
	}
	for (const text of texts) {
		const config = text ? parseJsonc(text) : undefined;
		if (config && typeof config['model'] === 'string' && MODEL_ID.test(config['model'] as string)) {
			model = config['model'] as string;
		}
	}
	return model;
}

/** Provider display names: models.dev's cache that OpenCode keeps, then providers the config defines. */
export function readProviderNames(cacheText: string | undefined, configTexts: readonly (string | undefined)[]): Map<string, string> {
	const names = new Map<string, string>();
	if (cacheText) {
		try {
			const cache = obj(JSON.parse(cacheText));
			for (const [id, provider] of Object.entries(cache)) {
				const name = obj(provider)['name'];
				if (typeof name === 'string' && name.trim()) {
					names.set(id, name.trim());
				}
			}
		} catch {
			// a half-written cache: the ids stand in
		}
	}
	for (const text of configTexts) {
		const providers = obj(text ? parseJsonc(text)?.['provider'] : undefined);
		for (const [id, provider] of Object.entries(providers)) {
			const name = obj(provider)['name'];
			if (typeof name === 'string' && name.trim()) {
				names.set(id, name.trim());
			}
		}
	}
	return names;
}

/** `zhipuai-coding-plan` → `Zhipuai Coding Plan`, for a provider nobody named. */
export function providerFallbackName(providerId: string): string {
	return providerId.split(/[-_]/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || providerId;
}

/** The thinking level picker entry for a model with variants; none for a model without. */
export function opencodeThinkingLevelSchema(variants: readonly string[]): ConfigSchema | undefined {
	if (!variants.length) {
		return undefined;
	}
	const values = [OPENCODE_DEFAULT_EFFORT, ...variants.filter(v => v !== OPENCODE_DEFAULT_EFFORT)];
	return {
		type: 'object',
		properties: {
			[OPENCODE_THINKING_LEVEL_KEY]: {
				type: 'string',
				title: localize('opencode.modelThinkingLevel.title', "Thinking Level"),
				description: localize('opencode.modelThinkingLevel.description', "How much reasoning effort the model uses (OpenCode's variants)."),
				enum: values,
				enumLabels: values.map(v => v === OPENCODE_DEFAULT_EFFORT ? localize('opencode.effort.default', "Default") : getReasoningEffortLabel(v)),
				enumDescriptions: values.map(v => v === OPENCODE_DEFAULT_EFFORT
					? localize('opencode.effort.defaultDescription', "The model's own default")
					: getReasoningEffortDescription(v) ?? ''),
				default: OPENCODE_DEFAULT_EFFORT,
			},
		},
	};
}

/** The thinking level a selection asks for (`default` when none is set). */
export function opencodeEffortOf(model: ModelSelection | undefined): string {
	const value = model?.config?.[OPENCODE_THINKING_LEVEL_KEY];
	return typeof value === 'string' && /^[\w.-]+$/.test(value) ? value : OPENCODE_DEFAULT_EFFORT;
}

/**
 * The picker's list: the default model first (a new session starts on it), then the rest of its
 * provider, then every other provider by name, each provider's models in OpenCode's order. Each
 * model carries its provider as the picker group (`modelGroupId`) and the group title.
 */
export function toAgentModels(models: readonly IOpenCodeModel[], providerNames: ReadonlyMap<string, string>, defaultModel: string | undefined): IAgentModelInfo[] {
	const byProvider = new Map<string, IOpenCodeModel[]>();
	for (const model of models) {
		let list = byProvider.get(model.providerId);
		if (!list) {
			list = [];
			byProvider.set(model.providerId, list);
		}
		list.push(model);
	}
	const nameOf = (providerId: string) => providerNames.get(providerId) ?? providerFallbackName(providerId);
	const defaultProvider = defaultModel && models.some(m => m.id === defaultModel) ? defaultModel.slice(0, defaultModel.indexOf('/')) : undefined;
	const providers = [...byProvider.keys()].sort((a, b) => {
		if (a === defaultProvider || b === defaultProvider) {
			return a === defaultProvider ? -1 : 1;
		}
		return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
	});
	const out: IAgentModelInfo[] = [];
	for (const providerId of providers) {
		const list = [...byProvider.get(providerId)!];
		const first = list.findIndex(m => m.id === defaultModel);
		if (first > 0) {
			list.unshift(...list.splice(first, 1));
		}
		for (const model of list) {
			const configSchema = opencodeThinkingLevelSchema(model.variants);
			out.push({
				provider: OPENCODE_PROVIDER_ID,
				id: model.id,
				name: model.name,
				supportsVision: model.vision,
				...(model.contextWindow ? { maxContextWindow: model.contextWindow } : {}),
				...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
				...(configSchema ? { configSchema } : {}),
				// the provider as the picker group, its name as the group's title
				_meta: { ...createAgentModelGroupMeta(providerId), [AGENT_MODEL_GROUP_LABEL_META_KEY]: nameOf(providerId) },
			});
		}
	}
	return out;
}

/**
 * Provider and model names from a session's `model` config option ("Zhipu AI Coding Plan/GLM-5.3
 * Flash"), for a provider the models.dev cache does not name. Returns the names it learned.
 */
export function namesFromModelOption(options: readonly { readonly value: string; readonly name?: string }[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const option of options) {
		const slash = option.value.indexOf('/');
		const label = option.name ?? '';
		const cut = label.indexOf('/');
		if (slash > 0 && cut > 0) {
			names.set(option.value.slice(0, slash), label.slice(0, cut).trim());
		}
	}
	return names;
}
