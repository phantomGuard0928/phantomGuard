import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, set, onValue, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const app = initializeApp({
  apiKey: "AIzaSyC16d9EhEbQE3jSVEYafgbH8ouh19ho98U",
  authDomain: "phantomguard-69e93.firebaseapp.com",
  databaseURL: "https://phantomguard-69e93-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "phantomguard-69e93"
});
const auth = getAuth(app), db = getDatabase(app);
const BASE = "devices/unit1";
const ALLOWED = ["jonymangozo25@gmail.com","jofelechavez143@gmail.com","nalingseanlouis@gmail.com","seanlouisnaling@gmail.com"];
const $ = id => document.getElementById(id);

const STALE_MS             = 12000;
const OFFLINE_MS           = 40000;
const NO_DATA_MS           = 20000;
const FRESH_PROOF_MS       = 20000;
const MIN_INIT_MS          = 2000;
const PENDING_TIMEOUT_MS   = 20000;
const STATE_MATCH_DELAY_MS = 1500;

let st = null;
let stRecvAt = 0;
let confirmedAt = 0;
let everLive = false;
let phase = "INIT";
let startedAt = 0;
let pending = null;
let ang = 300;
let latestLog = [];
const seenLog = new Set();
let prevPhase = "INIT", prevPresence = null, prevRelay = null;

let unsubStatus = null;
let unsubLog = null;
let unsubConfig = null;
let tickInterval = null;

let localConfig = { absenceDelayS: 30, autoCooldownS: 15 };

/* ---------- a11y announcer ---------- */
let srTimer;
function announce(msg) {
  const el = $("srStatus");
  clearTimeout(srTimer);
  el.textContent = "";
  srTimer = setTimeout(() => { el.textContent = msg; }, 60);
}

/* ---------- input cosmetics ---------- */
document.addEventListener("pointermove", e => {
  const c = e.target.closest && e.target.closest(".card"); if (!c) return;
  const r = c.getBoundingClientRect();
  c.style.setProperty("--mx", (e.clientX - r.left) + "px");
  c.style.setProperty("--my", (e.clientY - r.top) + "px");
});
document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height), d = document.createElement("span");
  d.className = "rip";
  d.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s/2}px;top:${e.clientY - r.top - s/2}px`;
  b.append(d); setTimeout(() => d.remove(), 650);
});
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("page-hidden", document.hidden);
});

/* ---------- small helpers ---------- */
function tween(el, to, suffix = "") {
  const from = el._v ?? to; el._v = to;
  if (from === to) { el.textContent = to + suffix; return; }
  const t0 = performance.now();
  (function f(t) {
    const k = Math.min(1, (t - t0) / 700);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e) + suffix;
    if (k < 1) requestAnimationFrame(f);
  })(t0);
}
function setBtn(b, text) {
  let textNode = null;
  for (const n of b.childNodes) { if (n.nodeType === Node.TEXT_NODE) { textNode = n; break; } }
  if (!textNode) { textNode = document.createTextNode(""); b.insertBefore(textNode, b.firstChild); }
  if (textNode.textContent !== text) textNode.textContent = text;
}
function setPill(el, text, cls) { el.textContent = text; el.className = "pill " + cls; }

function toast(msg, kind = "", duration = 4200, tag = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  if (tag) t.dataset.tag = tag;
  t.textContent = msg;
  $("toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, duration);
}
function dismissToastTag(tag) {
  document.querySelectorAll(`.toast[data-tag="${tag}"]`).forEach(t => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 400);
  });
}
const fmtUp = s => {
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + "d " : "") + h + "h " + m + "m";
};
const relTime = ts => {
  if (typeof ts !== "number" || ts < 1e12) return null;
  const d = Date.now() - ts;
  if (d < 30000) return "just now";
  if (d < 60000) return Math.floor(d/1000) + "s ago";
  if (d < 3600000) return Math.floor(d/60000) + " min ago";
  if (d < 86400000) return Math.floor(d/3600000) + "h ago";
  return new Date(ts).toLocaleDateString();
};
const left = k => st ? Math.max(0, (st[k] || 0) - Math.floor((Date.now() - stRecvAt) / 1000)) : 0;

/* ---------- timers config (mode-aware) ---------- */
const TIMERS = [
  { k: "cooldownLeftS",      name: "Auto cooldown",  mode: "auto" },
  { k: "absenceLeftS",       name: "Absence delay",  mode: "auto" },
  { k: "manualLimitLeftS",   name: "Manual limit",   mode: "manual" },
  { k: "manualTimeoutLeftS", name: "Manual timeout", mode: "manual" }
];
const maxSeen = {};
$("rings").innerHTML = TIMERS.map(({k, name, mode}) =>
  `<div class="tr" data-mode="${mode}"><svg viewBox="0 0 60 60"><circle class="bg" cx="30" cy="30" r="26"/><circle class="fg" id="f_${k}" cx="30" cy="30" r="26"/></svg><span class="v" id="v_${k}">–</span><span class="mute">${name}</span></div>`
).join("");

/* ---------- auth ---------- */
$("signin").onclick = async () => {
  const btn = $("signin");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  $("loginErr").textContent = "";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { $("loginErr").textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = orig; }
};
$("signout").onclick = () => signOut(auth);

onAuthStateChanged(auth, u => {
  const ok = u && ALLOWED.includes((u.email || "").toLowerCase());
  $("login").classList.toggle("hidden", !!ok);
  $("app").classList.toggle("hidden", !ok);
  if (u && !ok) {
    $("loginErr").textContent = u.email + " is not authorized. Sign in with an approved account.";
    signOut(auth);
    return;
  }
  if (ok) {
    $("who").textContent = u.email;
    startSession();
  } else {
    stopSession();
  }
});

function stopSession() {
  if (unsubStatus) { try { unsubStatus(); } catch (e) {} unsubStatus = null; }
  if (unsubLog)    { try { unsubLog();    } catch (e) {} unsubLog    = null; }
  if (unsubConfig) { try { unsubConfig(); } catch (e) {} unsubConfig = null; }
  if (tickInterval){ clearInterval(tickInterval); tickInterval = null; }
  if (pending?.timer) { clearTimeout(pending.timer); pending = null; }
  dismissToastTag("sending");
}

function startSession() {
  stopSession();

  st = null;
  stRecvAt = 0;
  confirmedAt = 0;
  everLive = false;
  startedAt = Date.now();
  phase = "INIT";
  prevPhase = "INIT"; prevPresence = null; prevRelay = null;
  latestLog = [];
  seenLog.clear();
  ang = 300;
  pending = null;

  // Listen to Config
  unsubConfig = onValue(ref(db, BASE + "/config"), snap => {
    const v = snap.val();
    if (v) {
      localConfig = v;
      $("cfgAbsence").value = v.absenceDelayS || 30;
      $("cfgCooldown").value = v.autoCooldownS || 15;
    }
  });

  unsubStatus = onValue(ref(db, BASE + "/status"), snap => {
    const v = snap.val();
    if (!v) return;
    const now = Date.now();

    let fresh = false;
    if (typeof v.ts === "number" && Math.abs(now - v.ts) <= FRESH_PROOF_MS) fresh = true;
    else if (st && typeof v.uptimeS === "number" && typeof st.uptimeS === "number" && v.uptimeS > st.uptimeS) fresh = true;
    else if (st?.lastCmd && v.lastCmd && typeof v.lastCmd.seq === "number" && typeof st.lastCmd.seq === "number" && v.lastCmd.seq > st.lastCmd.seq) fresh = true;

    st = v;
    stRecvAt = now;
    for (const {k} of TIMERS) maxSeen[k] = Math.max(maxSeen[k] || 1, v[k] || 0);
    if (fresh) { confirmedAt = now; everLive = true; }

    ang += (Math.random() - .5) * 26;
    checkPending();
    render();
  }, e => toast("Status read failed: " + e.message, "bad"));

  unsubLog = onValue(query(ref(db, BASE + "/log"), limitToLast(10)), snap => {
    const items = [];
    snap.forEach(c => {
      const val = c.val();
      if (val && typeof val === "object") items.push({ ...val, k: c.key });
      else items.push({ k: c.key, changed: String(val ?? "") });
    });
    items.sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      if (ta !== tb) return tb - ta;
      return a.k < b.k ? 1 : (a.k > b.k ? -1 : 0);
    });
    latestLog = items;
    paintLog();
  }, () => {});

  tickInterval = setInterval(render, 1000);
  render();
}

/* ---------- config writes ---------- */
function writeConfig(key, val) {
  if (phase !== "LIVE") { toast("Device must be online to change settings.", "bad"); return; }
  const updates = {};
  updates[key] = parseInt(val);
  set(ref(db, BASE + "/config"), { ...localConfig, ...updates })
    .then(() => toast("Setting saved. Device will sync in 10s.", "ok"))
    .catch(e => toast("Failed to save: " + e.message, "bad"));
}
$("cfgAbsence").onchange = (e) => writeConfig("absenceDelayS", e.target.value);
$("cfgCooldown").onchange = (e) => writeConfig("autoCooldownS", e.target.value);

/* ---------- commands ---------- */
function send(action) {
  if (pending) { toast("Please wait for the previous command to finish.", ""); return; }
  if (phase !== "LIVE" || !st) { toast("The system is not online right now.", "bad"); return; }

  // Validation
  if ((action === "on" || action === "off") && !st.manual) {
    toast("Switch to Manual override before turning the relay on or off.", "bad"); return;
  }
  if (action === "on"  &&  st.relayOn) { toast("Relay is already ON — nothing to change.", ""); return; }
  if (action === "off" && !st.relayOn) { toast("Relay is already OFF — nothing to change.", ""); return; }
  if ((action === "on" || action === "off") && left("manualLimitLeftS") > 0) {
    toast("Wait " + left("manualLimitLeftS") + "s before trying again.", "bad"); return;
  }
  if (action === "auto"     && !st.manual && !st.forceOff) { toast("Already in Auto mode.", ""); return; }
  if (action === "override" &&  st.manual && !st.forceOff) { toast("Already in Manual override.", ""); return; }
  if (action === "force_off" && st.forceOff) { toast("Already locked out.", ""); return; }

  const id = Date.now();
  pending = {
    id,
    action,
    since: Date.now(),
    stateAtSend: { relayOn: !!st.relayOn, manual: !!st.manual, forceOff: !!st.forceOff }
  };

  toast("Command sent. Waiting for the device…", "", 3000, "sending");

  set(ref(db, BASE + "/control"), { action, cmdId: id })
    .catch(e => {
      if (!pending || pending.id !== id) return;
      clearTimeout(pending.timer);
      pending = null;
      dismissToastTag("sending");
      toast("Could not send: " + e.message, "bad");
      render();
    });

  pending.timer = setTimeout(() => onPendingTimeout(id), PENDING_TIMEOUT_MS);
  render();
}
$("segAuto").onclick   = () => send("auto");
$("segManual").onclick = () => send("override");
$("segLockout").onclick = () => send("force_off");
$("bPower").onclick    = () => { if (!st) return; send(st.relayOn ? "off" : "on"); };

function stateMatches() {
  if (!pending || !st) return false;
  const b = pending.stateAtSend;
  if (pending.action === "on"        &&  st.relayOn && !b.relayOn) return true;
  if (pending.action === "off"       && !st.relayOn &&  b.relayOn) return true;
  if (pending.action === "override"  &&  st.manual  && !b.manual ) return true;
  if (pending.action === "force_off" &&  st.forceOff&& !b.forceOff)return true;
  if (pending.action === "auto"      && !st.manual  && !st.forceOff && (b.manual || b.forceOff)) return true;
  return false;
}

function checkPending() {
  if (!pending) return;
  const lc = st?.lastCmd;
  if (lc && lc.cmdId !== undefined && String(lc.cmdId) === String(pending.id)) {
    resolvePending(lc.result, lc.retryAfterS);
    return;
  }
  if (Date.now() - pending.since > STATE_MATCH_DELAY_MS && stateMatches()) {
    resolvePending(1);
  }
}

function resolvePending(result, retryAfterS) {
  if (!pending) return;
  const action = pending.action;
  if (pending.timer) clearTimeout(pending.timer);
  pending = null;
  dismissToastTag("sending");

  let msg, kind;
  switch (result) {
    case 1: msg = "Command applied."; kind = "ok"; break;
    case 2:
      if (action === "on") msg = "Relay is already ON.";
      else if (action === "off") msg = "Relay is already OFF.";
      else if (action === "auto") msg = "Already in Auto mode.";
      else if (action === "override") msg = "Already in Manual override.";
      else if (action === "force_off") msg = "Already locked out.";
      else msg = "No change needed.";
      kind = ""; break;
    case 3: msg = "Too fast. Wait " + (retryAfterS || 0) + "s before trying again."; kind = "bad"; break;
    case 4: msg = "Invalid state for that command."; kind = "bad"; break;
    case 5: msg = "The device did not recognize that command."; kind = "bad"; break;
    default: msg = "Unknown result code " + result; kind = "bad";
  }
  toast(msg, kind);
  render();
}

function onPendingTimeout(id) {
  if (!pending || pending.id !== id) return;
  const action = pending.action;
  const matched = stateMatches();
  pending = null;
  dismissToastTag("sending");

  if (matched) {
    toast("Command applied.", "ok");
  } else if (phase === "LIVE") {
    toast("No response from the device. Try again.", "bad");
  } else {
    toast("Connection lost — could not confirm the command.", "bad");
  }
  render();
}

/* ---------- phase ---------- */
function computePhase(now) {
  if (!startedAt || now - startedAt < MIN_INIT_MS) return "INIT";
  if (!st) return (now - startedAt > NO_DATA_MS) ? "OFFLINE" : "INIT";
  if (!everLive) return (now - stRecvAt > OFFLINE_MS) ? "OFFLINE" : "INIT";
  const age = now - confirmedAt;
  if (age <= STALE_MS) return "LIVE";
  if (age <= OFFLINE_MS) return "WAITING";
  return "OFFLINE";
}

function renderHeader() {
  const map = { INIT: "init", LIVE: "live", WAITING: "wait", OFFLINE: "off" };
  $("hbDot").className = "dot " + map[phase];
}

function updateFreshChip(now) {
  const chip = $("freshChip");
  let text, cls;
  if (phase === "INIT") { text = "Connecting…"; cls = "fresh-chip init"; }
  else if (phase === "OFFLINE") { text = "Offline"; cls = "fresh-chip off"; }
  else {
    const age = Math.max(0, Math.floor((now - confirmedAt) / 1000));
    if (phase === "LIVE") {
      text = age < 2 ? "Live now" : `Updated ${age}s ago`;
      cls = "fresh-chip live";
    } else {
      text = `Last update ${age}s ago`;
      cls = "fresh-chip wait";
    }
  }
  if (chip.textContent !== text) chip.textContent = text;
  if (chip.className !== cls) chip.className = cls;
}

function updateStateBanner(now) {
  const b = $("stateBanner");
  let msg = "", cls = "";
  if (phase === "OFFLINE") {
    msg = everLive ? "Device offline. Showing last known values." : "Waiting for the device to check in.";
    cls = "banner off";
  } else if (phase === "WAITING") {
    const age = Math.max(0, Math.floor((now - confirmedAt) / 1000));
    msg = `Data paused — last update ${age}s ago.`;
    cls = "banner";
  } else if (phase === "LIVE" && st && !st.radarConnected) {
    msg = "Radar disconnected. Auto mode unavailable.";
    cls = "banner";
  } else if (phase === "INIT") {
    msg = "Connecting to the device…";
    cls = "banner info";
  }
  if (msg) {
    if (b.textContent !== msg) b.textContent = msg;
    b.className = cls;
  } else {
    b.className = "banner hidden";
  }
}

/* ---------- controls ---------- */
function updateControls() {
  const segA = $("segAuto"), segM = $("segManual"), segL = $("segLockout"), pow = $("bPower"), reason = $("powerReason");
  const cfgAbs = $("cfgAbsence"), cfgCoold = $("cfgCooldown");
  const lim = (phase === "LIVE" && st) ? left("manualLimitLeftS") : 0;

  // Pending: lock everything
  if (pending) {
    segA.disabled = segM.disabled = segL.disabled = pow.disabled = true;
    segA.setAttribute("aria-pressed", "false"); segM.setAttribute("aria-pressed", "false"); segL.setAttribute("aria-pressed", "false");
    setBtn(segA, "Auto"); setBtn(segM, "Manual"); setBtn(segL, "Lockout");
    if (pending.action === "auto") setBtn(segA, "Sending…");
    if (pending.action === "override") setBtn(segM, "Sending…");
    if (pending.action === "force_off") setBtn(segL, "Sending…");
    if (pending.action === "on" || pending.action === "off") setBtn(pow, "Sending…");
    reason.textContent = "Waiting for the device to confirm…";
    cfgAbs.disabled = cfgCoold.disabled = true;
    return;
  }

  // Not live: disable everything
  if (phase !== "LIVE" || !st) {
    segA.disabled = segM.disabled = segL.disabled = pow.disabled = true;
    segA.setAttribute("aria-pressed", "false"); segM.setAttribute("aria-pressed", "false"); segL.setAttribute("aria-pressed", "false");
    setBtn(segA, "Auto"); setBtn(segM, "Manual"); setBtn(segL, "Secure Off");
    const on = !!st?.relayOn;
    setBtn(pow, on ? "Turn OFF" : "Turn ON");
    pow.classList.toggle("primary", !on);
    pow.classList.toggle("danger", on);
    reason.textContent = phase === "OFFLINE" ? "Waiting for the device to come back online." : "Waiting for the device to check in.";
    cfgAbs.disabled = cfgCoold.disabled = true;
    return;
  }

  // Live
  const manual = !!st.manual;
  const lockout = !!st.forceOff;

  segA.disabled = (!manual && !lockout) || !st.radarConnected;
  segM.disabled = manual && !lockout;
  segL.disabled = lockout;

  segA.setAttribute("aria-pressed", String(!manual && !lockout));
  segM.setAttribute("aria-pressed", String(manual && !lockout));
  segL.setAttribute("aria-pressed", String(lockout));

  setBtn(segA, "Auto"); setBtn(segM, "Manual"); setBtn(segL, "Lockout");

  const on = !!st.relayOn;
  pow.disabled = !manual || lockout || lim > 0;
  setBtn(pow, lim > 0 ? `Wait ${lim}s…` : (on ? "Turn OFF" : "Turn ON"));
  pow.classList.toggle("primary", !on);
  pow.classList.toggle("danger", on);

  cfgAbs.disabled = false;
  cfgCoold.disabled = false;

  if (lockout) reason.textContent = "Security lockout active. Relay is permanently OFF.";
  else if (!manual) reason.textContent = st.radarConnected ? "Switch to Manual to control the relay." : "Radar disconnected — running on manual fallback.";
  else if (lim > 0) reason.textContent = `Wait ${lim}s before changing the relay again.`;
  else reason.textContent = on ? "Relay is ON. Turn it off when you leave." : "Relay is OFF. Turn it on when needed.";
}

/* ---------- main render ---------- */
function renderLive(now) {
  const live    = phase === "LIVE";
  const waiting = phase === "WAITING";
  const haveData = !!st && (live || waiting);

  for (const id of ["cardCtrl", "cardTime", "cardHealth", "cardConfig"]) {
    $(id).classList.toggle("stale", waiting);
  }
  $("hero").classList.toggle("stale", waiting);

  const orb = $("orb");
  orb.classList.toggle("off", !live);
  orb.classList.toggle("hot", live && !!st && !!st.presence);

  if (!haveData) {
    const msg = phase === "OFFLINE" ? "Offline" : "Initializing…";
    $("presTxt").textContent = msg;
    $("presTxt").classList.add("init");
    $("presTxt").classList.remove("hot");
    $("relayLine").textContent = phase === "OFFLINE" ? "Waiting for the device to come back." : "Waiting for the device to check in.";
    $("distTxt").innerHTML = "&nbsp;";
    $("blip").style.opacity = "0";
    setPill($("modePill"), "–", "idle");
    setPill($("outPill"), "–", "idle");
    setPill($("radarPill"), "–", "idle");
    $("bulb").classList.remove("on");
    $("relayTxt").textContent = msg;
    $("modeHint").textContent = phase === "OFFLINE" ? "Controls are disabled while offline." : "";
    $("movV").textContent = "–"; $("movB").style.width = "0%";
    $("staV").textContent = "–"; $("staB").style.width = "0%";
    for (const {k} of TIMERS) { $("v_" + k).textContent = "–"; $("f_" + k).style.strokeDashoffset = "163.4"; }
    $("hRssi").textContent = "–"; $("hUp").textContent = "–";
    $("hDrops").textContent = "–"; $("hRadar").textContent = "–";
    updateControls();
    return;
  }

  const present = !!st.presence;
  $("presTxt").classList.remove("init");
  if (waiting) {
    $("presTxt").textContent = "Reconnecting…";
    $("presTxt").classList.remove("hot");
  } else {
    $("presTxt").textContent = present ? "Someone's here" : "Room empty";
    $("presTxt").classList.toggle("hot", present && live);
  }

  $("relayLine").textContent = "Appliance power is " + (st.relayOn ? "on" : "off") + (st.manual ? ", controlled by you." : (st.forceOff ? ", locked out." : ", controlled automatically."));

  $("distTxt").innerHTML = present ? "Target at " + (st.detDist || 0) + " cm" : "&nbsp;";
  $("blip").style.opacity = (present && live) ? "1" : "0";
  if (present) {
    const cm = st.detDist || 0;
    const rr = cm < 150 ? 0.125 : cm < 300 ? 0.25 : 0.375;
    const rad = ang * Math.PI / 180;
    $("blip").style.left = (50 + Math.cos(rad) * rr * 100) + "%";
    $("blip").style.top  = (50 + Math.sin(rad) * rr * 100) + "%";
  }

  // Pills
  let modeText = "◉ Auto mode", modeCls = "ok";
  if (st.forceOff) { modeText = "⊘ Secure Off"; modeCls = "bad"; }
  else if (st.manual) { modeText = "◎ Manual override"; modeCls = "warn"; }
  setPill($("modePill"), modeText, modeCls);

  setPill($("outPill"), (st.outHigh ? "▲ OUT high" : "▼ OUT low"), st.outHigh ? "ok" : "");
  setPill($("radarPill"), (st.radarConnected ? "✓ Radar linked" : "✕ Radar lost"), st.radarConnected ? "ok" : "bad");

  // Relay
  $("bulb").classList.toggle("on", !!st.relayOn);
  $("relayTxt").textContent = st.relayOn ? "Power ON" : "Power OFF";
  
  if (st.forceOff) $("modeHint").textContent = "System locked out";
  else if (st.manual) $("modeHint").textContent = "Back to Auto in " + left("manualTimeoutLeftS") + "s";
  else $("modeHint").textContent = "Click Manual to take control";

  // Radar energy
  tween($("movV"), st.moving || 0);
  tween($("staV"), st.stationary || 0);
  $("movB").style.width = Math.min(100, st.moving || 0) + "%";
  $("staB").style.width = Math.min(100, st.stationary || 0) + "%";

  // Timers
  const activeMode = st.manual ? "manual" : "auto";
  document.querySelectorAll("#rings .tr").forEach(tr => {
    tr.hidden = tr.dataset.mode !== activeMode;
  });
  for (const {k} of TIMERS) {
    let v = left(k);
    let max = 1; 

    // Determine the 100% mark based on current settings
    if (k === "cooldownLeftS") max = localConfig.autoCooldownS || 15;
    else if (k === "absenceLeftS") max = localConfig.absenceDelayS || 30;
    else if (k === "manualLimitLeftS") max = 7;
    else if (k === "manualTimeoutLeftS") max = 120;

    if (k === "manualTimeoutLeftS" && !st.manual) v = 0;
    
    $("v_" + k).textContent = v;
    // Calculate the offset. 163.4 is the full circumference of the circle.
    $("f_" + k).style.strokeDashoffset = 163.4 * (1 - Math.min(1, v / max));
  }

  // Health
  const rssi = st.rssi ?? 0;
  const bars = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : rssi >= -85 ? 1 : 0;
  const barsHtml = `<span class="rssi-bars">${[1,2,3,4].map(n => `<i class="${n <= bars ? "on" : ""}"></i>`).join("")}</span>`;
  $("hRssi").innerHTML = `${barsHtml}<span>${rssi} dBm</span>`;
  $("hUp").textContent    = fmtUp(st.uptimeS + Math.floor((Date.now() - stRecvAt) / 1000));
  $("hDrops").textContent = st.drops ?? 0;
  $("hRadar").textContent = st.radarConnected ? "Connected" : "Disconnected";

  updateControls();
}

function render() {
  const now = Date.now();
  phase = computePhase(now);
  $("app").dataset.phase = phase;
  renderHeader();
  updateFreshChip(now);
  updateStateBanner(now);
  renderLive(now);

  if (phase !== prevPhase) {
    announce(phase === "LIVE" ? "Live" : phase === "WAITING" ? "Data paused" : phase === "OFFLINE" ? "Device offline" : "Connecting");
    const hero = $("hero");
    hero.classList.remove("transition-flash");
    void hero.offsetWidth;
    hero.classList.add("transition-flash");
    paintLog();
    prevPhase = phase;
  }
  if (st && phase === "LIVE") {
    if (prevPresence !== null && prevPresence !== !!st.presence) announce(st.presence ? "Someone detected" : "Room is empty");
    prevPresence = !!st.presence;
    if (prevRelay !== null && prevRelay !== !!st.relayOn) announce(st.relayOn ? "Relay on" : "Relay off");
    prevRelay = !!st.relayOn;
  }
}

/* ---------- log ---------- */
function describe(e) {
  const parts = [];
  const changedStr = typeof e.changed === "string" ? e.changed : String(e.changed ?? "");
  const ch = changedStr.split(",");
  if (ch.includes("relay")) parts.push(e.relayOn ? "Relay turned ON" : "Relay turned OFF");
  if (ch.includes("mode")) parts.push(e.manual ? "Switched to Manual override" : "Switched to Auto mode");
  if (ch.includes("lockout")) parts.push(e.forceOff ? "System LOCKED OUT" : "System unlocked");
  if (ch.includes("presence")) parts.push(e.presence ? "Person detected" : "Room became empty");
  if (e.cmdResult && e.cmdResult > 2) parts.push("Command rejected (code " + e.cmdResult + ")");
  return parts.length ? parts.join(" · ") : (changedStr || "Event");
}

function paintLog() {
  const ul = $("log");
  ul.classList.toggle("dim", phase === "OFFLINE" || phase === "WAITING");

  const frag = document.createDocumentFragment();

  if (!Array.isArray(latestLog) || latestLog.length === 0) {
    const li = document.createElement("li");
    li.className = "mute";
    li.textContent = phase === "OFFLINE" ? "No events cached." : "No events yet.";
    frag.append(li);
  } else {
    latestLog.forEach((e, i) => {
      try {
        const li = document.createElement("li");
        const isNew = !seenLog.has(e.k);
        seenLog.add(e.k);
        const cls = [];
        if (e.cmdResult > 2) cls.push("bad");
        else if ((e.changed || "").includes("relay") || (e.changed || "").includes("lockout")) cls.push("ok");
        if (isNew) cls.push("new");
        li.className = cls.join(" ");
        if (isNew) li.style.animationDelay = Math.min(i, 12) * 60 + "ms";

        let when;
        const rel = relTime(e.ts);
        if (rel) when = rel + (e.ts > 1e12 ? " · " + new Date(e.ts).toLocaleTimeString() : "");
        else when = "uptime " + fmtUp(e.uptimeS || 0);

        const d1 = document.createElement("div");
        const d2 = document.createElement("div");
        d2.className = "mute";
        d1.textContent = describe(e);
        d2.textContent = when;
        if (typeof e.ts === "number" && e.ts > 1e12) d2.title = new Date(e.ts).toLocaleString();
        li.append(d1, d2);
        frag.append(li);
      } catch (err) {
        console.warn("Log render error", e, err);
      }
    });
  }
  ul.replaceChildren(frag);
}
