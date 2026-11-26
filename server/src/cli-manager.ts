import { execFile } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { CliStatus, Connector } from '../../shared/catalog.js';

const run = promisify(execFile);
const versionFlags = new Set(['--version', '-V', '-v', 'version']);

export async function cliStatus(cli: Extract<Connector, { kind: 'cli' }>['cli']): Promise<CliStatus> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.+@/-]*$/.test(cli.binary) || basename(cli.binary) !== cli.binary) {
    return { installed: false, version: null };
  }
  const options = { timeout: 1_500, maxBuffer: 8_192, env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot } };
  let executable: string;
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where.exe' : 'which', [cli.binary], options);
    executable = stdout.trim().split(/\r?\n/, 1)[0];
    if (!isAbsolute(executable)) return { installed: false, version: null };
  } catch { return { installed: false, version: null }; }
  const requested = typeof cli.versionCommand === 'string' ? cli.versionCommand.trim().split(/\s+/) : cli.versionCommand;
  if (requested?.length === 2 && requested[0] === cli.binary && versionFlags.has(requested[1])) {
    try {
      const result = await run(executable, [requested[1]], options);
      // Only expose a conventional version number, never arbitrary stdout/stderr.
      return { installed: true, version: `${result.stdout}\n${result.stderr}`.match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0] ?? null };
    } catch { /* Detection succeeded even if the version probe failed. */ }
  }
  return { installed: true, version: null };
}
