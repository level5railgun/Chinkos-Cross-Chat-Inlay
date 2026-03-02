// Popup script — shows current channel status and session-level toggle.
// Depends on: config/streamers.js (loaded before this script in popup.html)

const root = document.getElementById('root');

// Only these values are valid — guard against injection via the messaging pipeline.
const VALID_STATUSES = new Set(['live', 'offline', 'error', 'unknown']);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';

  // Determine if we're on a Twitch channel page.
  const twitchMatch = url.match(/^https:\/\/www\.twitch\.tv\/([^/?#]+)/);
  const channel = twitchMatch ? twitchMatch[1].toLowerCase() : null;

  // STREAMERS is defined by config/streamers.js loaded before this script.
  const streamerConfig = channel ? STREAMERS[channel] : null;

  if (!streamerConfig) {
    // Use DOM methods — channel comes from a URL and must not be interpolated
    // into innerHTML directly.
    const p = document.createElement('p');
    p.className = 'not-enrolled';
    if (channel) {
      const strong = document.createElement('strong');
      strong.textContent = `/${channel}`;
      p.appendChild(strong);
      p.appendChild(document.createTextNode(' is not enrolled in the overlay.'));
    } else {
      p.textContent = 'Open a Twitch channel to use the overlay.';
    }
    root.appendChild(p);
    return;
  }

  // Build the static scaffold via innerHTML (no user data in this block),
  // then set the channel name safely via textContent.
  root.innerHTML = `
    <div class="channel-row">
      Watching <span id="channel-name-display" class="channel-name"></span>
    </div>
    <div id="platforms"></div>
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

  // Render platform status placeholders and ask the content script for status.
  const platformsEl = document.getElementById('platforms');
  for (const platform of Object.keys(streamerConfig.platforms)) {
    platformsEl.appendChild(buildPlatformRow(platform, { status: 'unknown' }));
  }

  // Request a status snapshot from the content script in the active tab.
  if (tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (response?.statuses) {
        for (const [platform, statusInfo] of Object.entries(response.statuses)) {
          updatePlatformRow(platform, statusInfo);
        }
      }
    } catch {
      // Content script may not be active yet (e.g. page still loading).
    }
  }

  // Dev override section — always visible on enrolled channels.
  await renderDevOverride(root);
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
  // label    — derived from hardcoded STREAMERS keys, safe.
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

function updatePlatformRow(platform, statusInfo) {
  const existing = document.getElementById(`platform-${platform}`);
  if (!existing) return;
  existing.replaceWith(buildPlatformRow(platform, statusInfo));
}

function formatStatus(status) {
  return { live: 'Live', offline: 'Offline', error: 'Error', unknown: '…' }[status] ?? status;
}

// ---------------------------------------------------------------------------
// Dev override
// ---------------------------------------------------------------------------

// Parses a freeform YouTube input into a platform config suitable for
// START_POLLING. Accepts:
//   - Channel handle:  @SHIRASESHIRAKAWA  |  SHIRASESHIRAKAWA
//   - Channel URL:     https://www.youtube.com/@SHIRASESHIRAKAWA
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

  // Channel URL or bare handle → extract handle (strip leading @, URL prefix)
  const handleMatch = s.match(/(?:youtube\.com\/@?|^@?)([\w.-]{3,30})(?:\/|$)/);
  if (handleMatch && handleMatch[1]) {
    return { platforms: { youtube: { channelHandle: handleMatch[1] } } };
  }

  return null;
}

async function renderDevOverride(container) {
  const result = await chrome.storage.session.get(['devOverride']).catch(() => ({}));
  const current = result?.devOverride; // null/undefined = no override active

  const section = document.createElement('div');
  section.className = 'dev-section';
  section.innerHTML = `
    <div class="dev-heading">⚙ Dev Override</div>
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

  const input      = section.querySelector('#dev-input');
  const setBtn     = section.querySelector('#dev-set');
  const activeRow  = section.querySelector('#dev-active-row');
  const activeLabel = section.querySelector('#dev-active-label');
  const clearBtn   = section.querySelector('#dev-clear');
  const errorEl    = section.querySelector('#dev-error');

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

    chrome.storage.session.set({ devOverride: { raw, ...parsed } }, () => {
      input.value = '';
      showActive(raw);
    });
  });

  // Allow pressing Enter in the input field to set the override.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setBtn.click();
  });

  clearBtn.addEventListener('click', () => {
    chrome.storage.session.remove('devOverride', () => {
      hideActive();
      input.value = '';
      errorEl.style.display = 'none';
    });
  });
}

init();
