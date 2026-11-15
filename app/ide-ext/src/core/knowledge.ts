// The CLI calls behind the Knowledge page (Preferences = `dispatch prefs`, Wiki, Facts = FACTS.md, Profile =
// PROFILE.md, Engine memory = `dispatch memories`). Facts and Profile are edited in their files (the page opens
// them at the line); here only their Delete. (Dispatch IDE, Agents window, Customizations → Knowledge;
// patches/525-knowledge.patch; the line under a reply that remembered a preference asks for
// prefsIds / prefsForget / prefsUndo / prefsEdit too, patches/335-preferences.patch.) The page asks for an
// operation by name and the bridge builds the command line here: the page never passes raw arguments.
// Nothing the person typed may be read as an option: bodies go through stdin, fields as `--name=value`,
// and a query or topic that starts with "-" gets a leading space (the CLI strips it). No "--": the
// Python 3.9 that the IDE's PATH finds rejects it after a subcommand's options.

export type WikiKind = "pit" | "win" | "retro" | "howto";

export const WIKI_FIELDS: Record<WikiKind, string[]> = {
  pit: ["fix"],
  win: ["why"],
  retro: ["tech", "good", "bad"],
  howto: [],
};

export interface KnowledgeCall {
  args: string[];
  /** written to the CLI's stdin */
  input?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** A positional value argparse will not take for an option. */
const positional = (v: string) => (v.startsWith("-") ? ` ${v}` : v);
function lineOf(p: Record<string, unknown>): number {
  const n = Number(p.line);
  if (!Number.isInteger(n) || n < 1) throw new Error("no line");
  return n;
}
function keyOf(p: Record<string, unknown>): string {
  const key = str(p.key).trim();
  if (!key || key.startsWith("-")) throw new Error("no key");
  return key;
}
const isKind = (v: unknown): v is WikiKind => typeof v === "string" && v in WIKI_FIELDS;
const fieldsOf = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string") as [string, string][]) : {};

const PREF_ID = /^pref-[a-z0-9]{4,10}$/;
const POLARITY = new Set(["like", "avoid"]);
const AREA = new Set(["design", "workflow", "writing", "tools"]);

function prefId(p: Record<string, unknown>): string {
  const id = str(p.id).trim();
  if (!PREF_ID.test(id)) throw new Error("no preference id");
  return id;
}
function prefIds(p: Record<string, unknown>): string[] {
  const ids = (Array.isArray(p.ids) ? p.ids : [p.id]).map((x) => str(x).trim()).filter((x) => PREF_ID.test(x));
  if (!ids.length) throw new Error("no preference id");
  return [...new Set(ids)].slice(0, 50);
}
/** --name=value for the fields a person may type into; nothing when the field is not given. */
function prefFields(p: Record<string, unknown>, withText: boolean): { args: string[]; input?: string } {
  const args: string[] = [];
  for (const f of ["name", "scope", "quote"]) {
    if (typeof p[f] === "string") args.push(`--${f}=${(p[f] as string).trim()}`);
  }
  if (typeof p.area === "string") {
    if (!AREA.has(p.area)) throw new Error("area is design, workflow, writing or tools");
    args.push(`--area=${p.area}`);
  }
  if (typeof p.polarity === "string") {
    if (!POLARITY.has(p.polarity)) throw new Error("like or avoid");
    args.push(`--${p.polarity}`);
  }
  let input: string | undefined;
  if (withText && typeof p.text === "string") {
    if (!p.text.trim()) throw new Error("the preference is empty");
    input = p.text.trim();
  }
  return { args, input };
}

/** The command line for one page operation; an Error for anything else or a missing argument. */
export function knowledgeCall(op: string, p: Record<string, unknown> = {}): KnowledgeCall {
  switch (op) {
    case "prefsList":
      return { args: ["prefs", "list", "--all", "--thumbs", "chip", "--json"] };
    case "prefsNames":
      // a session's replies: which short names in brackets are preferences (no thumbnails)
      return { args: ["prefs", "list", "--json"] };
    case "prefsIds":
      // the line under a reply in a session: these, forgotten ones included
      return { args: ["prefs", "list", `--ids=${prefIds(p).join(",")}`, "--thumbs", "chip", "--json"] };
    case "prefsShow":
      return { args: ["prefs", "show", prefId(p), "--thumbs", "card", "--json"] };
    case "prefsAdd": {
      const f = prefFields(p, true);
      if (f.input === undefined) throw new Error("the preference is empty");
      return { args: ["prefs", "add", "-", "--json", ...f.args], input: f.input };
    }
    case "prefsEdit": {
      const f = prefFields(p, true);
      const args = ["prefs", "edit", prefId(p), "--json", ...f.args];
      if (f.input !== undefined) args.push("--text=-");
      if (args.length === 4) throw new Error("nothing to change");
      return { args, input: f.input };
    }
    case "prefsForget":
      // justSaid: the Undo right after an agent remembered it (one that was there before only loses the new words)
      return { args: ["prefs", "forget", ...prefIds(p), ...(p.justSaid ? ["--just-said"] : []), "--json"] };
    case "prefsUndo":
      return { args: ["prefs", "undo", ...(p.id ? [prefId(p)] : []), "--json"] };
    case "prefsKeep":
      return { args: ["prefs", "keep", prefId(p), "--json"] };
    case "prefsSeen":
      return { args: ["prefs", "seen", "--all", "--json"] };
    case "prefsCite": {
      // a name as the reply wrote it: never read as an option (the CLI strips the space)
      const names = (Array.isArray(p.names) ? p.names : []).map((x) => str(x).trim()).filter(Boolean).slice(0, 20);
      if (!names.length) throw new Error("no preference name");
      const ref = str(p.ref).trim();
      return { args: ["prefs", "cite", ...names.map(positional), ...(ref ? [`--ref=${ref}`] : []), "--by=reply", "--json"] };
    }
    case "prefsImport":
      // the page's Import writes only what is clearly a preference; the rest waits in pending-import.json
      return { args: ["prefs", "import", ...(p.apply === true ? ["--apply", "--sure-only"] : ["--dry-run"]), "--json"] };
    case "memoriesList":
      return { args: ["memories", "list", "--json"] };
    case "wikiList":
      return { args: ["wiki", "list", "--dated", "--json"] };
    case "wikiSearch": {
      const q = str(p.query).trim();
      return { args: q ? ["wiki", "search", positional(q), "--dated", "--json"] : ["wiki", "list", "--dated", "--json"] };
    }
    case "wikiAdd": {
      const body = str(p.body).trim();
      if (!isKind(p.kind)) throw new Error("kind must be pit, win, retro or howto");
      if (!body) throw new Error("the entry is empty");
      const args = ["wiki", "add", "--kind", p.kind, "--json", "--body", "-"];
      const fields = fieldsOf(p.fields);
      for (const f of WIKI_FIELDS[p.kind]) if (fields[f]?.trim()) args.push(`--${f}=${fields[f].trim()}`);
      const project = str(p.project).trim();
      if (project) args.push(`--project=${project}`);
      return { args, input: body };
    }
    case "wikiEdit": {
      const args = ["wiki", "edit", keyOf(p), "--json"];
      let input: string | undefined;
      if (typeof p.body === "string") {
        if (!p.body.trim()) throw new Error("the entry is empty");
        args.push("--body", "-");
        input = p.body.trim();
      }
      const fields = fieldsOf(p.fields);
      for (const f of ["fix", "why", "tech", "good", "bad"]) if (f in fields) args.push(`--${f}=${fields[f].trim()}`);
      if (args.length === 4) throw new Error("nothing to change");
      return { args, input };
    }
    case "wikiRemove": {
      return { args: ["wiki", "rm", keyOf(p), "--json"] };
    }
    case "factsList":
      return { args: ["facts", "list", "--json"] };
    case "factsDrop":
      return { args: ["facts", "drop", String(lineOf(p)), `--text=${str(p.text)}`, "--json"] };
    case "profileShow":
      return { args: ["profile", "show", "--json"] };
    case "profileDrop":
      return { args: ["profile", "drop", String(lineOf(p)), `--text=${str(p.text)}`, "--json"] };
    default:
      throw new Error(`unknown operation ${op}`);
  }
}
