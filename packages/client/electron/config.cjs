// Shared by the main process and (by value, checked in navigation.test.cjs) the renderer.
// Change the production server address here and in src/api-client.ts together.
const DEFAULT_API_ORIGIN = 'https://tendril.hokora.xyz';

/** The API origin the desktop app trusts: an https override, else the default. */
function apiOrigin(override = process.env.TENDRIL_API_ORIGIN) {
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
    } catch { /* fall through to the default */ }
  }
  return DEFAULT_API_ORIGIN;
}

module.exports = { DEFAULT_API_ORIGIN, apiOrigin };
