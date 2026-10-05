(() => {
  'use strict';

  const TO_PAGE = 'N2S_TO_PAGE';
  const FROM_PAGE = 'N2S_FROM_PAGE';
  const STORAGE_KEY = 'netflixTwoSubsSettings';

  const state = {
    tracks: [],
    activeId: '',
    enabled: false,
    primaryLanguage: '',
    secondaryLanguage: '',
    primaryId: '',
    secondaryId: '',
    cues: [],
    primaryCues: [],
    revision: 0,
    overlayEnabled: true,
    status: 'waiting',
    message: 'Open a Netflix title and start playback.'
  };

  let overlay = null;
  let textNode = null;
  let lastCueKey = '';
  let lastUrl = location.href;

  function toPage(kind, payload = {}) {
    window.postMessage({ channel: TO_PAGE, kind, ...payload }, '*');
  }

  function normalizeLanguage(lang) {
    return String(lang || '').toLowerCase().replace('_', '-');
  }

  function findTrackByLanguage(language) {
    const wanted = normalizeLanguage(language);
    if (!wanted) return null;
    return (
      state.tracks.find((track) => normalizeLanguage(track.language) === wanted) ||
      state.tracks.find((track) => normalizeLanguage(track.language).split('-')[0] === wanted.split('-')[0]) ||
      null
    );
  }

  function parseClockTime(value, tickRate = 10000000, frameRate = 30) {
    if (!value) return NaN;
    const text = String(value).trim();

    if (/^-?\d+(?:\.\d+)?ms$/i.test(text)) return parseFloat(text) / 1000;
    if (/^-?\d+(?:\.\d+)?s$/i.test(text)) return parseFloat(text);
    if (/^-?\d+(?:\.\d+)?t$/i.test(text)) return parseFloat(text) / tickRate;
    if (/^-?\d+(?:\.\d+)?f$/i.test(text)) return parseFloat(text) / frameRate;

    const match = text.match(/^(\d+):(\d{2}):(\d{2})(?:[\.,](\d+))?$/);
    if (match) {
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
      return hours * 3600 + minutes * 60 + seconds + fraction;
    }

    const frameMatch = text.match(/^(\d+):(\d{2}):(\d{2}):(\d{2})$/);
    if (frameMatch) {
      return (
        Number(frameMatch[1]) * 3600 +
        Number(frameMatch[2]) * 60 +
        Number(frameMatch[3]) +
        Number(frameMatch[4]) / frameRate
      );
    }

    const plain = Number(text);
    return Number.isFinite(plain) ? plain : NaN;
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseTtml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return [];

    const root = doc.documentElement;
    const tickRate = Number(
      root.getAttribute('ttp:tickRate') ||
      root.getAttribute('tickRate') ||
      root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate') ||
      10000000
    );
    const frameRate = Number(
      root.getAttribute('ttp:frameRate') ||
      root.getAttribute('frameRate') ||
      root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'frameRate') ||
      30
    );

    const nodes = [...doc.getElementsByTagName('p')];
    return nodes
      .map((node, index) => {
        const start = parseClockTime(node.getAttribute('begin'), tickRate, frameRate);
        let end = parseClockTime(node.getAttribute('end'), tickRate, frameRate);
        if (!Number.isFinite(end)) {
          const duration = parseClockTime(node.getAttribute('dur'), tickRate, frameRate);
          if (Number.isFinite(start) && Number.isFinite(duration)) end = start + duration;
        }

        const brs = [...node.querySelectorAll('br')];
        for (const br of brs) br.replaceWith('\n');

        const cueText = cleanText(node.textContent);
        if (!Number.isFinite(start) || !Number.isFinite(end) || !cueText) return null;
        return { start, end, text: cueText, key: `${index}:${start}:${end}` };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  function parseVttTimestamp(value) {
    const parts = String(value || '').trim().replace(',', '.').split(':');
    if (parts.length < 2 || parts.length > 3) return NaN;
    let seconds = 0;
    if (parts.length === 3) seconds += Number(parts.shift()) * 3600;
    seconds += Number(parts.shift()) * 60;
    seconds += Number(parts.shift());
    return seconds;
  }

  function stripVttMarkup(value) {
    const div = document.createElement('div');
    div.innerHTML = String(value || '')
      .replace(/<v(?:\.[^ >]+)?(?: [^>]*)?>/g, '')
      .replace(/<\/v>/g, '')
      .replace(/<c(?:\.[^ >]+)?>/g, '')
      .replace(/<\/c>/g, '')
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '');
    return cleanText(div.textContent);
  }

  function parseVtt(text) {
    const blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].match(/([^ ]+)\s+-->\s+([^ ]+)/);
      if (!timing) continue;
      const start = parseVttTimestamp(timing[1]);
      const end = parseVttTimestamp(timing[2]);
      const cueText = stripVttMarkup(lines.slice(timingIndex + 1).join('\n'));
      if (!Number.isFinite(start) || !Number.isFinite(end) || !cueText) continue;
      cues.push({ start, end, text: cueText, key: `${cues.length}:${start}:${end}` });
    }
    return cues;
  }

  function parseSubtitleText(text) {
    const head = String(text || '').trimStart().slice(0, 80).toUpperCase();
    if (head.startsWith('WEBVTT')) return parseVtt(text);
    return parseTtml(text);
  }

  function cueAt(time) {
    const cues = state.cues;
    let low = 0;
    let high = cues.length - 1;
    let result = null;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];
      if (time < cue.start) {
        high = mid - 1;
      } else if (time > cue.end) {
        low = mid + 1;
      } else {
        result = cue;
        break;
      }
    }
    return result;
  }

  function findOverlayHost() {
    const video = document.querySelector('video');
    const fullscreen = document.fullscreenElement;
    if (fullscreen) return fullscreen;
    return (
      video?.closest?.('[data-uia="video-canvas"]') ||
      video?.closest?.('.watch-video') ||
      video?.parentElement ||
      document.body
    );
  }

  function ensureOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'n2s-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      textNode = document.createElement('div');
      textNode.id = 'n2s-text';
      overlay.appendChild(textNode);
    }

    const host = findOverlayHost();
    if (host && overlay.parentElement !== host) host.appendChild(overlay);
    return overlay;
  }

  function positionOverlay() {
    const video = document.querySelector('video');
    const hostRect = overlay?.parentElement?.getBoundingClientRect();
    if (!video || !hostRect) return;
    let bottom = hostRect.height * 0.22;
    for (const native of document.querySelectorAll('.player-timedtext, .player-timedtext-text-container')) {
      const rect = native.getBoundingClientRect();
      if (rect.width && rect.height && rect.top >= hostRect.top && rect.bottom <= hostRect.bottom && getComputedStyle(native).visibility !== 'hidden') {
        bottom = Math.max(bottom, hostRect.bottom - rect.top + 18);
      }
    }
    overlay.style.setProperty('bottom', `${bottom}px`, 'important');
  }

  function clearCues() {
    state.cues = []; state.primaryCues = []; state.revision++;
  }

  function renderLoop() {
    const video = document.querySelector('video');
    const node = ensureOverlay();

    if (!state.enabled || !state.overlayEnabled || !video || !state.cues.length) {
      node.style.display = 'none';
      lastCueKey = '';
      requestAnimationFrame(renderLoop);
      return;
    }

    const cue = cueAt(video.currentTime);
    if (!cue) {
      node.style.display = 'none';
      lastCueKey = '';
    } else {
      positionOverlay();
      node.style.display = 'flex';
      if (cue.key !== lastCueKey) {
        lastCueKey = cue.key;
        textNode.textContent = cue.text;
      }
    }

    requestAnimationFrame(renderLoop);
  }

  async function loadSavedSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const saved = result?.[STORAGE_KEY];
      if (!saved) return;
      state.enabled = Boolean(saved.enabled);
      state.overlayEnabled = saved.overlayEnabled !== false;
      state.primaryLanguage = saved.primaryLanguage || '';
      state.secondaryLanguage = saved.secondaryLanguage || '';
    } catch (_) {
      // Storage failure should not break Netflix playback.
    }
  }

  async function saveSettings() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        enabled: state.enabled,
        overlayEnabled: state.overlayEnabled,
        primaryLanguage: state.primaryLanguage,
        secondaryLanguage: state.secondaryLanguage
      }
    });
  }

  function applySavedPairIfPossible() {
    if (!state.enabled || !state.tracks.length) return;
    const primary = findTrackByLanguage(state.primaryLanguage);
    const secondary = findTrackByLanguage(state.secondaryLanguage);
    if (!primary || !secondary || primary.id === secondary.id) return;

    state.primaryId = primary.id;
    state.secondaryId = secondary.id;
    clearCues();
    state.status = 'loading';
    state.message = 'Loading second subtitle track…';
    toPage('APPLY', { primaryId: primary.id, secondaryId: secondary.id });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== FROM_PAGE) return;

    if (message.kind === 'TRACKS') {
      state.tracks = Array.isArray(message.tracks) ? message.tracks : [];
      state.activeId = String(message.activeId || '');
      applySavedPairIfPossible();
      return;
    }

    if (message.kind === 'PLAYER_STATE') {
      state.activeId = String(message.activeId || '');
      return;
    }

    if (message.kind === 'SUBTITLE_DATA') {
      if (!state.enabled) return;
      const id = String(message.trackId);
      if (id !== state.primaryId && id !== state.secondaryId) return;
      const cues = parseSubtitleText(message.text || '');
      if (cues.length) {
        if (id === state.primaryId) state.primaryCues = cues;
        else state.cues = cues;
        state.revision++;
        state.status = 'ready';
        state.message = state.primaryCues.length && state.cues.length
          ? 'Both subtitle tracks loaded. Transcript ready.'
          : 'One track loaded. Loading the other track for the transcript…';
      } else {
        state.status = 'error';
        state.message = 'A subtitle track loaded, but its text format was not recognized.';
      }
      return;
    }

    if (message.kind === 'STATUS') {
      state.status = message.status || state.status;
      state.message = message.message || state.message;
      return;
    }

    if (message.kind === 'NAVIGATED') {
      clearCues();
      state.tracks = [];
      state.primaryId = '';
      state.secondaryId = '';
      state.status = 'waiting';
      state.message = 'Loading subtitle tracks for this title…';
      toPage('REQUEST_TRACKS');
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.kind === 'GET_TRANSCRIPT') {
      const video = document.querySelector('video');
      const primary = state.tracks.find(t => t.id === state.primaryId);
      const secondary = state.tracks.find(t => t.id === state.secondaryId);
      const result = {
        revision: state.revision, time: video?.currentTime || 0,
        paused: !video || video.paused, message: state.message,
        primaryLoaded: Boolean(state.primaryCues.length), secondaryLoaded: Boolean(state.cues.length)
      };
      if (message.revision !== state.revision) Object.assign(result, {
        primaryCues: state.primaryCues, secondaryCues: state.cues,
        primaryName: primary?.name, secondaryName: secondary?.name,
        primaryLanguage: primary?.language, secondaryLanguage: secondary?.language
      });
      sendResponse(result); return;
    }
    if (message.kind === 'SEEK') {
      const video = document.querySelector('video');
      if (video && Number.isFinite(message.time) && message.time >= 0) {
        toPage('SEEK', { time: message.time });
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      return;
    }
    if (message.kind === 'TOGGLE_PLAY') {
      toPage('TOGGLE_PLAY'); sendResponse({ ok: true }); return;
    }
    if (message.kind === 'SET_OVERLAY') {
      state.overlayEnabled = Boolean(message.enabled); void saveSettings();
      sendResponse({ ok: true }); return;
    }

    if (message.kind === 'GET_STATE') {
      sendResponse({
        tracks: state.tracks,
        activeId: state.activeId,
        enabled: state.enabled,
        overlayEnabled: state.overlayEnabled,
        primaryLanguage: state.primaryLanguage,
        secondaryLanguage: state.secondaryLanguage,
        status: state.status,
        message: state.message
      });
      return;
    }

    if (message.kind === 'REFRESH_TRACKS') {
      toPage('REQUEST_TRACKS');
      sendResponse({ ok: true });
      return;
    }

    if (message.kind === 'APPLY') {
      const primary = state.tracks.find((track) => track.id === message.primaryId);
      const secondary = state.tracks.find((track) => track.id === message.secondaryId);
      if (!primary || !secondary) {
        sendResponse({ ok: false, error: 'Selected track not found.' });
        return;
      }
      if (primary.id === secondary.id) {
        sendResponse({ ok: false, error: 'Choose two different languages.' });
        return;
      }

      state.enabled = true;
      state.primaryId = primary.id;
      state.secondaryId = secondary.id;
      state.primaryLanguage = primary.language || primary.name;
      state.secondaryLanguage = secondary.language || secondary.name;
      clearCues();
      state.status = 'loading';
      state.message = 'Loading second subtitle track…';
      void saveSettings();
      toPage('APPLY', { primaryId: primary.id, secondaryId: secondary.id });
      sendResponse({ ok: true });
      return true;
    }

    if (message.kind === 'DISABLE') {
      toPage('CANCEL');
      state.enabled = false;
      clearCues();
      state.status = 'disabled';
      state.message = 'Dual subtitles disabled.';
      void saveSettings();
      if (overlay) overlay.style.display = 'none';
      sendResponse({ ok: true });
      return true;
    }
  });

  document.addEventListener('fullscreenchange', () => {
    if (overlay) ensureOverlay();
  });

  const urlWatcher = new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    clearCues();
    state.tracks = []; state.primaryId = ''; state.secondaryId = '';
    state.status = 'waiting'; state.message = 'Loading subtitle tracks for this title…';
    toPage('CANCEL');
  });

  void loadSavedSettings().then(() => {
    toPage('REQUEST_TRACKS');
  });

  if (document.documentElement) {
    urlWatcher.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      urlWatcher.observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });
  }

  requestAnimationFrame(renderLoop);
})();
