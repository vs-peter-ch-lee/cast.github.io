// Page wiring: two main buttons, diagnostics, status line, PIN gate for casting and watching.
// Direction logic lives in whep.js (IFP -> PC) and rtccast.js (PC -> IFP), both WebRTC.
//
// This page is only served from GitHub Pages and talks to one IFP over WebTransport (wt.js), chosen by ?ip=<IFP IPv4>
// (the IFP's :8080 entry page links here). The PIN token is kept in memory only. On load the page pings the IFP:
// without a meeting everything is disabled and it shows "no meeting" (no automatic retry, reload to check again).
// Both directions need a PIN login first.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    receiveBtn: $('receiveBtn'), stopReceiveBtn: $('stopReceiveBtn'), receiveStats: $('receiveStats'),
    castBtn: $('castBtn'), stopCastBtn: $('stopCastBtn'), castStats: $('castStats'), castHint: $('castHint'),
    receiveIdle: $('receiveIdle'), receiveWrap: $('receiveWrap'), receiveStage: $('receiveStage'), receiveVideo: $('receiveVideo'),
    unmuteBtn: $('unmuteBtn'), fullscreenBtn: $('fullscreenBtn'),
    status: $('status'), stateRow: $('stateRow'), ifpAddr: $('ifpAddr'),
    pinView: $('pinView'), pinInput: $('pinInput'), pinError: $('pinError'), pinCancelBtn: $('pinCancelBtn'), pinBtn: $('pinBtn'),
  };
  let receiving = false;
  let casting = false;

  // ---- mode ---------------------------------------------------------------------------------
  const query = new URLSearchParams(location.search);
  const wtMode = query.has('ip');
  const wtIp = wtMode ? Wt.parseIp(query.get('ip')) : null; // null = missing or invalid
  if (wtIp) Wt.init(wtIp);

  // ---- static text / environment ------------------------------------------------------------
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-Hant';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  ui.ifpAddr.textContent = wtIp || '';
  const canCast = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (ui.fullscreenBtn && !document.fullscreenEnabled) ui.fullscreenBtn.hidden = true;

  // ---- controls -----------------------------------------------------------------------------
  let fatalText = '';
  if (!wtMode) fatalText = t('needIfpEntry');
  else if (!wtIp) fatalText = t('badIp');
  else if (typeof WebTransport === 'undefined') fatalText = t('noWebTransport');
  let blockedText = ''; // no meeting / meeting ended: everything stays disabled until the page is reloaded
  let checking = false;

  function showHint(text) {
    ui.castHint.textContent = text;
    ui.castHint.hidden = false;
  }

  function applyControls() {
    const locked = !!fatalText || !!blockedText || checking;
    ui.receiveBtn.disabled = locked;
    ui.castBtn.disabled = locked || !canCast;
  }

  if (fatalText) showHint(fatalText);
  else if (!canCast) showHint(t('noDisplayMedia'));
  applyControls();

  // ---- status line --------------------------------------------------------------------------
  let message = '';
  function renderStatus() {
    if (blockedText) {
      ui.status.textContent = blockedText;
      ui.stateRow.dataset.state = 'notice';
    } else if (message) {
      ui.status.textContent = message;
      ui.stateRow.dataset.state = 'notice';
    } else if (casting) {
      ui.status.textContent = t('stateCasting');
      ui.stateRow.dataset.state = 'casting';
    } else if (receiving) {
      ui.status.textContent = t('stateReceiving');
      ui.stateRow.dataset.state = 'receiving';
    } else {
      ui.status.textContent = t('stateIdle');
      ui.stateRow.dataset.state = 'idle';
    }
    document.body.dataset.state = ui.stateRow.dataset.state; // style.css keys the Pages card on it
  }
  /** Shows [text] (an end reason or error); '' falls back to the current state (idle / casting / receiving). */
  function setStatus(text) { message = text || ''; renderStatus(); }

  function setReceiving(on) {
    receiving = on;
    ui.receiveIdle.hidden = on;
    ui.stopReceiveBtn.hidden = !on;
    ui.receiveWrap.hidden = !on;
    ui.receiveVideo.hidden = !on;
    ui.unmuteBtn.hidden = !on;
    if (on) ui.receiveVideo.muted = true;
    if (!on) {
      ui.receiveStats.textContent = '';
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
    renderStatus();
  }

  function setCasting(on) {
    casting = on;
    ui.castBtn.hidden = on;
    ui.stopCastBtn.hidden = !on;
    if (!on) ui.castStats.textContent = '';
    // Keep the IFP-side handshake alive while casting; a dropped connection does not end the cast.
    if (on) Wt.startKeepalive();
    else Wt.stopKeepalive();
    renderStatus();
  }

  function endReceive(reasonText) {
    if (!receiving) return;
    Whep.stop();
    setReceiving(false);
    setStatus(reasonText);
  }

  function endCast(reasonText) {
    if (!casting) return;
    RtcCast.stop();
    setCasting(false);
    setStatus(reasonText);
  }

  ui.unmuteBtn.onclick = () => {
    ui.receiveVideo.muted = false;
    ui.receiveVideo.play().catch(() => {});
    ui.unmuteBtn.hidden = true;
  };
  ui.fullscreenBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else ui.receiveStage.requestFullscreen().catch(() => {});
  };

  // ---- PIN gate (casting and watching) -----------------------------------------------------
  let pinAction = null; // 'cast' | 'receive': what to start once the PIN is accepted

  /** Shows the PIN form for [action]. Casting is stopped for 'cast' only; nothing is shown once the meeting is over. */
  function showPin(errorText, action) {
    if (blockedText) return;
    pinAction = action;
    if (action === 'cast') {
      endCast('');
      ui.castBtn.hidden = true;
    }
    ui.pinView.hidden = false;
    ui.pinError.textContent = errorText || '';
    ui.pinInput.value = '';
    ui.pinView.scrollIntoView({ block: 'nearest' });
    ui.pinInput.focus();
  }

  function hidePin() {
    pinAction = null;
    ui.pinView.hidden = true;
    ui.pinError.textContent = '';
    ui.castBtn.hidden = casting;
  }

  /** The IFP has no meeting (never started, or ended): show [text], hide the PIN form, disable the controls. Media is not touched here. */
  function setNoMeeting(text) {
    blockedText = text;
    loginSeq++;
    hidePin();
    showHint(text);
    applyControls();
    renderStatus();
  }
  // A no_meeting reply never replaces a text already shown (e.g. "Meeting ended" from the notice).
  Wt.onNoMeeting(() => { if (!blockedText) setNoMeeting(t('noMeeting')); });

  /** The IFP sent its end-of-meeting notice over a 'meeting' DataChannel: stop watching and casting. */
  function meetingEnded() {
    if (receiving) {
      Whep.stop();
      setReceiving(false);
    }
    if (casting) {
      RtcCast.stop();
      setCasting(false);
    }
    setNoMeeting(t('meetingEnded'));
  }

  /** After a failed cast start: if the login is no longer valid (an unauthorized invite dropped the token), ask again. */
  function recheckAuth() {
    if (!Wt.hasToken()) showPin(t('pinChanged'), 'cast');
  }

  let loginSeq = 0; // bumped by every submit, by cancel and by no-meeting; a stale login result is ignored
  ui.pinView.onsubmit = async (ev) => {
    ev.preventDefault();
    const pin = ui.pinInput.value.trim();
    if (!/^[0-9]{6}$/.test(pin)) {
      ui.pinError.textContent = t('pinInvalid');
      return;
    }
    // WebTransport can wait a long time here (the browser's local-network permission prompt): show progress.
    const seq = ++loginSeq;
    const okLabel = ui.pinBtn.textContent;
    ui.pinBtn.disabled = true;
    ui.pinBtn.textContent = t('connecting');
    ui.pinError.textContent = '';
    try {
      const ok = (await Wt.login(pin)).ok;
      if (seq !== loginSeq) return; // cancelled while waiting
      if (ok) {
        const action = pinAction;
        hidePin();
        if (action === 'receive') {
          startReceive();
        } else if (navigator.userActivation && !navigator.userActivation.isActive) {
          // Screen capture needs a fresh click. A long wait (permission prompt) can use it up: ask for one more click.
          setStatus(t('connectedClickCast'));
          ui.castBtn.focus();
        } else {
          startCast();
        }
      } else {
        ui.pinError.textContent = t('pinWrong');
        ui.pinInput.select();
      }
    } catch (e) {
      if (seq !== loginSeq) return;
      ui.pinError.textContent = (e && e.message) || t('connectFail');
    } finally {
      ui.pinBtn.disabled = false;
      ui.pinBtn.textContent = okLabel;
    }
  };
  ui.pinCancelBtn.onclick = () => { loginSeq++; hidePin(); };

  // ---- meeting check on load ----------------------------------------------------------------
  async function checkMeeting() {
    checking = true;
    applyControls();
    setStatus(t('connecting'));
    try {
      const res = await Wt.ping();
      setStatus('');
      if (res.meeting === false) setNoMeeting(t('noMeeting'));
    } catch (e) {
      setStatus((e && e.message) || t('connectFail'));
    } finally {
      checking = false;
      applyControls();
    }
  }
  if (!fatalText) checkMeeting();

  // ---------------------------------------------------------------------------------------

  async function startReceive() {
    setStatus('');
    setReceiving(true);
    try {
      await Whep.start({
        stats: ui.receiveStats,
        video: ui.receiveVideo,
        signaling: Wt.viewSignaling,
        onEnded: (text) => endReceive(text),
        onMeetingEnded: meetingEnded,
      });
    } catch (e) {
      if (e && e.code === 'unauthorized') {
        endReceive('');
        showPin(t('pinChanged'), 'receive');
      } else {
        endReceive(tMsg((e && e.message) || String(e)));
      }
    }
  }

  ui.receiveBtn.onclick = () => {
    if (Wt.hasToken()) startReceive();
    else showPin(t('pinRequired'), 'receive');
  };
  ui.stopReceiveBtn.onclick = () => endReceive('');

  async function startCast() {
    setStatus('');
    setCasting(true);
    try {
      await RtcCast.start({
        stats: ui.castStats,
        onEnded: (text) => endCast(tMsg(text)),
        onMeetingEnded: meetingEnded,
        signaling: Wt.signaling,
      });
    } catch (e) {
      endCast(tMsg((e && e.message) || String(e)));
      recheckAuth();
    }
  }

  ui.castBtn.onclick = () => {
    if (Wt.hasToken()) startCast();
    else showPin('', 'cast');
  };
  ui.stopCastBtn.onclick = () => endCast('');

  renderStatus();
})();
