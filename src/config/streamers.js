// Hardcoded allowlist of opted-in streamers.
// Adding a new streamer: add an entry with twitch channel name as key.
// Adding a new platform: add to the platforms object with adapter config.

const STREAMERS = {
  pachi: {
    twitch: 'pachi',
    platforms: {
      youtube: { channelHandle: 'pachikko_' }
    }
  },
  kumomomomomomomo: {
    twitch: 'kumomomomomomomo',
    platforms: {
      youtube: { channelHandle: 'kumomomomomo'}
    }
  }
};
