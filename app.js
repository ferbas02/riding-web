"use strict";

const TZ = "America/Guayaquil";
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CIRC = 2 * Math.PI * 54;

const state = {
  tab: "home",
  calMonth: null,
  data: {},          // { "yyyy-MM": respuesta de /month }
  busy: false,
  sheetDate: null,
  toastTimer: null,
};

/* ---------- fechas ---------- */
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function currentMonth() { return todayStr().slice(0, 7); }
function shiftMonth(m, delta) {
  let [y, mo] = m.split("-").map(Number);
  mo += delta;
  while (mo > 12) { mo -= 12; y++; }
  while (mo < 1) { mo += 12; y--; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}
function monthLabel(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1))
    .toLocaleDateString("es", { month: "long", year: "numeric", timeZone: "UTC" });
}
function longDate(ds) {
  return new Date(ds + "T12:00:00Z")
    .toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/* ---------- token ---------- */
function getToken() { try { return localStorage.getItem("riding_token") || ""; } catch { return ""; } }
function setToken(t) { try { localStorage.setItem("riding_token", t); } catch { /* noop */ } }
function clearToken() { try { localStorage.removeItem("riding_token"); } catch { /* noop */ } }

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function showConnecting(on) { $("#connecting").hidden = !on; }

// Reintenta ante 503 (auto-pausa de SQL). Los errores de red solo se reintentan
// en lecturas (GET) para no duplicar registros si la respuesta se perdió.
async function api(path, { method = "GET", body } = {}) {
  const maxTries = 3;
  for (let i = 1; i <= maxTries; i++) {
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 90000);
    const slowTimer = setTimeout(() => showConnecting(true), 3000);
    try {
      const headers = { "X-App-Token": getToken() };
      if (body) headers["Content-Type"] = "application/json";
      const res = await fetch(API_BASE + path, {
        method, headers, signal: ctrl.signal,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) throw new ApiError(401, "Token inválido");
      if (res.status === 503 && i < maxTries) { await sleep(2000); continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data.error || `Error ${res.status}`);
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (method === "GET" && i < maxTries) { await sleep(2000); continue; }
      throw new ApiError(0, "Sin conexión con el servidor");
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(slowTimer);
      showConnecting(false);
    }
  }
  throw new ApiError(0, "Sin conexión con el servidor");
}

/* ---------- UI helpers ---------- */
function show(view) {
  for (const v of ["token", "home", "cal"]) $("#view-" + v).hidden = v !== view;
  $("#tabs").hidden = view === "token";
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === view));
}
function showBanner(msg) { $("#banner-msg").textContent = msg; $("#banner").hidden = false; }
function hideBanner() { $("#banner").hidden = true; }

function showToast(msg, undoFn) {
  clearTimeout(state.toastTimer);
  $("#toast-msg").textContent = msg;
  const u = $("#toast-undo");
  u.hidden = !undoFn;
  u.onclick = async () => { hideToast(); if (undoFn) await undoFn(); };
  $("#toast").hidden = false;
  state.toastTimer = setTimeout(hideToast, 7000);
}
function hideToast() { clearTimeout(state.toastTimer); $("#toast").hidden = true; }

function handleError(e) {
  if (e.status === 401) {
    clearToken();
    show("token");
    $("#token-msg").textContent = "Token inválido. Pégalo de nuevo.";
    return;
  }
  showBanner(e.message || "Error inesperado");
}

async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("busy");
  hideBanner();
  try { await fn(); } catch (e) { handleError(e); }
  finally { state.busy = false; document.body.classList.remove("busy"); }
}

/* ---------- render ---------- */
function renderHome() {
  const m = currentMonth();
  $("#home-month").textContent = monthLabel(m);
  const d = state.data[m];
  if (!d) return;
  const ring = $("#ring-fg");
  ring.style.strokeDasharray = CIRC;
  ring.style.strokeDashoffset = CIRC * (1 - Math.min(d.total / d.target, 1));
  ring.dataset.state = d.extra > 0 ? "extra" : "ok";
  $("#count").textContent = d.total;
  $("#target").textContent = "de " + d.target;
  $("#status").textContent =
    d.extra > 0 ? `+${d.extra} extra` :
    d.total === d.target ? "¡Completas!" : `Faltan ${d.target - d.total}`;
  const t = d.days[todayStr()] || 0;
  $("#today-info").textContent = t
    ? `Hoy: ${t} ${t === 1 ? "clase registrada" : "clases registradas"}`
    : "Hoy: sin registrar";
}

function renderCal() {
  const m = state.calMonth;
  $("#cal-title").textContent = monthLabel(m);
  const d = state.data[m];
  const [y, mo] = m.split("-").map(Number);
  const offset = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7; // semana inicia lunes
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const today = todayStr();
  let html = "";
  for (let i = 0; i < offset; i++) html += `<div class="day empty"></div>`;
  for (let day = 1; day <= dim; day++) {
    const ds = `${m}-${String(day).padStart(2, "0")}`;
    const n = d ? (d.days[ds] || 0) : 0;
    const hol = d && d.holidays && d.holidays[ds];
    html += `<button type="button" class="day${n ? " has" : ""}${ds === today ? " today" : ""}${hol ? " holiday" : ""}" data-date="${ds}">` +
            `<span>${day}</span>${n ? `<b>${n > 1 ? "×" + n : "●"}</b>` : ""}</button>`;
  }
  $("#cal-grid").innerHTML = html;
  $("#cal-total").textContent = d ? d.total : "–";
  $("#cal-target").textContent = d ? `de ${d.target}` : "";
  $("#cal-extra").textContent = d && d.extra > 0 ? `+${d.extra} clase(s) extra este mes` : "";
}

function renderSheet() {
  const ds = state.sheetDate;
  if (!ds) return;
  const d = state.data[ds.slice(0, 7)];
  const items = d ? d.items.filter((i) => i.date === ds) : [];
  $("#sheet-title").textContent = longDate(ds);
  const hol = d && d.holidays && d.holidays[ds];
  $("#sheet-holiday").hidden = !hol;
  if (hol) {
    $("#holiday-name").textContent = "Festivo: " + hol.name;
    const tg = $("#holiday-toggle");
    tg.textContent = hol.reminder_enabled ? "Recordatorio: activado" : "Recordatorio: apagado";
    tg.classList.toggle("on", hol.reminder_enabled);
  }
  $("#sheet-list").innerHTML = items.length
    ? items.map((i, idx) => `<li><span>Clase ${idx + 1}</span><button type="button" data-del="${i.id}">Eliminar</button></li>`).join("")
    : `<li class="muted">Sin clases este día</li>`;
}

function renderAll() { renderHome(); renderCal(); renderSheet(); }

/* ---------- acciones ---------- */
async function loadMonth(m) {
  state.data[m] = await api(`/month/${m}`);
}

async function refresh() {
  await run(async () => {
    const m = state.tab === "cal" ? state.calMonth : currentMonth();
    await loadMonth(m);
    renderAll();
  });
}

function addClass(ds) {
  return run(async () => {
    const res = await api("/attendance", { method: "POST", body: ds ? { date: ds } : {} });
    state.data[res.month] = res;
    renderAll();
    showToast("Clase registrada", () => undoAdd(res.created_id));
  });
}

function undoAdd(id) {
  return run(async () => {
    const res = await api(`/attendance/${id}`, { method: "DELETE" });
    state.data[res.month] = res;
    renderAll();
    showToast("Registro deshecho");
  });
}

function removeClass(id) {
  const ds = state.sheetDate;
  return run(async () => {
    const res = await api(`/attendance/${id}`, { method: "DELETE" });
    state.data[res.month] = res;
    renderAll();
    showToast("Clase eliminada", ds ? () => addClass(ds) : null);
  });
}

function toggleHoliday() {
  const ds = state.sheetDate;
  const d = ds && state.data[ds.slice(0, 7)];
  const hol = d && d.holidays && d.holidays[ds];
  if (!hol) return;
  return run(async () => {
    const res = await api(`/holidays/${ds}`, {
      method: "PUT", body: { reminder_enabled: !hol.reminder_enabled },
    });
    state.data[res.month] = res;
    renderAll();
    showToast(hol.reminder_enabled ? "Recordatorio apagado ese día" : "Recordatorio activado ese día");
  });
}

/* ---------- notificaciones push ---------- */
function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function updateNotifStatus() {
  const el = $("#notif-status");
  if (!pushSupported()) {
    el.textContent = "Para recibir recordatorios, abre la app desde el ícono de inicio.";
    $("#notif-btn").hidden = true;
    $("#notif-test").hidden = true;
    return;
  }
  let sub = null;
  try { sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { /* noop */ }
  const on = Notification.permission === "granted" && !!sub;
  el.textContent = on ? "Recordatorios activados" : "Recordatorios desactivados";
  $("#notif-btn").hidden = on;
  $("#notif-test").hidden = !on;
}

function enableNotifications() {
  return run(async () => {
    // requestPermission debe ejecutarse directamente desde el toque (requisito de iOS)
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      throw new ApiError(0, "Permiso denegado. Actívalo en Ajustes › Notificaciones › Equitación.");
    }
    const cfg = await api("/push/config");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(cfg.publicKey),
      });
    }
    await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
    showToast("Recordatorios activados");
    await updateNotifStatus();
  });
}

function sendTestPush() {
  return run(async () => {
    const r = await api("/push/test", { method: "POST" });
    showToast(r.sent ? "Prueba enviada" : `Sin envíos (suscripciones: ${r.subscriptions}, fallos: ${r.failed})`);
  });
}

function openSheet(ds) {
  state.sheetDate = ds;
  renderSheet();
  $("#sheet").hidden = false;
}
function closeSheet() { state.sheetDate = null; $("#sheet").hidden = true; }

async function switchTab(tab) {
  state.tab = tab;
  show(tab);
  if (tab === "cal" && !state.calMonth) state.calMonth = currentMonth();
  renderAll();
  await refresh();
}

async function changeMonth(delta) {
  state.calMonth = shiftMonth(state.calMonth, delta);
  renderCal();
  await refresh();
}

/* ---------- eventos ---------- */
$("#token-save").onclick = async () => {
  const v = $("#token-input").value.trim();
  if (!v) { $("#token-msg").textContent = "Pega el token."; return; }
  setToken(v);
  $("#token-input").value = "";
  $("#token-msg").textContent = "";
  await start();
};
$("#change-token").onclick = () => { clearToken(); show("token"); };
$("#add-btn").onclick = () => addClass();
$("#banner-retry").onclick = () => refresh();
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
$("#cal-prev").onclick = () => changeMonth(-1);
$("#cal-next").onclick = () => changeMonth(1);
$("#cal-grid").onclick = (e) => {
  const btn = e.target.closest("[data-date]");
  if (btn) openSheet(btn.dataset.date);
};
$("#sheet-list").onclick = (e) => {
  const btn = e.target.closest("[data-del]");
  if (btn) removeClass(Number(btn.dataset.del));
};
$("#sheet-add").onclick = () => addClass(state.sheetDate);
$("#holiday-toggle").onclick = () => toggleHoliday();
$("#notif-btn").onclick = () => enableNotifications();
$("#notif-test").onclick = () => sendTestPush();
$("#sheet-close").onclick = closeSheet;
$("#sheet-backdrop").onclick = closeSheet;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && getToken() && !$("#view-token").offsetParent) refresh();
});

/* ---------- inicio ---------- */
async function start() {
  if (!getToken()) { show("token"); return; }
  state.calMonth = state.calMonth || currentMonth();
  show(state.tab);
  renderAll();
  await refresh();
  updateNotifStatus();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
start();
