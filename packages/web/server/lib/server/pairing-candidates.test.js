import { describe, expect, it } from 'vitest';

import { buildDirectPairingCandidates, normalizeCandidateUrl } from './pairing-candidates.js';

describe('pairing direct candidates', () => {
  it('normalizes http(s) URLs and rejects other schemes', () => {
    expect(normalizeCandidateUrl(' http://100.120.83.24:39603/?x=1#y ')).toBe('http://100.120.83.24:39603');
    expect(normalizeCandidateUrl('relay://abc')).toBeNull();
    expect(normalizeCandidateUrl('')).toBeNull();
    expect(normalizeCandidateUrl(undefined)).toBeNull();
  });

  it('returns no candidates without a primary URL', () => {
    expect(buildDirectPairingCandidates({ primaryUrl: null, fallbackUrl: 'http://192.168.1.2:1' })).toEqual([]);
  });

  it('orders the fallback after the primary URL', () => {
    expect(buildDirectPairingCandidates({
      primaryUrl: 'http://100.120.83.24:39603',
      fallbackUrl: 'http://192.168.178.95:39603/',
    })).toEqual([
      { type: 'lan', url: 'http://100.120.83.24:39603', priority: 10 },
      { type: 'lan', url: 'http://192.168.178.95:39603', priority: 20 },
    ]);
  });

  it('drops an invalid or duplicate fallback', () => {
    const primaryUrl = 'http://100.120.83.24:39603';
    const only = [{ type: 'lan', url: primaryUrl, priority: 10 }];
    expect(buildDirectPairingCandidates({ primaryUrl, fallbackUrl: 'javascript:alert(1)' })).toEqual(only);
    expect(buildDirectPairingCandidates({ primaryUrl, fallbackUrl: `${primaryUrl}/` })).toEqual(only);
    expect(buildDirectPairingCandidates({ primaryUrl })).toEqual(only);
  });

  it('marks https URLs as tunnel candidates', () => {
    expect(buildDirectPairingCandidates({ primaryUrl: 'https://chamber.example.com' })).toEqual([
      { type: 'tunnel', url: 'https://chamber.example.com', priority: 10 },
    ]);
  });
});
