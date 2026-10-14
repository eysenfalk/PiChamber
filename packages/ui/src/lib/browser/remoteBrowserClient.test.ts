import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  RemoteBrowserClient,
  fetchRemoteBrowserAvailability,
  reconnectDelayMs,
  type RemoteBrowserConnection,
  type RemoteBrowserListener,
  type RemoteBrowserPageState,
  type RemoteBrowserSocketDeps,
} from "./remoteBrowserClient"
import type { RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"

// Self-contained: sockets, tokens and timers are injected, and the status
// fetch stubs globalThis.fetch. No mock.module, so this file is safe under
// `bun test --isolate`.

class FakeSocket {
  readyState = 0
  binaryType: "blob" | "arraybuffer" | undefined = undefined
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code, reason: "" })
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const setup = (options: { onFrame?: RemoteBrowserListener["onFrame"] } = {}) => {
  const sockets: FakeSocket[] = []
  const tokens: Array<string | null | undefined> = []
  const cleared: Array<string | null | undefined> = []
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = []
  const connections: RemoteBrowserConnection[] = []
  const states: RemoteBrowserPageState[] = []
  const frames: ArrayBuffer[] = []
  let tokenCount = 0
  const deps: RemoteBrowserSocketDeps = {
    refreshToken: async () => `token-${++tokenCount}`,
    clearToken: (token) => { cleared.push(token) },
    openSocket: (token) => {
      tokens.push(token)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as RelayTunnelWebSocket
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { (timer as { cancelled: boolean }).cancelled = true },
  }
  const client = new RemoteBrowserClient({
    onConnection: (connection) => { connections.push(connection) },
    onFrame: options.onFrame ?? ((jpeg) => { frames.push(jpeg) }),
    onPageState: (state) => { states.push(state) },
    onNotice: () => undefined,
  }, deps)
  const fireTimer = async (): Promise<void> => {
    const timer = timers.find((entry) => !entry.cancelled)
    if (!timer) throw new Error("no pending timer")
    timer.cancelled = true
    timer.callback()
    await flush()
  }
  return { client, sockets, tokens, cleared, timers, connections, states, frames, fireTimer }
}

describe("RemoteBrowserClient", () => {
  test("opens the socket with a fresh URL token and sends the viewport once open", async () => {
    const rig = setup()
    rig.client.setViewport(390.4, 50)
    rig.client.start()
    await flush()
    expect(rig.tokens).toEqual(["token-1"])
    expect(rig.sockets[0].binaryType).toBe("arraybuffer")
    expect(rig.sockets[0].sent).toEqual([])
    rig.sockets[0].open()
    expect(rig.sockets[0].sent).toEqual([{ type: "resize", width: 390, height: 100 }])
    expect(rig.connections).toEqual(["connecting", "open"])
  })

  test("acknowledges a frame only after it was drawn, also when drawing failed", async () => {
    let release: () => void = () => undefined
    let calls = 0
    const rig = setup({
      onFrame: () => {
        calls += 1
        if (calls === 1) return new Promise<void>((resolve) => { release = resolve })
        throw new Error("decode failed")
      },
    })
    rig.client.start()
    await flush()
    const socket = rig.sockets[0]
    socket.open()
    socket.onmessage?.({ data: new ArrayBuffer(4) })
    await flush()
    expect(socket.sent).toEqual([])
    release()
    await flush()
    expect(socket.sent).toEqual([{ type: "ack" }])
    socket.onmessage?.({ data: new ArrayBuffer(4) })
    await flush()
    expect(socket.sent).toEqual([{ type: "ack" }, { type: "ack" }])
  })

  test("reads page state and ignores malformed text", async () => {
    const rig = setup()
    rig.client.start()
    await flush()
    const socket = rig.sockets[0]
    socket.open()
    socket.onmessage?.({ data: "not json" })
    socket.onmessage?.({ data: JSON.stringify({ type: "state", url: "https://intra.example/", title: "Intra", canGoBack: true, loading: 1 }) })
    expect(rig.states).toEqual([{ url: "https://intra.example/", title: "Intra", canGoBack: true, canGoForward: false, loading: false }])
  })

  test("drops commands while not connected", async () => {
    const rig = setup()
    expect(rig.client.send({ type: "reload" })).toBe(false)
    rig.client.start()
    await flush()
    expect(rig.client.send({ type: "reload" })).toBe(false)
    rig.sockets[0].open()
    expect(rig.client.send({ type: "navigate", url: "https://intra.example/" })).toBe(true)
    expect(rig.sockets[0].sent).toEqual([{ type: "navigate", url: "https://intra.example/" }])
  })

  test("reconnects with growing backoff and resends the viewport", async () => {
    const rig = setup()
    rig.client.setViewport(800, 600)
    rig.client.start()
    await flush()
    rig.sockets[0].serverClose(1006)
    expect(rig.cleared).toEqual(["token-1"])
    expect(rig.timers.map((timer) => timer.ms)).toEqual([500])
    await rig.fireTimer()
    rig.sockets[1].serverClose(1006)
    expect(rig.timers.map((timer) => timer.ms)).toEqual([500, 1000])
    await rig.fireTimer()
    expect(rig.tokens).toEqual(["token-1", "token-2", "token-3"])
    rig.sockets[2].open()
    expect(rig.sockets[2].sent).toEqual([{ type: "resize", width: 800, height: 600 }])
    rig.sockets[2].serverClose(1001)
    // A successful open resets the backoff, and an opened socket keeps its token.
    expect(rig.timers.at(-1)?.ms).toBe(500)
    expect(rig.cleared).toEqual(["token-1", "token-2"])
    expect(rig.connections).toEqual(["connecting", "reconnecting", "reconnecting", "open", "reconnecting"])
  })

  test("stays closed when another viewer replaced it (4001)", async () => {
    const rig = setup()
    rig.client.start()
    await flush()
    rig.sockets[0].open()
    rig.sockets[0].serverClose(4001)
    expect(rig.timers).toEqual([])
    expect(rig.connections.at(-1)).toBe("replaced")
    rig.client.start()
    await flush()
    expect(rig.sockets).toHaveLength(2)
  })

  test("stop closes the socket and cancels a pending reconnect", async () => {
    const rig = setup()
    rig.client.start()
    await flush()
    rig.sockets[0].open()
    rig.client.stop()
    expect(rig.sockets[0].closed).toBe(true)
    expect(rig.connections.at(-1)).toBe("stopped")

    rig.client.start()
    await flush()
    rig.sockets[1].serverClose(1006)
    rig.client.stop()
    expect(rig.timers.every((timer) => timer.cancelled)).toBe(true)
    expect(rig.sockets).toHaveLength(2)
  })

  test("stop during the token refresh opens no socket", async () => {
    const rig = setup()
    rig.client.start()
    rig.client.stop()
    await flush()
    expect(rig.sockets).toEqual([])
  })

  test("backoff is capped at ten seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(reconnectDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000])
  })
})

const originalFetch = globalThis.fetch
const originalWindow = (globalThis as { window?: unknown }).window

describe("fetchRemoteBrowserAvailability", () => {
  let responder: () => Response = () => new Response(null, { status: 500 })

  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = {
      __PICHAMBER_API_BASE_URL__: "https://laptop.example",
      location: { protocol: "https:", origin: "https://laptop.example", href: "https://laptop.example/" },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    globalThis.fetch = mock(async (url: string) => {
      if (new URL(String(url), "http://localhost").pathname === "/api/browser/status") return responder()
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window
    else (globalThis as Record<string, unknown>).window = originalWindow
  })

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  test("reports the desktop host", async () => {
    responder = () => json({ available: true })
    expect(await fetchRemoteBrowserAvailability()).toBe("available")
  })

  test("reports a missing desktop app only when the server says so", async () => {
    responder = () => json({ available: false, reason: "desktop-app-required" })
    expect(await fetchRemoteBrowserAvailability()).toBe("desktop-app-required")
  })

  test("a failed or unreadable status is an error, not a missing desktop app", async () => {
    responder = () => json({ error: "down" }, 503)
    await expect(fetchRemoteBrowserAvailability()).rejects.toThrow()
    responder = () => json({ available: false })
    await expect(fetchRemoteBrowserAvailability()).rejects.toThrow()
    responder = () => new Response("<html>", { status: 200 })
    await expect(fetchRemoteBrowserAvailability()).rejects.toThrow()
  })
})
