import { describe, expect, it } from "vitest";
import { ownerBlock } from "./NewChat";

// dispatch-project-owners: a project's sessions start only on the Mac it belongs to.
describe("新建会话 and the project's own Mac", () => {
  const hosts = [{ id: "local", local: true, online: true }, { id: "hub", local: false, online: true }];
  const hub = { id: "hub", name: "小蓝" };

  it("lets a project start on its owner and anything without an owner start anywhere", () => {
    expect(ownerBlock("harbor", hub, "hub", hosts)).toBe("");
    expect(ownerBlock("scratch", undefined, "local", hosts)).toBe("");
  });

  it("says which Mac when another one is picked", () => {
    expect(ownerBlock("harbor", hub, "local", hosts)).toBe("项目 harbor 归「小蓝」，会话只在那台上开。");
  });

  it("names the owner when it is offline instead of falling back to this Mac", () => {
    const off = [hosts[0], { ...hosts[1], online: false }];
    expect(ownerBlock("harbor", hub, "hub", off)).toBe("项目 harbor 归「小蓝」，它现在离线。这个项目的会话只在那台上开，等它上线再发。");
  });

  it("asks to add an owner this Mac does not know", () => {
    expect(ownerBlock("harbor", { name: "阁楼" }, "local", hosts)).toBe("项目 harbor 归「阁楼」，这台不认识那台电脑，先在「电脑」页把它加进来。");
  });
});
