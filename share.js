// Shared area of the meeting page: the meeting folder list (thumbnails, download, upload of one file) and the IFP clipboard's latest item.
// Requests go through Wt.share (wt.js); this file owns polling, rendering and the stream budget
// (5 at a time: polling 1, thumbnails 2, downloads 2; an upload adds 1 more). Names, paths and clipboard text are only ever set with textContent.
//   ShareArea.start(root, { mediaActive: () => boolean, leave: (reason) => void })   reason: 'unreachable' | 'unauthorized'
//   ShareArea.stop()
'use strict';

const ShareArea = (() => {
  const POLL_GAP_MS = 2000;
  const MAX_THUMBS = 2;
  const MAX_DOWNLOADS = 2;
  const DEC = new TextDecoder();

  let session = null; // state of the running start(), or null

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatSize(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function baseName(path) {
    const i = path.lastIndexOf('/');
    return i < 0 ? path : path.slice(i + 1);
  }

  /** Extension in capitals; FILE when the last segment has none. */
  function typeCode(path) {
    const name = baseName(path);
    const i = name.lastIndexOf('.');
    return i > 0 && i < name.length - 1 ? name.slice(i + 1).toUpperCase() : 'FILE';
  }

  function clockText(ms) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function imageExtension(bytes) {
    const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
    if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    if (ascii(0, 3) === 'GIF') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (ascii(0, 2) === 'BM') return 'bmp';
    return '';
  }

  /** Runs at most [limit] tasks at once, the rest wait in order. */
  function createQueue(limit) {
    let running = 0;
    const waiting = [];
    function pump() {
      while (running < limit && waiting.length) {
        const task = waiting.shift();
        running++;
        task().catch(() => {}).finally(() => { running--; pump(); });
      }
    }
    return { add(task) { waiting.push(task); pump(); } };
  }

  /** Saves [blob] as a file named [name]: no new tab, no navigation. */
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function bodyBytes(res) {
    return res && res.body instanceof Uint8Array ? res.body : new Uint8Array(0);
  }

  function headerOf(res) {
    return (res && res.header) || res || {};
  }

  function start(root, hooks) {
    stop();
    const s = {
      root,
      hooks,
      alive: true,
      controllers: new Set(),
      urls: new Set(),
      rows: new Map(),
      failedPaths: new Set(),
      thumbQueue: createQueue(MAX_THUMBS),
      downloadQueue: createQueue(MAX_DOWNLOADS),
      lastFiles: undefined,
      lastClip: undefined,
      forceList: false,
      wake: null,
      clipView: null,
      upload: null,
    };
    s.pollCtl = newController(s);
    session = s;
    build(s);
    poll(s);
  }

  function stop() {
    const s = session;
    if (!s) return;
    session = null;
    s.alive = false;
    s.controllers.forEach((c) => c.abort());
    s.controllers.clear();
    s.urls.forEach((u) => URL.revokeObjectURL(u));
    s.urls.clear();
    s.rows.clear();
    if (s.wake) s.wake();
    while (s.root.firstChild) s.root.removeChild(s.root.firstChild);
  }

  function newController(s) {
    const c = new AbortController();
    s.controllers.add(c);
    return c;
  }

  function blobUrl(s, blob) {
    const url = URL.createObjectURL(blob);
    s.urls.add(url);
    return url;
  }

  function build(s) {
    s.root.appendChild(el('h2', '', t('shareTitle')));
    const folderHead = el('div', 'sectionhead');
    folderHead.appendChild(el('h3', '', t('folderTitle')));
    const tools = el('div', 'headtools');
    s.count = el('small', '', t('fileCount', 0));
    s.uploadProgress = el('small', 'progress');
    s.uploadProgress.hidden = true;
    s.uploadCancel = el('button', 'link', t('uploadCancel'));
    s.uploadCancel.type = 'button';
    s.uploadCancel.hidden = true;
    s.uploadCancel.onclick = () => cancelUpload(s);
    s.uploadButton = el('button', 'tool', t('upload'));
    s.uploadButton.type = 'button';
    s.uploadButton.setAttribute('aria-label', t('uploadLabel'));
    s.uploadPicker = el('input');
    s.uploadPicker.type = 'file';
    s.uploadPicker.hidden = true;
    s.uploadButton.onclick = () => { if (!s.upload) s.uploadPicker.click(); };
    s.uploadPicker.onchange = () => {
      const file = s.uploadPicker.files && s.uploadPicker.files[0];
      s.uploadPicker.value = '';
      if (file) startUpload(s, file);
    };
    tools.append(s.count, s.uploadProgress, s.uploadCancel, s.uploadButton, s.uploadPicker);
    folderHead.appendChild(tools);
    s.root.appendChild(folderHead);
    s.uploadNote = el('p', 'uploadnote');
    s.uploadNote.setAttribute('role', 'status');
    s.uploadNote.hidden = true;
    s.root.appendChild(s.uploadNote);
    s.list = el('div');
    s.root.appendChild(s.list);
    s.listEmpty = el('p', 'empty', t('nothingYet'));
    s.list.appendChild(s.listEmpty);

    const clipHead = el('div', 'sectionhead');
    clipHead.appendChild(el('h3', '', t('clipTitle')));
    clipHead.appendChild(el('small', '', t('clipLatest')));
    s.root.appendChild(clipHead);
    s.clip = el('div');
    s.root.appendChild(s.clip);
    renderClipEmpty(s);
  }

  // ---- polling --------------------------------------------------------------------------------------

  function sleep(s, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      s.wake = () => { clearTimeout(timer); resolve(); };
    }).finally(() => { s.wake = null; });
  }

  /** Marks [error] as a failed poll: 'retry', 'skip' (this round only) or 'stop'. Leaves the page when nobody else will. */
  function judge(s, rawError, attempt) {
    if (!s.alive || s.pollCtl.signal.aborted) return 'stop';
    const error = rawError === 'aborted' ? 'unreachable' : rawError;
    const busy = s.hooks.mediaActive();
    if (error === 'unauthorized') {
      if (!busy) s.hooks.leave('unauthorized');
      return 'stop';
    }
    if (error === 'no_meeting') {
      s.hooks.leave('unreachable');
      return 'stop';
    }
    if (error === 'unreachable') {
      if (busy) return 'skip';
      if (attempt === 0) return 'retry';
      s.hooks.leave('unreachable');
      return 'stop';
    }
    return 'skip';
  }

  async function round(s) {
    const version = await Wt.share.version(s.pollCtl.signal);
    if (!s.alive) return { ok: false, error: 'aborted' };
    if (!version.ok) return version;
    const header = headerOf(version);
    if (header.files !== s.lastFiles || s.forceList) {
      s.forceList = false;
      const list = await Wt.share.list(s.pollCtl.signal);
      if (!s.alive) return { ok: false, error: 'aborted' };
      if (!list.ok) return list;
      applyList(s, list);
      s.lastFiles = header.files;
    }
    if (header.clip !== s.lastClip) {
      if (!header.clip) {
        renderClipEmpty(s);
        s.lastClip = header.clip;
      } else {
        const clip = await Wt.share.clip(s.pollCtl.signal);
        if (!s.alive) return { ok: false, error: 'aborted' };
        if (!clip.ok) return clip;
        applyClip(s, clip);
        s.lastClip = header.clip;
      }
    }
    return { ok: true };
  }

  async function poll(s) {
    while (s.alive) {
      let outcome = 'skip';
      for (let attempt = 0; s.alive; attempt++) {
        let res;
        try {
          res = await round(s);
        } catch (e) {
          res = { ok: false, error: 'failed' };
        }
        if (!s.alive) return;
        if (res.ok) { outcome = 'ok'; break; }
        outcome = judge(s, res.error, attempt);
        if (outcome !== 'retry') break;
      }
      if (outcome === 'stop' || !s.alive) return;
      if (!s.forceList) await sleep(s, POLL_GAP_MS);
    }
  }

  function refreshListNow(s) {
    s.forceList = true;
    if (s.wake) s.wake();
  }

  // ---- folder list ----------------------------------------------------------------------------------

  function fileKey(f) {
    return `${f.path}\u0000${f.size}\u0000${f.mtime}`;
  }

  function applyList(s, res) {
    let files = [];
    if (res && Array.isArray(res.files)) {
      files = res.files;
    } else {
      try {
        const parsed = JSON.parse(DEC.decode(bodyBytes(res)));
        if (parsed && Array.isArray(parsed.files)) files = parsed.files;
      } catch (e) { /* an unreadable list is shown as empty until the next change */ }
    }
    files = files.filter((f) => f && typeof f.path === 'string');
    const keep = new Set(files.map(fileKey));
    const paths = new Set(files.map((f) => f.path));
    s.failedPaths.forEach((p) => { if (!paths.has(p)) s.failedPaths.delete(p); });
    for (const [key, row] of s.rows) {
      if (keep.has(key)) continue;
      row.controller.abort();
      s.controllers.delete(row.controller);
      row.dead = true;
      row.node.remove();
      s.rows.delete(key);
    }
    files.forEach((file) => {
      const key = fileKey(file);
      let row = s.rows.get(key);
      if (!row) {
        row = createRow(s, file);
        s.rows.set(key, row);
      }
      s.list.appendChild(row.node);
    });
    s.count.textContent = t('fileCount', files.length);
    s.listEmpty.hidden = files.length > 0;
    if (files.length === 0) s.list.appendChild(s.listEmpty);
  }

  function createRow(s, file) {
    const row = { file, dead: false, phase: 'idle', controller: newController(s) };
    const node = el('div', 'file');
    const thumb = el('div', 'thumb');
    const info = el('div');
    info.appendChild(el('b', '', file.path));
    row.meta = el('small', '', formatSize(file.size));
    info.appendChild(row.meta);
    row.note = el('small', 'warning');
    row.note.hidden = true;
    info.appendChild(row.note);
    row.action = el('div');
    node.append(thumb, info, row.action);
    row.node = node;
    row.thumb = thumb;

    const code = typeCode(file.path);
    const showCode = () => { thumb.className = 'thumb code'; thumb.textContent = code; };
    if (file.thumb === true) {
      s.thumbQueue.add(async () => {
        if (row.dead || !s.alive) return;
        const res = await Wt.share.thumb(file.path, row.controller.signal);
        if (row.dead || !s.alive) return;
        const bytes = res && res.ok ? bodyBytes(res) : null;
        if (bytes && bytes.length) {
          const img = el('img');
          img.alt = file.path;
          img.src = blobUrl(s, new Blob([bytes], { type: 'image/webp' }));
          thumb.appendChild(img);
        } else {
          showCode();
        }
      });
    } else {
      showCode();
    }

    if (file.tooLarge === true) {
      row.note.textContent = t('tooLarge');
      row.note.hidden = false;
    } else {
      if (s.failedPaths.has(file.path)) {
        row.note.textContent = t('downloadFailed');
        row.note.hidden = false;
      }
      renderAction(s, row);
    }
    return row;
  }

  function renderAction(s, row) {
    row.action.textContent = '';
    if (row.phase === 'busy') {
      row.action.appendChild(el('small', 'progress', row.pct === undefined ? t('downloading') : `${t('downloading')} ${row.pct}%`));
      return;
    }
    const button = el('button', 'link', t('download'));
    button.type = 'button';
    button.setAttribute('aria-label', t('downloadLabel', baseName(row.file.path)));
    button.onclick = () => startDownload(s, row);
    row.action.appendChild(button);
  }

  function progressPercent(loaded, size) {
    if (!(loaded >= 0) || !(size > 0)) return undefined;
    return Math.min(100, Math.floor((loaded * 100) / size));
  }

  function startDownload(s, row) {
    row.phase = 'busy';
    row.pct = undefined;
    row.note.hidden = true;
    s.failedPaths.delete(row.file.path);
    renderAction(s, row);
    s.downloadQueue.add(async () => {
      if (!s.alive) return;
      if (row.dead) {
        markDownloadFailed(s, row.file.path);
        return;
      }
      let res;
      try {
        res = await Wt.share.download(row.file, row.controller.signal, (arg) => {
          if (row.dead || !s.alive) return;
          row.pct = progressPercent(arg, row.file.size);
          renderAction(s, row);
        });
      } catch (e) {
        res = { ok: false, error: 'failed' };
      }
      if (!s.alive) return;
      if (!row.dead) row.phase = 'idle';
      if (res && res.ok && res.blob) {
        s.failedPaths.delete(row.file.path);
        saveBlob(res.blob, baseName(row.file.path));
      } else {
        markDownloadFailed(s, row.file.path);
        if (res && res.error === 'changed') refreshListNow(s);
      }
      if (!row.dead) renderAction(s, row);
    });
  }

  /** Puts "Download failed" on the current row of [path], even when the row that was downloading has since been replaced. */
  function markDownloadFailed(s, path) {
    let current = null;
    for (const row of s.rows.values()) if (row.file.path === path) current = row;
    if (!current || current.file.tooLarge === true) return;
    s.failedPaths.add(path);
    if (current.phase === 'busy') return;
    current.note.textContent = t('downloadFailed');
    current.note.hidden = false;
  }

  // ---- upload ---------------------------------------------------------------------------------------

  function showUploadNote(s, text, warning) {
    s.uploadNote.textContent = text;
    s.uploadNote.className = warning ? 'uploadnote warning' : 'uploadnote';
    s.uploadNote.hidden = !text;
  }

  function renderUpload(s) {
    const up = s.upload;
    s.uploadButton.disabled = up !== null;
    s.uploadCancel.hidden = up === null;
    s.uploadCancel.disabled = up !== null && up.cancelled;
    s.uploadProgress.hidden = up === null;
    if (up) {
      s.uploadProgress.textContent = up.pct === undefined ? t('uploading') : `${t('uploading')} ${up.pct}%`;
    }
  }

  function uploadErrorText(error) {
    if (error === 'too_large') return t('uploadTooLarge');
    if (error === 'busy') return t('uploadBusy');
    if (error === 'aborted' || error === 'cancelled') return t('uploadCancelled');
    return t('uploadFailed');
  }

  function cancelUpload(s) {
    const up = s.upload;
    if (!up || up.cancelled) return;
    up.cancelled = true;
    up.controller.abort();
    renderUpload(s);
  }

  async function startUpload(s, file) {
    if (s.upload) return;
    if (file.size > Wt.share.uploadMaxBytes) {
      showUploadNote(s, t('uploadTooLarge'), true);
      return;
    }
    const up = { controller: newController(s), cancelled: false, pct: progressPercent(0, file.size) };
    s.upload = up;
    showUploadNote(s, '', false);
    renderUpload(s);
    let res;
    try {
      res = await Wt.share.upload(file, up.controller.signal, (sent) => {
        if (!s.alive || s.upload !== up) return;
        const pct = progressPercent(sent, file.size);
        if (pct === up.pct) return;
        up.pct = pct;
        renderUpload(s);
      });
    } catch (e) {
      res = { ok: false, error: 'failed' };
    }
    s.controllers.delete(up.controller);
    if (!s.alive) return;
    s.upload = null;
    renderUpload(s);
    if (res && res.ok) {
      showUploadNote(s, t('uploadDone', res.name), false);
      refreshListNow(s);
    } else if (up.cancelled) {
      showUploadNote(s, t('uploadCancelled'), false);
    } else if (res && res.error === 'no_meeting') {
      showUploadNote(s, '', false);
    } else {
      showUploadNote(s, uploadErrorText(res && res.error), true);
    }
  }

  // ---- clipboard ------------------------------------------------------------------------------------

  function dropClipView(s) {
    if (!s.clipView) return;
    s.clipView.controller.abort();
    s.controllers.delete(s.clipView.controller);
    s.clipView = null;
  }

  function renderClipEmpty(s) {
    dropClipView(s);
    s.clip.textContent = '';
    s.clip.appendChild(el('p', 'empty', t('nothingYet')));
  }

  function applyClip(s, res) {
    const info = headerOf(res).clip;
    if (!info || typeof info !== 'object') {
      renderClipEmpty(s);
      return;
    }
    dropClipView(s);
    const view = { controller: newController(s) };
    s.clipView = view;
    s.clip.textContent = '';
    const box = el('div', 'clip');
    const when = info.time == null ? '' : clockText(info.time);
    if (info.kind === 'image') {
      box.appendChild(clipImageRow(s, view, info, bodyBytes(res)));
    } else {
      box.appendChild(el('p', '', DEC.decode(bodyBytes(res))));
      if (info.truncated) box.appendChild(el('div', 'warning', t('truncated')));
    }
    const meta = el('div', 'meta');
    meta.appendChild(el('time', '', when));
    if (info.kind !== 'image') {
      const copy = el('button', 'link', t('copy'));
      copy.type = 'button';
      copy.onclick = () => {
        navigator.clipboard.writeText(DEC.decode(bodyBytes(res))).then(() => {
          copy.textContent = t('copied');
          setTimeout(() => { copy.textContent = t('copy'); }, 1500);
        }, () => {});
      };
      meta.appendChild(copy);
    }
    box.appendChild(meta);
    s.clip.appendChild(box);
  }

  function clipImageRow(s, view, info, thumbBytes) {
    const node = el('div', 'file');
    const thumb = el('div', 'thumb');
    if (thumbBytes.length) {
      const img = el('img');
      img.alt = t('clipImage');
      img.src = blobUrl(s, new Blob([thumbBytes], { type: 'image/webp' }));
      thumb.appendChild(img);
    } else {
      thumb.className = 'thumb code';
      thumb.textContent = 'IMG';
    }
    const text = el('div');
    text.appendChild(el('b', '', t('clipImage')));
    text.appendChild(el('small', '', formatSize(info.size)));
    const note = el('small', 'warning');
    note.hidden = true;
    text.appendChild(note);
    const action = el('div');
    node.append(thumb, text, action);

    const row = { phase: 'idle', pct: undefined, action, note, file: { path: 'clipboard-image' }, dead: false };
    if (info.tooLarge === true) {
      note.textContent = t('tooLarge');
      note.hidden = false;
      return node;
    }
    const render = () => {
      action.textContent = '';
      if (row.phase === 'busy') {
        action.appendChild(el('small', 'progress', row.pct === undefined ? t('downloading') : `${t('downloading')} ${row.pct}%`));
        return;
      }
      const button = el('button', 'link', t('download'));
      button.type = 'button';
      button.setAttribute('aria-label', t('downloadLabel', t('clipImage')));
      button.onclick = () => {
        row.phase = 'busy';
        row.pct = undefined;
        note.hidden = true;
        render();
        s.downloadQueue.add(async () => {
          if (view.controller.signal.aborted || !s.alive) return;
          let res;
          try {
            res = await Wt.share.clipImage(info, view.controller.signal, (arg) => {
              if (view.controller.signal.aborted || !s.alive) return;
              row.pct = progressPercent(arg, info.size);
              render();
            });
          } catch (e) {
            res = { ok: false, error: 'failed' };
          }
          if (view.controller.signal.aborted || !s.alive) return;
          row.phase = 'idle';
          if (res && res.ok && res.blob) {
            const head = new Uint8Array(await res.blob.slice(0, 12).arrayBuffer());
            const ext = imageExtension(head);
            saveBlob(res.blob, ext ? `clipboard-${info.seq}.${ext}` : `clipboard-${info.seq}`);
          } else {
            note.textContent = t('downloadFailed');
            note.hidden = false;
          }
          render();
        });
      };
      action.appendChild(button);
    };
    render();
    return node;
  }

  return { start, stop };
})();
