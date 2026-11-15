import { spawnSync } from 'node:child_process';

const { npm_execpath: packageManager, npm_config_user_agent: userAgent, WORKERS_CI } = process.env;
const script = WORKERS_CI === '1' ? 'deploy:cloudflare' : 'deploy:local';
const args = process.argv.slice(2);
const separator = args.length && userAgent?.startsWith('npm/') ? ['--'] : [];

const result = spawnSync(process.execPath, [packageManager, 'run', script, ...separator, ...args], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
