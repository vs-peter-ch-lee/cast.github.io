// Shared constants and UI text (zh / en) for the portal page. See doc/poc-protocol.md.
'use strict';

// Casting page on GitHub Pages (a trusted https origin). The IFP entry page (portal.html on :8080) sends the user
// there with ?ip=<IFP address>.
const PAGES_URL = 'https://vs-peter-ch-lee.github.io/cast.github.io/';

// ---- UI text: zh (default) / en when navigator.language starts with "en" ----------------------
const LANG = /^en/i.test(navigator.language || '') ? 'en' : 'zh';
const I18N = {
  zh: {
    title: 'Casting', addr: 'IFP 位址',
    castBtn: '投放到 IFP', receiveBtn: '接收 IFP 畫面', stop: '停止投放', stopReceive: '停止接收',
    receiveTitle: '在這裡看 IFP 的畫面', receiveHint: '需要輸入 IFP 上顯示的 PIN。',
    castTitle: '把電腦畫面投到 IFP', castingTitle: '正在投放到 IFP',
    castLanNote: '影像只在區域網路內傳送，不經過外部伺服器。',
    castKeepOpen: '請保持這個分頁開啟。關閉分頁會結束投放。',
    lanPermission: '瀏覽器第一次會詢問是否允許存取區域網路，請按「允許」。',
    advanced: '進階設定', diag: '診斷資訊',
    pinLabel: 'IFP 上顯示的 6 位數 PIN', pinOk: '確認', pinCancel: '取消',
    pinInvalid: '請輸入 6 位數字', pinWrong: 'PIN 錯誤', pinChanged: 'PIN 已更換，請輸入 IFP 上的新 PIN',
    pinRequired: '請先輸入 IFP 上顯示的 PIN',
    noMeeting: '尚未開始會議', meetingEnded: '會議已結束',
    goMeeting: '前往會議頁面', portalHint: '按下按鈕，前往會議頁面投放或收看這台 IFP 的畫面。',
    fullscreen: '全螢幕', unmute: '開啟聲音',
    stateIdle: '待命', stateCasting: '投放中', stateReceiving: '接收中',
    noDisplayMedia: '此瀏覽器不支援分享畫面，請改用電腦上的 Chrome 或 Edge',
    badIp: '網址中的 IFP 位址不正確，請回到 IFP 的入口頁重新進入',
    needIfpEntry: '請從 IFP 的入口頁按「前往會議頁面」進入此頁',
    noWebTransport: '此瀏覽器不支援 WebTransport，請改用電腦上的 Chrome 或 Edge',
    wtNoFingerprint: '此頁面內的憑證指紋已過期，請重新整理頁面',
    connecting: '連線中…', connectedClickCast: '已連線，請再按一次「投放到 IFP」開始',
    connectFail: '無法連線到 IFP',
    castEnded: '投放已結束', receiveEnded: '接收已結束',
    receiveFailed: (c) => `接收失敗（${c}）`,
  },
  en: {
    title: 'Casting', addr: 'IFP address',
    castBtn: 'Cast to IFP', receiveBtn: 'Receive IFP screen', stop: 'Stop casting', stopReceive: 'Stop receiving',
    receiveTitle: 'Watch the IFP screen here', receiveHint: 'Enter the PIN shown on the IFP.',
    castTitle: 'Cast this computer to the IFP', castingTitle: 'Casting to the IFP',
    castLanNote: 'The video is sent only inside the local network, not through any external server.',
    castKeepOpen: 'Keep this tab open. Closing it ends the cast.',
    lanPermission: 'The first time, the browser asks whether to allow access to the local network. Choose "Allow".',
    advanced: 'Advanced settings', diag: 'Diagnostics',
    pinLabel: '6-digit PIN shown on the IFP', pinOk: 'OK', pinCancel: 'Cancel',
    pinInvalid: 'Enter 6 digits', pinWrong: 'Wrong PIN', pinChanged: 'The PIN has changed. Enter the new PIN shown on the IFP',
    pinRequired: 'Enter the PIN shown on the IFP first',
    noMeeting: 'No meeting in progress', meetingEnded: 'Meeting ended',
    goMeeting: 'Go to meeting page', portalHint: 'Press the button to go to the meeting page, where you can cast to or watch this IFP.',
    fullscreen: 'Fullscreen', unmute: 'Unmute',
    stateIdle: 'Ready', stateCasting: 'Casting', stateReceiving: 'Receiving',
    noDisplayMedia: 'This browser cannot share its screen. Use Chrome or Edge on a computer',
    badIp: 'The IFP address in the URL is invalid. Go back to the IFP entry page and try again',
    needIfpEntry: 'Open this page from the IFP entry page by pressing "Go to meeting page"',
    noWebTransport: 'This browser does not support WebTransport. Use Chrome or Edge on a computer',
    wtNoFingerprint: 'The certificate fingerprints in this page have expired. Reload the page',
    connecting: 'Connecting...', connectedClickCast: 'Connected. Press "Cast to IFP" once more to start',
    connectFail: 'Cannot connect to the IFP',
    castEnded: 'Casting ended', receiveEnded: 'Receiving ended',
    receiveFailed: (c) => `Receive failed (${c})`,
  },
};
/** UI text for [key]; function entries take args. */
function t(key, ...args) {
  const v = I18N[LANG][key];
  return typeof v === 'function' ? v(...args) : v;
}
// Messages thrown by rtccast.js (Chinese only, not editable) -> English.
const CAST_JS_EN = {
  '此瀏覽器不支援分享畫面': 'This browser cannot share its screen',
  '已取消分享': 'Sharing was cancelled',
};
/** Localizes an error message produced by rtccast.js when the UI is English. */
function tMsg(text) {
  if (LANG !== 'en' || !text) return text;
  if (CAST_JS_EN[text]) return CAST_JS_EN[text];
  if (text.startsWith('無法分享畫面：')) return `Cannot share the screen: ${text.slice(7)}`;
  return text;
}

/** true when a 'meeting' DataChannel message is the IFP's end-of-meeting notice: text JSON {"type":"meeting_ended"}. */
function isMeetingEnded(data) {
  if (typeof data !== 'string') return false;
  try {
    const msg = JSON.parse(data);
    return !!msg && msg.type === 'meeting_ended';
  } catch (e) {
    return false;
  }
}

/** Resolves once the peer connection has gathered all ICE candidates (non-trickle offer). */
function gatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
  });
}
