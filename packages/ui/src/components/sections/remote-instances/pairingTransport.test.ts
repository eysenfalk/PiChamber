import { describe, expect, test } from 'bun:test';

import { buildPairingTransportRequest, defaultAddDeviceTransport } from './pairingTransport';

const local = 'http://127.0.0.1:2606';
const lan = 'http://192.168.178.95:2606';
const tailscale = 'http://100.120.83.24:2606';

describe('defaultAddDeviceTransport', () => {
  test('prefers Tailscale, then the home network, then this computer', () => {
    expect(defaultAddDeviceTransport({ localUrl: local, lanUrl: lan, tailscaleUrl: tailscale })).toBe('tailscale');
    expect(defaultAddDeviceTransport({ localUrl: local, lanUrl: lan, tailscaleUrl: null })).toBe('lan');
    expect(defaultAddDeviceTransport({ localUrl: local, lanUrl: null, tailscaleUrl: null })).toBe('local');
  });
});

describe('buildPairingTransportRequest', () => {
  const all = { localUrl: local, lanUrl: lan, tailscaleUrl: tailscale };

  test('Tailscale with the Wi-Fi fallback advertises the LAN URL second', () => {
    expect(buildPairingTransportRequest(all, 'tailscale', true)).toEqual({
      serverUrl: tailscale,
      fallbackServerUrl: lan,
    });
  });

  test('Tailscale without the fallback advertises only the Tailscale URL', () => {
    expect(buildPairingTransportRequest(all, 'tailscale', false)).toEqual({ serverUrl: tailscale });
  });

  test('the fallback is dropped when the server has no LAN URL', () => {
    expect(buildPairingTransportRequest({ ...all, lanUrl: null }, 'tailscale', true)).toEqual({
      serverUrl: tailscale,
    });
  });

  test('home network and this computer never carry a fallback', () => {
    expect(buildPairingTransportRequest(all, 'lan', true)).toEqual({ serverUrl: lan });
    expect(buildPairingTransportRequest(all, 'local', true)).toEqual({ serverUrl: local });
  });

  test('an unavailable transport yields no request instead of another URL', () => {
    expect(buildPairingTransportRequest({ ...all, tailscaleUrl: null }, 'tailscale', true)).toBeNull();
    expect(buildPairingTransportRequest({ ...all, lanUrl: null }, 'lan', false)).toBeNull();
  });
});
