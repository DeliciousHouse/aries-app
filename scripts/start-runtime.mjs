import { spawn } from 'node:child_process';

const defaultPort = 3000;
const rawPort = process.env.PORT?.trim();
const parsedPort = rawPort ? Number(rawPort) : defaultPort;
const isValidPort = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535;

if (!isValidPort) {
  console.error(`Invalid PORT value "${rawPort}". Expected integer 1-65535.`);
  process.exit(1);
}

const child = spawn('next', ['start', '-p', String(parsedPort)], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`Failed to start Next.js runtime: ${String(error?.message || error)}`);
  process.exit(1);
});
