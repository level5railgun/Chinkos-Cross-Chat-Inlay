// YouTube chat adapter.
// Discovers live streams via /@handle/live redirect, fetches chat via
// the continuation API, and normalizes messages to the ChatMessage interface.
//
// clientVersion and apiKey are extracted dynamically from the live_chat page
// so the adapter stays compatible with YouTube's current internal API version.

const LIVE_CHAT_API = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat';
// Fallback InnerTube web API key — extracted dynamically from the live_chat page when possible.
const FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const MIN_POLL_MS = 2000;
const FALLBACK_POLL_MS = 3000;
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

  // --- Discovery ---

  async function discoverLive() {
    if (!channelHandle && !channelId) return null;
    const url = channelHandle
      ? `https://www.youtube.com/@${channelHandle}/live`
      : `https://www.youtube.com/channel/${channelId}/live`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      console.log(`[overlay/youtube] discoverLive status=${res.status} finalUrl=${res.url}`);
      // Try redirect URL first (HTTP 302 → watch URL)
      const urlMatch = res.url.match(/[?&]v=([\w-]+)/);
      if (urlMatch) return urlMatch[1];
      // Fallback: YouTube sometimes returns 200 at the /live URL with the videoId
      // embedded in the page HTML rather than issuing an HTTP redirect.
      const html = await res.text();
      const htmlMatch = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
      console.log(`[overlay/youtube] discoverLive htmlFallback=${htmlMatch ? htmlMatch[1] : 'null'}`);
      return htmlMatch ? htmlMatch[1] : null;
    } catch (err) {
      console.warn('[overlay/youtube] discoverLive fetch error:', err.message);
      return null;
    }
  }

  // Fetches the live_chat iframe page and extracts:
  //  - the initial continuation token
  //  - INNERTUBE_CLIENT_VERSION, INNERTUBE_API_KEY, visitorData (for authenticated polls)
  //  - the initial batch of chat messages already present in ytInitialData
  async function getInitialData(vid) {
    let html;
    try {
      const res = await fetch(`https://www.youtube.com/live_chat?v=${vid}`, { credentials: 'include' });
      html = await res.text();
      console.log(`[overlay/youtube] getInitialData fetch ok status=${res.status} len=${html.length}`);
    } catch (err) {
      console.warn('[overlay/youtube] getInitialData fetch error:', err.message);
      return null;
    }

    // Extract INNERTUBE_CLIENT_VERSION and INNERTUBE_API_KEY from the page config.
    const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
    if (versionMatch) clientVersion = versionMatch[1];
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (apiKeyMatch) apiKey = apiKeyMatch[1];
    const dsMatch = html.match(/"DATASYNC_ID"\s*:\s*"([^"]+)"/);
    if (dsMatch) datasyncId = dsMatch[1];

    // Extract ytInitialData JSON.
    // YouTube's live_chat page can use several assignment forms:
    //   ytInitialData = {...}          (no var, spaces optional)
    //   var ytInitialData={...}
    //   window["ytInitialData"] = {...}
    // The closing delimiter also varies: '};\n</script>' vs '};  </script>' etc.
    const prefixMatch = html.match(/window\["ytInitialData"\]\s*=\s*|ytInitialData\s*=\s*/);
    console.log(`[overlay/youtube] getInitialData ytInitialData=${!!prefixMatch} clientVersion=${clientVersion}`);
    if (!prefixMatch) return null;

    const jsonStart = prefixMatch.index + prefixMatch[0].length;
    const remaining = html.slice(jsonStart);
    // Find the closing brace of the top-level object immediately before </script>.
    const endMatch = remaining.search(/\};?[\t\r\n ]*<\/script>/);
    console.log(`[overlay/youtube] getInitialData jsonEnd=${endMatch !== -1}`);
    if (endMatch === -1) return null;

    try {
      const data = JSON.parse(remaining.slice(0, endMatch + 1));

      // Extract visitorData — needed in every poll context to pass bot detection.
      const vd = data?.responseContext?.visitorData;
      if (vd) visitorData = vd;

      const continuations = data?.contents?.liveChatRenderer?.continuations;
      console.log(`[overlay/youtube] getInitialData hasContinuations=${Array.isArray(continuations)} count=${continuations?.length}`);
      const token = extractContinuationToken(continuations);
      console.log(`[overlay/youtube] getInitialData token=${token ? token.slice(0, 20) + '…' : 'null'}`);

      // Surface the initial batch of messages that are already baked into the page.
      const initialActions = data?.contents?.liveChatRenderer?.actions ?? [];
      const initialMessages = initialActions
        .map(a => a?.addChatItemAction?.item?.liveChatTextMessageRenderer)
        .filter(Boolean)
        .map(normalizeMessage);
      if (initialMessages.length > 0) onMessages(initialMessages);

      return token;
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

  // YouTube's continuation API requires an Authorization: SAPISIDHASH header on
  // every request — the same mechanism YouTube's own web client uses.
  // The hash is SHA-1( timestamp + " " + SAPISID + " " + origin ).
  async function getSapisidHash() {
    // __Secure-3PAPISID is the HTTPS-only variant; fall back to plain SAPISID.
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

  // --- Polling ---

  function buildClientContext() {
    const client = {
      clientName: 'WEB',
      // Fall back to a recent known-good version only if discovery failed to
      // parse one — this should not happen in practice.
      clientVersion: clientVersion ?? '2.20240101',
      hl: 'en',
      gl: 'US',
      // Additional fields that YouTube's own web client includes. These help
      // pass server-side validation that checks request fingerprints.
      userAgent: navigator.userAgent,
      platform: 'DESKTOP',
      clientFormFactor: 'UNKNOWN_FORM_FACTOR',
    };
    // visitorData ties this request to the user's YouTube session, which is
    // required for the continuation API to accept the request without 403.
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
      // Makes the request look like it originated from the live_chat iframe.
      'X-Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/live_chat?v=${videoId}`,
      // Required by YouTube's InnerTube API alongside SAPISIDHASH.
      'X-Goog-AuthUser': '0',
    };
    // Include the SAPISIDHASH when the user is signed into YouTube.
    // Unsigned sessions fall back to credentials-only and may still work for
    // public streams, but auth is required to reliably pass bot detection.
    if (auth) headers['Authorization'] = auth;
    // visitorData as a header is checked by bot detection on some YouTube
    // server configurations in addition to the body context field.
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    // datasyncId ties the request to the user's delegated session. YouTube's
    // InnerTube API requires it alongside SAPISIDHASH for authenticated polls;
    // without it the server returns 403 even though the continuation token and
    // visitorData are valid.
    if (datasyncId) headers['X-Goog-PageId'] = datasyncId;

    const body = { context: buildClientContext(), continuation };
    // Include the delegated session ID so YouTube's server maps this request
    // to the authenticated user's session — mirrors YouTube's own web client.
    if (datasyncId) body.context.user = { onBehalfOfUser: datasyncId };

    const res = await fetch(`${LIVE_CHAT_API}?key=${key}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const lcc = data?.liveChatContinuation;
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

  // --- Poll loop ---

  async function pollLoop() {
    if (stopped || paused || !continuation) return;

    let timeoutMs = FALLBACK_POLL_MS;
    try {
      const { messages, nextToken, timeoutMs: t } = await fetchBatch();
      if (stopped) return;

      auth403Count = 0; // successful poll — reset consecutive error counter

      if (!nextToken) {
        // No continuation token means the stream ended.
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
      console.warn('[overlay/youtube] poll error:', err.message);

      if (err.message.includes('403') && videoId) {
        auth403Count++;
        if (auth403Count > 3) {
          // Refreshing the session hasn't helped after multiple attempts —
          // the auth issue is unresolvable here. Drop back to full discovery.
          auth403Count = 0;
          console.warn('[overlay/youtube] 403 persists after refresh — dropping to discovery');
          onStatus('error');
          if (!stopped) pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
          return;
        }
        // Re-fetch the live_chat page to obtain fresh session context
        // (continuation token, visitorData, apiKey, datasyncId).
        console.log(`[overlay/youtube] 403 (attempt ${auth403Count}) — refreshing session via getInitialData`);
        const freshToken = await getInitialData(videoId);
        if (stopped) return;
        if (freshToken) {
          continuation = freshToken;
          timeoutMs = FALLBACK_POLL_MS; // conservative delay after re-init
        } else {
          // Page fetch itself failed — drop back to full discovery.
          auth403Count = 0;
          onStatus('error');
          if (!stopped) pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
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

  // --- Discovery loop ---

  async function discover() {
    if (stopped) return;

    auth403Count = 0; // fresh discovery attempt — reset error counter

    // No channel handle or ID available means we were started with a direct videoId that
    // has since gone offline. Cannot rediscover — stop here.
    if (!channelHandle && !channelId) {
      onStatus('offline');
      return;
    }

    const vid = await discoverLive();
    if (stopped) return;

    if (vid) {
      videoId = vid;
      onStatus('live', vid);

      const token = await getInitialData(vid);
      if (stopped) return;

      if (!token) {
        onStatus('error');
        pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
        return;
      }

      continuation = token;
      pollLoop();
    } else {
      onStatus('offline');
      if (!stopped) pollTimer = setTimeout(discover, DISCOVERY_RETRY_MS);
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
        // Dev override: direct video ID supplied — skip discovery entirely.
        videoId = initVideoId;
        onStatus('live', videoId);
        const token = await getInitialData(videoId);
        if (stopped) return;
        if (!token) { onStatus('error'); return; }
        continuation = token;
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
      continuation ? pollLoop() : discover();
    },

    stop() {
      stopped = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }
  };
}
