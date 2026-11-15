// The app icon's static SVG files, written from the one layout (ide/vscode/src/vs/base/common/dispatchIcon.ts) so they
// are the Dock's icon at their size like every drawing in code (kanban preference「图标处处同 Dock」):
//   sessions/contrib/files/browser/media/dispatch-mark.svg      the empty Files view, the logo 153px wide, its glow breathing
//   sessions/browser/media/dispatch-agent-icon-color.svg         the editor's "Open in Agents" button, 16px, in colour
//   sessions/browser/media/dispatch-agent-icon.svg               the same as a mask, inside the plate's outline, 16px
//
// Usage: node ide/gen-icon-svgs.mjs [--check]   (--check: exit 1 when a file on disk differs; ide/tests/palette.test.mjs
// holds the files to it too). Node 23 or later: it imports the .ts directly.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// the sources import each other as `.js` (what the build writes): take the `.ts` beside it
registerHooks({
	resolve: (spec, ctx, next) => {
		try {
			return next(spec, ctx);
		} catch (e) {
			if (e?.code === 'ERR_MODULE_NOT_FOUND' && spec.endsWith('.js')) {
				return next(spec.slice(0, -3) + '.ts', ctx);
			}
			throw e;
		}
	},
});

const vs = fileURLToPath(new URL('./vscode/src/vs/', import.meta.url));
const { dispatchIconSvg } = await import(pathToFileURL(path.join(vs, 'base/common/dispatchIcon.ts')).href);

export const ICON_FILES = {
	'sessions/contrib/files/browser/media/dispatch-mark.svg': dispatchIconSvg(153, { fill: 'light', breatheStyle: true, tight: true, mark: true }),
	'sessions/browser/media/dispatch-agent-icon-color.svg': dispatchIconSvg(16, { fill: 'light', dpr: 2 }),
	'sessions/browser/media/dispatch-agent-icon.svg': dispatchIconSvg(16, { plate: true, dpr: 2, fill: 'mono' }),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes('--check');
	let stale = 0;
	for (const [rel, text] of Object.entries(ICON_FILES)) {
		const file = path.join(vs, rel);
		if (fs.readFileSync(file, 'utf8') === text) {
			continue;
		}
		if (check) {
			console.error(`stale: ${rel}`);
			stale++;
		} else {
			fs.writeFileSync(file, text);
			console.log(`wrote ${rel}`);
		}
	}
	process.exit(stale ? 1 : 0);
}
