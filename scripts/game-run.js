#!/usr/bin/env node
'use strict';
// Called by the per-game systemd unit to start/stop a server on boot/shutdown.
//   node scripts/game-run.js start|stop <serverId>
const config = require('../lib/config');
const games = require('../lib/games');

(async () => {
  const [, , action, id] = process.argv;
  if (!action || !id) { console.error('użycie: game-run.js start|stop <id>'); process.exit(2); }
  try {
    games.load(config.load());
    if (action === 'start') await games.start(id);
    else if (action === 'stop') await games.stop(id);
    else { console.error('nieznana akcja'); process.exit(2); }
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
