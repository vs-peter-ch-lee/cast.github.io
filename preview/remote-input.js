// Remote control (PC -> IFP) over the WebRTC DataChannels opened by whep.js.
// Pure helpers (imageRect / mapPoint / wheelPixels / stepWheel / msg*) plus attach(), which wires pointer, wheel and
// keyboard listeners on the receive <video>. Protocol: JSON strings; x/y are 0..1 ratios inside the actual
// image rectangle (object-fit: contain letterbox removed); "s" is the press sequence number.
'use strict';

const RemoteInput = (() => {
  const PX_PER_NOTCH = 100;
  const MAX_NOTCHES = 5;
  let seq = 0; // press sequence, monotonic for the life of the page

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const round5 = (v) => Math.round(v * 100000) / 100000;

  /** Image rectangle inside a boxW x boxH element for a vw x vh video with object-fit: contain, or null. */
  function imageRect(boxW, boxH, vw, vh) {
    if (!(boxW > 0 && boxH > 0 && vw > 0 && vh > 0)) return null;
    const scale = Math.min(boxW / vw, boxH / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { left: (boxW - w) / 2, top: (boxH - h) / 2, width: w, height: h };
  }

  /**
   * Client point -> {x, y} ratios in the image rectangle. box = element getBoundingClientRect().
   * Outside the image (letterbox): null, or the clamped edge point when clamp is true.
   */
  function mapPoint(box, vw, vh, clientX, clientY, clamp) {
    const img = imageRect(box.width, box.height, vw, vh);
    if (!img) return null;
    const fx = (clientX - box.left - img.left) / img.width;
    const fy = (clientY - box.top - img.top) / img.height;
    if (!clamp && (fx < 0 || fx > 1 || fy < 0 || fy > 1)) return null;
    return { x: round5(clamp01(fx)), y: round5(clamp01(fy)) };
  }

  /** Wheel deltaY -> pixels (positive = down). Line mode: 1 line = 1 notch; page mode: 1 page = MAX_NOTCHES notches. */
  function wheelPixels(deltaY, deltaMode) {
    return deltaMode === 1 ? deltaY * PX_PER_NOTCH : deltaMode === 2 ? deltaY * PX_PER_NOTCH * MAX_NOTCHES : deltaY;
  }

  /**
   * One wheel step: acc = pixels carried over (|acc| < PX_PER_NOTCH), px = this event's pixels.
   * Returns { d, acc }: d = whole notches to send (integer in -5..5, 0 = none; positive = down), acc = new carry.
   * Opposite-direction carry is dropped. An event that alone spans a notch (mouse wheel tick) is sent as
   * floor(px / notch) with no carry; a touchpad's many small events accumulate until a full notch.
   */
  function stepWheel(acc, px) {
    if (acc && Math.sign(acc) !== Math.sign(px)) acc = 0;
    const sign = Math.sign(px);
    if (Math.abs(px) >= PX_PER_NOTCH) {
      return { d: sign * Math.min(MAX_NOTCHES, Math.floor(Math.abs(px) / PX_PER_NOTCH + 1e-9)), acc: 0 };
    }
    acc += px;
    const n = Math.floor(Math.abs(acc) / PX_PER_NOTCH + 1e-9);
    return { d: sign * n, acc: n ? acc - sign * n * PX_PER_NOTCH : acc };
  }

  const msgDown = (s, p) => JSON.stringify({ t: 'down', s, x: p.x, y: p.y });
  const msgMove = (s, p) => JSON.stringify({ t: 'move', s, x: p.x, y: p.y });
  const msgUp = (s, p) => JSON.stringify({ t: 'up', s, x: p.x, y: p.y });
  const msgBack = () => JSON.stringify({ t: 'back' });
  const msgScroll = (p, d) => JSON.stringify({ t: 'scroll', x: p.x, y: p.y, d });
  const msgKey = (a, c) => JSON.stringify({ t: 'key', a, c });
  const msgReset = () => JSON.stringify({ t: 'reset' });

  /**
   * Starts forwarding input on [video]. io = { ctl, mv }: RTCDataChannels, used only while open.
   * Returns detach(), which removes every listener and drops all state.
   */
  function attach(video, io) {
    let press = null;   // { id, s, last } while the left button is held and its down was sent
    let pending = null; // latest unsent move
    let raf = 0;
    const downKeys = new Set(); // codes sent down and not yet up
    let meta = false;           // last observed e.metaKey on a key event
    let wheelAcc = 0;           // wheel pixels not yet sent as a whole notch (|wheelAcc| < PX_PER_NOTCH)

    const open = (ch) => !!ch && ch.readyState === 'open';
    const sendCtl = (m) => { if (open(io.ctl)) { io.ctl.send(m); return true; } return false; };
    const sendMv = (m) => { if (open(io.mv)) io.mv.send(m); };
    const point = (e, clamp) => mapPoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight,
      e.clientX, e.clientY, clamp);

    function clearPress() {
      if (press) {
        try { video.releasePointerCapture(press.id); } catch (e) { /* not captured */ }
      }
      press = null;
      pending = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    function reset() {
      clearPress();
      downKeys.clear();
      meta = false;
      wheelAcc = 0;
      sendCtl(msgReset());
    }

    function flushMove() {
      raf = 0;
      if (press && pending) sendMv(msgMove(press.s, pending));
      pending = null;
    }

    function onPointerDown(e) {
      if (!e.isPrimary) return;
      if (e.button === 0) {
        if (press) return;
        const p = point(e, false);
        if (!p || !open(io.ctl)) return; // letterbox or channel not open: no press
        const s = ++seq;
        sendCtl(msgDown(s, p));
        press = { id: e.pointerId, s };
        try { video.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      } else if (e.button === 2) {
        if (point(e, false)) sendCtl(msgBack());
      }
      // middle button: ignored
    }

    // Left button no longer in e.buttons: finish the press with up (reset if the point cannot be mapped).
    function endPress(e) {
      const p = point(e, true);
      const s = press.s;
      clearPress();
      sendCtl(p ? msgUp(s, p) : msgReset());
    }

    function onPointerMove(e) {
      if (!press || e.pointerId !== press.id) return;
      if (!(e.buttons & 1)) { endPress(e); return; }
      const p = point(e, true);
      if (!p) return;
      pending = p;
      if (!raf) raf = requestAnimationFrame(flushMove);
    }

    function onPointerUp(e) {
      if (!press || e.pointerId !== press.id || (e.buttons & 1)) return;
      endPress(e);
    }

    function onWheel(e) {
      e.preventDefault();
      const p = point(e, false);
      if (!p) { wheelAcc = 0; return; } // letterbox / outside the image: no scroll, carry dropped
      const px = wheelPixels(e.deltaY, e.deltaMode);
      if (!px) return;
      const r = stepWheel(wheelAcc, px);
      wheelAcc = r.acc;
      if (r.d) sendCtl(msgScroll(p, r.d));
    }

    // macOS does not deliver keyup for other keys while Cmd (Meta) is held. Meta and Meta combos are browser
    // or OS shortcuts and are not forwarded; when Meta is released, keys already sent down get their up.
    function releaseKeys() {
      downKeys.forEach((c) => sendCtl(msgKey('up', c)));
      downKeys.clear();
    }

    function onKey(action) {
      return (e) => {
        const wasMeta = meta;
        meta = !!e.metaKey;
        if (wasMeta && !meta) releaseKeys();
        if (!e.code) return;
        // IME composition: keydown is not sent, but a key already sent down always gets its keyup.
        if ((e.isComposing || e.keyCode === 229) && !(action === 'up' && downKeys.has(e.code))) return;
        if (e.metaKey || e.code === 'MetaLeft' || e.code === 'MetaRight') return;
        e.preventDefault();
        if (action === 'down') downKeys.add(e.code); else downKeys.delete(e.code);
        sendCtl(msgKey(action, e.code));
      };
    }
    const onKeyDown = onKey('down');
    const onKeyUp = onKey('up');

    const onContextMenu = (e) => e.preventDefault();
    const onHidden = () => { if (document.visibilityState === 'hidden') reset(); };

    const videoListeners = [
      ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerUp],
      ['pointercancel', reset], ['contextmenu', onContextMenu], ['wheel', onWheel, { passive: false }],
      ['keydown', onKeyDown], ['keyup', onKeyUp], ['blur', reset],
    ];
    videoListeners.forEach(([n, f, o]) => video.addEventListener(n, f, o));
    window.addEventListener('blur', reset);
    window.addEventListener('pagehide', reset);
    document.addEventListener('visibilitychange', onHidden);

    return function detach() {
      videoListeners.forEach(([n, f, o]) => video.removeEventListener(n, f, o));
      window.removeEventListener('blur', reset);
      window.removeEventListener('pagehide', reset);
      document.removeEventListener('visibilitychange', onHidden);
      clearPress();
    };
  }

  return { attach };
})();
