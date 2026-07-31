/**
 * Canonical JSON for manifest signing.
 *
 * Must stay byte-identical to `canonicalize()` in raven-forge
 * (`src/core/updater/manifest-verify.ts`) — if the two ever drift, every
 * signature this repo produces will be rejected by the launcher.
 *
 * Rules: drop `signature`, sort object keys at every level, preserve array
 * order, no whitespace.
 */

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function canonicalize(manifest) {
  const { signature: _signature, ...rest } = manifest;
  return JSON.stringify(sortValue(rest));
}
