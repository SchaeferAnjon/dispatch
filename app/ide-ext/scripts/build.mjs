// Build dist/dispatch-bridge.vsix: install the dev dependencies when needed, compile with tsc, pack
// the extension. A .vsix is a zip (extension.vsixmanifest, [Content_Types].xml, extension/…); it is
// written here with node's zlib so the build needs no vsce. Entries are sorted and dated 1980-01-01,
// so the same sources give the same bytes (ide.py reinstalls the bridge only when its sha256 changes).
// Windows has no full IDE (design/full-ide/PLAN.md §6): the build is skipped there.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const dist = path.join(ext, "dist");
const out = path.join(dist, "dispatch-bridge.vsix");

if (process.platform === "win32" && !process.env.DISPATCH_BUILD_EXT_ON_WINDOWS) {
  console.log("dispatch-bridge: skipped on Windows (no full IDE there)");
  process.exit(0);
}

function npm(args) {
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(cmd, args, { cwd: ext, stdio: "inherit", shell: process.platform === "win32" });
}

const lock = path.join(ext, "package-lock.json");
const stamp = path.join(ext, "node_modules", ".package-lock.json");
const tscBin = path.join(ext, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscBin) || !fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < fs.statSync(lock).mtimeMs) {
  npm(["ci", "--no-audit", "--no-fund"]);
}

fs.rmSync(path.join(ext, "out"), { recursive: true, force: true });
execFileSync(process.execPath, [tscBin, "-p", ext], { cwd: ext, stdio: "inherit" });

const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));

function walk(rel) {
  const full = path.join(ext, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [rel];
  return fs.readdirSync(full).flatMap((n) => walk(path.join(rel, n)));
}

const files = [
  "package.json",
  "README.md",
  ...fs.readdirSync(ext).filter((n) => /^package\.nls(\.[\w-]+)?\.json$/.test(n)),
  ...walk("l10n"),
  ...walk("media"),
  ...walk("themes"),
  ...walk("out").filter((f) => f.endsWith(".js")),
]
  .map((f) => f.split(path.sep).join("/"))
  .sort();

const manifestPkg = { ...pkg };
delete manifestPkg.devDependencies;
delete manifestPkg.scripts;

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
const vsixmanifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>Dispatch Bridge</DisplayName>
    <Description xml:space="preserve">Dispatch inside the IDE: Cmd+K edits, Tab completion, agent changes, checkpoints, codebase search.</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="de,zh-cn" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const types = [...new Set(files.map((f) => path.extname(f).slice(1)).concat(["vsixmanifest"]))].sort();
const mime = { json: "application/json", js: "application/javascript", md: "text/markdown", svg: "image/svg+xml", vsixmanifest: "text/xml", png: "image/png" };
const contentTypes =
  '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  types.map((t) => `<Default Extension=".${t}" ContentType="${mime[t] || "application/octet-stream"}" />`).join("") +
  "</Types>\n";

const entries = [
  { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
  { name: "extension.vsixmanifest", data: Buffer.from(vsixmanifest) },
  ...files.map((f) => ({
    name: "extension/" + f,
    data: f === "package.json" ? Buffer.from(JSON.stringify(manifestPkg, null, 2) + "\n") : fs.readFileSync(path.join(ext, f)),
  })),
];

fs.mkdirSync(dist, { recursive: true });
const tmp = out + ".tmp";
fs.writeFileSync(tmp, zip(entries));
fs.renameSync(tmp, out);
console.log(`dispatch-bridge ${pkg.version}: ${path.relative(process.cwd(), out)} (${entries.length} files, ${fs.statSync(out).size} bytes)`);
