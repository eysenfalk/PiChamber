// Transport choice of the create-device dialog: which URL a pairing code
// advertises first and which one the device tries next.

export type AddDeviceTransport = 'tailscale' | 'lan' | 'local';

export interface PairingTransportOptions {
  localUrl: string | null;
  lanUrl: string | null;
  tailscaleUrl: string | null;
}

interface PairingTransportRequest {
  serverUrl: string;
  fallbackServerUrl?: string;
}

// Tailscale reaches the device at home and away, so it wins whenever the
// server is on a tailnet.
export const defaultAddDeviceTransport = (options: PairingTransportOptions): AddDeviceTransport =>
  options.tailscaleUrl ? 'tailscale' : options.lanUrl ? 'lan' : 'local';

// Returns null when the chosen transport has no URL. Never substitute the
// request origin: the desktop UI reaches its server over loopback, which
// another device cannot scan. The Wi-Fi fallback only applies behind Tailscale.
export const buildPairingTransportRequest = (
  options: PairingTransportOptions,
  transport: AddDeviceTransport,
  includeWifiFallback: boolean,
): PairingTransportRequest | null => {
  const serverUrl = {
    tailscale: options.tailscaleUrl,
    lan: options.lanUrl,
    local: options.localUrl,
  }[transport];
  if (!serverUrl) return null;
  if (transport === 'tailscale' && includeWifiFallback && options.lanUrl) {
    return { serverUrl, fallbackServerUrl: options.lanUrl };
  }
  return { serverUrl };
};
