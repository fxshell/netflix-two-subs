(() => {
  'use strict';

  const TO_PAGE = 'N2S_TO_PAGE';
  const FROM_PAGE = 'N2S_FROM_PAGE';
  const capturedByTrack = new Map();
  let expectedCaptureTrackId = null;
  let expectedCaptureUntil = 0;
  let lastTrackSignature = '';
  let lastStateSignature = '';
  let lastUrl = location.href;
  let operation = 0;
  let requestedPrimaryId = '';
  let applyQueue = Promise.resolve();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function emit(kind, payload = {}) {
    window.postMessage({ channel: FROM_PAGE, kind, ...payload }, '*');
  }

  function safeCall(fn, fallback = null) {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  }

  function getPlayer() {
    const videoPlayer = safeCall(
      () => window.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer,
      null
    );
    if (!videoPlayer) return null;

    const ids = safeCall(() => videoPlayer.getAllPlayerSessionIds?.(), []) || [];
    if (!ids.length) return null;

    for (const id of ids) {
      const player = safeCall(() => videoPlayer.getVideoPlayerBySessionId?.(id), null);
      if (player) return player;
    }
    return null;
  }

  function getRawTrackList(player) {
    if (!player) return [];
    const candidates = [
      () => player.getTextTrackList?.(),
      () => player.getTimedTextTrackList?.(),
      () => player.getSubtitleTrackList?.()
    ];
    for (const get of candidates) {
      const tracks = safeCall(get, null);
      if (Array.isArray(tracks) && tracks.length) return tracks;
    }
    return [];
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function trackId(track, index = 0) {
    return String(
      track?.trackId ??
      track?.id ??
      track?.timedTextTrackId ??
      track?.downloadableId ??
      `${trackLanguage(track) || 'track'}:${index}`
    );
  }

  function trackLanguage(track) {
    return firstString(
      track?.bcp47,
      track?.languageCode,
      track?.lang,
      typeof track?.language === 'string' ? track.language : '',
      track?.language?.bcp47,
      track?.language?.code
    );
  }

  function trackName(track) {
    return firstString(
      track?.displayName,
      track?.languageDescription,
      track?.name,
      track?.label,
      track?.language?.displayName,
      track?.language?.name,
      trackLanguage(track)
    ) || 'Unknown';
  }

  function isOffTrack(track) {
    const id = String(track?.id ?? track?.trackId ?? '').toLowerCase();
    const name = trackName(track).toLowerCase();
    return id === 'off' || name === 'off' || name === 'none' || name.includes('subtitles off');
  }

  function publicTracks(player) {
    return getRawTrackList(player)
      .map((track, index) => ({
        id: trackId(track, index),
        language: trackLanguage(track),
        name: trackName(track),
        isForced: Boolean(track?.isForcedNarrative || track?.forcedNarrative),
        rawIndex: index
      }))
      .filter((track) => !isOffTrack(track));
  }

  function findRawTrack(player, id) {
    const list = getRawTrackList(player);
    return list.find((track, index) => trackId(track, index) === String(id)) || null;
  }

  function getActiveTrack(player) {
    const getters = [
      () => player.getTextTrack?.(),
      () => player.getTimedTextTrack?.(),
      () => player.getSubtitleTrack?.()
    ];
    for (const get of getters) {
      const track = safeCall(get, null);
      if (track) return track;
    }
    return null;
  }

  function setTrack(player, track) {
    if (!player || !track) return false;
    const methodNames = ['setTextTrack', 'setTimedTextTrack', 'setSubtitleTrack'];
    for (const methodName of methodNames) {
      if (typeof player[methodName] !== 'function') continue;
      try {
        player[methodName](track);
        return true;
      } catch (_) {
        // Try the next API name.
      }
    }
    return false;
  }

  function looksLikeSubtitleText(text) {
    if (typeof text !== 'string' || text.length < 8) return false;
    const head = text.slice(0, 1200).toLowerCase();
    return (
      head.includes('webvtt') ||
      head.includes('<tt') ||
      head.includes('<p ') ||
      head.includes('<p>') ||
      head.includes('timedtext')
    );
  }

  function looksLikeSubtitleUrl(url) {
    const value = String(url || '').toLowerCase();
    return /timedtext|subtitle|caption|\.vtt(?:$|\?)|\.ttml(?:$|\?)|\.dfxp(?:$|\?)|\.xml(?:$|\?)/.test(value);
  }

  function activeTrackId() {
    const player = getPlayer();
    if (!player) return null;
    const active = getActiveTrack(player);
    if (!active) return null;
    const list = getRawTrackList(player);
    const index = list.indexOf(active);
    return trackId(active, Math.max(index, 0));
  }

  function captureText(text, url = '', requestTrackId = null, requestUrl = location.href) {
    if (requestUrl !== location.href) return;
    if (!looksLikeSubtitleText(text)) return;

    let id = requestTrackId;
    if (!id && expectedCaptureTrackId && Date.now() <= expectedCaptureUntil) {
      id = expectedCaptureTrackId;
    }
    if (!id) id = activeTrackId();
    if (!id) return;

    capturedByTrack.set(String(id), { text, url, capturedAt: Date.now() });
    emit('SUBTITLE_DATA', { trackId: String(id), text });
  }

  function shouldInspectResponse(url, contentType, contentLength = 0) {
    const type = String(contentType || '').toLowerCase();
    if (looksLikeSubtitleUrl(url)) return true;
    if (type.includes('vtt') || type.includes('xml') || type.includes('ttml') || type.includes('text/plain')) return true;

    // Netflix subtitle CDN URLs are often opaque. While intentionally priming
    // the second track, inspect only reasonably small Netflix CDN responses.
    if (expectedCaptureTrackId && Date.now() <= expectedCaptureUntil) {
      try {
        const host = new URL(String(url || ''), location.href).hostname.toLowerCase();
        const netflixCdn = host.endsWith('.nflxvideo.net') || host.endsWith('.netflix.com');
        return netflixCdn && (!contentLength || contentLength < 2_000_000);
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  async function inspectFetchResponse(response, url, id, requestUrl) {
    try {
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (!shouldInspectResponse(url, contentType, contentLength)) return;
      const text = await response.clone().text();
      captureText(text, url, id, requestUrl);
    } catch (_) {
      // Best-effort observer only.
    }
  }

  // Capture Netflix's own subtitle requests as early as possible.
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (...args) {
      const id = expectedCaptureTrackId || activeTrackId();
      const requestUrl = location.href;
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || response.url || '';
      void inspectFetchResponse(response, url, id, requestUrl);
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__n2sUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const id = expectedCaptureTrackId || activeTrackId();
    const requestUrl = location.href;
    this.addEventListener('load', () => {
      try {
        const contentType = String(this.getResponseHeader('content-type') || '').toLowerCase();
        const contentLength = Number(this.getResponseHeader('content-length') || 0);
        const url = this.__n2sUrl || this.responseURL || '';
        if (!shouldInspectResponse(url, contentType, contentLength)) return;
        if (typeof this.responseText === 'string') captureText(this.responseText, url, id, requestUrl);
      } catch (_) {
        // responseText can throw for non-text responseTypes.
      }
    });
    return originalSend.apply(this, args);
  };

  function extractHttpUrls(value, depth = 0, seen = new Set(), out = new Set()) {
    if (depth > 6 || value == null) return out;
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) out.add(value);
      return out;
    }
    if (typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) extractHttpUrls(item, depth + 1, seen, out);
      return out;
    }

    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
        out.add(item);
      } else if (/url|download|track|text/i.test(key) || depth < 3) {
        extractHttpUrls(item, depth + 1, seen, out);
      }
    }
    return out;
  }

  async function tryDirectTrackFetch(rawTrack, id, valid = () => true) {
    const urls = [...extractHttpUrls(rawTrack)];
    for (const url of urls) {
      try {
        if (!valid()) return false;
        const response = await originalFetch.call(window, url, { credentials: 'include' });
        if (!response.ok) continue;
        const text = await response.text();
        if (!valid()) return false;
        if (!looksLikeSubtitleText(text)) continue;
        capturedByTrack.set(String(id), { text, url, capturedAt: Date.now() });
        emit('SUBTITLE_DATA', { trackId: String(id), text });
        return true;
      } catch (_) {
        // Signed URLs/CORS may prevent a direct fetch. Switching the track is the fallback.
      }
    }
    return false;
  }

  async function primePair(primaryId, secondaryId, token, url) {
    const valid = () => token === operation && url === location.href;
    if (!valid()) return;
    const player = getPlayer();
    const primary = findRawTrack(player, primaryId);
    const secondary = findRawTrack(player, secondaryId);
    if (!player || !primary || !secondary) {
      emit('STATUS', { status: 'error', message: 'Netflix player or selected subtitle tracks are not available yet.' });
      return;
    }
    emit('STATUS', { status: 'loading', message: 'Loading both subtitle tracks for the transcript…' });
    try {
      for (const [id, raw] of [[secondaryId, secondary], [primaryId, primary]]) {
        if (!valid()) return;
        if (!capturedByTrack.has(id)) await tryDirectTrackFetch(raw, id, valid);
        if (!valid()) return;
        if (!capturedByTrack.has(id)) {
          // If already selected, switching away first can prompt a new text request.
          if (activeTrackId() === id) {
            setTrack(player, id === primaryId ? secondary : primary);
            await sleep(200);
            if (!valid()) return;
          }
          expectedCaptureTrackId = id;
          expectedCaptureUntil = Date.now() + 5000;
          setTrack(player, raw);
          for (let i = 0; i < 25 && valid() && !capturedByTrack.has(id); i++) await sleep(150);
        }
        if (!valid()) return;
        expectedCaptureTrackId = null; expectedCaptureUntil = 0;
        const captured = capturedByTrack.get(id);
        if (captured) emit('SUBTITLE_DATA', { trackId: id, text: captured.text });
      }
      if (!valid()) return;
      const both = capturedByTrack.has(primaryId) && capturedByTrack.has(secondaryId);
      const second = capturedByTrack.has(secondaryId);
      emit('STATUS', {
        status: both || second ? 'ready' : 'error',
        message: both ? 'Both tracks loaded. Open the transcript window to read.'
          : second ? 'Second subtitle ready. Primary transcript could not load; try Apply again.'
          : 'Could not read the subtitle text. Start playback with subtitles enabled, then Apply again.'
      });
    } catch (_) {
      if (valid()) emit('STATUS', { status: 'error', message: 'Subtitle loading failed. Try Apply again.' });
    } finally {
      expectedCaptureTrackId = null; expectedCaptureUntil = 0;
      // Never change the subtitle selection of a different episode.
      if (url === location.href) {
        const restore = findRawTrack(getPlayer(), requestedPrimaryId);
        if (restore) setTrack(getPlayer(), restore);
      }
    }
  }

  function publishState() {
    const player = getPlayer();
    if (!player) return;

    const tracks = publicTracks(player);
    const active = getActiveTrack(player);
    const raw = getRawTrackList(player);
    const activeIndex = raw.indexOf(active);
    const activeId = active ? trackId(active, Math.max(activeIndex, 0)) : '';

    const trackSignature = JSON.stringify(tracks);
    if (trackSignature !== lastTrackSignature) {
      lastTrackSignature = trackSignature;
      emit('TRACKS', { tracks, activeId });
    }

    const stateSignature = `${activeId}|${location.href}`;
    if (stateSignature !== lastStateSignature) {
      lastStateSignature = stateSignature;
      emit('PLAYER_STATE', { activeId, url: location.href });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== TO_PAGE) return;

    if (message.kind === 'REQUEST_TRACKS') {
      lastTrackSignature = '';
      publishState();
      return;
    }

    if (message.kind === 'APPLY') {
      requestedPrimaryId = String(message.primaryId);
      const primaryId = requestedPrimaryId, secondaryId = String(message.secondaryId);
      const token = ++operation, url = location.href;
      applyQueue = applyQueue.catch(() => {}).then(() => primePair(primaryId, secondaryId, token, url));
      return;
    }

    if (message.kind === 'CANCEL') {
      operation++; expectedCaptureTrackId = null; expectedCaptureUntil = 0;
      const player = getPlayer();
      const restore = findRawTrack(player, requestedPrimaryId);
      if (player && restore) setTrack(player, restore);
      return;
    }
    if (message.kind === 'SEEK' && Number.isFinite(message.time) && message.time >= 0) {
      const player = getPlayer();
      if (typeof player?.seek === 'function') safeCall(() => player.seek(message.time * 1000));
      else { const video = document.querySelector('video'); if (video) video.currentTime = message.time; }
      return;
    }
    if (message.kind === 'TOGGLE_PLAY') {
      const video = document.querySelector('video');
      if (video) {
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      }
      return;
    }

    if (message.kind === 'SET_PRIMARY') {
      const player = getPlayer();
      const primary = findRawTrack(player, String(message.primaryId));
      if (player && primary) setTrack(player, primary);
    }
  });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      operation++; requestedPrimaryId = '';
      capturedByTrack.clear();
      lastTrackSignature = '';
      lastStateSignature = '';
      emit('NAVIGATED', { url: lastUrl });
    }
    publishState();
  }, 1000);

  emit('PAGE_READY');
})();
