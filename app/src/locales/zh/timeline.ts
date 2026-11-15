import type { Dict } from "../../i18n";
// 项目页 v3 (Timeline.tsx): keys that read differently in Chinese only because English and German need
// another word than the shared key gives (the kind words, the stat labels, a row count).
const timeline: Dict = {
  "种类·收尾": "收尾", "种类·作废": "作废", "种类·结论": "结论", "种类·验收": "验收", "种类·提交": "提交", "种类·回复": "回复", "种类·做了": "做了",
  "统计·条线": "条线", "统计·还在动": "还在动", "统计·任务": "任务", "统计·收尾": "收尾", "统计·提交": "提交", "统计·结论": "结论",
  "时间线·{n} 条": "{n} 条",
};
export default timeline;
