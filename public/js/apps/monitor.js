'use strict';
/* System monitor ("Menedżer zadań"): CPU, memory, disks, network, processes. */
(function (WD) {
  const { h, api, fmt } = WD;

  function launch() {
    const existing = WD.wm.find((w) => w.app === 'monitor');
    if (existing) return existing.focus();

    const root = h('div', { class: 'monitor' });
    const cards = h('div', { class: 'mon-cards' });
    const filter = h('input', { class: 'field', type: 'search', placeholder: 'Filtruj procesy' });
    const procBody = h('tbody');
    root.append(
      cards,
      h('div', { class: 'mon-section' }, 'Procesy', filter),
      h('table', { class: 'proc-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'PID'), h('th', {}, 'Użytkownik'), h('th', {}, 'CPU %'), h('th', {}, 'RAM'), h('th', { class: 'hide-sm' }, 'Czas'), h('th', {}, 'Polecenie'), h('th'))),
        procBody)
    );

    const cpuHist = [];
    let timer = null;
    let procs = [];
    let tick = 0;

    const win = WD.wm.open({
      app: 'monitor',
      title: 'Monitor systemu',
      icon: WD.appIcon('monitor'),
      width: 860,
      height: 620,
      onClose: () => clearInterval(timer)
    });
    win.body.append(root);

    filter.addEventListener('input', renderProcs);

    function bar(pct) {
      const cls = pct > 90 ? 'bad' : pct > 75 ? 'warn' : '';
      return h('div', { class: 'progress' }, h('i', { class: cls, style: { width: Math.min(100, pct).toFixed(1) + '%' } }));
    }

    function spark(values) {
      const w = 200, hh = 40;
      const pts = values.map((v, i) => `${(i / 59) * w},${hh - (v / 100) * hh}`).join(' ');
      const svg = `<svg class="spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
      return h('div', { html: svg });
    }

    function card(title, big, sub, extra) {
      return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'big' }, big), sub ? h('div', { class: 'sub' }, sub) : null, extra);
    }

    async function refresh() {
      try {
        const s = await api.get('/api/system');
        cpuHist.push(s.cpu.percent);
        if (cpuHist.length > 60) cpuHist.shift();
        const m = s.memory;
        const memPct = (m.used / m.total) * 100;
        const list = [
          card('Procesor', s.cpu.percent.toFixed(0) + '%', `${s.cpu.cores} rdz. · obciążenie ${s.load.map((l) => l.toFixed(2)).join(' / ')}`, h('div', {}, bar(s.cpu.percent), spark(cpuHist))),
          card('Pamięć RAM', memPct.toFixed(0) + '%', `${fmt.size(m.used)} z ${fmt.size(m.total)}` + (m.swapTotal ? ` · swap ${fmt.size(m.swapUsed)} / ${fmt.size(m.swapTotal)}` : ''), bar(memPct)),
          ...s.disks.map((d) => {
            const pct = (d.used / d.total) * 100;
            return card('Dysk ' + d.mount, pct.toFixed(0) + '%', `${fmt.size(d.used)} z ${fmt.size(d.total)} · wolne ${fmt.size(d.total - d.used)}`, bar(pct));
          }),
          ...s.net.filter((n) => n.rx || n.tx).slice(0, 3).map((n) =>
            card('Sieć ' + n.iface, `↓ ${fmt.size(n.rxRate)}/s`, `↑ ${fmt.size(n.txRate)}/s · łącznie ↓ ${fmt.size(n.rx)} ↑ ${fmt.size(n.tx)}`)),
          card('System', s.hostname, `${s.os} · jądro ${s.kernel} · działa ${fmt.duration(s.uptime)}`)
        ];
        cards.replaceChildren(...list);
        if (tick++ % 2 === 0) {
          procs = await api.get('/api/processes');
          renderProcs();
        }
      } catch (err) {
        cards.replaceChildren(h('div', { class: 'card' }, 'Błąd: ' + err.message));
      }
    }

    function renderProcs() {
      const q = filter.value.toLowerCase();
      const rows = procs.filter((p) => !q || p.command.toLowerCase().includes(q) || String(p.pid).includes(q) || p.user.toLowerCase().includes(q));
      procBody.replaceChildren(...rows.map((p) => h('tr', {},
        h('td', {}, p.pid),
        h('td', {}, p.user),
        h('td', {}, p.cpu.toFixed(1)),
        h('td', {}, fmt.size(p.rss)),
        h('td', { class: 'hide-sm' }, p.time),
        h('td', { class: 'cmd', title: p.command }, p.command),
        h('td', {}, h('button', { title: 'Zakończ proces', onclick: (e) => kill(p, e.shiftKey) }, 'Zakończ'))
      )));
    }

    async function kill(p, force) {
      const ok = await WD.confirm('Zakończ proces', `Zakończyć proces „${p.command}” (PID ${p.pid})?`, { okLabel: 'Zakończ', danger: true });
      if (!ok) return;
      try {
        await api.post('/api/kill', { pid: p.pid, signal: force ? 'SIGKILL' : 'SIGTERM' });
        WD.toast(`Wysłano sygnał do PID ${p.pid}`, 'ok');
        setTimeout(async () => { procs = await api.get('/api/processes'); renderProcs(); }, 600);
      } catch (err) { WD.error(err); }
    }

    refresh();
    timer = setInterval(refresh, 2000);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.monitor = { name: 'Monitor systemu', icon: 'monitor', launch };
})(window.WD);
