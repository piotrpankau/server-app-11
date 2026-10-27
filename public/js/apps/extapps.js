'use strict';
/* Team web apps (DevHub) that the c1 server proxies under /app/<id>/ with the panel's login
   (contract wp-app-1, docs/APLIKACJE.md in webpulpit-c1). An app that speaks the contract opens
   inside a window; otherwise its own address opens in a new tab. Node has no /api/apps: nothing shows. */
(function (WD) {
  const { h, api } = WD;
  WD.extApps = [];

  async function load() {
    try {
      const list = await api.get('/api/apps');
      WD.extApps = Array.isArray(list) ? list : [];
    } catch (err) {
      WD.extApps = [];
    }
  }

  function launch(id) {
    const a = WD.extApps.find((x) => x.id === id);
    if (!a) return null;
    if (!a.embed) {
      if (a.url) window.open(a.url, '_blank', 'noopener');
      else WD.toast(`${a.name}: aplikacja nie odpowiada`, 'error');
      return null;
    }
    const existing = WD.wm.find((w) => w.app === 'app-' + id);
    if (existing) { existing.focus(); return existing; }
    const frame = h('iframe', { src: a.path, allow: 'clipboard-read; clipboard-write; fullscreen', style: { width: '100%', height: '100%', border: '0' } });
    const w = WD.wm.open({ app: 'app-' + id, title: a.name, icon: WD.appIcon('computer'), width: 1280, height: 800, maximized: true });
    w.body.style.padding = '0';
    w.body.append(frame);
    return w;
  }

  // desktop icons / start menu entries (the server already filtered them by role)
  const entries = () => WD.extApps.map((a) => ({ name: a.name, icon: 'computer', open: () => launch(a.id) }));

  WD.apps.extapps = { load, launch, entries };
})(window.WD);
