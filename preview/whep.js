// IFP -> PC over WebRTC (non-trickle). Signaling is injected (ctx.signaling, Wt.viewSignaling): view(sdp) sends
// the offer SDP and resolves the answer, end(id) tells the IFP this viewer left when the run ends (Stop, pagehide,
// connection lost). A 'meeting' DataChannel carries the IFP's end-of-meeting notice.
'use strict';

const Whep = (() => {
  const CONNECT_TIMEOUT_MS = 15000;
  const DISCONNECT_GRACE_MS = 5000;

  let run = null;

  /** Tells the IFP this viewer left so it can stop capture at once. Once per run; failures are ignored. */
  function sendEnd(r) {
    const id = r.resource;
    if (!id) return;
    r.resource = null;
    r.ctx.signaling.end(id).catch(() => {});
  }

  /** Tears the run down once. text = passed to onEnded; null = caller handles the UI itself. */
  function end(r, text) {
    if (r.finished) return;
    r.finished = true;
    clearTimeout(r.connectTimer);
    clearTimeout(r.graceTimer);
    clearInterval(r.statsTimer);
    sendEnd(r);
    if (r.detachInput) r.detachInput();
    try { r.pc.close(); } catch (e) { /* ignore */ }
    if (r.ctx.video.srcObject) r.ctx.video.srcObject = null;
    if (run === r) run = null;
    if (text !== null) r.ctx.onEnded(text);
  }

  let last = null;
  async function showStats(r) {
    const stats = await r.pc.getStats();
    let inbound = null;
    stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s; });
    if (!inbound || r.finished) return;
    const frames = inbound.framesDecoded || 0;
    let fps = '?';
    if (last && last.r === r) {
      const dt = (inbound.timestamp - last.timestamp) / 1000;
      if (dt > 0) fps = ((frames - last.frames) / dt).toFixed(1);
    }
    last = { r, frames, timestamp: inbound.timestamp };
    const codec = inbound.codecId && stats.get(inbound.codecId);
    r.ctx.stats.textContent = `WebRTC | ${frames} frames | ${fps} fps | `
      + `${inbound.frameWidth || '?'}x${inbound.frameHeight || '?'} ${codec ? codec.mimeType : ''}`;
  }

  /**
   * ctx: { video: HTMLVideoElement, stats: element, signaling: {view(sdp), end(id)}, onEnded(text), onMeetingEnded() }.
   * Resolves once the offer/answer exchange is done; rejects Error(text) on failure (Error.code = the IFP's error,
   * e.g. 'unauthorized').
   */
  async function start(ctx) {
    stop();
    const pc = new RTCPeerConnection();
    const r = { ctx, pc, finished: false, connected: false };
    run = r;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    // Remote control channels (before createOffer so the SDP carries the data section): ctl = reliable
    // ordered, mv = unordered no-retransmit for move samples.
    const ctl = pc.createDataChannel('ctl');
    const mv = pc.createDataChannel('mv', { ordered: false, maxRetransmits: 0 });
    r.detachInput = RemoteInput.attach(ctx.video, { ctl, mv });
    const meeting = pc.createDataChannel('meeting');
    meeting.onmessage = (e) => {
      if (!isMeetingEnded(e.data) || r.finished) return;
      r.meetingEnded = true;
      r.resource = null;
      end(r, null);
      ctx.onMeetingEnded();
    };
    // Video and audio share one msid, so both tracks land in one stream; keep a single srcObject.
    pc.ontrack = (e) => {
      const video = ctx.video;
      const stream = e.streams[0];
      if (stream) {
        if (video.srcObject !== stream) video.srcObject = stream;
      } else if (video.srcObject) {
        video.srcObject.addTrack(e.track);
      } else {
        video.srcObject = new MediaStream([e.track]);
      }
      video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        r.connected = true;
        clearTimeout(r.connectTimer);
        clearTimeout(r.graceTimer);
        if (!r.statsTimer) r.statsTimer = setInterval(() => { showStats(r).catch(() => {}); }, 1000);
      } else if (s === 'disconnected') {
        r.graceTimer = setTimeout(() => end(r, t('receiveEnded')), DISCONNECT_GRACE_MS);
      } else if (s === 'failed' || s === 'closed') {
        end(r, t('receiveEnded'));
      }
    };
    r.connectTimer = setTimeout(() => {
      if (!r.connected) end(r, t('connectFail'));
    }, CONNECT_TIMEOUT_MS);

    let refused = null;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gatheringComplete(pc);
      if (r.finished) return;
      const res = await ctx.signaling.view(pc.localDescription.sdp);
      if (res.ok && !r.meetingEnded) r.resource = res.id;
      if (r.finished) {
        sendEnd(r); // stopped while the request was in flight: the IFP already has this viewer
        return;
      }
      if (!res.ok) {
        refused = new Error(t('receiveFailed', res.status));
        refused.code = res.status;
        throw refused;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } catch (e) {
      if (r.finished) return; // stopped while signaling: nothing to report
      end(r, null);
      throw refused || new Error(t('connectFail'));
    }
  }

  /** User pressed Stop (or app resets). Idempotent. */
  function stop() {
    if (run) end(run, null);
  }

  // Closing the tab or leaving the page ends the run (and tells the IFP).
  window.addEventListener('pagehide', stop);

  return { start, stop };
})();
