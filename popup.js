'use strict';

const primary = document.getElementById('primary');
const secondary = document.getElementById('secondary');
const apply = document.getElementById('apply');
const disable = document.getElementById('disable');
const refresh = document.getElementById('refresh');
const status = document.getElementById('status');
const controls = document.getElementById('controls');
const notNetflix = document.getElementById('notNetflix');

let activeTabId = null;
let tracks = [];

function languageLabel(track) {
  const suffix = track.language && track.name !== track.language ? ` (${track.language})` : '';
  const forced = track.isForced ? ' — forced' : '';
  return `${track.name}${suffix}${forced}`;
}

function setStatus(message, kind = '') {
  status.textContent = message || '';
  status.className = `status ${kind}`.trim();
}

function fillSelect(select, selectedLanguage, fallbackIndex) {
  select.textContent = '';
  tracks.forEach((track) => {
    const option = document.createElement('option');
    option.value = track.id;
    option.textContent = languageLabel(track);
    option.dataset.language = track.language || track.name;
    select.appendChild(option);
  });

  const wanted = String(selectedLanguage || '').toLowerCase();
  const match = tracks.find((track) => String(track.language || track.name).toLowerCase() === wanted);
  if (match) select.value = match.id;
  else if (tracks[fallbackIndex]) select.value = tracks[fallbackIndex].id;
}

async function send(kind, payload = {}) {
  if (!activeTabId) return null;
  try {
    return await chrome.tabs.sendMessage(activeTabId, { kind, ...payload });
  } catch (_) {
    return null;
  }
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;

  if (!tab?.url?.startsWith('https://www.netflix.com/')) {
    controls.classList.add('hidden');
    notNetflix.classList.remove('hidden');
    return;
  }

  const state = await send('GET_STATE');
  if (!state) {
    controls.classList.add('hidden');
    notNetflix.classList.remove('hidden');
    notNetflix.textContent = 'Reload the Netflix tab once after installing the extension, start playback, then open this popup again.';
    return;
  }

  document.getElementById('overlayEnabled').checked = state.overlayEnabled !== false;
  tracks = Array.isArray(state.tracks) ? state.tracks : [];
  if (!tracks.length) {
    apply.disabled = true;
    setStatus('No subtitle tracks yet. Start playback, wait a moment, then press Refresh.');
    return;
  }

  apply.disabled = tracks.length < 2;
  fillSelect(primary, state.primaryLanguage, 0);
  fillSelect(secondary, state.secondaryLanguage, Math.min(1, tracks.length - 1));

  if (!state.secondaryLanguage && tracks.length > 1 && primary.value === secondary.value) {
    secondary.value = tracks[1].id;
  }

  setStatus(state.message || `${tracks.length} subtitle tracks available.`, state.status === 'ready' ? 'ready' : state.status === 'error' ? 'error' : '');
}

apply.addEventListener('click', async () => {
  if (primary.value === secondary.value) {
    setStatus('Choose two different subtitle languages.', 'error');
    return;
  }
  setStatus('Loading second subtitle track…');
  const result = await send('APPLY', { primaryId: primary.value, secondaryId: secondary.value });
  if (!result?.ok) {
    setStatus(result?.error || 'Could not apply subtitle tracks.', 'error');
    return;
  }
  setTimeout(load, 700);
});

disable.addEventListener('click', async () => {
  await send('DISABLE');
  setStatus('Dual subtitles disabled.');
});

refresh.addEventListener('click', async () => {
  setStatus('Refreshing available languages…');
  await send('REFRESH_TRACKS');
  setTimeout(load, 500);
});

void load();

// Open a normal, movable Chrome popup window alongside the Netflix window.
document.getElementById('transcript').addEventListener('click', async () => {
  if (!activeTabId) return;
  try {
    const width = Math.min(620, screen.availWidth);
    await chrome.windows.create({
      url: chrome.runtime.getURL(`transcript.html?tab=${activeTabId}`),
      type: 'popup', width, height: Math.min(850, screen.availHeight),
      left: Math.round(screen.availLeft + screen.availWidth - width),
      top: Math.round(screen.availTop), focused: true
    });
  } catch (_) { setStatus('Could not open the transcript window.', 'error'); }
});
document.getElementById('overlayEnabled').addEventListener('change', async event => {
  await send('SET_OVERLAY', { enabled: event.target.checked });
});
