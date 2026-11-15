// Customizations › Overview › Find Skills: search the skill pool first, then public skills.
// Types a query into the Find Skills box and shows the results; installs nothing.
export const meta = { needs: ['internet'],
  title: "Settings 里的 Find Skills",
  description: "Settings › Abilities › Find skills 里的 Find Skills：先搜技能池，再搜公开技能，装之前会问一次。",
};

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.openCustomizations("Overview");
  await ui.scrollTo("Find Skills");
  await ui.type("pdf", { into: "Search skills" });
  await ui.press("Enter");
  // the pool answers at once, skills.sh takes a moment; the results open below the box, out of view
  await ui.waitForText("In your pool", { timeoutMs: 20000 });
  await ui.sleep(3000);
  await ui.scrollTo("In your pool");
  await ui.screenshot("find-skills");
  await ui.mark({ text: "Abilities", exact: true, within: ".dispatch-settings-nav" }, { what: "Abilities", where: "Settings 左栏", how: "⌘, 打开 Settings，点 Abilities" });
  await ui.mark({ text: "Find Skills", exact: true }, { what: "Find Skills 区块", where: "Abilities › Find skills 页往下滚到底", how: "Abilities 列表最后的 Find skills" });
  await ui.mark("Search skills", { what: "技能搜索框", where: "Find Skills 标题下面", how: "输入关键词回车，先出技能池里的，再出公开的" });
  await ui.mark("In your pool", { what: "技能池里的结果", where: "搜索框下面第一组", how: "已在池里的技能，按当前引擎挂载" });
}
