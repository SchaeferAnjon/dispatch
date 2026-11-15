/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session that is not a chat draws its own view where the chat would be.
 *
 *  The session view (parts/sessionView.ts) asks these before it builds a chat view. The terminal sessions
 *  (contrib/dispatchTerminal) are the one user today. Returns undefined for every session that is a chat.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ISession } from '../services/sessions/common/session.js';
import { AbstractChatView } from './parts/chatView.js';

export interface IDispatchSessionViewFactory {
	/** The view for a session of this kind, or undefined for any other session. */
	create(session: ISession, instantiationService: IInstantiationService): AbstractChatView | undefined;
}

const factories: IDispatchSessionViewFactory[] = [];

export function registerDispatchSessionView(factory: IDispatchSessionViewFactory): IDisposable {
	factories.push(factory);
	return toDisposable(() => {
		const i = factories.indexOf(factory);
		if (i >= 0) {
			factories.splice(i, 1);
		}
	});
}

export function createDispatchSessionView(session: ISession, instantiationService: IInstantiationService): AbstractChatView | undefined {
	for (const factory of factories) {
		const view = factory.create(session, instantiationService);
		if (view) {
			return view;
		}
	}
	return undefined;
}
