// YouTube chat adapter.
// Discovers live streams via /@handle/live redirect, fetches chat via
// the continuation API, and normalizes messages to the ChatMessage interface.
//
// Two polling strategies:
//   1. InnerTube continuation API (fast, lightweight POST requests)
//   2. Page-poll fallback (re-fetches /live_chat HTML and deduplicates)
//
// Chrome MV3 service workers send Sec-Fetch-Site: cross-site and Origin:
// chrome-extension://… on POST requests — headers that cannot be overridden.
// Google's abuse detection can flag this fingerprint, returning a "Sorry…"
// CAPTCHA page (403). When that happens the adapter falls back to page-poll
// mode, which uses simple GET requests that are not flagged.

const LIVE_CHAT_API = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat';
// Fallback InnerTube web API key — extracted dynamically from the live_chat page when possible.
const FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const MIN_POLL_MS = 2000;
const FALLBACK_POLL_MS = 3000;
const PAGE_POLL_MS = 6000;     // Interval for page-poll fallback (heavier, so slower)
const DISCOVERY_RETRY_MS = 60_000;
const ERROR_RETRY_MS = 5_000;

export function createAdapter({ onMessages, onStatus }) {
  let continuation = null;
  let videoId = null;
  let clientVersion = null; // resolved dynamically from live_chat page
  let apiKey = null;        // resolved dynamically from live_chat page
  let visitorData = null;   // resolved dynamically from live_chat page
  let datasyncId = null;    // resolved dynamically from live_chat page (needed for SAPISIDHASH)
  let pollTimer = null;
  let stopped = false;
  let paused = false;
  let auth403Count = 0; // consecutive 403s; breaks infinite refresh loop
  let channelHandle = null;
  let channelId = null;
  let initVideoId = null; // set when init receives a direct videoId (manual override)

  // Page-poll fallback state.
  let usePagePoll = false;   // true after InnerTube API 403
  let seenIds = new Set();   // dedup set for page-poll mode

  // --- Discovery ---

  async function discoverLive() {
    if (!channelHandle && !channelId) return null;
    const url = channelHandle
      ? `https://www.youtube.com/@${channelHandle}/live`
      : `https://www.youtube.com/channel/${channelId}/live`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      // Try redirect URL first (HTTP 302 → watch URL)
      const urlMatch = res.url.match(/[?&]v=([\w-]+)/);
      if (urlMatch) return urlMatch[1];
      // Fallback: YouTube sometimes returns 200 at the /live URL with the videoId
      // embedded in the page HTML rather than issuing an HTTP redirect.
      const html = await res.text();
      const htmlMatch = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
      return htmlMatch ? htmlMatch[1] : null;
    } catch (err) {
      console.warn('[overlay/youtube] discoverLive fetch error:', err.message);
      return null;
    }
  }

  // Fetches the live_chat iframe page and extracts:
  //  - the initial continuation token
  //  - INNERTUBE_CLIENT_VERSION, INNERTUBE_API_KEY, visitorData (for authenticated polls)
  //  - the batch of chat messages present in ytInitialData
  //
  // Returns { token, messages } or null on failure.
  async function getInitialData(vid) {
    let html;
    try {
      const res = await fetch(`https://www.youtube.com/live_chat?v=${vid}`, { credentials: 'include' });
      html = await res.text();
    } catch (err) {
      console.warn('[overlay/youtube] getInitialData fetch error:', err.message);
      return null;
    }

    // Detect YouTube consent / cookie-wall pages that block access to live_chat.
    if (html.includes('action="https://consent.youtube.com') ||
        html.includes('action="https://consent.google.com')) {
      console.warn(
        '[overlay/youtube] getInitialData blocked by YouTube consent page. ' +
        'The user may need to accept YouTube cookies in their browser first.'
      );
      return null;
    }

    // Extract INNERTUBE_CLIENT_VERSION, INNERTUBE_API_KEY, and VISITOR_DATA from
    // the page config (ytcfg). VISITOR_DATA is critical for bot detection.
    const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
    if (versionMatch) clientVersion = versionMatch[1];
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (apiKeyMatch) apiKey = apiKeyMatch[1];
    const dsMatch = html.match(/"DATASYNC_ID"\s*:\s*"([^"]+)"/);
    if (dsMatch) datasyncId = dsMatch[1];
    // VISITOR_DATA lives in ytcfg (page config), NOT inside ytInitialData.
    const vdConfigMatch = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
    if (vdConfigMatch) visitorData = decodeURIComponent(vdConfigMatch[1]);

    // Extract ytInitialData JSON.
    const prefixMatch = html.match(/window\.ytInitialData\s*=\s*|window\["ytInitialData"\]\s*=\s*|ytInitialData\s*=\s*/);
    if (!prefixMatch) return null;

    const jsonStart = prefixMatch.index + prefixMatch[0].length;
    const remaining = html.slice(jsonStart);
    const endMatch = remaining.search(/\};?[\t\r\n ]*<\/script>/);
    if (endMatch === -1) return null;

    try {
      const data = JSON.parse(remaining.slice(0, endMatch + 1));

      // Extract visitorData from ytInitialData as well (overrides ytcfg if present).
      const vd = data?.responseContext?.visitorData;
      if (vd) visitorData = vd;

      const continuations = data?.contents?.liveChatRenderer?.continuations;
      const token = extractContinuationToken(continuations);

      // Extract the batch of messages baked into the page.
      const initialActions = data?.contents?.liveChatRenderer?.actions ?? [];
      const messages = initialActions
        .map(a => a?.addChatItemAction?.item?.liveChatTextMessageRenderer)
        .filter(Boolean)
        .map(normalizeMessage);

      return { token, messages };
    } catch (err) {
      console.warn('[overlay/youtube] getInitialData parse error:', err.message);
      return null;
    }
  }

  function extractContinuationToken(continuations) {
    if (!Array.isArray(continuations)) return null;
    for (const c of continuations) {
      const token =
        c?.invalidationContinuationData?.continuation ||
        c?.timedContinuationData?.continuation ||
        c?.liveChatReplayContinuationData?.continuation;
      if (token) return token;
    }
    return null;
  }

  // --- Auth ---

  async function getSapisidHash() {
    let cookie = await chrome.cookies.get({ url: 'https://www.youtube.com', name: '__Secure-3PAPISID' });
    if (!cookie) {
      cookie = await chrome.cookies.get({ url: 'https://www.youtube.com', name: 'SAPISID' });
    }
    if (!cookie?.value) return null;

    const timestamp = Math.floor(Date.now() / 1000);
    const msg = `${timestamp} ${cookie.value} https://www.youtube.com`;
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(msg));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${timestamp}_${hex}`;
  }

  // --- Polling: InnerTube API ---

  function buildClientContext() {
    const client = {
      clientName: 'WEB',
      clientVersion: clientVersion ?? '2.20240101',
      hl: 'en',
      gl: 'US',
      userAgent: navigator.userAgent,
      platform: 'DESKTOP',
      clientFormFactor: 'UNKNOWN_FORM_FACTOR',
    };
    if (visitorData) client.visitorData = visitorData;
    return { client };
  }

  async function fetchBatch() {
    const key  = apiKey ?? FALLBACK_API_KEY;
    const cv   = clientVersion ?? '2.20240101';
    const auth = await getSapisidHash();

    const headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': cv,
      'X-Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/live_chat?v=${videoId}`,
      'X-Goog-AuthUser': '0',
    };
    if (auth) headers['Authorization'] = auth;
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    if (datasyncId) headers['X-Goog-PageId'] = datasyncId;

    const body = { context: buildClientContext(), continuation };
    if (datasyncId) body.context.user = { onBehalfOfUser: datasyncId };

    const res = await fetch(`${LIVE_CHAT_API}?key=${key}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // YouTube nests chat data under different keys depending on context.
    const lcc = data?.liveChatContinuation ?? data?.continuationContents?.liveChatContinuation;
    if (!lcc) throw new Error('No liveChatContinuation in response');

    const nextToken = extractContinuationToken(lcc.continuations);
    const timeoutMs =
      lcc.continuations?.[0]?.invalidationContinuationData?.timeoutMs ??
      lcc.continuations?.[0]?.timedContinuationData?.timeoutMs ??
      FALLBACK_POLL_MS;

    const messages = (lcc.actions ?? [])
      .map(a => a?.addChatItemAction?.item?.liveChatTextMessageRenderer)
      .filter(Boolean)
      .map(normalizeMessage);

    return { messages, nextToken, timeoutMs };
  }

  function normalizeMessage(r) {
    const parts = (r.message?.runs ?? []).map(run => {
      if (run.text != null) return { type: 'text', text: run.text };
      const thumb = run.emoji?.image?.thumbnails?.[0];
      return {
        type: 'emoji',
        imageUrl: thumb?.url ?? '',
        alt: run.emoji?.shortcuts?.[0] ?? run.emoji?.emojiId ?? ''
      };
    });

    const badges = (r.authorBadges ?? [])
      .map(b => {
        const renderer = b?.liveChatAuthorBadgeRenderer;
        return {
          imageUrl: renderer?.customThumbnail?.thumbnails?.[0]?.url ?? '',
          label: renderer?.accessibility?.accessibilityData?.label ?? ''
        };
      })
      .filter(b => b.imageUrl);

    return {
      id: r.id,
      platform: 'youtube',
      displayName: r.authorName?.simpleText ?? 'Unknown',
      authorId: r.authorExternalChannelId ?? '',
      parts,
      badges,
      timestampMs: r.timestampUsec
        ? Math.floor(Number(r.timestampUsec) / 1000)
        : Date.now()
    };
  }

  // --- Helper: emit initial messages (used by both poll modes) ---

  function emitInitialMessages(result) {
    if (!result?.messages?.length) return;
    if (usePagePoll) {
      // In page-poll mode, deduplicate against seenIds.
      const fresh = result.messages.filter(m => !seenIds.has(m.id));
      for (const m of result.messages) seenIds.add(m.id);
      // Cap the dedup set to avoid unbounded growth.
      if (seenIds.size > 2000) {
        const arr = [...seenIds];
        seenIds = new Set(arr.slice(arr.length - 1000));
      }
      if (fresh.length > 0) onMessages(fresh);
    } else {
      onMessages(result.messages);
    }
  }

  // --- Poll loop: InnerTube API (primary) ---

  async function pollLoop() {
    if (stopped || paused || !continuation) return;

    let timeoutMs = FALLBACK_POLL_MS;
    try {
      const { messages, nextToken, timeoutMs: t } = await fetchBatch();
      if (stopped) return;

      auth403Count = 0;

      if (!nextToken) {
        videoId = null;
        continuation = null;
        onStatus('offline');
        if (!stopped) pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
        return;
      }

      continuation = nextToken;
      timeoutMs = t;
      if (messages.length > 0) onMessages(messages);
    } catch (err) {
      if (err.message.includes('403') && videoId) {
        auth403Count++;

        if (auth403Count >= 1) {
          // InnerTube API POST is blocked by Google's abuse detection.
          // Fall back to page-poll mode (GET requests are not flagged).
          console.log('[overlay/youtube] 403 on InnerTube API — switching to page-poll mode');
          usePagePoll = true;
          // Seed the dedup set with messages from the initial page fetch.
          // (seenIds may already have some from the init phase.)
          pageRefreshLoop();
          return;
        }
      } else {
        timeoutMs = ERROR_RETRY_MS;
      }
    }

    if (!stopped && !paused) {
      pollTimer = setTimeout(pollLoop, Math.max(timeoutMs, MIN_POLL_MS));
    }
  }

  // --- Poll loop: Page-poll fallback ---
  // Re-fetches the /live_chat HTML page periodically. Each fetch returns the
  // latest ~50–100 messages. We deduplicate by message ID so only new messages
  // are forwarded to the UI.

  async function pageRefreshLoop() {
    if (stopped || paused) return;

    try {
      const result = await getInitialData(videoId);
      if (stopped) return;

      if (!result) {
        // Page fetch failed — stream may have ended or page changed.
        onStatus('error');
        if (!stopped) pollTimer = setTimeout(() => pageRefreshLoop(), ERROR_RETRY_MS);
        return;
      }

      emitInitialMessages(result);

      // Still live — schedule next poll.
      if (!stopped && !paused) {
        pollTimer = setTimeout(pageRefreshLoop, PAGE_POLL_MS);
      }
    } catch (err) {
      console.warn('[overlay/youtube] page-poll error:', err.message);
      if (!stopped && !paused) {
        pollTimer = setTimeout(pageRefreshLoop, ERROR_RETRY_MS);
      }
    }
  }

  // --- Discovery loop ---

  async function discover() {
    if (stopped) return;

    auth403Count = 0;

    if (!channelHandle && !channelId) {
      onStatus('offline');
      return;
    }

    const vid = await discoverLive();
    if (stopped) return;

    if (vid) {
      videoId = vid;
      onStatus('live', vid);

      const result = await getInitialData(vid);
      if (stopped) return;

      if (!result?.token) {
        onStatus('error');
        pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
        return;
      }

      emitInitialMessages(result);
      continuation = result.token;
      if (usePagePoll) {
        pageRefreshLoop();
      } else {
        pollLoop();
      }
    } else {
      onStatus('offline');
      if (!stopped) pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
    }
  }

  // --- Init retry (manual override) ---

  async function initRetry() {
    if (stopped) return;
    onStatus('live', videoId);
    const result = await getInitialData(videoId);
    if (stopped) return;
    if (!result?.token) {
      onStatus('error');
      if (!stopped) pollTimer = setTimeout(() => initRetry(), DISCOVERY_RETRY_MS);
      return;
    }
    emitInitialMessages(result);
    continuation = result.token;
    if (usePagePoll) {
      pageRefreshLoop();
    } else {
      pollLoop();
    }
  }

  // --- Public API ---

  return {
    async init(config) {
      channelHandle = config.channelHandle ?? null;
      channelId     = config.channelId     ?? null;
      initVideoId   = config.videoId       ?? null;
      stopped = false;
      paused  = false;

      if (initVideoId) {
        // Direct video ID supplied (manual override) — skip discovery entirely.
        videoId = initVideoId;
        onStatus('live', videoId);
        const result = await getInitialData(videoId);
        if (stopped) return;
        if (!result?.token) {
          onStatus('error');
          if (!stopped) pollTimer = setTimeout(() => initRetry(), DISCOVERY_RETRY_MS);
          return;
        }
        // Seed dedup set in case we fall back to page-poll later.
        if (result.messages) {
          for (const m of result.messages) seenIds.add(m.id);
        }
        emitInitialMessages(result);
        continuation = result.token;
        pollLoop();
      } else {
        discover();
      }
    },

    pause() {
      paused = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    },

    resume() {
      if (!paused) return;
      paused = false;
      if (usePagePoll) {
        pageRefreshLoop();
      } else {
        continuation ? pollLoop() : discover();
      }
    },

    stop() {
      stopped = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }
  };
}
