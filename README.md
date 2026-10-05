# Netflix Two Subs

A local Chrome/Chromium extension with dual subtitles and a separate bilingual transcript window. Version 0.2.0.

- **Primary language:** rendered by Netflix itself.
- **Secondary language:** rendered by this extension as an overlay.
- Uses subtitle tracks already provided by Netflix for the current title.
- No translation API, account, analytics, or subscription.
- Settings are stored locally in Chrome.
- Read both tracks in a separate movable, resizable window.
- Search either language, adjust the font size, follow playback, and click timestamps to seek.
- Turn off the secondary video overlay while keeping the transcript open.

## Install on Chrome (macOS)

1. Unzip the extension folder somewhere permanent.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `netflix-two-subs` folder (the folder containing `manifest.json`).
6. Reload any already-open Netflix tab once.
7. Start a movie/episode and begin playback.
8. Click the **Netflix Two Subs** toolbar icon.
9. Choose **Primary** and **Secondary** subtitle languages and click **Apply**.

Netflix can briefly switch tracks while the extension captures both subtitle files. It restores the selected primary language.

10. Click **Open transcript window ↗** in the popup. The window opens on the right of your screen.
11. Move or resize the Netflix and transcript windows beside each other. Use normal window mode to keep both visible.
12. Turn off **Follow playback** to read freely. Turn off **Show second subtitle on video** if you prefer the translation only in the reader.

The reader displays all text in the subtitle resources Netflix loads; it does not need to wait for each line to play. Subtitle boundaries vary across languages, so rows are paired by timing rather than exact sentence translation. Unmatched lines are retained. The transcript follows the same Netflix tab across episode changes. Reloading the extension requires reloading Netflix and reopening the reader.

## Notes / limitations

Netflix is a private web application and can change its player APIs at any time. This build supports both the older `getTextTrackList` / `setTextTrack` API names and newer timed-text variants where available.

The overlay parser supports text-based TTML/DFXP and WebVTT. Image-based subtitle tracks may not work. If either track does not load, start playback with subtitles enabled and press **Apply** again. The transcript can show one column while the other is loading. If Netflix serves subtitle segments instead of a complete file, only available captured text can be shown.

This extension does not bypass Netflix DRM, download video, or obtain subtitle languages that Netflix has not made available for the title/account/session.

## Privacy

There is no backend. The extension does not send subtitle text or viewing history to any third party. It only observes/fetches Netflix subtitle resources already used by the active Netflix page.

## Uninstall

Remove it from `chrome://extensions`.

## Validation

Checked JavaScript syntax, manifest references, cue alignment, direct and player-triggered subtitle capture, cached reapplication, language changes, cancellation, navigation, search, transcript rendering, playback controls, and revision polling using simulated player/Chrome endpoints. Live authenticated Netflix playback and actual Chrome window layout were not available in the build environment.
