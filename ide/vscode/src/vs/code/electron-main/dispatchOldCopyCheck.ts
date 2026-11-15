/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: an old copy started from a build folder or a backup offers the installed version (task-7ve7v).
 *  The pure part; dispatchOldCopy.ts asks and switches. No imports: ide/tests run it under plain Node.
 *--------------------------------------------------------------------------------------------*/

/** The .app a running copy is ("/x/Dispatch IDE.app/Contents/Resources/app" → "/x/Dispatch IDE.app"). */
export function dispatchBundleOf(appRoot: string): string | undefined {
	const m = /^(.*\.app)\/Contents\/Resources\/app\/?$/.exec(appRoot);
	return m ? m[1] : undefined;
}

export interface IDispatchOldCopyFacts {
	/** This copy's .app, undefined when it does not run from one (built from source). */
	readonly bundle: string | undefined;
	/** The installed copy: /Applications/Dispatch IDE.app. */
	readonly installed: string;
	/** When each was built (product.json's date); undefined when it says none. */
	readonly ownDate: string | undefined;
	readonly installedDate: string | undefined;
	/** The copies already asked about once: never again. */
	readonly asked: readonly string[];
}

/**
 * Offer the installed version when this copy is not in /Applications, the installed one is newer (built later; the
 * version number is the same for every build) and this copy was not asked about before.
 */
export function dispatchShouldOfferInstalled(f: IDispatchOldCopyFacts): boolean {
	if (!f.bundle || f.bundle === f.installed || f.bundle.startsWith('/Applications/') || f.asked.includes(f.bundle)) {
		return false;
	}
	const own = Date.parse(f.ownDate ?? '');
	const installed = Date.parse(f.installedDate ?? '');
	return !isNaN(own) && !isNaN(installed) && installed > own;
}

/** "Oct 1, 2026" for a product.json date, the way the dialog says it. */
export function dispatchBuiltOn(date: string | undefined): string {
	const t = Date.parse(date ?? '');
	return isNaN(t) ? '?' : new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
