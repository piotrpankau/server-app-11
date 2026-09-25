#!/usr/bin/env node
'use strict';
// Creates or updates config.json. Values can come from environment variables
// (used by install.sh) or are asked for interactively.
//   WP_USERNAME, WP_PASSWORD, WP_PORT, WP_HOST, WP_CERT, WP_KEY, WP_ROOT
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const auth = require('../lib/auth');
const { CONFIG_PATH } = require('../lib/config');

function ask(question, { hidden = false, def = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (s === '\r\n' || s === '\n') rl.output.write(s);
        else rl.output.write('*');
      };
    }
    rl.question(`${question}${def ? ` [${def}]` : ''}: `, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim() || def);
    });
  });
}

(async () => {
  const existing = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const env = process.env;

  const username = env.WP_USERNAME || await ask('Login do panelu', { def: existing.username || 'admin' });

  let password = env.WP_PASSWORD;
  while (!password) {
    const p1 = await ask('Hasło (min. 8 znaków)', { hidden: true });
    if (p1.length < 8) { console.log('Hasło za krótkie.'); continue; }
    const p2 = await ask('Powtórz hasło', { hidden: true });
    if (p1 !== p2) { console.log('Hasła się różnią.'); continue; }
    password = p1;
  }
  if (password.length < 8) {
    console.error('Hasło musi mieć co najmniej 8 znaków.');
    process.exit(1);
  }

  const port = Number(env.WP_PORT || existing.port || 8443);
  const cfg = Object.assign({}, existing, {
    host: env.WP_HOST || existing.host || '0.0.0.0',
    port,
    username,
    passwordHash: auth.hashPassword(password),
    sessionSecret: existing.sessionSecret || crypto.randomBytes(32).toString('hex'),
    sessionHours: existing.sessionHours || 12,
    rootDir: env.WP_ROOT || existing.rootDir || '/'
  });
  if (env.WP_CERT && env.WP_KEY) cfg.https = { cert: env.WP_CERT, key: env.WP_KEY };
  else if (env.WP_HTTPS === '0') cfg.https = null;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log(`Zapisano konfigurację: ${CONFIG_PATH}`);
})();
