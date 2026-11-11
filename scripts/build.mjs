import { build } from 'esbuild';
await build({ entryPoints: ['src/plugin.tsx'], bundle: true, format: 'esm', target: 'es2022',
  outfile: 'desktop/plugin.js', external: ['react', 'react/*', '@hermes/plugin-sdk'],
  legalComments: 'none', charset: 'utf8', loader: { '.css': 'text' } });
