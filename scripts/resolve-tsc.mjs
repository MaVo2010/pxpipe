import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

// TS 7 no longer exports './bin/tsc', so resolve it via the bin field of the
// (still-exported) package.json instead of a direct subpath require. Join it as
// a filesystem path: a `file://${path}` URL's pathname is `/C:/...` on Windows,
// which Node then reads as `C:\C:\...`.
export function resolveTscBin() {
  const pkgPath = require.resolve('typescript/package.json');
  return resolve(dirname(pkgPath), require(pkgPath).bin.tsc);
}
