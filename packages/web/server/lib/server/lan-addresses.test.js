import { describe, expect, it } from 'vitest';

import {
  createPairingTransportResolvers,
  listLanIPv4Addresses,
  listTailscaleIPv4Addresses,
} from './lan-addresses.js';

const interfaces = {
  lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  tailscale0: [{ family: 'IPv4', internal: false, address: '100.120.83.24' }],
  wlp0s20f3: [{ family: 'IPv4', internal: false, address: '192.168.178.95' }],
};

describe('LAN pairing addresses', () => {
  it('lists non-internal IPv4 addresses and skips loopback', () => {
    expect(listLanIPv4Addresses({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
      wlan0: [{ family: 4, internal: false, address: '192.168.1.20' }],
    })).toEqual(['192.168.1.20']);
  });

  it('separates Tailscale addresses from LAN addresses', () => {
    expect(listTailscaleIPv4Addresses(interfaces)).toEqual(['100.120.83.24']);
    expect(listLanIPv4Addresses(interfaces)).toEqual(['192.168.178.95']);
  });

  it('recognizes the Windows interface name and the macOS utun tunnel', () => {
    expect(listTailscaleIPv4Addresses({
      Tailscale: [{ family: 'IPv4', internal: false, address: '100.64.0.1' }],
      utun4: [{ family: 'IPv4', internal: false, address: '100.101.2.3' }],
    })).toEqual(['100.64.0.1', '100.101.2.3']);
  });

  it('does not treat CGNAT addresses on other interfaces or non-CGNAT tunnels as Tailscale', () => {
    const carrier = {
      wwan0: [{ family: 'IPv4', internal: false, address: '100.70.1.2' }],
      utun2: [{ family: 'IPv4', internal: false, address: '10.8.0.2' }],
    };
    expect(listTailscaleIPv4Addresses(carrier)).toEqual([]);
    expect(listLanIPv4Addresses(carrier)).toEqual(['100.70.1.2', '10.8.0.2']);
  });

  it('does not advertise direct URLs while the server is loopback-only', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 2606,
      bindHost: '127.0.0.1',
      networkInterfaces: interfaces,
    });
    expect(resolvers.getPairingTransports()).toEqual({
      local: 'http://127.0.0.1:2606',
      lan: null,
      tailscale: null,
      relayAvailable: false,
    });
    expect(resolvers.getDirectCandidateUrls()).toEqual([]);
  });

  it('advertises LAN URLs from the current bind port when the server is network-exposed', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 2606,
      bindHost: '0.0.0.0',
      networkInterfaces: {
        wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
      },
    });
    expect(resolvers.getPairingTransports()).toEqual({
      local: 'http://127.0.0.1:2606',
      lan: 'http://192.168.1.20:2606',
      tailscale: null,
      relayAvailable: false,
    });
    expect(resolvers.getDirectCandidateUrls()).toEqual(['http://192.168.1.20:2606']);
  });

  it('advertises the Tailscale URL separately and lists it first for paired devices', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 39603,
      bindHost: '0.0.0.0',
      networkInterfaces: interfaces,
    });
    expect(resolvers.getPairingTransports()).toEqual({
      local: 'http://127.0.0.1:39603',
      lan: 'http://192.168.178.95:39603',
      tailscale: 'http://100.120.83.24:39603',
      relayAvailable: false,
    });
    expect(resolvers.getDirectCandidateUrls()).toEqual([
      'http://100.120.83.24:39603',
      'http://192.168.178.95:39603',
    ]);
  });
});
