/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a whole file system path in a Markdown link opens as it is (325-path-links.patch). Markdown reads
 *  `/path` as relative to the workspace folder; agents write whole paths. openDocumentLink.ts asks this first.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as proto from '../client/protocol';

/** A `/…` link (optional `#fragment`) naming a file or folder that exists at that absolute path, for a local document. */
export async function dispatchAbsoluteTarget(linkText: string, fromResource: vscode.Uri): Promise<proto.ResolvedDocumentLinkTarget | undefined> {
	if (!linkText.startsWith('/') || linkText.startsWith('//') || (fromResource.scheme !== 'file' && fromResource.scheme !== 'untitled')) {
		return undefined;
	}
	const hash = linkText.indexOf('#');
	let path: string;
	try {
		path = decodeURIComponent(hash >= 0 ? linkText.slice(0, hash) : linkText);
	} catch {
		return undefined;
	}
	const uri = vscode.Uri.file(path).with({ fragment: hash >= 0 ? linkText.slice(hash + 1) : '' });
	try {
		const stat = await vscode.workspace.fs.stat(uri.with({ fragment: '' }));
		if (stat.type & vscode.FileType.Directory) {
			return { kind: 'folder', uri: uri.with({ fragment: '' }) };
		}
		return { kind: 'file', uri, fragment: uri.fragment || undefined };
	} catch {
		return undefined;
	}
}
