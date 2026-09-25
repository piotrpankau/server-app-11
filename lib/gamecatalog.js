'use strict';
/* A curated catalog of popular dedicated game servers with Linux support, so that
   searching by name gives ready install data: the Steam AppID of the *server tool*
   (not the game), a starting start-command, and the default ports. Users can still
   tweak everything afterwards. Entries with `template` reuse a full built-in template
   (nicer settings form); the rest create a "steam_custom" server pre-filled from here.
   Start commands are sensible starting points - a game may need small adjustments. */

const CATALOG = [
  { key: 'valheim', name: 'Valheim', template: 'valheim', appId: '896660', gameAppId: '892970', ports: ['2456/udp', '2457/udp'] },
  { key: 'cs2', name: 'Counter-Strike 2', template: 'cs2', appId: '730', gameAppId: '730', ports: ['27015/udp', '27015/tcp'] },
  { key: 'minecraft', name: 'Minecraft (Java)', template: 'minecraft', ports: ['25565/tcp'] },
  { key: 'rust', name: 'Rust', appId: '258550', gameAppId: '252490', ports: ['28015/udp', '28016/tcp'],
    startCmd: './RustDedicated -batchmode -nographics +server.port 28015 +rcon.port 28016 +server.maxplayers 50' },
  { key: 'ark', name: 'ARK: Survival Evolved', appId: '376030', gameAppId: '346110', ports: ['7777/udp', '7778/udp', '27015/udp'],
    startCmd: './ShooterGame/Binaries/Linux/ShooterGameServer TheIsland?listen?SessionName=Serwer -server -log' },
  { key: 'seven_days', name: '7 Days to Die', appId: '294420', gameAppId: '251570', ports: ['26900/tcp', '26900/udp', '26901/udp', '26902/udp'],
    startCmd: './startserver.sh -configfile=serverconfig.xml' },
  { key: 'pz', name: 'Project Zomboid', appId: '380870', gameAppId: '108600', ports: ['16261/udp', '16262/udp'],
    startCmd: './start-server.sh' },
  { key: 'palworld', name: 'Palworld', appId: '2394010', gameAppId: '1623730', ports: ['8211/udp'],
    startCmd: './PalServer.sh -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS' },
  { key: 'satisfactory', name: 'Satisfactory', appId: '1690800', gameAppId: '526870', ports: ['7777/udp', '7777/tcp'],
    startCmd: './FactoryServer.sh -unattended' },
  { key: 'l4d2', name: 'Left 4 Dead 2', appId: '222860', gameAppId: '550', ports: ['27015/udp', '27015/tcp'],
    startCmd: './srcds_run -game left4dead2 -port 27015 +map c1m1_hotel' },
  { key: 'tf2', name: 'Team Fortress 2', appId: '232250', gameAppId: '440', ports: ['27015/udp', '27015/tcp'],
    startCmd: './srcds_run -game tf -port 27015 +maxplayers 24 +map cp_dustbowl' },
  { key: 'gmod', name: "Garry's Mod", appId: '4020', gameAppId: '4000', ports: ['27015/udp', '27015/tcp'],
    startCmd: './srcds_run -game garrysmod -port 27015 +maxplayers 16 +map gm_flatgrass' },
  { key: 'css', name: 'Counter-Strike: Source', appId: '232330', gameAppId: '240', ports: ['27015/udp', '27015/tcp'],
    startCmd: './srcds_run -game cstrike -port 27015 +map de_dust2' },
  { key: 'insurgency', name: 'Insurgency', appId: '237410', gameAppId: '222880', ports: ['27015/udp', '27015/tcp'],
    startCmd: './srcds_run -game insurgency -port 27015 +map ministry' },
  { key: 'unturned', name: 'Unturned', appId: '1110390', gameAppId: '304930', ports: ['27015/udp', '27016/udp'],
    startCmd: './ServerHelper.sh +InternetServer/Serwer' },
  { key: 'dst', name: "Don't Starve Together", appId: '343050', gameAppId: '322330', ports: ['10999/udp'],
    startCmd: 'cd bin && ./dontstarve_dedicated_server_nullrenderer' },
  { key: 'vrising', name: 'V Rising', appId: '1829350', gameAppId: '1604030', ports: ['9876/udp', '9877/udp'],
    startCmd: './VRisingServer.sh -persistentDataPath ./save', notes: 'Serwer działa pod Linuksem przez Proton/Wine – może wymagać dodatkowej konfiguracji.' },
  { key: 'terraria', name: 'Terraria (tShock/serwer)', appId: '105600', gameAppId: '105600', ports: ['7777/tcp'],
    startCmd: './TerrariaServer -config serverconfig.txt', notes: 'Serwer Terrarii pobierany jest zwykle osobno – sprawdź komendę startową.' }
];

const byKey = (k) => CATALOG.find((g) => g.key === k);

function search(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return CATALOG.slice(0, 12);
  const norm = (s) => s.toLowerCase();
  return CATALOG
    .map((g) => ({ g, score: norm(g.name).startsWith(q) ? 3 : norm(g.name).includes(q) ? 2 : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.g);
}

// Live Steam store search (fills the game's AppID + image for anything not in the catalog).
async function steamSearch(q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=us&l=english`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || [])
      .filter((it) => it.platforms && it.platforms.linux)
      .slice(0, 12)
      .map((it) => ({ appId: String(it.id), name: it.name, image: it.tiny_image, linux: true }));
  } catch {
    return [];
  }
}

module.exports = { CATALOG, byKey, search, steamSearch };
