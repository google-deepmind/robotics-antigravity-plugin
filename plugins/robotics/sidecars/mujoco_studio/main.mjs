// Copyright 2026 DeepMind Technologies Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview MuJoCo Studio Web Sidecar Proxy.
 *
 * Bridges the Sidecar AuxPane iframe to the agent-controlled Python
 * `studiod` (`WebViewer` + Studio `hot_reload`):
 *   - Serves `/preload.js` and `/_sidecar/info` via `SidecarApp`.
 *   - Serves `standby.html` when no simulation daemon is active and auto-switches
 *     via SSE (`/_studio/events`) as soon as `studiod` starts.
 *   - Reverse-proxies HTTP (`/` HTML with injected token-forwarding shim and
 *     lazy `0x0` hidden-pane visibility gate, `/web_client.js`,
 *     `/web_client.wasm`, `/model`, `/model?total_bytes`, `/assets/*`) and
 *     strips COOP/COEP on the proxied AuxPane response for clean iframe
 *     embedding while leaving `web_server.py` untouched for standalone tabs.
 *   - Defers `web_client.js` WASM/WebGL2 boot in `0x0` pre-warmed hidden AuxPane
 *     tabs and reloads on collapse so hidden tabs never hold the single `/ui`
 *     controller lock.
 *   - Tunnels binary WebSocket upgrades (`/state`, `/ui`, `/drop`) at 60Hz over
 *     loopback TCP with `TCP_NODELAY` (and provides an HTTP-tunneled WebSocket
 *     transport over `/_studio/ws/*` when embedded under custom schemes like
 *     Antigravity's `plugin://` inside an `https://` workbench where Chromium
 *     blocks `ws://` Mixed Content), replacing a page's stale tunnel when it
 *     reconnects with the same `?sid=` so a reloaded pane reclaims control.
 *   - Exposes `/_studio/status`, `/_studio/context`, `/_studio/context/capture`,
 *     `/_studio/reload`, and `/_studio/notify`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STANDBY_HTML_PATH = path.join(__dirname, 'standby.html');

// Strip sidecar gateway auth query params before forwarding to web_server.py
// so valueless query strings like `/model?total_bytes` match `query_string == "total_bytes"`.
const STRIPPED_QUERY_PARAMS = new Set([
  'token',
  '_sidecar_token',
  'conversationId',
]);

// Strip cross-origin isolation headers on the AuxPane proxy hop so non-isolated
// host iframes embed cleanly without modifying web_server.py itself.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'content-length',
]);

function sanitizeUidTag(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_');
  return cleaned || 'default';
}

function safeOsUsername() {
  try {
    return (os.userInfo && os.userInfo().username) || '';
  } catch (_) {
    return '';
  }
}

/**
 * Returns the UID tag used for shared temp discovery files.
 * @return {string}
 */
export function getUidTag() {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  const raw =
    process.env.USERNAME ||
    process.env.USER ||
    safeOsUsername() ||
    'default';
  return sanitizeUidTag(raw);
}

/**
 * Returns candidate UID tags to check on platforms without `process.getuid()`.
 * @return {!Array<string>}
 */
export function getCandidateUidTags() {
  const primary = getUidTag();
  if (typeof process.getuid === 'function') {
    return [primary];
  }
  const tags = [primary];
  for (const raw of [
    process.env.USERNAME || '',
    process.env.USER || '',
    safeOsUsername(),
    'default',
  ]) {
    if (!raw) continue;
    for (const candidate of [sanitizeUidTag(raw), String(raw).trim()]) {
      if (candidate && !tags.includes(candidate)) {
        tags.push(candidate);
      }
    }
  }
  return tags;
}

/**
 * Appends `<tmp>/<filename>` and, on POSIX when `osTmpDir` is not `/tmp` (such
 * as `/var/folders/.../T` on macOS), also `/tmp/<filename>` so tools using
 * either `$TMPDIR` or `/tmp` converge on the same discovery files.
 * @param {!Array<string>} paths
 * @param {string} osTmpDir
 * @param {string} filename
 */
export function appendSharedTmpPaths(paths, osTmpDir, filename) {
  const first = path.join(osTmpDir, filename);
  if (!paths.includes(first)) {
    paths.push(first);
  }
  if (process.platform === 'win32') {
    return;
  }
  try {
    if (fs.realpathSync(osTmpDir) !== fs.realpathSync('/tmp')) {
      const slashPath = path.join('/tmp', filename);
      if (!paths.includes(slashPath)) {
        paths.push(slashPath);
      }
    }
  } catch (_) {
    if (path.resolve(osTmpDir) !== '/tmp') {
      const slashPath = path.join('/tmp', filename);
      if (!paths.includes(slashPath)) {
        paths.push(slashPath);
      }
    }
  }
}

/**
 * Candidate paths where `studiod.py` writes `session.json`.
 * @return {!Array<string>}
 */
export function getCandidateSessionPaths() {
  const paths = [];
  if (process.env.MUJOCO_STUDIO_SESSION_FILE) {
    paths.push(process.env.MUJOCO_STUDIO_SESSION_FILE);
    return paths;
  }
  if (process.env.PLUGIN_DATA) {
    paths.push(path.join(process.env.PLUGIN_DATA, 'session.json'));
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    paths.push(
      path.join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'session.json'),
    );
  }
  const tmpDir = os.tmpdir();
  for (const tag of getCandidateUidTags()) {
    appendSharedTmpPaths(paths, tmpDir, `mujoco_studio_session_${tag}.json`);
  }
  return paths;
}

/**
 * Candidate paths where `main.mjs` publishes its sidecar info for `studiod.py`.
 * @param {!Object=} options
 * @return {!Array<string>}
 */
export function getSidecarInfoPaths(options = {}) {
  if (options && options.sidecarInfoPath) {
    return [options.sidecarInfoPath];
  }
  if (process.env.MUJOCO_STUDIO_SIDECAR_FILE) {
    return [process.env.MUJOCO_STUDIO_SIDECAR_FILE];
  }
  const paths = [];
  if (process.env.PLUGIN_DATA) {
    paths.push(path.join(process.env.PLUGIN_DATA, 'sidecar.json'));
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    paths.push(
      path.join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'sidecar.json'),
    );
  }
  const tmpDir = os.tmpdir();
  for (const tag of getCandidateUidTags()) {
    appendSharedTmpPaths(paths, tmpDir, `mujoco_studio_sidecar_${tag}.json`);
  }
  return paths;
}

/**
 * Clears the WASM shared-memory limits flag (`0x02`) in Section 2 (`Import`)
 * and Section 5 (`Memory`) when running in a non-`crossOriginIsolated` AuxPane
 * iframe where `SharedArrayBuffer` is unavailable. Pre-released `mujoco` wheels
 * compile `web_client.wasm` with `-pthread` (`flags = 0x03`), while `web_client`
 * itself runs single-threaded on the main thread; W3C WASM Threads permits all
 * `0xFE` atomic instructions on unshared (`0x01`) linear memory. Returns
 * `input` untouched with zero copy when no shared memory descriptor is present.
 * @param {!BufferSource} input
 * @return {!BufferSource}
 */
export function stripWasmSharedMemoryFlag(input) {
  const src =
    input instanceof Uint8Array
      ? input
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : null;
  if (!src || src.length < 8) return input;
  if (
    src[0] !== 0x00 ||
    src[1] !== 0x61 ||
    src[2] !== 0x73 ||
    src[3] !== 0x6d ||
    src[4] !== 0x01 ||
    src[5] !== 0x00 ||
    src[6] !== 0x00 ||
    src[7] !== 0x00
  ) {
    return input;
  }

  let pos = 8;
  function readU32() {
    let result = 0;
    let shift = 0;
    while (pos < src.length) {
      const byte = src[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }
  function skipLeb() {
    while (pos < src.length && (src[pos++] & 0x80) !== 0) {}
  }

  const patchOffsets = [];
  while (pos < src.length) {
    const sectionId = src[pos++];
    const sectionLen = readU32();
    const sectionEnd = pos + sectionLen;
    if (sectionEnd > src.length || sectionId > 5) break;

    if (sectionId === 2) {
      const count = readU32();
      for (let i = 0; i < count && pos < sectionEnd; i++) {
        const modLen = readU32();
        pos += modLen;
        const fieldLen = readU32();
        pos += fieldLen;
        if (pos >= sectionEnd) break;
        const kind = src[pos++];
        if (kind === 0x00) {
          skipLeb();
        } else if (kind === 0x01) {
          const rt = src[pos++];
          if (rt === 0x63 || rt === 0x64) skipLeb();
          const tf = readU32();
          skipLeb();
          if (tf & 0x01) skipLeb();
        } else if (kind === 0x02) {
          const flagPos = pos;
          const mf = readU32();
          if ((mf & 0x02) !== 0 && mf < 0x80) patchOffsets.push(flagPos);
          skipLeb();
          if (mf & 0x01) skipLeb();
        } else if (kind === 0x03) {
          const gt = src[pos++];
          if (gt === 0x63 || gt === 0x64) skipLeb();
          pos++;
        } else if (kind === 0x04) {
          pos++;
          skipLeb();
        } else {
          break;
        }
      }
    } else if (sectionId === 5) {
      const count = readU32();
      for (let i = 0; i < count && pos < sectionEnd; i++) {
        const flagPos = pos;
        const mf = readU32();
        if ((mf & 0x02) !== 0 && mf < 0x80) patchOffsets.push(flagPos);
        skipLeb();
        if (mf & 0x01) skipLeb();
      }
    }
    pos = sectionEnd;
  }

  if (patchOffsets.length === 0) return input;
  const out = new Uint8Array(src);
  for (let i = 0; i < patchOffsets.length; i++) {
    out[patchOffsets[i]] &= ~0x02;
  }
  return out;
}

/**
 * Builds the client-side script injected into `WebViewer`'s `index.html` `<head>`
 * so all relative and same-host `WebSocket`, `fetch`, `XMLHttpRequest`, and
 * `Worker` calls carry the sidecar gateway token (`?token=...`) without
 * corrupting valueless query parameters like `/model?total_bytes`, and so
 * `-pthread` `web_client.wasm` builds run cleanly in non-`crossOriginIsolated`
 * AuxPane iframes.
 * @param {string=} serverToken
 * @return {string}
 */
function buildClientBridgeScript(serverToken = '') {
  const preloadSrc = serverToken
    ? `/preload.js?token=${encodeURIComponent(serverToken)}`
    : '/preload.js';
  const fallbackTokenLiteral = JSON.stringify(serverToken || '');
  return `
<script src="${preloadSrc}"></script>
<script>
(function() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('_sidecar_token') || ${fallbackTokenLiteral} || '';
  const isCustomScheme =
    window.location.protocol !== 'http:' && window.location.protocol !== 'https:';

  // Ensure sessionStorage never throws SecurityError under restricted custom schemes.
  try {
    void window.sessionStorage.length;
  } catch (_) {
    try {
      const memStore = new Map();
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: {
          get length() { return memStore.size; },
          key: function(i) { return Array.from(memStore.keys())[i] || null; },
          getItem: function(k) { return memStore.has(String(k)) ? memStore.get(String(k)) : null; },
          setItem: function(k, v) { memStore.set(String(k), String(v)); },
          removeItem: function(k) { memStore.delete(String(k)); },
          clear: function() { memStore.clear(); },
        },
      });
    } catch (_) {}
  }

  // On custom schemes (e.g. Antigravity's plugin://<id>-<port>/ inside an
  // https:// workbench), rewrite explicit http(s)://<window.location.host>/...
  // requests (such as PrimeWebSocketUrl and /drop) to relative same-scheme
  // paths so Chromium never blocks them as Mixed Content.
  function normalizeCustomSchemeUrl(rawUrl) {
    if (!isCustomScheme || typeof rawUrl !== 'string') return rawUrl;
    try {
      const parsed = new URL(rawUrl, window.location.href);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.host === window.location.host
      ) {
        if (parsed.pathname === '/ui' || parsed.pathname === '/state') {
          return '/_studio/ws/prime';
        }
        return (parsed.pathname || '/') + (parsed.search || '') + (parsed.hash || '');
      }
    } catch (_) {}
    return rawUrl;
  }

  function appendToken(rawUrl) {
    if (typeof rawUrl !== 'string') return rawUrl;
    rawUrl = normalizeCustomSchemeUrl(rawUrl);
    if (!token) return rawUrl;
    try {
      const resolved = new URL(rawUrl, window.location.href);
      // Compare host rather than origin so ws:// and wss:// URLs targeting the
      // same host (window.location.host) also receive the gateway token.
      if (resolved.host !== window.location.host && !rawUrl.startsWith('/')) {
        return rawUrl;
      }
      if (resolved.searchParams.has('token') || resolved.searchParams.has('_sidecar_token')) {
        return rawUrl;
      }
      const encodedToken = 'token=' + encodeURIComponent(token);
      const hashIdx = rawUrl.indexOf('#');
      const basePart = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
      const hashPart = hashIdx === -1 ? '' : rawUrl.slice(hashIdx);
      const sep = basePart.includes('?') ? '&' : '?';
      return basePart + sep + encodedToken + hashPart;
    } catch (_) {
      return rawUrl;
    }
  }

  const origFetch = window.fetch;
  const openSockets = new Set();
  window.addEventListener('pagehide', function() {
    for (const ws of openSockets) {
      try { ws.close(1000, 'pagehide'); } catch (_) {}
    }
    openSockets.clear();
  });

  if (isCustomScheme) {
    // Under Antigravity's plugin:// iframe hosted inside an https://127.0.0.1
    // window, Chromium blocks ws:// WebSockets as Mixed Content and custom
    // schemes cannot upgrade to wss://. Tunnel WebSocket frames over same-origin
    // plugin:// fetch requests (/_studio/ws/*) to main.mjs instead.
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder('utf-8');
    const MAX_SEND_BATCH_BYTES = 16 * 1024 * 1024;

    function makeCloseEvent(code, reason, wasClean) {
      if (typeof CloseEvent === 'function') {
        return new CloseEvent('close', { code: code, reason: reason, wasClean: wasClean });
      }
      const ev = new Event('close');
      ev.code = code;
      ev.reason = reason;
      ev.wasClean = wasClean;
      return ev;
    }

    class HttpTunneledWebSocket extends EventTarget {
      constructor(url, protocols) {
        super();
        this.url = String(url);
        this.readyState = 0;
        this.bufferedAmount = 0;
        this.extensions = '';
        this.protocol = '';
        this.binaryType = 'blob';
        this._sessionId = '';
        this._sendQueue = [];
        this._sending = false;
        this._closeRequested = null;
        this._closeSent = false;
        this._closedEmitted = false;

        let targetPath = '/';
        try {
          const parsed = new URL(String(url), window.location.href);
          targetPath = (parsed.pathname || '/') + (parsed.search || '');
        } catch (_) {
          targetPath = String(url);
        }

        openSockets.add(this);
        this.addEventListener('close', () => { openSockets.delete(this); });
        this._connect(targetPath, protocols);
      }

      async _connect(targetPath, protocols) {
        try {
          const resp = await origFetch.call(window, appendToken('/_studio/ws/open'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: targetPath,
              protocols: protocols === undefined ? null : protocols,
            }),
            cache: 'no-store',
          });
          if (!resp.ok) {
            this._failAndClose();
            return;
          }
          const info = await resp.json();
          if (!info || !info.id) {
            this._failAndClose();
            return;
          }
          this._sessionId = String(info.id);
          this.protocol = info.protocol ? String(info.protocol) : '';
          if (this._closeRequested) {
            await this._sendCloseHttp(this._closeRequested.code, this._closeRequested.reason);
            this._finalizeClose(this._closeRequested.code, this._closeRequested.reason, true);
            return;
          }
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
          this._pumpSend();
          this._pollLoop();
        } catch (_) {
          this._failAndClose();
        }
      }

      send(data) {
        if (this.readyState === 0) {
          throw new DOMException('Still in CONNECTING state', 'InvalidStateError');
        }
        if (this.readyState !== 1) return;

        // Copy ArrayBuffer / TypedArray views synchronously: Emscripten's
        // libwebsocket.js passes HEAPU8.subarray(...) backed by WASM stack
        // memory that C++ immediately overwrites after send() returns.
        if (typeof data === 'string') {
          const bytes = textEncoder.encode(data);
          this.bufferedAmount += bytes.byteLength;
          this._sendQueue.push({ opcode: 0x01, bytes: bytes, size: bytes.byteLength });
        } else if (data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(data.slice(0));
          this.bufferedAmount += bytes.byteLength;
          this._sendQueue.push({ opcode: 0x02, bytes: bytes, size: bytes.byteLength });
        } else if (ArrayBuffer.isView(data)) {
          const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
          this.bufferedAmount += bytes.byteLength;
          this._sendQueue.push({ opcode: 0x02, bytes: bytes, size: bytes.byteLength });
        } else if (typeof Blob === 'function' && data instanceof Blob) {
          const size = data.size || 0;
          this.bufferedAmount += size;
          this._sendQueue.push({ opcode: 0x02, blob: data, size: size });
        } else {
          const bytes = textEncoder.encode(String(data));
          this.bufferedAmount += bytes.byteLength;
          this._sendQueue.push({ opcode: 0x01, bytes: bytes, size: bytes.byteLength });
        }
        this._pumpSend();
      }

      async _pumpSend() {
        if (this._sending || !this._sessionId) return;
        this._sending = true;
        try {
          while (this._sendQueue.length > 0 && !this._closedEmitted) {
            const batch = [];
            let packedBytes = 0;
            let payloadBytes = 0;
            while (this._sendQueue.length > 0) {
              const head = this._sendQueue[0];
              const estBytes = 5 + head.size;
              if (batch.length > 0 && packedBytes + estBytes > MAX_SEND_BATCH_BYTES) {
                break;
              }
              this._sendQueue.shift();
              const bytes = head.bytes
                ? head.bytes
                : new Uint8Array(await head.blob.arrayBuffer());
              batch.push({ opcode: head.opcode, bytes: bytes, accounted: head.size });
              packedBytes += 5 + bytes.byteLength;
              payloadBytes += head.size;
            }
            const packed = new Uint8Array(packedBytes);
            const view = new DataView(packed.buffer);
            let off = 0;
            for (let i = 0; i < batch.length; i++) {
              const item = batch[i];
              packed[off] = item.opcode;
              view.setUint32(off + 1, item.bytes.byteLength, false);
              packed.set(item.bytes, off + 5);
              off += 5 + item.bytes.byteLength;
            }
            this.bufferedAmount = Math.max(0, this.bufferedAmount - payloadBytes);
            const resp = await origFetch.call(
              window,
              appendToken('/_studio/ws/send?id=' + encodeURIComponent(this._sessionId)),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: packed,
                cache: 'no-store',
              },
            );
            if (!resp.ok) {
              this._failAndClose();
              return;
            }
          }
          if (this._closeRequested && !this._closeSent) {
            await this._sendCloseHttp(this._closeRequested.code, this._closeRequested.reason);
            this._finalizeClose(this._closeRequested.code, this._closeRequested.reason, true);
          }
        } catch (_) {
          this._failAndClose();
        } finally {
          this._sending = false;
        }
      }

      async _pollLoop() {
        while (!this._closedEmitted && (this.readyState === 1 || this.readyState === 2)) {
          try {
            const resp = await origFetch.call(
              window,
              appendToken('/_studio/ws/poll?id=' + encodeURIComponent(this._sessionId)),
              { method: 'POST', cache: 'no-store' },
            );
            if (!resp.ok) {
              this._finalizeClose(1006, '', false);
              return;
            }
            const buf = await resp.arrayBuffer();
            if (buf.byteLength === 0) continue;
            const view = new DataView(buf);
            const u8 = new Uint8Array(buf);
            let off = 0;
            while (off + 5 <= buf.byteLength) {
              const frameType = u8[off];
              const len = view.getUint32(off + 1, false);
              if (off + 5 + len > buf.byteLength) break;
              const start = off + 5;
              const end = start + len;
              off = end;
              if (frameType === 0x08) {
                let code = 1005;
                let reason = '';
                if (len >= 2) {
                  code = view.getUint16(start, false);
                  reason = textDecoder.decode(u8.subarray(start + 2, end));
                }
                this._finalizeClose(code, reason, code !== 1006);
                return;
              }
              if (this.readyState !== 1) continue;
              if (frameType === 0x01) {
                const text = textDecoder.decode(u8.subarray(start, end));
                this.dispatchEvent(new MessageEvent('message', { data: text }));
              } else if (frameType === 0x02) {
                const slice = buf.slice(start, end);
                const payload =
                  this.binaryType === 'arraybuffer'
                    ? slice
                    : typeof Blob === 'function'
                      ? new Blob([slice])
                      : slice;
                this.dispatchEvent(new MessageEvent('message', { data: payload }));
              }
            }
          } catch (_) {
            if (!this._closedEmitted) {
              this._failAndClose();
            }
            return;
          }
        }
      }

      async _sendCloseHttp(code, reason) {
        if (this._closeSent || !this._sessionId) return;
        this._closeSent = true;
        try {
          await origFetch.call(
            window,
            appendToken('/_studio/ws/close?id=' + encodeURIComponent(this._sessionId)),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: code, reason: reason }),
              cache: 'no-store',
              keepalive: true,
            },
          );
        } catch (_) {}
      }

      close(code, reason) {
        if (this.readyState === 2 || this.readyState === 3) return;
        const closeCode = typeof code === 'number' ? code : 1000;
        const closeReason = reason !== undefined ? String(reason) : '';
        this._closeRequested = { code: closeCode, reason: closeReason };
        this.readyState = 2;
        if (this._sessionId && !this._sending) {
          this._pumpSend();
        }
      }

      _failAndClose() {
        if (this._closedEmitted) return;
        this.readyState = 3;
        this.dispatchEvent(new Event('error'));
        this._finalizeClose(1006, '', false);
      }

      _finalizeClose(code, reason, wasClean) {
        if (this._closedEmitted) return;
        this._closedEmitted = true;
        this.readyState = 3;
        this._sendQueue.length = 0;
        this.bufferedAmount = 0;
        this.dispatchEvent(makeCloseEvent(code, reason, wasClean));
      }
    }

    for (const evtName of ['open', 'message', 'error', 'close']) {
      const slot = '_on_' + evtName;
      Object.defineProperty(HttpTunneledWebSocket.prototype, 'on' + evtName, {
        configurable: true,
        enumerable: true,
        get: function() { return this[slot] || null; },
        set: function(fn) {
          if (this[slot]) {
            this.removeEventListener(evtName, this[slot]);
          }
          if (typeof fn === 'function') {
            this[slot] = fn;
            this.addEventListener(evtName, fn);
          } else {
            this[slot] = null;
          }
        },
      });
    }

    HttpTunneledWebSocket.CONNECTING = 0;
    HttpTunneledWebSocket.OPEN = 1;
    HttpTunneledWebSocket.CLOSING = 2;
    HttpTunneledWebSocket.CLOSED = 3;
    HttpTunneledWebSocket.prototype.CONNECTING = 0;
    HttpTunneledWebSocket.prototype.OPEN = 1;
    HttpTunneledWebSocket.prototype.CLOSING = 2;
    HttpTunneledWebSocket.prototype.CLOSED = 3;
    window.WebSocket = HttpTunneledWebSocket;
  } else {
    // Wrap WebSocket so /state, /ui, and /drop carry ?token=..., and so the
    // page's sockets get a clean close frame when the iframe is reloaded or
    // torn down (otherwise the server may keep a ghost controller for this sid).
    const OrigWebSocket = window.WebSocket;
    function PatchedWebSocket(url, protocols) {
      const patchedUrl = appendToken(String(url));
      const ws = protocols !== undefined
        ? new OrigWebSocket(patchedUrl, protocols)
        : new OrigWebSocket(patchedUrl);
      openSockets.add(ws);
      ws.addEventListener('close', function() { openSockets.delete(ws); });
      return ws;
    }
    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    window.WebSocket = PatchedWebSocket;
  }

  // Wrap fetch so /model, /model?total_bytes, /assets/*, /_studio/* carry ?token=...
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = appendToken(input);
    } else if (input instanceof URL) {
      input = appendToken(input.toString());
    }
    return origFetch.call(this, input, init);
  };

  // Wrap XMLHttpRequest.open for Emscripten WASM asset fetches and PrimeWebSocketUrl.
  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return origXhrOpen.call(this, method, appendToken(String(url)), ...rest);
  };

  // Wrap Worker so same-host worker scripts carry ?token=... and non-isolated
  // iframes do not throw DataCloneError if Emscripten posts unshared wasmMemory.
  if (typeof window.Worker === 'function') {
    const OrigWorker = window.Worker;
    function PatchedWorker(scriptUrl, options) {
      const patchedUrl =
        scriptUrl instanceof URL
          ? appendToken(scriptUrl.toString())
          : appendToken(String(scriptUrl));
      let worker;
      try {
        worker =
          options !== undefined
            ? new OrigWorker(patchedUrl, options)
            : new OrigWorker(patchedUrl);
      } catch (err) {
        if (!isCustomScheme && typeof SharedArrayBuffer !== 'undefined') {
          throw err;
        }
        const stub = new EventTarget();
        stub.onmessage = null;
        stub.onerror = null;
        stub.terminate = function() {};
        stub.postMessage = function(msg) {
          if (msg && typeof msg === 'object' && 'wasmMemory' in msg) {
            Promise.resolve().then(function() {
              const ev = new MessageEvent('message', { data: { cmd: 'loaded' } });
              if (typeof stub.onmessage === 'function') stub.onmessage(ev);
              stub.dispatchEvent(ev);
            });
          }
        };
        return stub;
      }
      if (typeof SharedArrayBuffer === 'undefined') {
        const origPostMessage = worker.postMessage.bind(worker);
        worker.postMessage = function(msg, transfer) {
          if (msg && typeof msg === 'object' && 'wasmMemory' in msg) {
            Promise.resolve().then(function() {
              const ev = new MessageEvent('message', { data: { cmd: 'loaded' } });
              if (typeof worker.onmessage === 'function') worker.onmessage(ev);
              worker.dispatchEvent(ev);
            });
            return;
          }
          return transfer !== undefined
            ? origPostMessage(msg, transfer)
            : origPostMessage(msg);
        };
      }
      return worker;
    }
    Object.setPrototypeOf(PatchedWorker, OrigWorker);
    PatchedWorker.prototype = OrigWorker.prototype;
    window.Worker = PatchedWorker;
  }

  // Fallback for non-crossOriginIsolated AuxPane iframes (SharedArrayBuffer
  // unavailable) when loading external py.mujoco.org -pthread WASM builds.
  if (typeof SharedArrayBuffer === 'undefined' && typeof WebAssembly === 'object') {
    ${stripWasmSharedMemoryFlag.toString()}

    if (typeof WebAssembly.Memory === 'function') {
      const OrigMemory = WebAssembly.Memory;
      function PatchedMemory(desc) {
        if (desc && desc.shared) {
          desc = Object.assign({}, desc, { shared: false });
        }
        return new OrigMemory(desc);
      }
      Object.setPrototypeOf(PatchedMemory, OrigMemory);
      PatchedMemory.prototype = OrigMemory.prototype;
      WebAssembly.Memory = PatchedMemory;
    }

    if (typeof WebAssembly.Module === 'function') {
      const OrigModule = WebAssembly.Module;
      function PatchedModule(bytes) {
        return new OrigModule(stripWasmSharedMemoryFlag(bytes));
      }
      Object.setPrototypeOf(PatchedModule, OrigModule);
      PatchedModule.prototype = OrigModule.prototype;
      WebAssembly.Module = PatchedModule;
    }

    if (typeof WebAssembly.compile === 'function') {
      const origCompile = WebAssembly.compile;
      WebAssembly.compile = function(bytes, ...rest) {
        return origCompile.call(
          WebAssembly,
          stripWasmSharedMemoryFlag(bytes),
          ...rest,
        );
      };
    }

    if (typeof WebAssembly.instantiate === 'function') {
      const origInstantiate = WebAssembly.instantiate;
      WebAssembly.instantiate = function(source, ...rest) {
        if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
          source = stripWasmSharedMemoryFlag(source);
        }
        return origInstantiate.call(WebAssembly, source, ...rest);
      };
    }

    if (typeof WebAssembly.compileStreaming === 'function') {
      WebAssembly.compileStreaming = function(source, ...rest) {
        return Promise.resolve(source)
          .then(function(resp) { return resp.arrayBuffer(); })
          .then(function(buf) { return WebAssembly.compile(buf, ...rest); });
      };
    }

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      WebAssembly.instantiateStreaming = function(source, ...rest) {
        return Promise.resolve(source)
          .then(function(resp) { return resp.arrayBuffer(); })
          .then(function(buf) { return WebAssembly.instantiate(buf, ...rest); });
      };
    }

    if (typeof Atomics === 'object' && typeof Atomics.waitAsync === 'function') {
      const origWaitAsync = Atomics.waitAsync;
      Atomics.waitAsync = function(typedArray, index, value, timeout) {
        if (
          typeof SharedArrayBuffer === 'undefined' ||
          !typedArray ||
          !(typedArray.buffer instanceof SharedArrayBuffer)
        ) {
          return { async: true, value: new Promise(function() {}) };
        }
        return origWaitAsync.call(Atomics, typedArray, index, value, timeout);
      };
    }
  }

  // Render a floating toast when the user captures a simulation frame so they
  // can send it straight to the agent chat with a note.
  function showCapturedContextToast() {
    let toast = document.getElementById('__mj_studio_ctx_toast');
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.id = '__mj_studio_ctx_toast';
    toast.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:16px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'background:rgba(22,27,34,0.96)',
      'color:#e6edf3',
      'border:1px solid #30363d',
      'border-radius:10px',
      'padding:10px 12px',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
      'max-width:calc(100vw - 24px)',
    ].join(';');

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask agent about captured simulation frame...';
    input.value = 'Inspect the captured MuJoCo Studio simulation frame.';
    input.style.cssText = [
      'background:#0d1117',
      'color:#e6edf3',
      'border:1px solid #30363d',
      'border-radius:6px',
      'padding:6px 8px',
      'font-size:12px',
      'min-width:220px',
      'flex:1',
    ].join(';');

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send to Agent Chat';
    sendBtn.style.cssText = [
      'background:#58a6ff',
      'color:#0d1117',
      'border:none',
      'border-radius:6px',
      'padding:6px 10px',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'white-space:nowrap',
    ].join(';');

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.cssText = [
      'background:#21262d',
      'color:#e6edf3',
      'border:1px solid #30363d',
      'border-radius:6px',
      'padding:6px 10px',
      'font-size:12px',
      'cursor:pointer',
      'white-space:nowrap',
    ].join(';');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '\u00d7';
    closeBtn.style.cssText = [
      'background:transparent',
      'color:#8b949e',
      'border:none',
      'font-size:16px',
      'line-height:1',
      'padding:2px 6px',
      'cursor:pointer',
    ].join(';');
    closeBtn.onclick = function() { toast.remove(); };

    async function fetchSnapshotJson() {
      const resp = await window.fetch('/_studio/context', { cache: 'no-store' });
      return await resp.json();
    }

    sendBtn.onclick = async function() {
      sendBtn.disabled = true;
      try {
        const snap = await fetchSnapshotJson();
        const note = input.value.trim() || 'Inspect the captured MuJoCo Studio simulation frame.';
        const fence = String.fromCharCode(96, 96, 96);
        const prompt = note + '\\n\\n' + fence + 'json\\n' + JSON.stringify(snap, null, 2) + '\\n' + fence;
        if (
          window.sidecar &&
          window.sidecar.agent &&
          typeof window.sidecar.agent.sendMessage === 'function'
        ) {
          await window.sidecar.agent.sendMessage(prompt);
          sendBtn.textContent = 'Sent!';
          setTimeout(function() { toast.remove(); }, 900);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(prompt);
          sendBtn.textContent = 'Copied Prompt!';
        }
      } catch (_) {
        sendBtn.textContent = 'Failed';
        sendBtn.disabled = false;
      }
    };

    copyBtn.onclick = async function() {
      try {
        const snap = await fetchSnapshotJson();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
          copyBtn.textContent = 'Copied!';
        }
      } catch (_) {}
    };

    toast.appendChild(input);
    toast.appendChild(sendBtn);
    toast.appendChild(copyBtn);
    toast.appendChild(closeBtn);
    (document.body || document.documentElement).appendChild(toast);
  }

  // Listen for daemon restarts and captured frames via SSE (or JSON polling on
  // custom schemes like plugin:// where streaming EventSource is unsupported).
  let currentPid = null;
  function handleStudioEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === 'session_started') {
      if (currentPid !== null && msg.pid && msg.pid !== currentPid) {
        window.location.reload();
      }
      if (msg.pid) currentPid = msg.pid;
    } else if (msg.event === 'context_captured') {
      showCapturedContextToast();
    }
  }

  if (!isCustomScheme && typeof EventSource === 'function') {
    try {
      const es = new EventSource(appendToken('/_studio/events'));
      es.onmessage = function(ev) {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.event === 'connected' && msg.pid && currentPid === null) {
            currentPid = msg.pid;
          }
          handleStudioEvent(msg);
        } catch (_) {}
      };
    } catch (_) {}
  } else {
    let sinceSeq = null;
    async function pollStudioEvents() {
      try {
        const suffix = sinceSeq !== null ? '&since=' + encodeURIComponent(String(sinceSeq)) : '';
        const resp = await origFetch.call(
          window,
          appendToken('/_studio/events?poll=1' + suffix),
          { cache: 'no-store' },
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && typeof data === 'object') {
            if (currentPid === null && data.state && data.state.pid) {
              currentPid = data.state.pid;
            }
            if (typeof data.seq === 'number') {
              sinceSeq = data.seq;
            }
            if (Array.isArray(data.events)) {
              for (let i = 0; i < data.events.length; i++) {
                handleStudioEvent(data.events[i]);
              }
            }
          }
        }
      } catch (_) {}
    }
    pollStudioEvents();
    const evPollTimer = setInterval(pollStudioEvents, 1000);
    if (evPollTimer && typeof evPollTimer.unref === 'function') {
      evPollTimer.unref();
    }
  }
})();
</script>
`;
}

/**
 * Builds the `0x0` hidden-pane visibility gate replacing eager `<script async src="web_client.js">`
 * so pre-warmed or collapsed AuxPane iframes neither allocate WASM/WebGL2 nor
 * occupy the single `/ui` controller slot while hidden.
 * @param {string} webClientSrc
 * @return {string}
 */
function buildVisibilityGatedWebClientScript(webClientSrc) {
  const clientSrcLiteral = JSON.stringify(webClientSrc);
  return `<script id="__mj_studio_visibility_gate">
(function() {
  // web_client.cc falls back to sessionStorage.getItem('mjwv_sid'), which is
  // shared across all same-origin AuxPane iframes in the same browser tab and
  // makes web_server.py treat panes from different conversations as one client
  // (ignoring "Request control" and "Steal control"). Pre-populating
  // Module.session_id from window.name gives each iframe its own session id
  // that still persists when that iframe reloads.
  if (window.Module && !window.Module.session_id) {
    try {
      const prefix = 'mjwv_sid:';
      if (typeof window.name !== 'string' || window.name.indexOf(prefix) !== 0) {
        window.name =
          prefix + Date.now().toString(36) + Math.random().toString(36).slice(2);
      }
      window.Module.session_id = window.name.slice(prefix.length);
    } catch (_) {
      window.Module.session_id =
        Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  }
  if (typeof window.fitCanvas === 'function') {
    const origFitCanvas = window.fitCanvas;
    window.fitCanvas = function() {
      if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
      return origFitCanvas.apply(this, arguments);
    };
  }
  const MIN_PANE_PX = 32;
  const COLLAPSE_RELOAD_MS = 600;
  const clientSrc = ${clientSrcLiteral};
  let booted = false;
  let collapseTimer = null;

  function isPaneVisible() {
    return (
      window.innerWidth >= MIN_PANE_PX &&
      window.innerHeight >= MIN_PANE_PX &&
      document.visibilityState !== 'hidden'
    );
  }

  function checkVisibilityGate() {
    if (!booted) {
      if (!isPaneVisible()) return;
      booted = true;
      if (typeof window.fitCanvas === 'function') window.fitCanvas();
      const s = document.createElement('script');
      s.async = true;
      s.src = clientSrc;
      (document.body || document.documentElement).appendChild(s);
      return;
    }
    if (window.innerWidth === 0 && window.innerHeight === 0) {
      if (!collapseTimer) {
        collapseTimer = setTimeout(function() {
          if (window.innerWidth === 0 && window.innerHeight === 0) {
            window.location.reload();
          }
        }, COLLAPSE_RELOAD_MS);
      }
    } else if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  }

  window.addEventListener('resize', checkVisibilityGate);
  document.addEventListener('visibilitychange', checkVisibilityGate);
  checkVisibilityGate();
})();
</script>`;
}

/**
 * Strips sidecar auth query parameters from `rawUrl` while preserving raw
 * valueless parameters such as `?total_bytes`.
 * @param {string} rawUrl
 * @return {string}
 */
export function stripSidecarAuthParams(rawUrl) {
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) {
    return rawUrl;
  }
  const pathname = rawUrl.slice(0, qIndex);
  const rawQuery = rawUrl.slice(qIndex + 1);
  const keptSegments = [];
  for (const segment of rawQuery.split('&')) {
    if (!segment) continue;
    const eqIdx = segment.indexOf('=');
    const rawKey = eqIdx === -1 ? segment : segment.slice(0, eqIdx);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch (_) {}
    if (!STRIPPED_QUERY_PARAMS.has(key)) {
      if (segment === 'total_bytes=') {
        keptSegments.push('total_bytes');
      } else {
        keptSegments.push(segment);
      }
    }
  }
  return keptSegments.length > 0
    ? `${pathname}?${keptSegments.join('&')}`
    : pathname;
}

/**
 * Injects the preload & token-forwarding script and `0x0` hidden-pane
 * visibility gate into `WebViewer`'s `index.html`, and appends `?token=...` to
 * static asset links so cross-site iframes work when third-party cookies are
 * blocked.
 * @param {string} html
 * @param {string=} serverToken
 * @return {string}
 */
export function injectClientBridgeIntoHtml(html, serverToken = '') {
  if (html.includes('/preload.js')) {
    return html;
  }
  const qs = serverToken ? `?token=${encodeURIComponent(serverToken)}` : '';
  let transformed = html;
  if (qs) {
    transformed = transformed.replace(
      /href="favicon\.ico"/g,
      `href="favicon.ico${qs}"`,
    );
  }
  transformed = transformed.replace(
    /<script\b[^>]*\bsrc=["']web_client\.js([^"']*)["'][^>]*>\s*<\/script>/gi,
    (_match, existingSuffix) => {
      const suffix = existingSuffix || qs;
      return buildVisibilityGatedWebClientScript(`web_client.js${suffix}`);
    },
  );
  const bridgeScript = buildClientBridgeScript(serverToken);
  const headMatch = transformed.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const insertPos = headMatch.index + headMatch[0].length;
    return (
      transformed.slice(0, insertPos) +
      bridgeScript +
      transformed.slice(insertPos)
    );
  }
  return bridgeScript + transformed;
}

/**
 * Keys a WebSocket tunnel by path and Studio session id (`?sid=`), so a page
 * that reloads replaces its own stale tunnel. Returns null without a sid.
 * @param {string} cleanPath
 * @return {?string}
 */
export function tunnelKeyFor(cleanPath) {
  try {
    const url = new URL(cleanPath, 'http://127.0.0.1');
    const sid = url.searchParams.get('sid');
    return sid ? `${url.pathname}?sid=${sid}` : null;
  } catch (_) {
    return null;
  }
}

/**
 * Extracts any sidecar token present on the incoming request (either from
 * `X-Sidecar-Token` injected by the sidecar gateway or `?token=` in `req.url`).
 * @param {!http.IncomingMessage} req
 * @return {string}
 */
function extractRequestToken(req) {
  const headerToken = req.headers['x-sidecar-token'];
  if (typeof headerToken === 'string' && headerToken) {
    return headerToken;
  }
  try {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    return (
      parsed.searchParams.get('token') ||
      parsed.searchParams.get('_sidecar_token') ||
      ''
    );
  } catch (_) {
    return '';
  }
}

/**
 * Resolves the expected sidecar gateway auth token from explicit options or
 * the sidecar environment (`ANTIGRAVITY_SIDECAR_UI_TOKEN`, falling back to
 * `SIDECAR_TOKEN`).
 * @param {!Object=} options
 * @param {!Object=} env
 * @return {string}
 */
export function resolveExpectedSidecarToken(options = {}, env = process.env) {
  if (options && options.token !== undefined) {
    return String(options.token || '');
  }
  return String(
    (env && (env.ANTIGRAVITY_SIDECAR_UI_TOKEN || env.SIDECAR_TOKEN)) || '',
  );
}

/**
 * Checks whether an incoming request carries a valid sidecar token when a
 * sidecar token is configured.
 * @param {!http.IncomingMessage} req
 * @param {string} expectedToken
 * @return {boolean}
 */
function verifySidecarAuth(req, expectedToken) {
  if (!expectedToken) {
    return true;
  }
  const actualToken = extractRequestToken(req);
  if (!actualToken) {
    return false;
  }
  const expectedDigest = crypto
    .createHash('sha256')
    .update(expectedToken, 'utf-8')
    .digest();
  const actualDigest = crypto
    .createHash('sha256')
    .update(actualToken, 'utf-8')
    .digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * Checks whether an incoming POST /_studio/notify carries acceptable
 * credentials. Previously notify was exempt from auth entirely, so any
 * loopback caller — including a website that discovered the ephemeral
 * sidecar port via localhost scanning — could overwrite the daemon session
 * state (http_port / control_port) and hijack the sidecar's proxy targets
 * or kill the session with `session_stopped`.
 *
 * studiod.py (urllib) sends no Origin header, while browsers always send
 * one on cross-origin POSTs, so browser-originated notifies are rejected
 * outright. A per-process token (published in the sidecar info file that
 * studiod already reads for the notify URL) is required whenever the
 * caller presents one, and is always sent by current studiod. Legacy
 * studiod (no Origin, no token) keeps working.
 *
 * @param {!http.IncomingMessage} req
 * @param {string} notifyToken
 * @return {boolean}
 */
function verifyNotifyAuth(req, notifyToken) {
  if (req.headers.origin) {
    return false;
  }

  const presented = req.headers['x-studio-notify-token'];
  if (!presented) {
    return true;
  }

  const expectedDigest = crypto
    .createHash('sha256')
    .update(notifyToken, 'utf-8')
    .digest();
  const actualDigest = crypto
    .createHash('sha256')
    .update(String(presented), 'utf-8')
    .digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * Reads JSON body from an HTTP request.
 * @param {!http.IncomingMessage} req
 * @return {!Promise<!Object>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Reads raw binary body from an HTTP request.
 * @param {!http.IncomingMessage} req
 * @return {!Promise<!Buffer>}
 */
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/**
 * Encodes a masked client-to-server RFC 6455 WebSocket frame.
 * @param {number} opcode
 * @param {!Buffer|!Uint8Array} payload
 * @return {!Buffer}
 */
function encodeWsClientFrame(opcode, payload) {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 65536) {
    headerLen = 10;
  } else if (len >= 126) {
    headerLen = 4;
  }
  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len < 65536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  mask.copy(out, headerLen);
  const dataOffset = headerLen + 4;
  for (let i = 0; i < len; i++) {
    out[dataOffset + i] = payload[i] ^ mask[i & 3];
  }
  return out;
}

/**
 * Sends a JSON HTTP response.
 * @param {!http.ServerResponse} res
 * @param {number} statusCode
 * @param {!Object} payload
 */
function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Creates and starts the MuJoCo Studio Web sidecar server.
 * @param {!Object=} options
 * @return {!Promise<{server: !http.Server, port: number, state: !Object, close: function(): !Promise<void>}>}
 */
export async function startStudioSidecarServer(options = {}) {
  const expectedToken = resolveExpectedSidecarToken(options);
  // Per-process token for POST /_studio/notify, published in the sidecar
  // info file (see below) so studiod.py can present it. Any other loopback
  // caller — including a website that found the port — does not know it.
  const notifyToken = crypto.randomBytes(32).toString('hex');

  /** @type {!Map<string, function(): void>} tunnel key -> teardown */
  const wsTunnels = new Map();
  /** @type {!Map<string, !Object>} session id -> HTTP-tunneled WS session */
  const httpWsSessions = new Map();

  const state = {
    pid: 0,
    http_port: Number(options.initialHttpPort || 0),
    control_port: Number(options.initialControlPort || 0),
    workspace_dir: options.initialWorkspaceDir || '',
    runtime_dir: '',
    status_file: '',
    snapshot_file: '',
    scene_source: '',
    started_at: 0,
  };

  /** @type {!Set<!http.ServerResponse>} */
  const sseClients = new Set();
  let eventSeq = 0;
  /** @type {!Array<{seq: number, payload: !Object}>} */
  const eventHistory = [];

  function broadcastSse(payload) {
    eventSeq += 1;
    eventHistory.push({ seq: eventSeq, payload });
    if (eventHistory.length > 64) {
      eventHistory.shift();
    }
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(data);
      } catch (_) {
        sseClients.delete(client);
      }
    }
  }

  function openUpstreamWsSession(targetPort, cleanPath, protocols) {
    return new Promise((resolve) => {
      const sessionId = crypto.randomBytes(16).toString('hex');
      const tunnelKey = tunnelKeyFor(cleanPath);
      if (tunnelKey) {
        const previous = wsTunnels.get(tunnelKey);
        if (previous) {
          previous();
        }
      }

      const upstreamSocket = net.connect({ host: '127.0.0.1', port: targetPort });
      upstreamSocket.setNoDelay(true);

      let handshakeDone = false;
      let rxBuf = Buffer.alloc(0);
      let fragOpcode = 0;
      let fragChunks = [];

      const session = {
        id: sessionId,
        lastSeen: Date.now(),
        /** @type {!Array<{type: number, payload: !Buffer}>} */
        outQueue: [],
        /** @type {?{code: number, reason: string}} */
        closedInfo: null,
        /** @type {?function(boolean=): void} */
        activePollFinish: null,
        sendFrame(opcode, payload) {
          if (session.closedInfo || upstreamSocket.destroyed || !upstreamSocket.writable) {
            return false;
          }
          upstreamSocket.write(encodeWsClientFrame(opcode, payload));
          return true;
        },
        closeFromClient(code, reason) {
          const safeCode =
            typeof code === 'number' &&
            code >= 1000 &&
            code <= 4999 &&
            code !== 1005 &&
            code !== 1006
              ? code
              : 1000;
          const reasonBuf = Buffer.from(String(reason || ''), 'utf-8').subarray(0, 123);
          if (!upstreamSocket.destroyed && upstreamSocket.writable) {
            const closePayload = Buffer.allocUnsafe(2 + reasonBuf.length);
            closePayload.writeUInt16BE(safeCode, 0);
            reasonBuf.copy(closePayload, 2);
            try {
              upstreamSocket.write(encodeWsClientFrame(0x08, closePayload));
              upstreamSocket.end();
            } catch (_) {}
          }
          markClosed(safeCode, reasonBuf.toString('utf-8'));
          const killTimer = setTimeout(() => upstreamSocket.destroy(), 250);
          if (typeof killTimer.unref === 'function') killTimer.unref();
          httpWsSessions.delete(sessionId);
        },
        destroyImmediate() {
          markClosed(1006, '');
          upstreamSocket.destroy();
          httpWsSessions.delete(sessionId);
        },
      };

      const teardown = () => {
        if (tunnelKey && wsTunnels.get(tunnelKey) === teardown) {
          wsTunnels.delete(tunnelKey);
        }
        session.destroyImmediate();
      };

      if (tunnelKey) {
        wsTunnels.set(tunnelKey, teardown);
      }

      function notifyPoll() {
        if (session.activePollFinish) {
          const fn = session.activePollFinish;
          session.activePollFinish = null;
          fn(false);
        }
      }

      function markClosed(code, reason) {
        if (tunnelKey && wsTunnels.get(tunnelKey) === teardown) {
          wsTunnels.delete(tunnelKey);
        }
        if (!session.closedInfo) {
          session.closedInfo = { code, reason };
        }
        notifyPoll();
      }

      function enqueueOut(type, payload) {
        if (session.closedInfo) return;
        session.outQueue.push({ type, payload });
        notifyPoll();
      }

      function parseFrames() {
        while (rxBuf.length >= 2) {
          const b0 = rxBuf[0];
          const b1 = rxBuf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let payloadLen = b1 & 0x7f;
          let headerLen = 2;
          if (payloadLen === 126) {
            if (rxBuf.length < 4) return;
            payloadLen = rxBuf.readUInt16BE(2);
            headerLen = 4;
          } else if (payloadLen === 127) {
            if (rxBuf.length < 10) return;
            payloadLen = Number(rxBuf.readBigUInt64BE(2));
            headerLen = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (rxBuf.length < headerLen + maskLen + payloadLen) return;
          const payloadStart = headerLen + maskLen;
          const payloadEnd = payloadStart + payloadLen;
          const framePayload = Buffer.from(rxBuf.subarray(payloadStart, payloadEnd));
          if (masked) {
            const mask = rxBuf.subarray(headerLen, headerLen + 4);
            for (let i = 0; i < payloadLen; i++) {
              framePayload[i] ^= mask[i & 3];
            }
          }
          rxBuf =
            payloadEnd < rxBuf.length
              ? rxBuf.subarray(payloadEnd)
              : Buffer.alloc(0);

          if (opcode === 0x08) {
            let code = 1005;
            let reason = '';
            if (framePayload.length >= 2) {
              code = framePayload.readUInt16BE(0);
              reason = framePayload.subarray(2).toString('utf-8');
            }
            if (!upstreamSocket.destroyed && upstreamSocket.writable) {
              try {
                upstreamSocket.write(encodeWsClientFrame(0x08, framePayload.subarray(0, 2)));
              } catch (_) {}
            }
            markClosed(code, reason);
            upstreamSocket.destroy();
            return;
          } else if (opcode === 0x09) {
            if (!upstreamSocket.destroyed && upstreamSocket.writable) {
              try {
                upstreamSocket.write(encodeWsClientFrame(0x0a, framePayload));
              } catch (_) {}
            }
          } else if (opcode === 0x01 || opcode === 0x02) {
            if (fin) {
              enqueueOut(opcode, framePayload);
            } else {
              fragOpcode = opcode;
              fragChunks = [framePayload];
            }
          } else if (opcode === 0x00 && fragOpcode !== 0) {
            fragChunks.push(framePayload);
            if (fin) {
              enqueueOut(fragOpcode, Buffer.concat(fragChunks));
              fragOpcode = 0;
              fragChunks = [];
            }
          }
        }
      }

      const connectTimer = setTimeout(() => {
        if (!handshakeDone) {
          handshakeDone = true;
          teardown();
          resolve({ ok: false, status: 504 });
        }
      }, 5000);
      if (typeof connectTimer.unref === 'function') connectTimer.unref();

      upstreamSocket.on('connect', () => {
        const wsKey = crypto.randomBytes(16).toString('base64');
        const reqLines = [
          `GET ${cleanPath} HTTP/1.1`,
          `Host: 127.0.0.1:${targetPort}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${wsKey}`,
          'Sec-WebSocket-Version: 13',
        ];
        if (Array.isArray(protocols) && protocols.length > 0) {
          reqLines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
        } else if (typeof protocols === 'string' && protocols) {
          reqLines.push(`Sec-WebSocket-Protocol: ${protocols}`);
        }
        reqLines.push('', '');
        upstreamSocket.write(reqLines.join('\r\n'));
      });

      upstreamSocket.on('data', (chunk) => {
        rxBuf = rxBuf.length === 0 ? chunk : Buffer.concat([rxBuf, chunk]);
        if (!handshakeDone) {
          const headerEnd = rxBuf.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          handshakeDone = true;
          clearTimeout(connectTimer);
          const headerText = rxBuf.subarray(0, headerEnd).toString('latin1');
          rxBuf =
            headerEnd + 4 < rxBuf.length
              ? Buffer.from(rxBuf.subarray(headerEnd + 4))
              : Buffer.alloc(0);
          const lines = headerText.split('\r\n');
          const statusLine = lines[0] || '';
          if (!/^HTTP\/1\.[01]\s+101\b/i.test(statusLine)) {
            teardown();
            resolve({ ok: false, status: 502 });
            return;
          }
          let negotiatedProtocol = '';
          for (let i = 1; i < lines.length; i++) {
            const idx = lines[i].indexOf(':');
            if (idx !== -1) {
              const hk = lines[i].slice(0, idx).trim().toLowerCase();
              if (hk === 'sec-websocket-protocol') {
                negotiatedProtocol = lines[i].slice(idx + 1).trim();
              }
            }
          }
          httpWsSessions.set(sessionId, session);
          resolve({ ok: true, id: sessionId, protocol: negotiatedProtocol });
          if (rxBuf.length > 0) {
            parseFrames();
          }
          return;
        }
        parseFrames();
      });

      upstreamSocket.on('error', () => {
        clearTimeout(connectTimer);
        if (!handshakeDone) {
          handshakeDone = true;
          teardown();
          resolve({ ok: false, status: 502 });
          return;
        }
        markClosed(1006, '');
      });

      upstreamSocket.on('close', () => {
        clearTimeout(connectTimer);
        if (!handshakeDone) {
          handshakeDone = true;
          teardown();
          resolve({ ok: false, status: 502 });
          return;
        }
        markClosed(1006, '');
      });
    });
  }

  const wsSessionReaperInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, sess] of httpWsSessions.entries()) {
      if (!sess.activePollFinish && now - sess.lastSeen > 60000) {
        sess.destroyImmediate();
        httpWsSessions.delete(sid);
      }
    }
  }, 5000);
  if (typeof wsSessionReaperInterval.unref === 'function') {
    wsSessionReaperInterval.unref();
  }

  function updateSessionState(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (candidate.event === 'session_stopped') {
      const hadSession =
        state.http_port > 0 || state.control_port > 0 || state.pid > 0;
      state.http_port = 0;
      state.control_port = 0;
      state.pid = 0;
      return hadSession;
    }
    const nextHttpPort = Number(candidate.http_port || 0);
    const nextControlPort = Number(candidate.control_port || 0);
    const nextPid = Number(candidate.pid || 0);
    const nextWorkspace = String(candidate.workspace_dir || '');
    const nextRuntimeDir = String(candidate.runtime_dir || '');
    const nextStatusFile = String(candidate.status_file || '');
    const nextSnapshotFile = String(candidate.snapshot_file || '');
    const nextScene = String(candidate.scene_source || '');
    const changed =
      (nextHttpPort > 0 && nextHttpPort !== state.http_port) ||
      (nextControlPort > 0 && nextControlPort !== state.control_port) ||
      (nextPid > 0 && nextPid !== state.pid) ||
      (nextWorkspace && nextWorkspace !== state.workspace_dir);

    if (nextHttpPort > 0) state.http_port = nextHttpPort;
    if (nextControlPort > 0) state.control_port = nextControlPort;
    if (nextPid > 0) state.pid = nextPid;
    if (nextWorkspace) state.workspace_dir = nextWorkspace;
    if (nextRuntimeDir) state.runtime_dir = nextRuntimeDir;
    if (nextStatusFile) state.status_file = nextStatusFile;
    if (nextSnapshotFile) state.snapshot_file = nextSnapshotFile;
    if (nextScene) state.scene_source = nextScene;
    if (candidate.started_at) state.started_at = Number(candidate.started_at);
    return changed;
  }

  function refreshFromSessionFiles() {
    const sessionPaths = options.sessionPaths || getCandidateSessionPaths();
    let newest = null;
    let newestMtime = -1;
    for (const p of sessionPaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const stat = fs.statSync(p);
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const ts = Number(parsed.started_at || stat.mtimeMs || 0);
        if (ts >= newestMtime && Number(parsed.http_port) > 0) {
          newestMtime = ts;
          newest = parsed;
        }
      } catch (_) {}
    }
    if (newest) {
      const changed = updateSessionState(newest);
      if (changed) {
        broadcastSse({ event: 'session_started', ...state });
      }
    }
  }

  const UI_ACTIVITY_POLL_WINDOW_MS = 15000;
  let lastUiActivityMs = 0;

  function markUiActivity() {
    lastUiActivityMs = Date.now();
  }

  refreshFromSessionFiles();
  const pollInterval = setInterval(() => {
    // Gate background session-file polling on an active pane connection or
    // recent UI request so a closed AuxPane does zero periodic filesystem polling.
    if (
      sseClients.size === 0 &&
      Date.now() - lastUiActivityMs > UI_ACTIVITY_POLL_WINDOW_MS
    ) {
      return;
    }
    refreshFromSessionFiles();
  }, 1000);
  if (typeof pollInterval.unref === 'function') {
    pollInterval.unref();
  }

  function serveStandbyHtml(req, res) {
    let html = '<html><body><h1>MuJoCo Studio Standby</h1></body></html>';
    const candidatePaths = [STANDBY_HTML_PATH];
    if (process.argv[1]) {
      candidatePaths.unshift(
        path.join(path.dirname(path.resolve(process.argv[1])), 'standby.html'),
      );
    }
    if (options && options.standbyHtmlPath) {
      candidatePaths.unshift(options.standbyHtmlPath);
    }
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          html = fs.readFileSync(p, 'utf-8');
          break;
        }
      } catch (_) {}
    }
    const reqToken = extractRequestToken(req);
    if (reqToken) {
      const qs = `?token=${encodeURIComponent(reqToken)}`;
      html = html.replace(/src="\/preload\.js"/g, `src="/preload.js${qs}"`);
    }
    const buf = Buffer.from(html, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  }

  function proxyHttpToPort(req, res, targetPort, targetPath, proxyOptions = false) {
    const transformHtml =
      typeof proxyOptions === 'boolean'
        ? proxyOptions
        : Boolean(proxyOptions && proxyOptions.transformHtml);
    const onError =
      proxyOptions && typeof proxyOptions === 'object' ? proxyOptions.onError : null;

    const outHeaders = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    delete outHeaders['accept-encoding'];
    // The studiod control API rejects requests bearing an Origin header
    // (browser-originated). Strip it here so the sidecar's own proxied
    // calls to the control port keep working.
    delete outHeaders['origin'];

    const reqToken = extractRequestToken(req);

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: targetPath,
        headers: outHeaders,
      },
      (proxyRes) => {
        const cleanHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase()) && v !== undefined) {
            cleanHeaders[k] = v;
          }
        }

        if (
          transformHtml &&
          proxyRes.statusCode === 200 &&
          String(proxyRes.headers['content-type'] || '').includes('text/html')
        ) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            const rawHtml = Buffer.concat(chunks).toString('utf-8');
            const injected = injectClientBridgeIntoHtml(rawHtml, reqToken);
            const buf = Buffer.from(injected, 'utf-8');
            cleanHeaders['content-length'] = String(buf.length);
            cleanHeaders['cache-control'] = 'no-store';
            res.writeHead(proxyRes.statusCode || 200, cleanHeaders);
            res.end(buf);
          });
          return;
        }

        if (proxyRes.headers['content-length'] !== undefined) {
          cleanHeaders['content-length'] = proxyRes.headers['content-length'];
        }
        res.writeHead(proxyRes.statusCode || 200, cleanHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', () => {
      req.resume();
      if (typeof onError === 'function' && !res.headersSent) {
        onError();
      } else if (transformHtml && !res.headersSent) {
        serveStandbyHtml(req, res);
      } else if (!res.headersSent) {
        sendJson(res, 502, {
          error: 'MuJoCo Studio daemon is not reachable',
          http_port: targetPort,
        });
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq);
  }

  function serveContextFallbackOr503(req, res, pathname) {
    // Fallback for GET /_studio/context: read snapshot_file from out-of-workspace runtime_dir.
    if (req.method === 'GET' && pathname === '/_studio/context') {
      const candidateFiles = [];
      if (state.snapshot_file) {
        candidateFiles.push(state.snapshot_file);
      } else if (state.runtime_dir) {
        candidateFiles.push(path.join(state.runtime_dir, 'latest_snapshot.json'));
      }
      for (const snapPath of candidateFiles) {
        try {
          if (fs.existsSync(snapPath)) {
            const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
            sendJson(res, 200, snap);
            return;
          }
        } catch (_) {}
      }
    }
    sendJson(res, 503, {
      error: 'Simulation control server is not running',
      ...state,
    });
  }

  async function handleCustomStudioRoutes(req, res, pathname, cleanUrl) {
    if (req.method === 'GET' && pathname === '/_studio/ws/prime') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    if (req.method === 'POST' && pathname === '/_studio/ws/open') {
      const body = await readJsonBody(req);
      refreshFromSessionFiles();
      const targetPort = state.http_port;
      if (!targetPort || targetPort <= 0) {
        sendJson(res, 503, { error: 'No active MuJoCo Studio session' });
        return true;
      }
      const cleanTarget = stripSidecarAuthParams(String(body.target || '/'));
      let parsedTarget;
      try {
        parsedTarget = new URL(cleanTarget, 'http://127.0.0.1');
      } catch (_) {
        sendJson(res, 400, { error: 'Invalid WebSocket target path' });
        return true;
      }
      if (
        parsedTarget.pathname !== '/ui' &&
        parsedTarget.pathname !== '/state' &&
        parsedTarget.pathname !== '/drop'
      ) {
        sendJson(res, 400, { error: 'Unsupported WebSocket path' });
        return true;
      }
      const upstreamPath = (parsedTarget.pathname || '/') + (parsedTarget.search || '');
      const result = await openUpstreamWsSession(
        targetPort,
        upstreamPath,
        body.protocols,
      );
      if (!result.ok) {
        sendJson(res, result.status || 502, {
          error: 'Upstream WebSocket handshake failed',
        });
        return true;
      }
      sendJson(res, 200, { id: result.id, protocol: result.protocol || '' });
      return true;
    }

    if (req.method === 'POST' && pathname === '/_studio/ws/send') {
      const parsedReqUrl = new URL(cleanUrl, 'http://127.0.0.1');
      const sid = parsedReqUrl.searchParams.get('id') || '';
      const session = httpWsSessions.get(sid);
      const raw = await readRawBody(req);
      if (!session || session.closedInfo) {
        res.writeHead(410, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      session.lastSeen = Date.now();
      let off = 0;
      while (off + 5 <= raw.length) {
        const opcode = raw[off] === 0x01 ? 0x01 : 0x02;
        const len = raw.readUInt32BE(off + 1);
        if (off + 5 + len > raw.length) break;
        const payload = raw.subarray(off + 5, off + 5 + len);
        off += 5 + len;
        if (!session.sendFrame(opcode, payload)) {
          res.writeHead(410, { 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    if (req.method === 'POST' && pathname === '/_studio/ws/poll') {
      const parsedReqUrl = new URL(cleanUrl, 'http://127.0.0.1');
      const sid = parsedReqUrl.searchParams.get('id') || '';
      const session = httpWsSessions.get(sid);
      await readRawBody(req);
      if (!session) {
        res.writeHead(410, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      session.lastSeen = Date.now();
      if (session.activePollFinish) {
        const prevFinish = session.activePollFinish;
        session.activePollFinish = null;
        prevFinish(true);
      }

      const MAX_POLL_BATCH_BYTES = 16 * 1024 * 1024;
      const sendPollResponse = (forceEmpty) => {
        if (res.writableEnded || res.destroyed) return;
        if (forceEmpty) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '0',
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        const records = [];
        let totalBytes = 0;
        while (session.outQueue.length > 0) {
          const next = session.outQueue[0];
          const recBytes = 5 + next.payload.length;
          if (records.length > 0 && totalBytes + recBytes > MAX_POLL_BATCH_BYTES) {
            break;
          }
          session.outQueue.shift();
          records.push(next);
          totalBytes += recBytes;
        }
        if (session.outQueue.length === 0 && session.closedInfo !== null) {
          const reasonBuf = Buffer.from(session.closedInfo.reason || '', 'utf-8');
          const closePayload = Buffer.allocUnsafe(2 + reasonBuf.length);
          closePayload.writeUInt16BE(session.closedInfo.code || 1005, 0);
          reasonBuf.copy(closePayload, 2);
          records.push({ type: 0x08, payload: closePayload });
          totalBytes += 5 + closePayload.length;
          httpWsSessions.delete(sid);
        }
        if (totalBytes === 0) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '0',
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        const out = Buffer.allocUnsafe(totalBytes);
        let offset = 0;
        for (let i = 0; i < records.length; i++) {
          const rec = records[i];
          out[offset] = rec.type;
          out.writeUInt32BE(rec.payload.length, offset + 1);
          rec.payload.copy(out, offset + 5);
          offset += 5 + rec.payload.length;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(out.length),
          'Cache-Control': 'no-store',
        });
        res.end(out);
      };

      if (session.outQueue.length > 0 || session.closedInfo !== null) {
        sendPollResponse(false);
        return true;
      }

      let finished = false;
      const finish = (forceEmpty = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(waitTimer);
        if (session.activePollFinish === finish) {
          session.activePollFinish = null;
        }
        session.lastSeen = Date.now();
        sendPollResponse(Boolean(forceEmpty));
      };
      const waitTimer = setTimeout(() => finish(false), 1500);
      if (typeof waitTimer.unref === 'function') waitTimer.unref();
      session.activePollFinish = finish;
      req.on('close', () => {
        if (!finished) {
          finished = true;
          clearTimeout(waitTimer);
          if (session.activePollFinish === finish) {
            session.activePollFinish = null;
          }
        }
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/_studio/ws/close') {
      const parsedReqUrl = new URL(cleanUrl, 'http://127.0.0.1');
      const sid = parsedReqUrl.searchParams.get('id') || '';
      const body = await readJsonBody(req);
      const session = httpWsSessions.get(sid);
      if (session) {
        session.closeFromClient(body.code, body.reason);
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    if (req.method === 'GET' && pathname === '/_studio/events') {
      const parsedEventsUrl = new URL(cleanUrl, 'http://127.0.0.1');
      if (parsedEventsUrl.searchParams.get('poll') === '1') {
        const sinceParam = parsedEventsUrl.searchParams.get('since');
        const since = sinceParam !== null ? Number(sinceParam) : eventSeq;
        const events = Number.isFinite(since)
          ? eventHistory
              .filter((item) => item.seq > since)
              .map((item) => item.payload)
          : [];
        sendJson(res, 200, { seq: eventSeq, state, events });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ event: 'connected', ...state })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return true;
    }

    if (req.method === 'POST' && pathname === '/_studio/notify') {
      const body = await readJsonBody(req);
      updateSessionState(body);
      broadcastSse({
        event: body.event || 'notify',
        ...state,
        ...body,
      });
      sendJson(res, 200, { ok: true, state });
      return true;
    }

    if (req.method === 'GET' && pathname === '/_studio/status') {
      refreshFromSessionFiles();
      if (state.control_port > 0) {
        proxyHttpToPort(req, res, state.control_port, '/_studio/status', {
          onError: () =>
            sendJson(res, 200, {
              ok: false,
              daemon_connected: false,
              ...state,
            }),
        });
        return true;
      }
      sendJson(res, 200, {
        ok: false,
        daemon_connected: false,
        ...state,
      });
      return true;
    }

    if (
      pathname === '/_studio/context' ||
      pathname === '/_studio/context/capture' ||
      pathname === '/_studio/reload'
    ) {
      refreshFromSessionFiles();
      if (state.control_port > 0) {
        proxyHttpToPort(req, res, state.control_port, cleanUrl, {
          onError: () => serveContextFallbackOr503(req, res, pathname),
        });
        return true;
      }
      serveContextFallbackOr503(req, res, pathname);
      return true;
    }

    return false;
  }

  // Try loading SidecarApp from sidecar_sdk when injected by the host IDE.
  let server = null;
  let sdkHandler = null;

  if (!options.disableSdk) {
    try {
      const sdk = await import('sidecar_sdk');
      const app = new sdk.SidecarApp();
      app.page('/', () => sdk.Response.html('<html></html>'));
      server = await app.run();
      const listeners = server.listeners('request');
      if (listeners.length > 0) {
        sdkHandler = listeners[0];
        server.removeAllListeners('request');
      }
    } catch (_) {
      server = null;
    }
  }

  if (!server) {
    const requestedPort =
      Number(
        options.port ??
          process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ??
          process.env.PORT ??
          0,
      ) || 0;
    server = http.createServer();
    await new Promise((resolve) => {
      server.listen(requestedPort, '127.0.0.1', resolve);
    });
  }

  server.on('request', async (req, res) => {
    const rawUrl = req.url || '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);

    if (
      pathname === '/_studio/notify'
        ? !verifyNotifyAuth(req, notifyToken)
        : !verifySidecarAuth(req, expectedToken)
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: invalid or missing sidecar token');
      return;
    }
    if (pathname !== '/_studio/notify') {
      markUiActivity();
    }

    // Delegate /preload.js and /_sidecar/* to SidecarApp when available.
    if (pathname === '/preload.js' || pathname.startsWith('/_sidecar/')) {
      if (sdkHandler) {
        sdkHandler(req, res);
        return;
      }
      if (pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('window.sidecar = window.sidecar || {};');
        return;
      }
      sendJson(res, 200, { views: [{ path: '/', title: 'MuJoCo Studio' }] });
      return;
    }

    const cleanUrl = stripSidecarAuthParams(rawUrl);

    if (pathname.startsWith('/_studio/')) {
      const handled = await handleCustomStudioRoutes(req, res, pathname, cleanUrl);
      if (handled) return;
    }

    refreshFromSessionFiles();
    const isHtmlEntry = pathname === '/' || pathname === '/index.html';
    if (state.http_port <= 0) {
      if (isHtmlEntry) {
        serveStandbyHtml(req, res);
      } else {
        sendJson(res, 503, { error: 'No active MuJoCo Studio session' });
      }
      return;
    }

    if (isHtmlEntry) {
      proxyHttpToPort(req, res, state.http_port, '/', {
        transformHtml: true,
        onError: () => serveStandbyHtml(req, res),
      });
      return;
    }

    proxyHttpToPort(req, res, state.http_port, cleanUrl, false);
  });

  // Tunnel binary WebSocket upgrades (/state, /ui, /drop) to WebViewer.
  server.on('upgrade', (req, clientSocket, head) => {
    if (!verifySidecarAuth(req, expectedToken)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    refreshFromSessionFiles();
    const targetPort = state.http_port;
    if (!targetPort || targetPort <= 0) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    clientSocket.setNoDelay(true);
    const cleanPath = stripSidecarAuthParams(req.url || '/');
    const tunnelKey = tunnelKeyFor(cleanPath);
    const upstreamSocket = net.connect(
      { host: '127.0.0.1', port: targetPort },
      () => {
        upstreamSocket.setNoDelay(true);
        const lines = [`${req.method || 'GET'} ${cleanPath} HTTP/${req.httpVersion || '1.1'}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i];
          const v = req.rawHeaders[i + 1];
          const lower = k.toLowerCase();
          if (lower === 'host') {
            lines.push(`Host: 127.0.0.1:${targetPort}`);
          } else {
            lines.push(`${k}: ${v}`);
          }
        }
        lines.push('', '');
        upstreamSocket.write(lines.join('\r\n'));
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      },
    );

    const teardown = () => {
      if (tunnelKey && wsTunnels.get(tunnelKey) === teardown) {
        wsTunnels.delete(tunnelKey);
      }
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on('error', teardown);
    clientSocket.on('error', teardown);
    upstreamSocket.on('close', teardown);
    clientSocket.on('close', teardown);

    // A page's session id survives reloads, but its old sockets may not be
    // closed through the sidecar gateway. Without this, the stale /ui tunnel
    // stays the server's controller under the same sid, so the reloaded page
    // is rejected as a spectator and cannot even queue for control.
    if (tunnelKey) {
      const previous = wsTunnels.get(tunnelKey);
      if (previous) {
        previous();
      }
      wsTunnels.set(tunnelKey, teardown);
    }
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

  // Publish sidecar info files so `studiod.py` can auto-discover `/_studio/notify`.
  const sidecarInfoPayload = JSON.stringify(
    {
      web_port: actualPort,
      pid: process.pid,
      notify_token: notifyToken,
      started_at: Date.now(),
    },
    null,
    2,
  );
  for (const sidecarInfoPath of getSidecarInfoPaths(options)) {
    try {
      fs.mkdirSync(path.dirname(sidecarInfoPath), { recursive: true });
      // Owner-only: the file now carries the notify token and the sidecar
      // port; other local users have no business reading either.
      fs.writeFileSync(sidecarInfoPath, sidecarInfoPayload, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch (_) {}
  }

  // Emit handshake JSON line expected by SidecarManager when running standalone.
  if (!sdkHandler && !options.silentHandshake) {
    process.stdout.write(`${JSON.stringify({ web_port: actualPort })}\n`);
  }

  return {
    server,
    port: actualPort,
    state,
    close: () =>
      new Promise((resolve) => {
        clearInterval(pollInterval);
        clearInterval(wsSessionReaperInterval);
        for (const sess of httpWsSessions.values()) {
          try {
            sess.destroyImmediate();
          } catch (_) {}
        }
        httpWsSessions.clear();
        for (const c of sseClients) {
          try {
            c.end();
          } catch (_) {}
        }
        sseClients.clear();
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      }),
  };
}

function isExecutedAsEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch (_) {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
}

if (isExecutedAsEntrypoint()) {
  startStudioSidecarServer().catch((err) => {
    console.error('[MuJoCo Studio Sidecar] Fatal error:', err);
    process.exit(1);
  });
}
