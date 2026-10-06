import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(root, 'extensions/vscode');
const runtime = resolve(extension, 'runtime');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${command}`);
}

export async function buildExtension({ packageVsix = false, skipFrontend = false } = {}) {
  if (!skipFrontend) {
    run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--base', './']);
  }
  if (!existsSync(resolve(root, 'dist/index.html'))) throw new Error('Missing frontend: run npm run build first.');
  // Delete only this script's generated runtime, after verifying its exact path.
  if (runtime !== resolve(root, 'extensions', 'vscode', 'runtime') || !runtime.startsWith(`${extension}${sep}`)) {
    throw new Error('Invalid generated runtime path.');
  }
  await rm(runtime, { recursive: true, force: true });
  await mkdir(resolve(runtime, 'tensorv'), { recursive: true });
  await cp(resolve(root, 'dist'), resolve(runtime, 'dist'), { recursive: true });
  // Explicit allowlist avoids copying environments, cached data, or credentials.
  for (const file of ['__init__.py', 'bridge.py', 'server.py', 'engine.py', 'diagnostics.py']) {
    await cp(resolve(root, 'tensorv', file), resolve(runtime, 'tensorv', file));
  }
  console.log(`TensorV extension runtime built: ${runtime}`);
  if (packageVsix) {
    const vsce = resolve(extension, 'node_modules/@vscode/vsce/vsce');
    if (!existsSync(vsce)) throw new Error('Install packaging dependencies first: npm install --prefix extensions/vscode');
    const manifest = JSON.parse(await readFile(resolve(extension, 'package.json'), 'utf8'));
    const output = resolve(extension, `tensorv-${manifest.version}.vsix`);
    run(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', output], extension);
    console.log(`Install VSIX in VS Code: ${output}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExtension({ packageVsix: process.argv.includes('--package'), skipFrontend: process.argv.includes('--skip-frontend') });
}
