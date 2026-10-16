// Direct (non-relay) candidates for a Pairing v2 payload. The client tries
// candidates in ascending priority, so the primary URL is attempted before the
// fallback.

const PRIMARY_DIRECT_PRIORITY = 10;
const FALLBACK_DIRECT_PRIORITY = 20;

export const normalizeCandidateUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

const isHttpsUrl = (url) => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

const directCandidate = (url, priority) => ({
  type: isHttpsUrl(url) ? 'tunnel' : 'lan',
  url,
  priority,
});

// `primaryUrl` is the already-resolved preferred URL (normalized input or the
// request origin); `fallbackUrl` is caller-supplied and
// is dropped when invalid or identical to the primary.
export const buildDirectPairingCandidates = ({ primaryUrl, fallbackUrl } = {}) => {
  if (!primaryUrl) return [];
  const candidates = [directCandidate(primaryUrl, PRIMARY_DIRECT_PRIORITY)];
  const fallback = normalizeCandidateUrl(fallbackUrl);
  if (fallback && fallback !== primaryUrl) {
    candidates.push(directCandidate(fallback, FALLBACK_DIRECT_PRIORITY));
  }
  return candidates;
};
