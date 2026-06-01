(() => {
if (window.__aiDetectorContentScriptLoaded) {
  return;
}
window.__aiDetectorContentScriptLoaded = true;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/([#.;?+*~':"!^$\[\]()=>|/@])/g, "\\$1");
}

function getDomPath(el) {
  if (!(el instanceof Element)) {
    return "";
  }

  if (el.id) {
    return `#${cssEscape(el.id)}`;
  }

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) {
        index += 1;
      }
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    node = node.parentElement;
  }

  return `body > ${parts.join(" > ")}`;
}

function ensureDetectorId(el, prefix) {
  if (!(el instanceof Element)) {
    return "";
  }
  const existing = el.getAttribute("data-ai-detector-id");
  if (existing) {
    return existing;
  }
  const id = `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  el.setAttribute("data-ai-detector-id", id);
  return id;
}

function isElementVisible(el) {
  if (!(el instanceof Element)) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  // Exclude elements fully outside viewport; they are not currently visible.
  if (
    rect.bottom < 0 ||
    rect.right < 0 ||
    rect.top > window.innerHeight ||
    rect.left > window.innerWidth
  ) {
    return false;
  }
  return true;
}

function isElementRenderable(el) {
  if (!(el instanceof Element)) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();

  // For video/iframe, allow zero-size placeholders if they already have source URLs.
  if (el.tagName === "VIDEO" || el.tagName === "IFRAME") {
    const srcLike =
      el.getAttribute("src") ||
      el.getAttribute("data-src") ||
      el.getAttribute("data-video-url") ||
      "";
    if (String(srcLike).trim()) {
      return true;
    }
  }

  return rect.width >= 2 && rect.height >= 2;
}

function hasAnyKeyword(text, keywords) {
  const value = String(text || "").toLowerCase();
  return keywords.some((k) => value.includes(k));
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isBoilerplateText(text) {
  const value = normalizeText(text).toLowerCase();
  if (!value) {
    return true;
  }

  const boilerplatePhrases = [
    "creative commons",
    "attribution-sharealike",
    "all rights reserved",
    "terms of use",
    "privacy policy",
    "cookie policy",
    "licen",
    "license",
    "meta-wiki",
    "community coordination",
    "documentation",
    "credits",
    "powered by",
    "copyright",
    "this page is available under",
    "wikimedia foundation",
    "contact us"
  ];

  const navLikeShort = value.length < 120 && /(home|about|help|login|sign in|subscribe|contact)/.test(value);
  const mostlyPunctuation = value.replace(/[a-z0-9]/g, "").length > value.length * 0.45;
  const hasBoilerplatePhrase = hasAnyKeyword(value, boilerplatePhrases);

  return hasBoilerplatePhrase || navLikeShort || mostlyPunctuation;
}

function isLikelyLogoOrThumbnailImage(img) {
  const keywords = [
    "logo",
    "icon",
    "favicon",
    "sprite",
    "avatar",
    "profile",
    "thumbnail",
    "thumb",
    "badge",
    "emoji"
  ];

  const src = String(img.currentSrc || img.src || "").toLowerCase();
  const alt = String(img.alt || "").toLowerCase();
  const cls = String(img.className || "").toLowerCase();
  const id = String(img.id || "").toLowerCase();
  const parentCls = String(img.parentElement?.className || "").toLowerCase();

  const width = img.naturalWidth || img.width || img.clientWidth || 0;
  const height = img.naturalHeight || img.height || img.clientHeight || 0;
  const area = width * height;
  const minSide = Math.min(width || 0, height || 0);
  const maxSide = Math.max(width || 0, height || 0);
  const aspect = minSide > 0 ? maxSide / minSide : 999;

  // Metadata keywords + small visual size.
  const metaHasKeyword = hasAnyKeyword(`${alt} ${cls} ${id} ${parentCls}`, keywords);
  if (metaHasKeyword && (area <= 250000 || minSide <= 180)) {
    return true;
  }

  // Source keyword alone should not discard large content images.
  const srcHasKeyword = hasAnyKeyword(src, keywords);
  if (srcHasKeyword && (area <= 140000 || minSide <= 140)) {
    return true;
  }

  // Very small image tiles are almost always thumbnails/icons.
  if (area > 0 && area < 18000) {
    return true;
  }

  // Very small side with narrow aspect often logos/icons.
  if (minSide > 0 && minSide < 70 && aspect >= 1.0) {
    return true;
  }

  return false;
}

function collectText(maxChars = 12000) {
  const selectors = "p,li,blockquote,h1,h2,h3,h4,h5,h6,article section";
  const elements = Array.from(document.querySelectorAll(selectors));
  const chunks = [];

  for (const el of elements) {
    if (!isElementVisible(el)) {
      continue;
    }
    const text = normalizeText(el.innerText || "");
    if (text.length < 50) {
      continue;
    }
    if (isBoilerplateText(text)) {
      continue;
    }
    chunks.push(text);
  }

  return normalizeText(chunks.join(" ")).slice(0, maxChars);
}

function collectTextBlocks(maxItems = 20) {
  const selectors = "p,li,blockquote,h1,h2,h3,h4,h5,h6,article section";
  const elements = Array.from(document.querySelectorAll(selectors));
  const blocks = [];

  for (const el of elements) {
    if (!isElementVisible(el)) {
      continue;
    }
    const text = normalizeText(el.innerText || "");
    if (text.length < 50) {
      continue;
    }
    if (isBoilerplateText(text)) {
      continue;
    }

    blocks.push({
      selector: getDomPath(el),
      elementId: ensureDetectorId(el, "txt"),
      text,
      preview: text.slice(0, 160)
    });

    if (blocks.length >= maxItems) {
      break;
    }
  }

  return blocks;
}

function collectImages(maxItems = 40, excludedVideoUrls = []) {
  const excluded = new Set((excludedVideoUrls || []).map((v) => normalizeUrlForMatch(v)).filter(Boolean));
  const visibleImages = Array.from(document.images || []).filter((img) => isElementVisible(img));
  let images = visibleImages.filter((img) => !isLikelyLogoOrThumbnailImage(img));

  // Safety fallback: if filtering removes almost everything, keep visible medium/large images.
  if (images.length === 0 && visibleImages.length > 0) {
    images = visibleImages.filter((img) => {
      const w = img.naturalWidth || img.width || img.clientWidth || 0;
      const h = img.naturalHeight || img.height || img.clientHeight || 0;
      return w >= 120 && h >= 120;
    });
  }

  images = images.filter((img) => {
    const src = String(img.currentSrc || img.src || "").trim();
    if (!src) {
      return false;
    }
    if (isLikelyVideoAssetUrl(src)) {
      return false;
    }
    const normalized = normalizeUrlForMatch(src);
    if (normalized && excluded.has(normalized)) {
      return false;
    }
    return true;
  });

  images = images.slice(0, maxItems);
  return images.map((img) => ({
    src: img.currentSrc || img.src,
    alt: img.alt || "",
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
    selector: getDomPath(img),
    elementId: ensureDetectorId(img, "img")
  }));
}

function collectVideos(maxItems = 10) {
  const videos = Array.from(document.querySelectorAll("video")).filter((video) => {
    if (!isElementRenderable(video)) {
      return false;
    }
    const sourceNodes = Array.from(video.querySelectorAll("source[src], source[data-src]"));
    const hasSourceNode = sourceNodes.some((s) => {
      const v = (s.getAttribute("src") || s.getAttribute("data-src") || "").trim();
      return !!v && !v.startsWith("blob:");
    });
    const direct = String(video.currentSrc || video.src || video.getAttribute("data-src") || "").trim();
    const hasDirect = !!direct && !direct.startsWith("blob:");
    return hasSourceNode || hasDirect;
  });
  const out = videos.map((video) => {
    const sourceNodes = Array.from(video.querySelectorAll("source[src], source[data-src]"));
    const sourceUrl = sourceNodes
      .map((s) => (s.getAttribute("src") || s.getAttribute("data-src") || "").trim())
      .find((u) => !!u);
    const src = (video.currentSrc || video.src || video.getAttribute("data-src") || sourceUrl || "").trim();
    return {
      src,
      poster: video.poster || "",
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      width: video.videoWidth || video.clientWidth || 0,
      height: video.videoHeight || video.clientHeight || 0,
      selector: getDomPath(video),
      elementId: ensureDetectorId(video, "vid"),
      analysisUrl: resolveVideoAnalysisUrl(video)
    };
  });

  const seen = new Set(
    out
      .map((x) => normalizeUrlForMatch(x.analysisUrl || x.src))
      .filter(Boolean)
  );

  // Fallback for search/listing pages (e.g. Pixabay) where cards/links contain video URLs.
  const linkNodes = Array.from(document.querySelectorAll("a[href], [data-video-url], [data-src], [data-href]"));
  for (const node of linkNodes) {
    if (out.length >= maxItems) {
      break;
    }
    if (!isElementRenderable(node)) {
      continue;
    }

    const candidates = [
      node.getAttribute("href"),
      node.getAttribute("data-video-url"),
      node.getAttribute("data-src"),
      node.getAttribute("data-href")
    ]
      .map((v) => String(v || "").trim())
      .filter(Boolean);

    const videoUrl = candidates.find((v) => /\.(mp4|webm|mov|mkv)(\?|#|$)/i.test(v));
    const analysisUrl = videoUrl || "";
    if (!analysisUrl) {
      continue;
    }

    const normalized = normalizeUrlForMatch(analysisUrl);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    out.push({
      src: videoUrl || "",
      poster: "",
      duration: 0,
      width: 0,
      height: 0,
      selector: getDomPath(node),
      elementId: ensureDetectorId(node, "vid"),
      analysisUrl
    });
  }

  // Iframe embeds (YouTube/Vimeo/etc.) fallback.
  const iframes = Array.from(document.querySelectorAll("iframe[src], iframe[data-src]")).filter((iframe) =>
    isElementRenderable(iframe)
  );
  for (const iframe of iframes) {
    if (out.length >= maxItems) {
      break;
    }
    const src = String(iframe.getAttribute("src") || iframe.getAttribute("data-src") || "").trim();
    if (!src) {
      continue;
    }
    const analysisUrl = resolveIframeAnalysisUrl(src);
    if (!analysisUrl) {
      continue;
    }
    const normalized = normalizeUrlForMatch(analysisUrl);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push({
      src,
      poster: "",
      duration: 0,
      width: iframe.clientWidth || 0,
      height: iframe.clientHeight || 0,
      selector: getDomPath(iframe),
      elementId: ensureDetectorId(iframe, "vid"),
      analysisUrl
    });
  }

  return out.slice(0, maxItems);
}

function resolveVideoAnalysisUrl(video) {
  const src = (video.currentSrc || video.src || video.getAttribute("data-src") || "").trim();
  const sourceNodes = Array.from(video.querySelectorAll("source[src], source[data-src]"));
  const sourceUrl = sourceNodes
    .map((s) => (s.getAttribute("src") || s.getAttribute("data-src") || "").trim())
    .find((u) => !!u && !u.startsWith("blob:"));

  if (src && !src.startsWith("blob:")) {
    return src;
  }
  if (sourceUrl) {
    return sourceUrl;
  }
  return "";
}

function resolveIframeAnalysisUrl(rawSrc) {
  const src = String(rawSrc || "").trim();
  if (!src) {
    return "";
  }

  try {
    const u = new URL(src, location.href);

    // For direct file embeds in iframe src, allow backend download.
    if (/\.(mp4|webm|mov|mkv)(\?|#|$)/i.test(u.href)) {
      return u.href;
    }
  } catch (_err) {
    return "";
  }

  return "";
}

function normalizeUrlForMatch(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const u = new URL(raw, location.href);
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch (_err) {
    return raw.split("?")[0].split("#")[0].toLowerCase();
  }
}

function isLikelyVideoAssetUrl(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (/\.(mp4|webm|mov|mkv|avi)(\?|#|$)/i.test(raw)) {
    return true;
  }
  if (/(\/video\/|pro-video-wall|\/stream\/|mime=video|format=webm|format=mp4)/i.test(raw)) {
    return true;
  }
  return false;
}

function urlsLikelySame(a, b) {
  const na = normalizeUrlForMatch(a);
  const nb = normalizeUrlForMatch(b);
  if (!na || !nb) {
    return false;
  }
  return na === nb || na.includes(nb) || nb.includes(na);
}

const mediaWrapState = new Map();

function wrapMediaElement(el) {
  if (!(el instanceof Element)) {
    return null;
  }
  if (mediaWrapState.has(el)) {
    return mediaWrapState.get(el).wrapper;
  }

  const parent = el.parentNode;
  if (!parent) {
    return null;
  }

  const nextSibling = el.nextSibling;
  const computed = window.getComputedStyle(el);
  const wrapper = document.createElement("span");
  wrapper.className = "ai-detector-media-wrapper";
  wrapper.style.position = "relative";
  wrapper.style.lineHeight = "0";
  wrapper.style.boxSizing = "border-box";
  wrapper.style.transformOrigin = "center center";
  wrapper.style.transition = "transform 180ms ease";
  wrapper.style.display = ["block", "flex", "grid", "table", "list-item"].includes(computed.display)
    ? "block"
    : "inline-block";

  parent.insertBefore(wrapper, nextSibling);
  wrapper.appendChild(el);
  mediaWrapState.set(el, { parent, nextSibling, wrapper });
  return wrapper;
}

function unwrapAllMediaElements() {
  for (const [el, state] of mediaWrapState.entries()) {
    const wrapper = state.wrapper;
    if (!wrapper) {
      continue;
    }

    const restoreParent = state.parent && state.parent.isConnected ? state.parent : wrapper.parentNode;
    if (restoreParent) {
      const anchor = state.nextSibling && state.nextSibling.parentNode === restoreParent ? state.nextSibling : null;
      restoreParent.insertBefore(el, anchor);
    }
    wrapper.remove();
  }
  mediaWrapState.clear();
}

function clearHighlights() {
  const highlighted = document.querySelectorAll("[data-ai-detector-highlight='1']");
  for (const node of highlighted) {
    node.style.outline = "";
    node.style.backgroundColor = "";
    node.style.scrollMarginTop = "";
    node.style.boxShadow = "";
    node.style.transform = "";
    node.style.transition = "";
    node.style.zIndex = "";
    node.style.position = "";
    node.style.filter = "";
    if (node.hasAttribute("data-ai-detector-prev-radius")) {
      node.style.borderRadius = node.getAttribute("data-ai-detector-prev-radius") || "";
      node.removeAttribute("data-ai-detector-prev-radius");
    } else {
      node.style.borderRadius = "";
    }
    node.style.removeProperty("--ai-outline-rgb");
    node.classList.remove("ai-detector-highlight-pulse");
    node.classList.remove("ai-detector-media-boost");
    node.removeAttribute("data-ai-detector-highlight");
  }
  const overlays = document.querySelectorAll(".ai-detector-overlay");
  for (const ov of overlays) {
    ov.remove();
  }
  unwrapAllMediaElements();
  const labels = document.querySelectorAll(".ai-detector-floating-label");
  for (const label of labels) {
    label.remove();
  }
}

function ensureHighlightStyles() {
  let style = document.getElementById("ai-detector-highlight-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "ai-detector-highlight-style";
    document.head.appendChild(style);
  }
  style.textContent = `
    .ai-detector-highlight-pulse {
      animation: aiDetectorOutlinePulse 1.1s ease-in-out infinite;
    }
    @keyframes aiDetectorOutlinePulse {
      0% { outline-color: rgba(var(--ai-outline-rgb, 214,0,0), 0.5); }
      50% { outline-color: rgba(var(--ai-outline-rgb, 214,0,0), 1); }
      100% { outline-color: rgba(var(--ai-outline-rgb, 214,0,0), 0.5); }
    }
    .ai-detector-media-boost {
      animation: aiDetectorMediaPulse 1.1s ease-in-out infinite;
    }
    @keyframes aiDetectorMediaPulse {
      0% { box-shadow: 0 0 0 2px rgba(var(--ai-outline-rgb, 214,0,0), 0.5); }
      50% { box-shadow: 0 0 0 6px rgba(var(--ai-outline-rgb, 214,0,0), 0.95); }
      100% { box-shadow: 0 0 0 2px rgba(var(--ai-outline-rgb, 214,0,0), 0.5); }
    }
  `;
}

function severityFromRisk(riskPercent, isFake) {
  if (isFake === true || Number(riskPercent || 0) >= 70) {
    return "high";
  }
  if (Number(riskPercent || 0) >= 40) {
    return "medium";
  }
  return "low";
}

function applyHighlight(el, options = {}) {
  const { severity = "high", clearFirst = true, scrollTo = true } = options;
  ensureHighlightStyles();
  if (clearFirst) {
    clearHighlights();
  }

  const colorMap = {
    low: { rgb: "22,163,74", hex: "#16a34a" },
    medium: { rgb: "234,88,12", hex: "#ea580c" },
    high: { rgb: "214,0,0", hex: "#d60000" }
  };
  const chosen = colorMap[severity] || colorMap.high;

  const isMedia = el.tagName === "IMG" || el.tagName === "VIDEO";
  const target = isMedia ? wrapMediaElement(el) || el : el;

  target.setAttribute("data-ai-detector-highlight", "1");
  if (!target.hasAttribute("data-ai-detector-prev-radius")) {
    target.setAttribute("data-ai-detector-prev-radius", target.style.borderRadius || "");
  }
  target.style.setProperty("--ai-outline-rgb", chosen.rgb);
  target.style.outline = `3px solid ${chosen.hex}`;
  target.style.borderRadius = isMedia ? "10px" : "8px";
  target.style.boxShadow = isMedia
    ? `0 0 0 2px rgba(${chosen.rgb}, 0.6), 0 0 0 6px rgba(${chosen.rgb}, 0.18)`
    : "none";
  target.style.backgroundColor = "";
  target.style.scrollMarginTop = "80px";
  target.style.transition = "none";
  target.style.transform = "none";
  target.style.position = target.style.position || "relative";
  target.style.zIndex = "2147483646";
  target.classList.add("ai-detector-highlight-pulse");
  if (isMedia) {
    target.classList.add("ai-detector-media-boost");
    const scaleBySeverity = {
      low: "scale(1.03)",
      medium: "scale(1.06)",
      high: "scale(1.10)"
    };
    target.style.transform = scaleBySeverity[severity] || scaleBySeverity.high;
  }
  if (scrollTo) {
    (isMedia ? target : el).scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function highlightBySelector(selector, severity = "high") {
  if (!selector) {
    return false;
  }

  try {
    const el = document.querySelector(selector);
    if (!el) {
      return false;
    }
    applyHighlight(el, { severity });
    return true;
  } catch (_err) {
    return false;
  }
}

function highlightByDetectorId(detectorId, severity = "high") {
  if (!detectorId) {
    return false;
  }
  const el = document.querySelector(`[data-ai-detector-id="${cssEscape(detectorId)}"]`);
  if (!el) {
    return false;
  }
  applyHighlight(el, { severity });
  return true;
}

function highlightByMediaUrl(url, type, severity = "high") {
  if (!url) {
    return false;
  }

  const nodes = type === "video" ? Array.from(document.querySelectorAll("video")) : Array.from(document.images || []);
  const target = nodes.find((el) => {
    const src = (el.currentSrc || el.src || "").trim();
    const poster = type === "video" ? (el.poster || "").trim() : "";
    return src === url || poster === url || urlsLikelySame(src, url) || urlsLikelySame(poster, url);
  });

  if (!target) {
    return false;
  }
  applyHighlight(target, { severity });
  return true;
}

function findElementForItem(item) {
  const modality = String(item?.modality || "");
  const source = String(item?.source || "");
  const preview = String(item?.preview || "");
  if (!source) {
    return null;
  }

  if (modality === "text") {
    return document.querySelector(`[data-ai-detector-id="${cssEscape(source)}"]`) || null;
  }

  if (modality === "video") {
    return (
      document.querySelector(`[data-ai-detector-id="${cssEscape(source)}"]`) ||
      Array.from(document.querySelectorAll("video")).find((el) => {
        const src = (el.currentSrc || el.src || "").trim();
        const poster = (el.poster || "").trim();
        return (
          src === source ||
          poster === source ||
          urlsLikelySame(src, source) ||
          urlsLikelySame(poster, source) ||
          urlsLikelySame(src, preview) ||
          urlsLikelySame(poster, preview)
        );
      }) ||
      Array.from(document.querySelectorAll("iframe[src]")).find((el) => {
        const src = (el.getAttribute("src") || "").trim();
        return src === source || urlsLikelySame(src, source) || urlsLikelySame(src, preview);
      }) ||
      null
    );
  }

  if (modality === "image") {
    return (
      document.querySelector(`[data-ai-detector-id="${cssEscape(source)}"]`) ||
      Array.from(document.images || []).find((img) => {
        const src = (img.currentSrc || img.src || "").trim();
        return src === source || urlsLikelySame(src, source) || urlsLikelySame(src, preview);
      }) ||
      null
    );
  }

  return null;
}

function applyScanHighlights(items) {
  ensureHighlightStyles();
  clearHighlights();

  let applied = 0;
  for (const item of items || []) {
    if (!item || item.status !== "analyzed") {
      continue;
    }

    const el = findElementForItem(item);
    if (!el) {
      continue;
    }

    const severity = severityFromRisk(item.risk_percent, item.is_fake);
    applyHighlight(el, {
      severity,
      clearFirst: false,
      scrollTo: false
    });
    applied += 1;
    if (applied >= 20) {
      break;
    }
  }

  return applied;
}

function panelHumanizeLabel(label) {
  const key = String(label || "").toLowerCase();
  if (key === "likely_authentic") return "Likely authentic content";
  if (key === "likely_fake_or_ai_generated") return "Likely AI-generated or fake content";
  return String(label || "Unknown result").replaceAll("_", " ");
}

function panelBadgeLevel(riskPercent) {
  const risk = Number(riskPercent || 0);
  if (risk >= 70) return { cls: "high", text: "High" };
  if (risk >= 40) return { cls: "medium", text: "Medium" };
  return { cls: "low", text: "Low" };
}

function panelStateLabel(item) {
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

function panelTextAuthenticityTag(result) {
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

function panelTextAiTag(item) {
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

function panelFlattenItems(result) {
  return [
    ...(result?.text_result?.items || []),
    ...(result?.image_result?.items || []),
    ...(result?.video_result?.items || [])
  ];
}

function ensureFloatingPanelStyles() {
  let style = document.getElementById("ai-detector-panel-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "ai-detector-panel-style";
    document.head.appendChild(style);
  }
  style.textContent = `
    #ai-detector-panel {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 360px;
      max-height: min(80vh, 760px);
      overflow: hidden;
      background: #ffffff;
      border: 1px solid #c7d2e3;
      border-radius: 10px;
      box-shadow: 0 10px 24px rgba(0,0,0,0.18);
      z-index: 2147483647;
      font-family: Segoe UI, sans-serif;
      color: #1f2d3d;
      user-select: none;
    }
    #ai-detector-panel .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: #0d5fdb;
      color: #fff;
      border-radius: 10px 10px 0 0;
      cursor: move;
      font-size: 13px;
      font-weight: 700;
    }
    #ai-detector-panel .panel-body {
      padding: 10px;
      font-size: 12px;
      line-height: 1.35;
      max-height: calc(min(80vh, 760px) - 52px);
      overflow: auto;
    }
    #ai-detector-panel .panel-actions {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      margin-bottom: 8px;
    }
    #ai-detector-panel .panel-btn {
      border: 0;
      border-radius: 6px;
      padding: 6px 10px;
      color: #fff;
      background: #0d5fdb;
      cursor: pointer;
      font-size: 12px;
    }
    #ai-detector-panel .panel-btn.secondary {
      background: #667894;
    }
    #ai-detector-panel .panel-status {
      font-weight: 700;
      margin-bottom: 8px;
    }
    #ai-detector-panel .panel-list {
      margin: 6px 0;
      padding-left: 16px;
      max-height: 90px;
      overflow: auto;
    }
    #ai-detector-panel .panel-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 8px;
    }
    #ai-detector-panel .panel-card {
      border: 1px solid #d7deea;
      border-radius: 8px;
      padding: 6px;
      background: #fff;
    }
    #ai-detector-panel .panel-card-title {
      font-size: 11px;
      color: #3f4f68;
    }
    #ai-detector-panel .panel-card-value {
      margin-top: 3px;
      font-size: 12px;
      font-weight: 700;
    }
    #ai-detector-panel .panel-controls {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      margin-bottom: 8px;
    }
    #ai-detector-panel .panel-controls select {
      border: 1px solid #c8d1e2;
      border-radius: 6px;
      padding: 5px;
      font-size: 12px;
      background: #fff;
    }
    #ai-detector-panel .panel-findings {
      display: grid;
      gap: 7px;
      max-height: 260px;
      overflow: auto;
    }
    #ai-detector-panel .panel-item {
      border: 1px solid #d7deea;
      border-radius: 8px;
      padding: 7px;
      cursor: pointer;
      background: #fff;
    }
    #ai-detector-panel .panel-item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    #ai-detector-panel .panel-badge {
      color: #fff;
      border-radius: 10px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 700;
    }
    #ai-detector-panel .panel-badge.high {
      background: #c4302b;
    }
    #ai-detector-panel .panel-badge.medium {
      background: #d77e21;
    }
    #ai-detector-panel .panel-badge.low {
      background: #208a4e;
    }
    #ai-detector-panel .panel-item-meta {
      margin-top: 4px;
      color: #2f405b;
      font-size: 11px;
    }
    #ai-detector-panel .panel-item-preview {
      margin-top: 5px;
      color: #495a73;
      font-size: 11px;
      word-break: break-word;
    }
    #ai-detector-panel .panel-item-reason {
      margin-top: 5px;
      color: #223751;
      font-size: 11px;
      line-height: 1.35;
    }
    #ai-detector-panel .panel-item-tags {
      margin-top: 5px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    #ai-detector-panel .panel-status-tag {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 600;
      border: 1px solid transparent;
    }
    #ai-detector-panel .panel-status-tag.good {
      background: #e8f7ee;
      color: #17663a;
      border-color: #b6e3c4;
    }
    #ai-detector-panel .panel-status-tag.warn {
      background: #fff2df;
      color: #8a5311;
      border-color: #f0c88a;
    }
    #ai-detector-panel .panel-status-tag.bad {
      background: #fde9e8;
      color: #9f2722;
      border-color: #f0b8b5;
    }
    #ai-detector-panel .panel-status-tag.neutral {
      background: #eef2f7;
      color: #4c607d;
      border-color: #d3dce8;
    }
    #ai-detector-panel .panel-line {
      margin-top: 5px;
    }
    #ai-detector-panel .panel-close {
      border: 0;
      background: transparent;
      color: #fff;
      font-size: 14px;
      cursor: pointer;
    }
  `;
}

function setupPanelDrag(panel, handle) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.onmousedown = (event) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    event.preventDefault();
  };

  document.addEventListener("mousemove", (event) => {
    if (!dragging) {
      return;
    }
    const left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - offsetX));
    const top = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, event.clientY - offsetY));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

function showFloatingPanel(result) {
  ensureFloatingPanelStyles();
  let panel = document.getElementById("ai-detector-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "ai-detector-panel";
    panel.innerHTML = `
      <div class="panel-head">
        <span>AI Detector Panel</span>
        <button class="panel-close" type="button">x</button>
      </div>
      <div class="panel-body"></div>
    `;
    document.body.appendChild(panel);
    const head = panel.querySelector(".panel-head");
    const closeBtn = panel.querySelector(".panel-close");
    closeBtn.addEventListener("click", () => panel.remove());
    setupPanelDrag(panel, head);
  }

  const body = panel.querySelector(".panel-body");
  const current = { result: result || null };

  function modalityTitle(modality) {
    if (modality === "text") return "Text";
    if (modality === "image") return "Image";
    if (modality === "video") return "Video";
    return "Item";
  }

  function render() {
    const res = current.result;
    const items = panelFlattenItems(res);

    body.innerHTML = `
      <div class="panel-actions">
        <button class="panel-btn" id="panel-scan-btn" type="button">Scan</button>
        <button class="panel-btn secondary" id="panel-clear-btn" type="button">Clear</button>
      </div>
      <div class="panel-status" id="panel-status"></div>
      <ul class="panel-list" id="panel-reasons"></ul>
      <div class="panel-summary" id="panel-summary"></div>
      <div class="panel-controls">
        <select id="panel-modality">
          <option value="all">All</option>
          <option value="text">Text</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        <select id="panel-state">
          <option value="all">All status</option>
          <option value="fake">Only fake</option>
          <option value="authentic">Only authentic</option>
        </select>
        <select id="panel-sort">
          <option value="risk_desc">Risk high to low</option>
          <option value="risk_asc">Risk low to high</option>
        </select>
      </div>
      <div class="panel-findings" id="panel-findings"></div>
    `;

    const statusEl = body.querySelector("#panel-status");
    const reasonsEl = body.querySelector("#panel-reasons");
    const summaryEl = body.querySelector("#panel-summary");
    const findingsEl = body.querySelector("#panel-findings");
    const modalitySel = body.querySelector("#panel-modality");
    const stateSel = body.querySelector("#panel-state");
    const sortSel = body.querySelector("#panel-sort");

    if (!res) {
      statusEl.textContent = "No result. Click Scan.";
    } else {
      const score = Math.round(Number(res.score || 0) * 100);
      statusEl.textContent = `${panelHumanizeLabel(res.label)} (${score}%)`;
      for (const reason of res.reasons || []) {
        const li = document.createElement("li");
        li.textContent = reason;
        reasonsEl.appendChild(li);
      }
    }

    for (const modality of ["text", "image", "video"]) {
      const subset = items.filter((x) => x.modality === modality && x.status === "analyzed");
      const fakeCount = subset.filter((x) => x.is_fake).length;
      const card = document.createElement("div");
      card.className = "panel-card";
      card.innerHTML = `
        <div class="panel-card-title">${modalityTitle(modality)} flagged</div>
        <div class="panel-card-value">${fakeCount}/${subset.length}</div>
      `;
      summaryEl.appendChild(card);
    }

    function renderFindings() {
      findingsEl.innerHTML = "";
      let filtered = [...items];

      if (modalitySel.value !== "all") {
        filtered = filtered.filter((x) => x.modality === modalitySel.value);
      }
      if (stateSel.value === "fake") {
        filtered = filtered.filter((x) => x.status === "analyzed" && x.is_fake === true);
      } else if (stateSel.value === "authentic") {
        filtered = filtered.filter((x) => x.status === "analyzed" && x.is_fake === false);
      }

      filtered.sort((a, b) => {
        const ar = a.risk_percent == null ? -1 : a.risk_percent;
        const br = b.risk_percent == null ? -1 : b.risk_percent;
        return sortSel.value === "risk_asc" ? ar - br : br - ar;
      });

      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "panel-line";
        empty.textContent = "No matching findings.";
        findingsEl.appendChild(empty);
        return;
      }

      for (const item of filtered) {
        const risk = item.risk_percent == null ? "NA" : `${item.risk_percent}%`;
        const auth = item.authenticity_percent == null ? "NA" : `${item.authenticity_percent}%`;
        const level = panelBadgeLevel(item.risk_percent);
        const state = panelStateLabel(item);
        const authTag = panelTextAuthenticityTag(res);
        const aiTag = panelTextAiTag(item);
        const card = document.createElement("div");
        card.className = "panel-item";
        card.innerHTML = `
          <div class="panel-item-head">
            <strong>${modalityTitle(item.modality)}: ${state}</strong>
            <span class="panel-badge ${level.cls}">${level.text}</span>
          </div>
          <div class="panel-item-meta">Risk: ${risk} | Authenticity: ${auth}</div>
          <div class="panel-item-preview">${item.preview || item.source || item.summary || ""}</div>
          ${item.modality === "text" ? `
          <div class="panel-item-tags">
            <span class="panel-status-tag ${authTag.cls}">${authTag.text}</span>
            <span class="panel-status-tag ${aiTag.cls}">${aiTag.text}</span>
          </div>
          ` : ""}
          <div class="panel-item-reason">${item.reason || item.summary || ""}</div>
        `;
        card.addEventListener("click", () => {
          const severity = severityFromRisk(item.risk_percent, item.is_fake);
          if (item.modality === "text") {
            highlightByDetectorId(item.source, severity) || highlightBySelector(item.source, severity);
          } else if (item.modality === "image") {
            highlightByMediaUrl(item.source, "image", severity);
          } else if (item.modality === "video") {
            highlightByDetectorId(item.source, severity) || highlightByMediaUrl(item.source, "video", severity);
          }
        });
        findingsEl.appendChild(card);
      }
    }

    modalitySel.addEventListener("change", renderFindings);
    stateSel.addEventListener("change", renderFindings);
    sortSel.addEventListener("change", renderFindings);
    renderFindings();

    body.querySelector("#panel-clear-btn").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" });
      clearHighlights();
      current.result = null;
      render();
    });

    body.querySelector("#panel-scan-btn").addEventListener("click", async () => {
      statusEl.textContent = "Scanning...";
      const response = await chrome.runtime.sendMessage({ type: "SCAN_FROM_PANEL" });
      if (!response?.ok) {
        statusEl.textContent = response?.error || "Scan failed";
        return;
      }
      current.result = response.result || null;
      render();
    });
  }

  render();
}

function collectContentPayload() {
  const text = collectText();
  const textBlocks = collectTextBlocks();
  const allAccessibleVideos = collectVideos(200);
  const videos = allAccessibleVideos.slice(0, 10);
  const videoLikeUrls = unique(
    allAccessibleVideos.flatMap((v) => [v.analysisUrl, v.src, v.poster]).filter(Boolean)
  );
  const images = collectImages(40, videoLikeUrls);
  return {
    url: location.href,
    title: document.title,
    text,
    textBlocks,
    images,
    videos,
    imageUrls: unique(images.map((x) => x.src)),
    videoUrls: unique(videos.map((x) => x.analysisUrl || x.src || x.poster)),
    accessibleVideoCount: allAccessibleVideos.length
  };
}

// Exposed for background all-frame collection via executeScript.
window.__aiDetectorCollectContent = collectContentPayload;
window.__aiDetectorApplyHighlights = applyScanHighlights;
window.__aiDetectorShowFloatingPanel = showFloatingPanel;
window.__aiDetectorClearHighlights = clearHighlights;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "COLLECT_CONTENT") {
    sendResponse(collectContentPayload());
    return;
  }

  if (message?.type === "HIGHLIGHT_ITEM") {
    const severity = severityFromRisk(message.riskPercent, message.isFake);
    let ok = false;
    if (message.modality === "text") {
      ok = highlightByDetectorId(message.source, severity) || highlightBySelector(message.source, severity);
    } else if (message.modality === "image") {
      ok = highlightByMediaUrl(message.source, "image", severity);
    } else if (message.modality === "video") {
      ok = highlightByDetectorId(message.source, severity) || highlightByMediaUrl(message.source, "video", severity);
    }
    sendResponse({ ok });
    return;
  }

  if (message?.type === "APPLY_SCAN_HIGHLIGHTS") {
    const applied = applyScanHighlights(message.items || []);
    sendResponse({ ok: true, applied });
    return;
  }

  if (message?.type === "SHOW_FLOAT_PANEL") {
    showFloatingPanel(message.result || null);
    sendResponse({ ok: true });
  }
});
})();
