import type { Dict } from "../../i18n";
// Keys that must read differently in Chinese: the project page's tab names, where English and German
// need a plural ("Tasks") that the shared "任务" key ("Task") does not give.
const projectsSettings: Dict = {
  "项目页·任务": "任务",
  "项目页·成果": "成果",
};
export default projectsSettings;
