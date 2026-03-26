/**
 * Background Service Worker
 * Scrapes ManyVids content manager in an authenticated tab, manages downloads.
 */

const MAX_CONCURRENT = 4;

let downloadQueue = [];
let activeDownloadCount = 0;
let downloadIdToVideoId = {};
let downloadSubfolder = '';
let detailFetchAborted = false;

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'OPEN_DASHBOARD':
      openDashboard();
      sendResponse({ ok: true });
      break;

    case 'FETCH_CATALOGUE':
      fetchCatalogue()
        .then(videos => sendResponse({ ok: true, videos }))
        .catch(err   => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'FETCH_VIDEO_DETAILS':
      detailFetchAborted = false;
      fetchAllVideoDetails(msg.videos)
        .then(videos => sendResponse({ ok: true, videos }))
        .catch(err   => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'STOP_FETCH_DETAILS':
      detailFetchAborted = true;
      sendResponse({ ok: true });
      break;

    case 'START_DOWNLOADS':
      downloadSubfolder = (msg.subfolder || '').trim().replace(/[<>:"|?*]/g, '_').replace(/\/+$/, '');
      enqueueDownloads(msg.videos);
      sendResponse({ ok: true });
      break;

    case 'DELETE_VIDEO':
      deleteVideo(msg.videoId, msg.editUrl)
        .then(result => sendResponse(result))
        .catch(err   => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'CHECK_LOGIN':
      checkManyVidsLogin()
        .then(result => sendResponse(result))
        .catch(err   => sendResponse({ ok: false, error: err.message }));
      return true;

    default:
      sendResponse({ ok: false, error: 'Unknown message: ' + msg.type });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

function openDashboard() {
  const url = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.query({ url }, tabs => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.action.onClicked.addListener(() => openDashboard());

// ─── Login Check ──────────────────────────────────────────────────────────────

async function checkManyVidsLogin() {
  const tab = await chrome.tabs.create({
    url: 'https://www.manyvids.com/MV-Content-Manager/',
    active: false
  });
  try {
    await waitForTabLoad(tab.id, 1000);
    const current = await chrome.tabs.get(tab.id);
    const loggedIn = (current.url || '').includes('MV-Content-Manager');
    return { ok: true, loggedIn };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ─── Tab Helpers ──────────────────────────────────────────────────────────────

function waitForTabLoad(tabId, extraDelay = 2500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tab load timeout')), 45000);

    function checkIfComplete() {
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (tab.status === 'complete') {
          clearTimeout(timeout);
          setTimeout(resolve, extraDelay);
        } else {
          setTimeout(checkIfComplete, 300);
        }
      });
    }

    // Also listen for updates in case status goes complete quickly
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        setTimeout(resolve, extraDelay);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    checkIfComplete();
  });
}

async function navigateTab(tabId, url, extraDelay = 2500) {
  await new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, tab => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab);
    });
  });
  await waitForTabLoad(tabId, extraDelay);
}

async function runInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func,
    args
  });
  if (!results || !results[0]) return null;
  return results[0].result;
}

// ─── Phase 1: Catalogue ───────────────────────────────────────────────────────

async function fetchCatalogue() {
  const tab = await chrome.tabs.create({
    url: 'https://www.manyvids.com/MV-Content-Manager/#store',
    active: false
  });

  try {
    await waitForTabLoad(tab.id, 3000);
    const allVideos = await scrapeAllPages(tab.id);
    return allVideos;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function scrapeAllPages(tabId) {
  const seenIds = new Set();
  let allVideos = [];
  let pageNum = 1;

  while (true) {
    notifyDashboard({ type: 'SCRAPE_PROGRESS', message: `Scraping catalogue page ${pageNum}…` });

    const result = await runInTab(tabId, scrapeContentManagerPage, [pageNum]);

    if (!result) {
      notifyDashboard({ type: 'SCRAPE_PROGRESS', message: `No result on page ${pageNum}. Stopping.` });
      break;
    }
    if (result.__error) {
      throw new Error('Scraper error on page ' + pageNum + ': ' + result.__error);
    }

    // Log pagination widget HTML every page so we can find the right click target

    // Pinned videos are CSS-first visually but last in the DOM — sort them to front
    const pageVideos = (result.videos || []).slice().sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));

    const newVideos = pageVideos.filter(v => {
      if (!v.id || seenIds.has(v.id)) return false;
      seenIds.add(v.id);
      return true;
    });

    allVideos = allVideos.concat(newVideos);

    // Derive total pages from pagination buttons OR totalCount fallback
    const effectiveMaxPage = result.maxPage > 1
      ? result.maxPage
      : (result.totalCount > 0 ? Math.ceil(result.totalCount / 50) : 1);

    notifyDashboard({
      type: 'SCRAPE_PROGRESS',
      message: `Page ${pageNum}/${effectiveMaxPage}: +${newVideos.length} videos (${allVideos.length} total)…`
    });

    if (pageNum >= effectiveMaxPage) break;
    // Don't stop on newVideos.length === 0 here — let pagination run; duplicates are harmless

    // Click the pagination link — ManyVids intercepts clicks on these anchors
    const nextPage = pageNum + 1;
    const prevFirstId = result.videos[0]?.id;
    const clicked = await runInTab(tabId, (pg) => {
      const link = document.querySelector(`.js-pagination-display a[href="#page-${pg}"]`);
      if (!link) return false;
      link.click();
      return true;
    }, [nextPage]);

    if (!clicked) {
      notifyDashboard({ type: 'SCRAPE_PROGRESS', message: `No pagination link found for page ${nextPage}. Stopping.` });
      break;
    }

    // Poll until the first video ID in the DOM changes (confirms page re-rendered)
    let loaded = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const firstId = await runInTab(tabId, () => {
        const el = document.querySelector('li.js-sorting-order.sorting-order-item[data-content-id]');
        return el ? el.getAttribute('data-content-id') : null;
      });
      if (firstId && firstId !== prevFirstId) { loaded = true; break; }
    }

    if (!loaded) {
      notifyDashboard({ type: 'SCRAPE_PROGRESS', message: `Page ${nextPage} did not render new content. Stopping.` });
      break;
    }
    pageNum++;
  }

  return allVideos;
}

/**
 * Injected into the ManyVids Content Manager tab.
 *
 * Real HTML structure (confirmed from page source):
 *   List container: ul#content-items-sorting
 *   Video items:    li.js-sorting-order.sorting-order-item[data-content-id]
 *   Title:          span.manage-content__list-item__title[title]
 *   Edit link:      a[href="/Edit-vid/{id}"]   (relative URL, capital E)
 *
 * Pagination:
 *   The content manager shows 50 items per page.
 *   ManyVids may support ?page=N query param (tried as best guess).
 *   The move-to-page buttons inside each row show the max page count.
 */
function scrapeContentManagerPage(pageNum) {
  try {
    // Normalise a display value like "$1,234.56", "10.8K", "2.1M" → plain number string
    function normNum(raw) {
      const s = (raw || '').trim().replace(/[$,]/g, '');
      const m = s.match(/^([\d.]+)\s*([KkMm]?)$/);
      if (!m) return '';
      const n = parseFloat(m[1]);
      if (isNaN(n)) return '';
      const mult = { k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1;
      const result = n * mult;
      // Return integer string if whole number, else 2 decimal places
      return Number.isInteger(result) ? String(result) : result.toFixed(2);
    }

    const videos = [];

    // ── Video items ──────────────────────────────────────────────────────────
    const items = document.querySelectorAll(
      'li.js-sorting-order.sorting-order-item[data-content-id]'
    );


    items.forEach((item, domIndex) => {
      const videoId = item.getAttribute('data-content-id');
      if (!videoId) return;

      // Title: prefer the title attribute (already HTML-decoded by the browser)
      const titleEl = item.querySelector('span.manage-content__list-item__title');
      const title = titleEl
        ? (titleEl.getAttribute('title') || titleEl.textContent.trim())
        : ('Video ' + videoId);

      // data-featured="0" means the button action is "unpin" → item IS currently pinned
      const isPinned = item.querySelector('.js-manage-featured-vid[data-featured="0"]') !== null;


      // Edit URL: look for /Edit-vid/ link (case-sensitive on ManyVids)
      const editLinkEl = item.querySelector(
        'a[href*="/Edit-vid/"], a[href*="/edit-vid/"]'
      );
      let editUrl = '';
      if (editLinkEl) {
        editUrl = editLinkEl.href; // already absolute
      } else {
        editUrl = 'https://www.manyvids.com/Edit-vid/' + videoId;
      }

      // Thumbnail (nice to have)
      const thumbEl = item.querySelector('img.manage-content__list-item__image');
      const thumbUrl = thumbEl ? thumbEl.src : '';

      // Stats — exact selectors confirmed from real card HTML
      const getText = sel => (item.querySelector(sel)?.textContent || '').trim();

      const views     = normNum(getText('.manage-content__list-item__label--views'));
      const purchases = normNum(getText('.manage-content__list-item__label--sales-count'));
      const earned    = normNum(getText('.manage-content__list-item__label--earned'));
      const price     = normNum(getText('.manage-content__list-item__label--price'));

      videos.push({ id: videoId, title, editUrl, thumbUrl, views, purchases, earned, price, isPinned });
    });

    // ── Pagination ───────────────────────────────────────────────────────────
    // Determine max page from the move-to-page buttons inside any item
    let maxPage = 1;
    const pageBtns = document.querySelectorAll('.js-move-to-page[data-move-to-page]');
    pageBtns.forEach(btn => {
      const p = parseInt(btn.getAttribute('data-move-to-page') || '0', 10);
      if (p > maxPage) maxPage = p;
    });

    // Also check the total count vs items found
    const totalEl = document.querySelector('.js-filter-total');
    const totalCount = totalEl ? parseInt(totalEl.textContent.replace(/[^0-9]/g, ''), 10) : 0;

    // Max page from pagination widget
    const paginationLinks = document.querySelectorAll('.js-pagination-display a[href^="#page-"]');
    paginationLinks.forEach(a => {
      const m = a.getAttribute('href').match(/#page-(\d+)/);
      if (m) { const p = parseInt(m[1], 10); if (p > maxPage) maxPage = p; }
    });

    return { videos, totalCount, maxPage };
  } catch (e) {
    return { __error: e.message + '\n' + e.stack, videos: [], maxPage: 1, totalCount: 0, firstCardHtml: '' };
  }
}

// ─── Phase 2: Fetch Video Details ─────────────────────────────────────────────

async function fetchAllVideoDetails(videos) {
  const tab = await chrome.tabs.create({
    url: 'https://www.manyvids.com/',
    active: false
  });

  try {
    const enriched = [];

    for (let i = 0; i < videos.length; i++) {
      if (detailFetchAborted) break;
      const video = videos[i];

      notifyDashboard({
        type: 'DETAILS_PROGRESS',
        current: i + 1,
        total: videos.length,
        videoId: video.id,
        message: `Fetching details for "${video.title}" (${i + 1}/${videos.length})`
      });

      let enrichedVideo;
      try {
        await navigateTab(tab.id, video.editUrl);
        const details = await runInTab(tab.id, scrapeEditPage);

        if (details && details.__error) {
          enrichedVideo = { ...video, description: '', keywords: '', downloadUrl: '', detailError: details.__error };
        } else if (details) {
          enrichedVideo = { ...video, ...details };
        } else {
          enrichedVideo = { ...video, description: '', keywords: '', downloadUrl: '', detailError: 'No result' };
        }
      } catch (err) {
        enrichedVideo = { ...video, description: '', keywords: '', downloadUrl: '', detailError: err.message };
      }

      enriched.push(enrichedVideo);
      notifyDashboard({ type: 'DETAIL_FETCHED', video: enrichedVideo });
    }

    return enriched;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Injected into the /Edit-vid/{id} page.
 *
 * Edit page selectors — need verification on your actual edit page.
 * Common ManyVids edit page fields:
 *   Title:       input[name="title"], #vid_title
 *   Description: textarea[name="description"], #vid_description
 *   Tags:        rendered tag elements or a hidden input
 *   Download:    a button/link with "Download" text, or a[href*="download"]
 *
 * The download link for the creator's own video is often a special
 * "Download Original" link that uses a signed CDN URL or a /download/ endpoint.
 */
async function scrapeEditPage() {
  try {
    function normalizeDate(str) {
      str = (str || '').trim();
      if (!str) return '';
      // Try parsing as-is (handles ISO strings like "2025-09-30T00:00:00Z")
      let d = new Date(str);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      // Capitalize first letter to handle "sep 30, 2025" → "Sep 30, 2025"
      d = new Date(str.charAt(0).toUpperCase() + str.slice(1));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return str; // return raw if unparseable
    }

    // ── Description ──────────────────────────────────────────────────────────
    let description = '';
    const descEl = document.querySelector('textarea[name="video_description"]')
      || document.querySelector('textarea[name="description"]')
      || document.querySelector('#vid_description')
      || document.querySelector('#description');
    if (descEl) description = (descEl.value || descEl.textContent || '').trim();

    // ── Keywords / Tags ───────────────────────────────────────────────────────
    let keywords = '';
    const tagListEls = document.querySelectorAll('ul.multi-dropdown-list li');
    if (tagListEls.length > 0) {
      const tags = Array.from(tagListEls).map(el => {
        return Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join('').trim();
      }).filter(t => t.length > 0 && t.length < 80);
      if (tags.length > 0) keywords = tags.join(', ');
    }

    // ── Video page URL (for display / CSV) ────────────────────────────────────
    const videoLinkEl = document.querySelector('div.mb-1 a[href*="/Video/"]')
      || document.querySelector('a[href*="/Video/"]')
      || document.querySelector('link[rel="canonical"]');
    const downloadUrl = videoLinkEl ? videoLinkEl.href : '';

    // ── Download endpoint (called fresh at download time with session cookies)
    let fileUrl = '';
    const dlBtn = document.querySelector('a.js-download-btn[href*="/download.php"]')
      || document.querySelector('a[href*="/download.php"]')
      || document.querySelector('a[download][href]');
    if (dlBtn) fileUrl = dlBtn.href || '';

    // ── Published date (fetched from the public video page) ──────────────────
    let publishedAt = '';
    if (downloadUrl) {
      try {
        const resp = await fetch(downloadUrl, { credentials: 'include' });
        if (resp.ok) {
          const html = await resp.text();

          // 1. JSON-LD structured data (most reliable)
          const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
          if (ldMatch) {
            try {
              const ld = JSON.parse(ldMatch[1]);
              const raw = ld.uploadDate || ld.datePublished || '';
              if (raw) publishedAt = normalizeDate(raw);
            } catch {}
          }

          // 2. __NEXT_DATA__ JSON blob
          if (!publishedAt) {
            const m = html.match(/"published_at"\s*:\s*"([^"]+)"|"publishedAt"\s*:\s*"([^"]+)"/);
            if (m) publishedAt = normalizeDate(m[1] || m[2]);
          }

          // 3. Rendered date text in the __date CSS-module class
          if (!publishedAt) {
            const m = html.match(/class="[^"]*__date[^"]*">([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})</);
            if (m) publishedAt = normalizeDate(m[1]);
          }
        }
      } catch {}
    }

    const pageTitle = document.title || '';

    return { description, keywords, downloadUrl, fileUrl, publishedAt, pageTitle };
  } catch (e) {
    return { __error: e.message, description: '', keywords: '', downloadUrl: '' };
  }
}

// ─── Phase 3: Downloads ───────────────────────────────────────────────────────

function enqueueDownloads(videos) {
  for (const video of videos) {
    if (!video.fileUrl && !video.downloadUrl) continue;
    downloadQueue.push(video);
  }
  processQueue();
}

function processQueue() {
  while (activeDownloadCount < MAX_CONCURRENT && downloadQueue.length > 0) {
    const video = downloadQueue.shift();
    startDownload(video);
  }
}

function startDownload(video) {
  activeDownloadCount++;

  notifyDashboard({
    type: 'DOWNLOAD_STARTED',
    videoId: video.id,
    activeCount: activeDownloadCount,
    queueRemaining: downloadQueue.length
  });

  const prefix = downloadSubfolder ? downloadSubfolder + '/' : '';
  chrome.downloads.download({
    url: video.fileUrl || video.downloadUrl,
    filename: prefix + sanitizeFilename(video.title) + '.mp4',
    conflictAction: 'uniquify',
    saveAs: false
  }, dlId => {
    if (chrome.runtime.lastError || dlId === undefined) {
      activeDownloadCount = Math.max(0, activeDownloadCount - 1);
      notifyDashboard({
        type: 'DOWNLOAD_ERROR',
        videoId: video.id,
        error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed'
      });
      processQueue();
      return;
    }
    downloadIdToVideoId[dlId] = video.id;
  });
}

chrome.downloads.onChanged.addListener(delta => {
  const videoId = downloadIdToVideoId[delta.id];
  if (!videoId) return;

  if (!delta.state) return;

  if (delta.state.current === 'complete') {
    activeDownloadCount = Math.max(0, activeDownloadCount - 1);
    delete downloadIdToVideoId[delta.id];

    chrome.downloads.search({ id: delta.id }, items => {
      const item = items && items[0];
      notifyDashboard({
        type: 'DOWNLOAD_COMPLETE',
        videoId,
        filename: item ? item.filename : '',
        fileSize: item ? item.fileSize : 0,
        totalBytes: item ? item.totalBytes : -1,
        activeCount: activeDownloadCount,
        queueRemaining: downloadQueue.length
      });
    });

    processQueue();

  } else if (delta.state.current === 'interrupted') {
    activeDownloadCount = Math.max(0, activeDownloadCount - 1);
    delete downloadIdToVideoId[delta.id];

    notifyDashboard({
      type: 'DOWNLOAD_ERROR',
      videoId,
      error: delta.error ? delta.error.current : 'interrupted'
    });
    processQueue();
  }
});

// ─── Phase 4: Delete ──────────────────────────────────────────────────────────

async function deleteVideo(videoId, editUrl) {
  const tab = await chrome.tabs.create({
    url: 'https://www.manyvids.com/MV-Content-Manager/#store',
    active: false
  });
  try {
    await waitForTabLoad(tab.id, 3000);

    // Click the delete link for this specific video
    const clicked = await runInTab(tab.id, (id) => {
      const btn = document.querySelector(`a.delvideo[data-id="${id}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, [videoId]);

    if (!clicked) return { ok: false, error: 'Delete button not found on edit page' };

    // Wait for confirmation modal to appear
    await new Promise(r => setTimeout(r, 800));

    await runInTab(tab.id, () => {
      const confirmBtn = document.querySelector('.modal-footer a.js-btn-submit.js-btn-msg-vid');
      if (confirmBtn) confirmBtn.click();
    });

    // Wait for the deletion to process
    await new Promise(r => setTimeout(r, 2000));
    return { ok: true };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
}

function notifyDashboard(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
