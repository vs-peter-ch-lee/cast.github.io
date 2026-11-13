// Shared constants and UI text (zh / en) for the portal page. See doc/poc-protocol.md.
'use strict';

// Port of the HTTPS origin (CastingServer.PORT). The HTTP portal sends the user there for casting.
const HTTPS_PORT = 8443;
// Casting page on GitHub Pages (a trusted https origin). The IFP entry page sends the user there with ?ip=<IFP address>.
const PAGES_URL = 'https://vs-peter-ch-lee.github.io/cast.github.io/';

// ---- UI text: zh (default) / en when navigator.language starts with "en" ----------------------
const LANG = /^en/i.test(navigator.language || '') ? 'en' : 'zh';
const I18N = {
  zh: {
    title: 'Casting', addr: 'IFP 位址',
    castBtn: '投放到 IFP', receiveBtn: '接收 IFP 畫面', stop: '停止投放', stopReceive: '停止接收',
    receiveTitle: '在這裡看 IFP 的畫面', receiveHint: '不需要 PIN，按下就開始。',
    castTitle: '把電腦畫面投到 IFP', castingTitle: '正在投放到 IFP',
    castDesc: (host) => `會開啟投影頁 ${host}，輸入 IFP 上的 PIN 即可開始。`,
    castLanNote: '影像只在區域網路內傳送，不經過外部伺服器。',
    castKeepOpen: '請保持這個分頁開啟。關閉分頁會結束投放。',
    lanPermission: '瀏覽器第一次會詢問是否允許存取區域網路，請按「允許」。',
    legacyPre: '電腦連不上外部網路？', legacyLink: '改用區網連線', legacyPost: '。瀏覽器會先顯示憑證警告，屬正常現象。',
    viewPre: '要看 IFP 的畫面？請開 ',
    advanced: '進階設定', diag: '診斷資訊',
    pinLabel: 'IFP 上顯示的 6 位數 PIN', pinOk: '開始投放', pinCancel: '取消',
    pinInvalid: '請輸入 6 位數字', pinWrong: 'PIN 錯誤', pinChanged: 'PIN 已更換，請輸入 IFP 上的新 PIN',
    fullscreen: '全螢幕', unmute: '開啟聲音',
    stateIdle: '待命', stateCasting: '投放中', stateReceiving: '接收中',
    noDisplayMedia: '此瀏覽器不支援分享畫面，請改用電腦上的 Chrome 或 Edge',
    badIp: '網址中的 IFP 位址不正確，請回到 IFP 的入口頁重新進入',
    needIfpEntry: '請從 IFP 的入口頁按「投放到 IFP」進入此頁',
    noWebTransport: '此瀏覽器不支援 WebTransport，請改用電腦上的 Chrome 或 Edge',
    wtNoFingerprint: '此頁面內的憑證指紋已過期，請重新整理頁面',
    connectFail: '無法連線到 IFP',
    castEnded: '投放已結束', receiveEnded: '接收已結束',
    receiveFailed: (c) => `接收失敗（HTTP ${c}）`,
  },
  en: {
    title: 'Casting', addr: 'IFP address',
    castBtn: 'Cast to IFP', receiveBtn: 'Receive IFP screen', stop: 'Stop casting', stopReceive: 'Stop receiving',
    receiveTitle: 'Watch the IFP screen here', receiveHint: 'No PIN needed. Press to start.',
    castTitle: 'Cast this computer to the IFP', castingTitle: 'Casting to the IFP',
    castDesc: (host) => `Opens the casting page ${host}. Enter the PIN shown on the IFP to start.`,
    castLanNote: 'The video is sent only inside the local network, not through any external server.',
    castKeepOpen: 'Keep this tab open. Closing it ends the cast.',
    lanPermission: 'The first time, the browser asks whether to allow access to the local network. Choose "Allow".',
    legacyPre: 'Computer cannot reach the internet? ', legacyLink: 'Use the local network connection',
    legacyPost: '. The browser shows a certificate warning first; this is expected.',
    viewPre: 'Want to watch the IFP screen? Open ',
    advanced: 'Advanced settings', diag: 'Diagnostics',
    pinLabel: '6-digit PIN shown on the IFP', pinOk: 'Start casting', pinCancel: 'Cancel',
    pinInvalid: 'Enter 6 digits', pinWrong: 'Wrong PIN', pinChanged: 'The PIN has changed. Enter the new PIN shown on the IFP',
    fullscreen: 'Fullscreen', unmute: 'Unmute',
    stateIdle: 'Ready', stateCasting: 'Casting', stateReceiving: 'Receiving',
    noDisplayMedia: 'This browser cannot share its screen. Use Chrome or Edge on a computer',
    badIp: 'The IFP address in the URL is invalid. Go back to the IFP entry page and try again',
    needIfpEntry: 'Open this page from the IFP entry page by pressing "Cast to IFP"',
    noWebTransport: 'This browser does not support WebTransport. Use Chrome or Edge on a computer',
    wtNoFingerprint: 'The certificate fingerprints in this page have expired. Reload the page',
    connectFail: 'Cannot connect to the IFP',
    castEnded: 'Casting ended', receiveEnded: 'Receiving ended',
    receiveFailed: (c) => `Receive failed (HTTP ${c})`,
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

/** Resolves once the peer connection has gathered all ICE candidates (non-trickle offer). */
function gatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
  });
}
