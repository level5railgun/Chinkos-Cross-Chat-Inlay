# Chinko's Cross Chat Inlay

A Chrome extension that inlays YouTube live chat messages directly into Twitch chat for multiplatform streamers.

When a streamer is live on both Twitch and YouTube, their YouTube chat messages appear inline alongside native Twitch chat.
This includes display names, member badges, and emojis. A banner links to the YouTube stream when active.

## Installation

### From Chrome Web Store
[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/chinkos-cross-chat-inlay/naflpgbmlcipnkalfgjomdmmhciibmlb)

### From Github
1. Download or clone this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder
5. Navigate to any Twitch channel. The overlay activates automatically if a YouTube link is found

## Usage

Once installed, the extension runs automatically on any Twitch channel page.

- The extension scans the streamer's Twitch page panels for a linked YouTube channel
- If found, YouTube chat messages appear in Twitch chat with a YouTube icon badge
- An "Also live on YouTube" banner appears at the top of chat with a link to the stream
- Use the extension popup to toggle the overlay on or off

## Auto-Detection

The extension automatically activates on any Twitch channel that links their YouTube in their Twitch panels (the About/Info section below the stream). No configuration or allowlist required.

## Manual Override

If auto-detection doesn't find a YouTube link (e.g. the streamer hasn't linked their YouTube in their Twitch panels), you can enter a YouTube channel or video URL manually in the extension popup's **Manual Override** field.

Accepted formats:
- `@handle` or bare handle name
- `https://www.youtube.com/@handle`
- `https://www.youtube.com/channel/UCxxxx`
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`

## Privacy

This extension does not collect, store, or transmit any personal data. See the full [Privacy Policy](privacy-policy.md).
