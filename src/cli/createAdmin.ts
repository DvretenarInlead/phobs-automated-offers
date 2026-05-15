import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { bootstrapSuperadmin } from '../routes/adminAuth.js';
import { passwordSchema } from '../admin/passwords.js';
import { z } from 'zod';

async function prompt(label: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) {
    // Best-effort: disable echo by writing a CSI escape and rely on TTY raw mode.
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
  } else {
    const answer = await rl.question(label);
    rl.close();
    return answer;
  }
}

async function main(): Promise<void> {
  console.error('Phobs Automated Offers — create initial superadmin');
  const email = z.string().email().toLowerCase().parse((await prompt('Email: ')).trim());
  const password = passwordSchema.parse(await prompt('Password (hidden): ', true));
  const password2 = await prompt('Confirm password: ', true);
  // Two user-entered strings in the same interactive session; timing-attack
  // surface does not apply.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (password !== password2) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  const created = await bootstrapSuperadmin(email, password);
  console.error(`OK. Superadmin created: id=${created.id.toString()} email=${created.email}`);
  console.error('Sign in via POST /api/admin/login. Configure TOTP from the admin UI when it ships.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Failed to create admin:', err instanceof Error ? err.message : err);
  process.exit(1);
});
