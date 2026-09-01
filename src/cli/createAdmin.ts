/**
 * One-shot superadmin bootstrap.
 *
 *   Interactive (TTY, e.g. DO App Platform console):
 *     node dist/cli/createAdmin.js
 *
 *   Non-interactive (CI / one-off job):
 *     ADMIN_BOOTSTRAP_EMAIL=you@example.com \
 *     ADMIN_BOOTSTRAP_PASSWORD='…' node dist/cli/createAdmin.js
 *
 * Refuses if a superadmin already exists. Invite further admins from the UI.
 */
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { bootstrapSuperadmin } from '../routes/adminAuth.js';
import { passwordSchema } from '../admin/passwords.js';
import { z } from 'zod';

async function prompt(label: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden && process.stdin.isTTY) {
    process.stdout.write(label);
    process.stdin.setRawMode?.(true);
    let buf = '';
    return new Promise<string>((resolve) => {
      process.stdin.on('data', function onData(chunk) {
        const s = chunk.toString('utf8');
        for (const ch of s) {
          if (ch === '\r' || ch === '\n') {
            process.stdin.setRawMode?.(false);
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            rl.close();
            resolve(buf);
            return;
          }
          if (ch === '') {
            // Ctrl-C
            process.exit(130);
          }
          if (ch === '' || ch === '\b') {
            buf = buf.slice(0, -1);
            continue;
          }
          buf += ch;
        }
      });
    });
  }
  const answer = await rl.question(label);
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  console.error('Phobs Automated Offers — create initial superadmin');

  const envEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim();
  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  let email: string;
  let password: string;
  if (envEmail && envPassword) {
    email = z.string().email().toLowerCase().parse(envEmail);
    password = passwordSchema.parse(envPassword);
  } else {
    if (!process.stdin.isTTY) {
      console.error(
        'No TTY. Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD for non-interactive use.',
      );
      process.exit(2);
    }
    email = z.string().email().toLowerCase().parse((await prompt('Email: ')).trim());
    password = passwordSchema.parse(await prompt('Password (hidden): ', true));
    const password2 = await prompt('Confirm password: ', true);
    // Two user-entered strings in the same interactive session; timing-attack
    // surface does not apply.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (password !== password2) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }

  const created = await bootstrapSuperadmin(email, password);
  console.error(`OK. Superadmin created: id=${created.id.toString()} email=${created.email}`);
  console.error('Sign in at /admin/login, then enrol TOTP under Settings before inviting others.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Failed to create admin:', err instanceof Error ? err.message : err);
  process.exit(1);
});
