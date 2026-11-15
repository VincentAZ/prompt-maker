// A small cutting room: edits describe source clips; originals are never changed.
export function createVideoEditor({ api, items, esc, save, watch, library }) {
  const $ = id => document.getElementById(id);
  const root = $('view-video-editor');
  const player = $('vePlayer');
  let available = [], clips = [], selected = null, busy = false, playing = false, result = null, drag = null;
  let loading = 0;
  let dropIndex = null, dragX = 0, scrollFrame = 0;
  const strip = $('veTimeline');
  const wrap = $('veTimelineWrap');
  const marker = $('veDropMarker');
  const key = it => `${it.render.id}/${it.file.file}`;
  const source = it => `/renders/${encodeURIComponent(it.file.file)}`;
  const current = () => clips.find(c => c.key === selected);
  const seconds = c => Math.max(0, (c.end ?? c.duration ?? 0) - c.start);
  const time = n => `${Number(n || 0).toFixed(2)}s`;
  const title = it => it.entry.theme || it.file.name || 'Untitled video';
  const ready = () => clips.length > 0 && clips.every(c => Number.isFinite(c.duration) && seconds(c) >= 0.1);

  function stop() {
    playing = false;
    player.pause();
    $('vePlay').textContent = '▶ Preview film';
  }
  function summary() {
    $('veSummary').textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${time(clips.reduce((n, c) => n + seconds(c), 0))}`;
    $('veSave').disabled = busy || !ready();
    $('vePlay').disabled = busy || !ready();
    for (const el of $('veTimeline').querySelectorAll('[data-length]')) {
      const c = clips.find(c => c.key === el.dataset.length);
      if (c) el.textContent = `${time(c.start)} – ${time(c.end ?? c.duration)} · ${time(seconds(c))}`;
    }
  }
  function trimFields() {
    const c = current();
    const enabled = !busy && Boolean(c?.duration);
    $('veTrim').disabled = !enabled;
    $('veClipTitle').textContent = c ? title(c.it) : 'Preview';
    $('veClipNumber').textContent = c ? `Clip ${clips.indexOf(c) + 1} of ${clips.length}` : '';
    $('vePreviewEmpty').hidden = Boolean(c);
    player.hidden = !c;
    if (!enabled) return;
    const end = c.end ?? c.duration;
    for (const id of ['veStart', 'veStartRange', 'veEnd', 'veEndRange']) $(id).max = c.duration.toFixed(3);
    $('veStart').value = $('veStartRange').value = c.start.toFixed(2);
    $('veEnd').value = $('veEndRange').value = end.toFixed(2);
    $('veTrimNote').textContent = `Keeping ${time(seconds(c))} of ${time(c.duration)}. Pause the preview, then choose Start here or End here.`;
  }
  function select(k, autoplay = false) {
    if (!autoplay) stop();
    selected = k;
    const c = current();
    $('vePreviewError').hidden = true;
    for (const el of $('veTimeline').children) {
      el.classList.toggle('active', el.dataset.key === k);
      el.querySelector('[data-action="select"]')?.setAttribute('aria-pressed', String(el.dataset.key === k));
    }
    trimFields();
    if (!c) { player.removeAttribute('src'); player.load(); return; }
    const url = new URL(source(c.it), location.href).href;
    if (player.src !== url) player.src = source(c.it);
    else if (player.readyState >= 1) startPreview();
  }
  function startPreview() {
    const c = current();
    if (!c) return;
    if (Number.isFinite(player.duration)) c.duration = player.duration;
    player.currentTime = c.start;
    trimFields(); summary();
    if (playing) player.play().catch(() => { stop(); $('vePreviewError').textContent = 'Press play on the preview to continue.'; $('vePreviewError').hidden = false; });
  }
  player.addEventListener('loadedmetadata', startPreview);
  player.addEventListener('error', () => {
    stop();
    $('vePreviewError').textContent = 'This video could not be previewed. Refresh your videos or choose another clip.';
    $('vePreviewError').hidden = false;
  });
  function advance() {
    const c = current();
    if (!c) return;
    if (playing) {
      const next = clips[clips.indexOf(c) + 1];
      if (next) select(next.key, true); else stop();
    } else { player.pause(); if (player.currentTime > (c.end ?? c.duration)) player.currentTime = c.end ?? c.duration; }
  }
  function checkEnd() {
    const c = current();
    if (c && !player.paused && player.currentTime >= (c.end ?? c.duration) - 0.025) advance();
  }
  let previewFrame = 0;
  function checkFrame() {
    checkEnd();
    if (!player.paused) previewFrame = requestAnimationFrame(checkFrame);
  }
  player.addEventListener('timeupdate', checkEnd);
  player.addEventListener('pause', () => cancelAnimationFrame(previewFrame));
  player.addEventListener('ended', () => { if (playing) advance(); });
  player.addEventListener('play', () => {
    cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(checkFrame);
    const c = current();
    if (c && (player.currentTime < c.start || player.currentTime >= (c.end ?? c.duration) - 0.025)) player.currentTime = c.start;
  });

  function renderLibrary() {
    const q = $('veSearch').value.toLowerCase().trim();
    const shown = available.filter(it => title(it).toLowerCase().includes(q));
    $('veLibraryNote').textContent = !available.length ? 'Your rendered videos will appear here. Make a video in Create first.' : !shown.length ? 'No videos match that search.' : `${available.length} video${available.length === 1 ? '' : 's'} to choose from`;
    $('veLibrary').replaceChildren();
    for (const it of shown) {
      const k = key(it), added = clips.some(c => c.key === k);
      const tile = document.createElement('div');
      tile.className = 've-source';
      tile.innerHTML = `<video muted playsinline preload="metadata" src="${esc(source(it))}#t=0.1"></video><span title="${esc(title(it))}">${esc(title(it))}</span><button type="button" class="btn small" data-add="${esc(k)}" ${added || busy ? 'disabled' : ''}>${added ? '✓ Added' : '＋ Add'}</button>`;
      tile.querySelector('video').addEventListener('loadedmetadata', e => {
        const c = clips.find(c => c.key === k);
        if (c && Number.isFinite(e.target.duration)) { c.duration = e.target.duration; summary(); if (selected === k) trimFields(); }
      });
      $('veLibrary').append(tile);
    }
  }
  function timeline(focusKey, action) {
    $('veTimeline').innerHTML = clips.map((c, i) => `<li class="ve-clip${selected === c.key ? ' active' : ''}" draggable="${!busy && clips.length > 1}" data-key="${esc(c.key)}">
      <button type="button" class="ve-drag-handle" data-action="drag" title="Drag to reorder, or use the Left and Right arrow keys" aria-label="Rearrange clip ${i + 1}: drag or use Left and Right arrow keys"><svg viewBox="0 0 16 20" aria-hidden="true"><circle cx="5" cy="4" r="1.4"/><circle cx="11" cy="4" r="1.4"/><circle cx="5" cy="10" r="1.4"/><circle cx="11" cy="10" r="1.4"/><circle cx="5" cy="16" r="1.4"/><circle cx="11" cy="16" r="1.4"/></svg><span>Drag to move</span><b>Clip ${i + 1}</b></button>
      <button type="button" data-action="select" aria-pressed="${selected === c.key}" aria-label="Edit clip ${i + 1}: ${esc(title(c.it))}"><video muted playsinline preload="metadata" src="${esc(source(c.it))}#t=${c.start || 0.1}"></video><b>${esc(title(c.it))}</b><small data-length="${esc(c.key)}">${time(c.start)} – ${time(c.end ?? c.duration)} · ${time(seconds(c))}</small></button>
      <div class="ve-clip-actions"><button class="btn small" type="button" data-action="earlier" aria-label="Move clip ${i + 1} earlier" ${!i || busy ? 'disabled' : ''}>←</button><button class="btn small" type="button" data-action="later" aria-label="Move clip ${i + 1} later" ${i === clips.length - 1 || busy ? 'disabled' : ''}>→</button><button class="btn small" type="button" data-action="remove" aria-label="Remove clip ${i + 1}" ${busy ? 'disabled' : ''}>Remove</button></div></li>`).join('');
    $('veEmpty').hidden = Boolean(clips.length);
    summary(); trimFields();
    if (focusKey) {
      const el = [...$('veTimeline').children].find(el => el.dataset.key === focusKey);
      (el?.querySelector(`[data-action="${action || 'select'}"]:not(:disabled)`) || el?.querySelector('[data-action="select"]'))?.focus();
    }
  }
  function add(it) {
    if (busy || clips.some(c => c.key === key(it))) return;
    if (clips.length >= 60) { $('veStatus').textContent = 'Use up to 60 clips in one film.'; return; }
    const tile = [...$('veLibrary').querySelectorAll('[data-add]')].find(el => el.dataset.add === key(it))?.parentElement;
    const duration = tile?.querySelector('video').duration;
    clips.push({ key: key(it), it, start: 0, end: null, duration: Number.isFinite(duration) ? duration : null });
    select(key(it)); timeline(); renderLibrary();
  }
  $('veLibrary').addEventListener('click', e => {
    const b = e.target.closest('[data-add]');
    const it = b && available.find(it => key(it) === b.dataset.add);
    if (it) add(it);
  });
  function move(from, to, action) {
    stop();
    const [c] = clips.splice(from, 1); clips.splice(to, 0, c);
    timeline(c.key, action);
    $('veOrderStatus').textContent = `Moved clip ${from + 1} to position ${to + 1} of ${clips.length}. Trims stay with each clip.`;
  }
  $('veTimeline').addEventListener('click', e => {
    if (busy) return;
    const b = e.target.closest('[data-action]'), el = b?.closest('[data-key]');
    if (!el) return;
    const i = clips.findIndex(c => c.key === el.dataset.key);
    if (b.dataset.action === 'select') select(el.dataset.key);
    else if (b.dataset.action === 'earlier' && i > 0) move(i, i - 1, 'earlier');
    else if (b.dataset.action === 'later' && i < clips.length - 1) move(i, i + 1, 'later');
    else if (b.dataset.action === 'remove') {
      stop(); clips.splice(i, 1);
      if (selected === el.dataset.key) select(clips[Math.min(i, clips.length - 1)]?.key ?? null);
      timeline(clips[Math.min(i, clips.length - 1)]?.key); renderLibrary();
    }
  });
  strip.addEventListener('keydown', e => {
    if (busy || !e.target.closest('[data-action="drag"]')) return;
    const from = clips.findIndex(c => c.key === e.target.closest('[data-key]')?.dataset.key);
    const to = e.key === 'ArrowLeft' ? from - 1 : e.key === 'ArrowRight' ? from + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? clips.length - 1 : null;
    if (to == null) return;
    e.preventDefault();
    if (to >= 0 && to < clips.length && to !== from) move(from, to, 'drag');
  });
  function clearDrag() {
    cancelAnimationFrame(scrollFrame);
    drag = null; dropIndex = null;
    marker.hidden = true;
    wrap.classList.remove('drag-active');
    strip.querySelector('.dragging')?.classList.remove('dragging');
  }
  function showDrop(x) {
    const others = [...strip.children].filter(el => el.dataset.key !== drag);
    const slot = others.findIndex(el => x < el.getBoundingClientRect().left + el.offsetWidth / 2);
    dropIndex = slot < 0 ? others.length : slot;
    const before = others[dropIndex], last = others.at(-1);
    const edge = before ? before.getBoundingClientRect().left - 10 : last ? last.getBoundingClientRect().right + 10 : strip.getBoundingClientRect().left + 14;
    const bounds = wrap.getBoundingClientRect();
    const markerX = Math.max(9, Math.min(bounds.width - 10, edge - bounds.left));
    marker.style.left = `${markerX}px`;
    marker.querySelector('span').style.left = `${Math.max(65, Math.min(bounds.width - 65, markerX)) - markerX}px`;
    marker.querySelector('span').textContent = `Drop as clip ${dropIndex + 1}`;
    marker.hidden = false;
    const message = `Release to place this as clip ${dropIndex + 1} of ${clips.length}.`;
    if ($('veOrderStatus').textContent !== message) $('veOrderStatus').textContent = message;
  }
  function scrollDrag() {
    if (!drag) return;
    const rect = strip.getBoundingClientRect();
    const speed = dragX < rect.left + 46 ? -9 : dragX > rect.right - 46 ? 9 : 0;
    if (speed) { strip.scrollLeft += speed; showDrop(dragX); }
    scrollFrame = requestAnimationFrame(scrollDrag);
  }
  strip.addEventListener('dragstart', e => {
    if (busy || clips.length < 2 || e.target.closest('.ve-clip-actions')) { e.preventDefault(); return; }
    const el = e.target.closest('[data-key]');
    drag = el?.dataset.key;
    if (!drag) return;
    stop();
    e.dataTransfer.setData('text/plain', drag);
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('drag-active');
    dragX = e.clientX;
    requestAnimationFrame(() => { if (drag === el.dataset.key) el.classList.add('dragging'); });
    $('veOrderStatus').textContent = 'Move the clip to a green line, then release to place it.';
    scrollFrame = requestAnimationFrame(scrollDrag);
  });
  wrap.addEventListener('dragover', e => {
    if (!drag || busy) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    dragX = e.clientX; showDrop(dragX);
  });
  wrap.addEventListener('dragleave', e => {
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    const rect = wrap.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) return;
    dropIndex = null; marker.hidden = true;
    cancelAnimationFrame(scrollFrame);
  });
  wrap.addEventListener('dragenter', () => {
    if (drag) { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(scrollDrag); }
  });
  wrap.addEventListener('drop', e => {
    if (!drag || busy) return;
    e.preventDefault();
    showDrop(e.clientX);
    const from = clips.findIndex(c => c.key === drag), to = dropIndex;
    clearDrag();
    if (from >= 0 && to != null && from !== to) move(from, to, 'drag');
    else $('veOrderStatus').textContent = 'Clip kept in the same position.';
  });
  strip.addEventListener('dragend', () => {
    if (drag) $('veOrderStatus').textContent = 'Order unchanged. Drag a clip to a green line to move it.';
    clearDrag();
  });
  function trim(which, value) {
    const c = current();
    if (busy || !c?.duration || !Number.isFinite(value)) return;
    stop();
    if (which === 'start') c.start = Math.max(0, Math.min(value, (c.end ?? c.duration) - 0.1));
    else c.end = Math.min(c.duration, Math.max(value, c.start + 0.1));
    player.currentTime = which === 'start' ? c.start : c.end;
    trimFields(); summary();
  }
  for (const [id, which] of [['veStart', 'start'], ['veEnd', 'end'], ['veStartRange', 'start'], ['veEndRange', 'end']]) {
    $(id).addEventListener(id.endsWith('Range') ? 'input' : 'change', e => trim(which, e.target.value === '' ? NaN : Number(e.target.value)));
  }
  $('veSetStart').addEventListener('click', () => trim('start', player.currentTime));
  $('veSetEnd').addEventListener('click', () => trim('end', player.currentTime));
  $('veResetTrim').addEventListener('click', () => { const c = current(); if (!c || busy) return; stop(); c.start = 0; c.end = null; player.currentTime = 0; trimFields(); summary(); });
  $('vePlay').addEventListener('click', () => {
    if (playing) return stop();
    if (!ready()) return;
    playing = true; $('vePlay').textContent = '■ Stop preview'; select(clips[0].key, true);
  });
  $('veSearch').addEventListener('input', renderLibrary);
  async function load() {
    const request = ++loading;
    try {
      const history = await api('/api/history');
      if (request !== loading) return;
      available = items(history).filter(it => it.file.kind === 'video' && !it.render.hidden);
      renderLibrary();
    } catch (err) { $('veLibraryNote').textContent = `Couldn't load your videos: ${err.message}`; }
  }
  $('veRefresh').addEventListener('click', load);
  $('veSave').addEventListener('click', async () => {
    if (busy || !ready()) return;
    stop(); busy = true;
    for (const el of root.querySelectorAll('button, input')) el.disabled = true;
    $('veResult').hidden = true;
    $('veSave').textContent = 'Saving video…';
    $('veStatus').textContent = 'Putting your film together… You can keep working in another tab.';
    try {
      result = await save(clips.map(c => ({ id: c.it.render.id, file: c.it.file.file, start: c.start, end: c.end ?? c.duration })), $('veTitle').value.trim() || 'My film');
      $('veStatus').textContent = `Saved “${result.entry.theme}” · ${time(result.seconds)}. The original clips are kept.`;
      $('veDownload').href = `/renders/${encodeURIComponent(result.render.files[0].file)}`;
      $('veDownload').download = result.render.files[0].name;
      $('veResult').hidden = false;
    } catch (err) { $('veStatus').textContent = `Couldn't save the video: ${err.message}. Your edits are still here.`; }
    finally {
      busy = false;
      for (const el of root.querySelectorAll('button, input')) el.disabled = false;
      $('veSave').textContent = 'Save video'; timeline(); renderLibrary();
    }
  });
  $('veViewResult').addEventListener('click', () => { if (result) watch(result); });
  $('veOpenLibrary').addEventListener('click', library);
  select(null); timeline();
  return {
    load,
    pause() { stop(); clearDrag(); },
    open(initial) {
      if (busy) return;
      stop(); clips = []; selected = null; result = null;
      $('veResult').hidden = true; $('veTitle').value = '';
      $('veStatus').textContent = 'The original clips stay in your Library. Your saved film appears there too.';
      for (const it of initial.filter(it => it.file.kind === 'video').slice(0, 60)) if (!clips.some(c => c.key === key(it))) clips.push({ key: key(it), it, start: 0, end: null, duration: null });
      select(clips[0]?.key ?? null); timeline(); load();
    },
  };
}
