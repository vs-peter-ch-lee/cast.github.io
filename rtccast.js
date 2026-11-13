// PC -> IFP over WebRTC (WHIP-style, non-trickle): POST /rtc/whip?w=&h= with offer, 201 + answer.
// Signaling is pluggable: the default is the HTTP WHIP above; wt.js supplies the same invite/end pair over
// WebTransport (ctx.signaling). The media path is identical either way.
'use strict';

const RtcCast = (() => {
  const MAX_W = 1920;
  const MAX_H = 1080;
  // Chrome caps 1080p video at about 2.5 Mbps by default; raise to 6 Mbps.
  const VIDEO_MAX_BITRATE = 6000000;
  const CONNECT_TIMEOUT_MS = 15000;
  const DIAG_MS = 10000;
  const FAIL_TEXT = t('connectFail');
  const ENDED_TEXT = t('castEnded');
  const DELETE_WAIT_MS = 2000;

  let run = null;
  const t0 = () => (run ? ((performance.now() - run.t0) / 1000).toFixed(2) : '0');
  const log = (msg) => console.log(`[rtccast +${t0()}s] ${msg}`);

  function preferH264(transceiver) {
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !transceiver.setCodecPreferences) return;
    const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    if (!h264.length) return;
    const mode1 = h264.filter((c) => /packetization-mode=1/.test(c.sdpFmtpLine || ''));
    const rest = caps.codecs.filter((c) => !h264.includes(c));
    transceiver.setCodecPreferences([...mode1, ...h264.filter((c) => !mode1.includes(c)), ...rest]);
  }

  /**
   * Default signaling: HTTP WHIP on the page's own origin (cookie auth).
   * invite(w, h, sdp, onId) -> {ok, status, id, sdp}; onId(id) fires as soon as the id is known. end(id) releases it.
   */
  const HTTP_SIGNALING = {
    async invite(w, h, sdp, onId) {
      const resp = await fetch(`/rtc/whip?w=${w}&h=${h}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        credentials: 'same-origin',
        body: sdp,
      });
      const ok = resp.status === 201;
      const id = ok ? resp.headers.get('Location') : null;
      if (ok && onId) onId(id);
      return { ok, status: resp.status, id, sdp: await resp.text() };
    },
    async end(id) {
      const res = await fetch(id, { method: 'DELETE', credentials: 'same-origin' });
      log(`DELETE -> ${res.status}`);
    },
  };

  /** Resolves when [p] settles (either way) or after [ms], whichever comes first. */
  function settleWithin(p, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      p.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Ends the run exactly once. text = status passed to onEnded; null = no notification (caller already
   * handles it). Order: DELETE the IFP-side session and wait for the reply (max DELETE_WAIT_MS), then
   * pc.close() and stop capture. The UI is notified at once. DELETE of a replaced id answering 404 is normal.
   */
  async function finish(r, reason, text) {
    if (r.finished) return;
    r.finished = true;
    log(`end: ${reason}`);
    clearTimeout(r.connectTimer);
    clearInterval(r.diagTimer);
    if (run === r) run = null;
    if (text !== null) r.ctx.onEnded(text);
    try {
      // POST still in flight: its answer carries the id we need to release.
      if (!r.id && r.posting) await settleWithin(r.posting, DELETE_WAIT_MS);
      if (r.id) {
        log(`end ${r.id}`);
        r.deleteSent = true;
        await settleWithin(r.sig.end(r.id), DELETE_WAIT_MS);
      }
    } finally {
      r.deleteDone = true;
      try { if (r.pc) r.pc.close(); } catch (e) { /* ignore */ }
      if (r.stream) r.stream.getTracks().forEach((tr) => tr.stop());
    }
  }

  async function diag(r) {
    const stats = await r.pc.getStats();
    let pairId = null;
    let out = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    });
    const pair = pairId && stats.get(pairId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    const local = pair && stats.get(pair.localCandidateId);
    const proto = (local && local.protocol) || (remote && remote.protocol) || '?';
    let kbps = '?';
    let fps = '?';
    let tgt = '?';
    let srcFps = '?';
    let srcFrames = '?';
    let encFps = '?';
    let encMs = '?';
    let qlr = '?';
    let qld = '?';
    if (out) {
      if (typeof out.targetBitrate === 'number') tgt = Math.round(out.targetBitrate);
      if (typeof out.framesPerSecond === 'number') encFps = out.framesPerSecond.toFixed(1);
      if (out.qualityLimitationReason) qlr = out.qualityLimitationReason;
      if (out.qualityLimitationDurations) {
        qld = Object.entries(out.qualityLimitationDurations).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(',');
      }
      if (r.last && typeof out.totalEncodeTime === 'number' && typeof r.last.encTime === 'number'
          && out.framesEncoded > r.last.frames) {
        encMs = (((out.totalEncodeTime - r.last.encTime) / (out.framesEncoded - r.last.frames)) * 1000).toFixed(1);
      }
      if (r.last) {
        const dt = (out.timestamp - r.last.timestamp) / 1000;
        if (dt > 0) {
          kbps = (((out.bytesSent - r.last.bytes) * 8) / dt / 1000).toFixed(0);
          if (typeof out.framesEncoded === 'number' && typeof r.last.frames === 'number') {
            fps = ((out.framesEncoded - r.last.frames) / dt).toFixed(1);
          }
        }
      }
      if (typeof out.framesPerSecond === 'number') fps = out.framesPerSecond.toFixed(1);
      r.last = { bytes: out.bytesSent || 0, timestamp: out.timestamp, frames: out.framesEncoded, encTime: out.totalEncodeTime };
    }
    stats.forEach((s) => {
      if (s.type === 'media-source' && s.kind === 'video') {
        if (typeof s.framesPerSecond === 'number') srcFps = s.framesPerSecond.toFixed(1);
        if (typeof s.frames === 'number') srcFrames = s.frames;
      }
    });
    const el = Math.round((performance.now() - r.t0) / 1000);
    const line = `t=${el}s pair=${proto} ${remote ? remote.address : '?'} ${remote ? remote.candidateType : '?'}`
      + ` video=${out ? `${out.frameWidth}x${out.frameHeight}` : '?'} bitrate=${kbps}kbps fps=${fps}`
      + ` tgt=${tgt} srcFps=${srcFps} srcFrames=${srcFrames} encFps=${encFps} encMsPerFrame=${encMs} qlr=${qlr} qld=${qld}`;
    console.log(`[rtccast] ${line}`);
    r.ctx.stats.textContent = line;
  }

  /** ctx: { stats: element, onEnded(text), signaling?: {invite, end} (default HTTP WHIP) }. Resolves once the POST/answer exchange is done; rejects Error(text) on failure. */
  async function start(ctx) {
    if (run) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('此瀏覽器不支援分享畫面');
    }
    const r = {
      ctx, sig: ctx.signaling || HTTP_SIGNALING, t0: performance.now(),
      finished: false, id: null, pc: null, stream: null, last: null,
    };
    run = r;
    ctx.stats.textContent = '請選擇要分享的分頁';

    try {
      r.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser',
          width: { max: MAX_W },
          height: { max: MAX_H },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
        },
        systemAudio: 'include',
      });
    } catch (e) {
      finish(r, 'getDisplayMedia failed', null);
      throw new Error(e && e.name === 'NotAllowedError' ? '已取消分享' : `無法分享畫面：${(e && e.message) || e}`);
    }
    if (r.finished) { // 停止 pressed while the picker was open
      r.stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const failed = (reason) => {
      finish(r, reason, null);
      return new Error(FAIL_TEXT);
    };
    try {
      const videoTrack = r.stream.getVideoTracks()[0];
      const audioTrack = r.stream.getAudioTracks()[0] || null;
      videoTrack.addEventListener('ended', () => finish(r, 'video track ended', ''));

      const pc = new RTCPeerConnection({ iceServers: [] });
      r.pc = pc;
      window.__rtcCast = pc;
      const vSender = pc.addTrack(videoTrack, r.stream);
      const vp = vSender.getParameters();
      vp.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      await vSender.setParameters(vp);
      if (audioTrack) pc.addTrack(audioTrack, r.stream);
      const vTrans = pc.getTransceivers().find((t) => t.sender === vSender);
      if (vTrans) preferH264(vTrans);

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        log(`connectionState=${s}`);
        if (s === 'connected') {
          if (r.connected) return;
          r.connected = true;
          clearTimeout(r.connectTimer);
          r.diagTimer = setInterval(() => { diag(r).catch(() => {}); }, DIAG_MS);
        } else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
          finish(r, `connectionState ${s}`, ENDED_TEXT);
        }
      };
      r.connectTimer = setTimeout(() => {
        if (!r.connected) {
          log('connect timeout 15s');
          finish(r, 'connect timeout', FAIL_TEXT);
        }
      }, CONNECT_TIMEOUT_MS);

      await pc.setLocalDescription(await pc.createOffer());
      await gatheringComplete(pc);
      if (r.finished) return;

      const s = videoTrack.getSettings();
      const w = s.width || MAX_W;
      const h = s.height || MAX_H;
      log(`invite w=${w} h=${h}`);
      r.posting = r.sig.invite(w, h, pc.localDescription.sdp, (id) => { r.id = id; });
      const res = await r.posting;
      if (r.finished) {
        // Ended while the invite was in flight and finish() stopped waiting for it: release the IFP side now.
        if (r.id && r.deleteDone && !r.deleteSent) {
          r.sig.end(r.id).catch(() => {});
        }
        return;
      }
      log(`response ${res.status}`);
      if (!res.ok) throw failed(`invite status ${res.status}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } catch (e) {
      if (r.finished) {
        if (e && e.message === FAIL_TEXT) throw e;
        return;
      }
      throw failed(`error ${(e && e.message) || e}`);
    }
  }

  /** User pressed 停止 (or app resets). Safe to call at any time. */
  function stop() {
    if (run) finish(run, 'user stop', null);
  }

  return { start, stop };
})();
