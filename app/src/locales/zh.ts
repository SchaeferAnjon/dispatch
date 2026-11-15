import type { Dict } from "../i18n";
import projectsSettings from "./zh/projectsSettings";
import timeline from "./zh/timeline";
// Chinese is the source language: keys are the Chinese strings themselves, so nothing to map here.
// Add an entry only when the zh rendering must differ from the key (it normally must not).
const zh: Dict = {
  ...projectsSettings,
  ...timeline,
  // 脉络: the discussion record says 讨论; the key differs only because en/de already use 讨论 for the page.
  "讨论（这一轮）": "讨论",
  // the task page's 验收 button (a verb); 验收 on its own is the noun (the acceptance section)
  "验收（动作）": "验收",
};
export default zh;
