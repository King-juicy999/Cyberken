import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Loads Cyberken configuration into `process.env`.
 *
 * Config lives in the repo-root `.env`. A bare `dotenv.config()` would resolve `.env`
 * against `process.cwd()`, which depends on the directory the script happens to be run
 * from — resolving against the repo root keeps every script (and CI) consistent.
 *
 * Precedence, highest first: shell/exported env, the repo-root `.env`.
 */
export function loadEnv(): void {
  const shellEnv = { ...process.env };

  const file = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: true });
  }

  // Anything the caller already exported outranks the file.
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}