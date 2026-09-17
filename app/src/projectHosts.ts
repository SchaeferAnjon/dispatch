// Which Mac a project lives on (after `dispatch project --move-to`, the shared 项目归属 record).
// Things read from the project's own folder — its git log, its FACTS.md — have to be asked on that
// Mac; asking this one returns nothing. Filled by App from the owners record and hosts.json.
let owners: Record<string, string> = {};
export function setProjectHosts(map: Record<string, string>) { owners = map; }
/** The host id to run a per-project command on: the owner Mac when it is another one, else "local". */
export function hostOfProject(name: string | undefined | null): string { return (name && owners[name]) || "local"; }
