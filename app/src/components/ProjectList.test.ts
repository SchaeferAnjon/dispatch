import { describe, expect, it } from 'vitest';
import { newFrozenOrder, stableOrder } from './ProjectHub';

type P = { name: string; today: boolean };
const order = (list: P[], memo = newFrozenOrder(), sig = 'all') => stableOrder(list, (p) => p.name, (p) => (p.today ? 'today' : 'earlier'), memo, sig);

describe('stableOrder (项目列表不在停留时重排)', () => {
  it('keeps rows and their groups where they were while the list stays open', () => {
    const memo = newFrozenOrder();
    const first = order([{ name: 'a', today: true }, { name: 'b', today: false }, { name: 'c', today: false }], memo);
    expect(first.map((x) => `${x.item.name}:${x.group}`)).toEqual(['a:today', 'b:earlier', 'c:earlier']);
    // A sync later: c got activity and would sort first and move to today. It stays put.
    const later = order([{ name: 'c', today: true }, { name: 'a', today: true }, { name: 'b', today: false }], memo);
    expect(later.map((x) => `${x.item.name}:${x.group}`)).toEqual(['a:today', 'b:earlier', 'c:earlier']);
    // The row object is the fresh one: accessories still update.
    expect(later[2].item.today).toBe(true);
  });

  it('appends new rows and drops rows that went away', () => {
    const memo = newFrozenOrder();
    order([{ name: 'a', today: true }, { name: 'b', today: false }], memo);
    const next = order([{ name: 'new', today: true }, { name: 'b', today: false }], memo);
    expect(next.map((x) => x.item.name)).toEqual(['b', 'new']);
    expect(next[1].group).toBe('today');
  });

  it('re-sorts when the tab, sort or filter changes', () => {
    const memo = newFrozenOrder();
    order([{ name: 'a', today: false }, { name: 'b', today: false }], memo, 'all|recent');
    const resorted = order([{ name: 'b', today: true }, { name: 'a', today: false }], memo, 'all|name');
    expect(resorted.map((x) => `${x.item.name}:${x.group}`)).toEqual(['b:today', 'a:earlier']);
  });
});
