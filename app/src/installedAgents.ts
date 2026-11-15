// Which agents exist on this Mac (`dispatch agents-installed`): dialogs default to one the person
// actually has and grey out the rest, instead of assuming the author's full set. Unknown (older
// CLI, not loaded yet) means "do not restrict".
let installed: Set<string> | null = null;
const KIND_TO_ID: Record<string, string> = { claude: "claude-code" };
const idOf = (kindOrId: string) => KIND_TO_ID[kindOrId] ?? kindOrId;

export function setInstalledAgents(ids: string[] | null) { installed = ids ? new Set(ids) : null; }
export function isInstalled(kindOrId: string): boolean { return installed === null || installed.has(idOf(kindOrId)); }
/** The first candidate that is installed; the first candidate when nothing is known or none is. */
export function firstInstalled(candidates: string[]): string { return candidates.find((c) => isInstalled(c)) ?? candidates[0]; }
