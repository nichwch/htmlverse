import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const output = mkdtempSync(join(tmpdir(), 'canvaschat-tests-'));
try {
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), 'tests/references.test.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--esModuleInterop', '--skipLibCheck'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['--test', join(output, 'tests/references.test.js')], { stdio: 'inherit' });
} finally {
  rmSync(output, { recursive: true, force: true });
}
