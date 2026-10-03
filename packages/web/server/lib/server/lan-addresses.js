import os from 'node:os';

import { isNetworkExposedBindHost } from '../security/bind-host.js';

const isIpv4Family = (family) => family === 'IPv4' || family === 4;

// Tailscale assigns node addresses from the CGNAT range 100.64.0.0/10.
const isCgnatIPv4 = (address) => {
  const [first, second] = address.split('.').map((part) => Number.parseInt(part, 10));
  return first === 100 && second >= 64 && second <= 127;
};

// Linux names the interface `tailscale0` and Windows `Tailscale`; the macOS app
// uses a generic `utunN` tunnel, so there the CGNAT address identifies it. A
// CGNAT address on any other interface (e.g. a carrier modem) is not Tailscale.
const isTailscaleInterface = (name, address) =>
  /tailscale/i.test(name) || (/^utun\d*$/i.test(name) && isCgnatIPv4(address));

const listDirectIPv4Addresses = (networkInterfaces) => {
  const entries = [];
  const seen = new Set();
  for (const [name, interfaceEntries] of Object.entries(networkInterfaces || {})) {
    for (const entry of interfaceEntries || []) {
      if (!isIpv4Family(entry.family) || entry.internal || typeof entry.address !== 'string') continue;
      if (entry.address === '0.0.0.0' || entry.address.startsWith('127.')) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      entries.push({ address: entry.address, tailscale: isTailscaleInterface(name, entry.address) });
    }
  }
  return entries;
};

export const listLanIPv4Addresses = (networkInterfaces = os.networkInterfaces()) =>
  listDirectIPv4Addresses(networkInterfaces).filter((entry) => !entry.tailscale).map((entry) => entry.address);

export const listTailscaleIPv4Addresses = (networkInterfaces = os.networkInterfaces()) =>
  listDirectIPv4Addresses(networkInterfaces).filter((entry) => entry.tailscale).map((entry) => entry.address);

const formatHostForUrl = (host) => (host.includes(':') ? `[${host}]` : host);

export const createPairingTransportResolvers = ({ getPort, bindHost, networkInterfaces } = {}) => {
  const localUrl = () => {
    const port = getPort();
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
  };

  // Interfaces are read on every call: Tailscale and Wi-Fi come and go while
  // the server runs.
  const directUrls = (listAddresses) => {
    const port = getPort();
    if (!Number.isInteger(port) || port <= 0 || !isNetworkExposedBindHost(bindHost)) return [];
    return listAddresses(networkInterfaces).map((ip) => `http://${formatHostForUrl(ip)}:${port}`);
  };
  const lanUrls = () => directUrls(listLanIPv4Addresses);
  const tailscaleUrls = () => directUrls(listTailscaleIPv4Addresses);

  return {
    getPairingTransports: () => ({
      local: localUrl(),
      lan: lanUrls()[0] ?? null,
      tailscale: tailscaleUrls()[0] ?? null,
      relayAvailable: false,
    }),
    // Tailscale first: it is the preferred transport for paired devices.
    getDirectCandidateUrls: () => [...tailscaleUrls(), ...lanUrls()],
  };
};
