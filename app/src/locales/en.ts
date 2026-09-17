import type { Dict } from "../i18n";
import common from "./en/common";
import app from "./en/app";
import project from "./en/project";
import task from "./en/task";
import session from "./en/session";
import settings from "./en/settings";
// One flat dictionary; the groups only mirror which components own the strings.
const en: Dict = { ...common, ...app, ...project, ...task, ...session, ...settings };
export default en;
