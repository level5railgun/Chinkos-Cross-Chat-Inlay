// Popup script — shows current channel status and session-level toggle.

const root = document.getElementById('root');

// Only these values are valid — guard against injection via the messaging pipeline.
const VALID_STATUSES = new Set(['live', 'offline', 'error', 'unknown']);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';

  // Determine if we're on a Twitch channel page.
  const twitchMatch = url.match(/^https:\/\/www\.twitch\.tv\/([^/?#]+)/);
  const channel = twitchMatch ? twitchMatch[1].toLowerCase() : null;

  if (!channel) {
    const p = document.createElement('p');
    p.className = 'not-enrolled';
    p.textContent = 'Open a Twitch channel to use the overlay.';
    root.appendChild(p);
    return;
  }

  // Build the static scaffold via innerHTML (no user data in this block),
  // then set the channel name safely via textContent.
  root.innerHTML = `
    <div class="channel-row">
      Watching <span id="channel-name-display" class="channel-name"></span>
    </div>
    <div id="status-area"></div>
    <div class="toggle-row">
      <span class="toggle-label">Overlay enabled</span>
      <label class="switch">
        <input type="checkbox" id="toggle" checked />
        <span class="slider"></span>
      </label>
    </div>
  `;
  document.getElementById('channel-name-display').textContent = `twitch.tv/${channel}`;

  // Restore toggle state from session storage.
  chrome.storage.session.get(['overlayEnabled'], (result) => {
    if (chrome.runtime.lastError || !result) return;
    const enabled = result.overlayEnabled !== false;
    document.getElementById('toggle').checked = enabled;
  });

  document.getElementById('toggle').addEventListener('change', (e) => {
    chrome.storage.session.set({ overlayEnabled: e.target.checked });
  });

  const statusArea = document.getElementById('status-area');

  // Request a status snapshot from the content script in the active tab.
  let discoveryState = null;
  let statuses = null;
  if (tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (response) {
        discoveryState = response.discoveryState ?? null;
        statuses = response.statuses ?? null;
      }
    } catch {
      // Content script may not be active yet (e.g. page still loading).
    }
  }

  if (discoveryState === 'found' && statuses) {
    // Show platform status rows
    const platformsEl = document.createElement('div');
    platformsEl.id = 'platforms';
    for (const [platform, statusInfo] of Object.entries(statuses)) {
      platformsEl.appendChild(buildPlatformRow(platform, statusInfo));
    }
    // If no statuses yet (polling just started), show a placeholder for youtube
    if (Object.keys(statuses).length === 0) {
      platformsEl.appendChild(buildPlatformRow('youtube', { status: 'unknown' }));
    }
    statusArea.appendChild(platformsEl);
  } else if (discoveryState === 'scanning' || discoveryState === null) {
    const p = document.createElement('p');
    p.className = 'discovery-msg';
    p.textContent = discoveryState === 'scanning'
      ? 'Scanning for YouTube channel on this page…'
      : 'Connecting…';
    statusArea.appendChild(p);
  } else if (discoveryState === 'not_found') {
    const p = document.createElement('p');
    p.className = 'discovery-msg';
    p.textContent = 'No YouTube channel found on this page.';
    statusArea.appendChild(p);
  }

  // Manual override section — always shown when on a Twitch channel.
  await renderManualOverride(root);
}

function buildPlatformRow(platform, statusInfo) {
  const row = document.createElement('div');
  row.className = 'platform-status';
  row.id = `platform-${platform}`;

  const iconUrl = chrome.runtime.getURL(`assets/icons/${platform}.png`);
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  const { videoId } = statusInfo;

  // Whitelist status before embedding as a CSS class name.
  const status = VALID_STATUSES.has(statusInfo.status) ? statusInfo.status : 'unknown';

  // iconUrl  — chrome.runtime.getURL(), extension-controlled, safe.
  // label    — derived from known platform keys, safe.
  // status   — whitelisted above, safe.
  // videoId  — validated as [\w-]+ by the YouTube adapter's regex, safe.
  row.innerHTML = `
    <img src="${iconUrl}" alt="${label}" />
    <span class="status-dot ${status}"></span>
    <span class="status-label">${label} — ${formatStatus(status)}</span>
    ${videoId ? `<a class="status-link" href="https://www.youtube.com/watch?v=${videoId}" target="_blank">Watch →</a>` : ''}
  `;
  return row;
}

function formatStatus(status) {
  return { live: 'Live', offline: 'Offline', error: 'Error', unknown: '…' }[status] ?? status;
}

// ---------------------------------------------------------------------------
// Manual override
// ---------------------------------------------------------------------------

// Parses a freeform YouTube input into a platform config suitable for
// START_POLLING. Accepts:
//   - Channel handle:  @SHIRASESHIRAKAWA  |  SHIRASESHIRAKAWA
//   - Channel URL:     https://www.youtube.com/@SHIRASESHIRAKAWA
//   - Channel URL:     https://www.youtube.com/channel/UCxxxx
//   - Watch URL:       https://www.youtube.com/watch?v=VIDEO_ID
//   - Short URL:       https://youtu.be/VIDEO_ID
function parseYouTubeInput(raw) {
  const s = raw.trim();
  if (!s) return null;

  // Watch URL or short URL → extract video ID (11-char alphanumeric)
  const videoMatch = s.match(/(?:[?&]v=|youtu\.be\/)([\w-]{11})(?:[&?#]|$)/);
  if (videoMatch) {
    return { platforms: { youtube: { videoId: videoMatch[1] } } };
  }

  // /channel/UCxxxx URL → extract channel ID
  const channelIdMatch = s.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  if (channelIdMatch) {
    return { platforms: { youtube: { channelId: channelIdMatch[1] } } };
  }

  // Channel URL or bare handle → extract handle (strip leading @, URL prefix)
  const handleMatch = s.match(/(?:youtube\.com\/@?|^@?)([\w.-]{3,30})(?:\/|$)/);
  if (handleMatch && handleMatch[1]) {
    return { platforms: { youtube: { channelHandle: handleMatch[1] } } };
  }

  return null;
}

async function renderManualOverride(container) {
  const result = await chrome.storage.session.get(['manualOverride']).catch(() => ({}));
  const current = result?.manualOverride; // null/undefined = no override active

  const section = document.createElement('div');
  section.className = 'dev-section';
  section.innerHTML = `
    <div class="dev-heading">Manual Override</div>
    <div class="dev-platform-label">YouTube channel or video URL</div>
    <div class="dev-input-row">
      <input class="dev-input" id="dev-input" type="text"
             placeholder="@handle or youtube.com/watch?v=…" />
      <button class="dev-btn" id="dev-set">Set</button>
    </div>
    <div id="dev-active-row" style="display:none" class="dev-active">
      <span class="dev-active-label" id="dev-active-label"></span>
      <button class="dev-clear" id="dev-clear" title="Clear override">✕ Clear</button>
    </div>
    <div id="dev-error" class="dev-error" style="display:none"></div>
  `;
  container.appendChild(section);

  const input       = section.querySelector('#dev-input');
  const setBtn      = section.querySelector('#dev-set');
  const activeRow   = section.querySelector('#dev-active-row');
  const activeLabel = section.querySelector('#dev-active-label');
  const clearBtn    = section.querySelector('#dev-clear');
  const errorEl     = section.querySelector('#dev-error');

  function showActive(raw) {
    activeLabel.textContent = `Active: ${raw}`;
    activeRow.style.display = 'flex';
    errorEl.style.display = 'none';
  }

  function hideActive() {
    activeRow.style.display = 'none';
  }

  // Restore current override state into the UI.
  if (current?.raw) showActive(current.raw);

  setBtn.addEventListener('click', () => {
    const raw = input.value.trim();
    if (!raw) return;

    const parsed = parseYouTubeInput(raw);
    if (!parsed) {
      errorEl.textContent = 'Could not parse — try @handle or a watch URL.';
      errorEl.style.display = 'block';
      return;
    }

    chrome.storage.session.set({ manualOverride: { raw, ...parsed } }, () => {
      input.value = '';
      showActive(raw);
    });
  });

  // Allow pressing Enter in the input field to set the override.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setBtn.click();
  });

  clearBtn.addEventListener('click', () => {
    chrome.storage.session.remove('manualOverride', () => {
      hideActive();
      input.value = '';
      errorEl.style.display = 'none';
    });
  });
}

init();
