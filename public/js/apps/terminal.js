'use strict';
/* Terminal (bash) over WebSocket using xterm.js. */
(function (WD) {
  const { h } = WD;

  function launch(opts = {}) {
    const wrap = h('div', { class: 'term-wrap' });
    const status = h('div', { class: 'term-status', hidden: true });
    let ws = null;
    let closed = false;

    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Ubuntu Mono", Menlo, Consolas, monospace',
      fontSize: WD.settings.get('term.fontSize', 14),
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: '#264f78',
        black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
        brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
      }
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);

    const win = WD.wm.open({
      app: 'terminal',
      title: 'Terminal',
      icon: WD.appIcon('terminal'),
      width: 820,
      height: 500,
      onResize: () => doFit(),
      onFocus: () => term.focus(),
      onClose: () => { closed = true; if (ws) ws.close(); term.dispose(); }
    });
    win.body.append(wrap, status);
    term.open(wrap);

    // Ctrl+C copies when text is selected, Ctrl+V pastes (like Windows Terminal).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        if (navigator.clipboard) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.key === 'v') return false; // let the browser fire a paste event
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'V')) return false;
      return true;
    });
    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      WD.contextMenu(e.clientX, e.clientY, [
        { label: 'Kopiuj', icon: 'copy', key: 'Ctrl+C', disabled: !term.hasSelection(), action: () => navigator.clipboard && navigator.clipboard.writeText(term.getSelection()) },
        { label: 'Wklej', icon: 'paste', key: 'Ctrl+V', action: async () => {
          try { send({ t: 'i', d: await navigator.clipboard.readText() }); } catch { WD.toast('Użyj Ctrl+V, aby wkleić', 'error'); }
        } },
        '-',
        { label: 'Większa czcionka', icon: 'zoomin', action: () => setFont(term.options.fontSize + 1) },
        { label: 'Mniejsza czcionka', icon: 'zoomout', action: () => setFont(term.options.fontSize - 1) },
        { label: 'Wyczyść', icon: 'trash', action: () => term.clear() },
        '-',
        { label: 'Nowy terminal', icon: 'terminal', action: () => launch({}) }
      ]);
    });

    function setFont(size) {
      size = Math.max(9, Math.min(28, size));
      term.options.fontSize = size;
      WD.settings.set('term.fontSize', size);
      doFit();
    }

    function doFit() {
      if (closed || !wrap.offsetWidth || !wrap.offsetHeight) return;
      try { fit.fit(); } catch { return; }
      send({ t: 'r', c: term.cols, r: term.rows });
    }

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function connect() {
      status.hidden = true;
      requestAnimationFrame(() => { try { fit.fit(); } catch { /* not visible yet */ } });
      const q = new URLSearchParams({ cols: term.cols, rows: term.rows });
      if (opts.cwd) q.set('cwd', opts.cwd);
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal?${q}`);
      ws.onopen = () => { doFit(); term.focus(); };
      ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      ws.onclose = (e) => {
        if (closed) return;
        term.write('\r\n\x1b[90m[Sesja zakończona' + (e.reason ? ': ' + e.reason : '') + '. Naciśnij Enter, aby uruchomić ponownie]\x1b[0m\r\n');
        ws = null;
      };
    }

    term.onData((d) => {
      if (!ws) {
        if (d === '\r') { term.reset(); connect(); }
        return;
      }
      send({ t: 'i', d });
    });
    term.onTitleChange((t) => win.setTitle(t ? `${t} — Terminal` : 'Terminal'));

    setTimeout(connect, 30);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.terminal = { name: 'Terminal', icon: 'terminal', launch };
})(window.WD);
