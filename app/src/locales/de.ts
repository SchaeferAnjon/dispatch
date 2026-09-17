import type { Dict } from "../i18n";
import common from "./de/common";
import app from "./de/app";
import project from "./de/project";
import task from "./de/task";
import session from "./de/session";
import settings from "./de/settings";
// One flat dictionary; the groups only mirror which components own the strings.
const de: Dict = { ...common, ...app, ...project, ...task, ...session, ...settings };
export default de;
