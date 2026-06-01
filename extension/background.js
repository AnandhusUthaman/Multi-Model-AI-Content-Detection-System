const API_URL = "http://localhost:8000/analyze";
const inFlightScans = new Map();

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (_err) {
    return "";
  }
}

function isScannableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

async function isAutoScanEnabled() {
  const { enabled = false } = await chrome.storage.local.get(["enabled"]);
  return Boolean(enabled);
}

async function clearStoredResult() {
  await chrome.storage.local.set({
    lastResult: null,
    lastScanTabId: null,
    lastScanUrl: "",
    lastScanOrigin: "",
    lastAccessibleVideoCount: 0
  });
}

function countAccessibleVideos(videos) {
  const accessible = (videos || []).filter((video) => {
    const source = String(video?.analysisUrl || video?.src || "").trim();
    if (!source) {
      return false;
    }
    return true;
  });

  return accessible.length;
}

async function syncResultForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const currentOrigin = getOrigin(tab?.url || "");
  const { lastResult = null, lastScanOrigin = "", lastScanTabId = null, lastAccessibleVideoCount = 0 } =
    await chrome.storage.local.get([
    "lastResult",
    "lastScanOrigin",
    "lastScanTabId",
    "lastAccessibleVideoCount"
  ]);

  if (!lastResult) {
    return { lastResult: null, cleared: false, accessibleVideoCount: 0 };
  }

  const sameTab = lastScanTabId === tabId;
  const sameSite = !!currentOrigin && currentOrigin === lastScanOrigin;
  if (sameTab || sameSite) {
    return { lastResult, cleared: false, accessibleVideoCount: Number(lastAccessibleVideoCount || 0) };
  }

  await clearStoredResult();
  return { lastResult: null, cleared: true, accessibleVideoCount: 0 };
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (_err) {
    // Some frames may be restricted; proceed with whatever can be injected.
  }
}

async function collectAllFramesContent(tabId) {
  let frameEntries = [];
  try {
    frameEntries = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (_err) {
    frameEntries = [{ frameId: 0 }];
  }

  const results = await Promise.all(
    frameEntries.map(async (entry) => {
      try {
        const result = await chrome.tabs.sendMessage(tabId, { type: "COLLECT_CONTENT" }, { frameId: entry.frameId });
        return { frameId: entry.frameId, result };
      } catch (_err) {
        return null;
      }
    })
  );

  const merged = {
    url: "",
    title: "",
    text: "",
    textBlocks: [],
    images: [],
    videos: [],
    imageUrls: [],
    videoUrls: [],
    accessibleVideoCount: 0
  };

  for (const entry of results) {
    if (!entry?.result) {
      continue;
    }
    const frameResult = entry.result;
    const frameId = entry.frameId;

    if (frameId === 0) {
      merged.url = frameResult.url || merged.url;
      merged.title = frameResult.title || merged.title;
    }

    const frameText = String(frameResult.text || "").trim();
    if (frameText) {
      merged.text += `${frameText} `;
    }

    for (const block of frameResult.textBlocks || []) {
      merged.textBlocks.push({ ...block, frameId });
    }
    for (const img of frameResult.images || []) {
      merged.images.push({ ...img, frameId });
    }
    for (const vid of frameResult.videos || []) {
      merged.videos.push({ ...vid, frameId });
    }

    merged.imageUrls.push(...(frameResult.imageUrls || []));
    merged.videoUrls.push(...(frameResult.videoUrls || []));
    merged.accessibleVideoCount += Number(frameResult.accessibleVideoCount || 0);
  }

  merged.text = merged.text.trim().slice(0, 20000);
  merged.imageUrls = unique(merged.imageUrls);
  merged.videoUrls = unique(merged.videoUrls);
  merged.accessibleVideoCount = merged.videoUrls.length || merged.accessibleVideoCount;
  return merged;
}

function flattenResultItems(result) {
  return [
    ...(result?.text_result?.items || []),
    ...(result?.image_result?.items || []),
    ...(result?.video_result?.items || [])
  ];
}

function countFrameDecodeFailures(result) {
  const videoItems = result?.video_result?.items || [];
  return videoItems.filter((item) => {
    if (!item || item.status === "analyzed") {
      return false;
    }
    const summary = String(item.summary || "").toLowerCase();
    return summary.includes("frame decoding failed");
  }).length;
}

async function applyAutoHighlights(tabId, result) {
  const analyzedItems = flattenResultItems(result).filter(
    (item) => item && item.status === "analyzed" && item.is_fake === true
  );
  if (!analyzedItems.length) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [analyzedItems],
      func: (items) => {
        if (typeof window.__aiDetectorApplyHighlights === "function") {
          window.__aiDetectorApplyHighlights(items);
        }
      }
    });
  } catch (_err) {
    // Ignore frame-specific restrictions.
  }
}

async function scanTab(tabId) {
  if (inFlightScans.has(tabId)) {
    return inFlightScans.get(tabId);
  }

  const scanPromise = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isScannableUrl(tab?.url || "")) {
      throw new Error("This page cannot be scanned automatically.");
    }

  await ensureContentScript(tabId);
  const content = await collectAllFramesContent(tabId);
  const accessibleVideoCount = Number(content?.accessibleVideoCount || 0) || countAccessibleVideos(content?.videos || []);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(content)
  });

  if (!res.ok) {
    throw new Error(`Backend error ${res.status}`);
  }

  const result = await res.json();
  const frameDecodeFailureCount = countFrameDecodeFailures(result);
  const adjustedAccessibleVideoCount = Math.max(0, accessibleVideoCount - frameDecodeFailureCount);
  await chrome.storage.local.set({
    lastResult: result,
    lastScanTabId: tabId,
    lastScanUrl: content?.url || "",
    lastScanOrigin: getOrigin(content?.url || ""),
    lastAccessibleVideoCount: adjustedAccessibleVideoCount
  });
  await applyAutoHighlights(tabId, result);
  return { ...result, accessible_video_count: adjustedAccessibleVideoCount };
  })();

  inFlightScans.set(tabId, scanPromise);
  try {
    return await scanPromise;
  } finally {
    inFlightScans.delete(tabId);
  }
}

async function openFloatingPanel(tabId) {
  await ensureContentScript(tabId);
  const { lastResult = null } = await chrome.storage.local.get(["lastResult"]);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [lastResult],
      func: (result) => {
        if (typeof window.__aiDetectorShowFloatingPanel === "function") {
          window.__aiDetectorShowFloatingPanel(result);
        }
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function clearPageHighlights(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        if (typeof window.__aiDetectorClearHighlights === "function") {
          window.__aiDetectorClearHighlights();
        }
      }
    });
  } catch (_err) {
    // Ignore if frame/script is not accessible.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCAN_TAB") {
    scanTab(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "CLEAR_RESULTS") {
    clearStoredResult()
      .then(async () => {
        const tabId = sender?.tab?.id;
        if (tabId) {
          await clearPageHighlights(tabId);
        }
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "SYNC_RESULT_FOR_TAB") {
    syncResultForTab(message.tabId)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((err) => sendResponse({ ok: false, error: err.message, lastResult: null }));
    return true;
  }
  if (message?.type === "OPEN_FLOAT_PANEL") {
    openFloatingPanel(message.tabId)
      .then((payload) => sendResponse(payload))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "SCAN_FROM_PANEL") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No active tab context" });
      return false;
    }
    scanTab(tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await syncResultForTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.status) {
    return;
  }

  // Clear stale result on any navigation/reload start so popup resets automatically.
  if (changeInfo.status === "loading" || !!changeInfo.url) {
    await clearStoredResult();
    await clearPageHighlights(tabId);
    return;
  }

  if (changeInfo.status === "complete") {
    const enabled = await isAutoScanEnabled();
    if (enabled && isScannableUrl(tab?.url || "")) {
      try {
        await scanTab(tabId);
      } catch (_err) {
        // Ignore autoscan failures and leave manual scan available.
      }
    }
  }

  await syncResultForTab(tabId);
});
