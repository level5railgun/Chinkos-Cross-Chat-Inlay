# Chinko's Cross Chat Inlay — Privacy Policy

**Last updated:** March 12, 2026

## Data Collection

Chinko's Cross Chat Inlay does not collect, store, or transmit any personal data.

## How the Extension Works

The extension automatically activates on any visited Twitch channel page by scanning for a YouTube channel link in the streamer's public panel/about section. This scan is performed entirely within the browser; no link data is collected, stored, or transmitted.

When a YouTube channel link is found (or a Manual Override is set), the extension fetches publicly available YouTube live chat messages and displays them inline within the Twitch chat interface.

- **YouTube session cookie (SAPISID):** Read locally to authenticate requests to
  YouTube's live chat API. The cookie value is hashed in-memory and sent
  only to youtube.com as an authorization header. It is never stored, logged, or
  transmitted elsewhere.
- **chrome.storage.session:** Used to persist UI preferences (overlay toggle state,
  manual override) for the current browser session only. No user data is written to
  persistent storage.

## Third-Party Services

The extension communicates exclusively with:
- **youtube.com** — to fetch live chat data
- **twitch.tv** — content script runs on Twitch pages to inject chat messages into the DOM

No data is sent to any other server, analytics service, or third party.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

For questions, message me on Discord: @chikun

Join my partner's community on Discord: https://discord.gg/CcnWJDkBVa
