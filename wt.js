// WebTransport handshake with the IFP, used when the page URL carries ?ip=<IFP IPv4> (the GitHub Pages build).
// One WebTransport session to https://<ip>:8444/cast is reused; every request opens a fresh bidirectional
// stream: write one UTF-8 JSON object, close the write side, read the single JSON reply until the stream ends.
//   {"type":"login","pin":"123456"}                          -> {"ok":true,"token":"<hex>"} | {"ok":false,"error":"wrong_pin"}
//   {"type":"invite","token","w","h","sdp":"<offer>"}        -> {"ok":true,"id","sdp":"<answer>"} | {"ok":false,"error":"unauthorized"|"failed"}
//   {"type":"end","token","id"}                              -> {"ok":true} | {"ok":false,"error":"unauthorized"|"not_found"}
//   {"type":"view","token","sdp":"<offer>"}                  -> {"ok":true,"id","sdp":"<answer>"} | {"ok":false,"error":"unauthorized"|"failed"|"bad_request"}
//   {"type":"view-end","token","id"}                         -> {"ok":true} | {"ok":false,"error":"unauthorized"|"not_found"|"bad_request"}
//   {"type":"ping"}                                          -> {"ok":true,"meeting":<bool>}   (no token needed)
// Without a meeting, login / invite / end / view / view-end answer {"ok":false,"error":"no_meeting"}: request() drops the
// token and calls the handler given to onNoMeeting.
// Shared-area ops (share-version, share-list, share-thumb, share-file, share-clip, share-clip-image) use the same
// request stream but a framed reply: 4-byte big-endian header length, UTF-8 JSON header ({"ok":true,"size",...} or
// {"ok":false,"error"}), then `size` body bytes. transfer() handles them; a failure there never closes the session,
// and only unauthorized drops the token; no_meeting keeps it so the next poll still asks the IFP and gets the same
// answer (the shared area itself decides what the page shows).
// Upload ops (share-upload-start / -chunk / -finish / -cancel) answer in the same framed reply with an empty body.
// share-upload-chunk is the only framed request: 4-byte big-endian header length, JSON header, then the chunk bytes
// up to the end of the write side. Wt.share.upload() runs the whole flow.
// The login token lives only in this closure (never in storage, cookie or URL): a reload asks for the PIN again.
'use strict';

const Wt = (() => {
  const PORT = 8444;
  const PATH = '/cast';
  const CERT_VALID_MS = 14 * 24 * 3600 * 1000; // Chrome only accepts hash-pinned certificates valid for <= 14 days
  // Chrome asks "Access other devices on your local network" on the first connect and keeps `ready` pending until
  // the user answers, so this must outlast a person reading the prompt. An unreachable IFP normally makes Chrome
  // reject `ready` by itself well before this; the value only bounds the case where it never settles.
  const CONNECT_TIMEOUT_MS = 90000;
  // Per request on an already established session (counted from session ready, not from the connect).
  const REQUEST_TIMEOUT_MS = 10000;
  const PING_MS = 15000;
  const MAX_REPLY_BYTES = 1 << 20;
  // Shared area: connect + request + header within POLL / SHARE ms; then each body read within the idle limit.
  const POLL_TIMEOUT_MS = 5000;
  const SHARE_TIMEOUT_MS = 10000;
  const SHARE_IDLE_MS = 10000;
  const MAX_HEADER_BYTES = 64 * 1024;
  const CHUNK_BYTES = 1 << 20;
  // Upload (share-upload-*): at most 100 MiB per file, sent as chunks of at most 8 MiB (the IFP tells its chunk size),
  // each on its own stream and written in 256 KiB pieces so that progress follows the bytes sent.
  const UPLOAD_MAX_BYTES = 104857600;
  const UPLOAD_CHUNK_MAX_BYTES = 8 << 20;
  const UPLOAD_PIECE_BYTES = 256 * 1024;
  // No piece accepted by the stream within this long: the chunk failed (the IFP gives up after 20 s without data).
  const UPLOAD_WRITE_IDLE_MS = 30000;
  // After the last byte of a chunk: the IFP reads for at most 120 s per chunk and then answers.
  const UPLOAD_REPLY_MS = 130000;
  const UPLOAD_CANCEL_MS = 5000;

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
  let noMeetingHandler = null;

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

  async function writeRequest(stream, obj) {
    const writer = stream.writable.getWriter();
    await writer.write(ENC.encode(JSON.stringify(obj)));
    await writer.close();
  }

  async function readReply(stream) {
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

  async function exchange(wt, obj) {
    const stream = await wt.createBidirectionalStream();
    await writeRequest(stream, obj);
    return readReply(stream);
  }

  /** One request/reply on a new stream. Throws Error(connectFail text) when the IFP cannot be reached. */
  async function request(obj) {
    const wt = await ensureSession();
    let timer;
    let res;
    try {
      res = await Promise.race([
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
    if (res.error === 'no_meeting') {
      token = null;
      if (noMeetingHandler) noMeetingHandler();
    }
    return res;
  }

  /** Resolves the ping reply {ok, meeting}; throws when the IFP cannot be reached. */
  function ping() {
    return request({ type: 'ping' });
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

  /** Reads exactly n bytes per take(n) from a stream reader; onData runs on every chunk received. */
  function byteReader(reader, guard, onData) {
    let pending = new Uint8Array(0);
    return async function take(n) {
      const out = new Uint8Array(n);
      let filled = 0;
      while (filled < n) {
        if (!pending.length) {
          const { done, value } = await guard(reader.read());
          if (done) throw new Error('stream ended early');
          pending = value;
          onData();
        }
        const count = Math.min(n - filled, pending.length);
        out.set(pending.subarray(0, count), filled);
        filled += count;
        pending = pending.subarray(count);
      }
      return out;
    };
  }

  /**
   * One shared-area request on its own stream. Resolves {ok:true, header, body:Uint8Array} or {ok:false, error}:
   * a server error code, 'aborted' when [signal] fires, or 'unreachable' for any other failure (including timeouts).
   * Never throws and never closes the session.
   * With [frame] (a Blob) the request is framed: 4-byte big-endian header length, the JSON header, then the Blob's bytes;
   * [timeoutMs] is then the longest wait for one piece to be accepted, [replyMs] the wait for the reply after the last
   * byte, and onSent(bytesOfFrameSent) runs after each piece.
   */
  async function transfer(obj, { signal, timeoutMs = SHARE_TIMEOUT_MS, idleMs = SHARE_IDLE_MS, frame, replyMs, onSent } = {}) {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    if (!token) return { ok: false, error: 'unauthorized' };
    const sent = token;
    let reader = null;
    let writer = null;
    let timer = null;
    let failure = null;
    let bodyIdleMs = 0;
    let stop;
    const stopped = new Promise((_, reject) => { stop = reject; });
    stopped.catch(() => {});
    const guard = (promise) => Promise.race([promise, stopped]);
    const fail = (code) => {
      if (!failure) failure = code;
      stop(new Error(code));
      try { if (writer) writer.abort().catch(() => {}); } catch (e) { /* ignore */ }
      try { if (reader) reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
    };
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail('unreachable'), ms);
    };
    const onAbort = () => fail('aborted');
    if (signal) signal.addEventListener('abort', onAbort);
    arm(timeoutMs);
    try {
      const wt = await guard(ensureSession());
      const stream = await guard(wt.createBidirectionalStream());
      writer = stream.writable.getWriter();
      const head = ENC.encode(JSON.stringify({ ...obj, token: sent }));
      if (frame) {
        const first = new Uint8Array(4 + head.length);
        new DataView(first.buffer).setUint32(0, head.length);
        first.set(head, 4);
        await guard(writer.write(first));
        for (let at = 0; at < frame.size; at += UPLOAD_PIECE_BYTES) {
          const end = Math.min(at + UPLOAD_PIECE_BYTES, frame.size);
          const piece = new Uint8Array(await guard(frame.slice(at, end).arrayBuffer()));
          arm(timeoutMs);
          await guard(writer.write(piece));
          arm(timeoutMs);
          if (onSent) onSent(end);
        }
      } else {
        await guard(writer.write(head));
      }
      await guard(writer.close());
      if (frame && replyMs) arm(replyMs);
      reader = stream.readable.getReader();
      const take = byteReader(reader, guard, () => { if (bodyIdleMs) arm(bodyIdleMs); });
      const prefix = await take(4);
      const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0);
      if (length > MAX_HEADER_BYTES) throw new Error('header too large');
      const header = JSON.parse(DEC.decode(await take(length)));
      if (!header || typeof header !== 'object') throw new Error('bad header');
      if (header.ok !== true) {
        const error = typeof header.error === 'string' ? header.error : 'unreachable';
        if (error === 'unauthorized' && token === sent) token = null;
        return { ok: false, error };
      }
      if (!Number.isSafeInteger(header.size) || header.size < 0) throw new Error('bad body size');
      bodyIdleMs = idleMs;
      arm(idleMs);
      const body = await take(header.size);
      return { ok: true, header, body };
    } catch (e) {
      return { ok: false, error: failure || 'unreachable' };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { if (reader) reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
    }
  }

  /** Fetches [total] bytes as 1 MiB ranges of [base]; onProgress(loadedBytes) after each range. */
  async function fetchRanges(base, total, signal, onProgress) {
    const parts = [];
    let loaded = 0;
    do {
      const length = Math.min(CHUNK_BYTES, total - loaded);
      const res = await transfer({ ...base, offset: loaded, length }, { signal });
      if (!res.ok) return { ok: false, error: res.error };
      if (res.body.length !== length) return { ok: false, error: 'unreachable' };
      parts.push(res.body);
      loaded += length;
      if (onProgress) onProgress(loaded);
    } while (loaded < total);
    return { ok: true, blob: new Blob(parts, { type: 'application/octet-stream' }) };
  }

  /**
   * Uploads [file] to the meeting folder: share-upload-start, one share-upload-chunk per chunk (one stream at a time),
   * share-upload-finish. onProgress(bytesSent) follows the bytes handed to the stream. Resolves {ok:true, name} (the final
   * name chosen by the IFP) or {ok:false, error} with the IFP's error code, 'aborted' or 'unreachable'. When [signal]
   * fires, a share-upload-cancel is sent so the IFP drops the partial file at once.
   */
  async function upload(file, signal, onProgress, onFinishing) {
    // start is sent without [signal]: a cancel before its reply waits for the id so the cancel can still be sent.
    const begun = await transfer({ type: 'share-upload-start', name: file.name, size: file.size });
    if (!begun.ok) return begun;
    const id = begun.header.id;
    if (typeof id !== 'string') return { ok: false, error: 'failed' };
    const cancel = () => transfer({ type: 'share-upload-cancel', id }, { timeoutMs: UPLOAD_CANCEL_MS });
    const cancelQuietly = () => { cancel().catch(() => {}); };
    if (signal && signal.aborted) {
      await cancel();
      return { ok: false, error: 'aborted' };
    }
    const chunk = begun.header.chunk;
    if (!Number.isSafeInteger(chunk) || chunk <= 0) {
      await cancel();
      return { ok: false, error: 'failed' };
    }
    const step = Math.min(chunk, UPLOAD_CHUNK_MAX_BYTES);
    let received = 0;
    while (received < file.size) {
      const base = received;
      const end = Math.min(base + step, file.size);
      let res;
      try {
        res = await transfer(
          { type: 'share-upload-chunk', id, offset: base },
          {
            signal,
            frame: file.slice(base, end),
            timeoutMs: UPLOAD_WRITE_IDLE_MS,
            replyMs: UPLOAD_REPLY_MS,
            onSent: (sent) => { if (onProgress) onProgress(base + sent); },
          },
        );
      } catch (e) {
        cancelQuietly();
        return { ok: false, error: 'failed' };
      }
      if (!res.ok) {
        if (res.error === 'aborted') await cancel();
        else cancelQuietly();
        return res;
      }
      if (res.header.received !== end) {
        await cancel();
        return { ok: false, error: 'failed' };
      }
      received = end;
      if (onProgress) onProgress(received);
    }
    if (signal && signal.aborted) {
      await cancel();
      return { ok: false, error: 'aborted' };
    }
    // Once finish is sent the file may already be stored, so it is not tied to [signal] and cannot be cancelled.
    if (onFinishing) onFinishing();
    const done = await transfer({ type: 'share-upload-finish', id });
    if (!done.ok) return done;
    return { ok: true, name: typeof done.header.name === 'string' ? done.header.name : file.name };
  }

  const share = {
    uploadMaxBytes: UPLOAD_MAX_BYTES,
    upload,
    version: (signal) => transfer({ type: 'share-version' }, { signal, timeoutMs: POLL_TIMEOUT_MS }),
    list: (signal) => transfer({ type: 'share-list' }, { signal }),
    thumb: (path, signal) => transfer({ type: 'share-thumb', path }, { signal }),
    clip: (signal) => transfer({ type: 'share-clip' }, { signal }),
    download: (file, signal, onProgress) =>
      fetchRanges({ type: 'share-file', path: file.path, size: file.size, mtime: file.mtime }, file.size, signal, onProgress),
    clipImage: (clip, signal, onProgress) =>
      fetchRanges({ type: 'share-clip-image', seq: clip.seq }, clip.size, signal, onProgress),
  };

  // Signaling for RtcCast: invite(w, h, sdp, onId) / end(id).
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

  // Signaling for Whep: view(sdp) -> {ok, status, id, sdp} / end(id).
  const viewSignaling = {
    async view(sdp) {
      if (!token) return { ok: false, status: 'unauthorized' };
      const res = await request({ type: 'view', token, sdp });
      if (res.ok === true && typeof res.id === 'string' && typeof res.sdp === 'string') {
        return { ok: true, status: 'ok', id: res.id, sdp: res.sdp };
      }
      if (res.error === 'unauthorized') token = null;
      return { ok: false, status: String(res.error || 'failed') };
    },
    async end(id) {
      if (!token) return;
      const res = await request({ type: 'view-end', token, id });
      if (res.error === 'unauthorized') token = null;
      console.log(`[wt] view-end -> ${res.ok ? 'ok' : res.error}`);
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
    ping,
    onNoMeeting: (handler) => { noMeetingHandler = handler; },
    hasToken: () => token !== null,
    logout: () => { token = null; },
    share,
    signaling,
    viewSignaling,
    startKeepalive,
    stopKeepalive,
  };
})();
