const toggleEl = document.getElementById("toggle");
const scanBtn = document.getElementById("scanBtn");
const clearBtn = document.getElementById("clearBtn");
const floatBtn = document.getElementById("floatBtn");
const statusEl = document.getElementById("status");
const videoCountEl = document.getElementById("videoCount");
const reasonsEl = document.getElementById("reasons");
const summaryEl = document.getElementById("summary");
const detailsEl = document.getElementById("details");
const modalityFilterEl = document.getElementById("modalityFilter");
const statusFilterEl = document.getElementById("statusFilter");
const sortByEl = document.getElementById("sortBy");

let currentResult = null;
let currentAccessibleVideoCount = 0;
let isScanning = false;

function renderAccessibleVideoCount(count) {
  currentAccessibleVideoCount = Number(count || 0);
  if (videoCountEl) {
    videoCountEl.textContent = `Accessible videos: ${currentAccessibleVideoCount}`;
  }
}

function humanizeLabel(label) {
  const key = String(label || "").toLowerCase();
  if (key === "likely_authentic") return "Likely authentic content";
  if (key === "likely_fake_or_ai_generated") return "Likely AI-generated or fake content";
  return String(label || "Unknown result")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function modalityTitle(modality) {
  if (modality === "text") return "Text";
  if (modality === "image") return "Image";
  if (modality === "video") return "Video";
  return "Item";
}

function badgeLevel(riskPercent) {
  if (riskPercent == null) return { cls: "low", text: "NA" };
  const risk = Number(riskPercent || 0);
  if (risk >= 70) return { cls: "high", text: "High" };
  if (risk >= 40) return { cls: "medium", text: "Medium" };
  return { cls: "low", text: "Low" };
}

function stateLabel(item) {
  if (item?.status !== "analyzed") {
    return "Not analyzed";
  }
  const risk = Number(item?.risk_percent || 0);
  if (item?.is_fake === true || risk >= 70) {
    return "Likely fake";
  }
  if (risk >= 40) {
    return "Suspicious";
  }
  return "Likely authentic";
}

function textAuthenticityTag(result) {
  const label = String(result?.fake_news_result?.label || "").toLowerCase();
  if (label === "likely_fake_news") {
    return { cls: "bad", text: "Fact check: likely false" };
  }
  if (label === "likely_supported_claims") {
    return { cls: "good", text: "Fact check: looks true" };
  }
  if (label === "mixed_or_uncertain_claims") {
    return { cls: "warn", text: "Fact check: mixed evidence" };
  }
  return { cls: "neutral", text: "Fact check: not enough info" };
}

function textAiTag(item) {
  if (item?.status !== "analyzed") {
    return { cls: "neutral", text: "AI: not analyzed" };
  }
  const risk = Number(item?.risk_percent || 0);
  if (item?.is_fake === true || risk >= 70) {
    return { cls: "bad", text: "AI: likely generated" };
  }
  if (risk >= 40) {
    return { cls: "warn", text: "AI: suspicious" };
  }
  return { cls: "good", text: "AI: likely human" };
}

function flattenItems(result) {
  return [
    ...(result?.text_result?.items || []),
    ...(result?.image_result?.items || []),
    ...(result?.video_result?.items || [])
  ];
}

function renderSummary(items) {
  summaryEl.innerHTML = "";
  const modalities = ["text", "image", "video"];

  for (const modality of modalities) {
    const subset = items.filter((item) => item.modality === modality && item.status === "analyzed");
    const fakeCount = subset.filter((item) => item.is_fake).length;

    const card = document.createElement("div");
    card.className = "summary-card";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `${modalityTitle(modality)} flagged`;

    const value = document.createElement("div");
    value.className = "value";
    value.textContent = `${fakeCount}/${subset.length}`;

    card.appendChild(title);
    card.appendChild(value);
    summaryEl.appendChild(card);
  }
}

function applyFilters(items) {
  let filtered = [...items];

  const modalityFilter = modalityFilterEl.value;
  if (modalityFilter !== "all") {
    filtered = filtered.filter((item) => item.modality === modalityFilter);
  }

  const statusFilter = statusFilterEl.value;
  if (statusFilter === "fake") {
    filtered = filtered.filter((item) => item.status === "analyzed" && item.is_fake === true);
  }
  if (statusFilter === "authentic") {
    filtered = filtered.filter((item) => item.status === "analyzed" && item.is_fake === false);
  }

  const sortBy = sortByEl.value;
  filtered.sort((a, b) => {
    const ar = a.risk_percent == null ? -1 : a.risk_percent;
    const br = b.risk_percent == null ? -1 : b.risk_percent;
    return sortBy === "risk_asc" ? ar - br : br - ar;
  });

  return filtered;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function highlightItem(item) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }

  await chrome.tabs.sendMessage(tab.id, {
    type: "HIGHLIGHT_ITEM",
    modality: item.modality,
    source: item.source,
    riskPercent: item.risk_percent,
    isFake: item.is_fake
  });
}

function buildItemCard(item) {
  const card = document.createElement("div");
  card.className = "item-card";

  const head = document.createElement("div");
  head.className = "item-head";

  const left = document.createElement("strong");
  const statusText = stateLabel(item);
  left.textContent = `${modalityTitle(item.modality)}: ${statusText}`;

  const level = badgeLevel(item.risk_percent);
  const badge = document.createElement("span");
  badge.className = `badge ${level.cls}`;
  badge.textContent = level.text === "NA" ? "No score" : `${level.text} risk`;

  head.appendChild(left);
  head.appendChild(badge);

  const meta = document.createElement("div");
  meta.className = "item-meta";
  const risk = item.risk_percent == null ? "NA" : `${item.risk_percent}%`;
  const auth = item.authenticity_percent == null ? "NA" : `${item.authenticity_percent}%`;
  meta.textContent = `Risk: ${risk} | Authenticity: ${auth}`;

  const preview = document.createElement("div");
  preview.className = "item-preview";
  preview.textContent = item.preview || item.source || item.summary || "No preview";

  const summary = document.createElement("div");
  summary.className = "item-summary";
  summary.textContent = item.summary || "";

  const reason = document.createElement("div");
  reason.className = "item-reason";
  reason.textContent = item.reason || item.summary || "";

  if (item.modality === "text") {
    const tags = document.createElement("div");
    tags.className = "item-tags";
    const authTag = textAuthenticityTag(currentResult);
    const aiTag = textAiTag(item);
    tags.innerHTML = `
      <span class="status-tag ${authTag.cls}">${authTag.text}</span>
      <span class="status-tag ${aiTag.cls}">${aiTag.text}</span>
    `;
    card.appendChild(tags);
  }

  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(preview);
  card.appendChild(summary);
  card.appendChild(reason);
  card.addEventListener("click", () => {
    highlightItem(item).catch(() => {
      // no-op
    });
  });

  return card;
}

function renderFindings(items) {
  detailsEl.innerHTML = "";
  const filtered = applyFilters(items);

  if (!filtered.length) {
    detailsEl.textContent = "No matching findings for selected filter.";
    return;
  }

  for (const item of filtered) {
    detailsEl.appendChild(buildItemCard(item));
  }
}

function renderResult(result) {
  currentResult = result;

  if (!result) {
    statusEl.textContent = "No result";
    renderAccessibleVideoCount(0);
    reasonsEl.innerHTML = "";
    summaryEl.innerHTML = "";
    detailsEl.innerHTML = "";
    return;
  }

  const scorePct = Math.round((result.score ?? 0) * 100);
  statusEl.textContent = `${humanizeLabel(result.label)} (${scorePct}%)`;

  reasonsEl.innerHTML = "";
  for (const reason of result.reasons || []) {
    const li = document.createElement("li");
    li.textContent = reason;
    reasonsEl.appendChild(li);
  }

  const items = flattenItems(result);
  renderSummary(items);
  renderFindings(items);
}

async function runScan() {
  if (isScanning) {
    return;
  }

  isScanning = true;
  statusEl.textContent = "Scanning...";
  renderAccessibleVideoCount(0);
  reasonsEl.innerHTML = "";
  summaryEl.innerHTML = "";
  detailsEl.innerHTML = "";

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      statusEl.textContent = "No active tab";
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "SCAN_TAB",
      tabId: tab.id
    });

    if (!response?.ok) {
      statusEl.textContent = response?.error || "Scan failed";
      return;
    }

    renderAccessibleVideoCount(response?.result?.accessible_video_count || 0);
    renderResult(response.result);
  } finally {
    isScanning = false;
  }
}

async function clearResults() {
  await chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" });
  renderResult(null);
}

async function openFloatingPanel() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }
  await chrome.runtime.sendMessage({ type: "OPEN_FLOAT_PANEL", tabId: tab.id });
}

async function init() {
  const tab = await getActiveTab();
  const response = tab?.id
    ? await chrome.runtime.sendMessage({ type: "SYNC_RESULT_FOR_TAB", tabId: tab.id })
    : null;

  const { enabled = false } = await chrome.storage.local.get(["enabled"]);
  const lastResult = response?.lastResult ?? null;

  toggleEl.checked = enabled;
  renderAccessibleVideoCount(response?.accessibleVideoCount || 0);
  renderResult(lastResult);

  toggleEl.addEventListener("change", async () => {
    await chrome.storage.local.set({ enabled: toggleEl.checked });
    if (toggleEl.checked) {
      await runScan();
    }
  });

  scanBtn.addEventListener("click", runScan);
  clearBtn.addEventListener("click", clearResults);
  floatBtn.addEventListener("click", openFloatingPanel);
  modalityFilterEl.addEventListener("change", () => renderFindings(flattenItems(currentResult || {})));
  statusFilterEl.addEventListener("change", () => renderFindings(flattenItems(currentResult || {})));
  sortByEl.addEventListener("change", () => renderFindings(flattenItems(currentResult || {})));

  if (enabled && !lastResult) {
    await runScan();
  }
}

init().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
});
