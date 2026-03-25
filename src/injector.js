// Injector — builds and inserts synthetic Twitch-style chat nodes.
// Runs in the content script isolated world.
// Depends on: nothing (standalone, no imports needed)

const PLATFORM_COLORS = {
  youtube: '#FF0000'
};

// Dedup buffer — only IDs are kept, full message objects are discarded after injection.
const seenIds = new Set();
const MAX_SEEN = 500;

// Track injected rows for mirror-pruning.
let injectedCount = 0;

function recordSeen(id) {
  if (seenIds.size >= MAX_SEEN) {
    // Evict oldest entry (Sets preserve insertion order).
    seenIds.delete(seenIds.values().next().value);
  }
  seenIds.add(id);
}

// Twitch chat selectors — primary is native Twitch, fallbacks cover third-party
// extensions (BTTV, FFZ, 7TV) that replace or wrap the chat container.
const SCROLL_CONTAINER_SELECTORS = [
  '[data-a-target="chat-scroller"]',
  '.chat-scrollable-area__message-container',
  '.chat-list--default',
  '.chat-list--other',
  '.chat-list',
];

const CHAT_LOG_SELECTORS = [
  '[data-a-target="chat-scroller"] [role="log"]',
  '.chat-scrollable-area__message-container [role="log"]',
  '.chat-list--default [role="log"]',
  '.chat-list--other [role="log"]',
  '.chat-list [role="log"]',
  '[role="log"]',
];

function getScrollContainer() {
  for (const sel of SCROLL_CONTAINER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function getChatLog() {
  for (const sel of CHAT_LOG_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function isPinnedToBottom(container) {
  if (!container) return true;
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
}

function scrollToBottom(container) {
  if (container) container.scrollTop = container.scrollHeight;
}

// --- DOM builders ---

function buildPlatformBadge(platform) {
  const span = document.createElement('span');
  span.className = 'ext-platform-badge';
  span.title = platform.charAt(0).toUpperCase() + platform.slice(1);

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL(`assets/icons/${platform}.svg`);
  img.alt = span.title;
  span.appendChild(img);
  return span;
}

function buildMemberBadge({ imageUrl, label }) {
  const span = document.createElement('span');
  span.className = 'chat-badge';
  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = label;
  span.appendChild(img);
  return span;
}

function buildMessageBody(parts) {
  const span = document.createElement('span');
  span.className = 'message';
  for (const part of parts) {
    if (part.type === 'text') {
      span.appendChild(document.createTextNode(part.text));
    } else if (part.type === 'emoji') {
      const img = document.createElement('img');
      img.className = 'chat-image';
      img.src = part.imageUrl;
      img.alt = part.alt;
      span.appendChild(img);
    }
  }
  return span;
}

function buildChatRow(msg) {
  const row = document.createElement('div');
  row.className = 'ext-chat-line';
  row.dataset.extPlatform = msg.platform;
  row.dataset.extId = msg.id;

  // 1. Platform source badge
  row.appendChild(buildPlatformBadge(msg.platform));

  // 2. Member/subscriber badges from source platform
  for (const badge of msg.badges) {
    row.appendChild(buildMemberBadge(badge));
  }

  // 3. Username
  const nameBtn = document.createElement('button');
  nameBtn.className = 'chat-author__display-name';
  nameBtn.style.color = PLATFORM_COLORS[msg.platform] ?? '#FFFFFF';
  nameBtn.textContent = msg.displayName;
  row.appendChild(nameBtn);

  row.appendChild(document.createTextNode(': '));

  // 4. Message body
  row.appendChild(buildMessageBody(msg.parts));

  return row;
}

// --- Public API ---

function insertMessages(messages) {
  const log = getChatLog();
  if (!log) return;

  const container = getScrollContainer();
  const pinned = isPinnedToBottom(container);

  for (const msg of messages) {
    if (!msg.id || seenIds.has(msg.id)) continue;
    recordSeen(msg.id);

    const row = buildChatRow(msg);
    log.appendChild(row);
    injectedCount++;
  }

  if (pinned) scrollToBottom(container);
}

// Called by the content script's MutationObserver when Twitch prunes native rows.
// We mirror-prune the same number of injected rows from the oldest end.
function pruneInjected(count) {
  if (count <= 0) return;
  const log = getChatLog();
  if (!log) return;

  let removed = 0;
  const rows = log.querySelectorAll('[data-ext-platform]');
  for (const row of rows) {
    if (removed >= count) break;
    row.remove();
    injectedCount--;
    removed++;
  }
}

function showLiveBanner(platform, videoId) {
  hideLiveBanner(platform); // remove stale banner if present

  const log = getChatLog();
  if (!log) return;

  const banner = document.createElement('div');
  banner.className = 'ext-live-banner';
  banner.dataset.extPlatform = platform;

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL(`assets/icons/${platform}.svg`);
  img.alt = platform.charAt(0).toUpperCase() + platform.slice(1);
  banner.appendChild(img);

  const label = document.createElement('span');
  label.textContent = `Also live on ${platform.charAt(0).toUpperCase() + platform.slice(1)}`;
  banner.appendChild(label);

  if (videoId) {
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${videoId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '→';
    banner.appendChild(link);
  }

  // Insert as a pinned element above the message list.
  const scroller = getScrollContainer();
  if (scroller) {
    scroller.insertAdjacentElement('beforebegin', banner);
  } else {
    log.insertAdjacentElement('beforebegin', banner);
  }
}

function hideLiveBanner(platform) {
  const existing = document.querySelector(`.ext-live-banner[data-ext-platform="${platform}"]`);
  if (existing) existing.remove();
}
