/**
 * Dashboard controller — manages phases, table rendering, CSV export.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let allVideos = [];          // After phase 1
let enrichedVideos = [];     // After phase 2
let downloadVideos = [];     // Videos selected for download
let completedDownloads = []; // Verified completed downloads
let selectedDirHandle = null;
let dlStats = { active: 0, queued: 0, done: 0, errors: 0 };
let maxReachedPhase = 1;

const MAX_DL_CONCURRENT = 4;

// Pause/stop controls
let dlPaused = false;
let dlStopped = false;
let dlPauseResolvers = [];          // all slots waiting on pause
let dlAbortControllers = new Map(); // videoId → AbortController
let dlFailedVideos = [];            // videos that errored or were stopped

// ─── Phase helpers ────────────────────────────────────────────────────────────

function setPhase(num) {
  maxReachedPhase = Math.max(maxReachedPhase, num);

  // Update dots — all non-active dots are always reachable
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById(`dot-${i}`);
    const lbl = document.getElementById(`lbl-${i}`);
    dot.classList.remove('active', 'done', 'reachable');
    lbl.classList.remove('active');
    if (i < num)  dot.classList.add('done');
    if (i === num) { dot.classList.add('active'); lbl.classList.add('active'); }
    if (i !== num) dot.classList.add('reachable');
  }

  // Show/hide panels
  for (let i = 1; i <= 5; i++) {
    document.getElementById(`panel-${i}`).hidden = (i !== num);
  }

  if (num === 1) checkLogin();
  if (num === 5) renderSocialPreviews();
}

// Returns how many videos in the catalogue have not been verified as downloaded
function unverifiedCount() {
  if (!allVideos.length) return 0;
  const verifiedIds = new Set([
    ...completedDownloads.filter(v => v.verified).map(v => v.id),
    ...downloadVideos.filter(v => v.savedFilename).map(v => v.id)
  ]);
  return allVideos.filter(v => !verifiedIds.has(v.id)).length;
}

function warnUnverified(action) {
  const n = unverifiedCount();
  if (n === 0) return true;
  const total = allVideos.length;
  return confirm(
    `${n} of ${total} video${n !== 1 ? 's have' : ' has'} not been downloaded and verified.\n\n` +
    `${action} without verified downloads means those videos may be permanently lost.\n\nProceed anyway?`
  );
}

// Clickable phase dots — always reachable, warn on phase 4 & 5
for (let i = 1; i <= 5; i++) {
  document.getElementById(`dot-${i}`).addEventListener('click', () => {
    if ((i === 4 || i === 5) && !warnUnverified('Proceeding')) return;
    if (i === 4) renderPhase4Table(downloadVideos.length > 0 ? downloadVideos : enrichedVideos);
    setPhase(i);
  });
}

function setStatus(text, counts = '') {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-counts').textContent = counts;
}

// ─── Phase 1: Fetch Catalogue ─────────────────────────────────────────────────

document.getElementById('btn-fetch').addEventListener('click', async () => {
  document.getElementById('btn-fetch').disabled = true;
  document.getElementById('fetch-progress').hidden = false;
  setStatus('Opening background tab on ManyVids…');

  const response = await sendBg({ type: 'FETCH_CATALOGUE' });

  document.getElementById('fetch-progress').hidden = true;
  document.getElementById('btn-fetch').disabled = false;

  if (!response.ok) {
    setStatus('Error: ' + response.error);
    alert('Failed to fetch catalogue: ' + response.error);
    return;
  }

  allVideos = response.videos;
  enrichedVideos = allVideos.map(v => ({ ...v }));
  await chrome.storage.local.set({ mvdl_allVideos: allVideos, mvdl_details: {} });
  setStatus(`Catalogue fetched. Now click "Fetch Details from Edit Pages →" to get descriptions, keywords, and download links.`, `${allVideos.length} videos found`);
  // Show Proceed to Downloads — details not required, but will warn if missing
  const proceedBtn = document.getElementById('btn-proceed-downloads');
  proceedBtn.hidden = false;
  proceedBtn.disabled = true;

  renderPhase2Table(allVideos);
  setPhase(2);
  // Scroll so the action button is visible
  document.getElementById('btn-fetch-details').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ─── Re-scan & Merge ──────────────────────────────────────────────────────────

async function doRescan(triggerBtn) {
  triggerBtn.disabled = true;
  document.getElementById('fetch-progress').hidden = false;
  setStatus('Re-scanning catalogue…');

  const response = await sendBg({ type: 'FETCH_CATALOGUE' });

  document.getElementById('fetch-progress').hidden = true;
  triggerBtn.disabled = false;

  if (!response.ok) {
    setStatus('Error: ' + response.error);
    alert('Re-scan failed: ' + response.error);
    return;
  }

  const newVideos = response.videos;
  const existingMap = {};
  enrichedVideos.forEach(v => { existingMap[v.id] = v; });

  const merged = newVideos.map(v => {
    if (existingMap[v.id]) {
      return {
        ...existingMap[v.id],
        title: v.title, editUrl: v.editUrl, thumbUrl: v.thumbUrl,
        views: v.views, purchases: v.purchases, price: v.price,
        earned: v.earned, isPinned: v.isPinned
      };
    }
    return { ...v };
  });

  const addedCount = merged.filter(v => !existingMap[v.id]).length;
  const updatedCount = merged.length - addedCount;

  allVideos = merged.map(v => ({
    id: v.id, title: v.title, editUrl: v.editUrl, thumbUrl: v.thumbUrl,
    views: v.views, purchases: v.purchases, price: v.price,
    earned: v.earned, isPinned: v.isPinned
  }));
  enrichedVideos = merged;

  await saveToStorage();
  renderPhase2Table(enrichedVideos);
  setPhase(2);

  document.getElementById('btn-proceed-downloads').hidden = false;
  const withDetails = enrichedVideos.filter(v => v.title && v.price && v.views && v.purchases && v.publishedAt && v.description && v.keywords && v.downloadUrl).length;
  if (withDetails > 0) {
    // Restore re-fetch button style since we have existing details
    const fetchBtn = document.getElementById('btn-fetch-details');
    fetchBtn.textContent = 'Re-fetch Details →';
    fetchBtn.classList.remove('btn-primary');
    fetchBtn.classList.add('btn-refetch-details');
  }
  updateSelectionCount();

  setStatus(
    `Re-scan complete — ${updatedCount} matched, ${addedCount} new`,
    `${allVideos.length} total · ${withDetails} with details`
  );
}

document.getElementById('btn-rescan-2').addEventListener('click', function () { doRescan(this); });

// ─── Phase 2: Review & Enrich ─────────────────────────────────────────────────

function renderPhase2Table(videos) {
  const tbody = document.getElementById('video-tbody');
  tbody.innerHTML = '';

  videos.forEach((v, i) => {
    const tr = document.createElement('tr');
    tr.dataset.videoId = v.id;
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" checked data-id="${v.id}"></td>
      <td class="col-num">${i + 1}</td>
      <td class="col-title">${esc(v.title)}</td>
      <td class="col-price" id="price-${v.id}">${v.price ? '$' + esc(v.price) : ''}</td>
      <td class="col-views" id="views-${v.id}">${esc(v.views || '')}</td>
      <td class="col-purchases" id="purchases-${v.id}">${esc(v.purchases || '')}</td>
      <td class="col-date" id="date-${v.id}">${v.publishedAt ? esc(v.publishedAt) : '<span class="url-missing">Not fetched</span>'}</td>
      <td class="col-desc"><div class="cell-truncate" id="desc-${v.id}">${v.description ? esc(v.description) : '<span class="url-missing">Not fetched</span>'}</div></td>
      <td class="col-kw"><div class="cell-truncate" id="kw-${v.id}">${v.keywords ? esc(v.keywords) : '<span class="url-missing">Not fetched</span>'}</div></td>
      <td class="col-url url-cell" id="url-${v.id}">
        ${v.downloadUrl
          ? `<a href="${esc(v.downloadUrl)}" target="_blank" title="${esc(v.downloadUrl)}">Link ↗</a>`
          : `<span class="url-missing">Not fetched</span>`}
      </td>
      <td class="col-status"><span class="badge ${v.title && v.price && v.views && v.purchases && v.publishedAt && v.description && v.keywords && v.downloadUrl ? 'badge-ready' : 'badge-pending'}" id="vstatus-${v.id}">${v.title && v.price && v.views && v.purchases && v.publishedAt && v.description && v.keywords && v.downloadUrl ? 'Ready' : 'Pending'}</span></td>
      <td class="col-refetch"><button class="btn-refetch" data-id="${v.id}" title="Re-fetch details">↻</button></td>
    `;
    tbody.appendChild(tr);
  });

  updateSelectionCount();
}

function updateDetailRow(v) {
  const descEl  = document.getElementById('desc-' + v.id);
  const kwEl    = document.getElementById('kw-' + v.id);
  const urlCell = document.getElementById('url-' + v.id);
  const dateEl  = document.getElementById('date-' + v.id);
  const badge   = document.getElementById('vstatus-' + v.id);

  if (descEl)  descEl.textContent = v.description  || '';
  if (kwEl)    kwEl.textContent   = v.keywords     || '';
  if (dateEl)  dateEl.textContent = v.publishedAt  || '';

  if (urlCell) {
    if (v.downloadUrl) {
      urlCell.innerHTML = `<a href="${esc(v.downloadUrl)}" target="_blank" title="${esc(v.downloadUrl)}">Link ↗</a>`;
    } else {
      urlCell.innerHTML = `<span class="url-missing">Not found</span>`;
    }
  }

  if (badge) {
    const isReady = v.title && v.price && v.views && v.purchases &&
                    v.publishedAt && v.description && v.keywords && v.downloadUrl;
    if (isReady) {
      badge.className = 'badge badge-ready';
      badge.textContent = 'Ready';
    } else if (v.detailError) {
      badge.className = 'badge badge-error';
      badge.textContent = 'Error';
    } else if (!v.downloadUrl) {
      badge.className = 'badge badge-no-url';
      badge.textContent = 'No URL';
    } else {
      badge.className = 'badge badge-pending';
      badge.textContent = 'Pending';
    }
  }
}

function updateSelectionCount() {
  const checked = document.querySelectorAll('.row-check:checked').length;
  document.getElementById('selection-count').textContent = `${checked} of ${allVideos.length} selected`;
  document.getElementById('btn-proceed-downloads').disabled = checked === 0;
}

// Check-all toggle
document.getElementById('check-all').addEventListener('change', e => {
  document.querySelectorAll('.row-check').forEach(c => c.checked = e.target.checked);
  updateSelectionCount();
});

document.getElementById('btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('.row-check').forEach(c => c.checked = true);
  document.getElementById('check-all').checked = true;
  updateSelectionCount();
});

document.getElementById('btn-deselect-all').addEventListener('click', () => {
  document.querySelectorAll('.row-check').forEach(c => c.checked = false);
  document.getElementById('check-all').checked = false;
  updateSelectionCount();
});

document.getElementById('video-tbody').addEventListener('change', e => {
  if (e.target.classList.contains('row-check')) updateSelectionCount();
});

document.getElementById('video-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-refetch');
  if (!btn) return;
  const videoId = btn.dataset.id;
  const video = allVideos.find(v => v.id === videoId);
  if (!video) return;

  btn.disabled = true;
  btn.textContent = '…';
  const badge = document.getElementById('vstatus-' + videoId);
  if (badge) { badge.className = 'badge badge-fetching'; badge.textContent = 'Fetching…'; }
  const descEl = document.getElementById('desc-' + videoId);
  const kwEl   = document.getElementById('kw-'   + videoId);
  const urlEl  = document.getElementById('url-'  + videoId);
  if (descEl) descEl.innerHTML = '<span class="url-missing">Fetching…</span>';
  if (kwEl)   kwEl.innerHTML   = '<span class="url-missing">Fetching…</span>';
  if (urlEl)  urlEl.innerHTML  = '<span class="url-missing">Fetching…</span>';

  const response = await sendBg({ type: 'FETCH_VIDEO_DETAILS', videos: [video] });
  btn.disabled = false;
  btn.textContent = '↻';

  if (!response.ok) {
    if (badge) { badge.className = 'badge badge-error'; badge.textContent = 'Error'; }
    return;
  }

  const updated = response.videos[0];
  if (!updated) return;
  updateDetailRow(updated);
  const idx = enrichedVideos.findIndex(v => v.id === videoId);
  if (idx >= 0) enrichedVideos[idx] = { ...enrichedVideos[idx], ...updated };
  else enrichedVideos.push(updated);
  await saveVideoDetail(updated);
});

// Fetch Details
document.getElementById('btn-fetch-details').addEventListener('click', async function () {
  const btn = this;

  // If already fetching, act as Stop button
  if (btn.dataset.fetching === 'true') {
    await sendBg({ type: 'STOP_FETCH_DETAILS' });
    btn.textContent = 'Stopping…';
    btn.disabled = true;
    return;
  }

  // Save current label so we can restore it if stopped mid-way
  const prevText = btn.textContent;
  btn.dataset.fetching = 'true';
  btn.textContent = 'Stop Fetching';
  btn.classList.remove('btn-primary', 'btn-refetch-details');
  btn.classList.add('btn-stop');
  document.getElementById('btn-proceed-downloads').disabled = true;
  document.getElementById('details-progress').hidden = false;
  setStatus('Fetching video details (description, keywords, download URL)…');

  const checkedIds = new Set(
    Array.from(document.querySelectorAll('.row-check:checked')).map(c => c.dataset.id)
  );
  const videosToFetch = allVideos.filter(v => checkedIds.has(v.id));
  const response = await sendBg({ type: 'FETCH_VIDEO_DETAILS', videos: videosToFetch });

  btn.dataset.fetching = 'false';
  btn.disabled = false;
  btn.classList.remove('btn-stop');
  document.getElementById('details-progress').hidden = true;
  document.getElementById('btn-proceed-downloads').disabled = false;

  if (!response.ok) {
    setStatus('Error: ' + response.error);
    alert('Failed to fetch video details: ' + response.error);
    return;
  }

  if (response.ok) enrichedVideos = response.videos;
  enrichedVideos.forEach(updateDetailRow);

  const withUrl = enrichedVideos.filter(v => v.downloadUrl).length;
  const stopped = !response.ok || enrichedVideos.length < allVideos.length;
  setStatus(
    stopped ? 'Fetch stopped.' : 'Details fetched.',
    `${withUrl}/${enrichedVideos.length} have download URLs`
  );

  // Always switch to "Re-fetch" style after any fetch attempt
  btn.textContent = 'Re-fetch Details →';
  btn.classList.add('btn-refetch-details');

  if (withUrl > 0) {
    const proceedBtn = document.getElementById('btn-proceed-downloads');
    proceedBtn.hidden = false;
    updateSelectionCount();
  }
});

// Proceed to Downloads — set up table and show folder picker, don't start yet
document.getElementById('btn-proceed-downloads').addEventListener('click', () => {
  const checkedIds = new Set(
    Array.from(document.querySelectorAll('.row-check:checked')).map(c => c.dataset.id)
  );

  const source = enrichedVideos.length > 0 ? enrichedVideos : allVideos;
  downloadVideos = source.filter(v => checkedIds.has(v.id));

  if (downloadVideos.length === 0) { alert('No videos selected.'); return; }

  const isReady = v => v.title && v.price && v.views && v.purchases &&
                       v.publishedAt && v.description && v.keywords && v.downloadUrl;
  const notReady = downloadVideos.filter(v => !isReady(v)).length;
  if (notReady > 0) {
    const ok = confirm(
      `${notReady} of ${downloadVideos.length} selected video${downloadVideos.length !== 1 ? 's' : ''} ` +
      `aren't ready yet — details haven't been fully fetched and they'll be skipped during download.\n\n` +
      `Go back and click "Fetch Details" first, or continue and those videos will be skipped.`
    );
    if (!ok) return;
  }

  completedDownloads = [];
  renderPhase3Table(downloadVideos);
  setPhase(3);
  document.getElementById('download-options').hidden = false;
  document.getElementById('btn-go-delete').hidden = true;
  updateDlStats({ active: 0, queued: 0, done: 0, errors: 0 });
  setStatus('Choose a download folder then click Start Downloads.');
});

// Choose folder
document.getElementById('btn-choose-folder').addEventListener('click', async () => {
  try {
    selectedDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    document.getElementById('selected-folder-name').textContent = '📁 ' + selectedDirHandle.name + ' (full path not exposed by browser API)';
    document.getElementById('btn-start-downloads').disabled = false;
    await scanFolderForExisting(selectedDirHandle);
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not open folder: ' + e.message);
  }
});

async function scanFolderForExisting(dirHandle) {
  const existingFiles = new Set();
  for await (const [name] of dirHandle.entries()) {
    existingFiles.add(name);
  }

  let alreadyCount = 0;
  for (const v of downloadVideos) {
    const expected = sanitizeDlFilename(v.title) + '.mp4';
    if (existingFiles.has(expected)) {
      v.savedFilename = expected;   // persist on video object for phase 4
      setDlRowExisting(v.id, expected);
      alreadyCount++;
    }
  }

  if (alreadyCount > 0) {
    setStatus(
      `Folder scanned — ${alreadyCount} file${alreadyCount !== 1 ? 's' : ''} already present.`,
      `${alreadyCount} / ${downloadVideos.length} already downloaded`
    );
    // Allow proceeding to delete even if nothing new to download
    document.getElementById('btn-go-delete').hidden = false;
  }
}

function setDlRowExisting(videoId, filename) {
  setDlRowFilename(videoId, filename);
  const cell = document.getElementById('dlstatus-' + videoId)?.closest('td');
  if (!cell) return;
  // Replace cell content with badge + re-download button, preserve progress bar
  const progressWrap = document.getElementById('dlprog-wrap-' + videoId);
  cell.innerHTML = `
    <span class="badge badge-done" id="dlstatus-${videoId}">Already exists</span>
    <button class="btn-redownload" data-id="${videoId}" title="Re-download and overwrite existing file">↺</button>
  `;
  if (progressWrap) cell.appendChild(progressWrap);
}

// Start Downloads
document.getElementById('btn-start-downloads').addEventListener('click', async () => {
  if (!selectedDirHandle) { alert('Please choose a folder first.'); return; }
  document.getElementById('download-options').hidden = true;
  completedDownloads = [];
  dlFailedVideos = [];
  const toDownload = downloadVideos.filter(v => {
    if (!v.fileUrl) return false;
    // Skip videos already present in the chosen folder
    const badge = document.getElementById('dlstatus-' + v.id);
    if (badge && badge.textContent === 'Already exists') return false;
    return true;
  });
  updateDlStats({ active: 0, queued: toDownload.length, done: 0, errors: 0 });
  setStatus('Downloads started…', `${toDownload.length} queued`);
  showDlControls(true);
  await runDownloadQueue(toDownload);
});

document.getElementById('btn-pause-downloads').addEventListener('click', () => {
  dlPaused = !dlPaused;
  const btn = document.getElementById('btn-pause-downloads');
  if (dlPaused) {
    btn.textContent = 'Resume';
    setStatus('Downloads paused — active files will finish their current chunk.');
  } else {
    btn.textContent = 'Pause';
    // Unblock all slots waiting on pause
    const resolvers = dlPauseResolvers.splice(0);
    resolvers.forEach(r => r());
    setStatus('Downloads resumed…');
  }
});

document.getElementById('btn-stop-downloads').addEventListener('click', () => {
  if (!confirm('Stop all downloads? Partial files will be deleted.')) return;
  dlStopped = true;
  dlPaused = false;
  // Unblock any paused slots so they can see dlStopped
  const resolvers = dlPauseResolvers.splice(0);
  resolvers.forEach(r => r());
  // Abort all active fetches — downloadFileToDir will clean up partial files
  dlAbortControllers.forEach(ac => ac.abort());
  dlAbortControllers.clear();
  setStatus('Stopping downloads…');
});

document.getElementById('btn-restart-downloads').addEventListener('click', async () => {
  if (!selectedDirHandle) { alert('No folder selected — please go back and start again.'); return; }
  if (dlFailedVideos.length === 0) { alert('No failed downloads to restart.'); return; }
  const toRetry = [...dlFailedVideos];
  dlFailedVideos = [];
  document.getElementById('btn-restart-downloads').hidden = true;
  showDlControls(true);
  updateDlStats({ errors: 0 });
  setStatus('Retrying failed downloads…', `${toRetry.length} queued`);
  await runDownloadQueue(toRetry);
});

function waitIfPaused() {
  if (!dlPaused) return Promise.resolve();
  return new Promise(r => dlPauseResolvers.push(r));
}

async function runDownloadQueue(toDownload) {
  dlStopped = false;
  dlPaused = false;
  dlPauseResolvers = [];

  const total = toDownload.length;
  let idx = 0;           // next item index — shared across slots (safe: JS is single-threaded)
  let activeCount = 0;
  let done = dlStats.done;
  let errors = dlStats.errors;

  async function runSlot() {
    while (true) {
      await waitIfPaused();
      if (dlStopped || idx >= total) break;

      const video = toDownload[idx++];
      const ac = new AbortController();
      dlAbortControllers.set(video.id, ac);
      activeCount++;
      updateDlStats({ active: activeCount, queued: Math.max(0, total - idx), done, errors });
      setDlRowStatus(video.id, 'badge-active', 'Downloading…');
      setDlRowProgress(video.id, null);

      try {
        const { filename, verified } = await downloadFileToDir(
          video, selectedDirHandle,
          pct => setDlRowProgress(video.id, pct),
          ac.signal
        );
        dlAbortControllers.delete(video.id);
        activeCount--;
        done++;
        setDlRowStatus(video.id, 'badge-done', verified ? '✓ Verified' : 'Done');
        setDlRowFilename(video.id, filename);
        video.savedFilename = filename;
        completedDownloads.push({ ...video, verified });
      } catch (err) {
        dlAbortControllers.delete(video.id);
        activeCount--;
        const wasAborted = err.name === 'AbortError';
        if (!wasAborted) {
          errors++;
          setStatus(`Error: "${video.title}" — ${err.message}`);
        }
        setDlRowStatus(video.id, 'badge-error', wasAborted ? 'Stopped' : 'Error');
        dlFailedVideos.push(video);
      }
      updateDlStats({ active: activeCount, queued: Math.max(0, total - idx), done, errors });
    }

    // If stopped, mark any items this slot didn't start
    if (dlStopped) {
      // Only one slot needs to drain the queue; guard with idx check
      while (idx < total) {
        const v = toDownload[idx++];
        if (document.getElementById('dlstatus-' + v.id)?.textContent === 'Queued') {
          setDlRowStatus(v.id, 'badge-error', 'Stopped');
          dlFailedVideos.push(v);
        }
      }
    }
  }

  // Run MAX_DL_CONCURRENT slots concurrently
  await Promise.all(Array.from({ length: MAX_DL_CONCURRENT }, runSlot));

  // All slots finished
  showDlControls(false);
  if (dlFailedVideos.length > 0) document.getElementById('btn-restart-downloads').hidden = false;
  if (!dlStopped && done > 0) {
    setStatus('All downloads complete!', `${done} downloaded`);
    exportCSV();
  }
  if (completedDownloads.length > 0) document.getElementById('btn-go-delete').hidden = false;
  if (dlStopped) setStatus('Downloads stopped.', `${done} completed, ${dlFailedVideos.length} stopped/failed`);
}

function showDlControls(running) {
  document.getElementById('btn-pause-downloads').hidden = !running;
  document.getElementById('btn-pause-downloads').textContent = 'Pause';
  document.getElementById('btn-stop-downloads').hidden = !running;
}

async function downloadFileToDir(video, dirHandle, onProgress, signal) {
  const dlEndpoint = video.fileUrl;  // download.php URL — fresh CDN URL on every call
  console.log(`[mvdl] starting "${video.title}"`, dlEndpoint ? dlEndpoint.substring(0, 100) : '(no endpoint)');

  if (!dlEndpoint) throw new Error('No download endpoint for this video — try re-fetching details');

  // Call download.php with the user's session cookies to get a fresh signed CDN URL
  let cdnUrl;
  try {
    const dlResp = await fetch(dlEndpoint, { credentials: 'include', signal });
    if (!dlResp.ok) throw new Error(`download.php returned HTTP ${dlResp.status}`);
    const data = await dlResp.json();
    cdnUrl = (data?.original?.file_url || data?.transcoded?.file_url || '').replace(/\\/g, '');
    if (!cdnUrl) throw new Error('No file URL in download.php response');
    console.log(`[mvdl] CDN URL for "${video.title}":`, cdnUrl.substring(0, 100));
  } catch (e) {
    console.error(`[mvdl] download.php failed for "${video.title}":`, e.message);
    throw e;
  }

  const url = cdnUrl;

  const baseFilename = sanitizeDlFilename(video.title) + '.mp4';

  // If forcing overwrite, use base filename directly; otherwise find a non-conflicting name
  let finalFilename = baseFilename;
  if (!video.forceOverwrite) {
    let dupNum = 0;
    while (true) {
      try {
        await dirHandle.getFileHandle(finalFilename, { create: false });
        dupNum++;
        finalFilename = baseFilename.replace(/\.mp4$/, '') + ` (${dupNum}).mp4`;
      } catch { break; }
    }
  }

  let response;
  try {
    response = await fetch(url, { signal });
  } catch (e) {
    console.error(`[mvdl] fetch failed for "${video.title}":`, e.name, e.message);
    throw e;
  }

  console.log(`[mvdl] fetch response for "${video.title}":`, response.status, response.headers.get('Content-Type'), 'size:', response.headers.get('Content-Length'));

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    console.warn(`[mvdl] "${video.title}" returned HTML — URL is likely a page, not a video file. fileUrl may be missing.`);
    throw new Error('Response is HTML, not a video file — details may not have been fetched for this video');
  }

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
  let bytesStreamed = 0;

  if (contentLength > 0 && onProgress) onProgress(0);

  const counter = new TransformStream({
    transform(chunk, controller) {
      bytesStreamed += chunk.byteLength;
      controller.enqueue(chunk);
      if (contentLength > 0 && onProgress) {
        onProgress(Math.min(99, Math.round((bytesStreamed / contentLength) * 100)));
      }
    }
  });

  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(finalFilename, { create: true });
  } catch (e) {
    console.error(`[mvdl] getFileHandle failed for "${finalFilename}":`, e.name, e.message);
    throw e;
  }

  const writable = await fileHandle.createWritable();

  try {
    await response.body.pipeThrough(counter).pipeTo(writable, { signal });
  } catch (e) {
    console.error(`[mvdl] pipe failed for "${video.title}":`, e.name, e.message, `(${bytesStreamed} bytes streamed)`);
    try { await dirHandle.removeEntry(finalFilename); } catch { /* ignore */ }
    throw e;
  }

  // Verify by reading actual file size from disk
  let verified = false;
  if (contentLength > 0) {
    try {
      const written = await fileHandle.getFile();
      verified = written.size === contentLength;
      console.log(`[mvdl] verified "${video.title}": disk=${written.size} expected=${contentLength} → ${verified ? 'OK' : 'MISMATCH'}`);
    } catch {
      verified = bytesStreamed === contentLength;
    }
  } else {
    console.log(`[mvdl] "${video.title}" — no Content-Length header, cannot verify size`);
  }

  if (onProgress) onProgress(100);
  return { filename: finalFilename, verified };
}

function sanitizeDlFilename(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
}

// ─── Phase 3: Downloads ────────────────────────────────────────────────────────

function renderPhase3Table(videos) {
  const tbody = document.getElementById('dl-tbody');
  tbody.innerHTML = '';

  videos.forEach((v, i) => {
    const hasUrl = !!v.downloadUrl;
    const tr = document.createElement('tr');
    tr.dataset.videoId = v.id;
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td class="col-title">${esc(v.title)}</td>
      <td class="col-filename" id="fname-${v.id}">—</td>
      <td class="col-status">
        <span class="badge ${hasUrl ? 'badge-queued' : 'badge-no-url'}" id="dlstatus-${v.id}">
          ${hasUrl ? 'Queued' : 'No URL'}
        </span>
        <div class="dl-progress-wrap" id="dlprog-wrap-${v.id}" hidden>
          <div class="dl-progress-fill" id="dlprog-${v.id}"></div>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Re-download button on existing-file rows
document.getElementById('dl-tbody').addEventListener('click', e => {
  const btn = e.target.closest('.btn-redownload');
  if (!btn) return;
  const videoId = btn.dataset.id;
  const video = downloadVideos.find(v => v.id === videoId);
  if (!video) return;
  const filename = sanitizeDlFilename(video.title) + '.mp4';
  if (!confirm(`Re-downloading "${video.title}" will overwrite the existing file "${filename}" in the selected folder.\n\nContinue?`)) return;
  video.forceOverwrite = true;
  // Replace the existing badge+button with a plain Queued badge
  const cell = btn.closest('td');
  const progressWrap = document.getElementById('dlprog-wrap-' + videoId);
  cell.innerHTML = `<span class="badge badge-queued" id="dlstatus-${videoId}">Queued</span>`;
  if (progressWrap) cell.appendChild(progressWrap);
  setDlRowFilename(videoId, '—');
});

function updateDlStats(partial) {
  dlStats = { ...dlStats, ...partial };
  document.getElementById('stat-active').textContent = dlStats.active;
  document.getElementById('stat-queued').textContent = dlStats.queued;
  document.getElementById('stat-done').textContent   = dlStats.done;
  document.getElementById('stat-errors').textContent = dlStats.errors;
}

function setDlRowStatus(videoId, badgeClass, text) {
  const badge = document.getElementById('dlstatus-' + videoId);
  if (badge) { badge.className = 'badge ' + badgeClass; badge.textContent = text; }
  // Hide progress bar once a final status is set
  if (badgeClass !== 'badge-active') {
    const wrap = document.getElementById('dlprog-wrap-' + videoId);
    if (wrap) wrap.hidden = true;
  }
}

function setDlRowProgress(videoId, pct) {
  const wrap = document.getElementById('dlprog-wrap-' + videoId);
  const fill = document.getElementById('dlprog-' + videoId);
  if (!wrap || !fill) return;
  wrap.hidden = false;
  if (pct === null) {
    fill.style.width = '100%';
    fill.classList.add('dl-progress-indeterminate');
  } else {
    fill.classList.remove('dl-progress-indeterminate');
    fill.style.width = pct + '%';
  }
}

function setDlRowFilename(videoId, filename) {
  const el = document.getElementById('fname-' + videoId);
  if (el) el.textContent = filename || '—';
}

// ─── Background messages ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {

    case 'SCRAPE_PROGRESS':
      document.getElementById('fetch-progress-text').textContent = msg.message;
      setStatus(msg.message);
      break;

    case 'DETAILS_PROGRESS': {
      document.getElementById('details-progress-text').textContent = msg.message;
      setStatus(msg.message);
      const pct = Math.round((msg.current / msg.total) * 100);
      document.getElementById('details-progress-fill').style.width = pct + '%';
      // Mark row as actively fetching
      const badge = document.getElementById('vstatus-' + msg.videoId);
      if (badge) { badge.className = 'badge badge-fetching'; badge.textContent = 'Fetching…'; }
      const descEl    = document.getElementById('desc-' + msg.videoId);
      const kwEl      = document.getElementById('kw-'   + msg.videoId);
      const urlCellP  = document.getElementById('url-'  + msg.videoId);
      if (descEl)   descEl.innerHTML   = '<span class="url-missing">Fetching…</span>';
      if (kwEl)     kwEl.innerHTML     = '<span class="url-missing">Fetching…</span>';
      if (urlCellP) urlCellP.innerHTML = '<span class="url-missing">Fetching…</span>';
      break;
    }

    case 'DETAIL_FETCHED': {
      updateDetailRow(msg.video);
      const idx = enrichedVideos.findIndex(v => v.id === msg.video.id);
      if (idx >= 0) enrichedVideos[idx] = { ...enrichedVideos[idx], ...msg.video };
      else enrichedVideos.push(msg.video);
      saveVideoDetail(msg.video);
      break;
    }

  }

});

// ─── Phase 4: Delete ──────────────────────────────────────────────────────────

document.getElementById('btn-go-delete').addEventListener('click', () => {
  if (!warnUnverified('Deleting videos')) return;
  renderPhase4Table(downloadVideos.length > 0 ? downloadVideos : enrichedVideos);
  setPhase(4);
});

document.getElementById('btn-go-close-account').addEventListener('click', () => {
  if (!warnUnverified('Closing your account')) return;
  setPhase(5);
});

// ─── Phase 5: Social Share ────────────────────────────────────────────────────

function getTweetText() {
  const count = allVideos.length;
  const countStr = count > 0 ? `${count} video${count !== 1 ? 's' : ''}` : 'my content';
  return `Just deleted ${countStr} from ManyVids and requested account deletion. Taking back control of my content 💜\n\nCheck my other sites to keep up with me — I'm not going anywhere!\n\nUsed MV Divest to back everything up first: https://github.com/queueingqt/MVdivest/releases`;
}

function drawStoryCanvas(canvas) {
  const W = 1080, H = 1920;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0f0f11');
  bg.addColorStop(0.6, '#1a0a1f');
  bg.addColorStop(1, '#0a0a18');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Glow orb behind checkmark
  const glow = ctx.createRadialGradient(W / 2, 420, 0, W / 2, 420, 340);
  glow.addColorStop(0, 'rgba(224,92,191,0.18)');
  glow.addColorStop(1, 'rgba(224,92,191,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 800);

  // Checkmark circle
  ctx.strokeStyle = '#4ecb71';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(W / 2, 420, 180, 0, Math.PI * 2);
  ctx.stroke();

  // Checkmark tick
  ctx.strokeStyle = '#4ecb71';
  ctx.lineWidth = 22;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(W / 2 - 90, 420);
  ctx.lineTo(W / 2 - 10, 500);
  ctx.lineTo(W / 2 + 110, 330);
  ctx.stroke();

  // "Content Deleted." heading
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8e8ef';
  ctx.font = `bold 118px 'Helvetica Neue', Arial, sans-serif`;
  ctx.fillText('Content', W / 2, 820);
  ctx.fillStyle = '#e05cbf';
  ctx.fillText('Deleted.', W / 2, 960);

  // Horizontal rule
  ctx.strokeStyle = '#2e2e38';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(160, 1040);
  ctx.lineTo(W - 160, 1040);
  ctx.stroke();

  // Video count line
  const count = allVideos.length;
  if (count > 0) {
    ctx.fillStyle = '#e8e8ef';
    ctx.font = `bold 66px 'Helvetica Neue', Arial, sans-serif`;
    ctx.fillText(`${count} video${count !== 1 ? 's' : ''} backed up`, W / 2, 1150);
    ctx.fillStyle = '#8888a0';
    ctx.font = `52px 'Helvetica Neue', Arial, sans-serif`;
    ctx.fillText('& removed from ManyVids', W / 2, 1240);
  } else {
    ctx.fillStyle = '#8888a0';
    ctx.font = `56px 'Helvetica Neue', Arial, sans-serif`;
    ctx.fillText('Backed up & removed from ManyVids', W / 2, 1150);
  }

  // "Check my other sites" callout
  ctx.fillStyle = '#e8e8ef';
  ctx.font = `bold 58px 'Helvetica Neue', Arial, sans-serif`;
  ctx.fillText('Check my other sites —', W / 2, 1360);
  ctx.fillStyle = '#8888a0';
  ctx.font = `52px 'Helvetica Neue', Arial, sans-serif`;
  ctx.fillText("I'm not going anywhere! 💜", W / 2, 1445);

  // Branding block
  ctx.fillStyle = '#22222a';
  roundRect(ctx, 190, 1530, W - 380, 220, 24);
  ctx.fill();
  ctx.strokeStyle = '#2e2e38';
  ctx.lineWidth = 2;
  roundRect(ctx, 190, 1530, W - 380, 220, 24);
  ctx.stroke();

  ctx.fillStyle = '#e05cbf';
  ctx.font = `bold 62px 'Helvetica Neue', Arial, sans-serif`;
  ctx.fillText('MV Divest', W / 2, 1630);
  ctx.fillStyle = '#8888a0';
  ctx.font = `40px 'Helvetica Neue', Arial, sans-serif`;
  ctx.fillText('manyvids content backup tool', W / 2, 1690);
}

function renderSocialPreviews() {
  document.getElementById('tweet-preview-text').textContent = getTweetText();
  drawStoryCanvas(document.getElementById('insta-story-preview'));
}

document.getElementById('btn-tweet').addEventListener('click', () => {
  window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(getTweetText())}`, '_blank');
});

document.getElementById('btn-insta-story').addEventListener('click', () => {
  const canvas = document.createElement('canvas');
  drawStoryCanvas(canvas);
  const link = document.createElement('a');
  link.download = 'mv-divest-story.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

document.getElementById('btn-delete-all').addEventListener('click', async () => {
  const activeList = downloadVideos.length > 0 ? downloadVideos : enrichedVideos;
  const pending = activeList.filter(v => {
    const btn = document.querySelector(`.btn-delete-mv[data-id="${v.id}"]`);
    return btn && !btn.disabled;
  });

  if (pending.length === 0) { alert('Nothing left to delete.'); return; }
  if (!confirm(`Permanently delete all ${pending.length} video(s) from your ManyVids catalogue?\n\nThis cannot be undone.`)) return;

  const deleteBtn = document.getElementById('btn-delete-all');
  deleteBtn.disabled = true;

  for (const video of pending) {
    const rowBtn = document.querySelector(`.btn-delete-mv[data-id="${video.id}"]`);
    if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = 'Deleting…'; }

    const response = await sendBg({ type: 'DELETE_VIDEO', videoId: video.id, editUrl: video.editUrl });

    if (response.ok) {
      if (rowBtn) { rowBtn.textContent = 'Deleted'; rowBtn.style.opacity = '0.5'; }
      const badge = document.getElementById('delver-' + video.id);
      if (badge) { badge.className = 'badge badge-done'; badge.textContent = 'Deleted'; }
      allVideos      = allVideos.filter(v => v.id !== video.id);
      enrichedVideos = enrichedVideos.filter(v => v.id !== video.id);
      downloadVideos = downloadVideos.filter(v => v.id !== video.id);
    } else {
      if (rowBtn) { rowBtn.disabled = false; rowBtn.textContent = 'Delete from ManyVids'; }
      setStatus(`Failed to delete "${video.title}": ${response.error}`);
    }
  }

  saveToStorage();
  deleteBtn.disabled = false;
  setStatus('Delete All complete.');
});

function renderPhase4Table(videos) {
  const tbody = document.getElementById('delete-tbody');
  tbody.innerHTML = '';

  // Use completedDownloads for verified status from this session
  const completedMap = new Map(completedDownloads.map(v => [v.id, v]));

  videos.forEach((v, i) => {
    const completed = completedMap.get(v.id);
    const filename  = completed?.savedFilename || v.savedFilename || '';
    let badgeClass, badgeText;
    if (completed?.verified) {
      badgeClass = 'badge-done';    badgeText = '✓ Verified';
    } else if (filename) {
      badgeClass = 'badge-ready';   badgeText = 'File exists';
    } else {
      badgeClass = 'badge-pending'; badgeText = 'Not downloaded';
    }

    const tr = document.createElement('tr');
    tr.dataset.videoId = v.id;
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td class="col-title">${esc(v.title)}</td>
      <td class="col-filename">${esc(filename)}</td>
      <td class="col-status"><span class="badge ${badgeClass}" id="delver-${v.id}">${badgeText}</span></td>
      <td class="col-action"><button class="btn-danger btn-delete-mv" data-id="${v.id}" data-edit="${esc(v.editUrl || '')}">Delete from ManyVids</button></td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('delete-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('.btn-delete-mv');
  if (!btn) return;

  const videoId = btn.dataset.id;
  const editUrl = btn.dataset.edit;
  const video    = downloadVideos.find(v => v.id === videoId);
  const completed = completedDownloads.find(v => v.id === videoId);
  const title    = video?.title || videoId;
  const hasFile  = !!(completed?.savedFilename || video?.savedFilename);

  if (!hasFile) {
    if (!confirm(`"${title}" has no verified local copy.\n\nDeleting it from ManyVids without a local copy means it may be permanently lost.\n\nProceed anyway?`)) return;
  } else {
    if (!confirm(`Permanently delete "${title}" from your ManyVids catalogue?\n\nThis cannot be undone.`)) return;
  }

  btn.disabled = true;
  btn.textContent = 'Deleting…';

  const response = await sendBg({ type: 'DELETE_VIDEO', videoId, editUrl });

  if (response.ok) {
    btn.textContent = 'Deleted';
    btn.style.opacity = '0.5';
    const badge = document.getElementById('delver-' + videoId);
    if (badge) { badge.className = 'badge badge-done'; badge.textContent = 'Deleted'; }
    allVideos      = allVideos.filter(v => v.id !== videoId);
    enrichedVideos = enrichedVideos.filter(v => v.id !== videoId);
    downloadVideos = downloadVideos.filter(v => v.id !== videoId);
    saveToStorage();
  } else {
    btn.disabled = false;
    btn.textContent = 'Delete from ManyVids';
    alert(`Could not delete "${title}":\n${response.error}\n\nYou may need to delete it manually from the ManyVids content manager.`);
  }
});

// ─── CSV Export ────────────────────────────────────────────────────────────────

document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

async function exportCSV() {
  const source = downloadVideos.length > 0 ? downloadVideos
    : enrichedVideos.length > 0 ? enrichedVideos
    : allVideos;

  if (source.length === 0) {
    alert('No data to export yet.');
    return;
  }

  const headers = ['#', 'title', 'price', 'views', 'purchases', 'published_date', 'description', 'keywords', 'download_url', 'saved_filename', 'video_page_url', 'video_id'];

  const rows = source.map((v, i) => [
    i + 1,
    v.title         || '',
    v.price         || '',
    v.views         || '',
    v.purchases     || '',
    v.publishedAt   || '',
    v.description   || '',
    v.keywords      || '',
    v.downloadUrl   || '',
    v.savedFilename || '',
    v.downloadUrl   || v.editUrl || '',
    v.id            || ''
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => csvEscape(String(cell))).join(','))
    .join('\r\n');

  const filename = `manyvids_catalogue_${datestamp()}.csv`;
  const content  = '\uFEFF' + csv; // UTF-8 BOM

  // Save to selected folder if available, otherwise fall back to browser download
  if (selectedDirHandle) {
    try {
      const fileHandle = await selectedDirHandle.getFileHandle(filename, { create: true });
      const writable   = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      setStatus('CSV saved to download folder.', filename);
      return;
    } catch (e) {
      console.warn('[mvdl] Could not save CSV to folder, falling back to download:', e.message);
    }
  }

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvEscape(value) {
  if (/[",\r\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

function datestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}


// ─── Storage ──────────────────────────────────────────────────────────────────

async function saveToStorage() {
  const detailsMap = {};
  enrichedVideos.forEach(v => { detailsMap[v.id] = v; });
  await chrome.storage.local.set({ mvdl_allVideos: allVideos, mvdl_details: detailsMap });
}

async function loadFromStorage() {
  const data = await chrome.storage.local.get(['mvdl_allVideos', 'mvdl_details']);
  if (!data.mvdl_allVideos?.length) return false;

  allVideos = data.mvdl_allVideos;
  const detailsMap = data.mvdl_details || {};
  enrichedVideos = allVideos.map(v => detailsMap[v.id] ? { ...v, ...detailsMap[v.id] } : { ...v });
  downloadVideos = enrichedVideos.slice(); // restore for phase 4

  maxReachedPhase = 1;
  renderPhase2Table(enrichedVideos);
  setPhase(2);

  const withDetails = enrichedVideos.filter(v => v.title && v.price && v.views && v.purchases && v.publishedAt && v.description && v.keywords && v.downloadUrl).length;
  document.getElementById('btn-proceed-downloads').hidden = false;
  if (withDetails > 0) {
    const fetchBtn = document.getElementById('btn-fetch-details');
    fetchBtn.textContent = 'Re-fetch Details →';
    fetchBtn.classList.remove('btn-primary');
    fetchBtn.classList.add('btn-refetch-details');
  }
  updateSelectionCount();
  setStatus(`Restored from cache — ${allVideos.length} videos`, `${withDetails} with details`);
  return true;
}

async function saveVideoDetail(video) {
  const data = await chrome.storage.local.get('mvdl_details');
  const map = data.mvdl_details || {};
  map[video.id] = video;
  await chrome.storage.local.set({ mvdl_details: map });
}

document.getElementById('btn-clear-cache').addEventListener('click', async () => {
  if (!confirm('Clear all cached data and start fresh?')) return;
  await chrome.storage.local.clear();
  allVideos = []; enrichedVideos = []; downloadVideos = [];
  document.getElementById('video-tbody').innerHTML = '';
  document.getElementById('btn-proceed-downloads').hidden = true;
  setStatus('Ready. Click "Fetch Catalogue" to begin.');
  setPhase(1);
});

// ─── Login Check (Phase 1) ────────────────────────────────────────────────────

async function checkLogin() {
  const iconEl  = document.getElementById('login-status-icon');
  const textEl  = document.getElementById('login-status-text');
  const linkEl  = document.getElementById('login-link');
  const recheckBtn = document.getElementById('btn-recheck-login');
  const fetchBtn   = document.getElementById('btn-fetch');

  iconEl.textContent  = '⋯';
  iconEl.style.color  = '';
  textEl.textContent  = 'Checking ManyVids login…';
  textEl.style.color  = '';
  linkEl.hidden       = true;
  recheckBtn.hidden   = true;
  fetchBtn.disabled   = true;

  const result = await sendBg({ type: 'CHECK_LOGIN' });

  if (result.loggedIn) {
    iconEl.textContent  = '✓';
    iconEl.style.color  = 'var(--success)';
    textEl.textContent  = 'Logged in to ManyVids';
    textEl.style.color  = 'var(--success)';
    fetchBtn.disabled   = false;
  } else {
    iconEl.textContent  = '✕';
    iconEl.style.color  = 'var(--error)';
    textEl.textContent  = 'Not logged in to ManyVids.';
    textEl.style.color  = 'var(--error)';
    linkEl.hidden       = false;
    recheckBtn.hidden   = false;
    fetchBtn.disabled   = true;
  }
}

document.getElementById('btn-recheck-login').addEventListener('click', () => checkLogin());

// ─── Update check ─────────────────────────────────────────────────────────────

async function checkForUpdates() {
  try {
    const current = chrome.runtime.getManifest().version;
    const resp = await fetch('https://api.github.com/repos/queueingqt/MVdivest/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (!latest) return;

    const a = latest.split('.').map(Number);
    const b = current.split('.').map(Number);
    let newer = false;
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) > (b[i] || 0)) { newer = true; break; }
      if ((a[i] || 0) < (b[i] || 0)) break;
    }
    if (!newer) return;

    const banner = document.getElementById('update-banner');
    document.getElementById('update-banner-text').textContent = `v${latest} is available (you have v${current}).`;
    document.getElementById('update-link').href = data.html_url || 'https://github.com/queueingqt/MVdivest/releases';
    banner.hidden = false;

    document.getElementById('update-dismiss').addEventListener('click', () => {
      banner.hidden = true;
    });
  } catch (_) {
    // Silently ignore — no update check on network failure
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  checkForUpdates();
  const restored = await loadFromStorage();
  if (!restored) {
    setPhase(1);
    checkLogin();
  }
})();
