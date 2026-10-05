import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function pythonCandidates() {
  if (process.env.TENSORV_PYTHON) return [[process.env.TENSORV_PYTHON, []]];
  const venv = resolve(projectRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  if (existsSync(venv)) return [[venv, []]];
  return process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
}

export function runPython(args, options = {}) {
  let result;
  for (const [command, prefix] of pythonCandidates()) {
    result = spawnSync(command, [...prefix, ...args], { cwd: projectRoot, ...options });
    if (result.error?.code !== 'ENOENT') return result;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runPython(['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Unable to start Python: ${result.error.message}. Run the project startup script or set TENSORV_PYTHON.`);
  }
  process.exit(result.status ?? 1);
}
