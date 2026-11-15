import { afterEach, describe, expect, it } from 'vitest';
import * as P from './platform';

afterEach(() => P.__setPlatformForTests(null));

describe('platform detection', () => {
  it('can be overridden for tests', () => {
    P.__setPlatformForTests('windows');
    expect(P.isWindows).toBe(true);
    expect(P.isMac).toBe(false);
    expect(P.modKey()).toBe('Ctrl+');
    P.__setPlatformForTests('mac');
    expect(P.isMac).toBe(true);
    expect(P.isWindows).toBe(false);
    expect(P.modKey()).toBe('⌘');
  });
});

describe('home directories', () => {
  it('recognises all four forms', () => {
    expect(P.homeOf('/Users/x/p')).toBe('/Users/x');
    expect(P.homeOf('/home/x/p')).toBe('/home/x');
    expect(P.homeOf('C:/Users/x/p')).toBe('C:/Users/x');
    expect(P.homeOf('c:\\Users\\x\\p')).toBe('c:/Users/x');
    expect(P.homeOf('/opt/x')).toBe('');
    expect(P.homeOf('D:/work/x')).toBe('');
  });

  it('shortPath maps home to ~', () => {
    expect(P.shortPath('/Users/x/p')).toBe('~/p');
    expect(P.shortPath('/home/x/p')).toBe('~/p');
    expect(P.shortPath('C:/Users/x/p')).toBe('~/p');
    expect(P.shortPath('c:\\Users\\x\\p')).toBe('~/p');
    expect(P.shortPath('/Users/x')).toBe('~');
    expect(P.shortPath('/opt/x')).toBe('/opt/x');
  });

  it('shortPath keeps the iCloud and Obsidian mapping', () => {
    expect(P.shortPath('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/TUTOR')).toBe('~/iCloud/TUTOR');
    expect(P.shortPath('/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault')).toBe('~/Obsidian/Vault');
  });

  it('isHome', () => {
    expect(P.isHome('/Users/x')).toBe(true);
    expect(P.isHome('/Users/x/')).toBe(true);
    expect(P.isHome('C:\\Users\\x')).toBe(true);
    expect(P.isHome('/Users/x/p')).toBe(false);
    expect(P.isHome('')).toBe(false);
  });
});

describe('path pieces', () => {
  it('toSlash', () => {
    expect(P.toSlash('c:\\Users\\x\\p')).toBe('c:/Users/x/p');
  });

  it('dirname and basename split on either slash', () => {
    expect(P.dirname('/Users/x/p')).toBe('/Users/x');
    expect(P.dirname('C:/Users/x/p')).toBe('C:/Users/x');
    expect(P.dirname('c:\\Users\\x\\p')).toBe('c:/Users/x');
    expect(P.dirname('C:/p')).toBe('C:/');
    expect(P.dirname('/p')).toBe('/');
    expect(P.dirname('p')).toBe('');
    expect(P.basename('/Users/x/p')).toBe('p');
    expect(P.basename('/Users/x/p/')).toBe('p');
    expect(P.basename('c:\\Users\\x\\p')).toBe('p');
    expect(P.basename('C:/Users/x/p')).toBe('p');
  });

  it('isUnder on POSIX paths is case-sensitive and component-wise', () => {
    P.__setPlatformForTests('mac');
    expect(P.isUnder('/Users/x/p/a', '/Users/x/p')).toBe(true);
    expect(P.isUnder('/Users/x/p', '/Users/x/p/')).toBe(true);
    expect(P.isUnder('/Users/x/p2', '/Users/x/p')).toBe(false);
    expect(P.isUnder('/Users/x/P/a', '/Users/x/p')).toBe(false);
  });

  it('isUnder on Windows paths ignores case and slash style', () => {
    expect(P.isUnder('C:/Users/x/Proj/a', 'c:\\users\\x\\proj')).toBe(true);
    expect(P.isUnder('c:\\Users\\x\\p', 'C:/Users/x/p')).toBe(true);
    expect(P.isUnder('C:/Users/x/p2', 'C:/Users/x/p')).toBe(false);
    expect(P.isUnder('D:/x', 'C:/x')).toBe(false);
    expect(P.isUnder('', 'C:/x')).toBe(false);
  });
});
