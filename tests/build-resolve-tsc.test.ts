/**
 * scripts/build.mjs located tsc through a `file://` URL's pathname, which is
 * `/C:/...` on Windows and made `pnpm run build` fail with
 * `Cannot find module 'C:\C:\...\typescript\bin\tsc'`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveTscBin } from '../scripts/resolve-tsc.mjs';

describe('build: resolveTscBin', () => {
  it('returns an absolute path to a tsc entry that exists', () => {
    const bin: string = resolveTscBin();
    expect(isAbsolute(bin)).toBe(true);
    expect(existsSync(bin)).toBe(true);
  });
});
