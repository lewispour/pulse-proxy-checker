// Pulse — frontend logic. Talks to the Rust backend commands and listens for
// `proxy-progress` events streamed while proxies are checked.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "flag-icons/css/flag-icons.min.css";

const $ = (id) => document.getElementById(id);

// Cross-platform flag: an <i class="fi fi-xx"> image (emoji flags don't render
// on Windows). Returns empty string for unknown/missing country codes.
function flagHtml(cc) {
  if (!cc || cc.length !== 2) return "";
  return `<span class="fi fi-${cc.toLowerCase()}"></span>`;
}

const input = $("proxy-input");
const countEl = $("proxy-count");
const checkBtn = $("btn-check");
const clearBtn = $("btn-clear");
const exportBtn = $("btn-export");
const resultsList = $("results-list");
const progressBar = $("progress-bar");

// views
const viewInput = $("view-input");
const viewChecker = $("view-checker");
const viewSaved = $("view-saved");
const backBtn = $("btn-back");
const copyBtn = $("btn-copy");
const saveWorkingBtn = $("btn-save-working");
const hideDeadToggle = $("hide-dead");
const checkTitle = $("check-title");
const checkStatus = $("check-status");

let selectedScheme = "http";
let lastResults = [];
let liveWorking = 0;
let liveDead = 0;
let mode = "paste";

const freeBar = $("free-bar");
const freeStatus = $("free-status");
const pageTitle = $("page-title");
const findAliveBtn = $("btn-find-alive");

let checkRunning = false;
let cancelled = false;

// Normalize a raw proxy string to its host:port identity (for dedup).
function proxyKey(raw) {
  let s = String(raw).replace(/^[a-z0-9]+:\/\//i, "");       // drop scheme
  if (s.includes("@")) s = s.split("@")[0];                   // host:port@user:pass
  const parts = s.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : s;
}

// ============================ view switching ============================
function showView(name) {
  viewInput.hidden = name !== "input";
  viewChecker.hidden = name !== "checker";
  viewSaved.hidden = name !== "saved";
}

backBtn.addEventListener("click", async () => {
  if (checkRunning) {
    cancelled = true;
    try { await invoke("cancel_check"); } catch { /* ignore */ }
  }
  showView(mode === "saved" ? "saved" : "input");
});

// ============================ mode tabs ============================
// Tabs exist in BOTH the input view and the saved view; bind all of them and
// keep the active state synced so navigation works from any view.
function selectMode(newMode) {
  mode = newMode;
  document.querySelectorAll(".mode-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === mode)
  );
  if (mode === "saved") {
    showView("saved");
    loadSavedPool();
  } else {
    showView("input");
    freeBar.hidden = mode !== "free";
    pageTitle.textContent = mode === "free" ? "Free Proxy Finder" : "Paste Your Proxies";
  }
}
document.querySelectorAll(".mode-tabs").forEach((row) =>
  row.addEventListener("click", (e) => {
    const tab = e.target.closest(".mode-tab");
    if (tab) selectMode(tab.dataset.mode);
  })
);

function collectOptions(extra) {
  return Object.assign(
    {
      concurrency: Math.min(300, Math.max(5, parseInt($("concurrency").value, 10) || 100)),
      timeoutMs: parseInt($("timeout").value, 10) || 6000,
      testUrl: null,
    },
    extra || {}
  );
}

// ============================ checker run ============================
function beginResults() {
  showView("checker");
  resultsList.innerHTML = "";
  lastResults = [];
  liveWorking = 0;
  liveDead = 0;
  __rowQueue = [];
  __pending = { done: 0, total: 0 };
  saveWorkingBtn.disabled = true;
  saveWorkingBtn.hidden = true; // only shows once a filter is applied
  $("btn-save-all").disabled = true;
  exportBtn.disabled = true;
  copyBtn.disabled = true;
  resetFilters();
  setStats(0, 0, 0);
  progressBar.style.width = "0%";
}

findAliveBtn.addEventListener("click", async () => {
  findAliveBtn.disabled = true;
  cancelled = false;
  checkRunning = true;
  beginResults();
  checkTitle.textContent = "Finding alive proxies…";
  checkStatus.classList.add("busy");
  checkStatus.textContent = `Fetching ${selectedScheme.toUpperCase()} proxies from public lists…`;
  try {
    const conc = Math.min(300, Math.max(10, parseInt($("concurrency").value, 10) || 100));
    await invoke("find_alive_proxies", { protocol: selectedScheme, options: collectOptions({ limit: 0, concurrency: conc }) });
    finishCheck();
  } catch (err) {
    if (!cancelled) checkStatus.textContent = "Find Alive failed: " + err;
  } finally {
    checkRunning = false;
    findAliveBtn.disabled = false;
    checkStatus.classList.remove("busy");
  }
});

listen("free-fetched", (event) => {
  const p = event.payload || {};
  const fetched = p.fetched || (p.proxies ? p.proxies.length : 0);
  const checking = p.checking || (p.proxies ? p.proxies.length : 0);
  checkStatus.textContent = `Fetched ${fetched} — checking ${checking}…`;
});

function finishCheck() {
  if (cancelled) return;
  const alive = liveWorking;
  const total = lastResults.length;
  checkTitle.textContent = `${alive} working / ${total} checked`;
  checkStatus.classList.remove("busy");
  checkStatus.textContent = alive > 0 ? `Found ${alive} working proxies.` : "No working proxies found.";
  updateActionButtons();
  populateCountryFilter();
  rerenderResults();
}

// ============================ filters ============================
const fRisk = $("f-risk"), fCountry = $("f-country"), fLatency = $("f-latency"), fQuality = $("f-quality"), filterCount = $("filter-count");

function resetFilters() {
  fRisk.value = ""; fCountry.innerHTML = '<option value="">All</option>';
  fLatency.value = ""; fQuality.value = ""; hideDeadToggle.checked = true;
}

function populateCountryFilter() {
  const seen = new Map();
  for (const r of lastResults) if (r.ok && r.countryCode) seen.set(r.countryCode, r.countryCode);
  const cur = fCountry.value;
  fCountry.innerHTML = '<option value="">All</option>' +
    [...seen.entries()].sort().map(([cc, label]) => `<option value="${cc}">${label}</option>`).join("");
  fCountry.value = cur;
}

// Does a result pass the active filters?
// Generic filter predicate, reused by the checker view and the saved view.
function makeFilter(els) {
  return (r) => {
    if (els.hideDead.checked && !r.ok) return false;
    if (!r.ok) return true; // dead shown only when hide-dead off; filters apply to working
    if (els.risk.value && r.risk !== els.risk.value) return false;
    if (els.country.value && r.countryCode !== els.country.value) return false;
    const maxLat = parseInt(els.latency.value, 10);
    if (!isNaN(maxLat) && (r.latencyMs == null || r.latencyMs > maxLat)) return false;
    const minQ = parseInt(els.quality.value, 10);
    if (!isNaN(minQ) && (r.quality == null || r.quality < minQ)) return false;
    return true;
  };
}

const checkerFilterEls = { hideDead: hideDeadToggle, risk: fRisk, country: fCountry, latency: fLatency, quality: fQuality };
const passesFilters = (r) => makeFilter(checkerFilterEls)(r);

function filteredResults() {
  return lastResults.filter(passesFilters);
}

function rerenderResults() {
  resultsList.innerHTML = "";
  const rows = filteredResults();
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 1000)) frag.appendChild(buildRow(r));
  resultsList.appendChild(frag);
  const workingShown = rows.filter((r) => r.ok).length;
  filterCount.textContent = `${workingShown} shown`;
  updateActionButtons();
}

[fRisk, fCountry, fLatency, fQuality, hideDeadToggle].forEach((el) => el.addEventListener("input", rerenderResults));

// True when any narrowing filter is set (hide-dead alone doesn't count — it only
// affects display of dead rows, and "save" already ignores dead proxies).
function anyFilterActive() {
  return !!(fRisk.value || fCountry.value || fLatency.value || fQuality.value);
}

function updateActionButtons() {
  const shownWorking = filteredResults().filter((r) => r.ok).length;
  const totalWorking = liveWorking;
  copyBtn.disabled = shownWorking === 0;
  exportBtn.disabled = shownWorking === 0;
  $("btn-save-all").disabled = totalWorking === 0;
  // "Save filtered" only appears when a filter is actually applied (otherwise
  // it'd be identical to "Save all working").
  saveWorkingBtn.hidden = !anyFilterActive();
  saveWorkingBtn.disabled = shownWorking === 0;
}

// ============================ copy / export / save ============================
// These act on the FILTERED working set so "save/copy/export filtered" is implicit.
function visibleWorking() {
  return filteredResults().filter((r) => r.ok);
}

async function copyToClipboard(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  const old = btn.textContent; btn.textContent = "✓ Copied";
  setTimeout(() => (btn.textContent = old || label), 1200);
}

copyBtn.addEventListener("click", () => copyToClipboard(visibleWorking().map((r) => r.raw).join("\n"), copyBtn, "Copy"));

async function exportToFile(content, filename, btn) {
  try {
    const path = await invoke("export_proxies", { filename, content });
    const old = btn.textContent;
    btn.textContent = "✓ Saved to Downloads";
    setTimeout(() => (btn.textContent = old), 1800);
    console.log("exported to", path);
  } catch (e) {
    btn.textContent = "Export failed";
    setTimeout(() => (btn.textContent = "Export"), 1800);
  }
}

// Timestamp like 20261012-1305 for export filenames.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
// Most common scheme among a set of results (for the filename).
function dominantScheme(rows) {
  const counts = {};
  for (const r of rows) counts[r.scheme || "http"] = (counts[r.scheme || "http"] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "mixed";
}

exportBtn.addEventListener("click", () => {
  const rows = visibleWorking();
  exportToFile(rows.map((r) => r.raw).join("\n"), `proxies-${dominantScheme(rows)}-${stamp()}.txt`, exportBtn);
});

// Save a set of working results into the per-protocol saved pools (deduped),
// grouping each proxy into the pool matching its own scheme.
async function saveToPools(toSave, btn) {
  if (toSave.length === 0) return;
  const byProto = {};
  for (const r of toSave) {
    const proto = (r.scheme || "http").toLowerCase();
    (byProto[proto] = byProto[proto] || []).push(r);
  }
  let added = 0;
  for (const [proto, items] of Object.entries(byProto)) {
    added += await mergeIntoPool(proto, items);
  }
  const old = btn.textContent;
  btn.textContent = `✓ Saved ${added}`;
  setTimeout(() => (btn.textContent = old), 1500);
}

const saveAllBtn = $("btn-save-all");
// "Save filtered" — only what matches the active filters.
saveWorkingBtn.addEventListener("click", () => saveToPools(visibleWorking(), saveWorkingBtn));
// "Save all working" — every working proxy from the run, ignoring filters.
saveAllBtn.addEventListener("click", () => saveToPools(lastResults.filter((r) => r.ok), saveAllBtn));

// Merge results into a protocol's saved pool, dedup by host:port. Returns #added.
async function mergeIntoPool(proto, items) {
  const existing = await invoke("load_saved", { protocol: proto });
  const pool = Array.isArray(existing) ? existing : [];
  const index = new Map(pool.map((r) => [proxyKey(r.raw), r]));
  let added = 0;
  for (const r of items) {
    const k = proxyKey(r.raw);
    if (!index.has(k)) added++;
    index.set(k, r); // insert or refresh
  }
  await invoke("save_saved", { protocol: proto, proxies: [...index.values()] });
  return added;
}

// ============================ input (paste) ============================
function lines() {
  return input.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function refreshCount() {
  const n = lines().length;
  countEl.textContent = String(n);
  checkBtn.disabled = n === 0;
}
input.addEventListener("input", refreshCount);

$("protocol-group").addEventListener("click", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  $("protocol-group").querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  pill.classList.add("active");
  selectedScheme = pill.dataset.scheme;
  if (!freeBar.hidden) freeStatus.textContent = `Will pull ${selectedScheme.toUpperCase()} proxies from public lists.`;
});

clearBtn.addEventListener("click", () => { input.value = ""; refreshCount(); });

function applyScheme(list) {
  return list.map((line) => {
    if (/:\/\//.test(line)) return line;
    if (/@/.test(line)) return line;
    const parts = line.split(":");
    if (parts.length === 2) return `${selectedScheme}://${line}`;
    return line;
  });
}

checkBtn.addEventListener("click", async () => {
  const list = applyScheme(lines());
  if (list.length === 0) return;
  checkBtn.disabled = true;
  checkBtn.textContent = "Checking…";
  cancelled = false;
  checkRunning = true;
  beginResults();
  checkTitle.textContent = "Checking proxies…";
  checkStatus.classList.add("busy");
  checkStatus.textContent = `Checking ${list.length} proxies…`;
  try {
    await invoke("check_proxies_native", { proxies: list, options: collectOptions() });
    finishCheck();
  } catch (err) {
    if (!cancelled) checkStatus.textContent = "Check failed: " + err;
  } finally {
    checkRunning = false;
    checkBtn.disabled = false;
    checkBtn.textContent = "Check Proxies";
    checkStatus.classList.remove("busy");
  }
});

// ============================ live progress stream ============================
let __rowQueue = [];
let __pending = { done: 0, total: 0 };
let __flushScheduled = false;

function scheduleFlush() {
  if (__flushScheduled) return;
  __flushScheduled = true;
  requestAnimationFrame(flushProgress);
}

function flushProgress() {
  __flushScheduled = false;
  if (__rowQueue.length) {
    const frag = document.createDocumentFragment();
    for (const r of __rowQueue) if (passesFilters(r)) frag.appendChild(buildRow(r));
    resultsList.appendChild(frag);
    __rowQueue = [];
    while (resultsList.childElementCount > 1000) resultsList.removeChild(resultsList.firstChild);
  }
  const { done, total } = __pending;
  progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
  setStats(total || done, liveWorking, liveDead);
  updateActionButtons();
  if (checkStatus.classList.contains("busy") && done) {
    checkStatus.textContent = `Checking ${done}/${total} — ${liveWorking} working, ${liveDead} dead`;
  }
}

listen("proxy-progress", (event) => {
  if (savedRecheckActive) return; // saved-recheck has its own handler below
  const { result, done, total } = event.payload;
  lastResults.push(result);
  if (result.ok) { liveWorking++; if (result.countryCode) maybeAddCountry(result); }
  else liveDead++;
  __rowQueue.push(result);
  __pending = { done, total };
  scheduleFlush();
});

let __countrySeen = new Set();
function maybeAddCountry(r) {
  if (__countrySeen.has(r.countryCode)) return;
  __countrySeen.add(r.countryCode);
  const opt = document.createElement("option");
  opt.value = r.countryCode; opt.textContent = r.countryCode;
  fCountry.appendChild(opt);
}

function setStats(total, working, dead) {
  $("stat-total").textContent = total;
  $("stat-working").textContent = working;
  $("stat-dead").textContent = dead;
}

function buildRow(r) {
  const row = document.createElement("div");
  row.className = "result-row " + (r.ok ? "ok" : "dead");
  const status = r.ok ? "Success" : (r.error || "Failed");
  // flag is trusted markup (built from a validated 2-letter code); code is escaped.
  const country = r.ok ? `${flagHtml(r.countryCode)} ${escapeHtml(r.countryCode || "??")}` : "";
  const exit = r.ok && r.exitIp ? r.exitIp : "";
  const quality = r.ok && r.quality != null ? `${r.quality}%` : "";
  const risk = r.ok && r.risk ? r.risk : "";
  const latency = r.ok && r.latencyMs != null ? `${r.latencyMs} ms` : "";
  const riskClass = risk ? `risk-${risk.toLowerCase()}` : "";
  row.innerHTML = `
    <span class="dot" title="${escapeHtml(r.isp || "")}"></span>
    <span class="col-proxy raw">${escapeHtml(r.raw)}</span>
    <span class="col-status">${escapeHtml(status)}</span>
    <span class="col-country">${country}</span>
    <span class="col-ip">${escapeHtml(exit)}</span>
    <span class="col-quality"><span class="qbar"><span style="width:${r.ok ? r.quality : 0}%"></span></span>${quality}</span>
    <span class="col-risk ${riskClass}">${escapeHtml(risk)}</span>
    <span class="col-latency meta">${escapeHtml(latency)}</span>`;
  return row;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ============================ Saved Proxies view ============================
const savedList = $("saved-list");
const savedStatus = $("saved-status");
const savedProtoGroup = $("saved-proto-group");
const recheckBtn = $("btn-recheck-saved");
const removeDeadBtn = $("btn-remove-dead");
const savedCopyBtn = $("btn-saved-copy");
const savedExportBtn = $("btn-saved-export");
const savedClearBtn = $("btn-saved-clear");

let savedScheme = "http";
let savedPool = []; // array of result objects for the current savedScheme

savedProtoGroup.addEventListener("click", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  savedProtoGroup.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  pill.classList.add("active");
  savedScheme = pill.dataset.scheme;
  loadSavedPool();
});

async function loadSavedPool() {
  savedStatus.textContent = "Loading…";
  const data = await invoke("load_saved", { protocol: savedScheme });
  savedPool = Array.isArray(data) ? data : [];
  renderSavedPool();
  savedStatus.textContent = `${savedPool.length} saved ${savedScheme.toUpperCase()} proxies`;
}

// Saved-view filters (independent from the checker view).
const savedFilterEls = {
  hideDead: $("sf-hide-dead"), risk: $("sf-risk"), country: $("sf-country"),
  latency: $("sf-latency"), quality: $("sf-quality"),
};
const savedFilterCount = $("saved-filter-count");
const passesSavedFilter = (r) => makeFilter(savedFilterEls)(r);
Object.values(savedFilterEls).forEach((el) => el.addEventListener("input", renderSavedPool));

function populateSavedCountryFilter() {
  const seen = new Map();
  for (const r of savedPool) if (r.ok && r.countryCode) seen.set(r.countryCode, r.countryCode);
  const cur = savedFilterEls.country.value;
  savedFilterEls.country.innerHTML = '<option value="">All</option>' +
    [...seen.entries()].sort().map(([cc, label]) => `<option value="${cc}">${label}</option>`).join("");
  savedFilterEls.country.value = cur;
}

function renderSavedPool() {
  populateSavedCountryFilter();
  savedList.innerHTML = "";
  const rows = savedPool.filter(passesSavedFilter);
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 2000)) frag.appendChild(buildRow(r));
  savedList.appendChild(frag);
  savedFilterCount.textContent = `${rows.filter((r) => r.ok).length} shown`;
  const hasDead = savedPool.some((r) => !r.ok);
  removeDeadBtn.disabled = !hasDead;
  savedCopyBtn.disabled = savedPool.length === 0;
  savedExportBtn.disabled = savedPool.length === 0;
  savedClearBtn.disabled = savedPool.length === 0;
}

// Recheck every proxy in the pool, updating rows live, then persist.
recheckBtn.addEventListener("click", async () => {
  if (savedPool.length === 0) { savedStatus.textContent = "Pool is empty."; return; }
  recheckBtn.disabled = true;
  savedStatus.textContent = `Rechecking ${savedPool.length}…`;
  const raws = savedPool.map((r) => r.raw);
  savedRecheckActive = true;
  savedRecheckMap = new Map(); // key -> new result
  try {
    await invoke("check_proxies_native", { proxies: raws, options: collectOptions() });
    // merge new results back into the pool by key (keep dead, mark them)
    savedPool = savedPool.map((old) => savedRecheckMap.get(proxyKey(old.raw)) || { ...old, ok: false, status: "dead", error: "no response" });
    await invoke("save_saved", { protocol: savedScheme, proxies: savedPool });
    renderSavedPool();
    const alive = savedPool.filter((r) => r.ok).length;
    savedStatus.textContent = `Rechecked — ${alive}/${savedPool.length} still working`;
  } catch (err) {
    savedStatus.textContent = "Recheck failed: " + err;
  } finally {
    savedRecheckActive = false;
    recheckBtn.disabled = false;
  }
});

// During a saved recheck, capture progress into the map + show live progress.
let savedRecheckActive = false;
let savedRecheckMap = null;
listen("proxy-progress", (event) => {
  if (!savedRecheckActive) return;
  const { result, done, total } = event.payload;
  savedRecheckMap.set(proxyKey(result.raw), result);
  const alive = [...savedRecheckMap.values()].filter((r) => r.ok).length;
  savedStatus.textContent = `Rechecking ${done}/${total} — ${alive} still working`;
});

removeDeadBtn.addEventListener("click", async () => {
  savedPool = savedPool.filter((r) => r.ok);
  await invoke("save_saved", { protocol: savedScheme, proxies: savedPool });
  renderSavedPool();
  savedStatus.textContent = `Removed dead — ${savedPool.length} remain`;
});

const savedVisibleWorking = () => savedPool.filter((r) => r.ok && passesSavedFilter(r));
savedCopyBtn.addEventListener("click", () => copyToClipboard(savedVisibleWorking().map((r) => r.raw).join("\n"), savedCopyBtn, "Copy"));
savedExportBtn.addEventListener("click", () =>
  exportToFile(savedVisibleWorking().map((r) => r.raw).join("\n"), `proxies-${savedScheme}-${stamp()}.txt`, savedExportBtn)
);
savedClearBtn.addEventListener("click", async () => {
  savedPool = [];
  await invoke("save_saved", { protocol: savedScheme, proxies: [] });
  renderSavedPool();
  savedStatus.textContent = "Pool cleared.";
});

refreshCount();
