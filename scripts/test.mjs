import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
await build({ entryPoints: ['tests/frontend.test.tsx'], outfile: '.test-build/frontend.test.mjs', platform: 'node', format: 'esm', bundle: true,
  packages: 'external', loader: { '.css': 'text' }, alias: { '@hermes/plugin-sdk': resolve('tests/sdk-fixture.tsx') } });
const result = spawnSync(process.execPath, ['--test', '.test-build/frontend.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
