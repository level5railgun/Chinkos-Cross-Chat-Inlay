// Content script — injected into twitch.tv/*.
// Depends on (loaded before this file via manifest): injector.js

(function () {
  'use strict';

  // --- Channel detection ---

  function getChannelFromPath() {
    // Twitch URLs: /channelname or /channelname/...
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[0]?.toLowerCase() ?? null;
  }

  const channel = getChannelFromPath();
  if (!channel) return; // Not a channel page — exit.

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

  // Auto-detection state
  let autoDetectedPlatforms = null; // set when YouTube link found via page scan
  let discoveryState = 'scanning';
  //   'scanning'  — looking for YouTube link on page
  //   'found'     — YouTube link found, polling started
  let scanObserver = null;

  // --- YouTube link scanner ---

  function parseYouTubeLinkFromHref(href) {
    if (!href) return null;
    let url;
    try { url = new URL(href); } catch { return null; }

    const host = url.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const videoId = url.pathname.slice(1).split('/')[0];
      if (videoId && /^[\w-]{11}$/.test(videoId)) return { videoId };
      return null;
    }

    if (host !== 'youtube.com') return null;

    // Watch URL → extract video ID
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return { videoId: v };

    const path = url.pathname;

    // /@Handle or /@Handle/...
    const atMatch = path.match(/^\/@([^/]+)/);
    if (atMatch) return { channelHandle: atMatch[1] };

    // /channel/UCxxxx
    const channelMatch = path.match(/^\/channel\/(UC[\w-]+)/);
    if (channelMatch) return { channelId: channelMatch[1] };

    // /c/Name (legacy)
    const legacyMatch = path.match(/^\/c\/([^/]+)/);
    if (legacyMatch) return { channelHandle: legacyMatch[1] };

    return null;
  }

  function isInsideChatScroller(el) {
    return el.closest('[data-a-target="chat-scroller"]') ||
           el.closest('.chat-scrollable-area__message-container') ||
           el.closest('.chat-list--default') ||
           el.closest('.chat-list--other') ||
           el.closest('.chat-list');
  }

  function findYouTubeChannelLink() {
    const links = document.querySelectorAll('a[href*="youtube"]');
    // Prefer channel links (handle/channelId) over video links
    for (const link of links) {
      if (isInsideChatScroller(link)) continue;
      const parsed = parseYouTubeLinkFromHref(link.href);
      if (parsed && !parsed.videoId) return parsed;
    }
    // Fallback: accept video links too
    for (const link of links) {
      if (isInsideChatScroller(link)) continue;
      const parsed = parseYouTubeLinkFromHref(link.href);
      if (parsed) return parsed;
    }
    return null;
  }

  function onYouTubeLinkFound(config) {
    autoDetectedPlatforms = { youtube: config };
    discoveryState = 'found';
    if (!port) {
      connect();
    } else {
      sendStartPolling();
    }
  }

  function startYouTubeLinkScan() {
    // Immediate check
    const found = findYouTubeChannelLink();
    if (found) {
      onYouTubeLinkFound(found);
      return;
    }

    // MutationObserver scan — waits for panels to render.
    // No timeout: panels can take arbitrarily long on slow connections.
    // The observer stays active until a link is found or the user navigates away.
    scanObserver = new MutationObserver(() => {
      const result = findYouTubeChannelLink();
      if (result) {
        scanObserver.disconnect();
        scanObserver = null;
        onYouTubeLinkFound(result);
      }
    });
    scanObserver.observe(document.body, { childList: true, subtree: true });
  }

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
    // Manual override takes highest priority; fall back to auto-detected platforms.
    chrome.storage.session.get(['manualOverride'], (result) => {
      if (chrome.runtime.lastError || !result) result = {};
      if (!port) return; // port may have died while waiting for storage
      const platforms = result.manualOverride?.platforms ?? autoDetectedPlatforms;
      if (!platforms) return; // Still scanning or nothing found — wait
      port.postMessage({
        type: 'START_POLLING',
        twitchChannel: channel,
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
      sendResponse({ statuses: platformStatuses, discoveryState });
    }
    return false; // synchronous response — no need to keep channel open
  });

  // --- Visibility change (pause polling when tab hidden) ---

  document.addEventListener('visibilitychange', () => {
    if (!port) return;
    port.postMessage({
      type: document.hidden ? 'PAUSE_POLLING' : 'RESUME_POLLING',
      twitchChannel: channel
    });
  });

  // --- Page unload ---

  window.addEventListener('pagehide', () => {
    if (port) {
      port.postMessage({ type: 'STOP_POLLING', twitchChannel: channel });
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

  // Set when SPA navigation leaves this channel (e.g. raid). Prevents
  // the secondary MutationObserver from reconnecting with stale state after
  // Twitch remounts the chat container for the new channel.
  let navigatedAway = false;

  function handleNavigation() {
    const newChannel = getChannelFromPath();
    if (newChannel === channel) return; // Same channel, no-op.

    navigatedAway = true;

    // Stop polling and disconnect.
    if (port) {
      port.postMessage({ type: 'STOP_POLLING', twitchChannel: channel });
      port.disconnect();
      port = null;
    }

    // Hide all banners from the previous channel.
    const platforms = autoDetectedPlatforms ?? {};
    for (const platform of Object.keys(platforms)) {
      hideLiveBanner(platform);
    }

    // Cancel any in-progress scan.
    if (scanObserver) { scanObserver.disconnect(); scanObserver = null; }
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
    const log = getChatLog();
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
    if (navigatedAway) return; // Left this channel (e.g. raid) — don't reconnect.
    if (!getChatLog()) return;
    if (attachPrimaryObserver()) {
      // Chat was remounted — reconnect if port dropped and we have platforms to poll.
      if (!port && autoDetectedPlatforms) connect();
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
        twitchChannel: channel
      });
    }

    if ('manualOverride' in changes) {
      // Restart polling immediately with the new (or cleared) override.
      const platforms = changes.manualOverride.newValue?.platforms ?? autoDetectedPlatforms;
      if (!port) {
        if (platforms) connect(); // Port not yet open — open it now with the override
        return;
      }
      if (!platforms) return;
      port.postMessage({
        type: 'START_POLLING',
        twitchChannel: channel,
        platforms
      });
    }
  });

  // --- Init ---

  // Attempt to attach the primary observer immediately (chat may already exist).
  attachPrimaryObserver();
  // Begin scanning for a YouTube link in the page panels.
  // Port/polling is deferred until a link is found (or a manual override is set).
  startYouTubeLinkScan();
})();
