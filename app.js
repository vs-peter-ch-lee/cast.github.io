// Page wiring: two main buttons, diagnostics, status line, PIN gate for casting.
// Direction logic lives in whep.js (IFP -> PC) and rtccast.js (PC -> IFP), both WebRTC.
//
// Three ways this one script runs:
//   - IFP page (:8080 entry, :8443 casting): handshake over fetch ('/api/session', '/api/login', '/rtc/whip').
//   - GitHub Pages build with ?ip=<IFP IPv4> (wt.js): handshake over WebTransport, PIN token kept in memory only.
//   - GitHub Pages build without ?ip=: only a hint to start from the IFP entry page.
// The Pages build has no viewing UI (receive*, castDesc, castLegacy elements are removed from its index.html).
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    receiveBtn: $('receiveBtn'), stopReceiveBtn: $('stopReceiveBtn'), receiveStats: $('receiveStats'),
    castBtn: $('castBtn'), stopCastBtn: $('stopCastBtn'), castStats: $('castStats'), castHint: $('castHint'),
    receiveIdle: $('receiveIdle'), receiveWrap: $('receiveWrap'), receiveStage: $('receiveStage'), receiveVideo: $('receiveVideo'),
    unmuteBtn: $('unmuteBtn'), fullscreenBtn: $('fullscreenBtn'),
    status: $('status'), stateRow: $('stateRow'), ifpAddr: $('ifpAddr'),
    pinView: $('pinView'), pinInput: $('pinInput'), pinError: $('pinError'), pinCancelBtn: $('pinCancelBtn'),
    castDesc: $('castDesc'), castLegacyRow: $('castLegacyRow'), castLegacy: $('castLegacy'),
    viewRow: $('viewRow'), viewLink: $('viewLink'),
  };
  const SESSION_POLL_MS = 5000;
  let receiving = false;
  let casting = false;

  // ---- mode ---------------------------------------------------------------------------------
  const pagesBuild = !!document.querySelector('meta[name="casting-build"][content="pages"]');
  const query = new URLSearchParams(location.search);
  const wtMode = query.has('ip'); // ?ip= present: WebTransport handshake with that IFP
  const wtIp = wtMode && typeof Wt !== 'undefined' ? Wt.parseIp(query.get('ip')) : null; // null = invalid
  const legacyApi = !wtMode && !pagesBuild; // fetch handshake against the page's own IFP origin
  if (wtIp) Wt.init(wtIp);

  // ---- static text / environment ------------------------------------------------------------
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-Hant';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  if (wtMode) ui.ifpAddr.textContent = wtIp || '';
  else ui.ifpAddr.textContent = pagesBuild ? '' : location.host;
  // The HTTP portal (:8080) has no screen capture and no PIN cookie: casting continues on the HTTPS page.
  const onHttps = location.protocol === 'https:';
  const canCast = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  // The cast description and the old-https link (with its certificate-warning note) belong to the HTTP entry page:
  // on HTTPS the user is already past the warning.
  if (ui.castDesc) {
    ui.castDesc.textContent = t('castDesc', new URL(PAGES_URL).host);
    ui.castDesc.hidden = onHttps || !legacyApi;
  }
  if (ui.castLegacyRow) {
    ui.castLegacyRow.hidden = onHttps || !legacyApi;
    ui.castLegacy.href = `https://${location.hostname}:${HTTPS_PORT}/#cast`;
  }
  // Pages build: link to the IFP entry page, where the screen can be watched.
  if (ui.viewRow && wtIp) {
    ui.viewLink.href = ui.viewLink.textContent = `http://${wtIp}:8080`;
    ui.viewRow.hidden = false;
  }
  /** Casting is impossible here: show [text] and disable the cast button. */
  function blockCast(text) {
    ui.castBtn.disabled = true;
    ui.castHint.textContent = text;
    ui.castHint.hidden = false;
  }
  if (wtMode && !wtIp) blockCast(t('badIp'));
  else if (pagesBuild && !wtMode) blockCast(t('needIfpEntry'));
  else if (wtMode && typeof WebTransport === 'undefined') blockCast(t('noWebTransport'));
  else if (onHttps && !canCast) blockCast(t('noDisplayMedia'));
  const wtReady = wtMode && !!wtIp && !ui.castBtn.disabled;
  if (ui.fullscreenBtn && !document.fullscreenEnabled) ui.fullscreenBtn.hidden = true;

  // ---- status line --------------------------------------------------------------------------
  let message = '';
  function renderStatus() {
    if (message) {
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
    if (!ui.receiveBtn) return; // Pages build: no viewing UI
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
    if (wtMode) {
      // Keep the IFP-side handshake alive while casting; a dropped connection does not end the cast.
      if (on) Wt.startKeepalive();
      else Wt.stopKeepalive();
    }
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

  if (ui.receiveBtn) {
    ui.unmuteBtn.onclick = () => {
      ui.receiveVideo.muted = false;
      ui.receiveVideo.play().catch(() => {});
      ui.unmuteBtn.hidden = true;
    };
    ui.fullscreenBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else ui.receiveStage.requestFullscreen().catch(() => {});
    };
  }

  // ---- PIN gate (casting only) -------------------------------------------------------------
  let authed = false;

  /** true = cookie valid, false = 401, null = IFP unreachable. */
  async function checkSession() {
    try {
      const r = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
      return r.ok;
    } catch (e) {
      return null;
    }
  }

  /** Stops casting and shows the PIN form. Receiving is not touched. */
  function showPin(errorText) {
    authed = false;
    endCast('');
    ui.castBtn.hidden = true;
    ui.pinView.hidden = false;
    ui.pinError.textContent = errorText || '';
    ui.pinInput.value = '';
    ui.pinInput.focus();
  }

  function hidePin() {
    ui.pinView.hidden = true;
    ui.pinError.textContent = '';
    ui.castBtn.hidden = casting;
  }

  /**
   * After a failed cast start: if the login is no longer valid, go back to the PIN form.
   * WebTransport mode: an 'unauthorized' invite already dropped the in-memory token.
   */
  async function recheckAuth() {
    if (wtMode) {
      if (!Wt.hasToken()) showPin(t('pinChanged'));
      return;
    }
    if ((await checkSession()) === false) showPin(t('pinChanged'));
  }

  /** true = PIN accepted, false = wrong PIN; throws when the IFP cannot be reached. */
  async function login(pin) {
    if (wtMode) return (await Wt.login(pin)).ok;
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pin }),
    });
    return r.ok;
  }

  ui.pinView.onsubmit = async (ev) => {
    ev.preventDefault();
    const pin = ui.pinInput.value.trim();
    if (!/^[0-9]{6}$/.test(pin)) {
      ui.pinError.textContent = t('pinInvalid');
      return;
    }
    try {
      if (await login(pin)) {
        authed = true;
        hidePin();
        startCast();
      } else {
        ui.pinError.textContent = t('pinWrong');
        ui.pinInput.select();
      }
    } catch (e) {
      ui.pinError.textContent = (wtMode && e && e.message) || t('connectFail');
    }
  };
  ui.pinCancelBtn.onclick = () => hidePin();

  // The PIN may rotate at any time (manual, idle timeout): poll so the page returns to the PIN form.
  // Not in WebTransport mode: an unauthorized invite sends the page back to the PIN form instead.
  if (legacyApi) {
    setInterval(async () => {
      if (authed && (await checkSession()) === false) showPin(t('pinChanged'));
    }, SESSION_POLL_MS);
  }

  if (wtReady) {
    // Arrived from the IFP entry page's cast button: ask for the PIN right away (the token is memory-only,
    // so there is never a session to reuse after a load).
    if (canCast) showPin('');
  } else if (legacyApi && onHttps) {
    checkSession().then((ok) => {
      authed = ok === true;
      // Arrived from the HTTP portal's cast button: ask for the PIN right away. With a valid cookie the
      // user clicks the cast button once more, because screen capture only starts from a click.
      if (location.hash !== '#cast') return;
      history.replaceState(null, '', location.pathname);
      if (ok === false && canCast && !casting) showPin('');
      else ui.castBtn.focus();
    });
  }

  // ---------------------------------------------------------------------------------------

  if (ui.receiveBtn) {
    ui.receiveBtn.onclick = async () => {
      setStatus('');
      setReceiving(true);
      try {
        await Whep.start({
          stats: ui.receiveStats,
          video: ui.receiveVideo,
          onEnded: (text) => endReceive(text),
        });
      } catch (e) {
        endReceive(tMsg(e.message || String(e)));
      }
    };
    ui.stopReceiveBtn.onclick = () => endReceive('');
  }

  async function startCast() {
    setStatus('');
    setCasting(true);
    try {
      await RtcCast.start({
        stats: ui.castStats,
        onEnded: (text) => endCast(tMsg(text)),
        signaling: wtMode ? Wt.signaling : undefined,
      });
    } catch (e) {
      endCast(tMsg(e.message || String(e)));
      recheckAuth();
    }
  }

  ui.castBtn.onclick = async () => {
    if (wtMode) {
      if (Wt.hasToken()) startCast();
      else showPin('');
      return;
    }
    if (!onHttps) {
      // HTTP entry page: casting continues on the Pages build, which then talks to this IFP over WebTransport.
      location.href = `${PAGES_URL}?ip=${location.hostname}`;
      return;
    }
    if (!authed) authed = (await checkSession()) === true;
    if (!authed) {
      showPin('');
      return;
    }
    startCast();
  };
  ui.stopCastBtn.onclick = () => endCast('');

  renderStatus();
})();
