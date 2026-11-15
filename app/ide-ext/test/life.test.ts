import { describe, expect, it } from "vitest";
import { lifeSnapshot, handoffRows, lifeSession } from "../src/core/life";
import { docRows } from "../src/core/docs";
describe("Quiet markers contracts", () => {
 it("distinguishes unavailable usage from measured zero", () => {
  expect(lifeSnapshot({ context_tokens: null, percent: null }).percent).toBeUndefined();
  expect(lifeSnapshot({ context_tokens: 0, percent: 0 }).percent).toBe(0);
  expect(lifeSnapshot({ elapsed_seconds: -1, context_tokens: Infinity }).context_tokens).toBeUndefined();
 });
 it("keeps all committed boundaries in chronological order without duplicates", () => {
  const h = { id: 'b', path: '/handoff/b.md', task: 'task-abcd', after_turn: 7, created_at: 20 };
  expect(handoffRows([h, { ...h, id: 'a', created_at: 10 }, h, { ...h, id: 'bad', registered: false }]).map(x => x.id)).toEqual(['a', 'b']);
  expect(handoffRows([{ ...h, path: 'https://elsewhere' }])).toEqual([]);
 });
 it("rejects invalid session arguments", () => {
  expect(lifeSession('--help')).toBeUndefined();
  expect(lifeSession('agent-host-opencode:/abcd')).toBe('opencode:abcd');
 });
 it("recognizes handoff kind even before the backend adds a dedicated group", () => {
  expect(docRows({ docs: [{ path: '/handoff/a.md', kind: 'handoff', group: 'notes', tasks: [{ id: 'task-abcd', title: 'Continue build' }] }] })[0]).toMatchObject({ group: 'handoff', tasks: [{ id: 'task-abcd', title: 'Continue build' }] });
 });
});
describe("context breakdown", () => {
  it("keeps Claude Code's rows with numbers, drops the rest, and is absent without a window", () => {
    const b = lifeSnapshot({ breakdown: { total: 92000, max: 200000, model: "opus", categories: [{ name: "Messages", tokens: 56000 }, { name: "MCP tools (deferred)", tokens: 300, deferred: true }, { name: 7 }, { name: "x", tokens: -1 }] } }).breakdown;
    expect(b?.categories).toEqual([{ name: "Messages", tokens: 56000, deferred: false }, { name: "MCP tools (deferred)", tokens: 300, deferred: true }]);
    expect(b?.max).toBe(200000);
    expect(lifeSnapshot({ breakdown: {} }).breakdown).toBeUndefined();
    expect(lifeSnapshot({}).breakdown).toBeUndefined();
  });
});
