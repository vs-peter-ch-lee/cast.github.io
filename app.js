// Page wiring: role choice (speaker / audience), PIN gate, meeting page (one main button, the shared area, diagnostics).
// Direction logic lives in whep.js (IFP -> PC, audience) and rtccast.js (PC -> IFP, speaker), both WebRTC;
// the shared area is share.js.
//
// This page is only served from GitHub Pages and talks to one IFP over WebTransport (wt.js), chosen by ?ip=<IFP IPv4>
// (the IFP's :8080 entry page links here). The PIN token is kept in memory only. On load the page pings the IFP:
// when it cannot be reached (no meeting: the IFP does not listen) or reports no meeting, the role buttons are disabled
// and the entry shows the "cannot reach" text under the title (no automatic retry, reload to check again).
// The same text is shown when the IFP becomes unreachable while the page is in use;
// a "Meeting ended" text already shown is never replaced.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    status: $('status'), title: $('title'), notice: $('notice'), intro: $('intro'), ifpAddr: $('ifpAddr'),
    entry: $('entry'), roles: $('roles'), gate: $('gate'), pin: $('pin'), pinBtn: $('pinBtn'), error: $('error'), back: $('back'),
    room: $('room'), identity: $('identity'), leave: $('leave'), workspaceTitle: $('workspaceTitle'),
    stage: $('stage'), idle: $('idle'), video: $('receiveVideo'), media: $('media'), mediaStatus: $('mediaStatus'),
    unmute: $('unmute'), fullscreen: $('fullscreen'), shareRoot: $('shareRoot'),
    castStats: $('castStats'), receiveStats: $('receiveStats'),
  };
  let speaker = false;
  let receiving = false;
  let casting = false;
  let inRoom = false;

  // ---- mode ---------------------------------------------------------------------------------
  const query = new URLSearchParams(location.search);
  const wtMode = query.has('ip');
  const wtIp = wtMode ? Wt.parseIp(query.get('ip')) : null; // null = missing or invalid
  if (wtIp) Wt.init(wtIp);

  // ---- static text / environment ------------------------------------------------------------
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-Hant';
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  ui.ifpAddr.textContent = wtIp || '-';
  const canCast = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  let fatalText = '';
  if (!wtMode) fatalText = t('needIfpEntry');
  else if (!wtIp) fatalText = t('badIp');
  else if (typeof WebTransport === 'undefined') fatalText = t('noWebTransport');
  let blockedText = ''; // no meeting / meeting ended / unreachable: the role buttons stay disabled until the page is reloaded
  let checking = false;

  // ---- header status ------------------------------------------------------------------------
  function renderStatus() {
    let text;
    let state = 'idle';
    if (inRoom) {
      text = t('statusInMeeting');
      state = 'online';
    } else if (fatalText || blockedText) {
      text = t('statusOffline');
      state = 'notice';
    } else if (checking) {
      text = t('connecting');
    } else {
      text = t('statusReady');
    }
    ui.status.textContent = text;
    ui.status.dataset.state = state;
  }

  // ---- entry --------------------------------------------------------------------------------
  function applyControls() {
    const locked = !!fatalText || !!blockedText || checking;
    ui.roles.querySelectorAll('.role').forEach((b) => { b.disabled = locked; });
  }

  function renderNotice() {
    const text = fatalText || blockedText;
    ui.notice.textContent = text;
    ui.notice.hidden = !text;
    ui.intro.hidden = !!text;
  }

  function showEntry(focusTitle = true) {
    inRoom = false;
    ui.room.hidden = true;
    ui.entry.hidden = false;
    ui.gate.hidden = true;
    ui.roles.hidden = false;
    ui.title.textContent = t('entryTitle');
    ui.intro.textContent = t('entryIntro');
    renderNotice();
    applyControls();
    renderStatus();
    if (focusTitle) ui.title.focus();
  }

  let loginSeq = 0; // bumped by every submit, by back and by leaving; a stale login result is ignored

  function showGate(errorText) {
    inRoom = false;
    ui.room.hidden = true;
    ui.entry.hidden = false;
    ui.roles.hidden = true;
    ui.gate.hidden = false;
    ui.title.textContent = t(speaker ? 'speakerLogin' : 'audienceLogin');
    ui.intro.textContent = t('gateIntro');
    renderNotice();
    ui.pin.value = '';
    setPinError(errorText || '');
    renderStatus();
    ui.pin.focus();
  }

  function setPinError(text) {
    ui.error.textContent = text;
    if (text) ui.pin.setAttribute('aria-invalid', 'true');
    else ui.pin.removeAttribute('aria-invalid');
  }

  ui.roles.querySelectorAll('.role').forEach((button) => {
    button.onclick = () => {
      speaker = button.dataset.speaker === 'yes';
      showGate('');
    };
  });
  ui.back.onclick = () => {
    loginSeq++;
    ui.pinBtn.disabled = false;
    ui.pinBtn.textContent = t('joinMeeting');
    showEntry();
  };

  // ---- meeting page -------------------------------------------------------------------------
  function mediaActive() { return receiving || casting; }

  function renderMedia(message) {
    const on = mediaActive();
    ui.stage.classList.toggle('off', !receiving);
    ui.video.hidden = !receiving;
    ui.idle.hidden = receiving;
    if (speaker) ui.idle.textContent = t(casting ? 'castKeepOpen' : 'speakerIdle');
    else ui.idle.textContent = t('audienceIdle');
    ui.media.textContent = t(speaker ? (on ? 'castStop' : 'castStart') : (on ? 'viewStop' : 'viewStart'));
    ui.media.disabled = speaker && !canCast;
    ui.unmute.hidden = !(receiving && ui.video.muted);
    ui.fullscreen.hidden = !(receiving && document.fullscreenEnabled);
    let text;
    if (message) text = message;
    else if (speaker && !canCast) text = t('noDisplayMedia');
    else if (speaker) text = t(casting ? 'castOn' : 'castOff');
    else text = t(receiving ? 'viewOn' : 'viewOff');
    ui.mediaStatus.textContent = text;
  }

  function enterRoom() {
    inRoom = true;
    ui.identity.textContent = t(speaker ? 'speaker' : 'audience');
    ui.workspaceTitle.textContent = t(speaker ? 'speakerTitle' : 'audienceTitle');
    ui.castStats.textContent = '';
    ui.receiveStats.textContent = '';
    ui.castStats.hidden = !speaker;
    ui.receiveStats.hidden = speaker;
    renderMedia('');
    ui.entry.hidden = true;
    ui.room.hidden = false;
    renderStatus();
    ShareArea.start(ui.shareRoot, { mediaActive, leave: onShareLeave });
    ui.workspaceTitle.focus();
    window.scrollTo(0, 0);
  }

  /** Stops media and the shared area and drops the token, without any status text. */
  function closeMeetingPage() {
    ShareArea.stop();
    if (receiving) {
      Whep.stop();
      receiving = false;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
    if (casting) {
      RtcCast.stop();
      casting = false;
      Wt.stopKeepalive();
    }
    Wt.logout();
  }

  function home() {
    loginSeq++;
    closeMeetingPage();
    showEntry();
  }
  ui.leave.onclick = home;

  /** The IFP has no meeting (never started, ended) or cannot be reached: back to the entry with [text] under the title. */
  function setNoMeeting(text) {
    blockedText = text;
    loginSeq++;
    closeMeetingPage();
    showEntry();
  }
  // A no_meeting reply never replaces a text already shown (e.g. "Meeting ended" from the notice).
  Wt.onNoMeeting(markUnreachable);

  function markUnreachable() { if (!blockedText) setNoMeeting(t('unreachable')); }
  function isConnectFail(e) { return !!e && e.message === t('connectFail'); }
  /** Wraps a Wt signaling call so that a connection failure also shows the "cannot reach" screen, then rethrows. */
  function watchUnreachable(fn) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        if (isConnectFail(e)) markUnreachable();
        throw e;
      }
    };
  }
  const castSignaling = { invite: watchUnreachable(Wt.signaling.invite), end: Wt.signaling.end };
  const viewSignaling = { view: watchUnreachable(Wt.viewSignaling.view), end: Wt.viewSignaling.end };

  function onShareLeave(reason) {
    if (reason === 'unauthorized') home();
    else if (mediaActive()) meetingEnded();
    else markUnreachable();
  }

  /** The IFP sent its end-of-meeting notice over a 'meeting' DataChannel: stop watching and casting. */
  function meetingEnded() {
    setNoMeeting(t('meetingEnded'));
  }

  /** The login is no longer valid (PIN changed): back to the PIN form for the same role. */
  function askPinAgain() {
    loginSeq++;
    closeMeetingPage();
    showGate(t('pinChanged'));
  }

  function fullscreenToggle() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else ui.stage.requestFullscreen().catch(() => {});
  }
  ui.fullscreen.onclick = fullscreenToggle;
  ui.unmute.onclick = () => {
    ui.video.muted = false;
    ui.video.play().catch(() => {});
    ui.unmute.hidden = true;
  };

  // ---- PIN gate -----------------------------------------------------------------------------
  ui.gate.onsubmit = async (ev) => {
    ev.preventDefault();
    const pin = ui.pin.value.trim();
    if (!/^[0-9]{6}$/.test(pin)) {
      setPinError(t('pinInvalid'));
      ui.pin.focus();
      ui.pin.select();
      return;
    }
    // WebTransport can wait a long time here (the browser's local-network permission prompt): show progress.
    const seq = ++loginSeq;
    ui.pinBtn.disabled = true;
    ui.pinBtn.textContent = t('connecting');
    setPinError('');
    try {
      const ok = (await Wt.login(pin)).ok;
      if (seq !== loginSeq) return; // left the form while waiting
      if (ok) {
        ui.pin.value = '';
        enterRoom();
      } else {
        setPinError(t('pinWrong'));
        ui.pin.focus();
        ui.pin.select();
      }
    } catch (e) {
      if (seq !== loginSeq) return;
      if (isConnectFail(e)) markUnreachable();
      else setPinError((e && e.message) || t('connectFail'));
    } finally {
      if (seq === loginSeq) {
        ui.pinBtn.disabled = false;
        ui.pinBtn.textContent = t('joinMeeting');
      }
    }
  };

  // ---- meeting check on load ----------------------------------------------------------------
  async function checkMeeting() {
    checking = true;
    applyControls();
    renderStatus();
    try {
      const res = await Wt.ping();
      if (res.meeting === false) markUnreachable();
    } catch (e) {
      if (isConnectFail(e)) markUnreachable();
    } finally {
      checking = false;
      applyControls();
      renderStatus();
    }
  }

  // ---- media (speaker: cast, audience: watch) ------------------------------------------------
  function endReceive(reasonText) {
    if (!receiving) return;
    Whep.stop();
    receiving = false;
    ui.receiveStats.textContent = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    renderMedia(reasonText);
  }

  function endCast(reasonText) {
    if (!casting) return;
    RtcCast.stop();
    casting = false;
    Wt.stopKeepalive();
    ui.castStats.textContent = '';
    renderMedia(reasonText);
  }

  async function startReceive() {
    receiving = true;
    ui.video.muted = true;
    renderMedia('');
    try {
      await Whep.start({
        stats: ui.receiveStats,
        video: ui.video,
        signaling: viewSignaling,
        onEnded: (text) => endReceive(text),
        onMeetingEnded: meetingEnded,
      });
    } catch (e) {
      if (e && e.code === 'unauthorized') askPinAgain();
      else endReceive(tMsg((e && e.message) || String(e)));
    }
  }

  async function startCast() {
    casting = true;
    Wt.startKeepalive();
    renderMedia('');
    try {
      await RtcCast.start({
        stats: ui.castStats,
        onEnded: (text) => endCast(tMsg(text)),
        onMeetingEnded: meetingEnded,
        signaling: castSignaling,
      });
    } catch (e) {
      endCast(tMsg((e && e.message) || String(e)));
      if (!Wt.hasToken() && inRoom) askPinAgain();
    }
  }

  ui.media.onclick = () => {
    if (speaker) {
      if (casting) endCast('');
      else startCast();
    } else if (receiving) {
      endReceive('');
    } else {
      startReceive();
    }
  };

  showEntry(false);
  if (!fatalText) checkMeeting();
})();
