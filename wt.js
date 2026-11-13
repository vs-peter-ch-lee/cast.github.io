// WebTransport handshake with the IFP, used when the page URL carries ?ip=<IFP IPv4> (the GitHub Pages build).
// One WebTransport session to https://<ip>:8444/cast is reused; every request opens a fresh bidirectional
// stream: write one UTF-8 JSON object, close the write side, read the single JSON reply until the stream ends.
//   {"type":"login","pin":"123456"}                          -> {"ok":true,"token":"<hex>"} | {"ok":false,"error":"wrong_pin"}
//   {"type":"invite","token","w","h","sdp":"<offer>"}        -> {"ok":true,"id","sdp":"<answer>"} | {"ok":false,"error":"unauthorized"|"failed"}
//   {"type":"end","token","id"}                              -> {"ok":true} | {"ok":false,"error":"unauthorized"|"not_found"}
//   {"type":"ping"}                                          -> {"ok":true}
// The login token lives only in this closure (never in storage, cookie or URL): a reload asks for the PIN again.
'use strict';

const Wt = (() => {
  const PORT = 8444;
  const PATH = '/cast';
  const CERT_VALID_MS = 14 * 24 * 3600 * 1000; // Chrome only accepts hash-pinned certificates valid for <= 14 days
  const CONNECT_TIMEOUT_MS = 8000;
  const REQUEST_TIMEOUT_MS = 10000;
  const PING_MS = 15000;
  const MAX_REPLY_BYTES = 1 << 20;

  // Read once at page load (fingerprints.js); which entries are valid is decided at every connect.
  const FINGERPRINTS = Array.isArray(window.WT_FINGERPRINTS) ? window.WT_FINGERPRINTS.slice() : [];
  const ENC = new TextEncoder();
  const DEC = new TextDecoder();

  let ip = null;
  let token = null;
  let session = null; // open WebTransport, or null
  let connecting = null; // Promise of the session being opened
  let pingTimer = null;
  let pinging = false;

  /** Dotted-quad IPv4 (each part 0-255, no leading zeros) -> normalized string, else null. */
  function parseIp(text) {
    const parts = String(text == null ? '' : text).split('.');
    if (parts.length !== 4) return null;
    const nums = [];
    for (const p of parts) {
      if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      nums.push(n);
    }
    return nums.join('.');
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /** serverCertificateHashes for every fingerprint valid at [now] (notBefore <= now < notBefore + 14 days). */
  function validHashes(now) {
    const out = [];
    for (const f of FINGERPRINTS) {
      if (!f || typeof f.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(f.sha256)) continue;
      const nb = Date.parse(f.notBefore);
      if (!Number.isFinite(nb) || now < nb || now >= nb + CERT_VALID_MS) continue;
      out.push({ algorithm: 'sha-256', value: hexToBytes(f.sha256) });
    }
    return out;
  }

  async function openSession() {
    if (typeof WebTransport === 'undefined') throw new Error(t('noWebTransport'));
    const hashes = validHashes(Date.now());
    if (!hashes.length) throw new Error(t('wtNoFingerprint'));
    const wt = new WebTransport(`https://${ip}:${PORT}${PATH}`, { serverCertificateHashes: hashes });
    wt.closed.then(() => {}, () => {}).then(() => { if (session === wt) session = null; });
    let timer;
    try {
      await Promise.race([
        wt.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      try { wt.close(); } catch (e2) { /* ignore */ }
      throw new Error(t('connectFail'));
    } finally {
      clearTimeout(timer);
    }
    session = wt;
    return wt;
  }

  /** The open session, reconnecting (with a fresh fingerprint filter) when it is gone. */
  function ensureSession() {
    if (session) return Promise.resolve(session);
    if (!connecting) connecting = openSession().finally(() => { connecting = null; });
    return connecting;
  }

  async function exchange(wt, obj) {
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(ENC.encode(JSON.stringify(obj)));
    await writer.close();
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_REPLY_BYTES) throw new Error('reply too large');
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const res = JSON.parse(DEC.decode(all));
    if (!res || typeof res !== 'object') throw new Error('bad reply');
    return res;
  }

  /** One request/reply on a new stream. Throws Error(connectFail text) when the IFP cannot be reached. */
  async function request(obj) {
    const wt = await ensureSession();
    let timer;
    try {
      return await Promise.race([
        exchange(wt, obj),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request timeout')), REQUEST_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      // A stalled or broken session is dropped so that the next request reconnects.
      if (session === wt) session = null;
      try { wt.close(); } catch (e2) { /* ignore */ }
      throw new Error(t('connectFail'));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves {ok:true} (token kept in memory) or {ok:false, error:'wrong_pin'}; throws when unreachable. */
  async function login(pin) {
    const res = await request({ type: 'login', pin });
    if (res.ok === true && typeof res.token === 'string' && res.token) {
      token = res.token;
      return { ok: true };
    }
    if (res.error === 'wrong_pin') return { ok: false, error: 'wrong_pin' };
    throw new Error(t('connectFail'));
  }

  // Signaling for RtcCast (same shape as its HTTP default): invite(w, h, sdp, onId) / end(id).
  const signaling = {
    async invite(w, h, sdp, onId) {
      if (!token) return { ok: false, status: 'unauthorized' };
      const res = await request({ type: 'invite', token, w, h, sdp });
      if (res.ok === true && typeof res.id === 'string' && typeof res.sdp === 'string') {
        if (onId) onId(res.id);
        return { ok: true, status: 'ok', id: res.id, sdp: res.sdp };
      }
      if (res.error === 'unauthorized') token = null;
      return { ok: false, status: String(res.error || 'failed') };
    },
    async end(id) {
      if (!token) return;
      const res = await request({ type: 'end', token, id });
      if (res.error === 'unauthorized') token = null;
      console.log(`[wt] end -> ${res.ok ? 'ok' : res.error}`);
    },
  };

  /** Pings every 15 s while casting. A dead session is reconnected by the ping; failures are ignored. */
  function startKeepalive() {
    stopKeepalive();
    pingTimer = setInterval(() => {
      if (pinging) return;
      pinging = true;
      request({ type: 'ping' }).catch(() => {}).finally(() => { pinging = false; });
    }, PING_MS);
  }

  function stopKeepalive() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  return {
    parseIp,
    init: (address) => { ip = address; },
    login,
    hasToken: () => token !== null,
    signaling,
    startKeepalive,
    stopKeepalive,
  };
})();
