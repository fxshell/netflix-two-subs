(() => {
  'use strict';
  const tabId = Number(new URL(location.href).searchParams.get('tab'));
  const container = document.getElementById('rows');
  const status = document.getElementById('status');
  const search = document.getElementById('search');
  const follow = document.getElementById('follow');
  let revision = -1, rows = [], nodes = [], activeKeys = '', busy = false;
  async function send(kind, payload = {}) {
    return chrome.tabs.sendMessage(tabId, { kind, ...payload });
  }
  function filter() {
    const q = search.value.trim().toLocaleLowerCase();
    nodes.forEach((node, i) => { node.hidden = Boolean(q && !(`${rows[i].primary}\n${rows[i].secondary}`).toLocaleLowerCase().includes(q)); });
    activeKeys = '';
  }
  function render(data) {
    rows = N2STranscript.align(data.primaryCues || [], data.secondaryCues || []);
    container.replaceChildren();
    nodes = rows.map(row => {
      const node = document.createElement('div'); node.className = 'row';
      const time = document.createElement('button'); time.className = 'time';
      time.textContent = N2STranscript.timestamp(row.start); time.title = 'Jump to this subtitle';
      time.addEventListener('click', () => void send('SEEK', { time: row.start }).catch(() => { status.textContent = 'Netflix is disconnected. Reload Netflix and reopen this window.'; }));
      const first = document.createElement('div'); first.className = 'line'; first.textContent = row.primary;
      const second = document.createElement('div'); second.className = 'line translation'; second.textContent = row.secondary;
      if (data.primaryLanguage) first.lang = data.primaryLanguage;
      if (data.secondaryLanguage) second.lang = data.secondaryLanguage;
      node.append(time, first, second); container.append(node); return node;
    });
    if (!nodes.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = 'Choose two languages in the 2S popup and click Apply. Text appears as each subtitle track loads.';
      container.append(empty);
    }
    document.getElementById('primaryLabel').textContent = data.primaryName || 'Primary';
    document.getElementById('secondaryLabel').textContent = data.secondaryName || 'Secondary';
    filter(); activeKeys = '';
  }
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const data = await send('GET_TRANSCRIPT', { revision });
      if (!data) throw new Error('disconnected');
      if (data.revision !== revision) { render(data); revision = data.revision; }
      const loaded = data.primaryLoaded && data.secondaryLoaded;
      status.textContent = loaded ? `${rows.length} lines loaded · Paired by timing; translations may split lines differently.` : data.message;
      document.getElementById('play').textContent = data.paused ? 'Play' : 'Pause';
      const active = [];
      rows.forEach((row, i) => { if (data.time >= row.start && data.time < row.end) active.push(i); });
      const key = active.join(',');
      if (key !== activeKeys) {
        nodes.forEach((node, i) => node.classList.toggle('active', active.includes(i)));
        if (follow.checked) {
          const current = active.find(i => !nodes[i].hidden);
          if (current !== undefined) nodes[current].scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        activeKeys = key;
      }
    } catch (_) { status.textContent = 'Netflix is disconnected. Reload Netflix and reopen this window.'; }
    finally { busy = false; }
  }
  search.addEventListener('input', filter);
  follow.addEventListener('change', () => { activeKeys = '!'; void poll(); });
  document.getElementById('size').addEventListener('change', event => document.documentElement.style.setProperty('--text-size', `${event.target.value}px`));
  document.getElementById('play').addEventListener('click', () => void send('TOGGLE_PLAY').then(poll).catch(() => { status.textContent = 'Netflix is disconnected.'; }));
  void poll(); setInterval(poll, 500);
})();
