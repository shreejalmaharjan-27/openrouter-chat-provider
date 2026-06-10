const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  minify: production,
  sourcemap: !production,
  platform: 'browser',
  outfile: 'dist/webview.js',
  logLevel: 'info',
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
