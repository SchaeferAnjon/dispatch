// node sign.mjs <app> <identity>: sign Dispatch IDE.app with a Developer ID the way VS Code's own build does
// (vscode/build/darwin/sign.ts): @electron/osx-sign walks every Mach-O inside out, hardened runtime, secure
// timestamp, and VS Code's entitlements per helper (allow-jit everywhere; the Plugin helper, which runs the
// extension host, also unsigned executable memory and no library validation). Called by sign.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [app, identity] = process.argv.slice(2);
if (!app || !identity) {
	console.error('usage: node sign.mjs <app> <identity>');
	process.exit(2);
}
const ent = (name) => path.join(here, 'vscode/build/azure-pipelines/darwin', name);
function entitlementsFor(file) {
	if (file.includes(' Helper (GPU).app')) { return ent('helper-gpu-entitlements.plist'); }
	if (file.includes(' Helper (Renderer).app')) { return ent('helper-renderer-entitlements.plist'); }
	if (file.includes(' Helper (Plugin).app')) { return ent('helper-plugin-entitlements.plist'); }
	if (file.includes(' Helper.app')) { return ent('helper-entitlements.plist'); }
	return ent('app-entitlements.plist');
}

// What the app asks for under the hardened runtime needs a sentence in Info.plist, or macOS refuses it.
const plist = path.join(app, 'Contents', 'Info.plist');
for (const [key, text] of [
	['NSAppleEventsUsageDescription', 'An extension in Dispatch IDE wants to use AppleScript.'],
	['NSMicrophoneUsageDescription', 'An extension in Dispatch IDE wants to use the Microphone.'],
	['NSCameraUsageDescription', 'An extension in Dispatch IDE wants to use the Camera.'],
	['NSAudioCaptureUsageDescription', 'An extension in Dispatch IDE wants to use Audio Capture.'],
	['NSLocalNetworkUsageDescription', 'Dispatch IDE uses your local network for DNS resolution and to connect to locally running services.'],
]) {
	execFileSync('plutil', ['-replace', key, '-string', text, plist]);
}

const npmrc = fs.readFileSync(path.join(here, 'vscode/.npmrc'), 'utf8');
const version = /^target="(.*)"$/m.exec(npmrc)[1];
// sign.sh says where @electron/osx-sign is (this checkout's vscode/build/node_modules, or its own copy in .cache)
const osxSign = process.env.DISPATCH_OSX_SIGN || path.join(here, 'vscode/build/node_modules/@electron/osx-sign');
const { sign } = await import(pathToFileURL(path.join(osxSign, 'dist/index.js')).href);
await sign({
	app,
	platform: 'darwin',
	identity,
	version,
	optionsForFile: (file) => ({ entitlements: entitlementsFor(file), hardenedRuntime: true }),
	preAutoEntitlements: false,
	preEmbedProvisioningProfile: false,
});
console.log(`signed with: ${identity} (hardened runtime)`);
