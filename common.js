// Shared constants and UI text (zh / en) for the portal page and the meeting page. See doc/poc-protocol.md.
'use strict';

// Casting page on GitHub Pages (a trusted https origin). The IFP entry page (portal.html on :8080) sends the user
// there with ?ip=<IFP address>.
const PAGES_URL = 'https://vs-peter-ch-lee.github.io/cast.github.io/';

// ---- UI text: zh (default) / en when navigator.language starts with "en" ----------------------
const LANG = /^en/i.test(navigator.language || '') ? 'en' : 'zh';
const I18N = {
  zh: {
    title: 'Casting', brandSub: '教室會議',
    statusReady: '可加入會議', statusOffline: '尚未連線', statusInMeeting: '會議進行中',
    entryTitle: '加入教室會議', entryIntro: '選擇身分，再輸入教室螢幕上的 PIN。',
    speaker: '演講者', speakerDesc: '將電腦畫面投到教室螢幕', audience: '聽眾', audienceDesc: '在這台裝置收看教室畫面',
    speakerLogin: '演講者登入', audienceLogin: '聽眾登入', gateIntro: '請輸入教室螢幕上顯示的會議 PIN。',
    pinLabel: '6 位數會議 PIN', joinMeeting: '加入會議', backToRoles: '返回身分選擇',
    pinInvalid: '請輸入 6 位數字', pinWrong: 'PIN 錯誤', pinChanged: 'PIN 已更換，請輸入 IFP 上的新 PIN',
    lanPermission: '瀏覽器第一次會詢問是否允許存取區域網路，請按「允許」。',
    ifpLabel: 'IFP 位址', pinWhere: 'PIN 顯示在 IFP 的 Casting 小工具上',
    leaveMeeting: '離開會議', speakerTitle: '投影電腦畫面', audienceTitle: '收看教室畫面',
    speakerIdle: '按「開始投影」後，選擇要分享的電腦畫面。',
    castKeepOpen: '正在投影。請保持這個分頁開啟，關閉分頁會結束投影。',
    audienceIdle: '開始收看後，教室螢幕的畫面會顯示在這裡。',
    castStart: '開始投影', castStop: '停止投影', viewStart: '開始收看', viewStop: '停止收看',
    castOff: '尚未投影', castOn: '正在投影至 IFP', viewOff: '尚未收看', viewOn: '正在收看 IFP',
    advanced: '進階（診斷資訊）',
    unreachable: '連不上這台 IFP，請確認 IFP 已開始會議', meetingEnded: '會議已結束',
    goMeeting: '前往會議頁面', portalHint: '按下按鈕，前往會議頁面投影或收看這台 IFP 的畫面。',
    fullscreen: '全螢幕', unmute: '開啟聲音',
    noDisplayMedia: '此瀏覽器不支援分享畫面，請改用電腦上的 Chrome 或 Edge',
    badIp: '網址中的 IFP 位址不正確，請回到 IFP 的入口頁重新進入',
    needIfpEntry: '請從 IFP 的入口頁按「前往會議頁面」進入此頁',
    noWebTransport: '此瀏覽器不支援 WebTransport，請改用電腦上的 Chrome 或 Edge',
    wtNoFingerprint: '此頁面內的憑證指紋已過期，請重新整理頁面',
    connecting: '連線中…', connectFail: '無法連線到 IFP',
    castEnded: '投影已結束', receiveEnded: '收看已結束',
    receiveFailed: (c) => `收看失敗（${c}）`,
    shareTitle: '共用區', folderTitle: '會議資料夾', fileCount: (n) => `${n} 個檔案`,
    clipTitle: 'IFP 剪貼簿', clipLatest: '最新一筆', nothingYet: '尚無內容',
    copy: '複製', copied: '已複製', truncated: '內容過長，已截斷',
    tooLarge: '太大，無法下載', downloadFailed: '下載失敗', download: '下載', downloading: '下載中',
    downloadLabel: (name) => `下載 ${name}`, clipImage: '剪貼簿圖片',
    upload: '上傳', uploading: '上傳中', uploadCancel: '取消', uploadLabel: '上傳檔案到會議資料夾',
    uploadTooLarge: '檔案太大，無法上傳（上限 100 MB）', uploadBusy: 'IFP 忙碌中，請稍後再試',
    uploadFailed: '上傳失敗', uploadCancelled: '已取消上傳', uploadDone: (name) => `上傳完成：${name}`,
  },
  en: {
    title: 'Casting', brandSub: 'Classroom meeting',
    statusReady: 'Ready to join', statusOffline: 'Not connected', statusInMeeting: 'Meeting in progress',
    entryTitle: 'Join the classroom meeting', entryIntro: 'Choose your role, then enter the PIN shown on the classroom screen.',
    speaker: 'Speaker', speakerDesc: 'Show your computer screen on the classroom display', audience: 'Audience', audienceDesc: 'Watch the classroom screen on this device',
    speakerLogin: 'Speaker sign-in', audienceLogin: 'Audience sign-in', gateIntro: 'Enter the meeting PIN shown on the classroom screen.',
    pinLabel: '6-digit meeting PIN', joinMeeting: 'Join meeting', backToRoles: 'Back to role selection',
    pinInvalid: 'Enter 6 digits', pinWrong: 'Wrong PIN', pinChanged: 'The PIN has changed. Enter the new PIN shown on the IFP',
    lanPermission: 'The first time, the browser asks whether to allow access to the local network. Choose "Allow".',
    ifpLabel: 'IFP address', pinWhere: 'The PIN is shown in the Casting widget on the IFP',
    leaveMeeting: 'Leave meeting', speakerTitle: 'Present your screen', audienceTitle: 'Watch the classroom screen',
    speakerIdle: 'After you press "Start presenting", choose the screen to share.',
    castKeepOpen: 'Presenting. Keep this tab open: closing it ends the presentation.',
    audienceIdle: 'After you start watching, the classroom screen appears here.',
    castStart: 'Start presenting', castStop: 'Stop presenting', viewStart: 'Start watching', viewStop: 'Stop watching',
    castOff: 'Not presenting', castOn: 'Presenting to the IFP', viewOff: 'Not watching', viewOn: 'Watching the IFP',
    advanced: 'Advanced (diagnostics)',
    unreachable: 'Cannot reach this IFP. Make sure a meeting has started on it.', meetingEnded: 'Meeting ended',
    goMeeting: 'Go to meeting page', portalHint: 'Press the button to go to the meeting page, where you can present to or watch this IFP.',
    fullscreen: 'Fullscreen', unmute: 'Unmute',
    noDisplayMedia: 'This browser cannot share its screen. Use Chrome or Edge on a computer',
    badIp: 'The IFP address in the URL is invalid. Go back to the IFP entry page and try again',
    needIfpEntry: 'Open this page from the IFP entry page by pressing "Go to meeting page"',
    noWebTransport: 'This browser does not support WebTransport. Use Chrome or Edge on a computer',
    wtNoFingerprint: 'The certificate fingerprints in this page have expired. Reload the page',
    connecting: 'Connecting...', connectFail: 'Cannot connect to the IFP',
    castEnded: 'Presentation ended', receiveEnded: 'Watching ended',
    receiveFailed: (c) => `Watching failed (${c})`,
    shareTitle: 'Shared area', folderTitle: 'Meeting folder', fileCount: (n) => `${n} files`,
    clipTitle: 'IFP clipboard', clipLatest: 'Latest item', nothingYet: 'Nothing yet',
    copy: 'Copy', copied: 'Copied', truncated: 'Too long, truncated',
    tooLarge: 'Too large to download', downloadFailed: 'Download failed', download: 'Download', downloading: 'Downloading',
    downloadLabel: (name) => `Download ${name}`, clipImage: 'Clipboard image',
    upload: 'Upload', uploading: 'Uploading', uploadCancel: 'Cancel', uploadLabel: 'Upload a file to the meeting folder',
    uploadTooLarge: 'File too large to upload (limit 100 MB)', uploadBusy: 'The IFP is busy. Try again later',
    uploadFailed: 'Upload failed', uploadCancelled: 'Upload cancelled', uploadDone: (name) => `Upload complete: ${name}`,
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
