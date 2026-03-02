// Service worker — adapter registry, poll lifecycle, message relay.
// Uses long-lived ports (chrome.runtime.connect) to keep the service worker
// alive during active polling and to detect tab unload automatically.

import { createAdapter } from './adapters/youtube.js';

const ADAPTER_FACTORIES = {
  youtube: createAdapter
};

// Map<portId, { port, adapters: Map<platform, adapter> }>
const sessions = new Map();

let nextPortId = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'overlay') return;

  const portId = nextPortId++;
  const adapters = new Map();
  // statusMap stores the latest { status, videoId } per platform.
  // Using a Map avoids dynamic property names on a plain object (prototype pollution risk).
  const statusMap = new Map();
  sessions.set(portId, { port, adapters, statusMap });

  port.onMessage.addListener((msg) => handleMessage(portId, msg));
  port.onDisconnect.addListener(() => teardown(portId));
});

function handleMessage(portId, msg) {
  const session = sessions.get(portId);
  if (!session) return;

  switch (msg.type) {
    case 'START_POLLING':
      startPolling(session, msg.twitchChannel, msg.platforms);
      break;
    case 'PAUSE_POLLING':
      session.adapters.forEach(a => a.pause());
      break;
    case 'RESUME_POLLING':
      session.adapters.forEach(a => a.resume());
      break;
    case 'STOP_POLLING':
      stopAdapters(session.adapters);
      break;
    case 'GET_STATUS':
      sendStatus(session, msg.twitchChannel);
      break;
  }
}

function startPolling(session, twitchChannel, platforms) {
  // Stop any existing adapters for this session before starting fresh.
  stopAdapters(session.adapters);

  for (const [platform, config] of Object.entries(platforms)) {
    const factory = ADAPTER_FACTORIES[platform];
    if (!factory) {
      console.warn(`[overlay/bg] No adapter for platform: ${platform}`);
      continue;
    }

    const adapter = factory({
      onMessages(messages) {
        safePostMessage(session.port, { type: 'CHAT_MESSAGES', platform, messages });
      },
      onStatus(status, videoId) {
        session.statusMap.set(platform, { status, videoId });
        safePostMessage(session.port, { type: 'PLATFORM_STATUS', platform, status, videoId });
      }
    });

    session.adapters.set(platform, adapter);
    adapter.init(config).catch(err => {
      console.error(`[overlay/bg] Adapter init error (${platform}):`, err);
    });
  }
}

function stopAdapters(adapters) {
  adapters.forEach(a => a.stop());
  adapters.clear();
}

function teardown(portId) {
  const session = sessions.get(portId);
  if (!session) return;
  stopAdapters(session.adapters);
  sessions.delete(portId);
}

function safePostMessage(port, msg) {
  try {
    port.postMessage(msg);
  } catch (err) {
    // Port was disconnected — teardown will handle cleanup via onDisconnect.
  }
}

function sendStatus(session, twitchChannel) {
  // Called by the popup to get a snapshot of current adapter states.
  const statuses = {};
  for (const platform of session.adapters.keys()) {
    statuses[platform] = session.statusMap.get(platform) ?? { status: 'unknown' };
  }
  safePostMessage(session.port, { type: 'STATUS_SNAPSHOT', twitchChannel, statuses });
}
