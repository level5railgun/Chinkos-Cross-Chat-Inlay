// Content script — injected into twitch.tv/*.
// Depends on (loaded before this file via manifest): streamers.js, injector.js

(function () {
  'use strict';

  // --- Allowlist check ---

  function getChannelFromPath() {
    // Twitch URLs: /channelname or /channelname/...
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[0]?.toLowerCase() ?? null;
  }

  const channel = getChannelFromPath();
  const streamerConfig = channel ? STREAMERS[channel] : null;

  if (!streamerConfig) return; // Not an opted-in channel — exit immediately.

  // --- State ---

  let port = null;
  let enabled = true; // session-level toggle

  // Circuit breaker for reconnects. Chrome killing the service worker is normal
  // MV3 behaviour, so we reconnect at a fixed 1s interval. However if the SW
  // crashes immediately on every restart (a genuine bug), we stop after
  // MAX_RECONNECT_ATTEMPTS to avoid a CPU-draining infinite loop.
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 8;

  // Cache for popup status queries — updated whenever the background pushes
  // a PLATFORM_STATUS message. Avoids an async round-trip through the background.
  const platformStatuses = {};

  // --- Port connection ---

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'overlay' });
    } catch {
      // Extension was reloaded or updated while this content script was running.
      // The context is permanently invalidated — stop silently; a page reload will reinstate the overlay.
      return;
    }

    port.onMessage.addListener(handleBackgroundMessage);

    port.onDisconnect.addListener(() => {
      port = null;
      if (!enabled) return;

      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[overlay] Too many reconnect attempts — giving up. Reload the page to retry.');
        return;
      }

      reconnectAttempts++;
      setTimeout(connect, 1000);
    });

    if (enabled) sendStartPolling();
  }

  function sendStartPolling() {
    if (!port) return;
    // Apply dev override if one is stored, otherwise use the hardcoded config.
    chrome.storage.session.get(['devOverride'], (result) => {
      if (chrome.runtime.lastError || !result) result = {};
      if (!port) return; // port may have died while waiting for storage
      const platforms = result.devOverride?.platforms ?? streamerConfig.platforms;
      port.postMessage({
        type: 'START_POLLING',
        twitchChannel: streamerConfig.twitch,
        platforms
      });
    });
  }

  function handleBackgroundMessage(msg) {
    // Receiving any message means the connection is healthy — reset circuit breaker.
    reconnectAttempts = 0;

    switch (msg.type) {
      case 'CHAT_MESSAGES':
        if (enabled) insertMessages(msg.messages);
        break;

      case 'PLATFORM_STATUS':
        // Keep local cache up to date for popup queries.
        platformStatuses[msg.platform] = { status: msg.status, videoId: msg.videoId };
        if (msg.status === 'live') {
          showLiveBanner(msg.platform, msg.videoId);
        } else {
          hideLiveBanner(msg.platform);
        }
        break;
    }
  }

  // --- Popup status requests ---
  // The popup uses chrome.tabs.sendMessage → content script → sendResponse.
  // We answer immediately from the local cache; no background round-trip needed.
  // Sender is validated to ensure only our own extension can query status.

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.type === 'GET_STATUS') {
      sendResponse({ statuses: platformStatuses });
    }
    return false; // synchronous response — no need to keep channel open
  });

  // --- Visibility change (pause polling when tab hidden) ---

  document.addEventListener('visibilitychange', () => {
    if (!port) return;
    port.postMessage({
      type: document.hidden ? 'PAUSE_POLLING' : 'RESUME_POLLING',
      twitchChannel: streamerConfig.twitch
    });
  });

  // --- Page unload ---

  window.addEventListener('pagehide', () => {
    if (port) {
      port.postMessage({ type: 'STOP_POLLING', twitchChannel: streamerConfig.twitch });
      port.disconnect();
      port = null;
    }
  });

  // --- SPA navigation detection ---
  // Observe document.title — Twitch updates it on every SPA navigation.
  // This replaces the previous approach of injecting a <script> into page
  // context to wrap history.pushState, which flags CWS automated review and
  // creates a custom-event spoofing vector.

  let lastPathname = window.location.pathname;

  // Set when SPA navigation leaves the enrolled channel (e.g. raid). Prevents
  // the secondary MutationObserver from reconnecting with stale config after
  // Twitch remounts the chat container for the new channel.
  let navigatedAway = false;

  function handleNavigation() {
    const newChannel = getChannelFromPath();
    if (newChannel === channel) return; // Same channel, no-op.

    navigatedAway = true;

    // Stop polling for the old channel and disconnect.
    if (port) {
      port.postMessage({ type: 'STOP_POLLING', twitchChannel: streamerConfig.twitch });
      port.disconnect();
      port = null;
    }

    // Hide all banners from the previous channel.
    for (const platform of Object.keys(streamerConfig.platforms)) {
      hideLiveBanner(platform);
    }

    // The new channel may or may not be in the allowlist — if not, we simply
    // stop. A full page load to the new channel will re-run this script.
  }

  const titleEl = document.querySelector('head > title');
  if (titleEl) {
    const titleObserver = new MutationObserver(() => {
      if (window.location.pathname !== lastPathname) {
        lastPathname = window.location.pathname;
        handleNavigation();
      }
    });
    titleObserver.observe(titleEl, { childList: true, subtree: true, characterData: true });
  }

  // popstate handles browser back/forward navigation (title observer won't fire for these).
  window.addEventListener('popstate', () => {
    lastPathname = window.location.pathname;
    handleNavigation();
  });

  // --- Twitch chat MutationObserver ---
  // Primary: watches the chat log for native row removals (for mirror-pruning).
  // Secondary: watches document.body for the chat container being remounted
  //            after a React SPA navigation that keeps the page alive.

  let primaryObserver = null;

  function attachPrimaryObserver() {
    const log = document.querySelector('[data-a-target="chat-scroller"] [role="log"]');
    if (!log) return false;

    if (primaryObserver) primaryObserver.disconnect();

    primaryObserver = new MutationObserver((mutations) => {
      let removedNativeCount = 0;
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType === 1 &&
              node.dataset?.aTarget === 'chat-line-message' &&
              !node.dataset.extPlatform) {
            removedNativeCount++;
          }
        }
      }
      if (removedNativeCount > 0) pruneInjected(removedNativeCount);
    });

    primaryObserver.observe(log, { childList: true });
    return true;
  }

  const secondaryObserver = new MutationObserver(() => {
    // Re-attach primary observer when Twitch remounts the chat log.
    if (navigatedAway) return; // Left the enrolled channel (e.g. raid) — don't reconnect.
    if (!document.querySelector('[data-a-target="chat-scroller"] [role="log"]')) return;
    if (attachPrimaryObserver()) {
      // Chat was remounted — re-send START_POLLING in case the port dropped.
      if (!port) connect();
    }
  });

  secondaryObserver.observe(document.body, { childList: true, subtree: true });

  // --- Session toggle support ---
  // Reads from chrome.storage.session so popup can disable the overlay.

  chrome.storage.session.get(['overlayEnabled'], (result) => {
    if (chrome.runtime.lastError || !result) return;
    if (result.overlayEnabled === false) enabled = false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;

    if ('overlayEnabled' in changes) {
      enabled = changes.overlayEnabled.newValue !== false;
      if (!port) return;
      port.postMessage({
        type: enabled ? 'RESUME_POLLING' : 'PAUSE_POLLING',
        twitchChannel: streamerConfig.twitch
      });
    }

    if ('devOverride' in changes) {
      // Restart polling immediately with the new (or cleared) override.
      if (!port) return;
      const platforms = changes.devOverride.newValue?.platforms ?? streamerConfig.platforms;
      port.postMessage({
        type: 'START_POLLING',
        twitchChannel: streamerConfig.twitch,
        platforms
      });
    }
  });

  // --- Init ---

  // Attempt to attach the primary observer immediately (chat may already exist).
  attachPrimaryObserver();
  connect();
})();
