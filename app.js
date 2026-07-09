import { firebaseConfig } from "./firebase-config.js";

import {
  getApps,
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
  runTransaction,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const $ = (id) => document.getElementById(id);

const pageMode = document.body.dataset.page === "join" ? "join" : "teacher";

const setup = $("setup");
const game = $("game");
const teacherSetup = $("teacherSetup");
const teacherNameInput = $("teacherNameInput");
const createRoomBtn = $("createRoomBtn");
const roomInput = $("roomInput");
const nameInput = $("nameInput");
const joinBtn = $("joinBtn");
const setupError = $("setupError");

const roomTitle = $("roomTitle");
const shareActions = $("shareActions");
const copyLinkBtn = $("copyLinkBtn");
const openJoinLinkBtn = $("openJoinLinkBtn");
const copyCodeBtn = $("copyCodeBtn");
const soundToggleBtn = $("soundToggleBtn");
const copyStatus = $("copyStatus");
const roundValue = $("roundValue");
const onlineValue = $("onlineValue");
const playerCountValue = $("playerCountValue");
const statusBox = $("status");
const statusText = $("statusText");
const buzzBtn = $("buzzBtn");
const hostControls = $("hostControls");
const resetBtn = $("resetBtn");
const lockBtn = $("lockBtn");
const clearBtn = $("clearBtn");
const playersList = $("playersList");
const historyList = $("historyList");
const leaveBtn = $("leaveBtn");

let app;
let db;
let auth;
let uid;
let roomCode;
let playerName;
let role;
let state = null;
let unsubscribers = [];
let currentRound = 1;
let playerCount = 0;
let onlineCount = 0;
let hostRoomToRejoin = "";
let audioContext;
let hasRenderedState = false;
let lastSoundedBuzzKey = "";

const STORAGE_KEY = "classroom-buzzer-settings";
const savedSettings = readSettings();
let soundEnabled = savedSettings.soundEnabled !== false;

const params = new URLSearchParams(location.search);
const initialRoom = normalizeRoom(params.get("room") || "");
const initialHost = params.get("host") === "1";

if (pageMode === "teacher" && initialRoom && !initialHost) {
  location.replace(makePlayerUrl(initialRoom).toString());
}

if (roomInput && initialRoom) roomInput.value = initialRoom;
if (nameInput) {
  if (params.get("name")) nameInput.value = params.get("name");
  else if (savedSettings.name) nameInput.value = savedSettings.name;
}

if (teacherNameInput) {
  if (savedSettings.teacherName) teacherNameInput.value = savedSettings.teacherName;
  else if (initialHost && params.get("name")) teacherNameInput.value = params.get("name");
}

if (pageMode === "teacher" && initialRoom && initialHost) {
  hostRoomToRejoin = initialRoom;
  if (teacherSetup) teacherSetup.querySelector("h2").textContent = `Rejoin room ${initialRoom}`;
  if (createRoomBtn) createRoomBtn.textContent = "Rejoin as teacher";
} else if (pageMode === "join" && initialRoom && nameInput) {
  nameInput.focus();
} else if (pageMode === "join" && roomInput) {
  roomInput.focus();
}

createRoomBtn?.addEventListener("click", createRoom);
joinBtn?.addEventListener("click", joinRoom);
buzzBtn?.addEventListener("click", buzz);
resetBtn?.addEventListener("click", resetBuzzer);
lockBtn?.addEventListener("click", lockWithoutWinner);
clearBtn?.addEventListener("click", clearRoom);
copyLinkBtn?.addEventListener("click", copyPlayerLink);
openJoinLinkBtn?.addEventListener("click", openJoinScreen);
copyCodeBtn?.addEventListener("click", copyRoomCode);
soundToggleBtn?.addEventListener("click", toggleSound);
leaveBtn?.addEventListener("click", leaveRoom);

roomInput?.addEventListener("input", () => {
  const cursor = roomInput.selectionStart;
  roomInput.value = normalizeRoom(roomInput.value);
  roomInput.setSelectionRange(cursor, cursor);
});

for (const input of [roomInput, nameInput].filter(Boolean)) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });
}

teacherNameInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") createRoom();
});

window.addEventListener("beforeunload", () => {
  if (db && roomCode && uid) {
    update(ref(db, `rooms/${roomCode}/players/${uid}`), {
      online: false,
      lastSeen: serverTimestamp()
    });
  }
});

updateSoundButton();

async function createRoom() {
  if (!createRoomBtn || createRoomBtn.disabled) return;

  primeAudio();
  setupError.textContent = "";

  roomCode = hostRoomToRejoin || makeRoomCode();
  playerName = teacherNameInput.value.trim() || "Teacher";
  role = "host";

  createRoomBtn.disabled = true;
  createRoomBtn.textContent = hostRoomToRejoin ? "Rejoining..." : "Creating...";

  try {
    await initializeFirebaseSession();
    await runTransaction(ref(db, `rooms/${roomCode}/state`), (oldState) => {
      if (oldState) return { ...oldState, open: oldState.open !== false };
      return {
        open: true,
        locked: false,
        winner: null,
        round: 1,
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
    });

    await registerPresence();

    enterGame();
    subscribe();
    saveSettings({ teacherName: playerName });
  } catch (err) {
    console.error(err);
    showError(cleanError(err));
  } finally {
    createRoomBtn.disabled = false;
    createRoomBtn.textContent = hostRoomToRejoin ? "Rejoin as teacher" : "Create room";
  }
}

async function joinRoom() {
  if (!joinBtn || joinBtn.disabled) return;

  primeAudio();
  setupError.textContent = "";

  roomCode = normalizeRoom(roomInput.value);
  playerName = nameInput.value.trim();
  role = "player";

  if (!roomCode) return showError("Enter a room code.");
  if (!playerName) return showError("Enter your name or team name.");

  joinBtn.disabled = true;
  joinBtn.textContent = "Joining...";

  try {
    await initializeFirebaseSession();
    const roomState = await get(ref(db, `rooms/${roomCode}/state`));
    if (!roomState.exists() || roomState.val()?.open === false) {
      throw new Error("Room not open. Check the code with your teacher.");
    }

    await registerPresence();

    enterGame();
    subscribe();
    saveSettings({ name: playerName });
  } catch (err) {
    console.error(err);
    showError(cleanError(err));
  } finally {
    joinBtn.disabled = false;
    joinBtn.textContent = "Join room";
  }
}

async function initializeFirebaseSession() {
  ensureFirebaseConfig();
  app = getApps()[0] || initializeApp(firebaseConfig);
  db = getDatabase(app);
  auth = getAuth(app);

  const cred = await signInAnonymously(auth);
  uid = cred.user.uid;
}

async function registerPresence() {
  await set(ref(db, `rooms/${roomCode}/players/${uid}`), {
    name: playerName,
    role,
    online: true,
    joinedAt: serverTimestamp(),
    lastSeen: serverTimestamp()
  });

  await onDisconnect(ref(db, `rooms/${roomCode}/players/${uid}`)).update({
    online: false,
    lastSeen: serverTimestamp()
  });
}

function enterGame() {
  setup.classList.add("hidden");
  game.classList.remove("hidden");
  roomTitle.textContent = roomCode;
  hostControls.classList.toggle("hidden", role !== "host");
  shareActions?.classList.toggle("hidden", role !== "host");
  buzzBtn.disabled = role === "host";
  buzzBtn.textContent = role === "host" ? "HOST" : "BUZZ";
  updateUrl();
  renderSummary();
  updateSoundButton();
}

function subscribe() {
  unsubscribeAll();

  const stateRef = ref(db, `rooms/${roomCode}/state`);
  const playersRef = ref(db, `rooms/${roomCode}/players`);
  const historyRef = ref(db, `rooms/${roomCode}/history`);

  unsubscribers.push(onValue(stateRef, (snap) => {
    state = snap.val();
    currentRound = state?.round || 1;
    renderState();
  }));

  unsubscribers.push(onValue(playersRef, (snap) => {
    renderPlayers(snap.val() || {});
  }));

  unsubscribers.push(onValue(historyRef, (snap) => {
    renderHistory(snap.val() || {});
  }));
}

function unsubscribeAll() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
}

async function buzz() {
  if (!db || !roomCode || !uid || !playerName || role === "host") return;
  playBuzzerSound();
  buzzBtn.disabled = true;
  buzzBtn.textContent = "WAIT";

  try {
    const result = await runTransaction(ref(db, `rooms/${roomCode}/state`), (oldState) => {
      const nextState = oldState || {
        open: true,
        locked: false,
        winner: null,
        round: 1,
        startedAt: serverTimestamp()
      };

      if (nextState.open === false || nextState.locked) return;

      return {
        ...nextState,
        open: true,
        locked: true,
        winner: {
          uid,
          name: playerName,
          at: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      };
    });

    if (result.committed) {
      await set(ref(db, `rooms/${roomCode}/history/${Date.now()}-${uid}`), {
        round: currentRound,
        uid,
        name: playerName,
        at: serverTimestamp()
      });
    }
  } catch (err) {
    console.error(err);
    statusText.textContent = cleanError(err);
  }

  renderState();
}

async function resetBuzzer() {
  primeAudio();
  await update(ref(db, `rooms/${roomCode}/state`), {
    open: true,
    locked: false,
    winner: null,
    round: increment(1),
    startedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

async function lockWithoutWinner() {
  await update(ref(db, `rooms/${roomCode}/state`), {
    open: true,
    locked: true,
    winner: {
      uid: "host",
      name: "Locked by host",
      at: serverTimestamp()
    },
    updatedAt: serverTimestamp()
  });
}

async function clearRoom() {
  const ok = confirm(`Clear room ${roomCode}? This removes players and history.`);
  if (!ok) return;
  await remove(ref(db, `rooms/${roomCode}`));
  location.href = "./index.html";
}

async function leaveRoom() {
  try {
    if (db && roomCode && uid) {
      await update(ref(db, `rooms/${roomCode}/players/${uid}`), {
        online: false,
        lastSeen: serverTimestamp()
      });
    }
  } finally {
    location.href = pageMode === "join" ? "./join.html" : "./index.html";
  }
}

function renderState() {
  if (!state) {
    statusText.textContent = "Room closed or not available.";
    statusBox.className = "status waiting";
    buzzBtn.disabled = true;
    buzzBtn.textContent = role === "host" ? "HOST" : "BUZZ";
    renderSummary();
    hasRenderedState = true;
    return;
  }

  currentRound = state.round || 1;
  renderSummary();

  if (state.locked) {
    const winner = state.winner?.name || "Someone";
    const buzzKey = getBuzzKey(state);
    if (hasRenderedState && buzzKey && buzzKey !== lastSoundedBuzzKey && state.winner?.uid !== uid && state.winner?.uid !== "host") {
      playBuzzerSound();
    }
    if (buzzKey) lastSoundedBuzzKey = buzzKey;

    statusText.textContent = `${winner} buzzed first.`;
    statusBox.className = "status locked";
    buzzBtn.disabled = true;
    buzzBtn.textContent = "LOCKED";
  } else {
    statusText.textContent = role === "host" ? "Ready for the next question." : "Ready. Buzz now!";
    statusBox.className = "status ready";
    buzzBtn.disabled = role === "host";
    buzzBtn.textContent = role === "host" ? "HOST" : "BUZZ";
  }

  hasRenderedState = true;
}

function renderPlayers(players) {
  const rows = Object.values(players)
    .sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));

  playersList.innerHTML = "";
  playerCount = rows.filter((player) => player.role !== "host").length;
  onlineCount = rows.filter((player) => player.online).length;
  renderSummary();

  if (!rows.length) {
    playersList.innerHTML = "<li>No players yet.</li>";
    return;
  }

  for (const player of rows) {
    const li = document.createElement("li");
    li.className = player.online ? "online" : "offline";
    li.textContent = `${player.name}${player.role === "host" ? " - host" : ""}${player.online ? "" : " - offline"}`;
    playersList.appendChild(li);
  }
}

function renderHistory(history) {
  const rows = Object.values(history)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 10);

  historyList.innerHTML = "";

  if (!rows.length) {
    historyList.innerHTML = "<li>No buzzes yet.</li>";
    return;
  }

  for (const item of rows) {
    const li = document.createElement("li");
    const time = item.at ? new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    li.textContent = `Round ${item.round || "?"}: ${item.name}${time ? ` at ${time}` : ""}`;
    historyList.appendChild(li);
  }
}

async function copyPlayerLink() {
  const url = makePlayerUrl();

  try {
    await copyText(url.toString());
    copyStatus.textContent = "Student link copied.";
    copyLinkBtn.textContent = "Copied";
  } catch (err) {
    console.error(err);
    copyStatus.textContent = url.toString();
    copyLinkBtn.textContent = "Copy failed";
  }

  setTimeout(() => {
    copyStatus.textContent = "";
    copyLinkBtn.textContent = "Copy student link";
  }, 1800);
}

async function copyRoomCode() {
  try {
    await copyText(roomCode);
    copyStatus.textContent = `Room code ${roomCode} copied.`;
    copyCodeBtn.textContent = "Copied";
  } catch (err) {
    console.error(err);
    copyStatus.textContent = roomCode;
    copyCodeBtn.textContent = "Copy failed";
  }

  setTimeout(() => {
    copyStatus.textContent = "";
    copyCodeBtn.textContent = "Copy code";
  }, 1800);
}

function openJoinScreen() {
  const opened = window.open(makePlayerUrl().toString(), "_blank", "noopener");
  copyStatus.textContent = opened ? "Join screen opened." : makePlayerUrl().toString();
  setTimeout(() => {
    copyStatus.textContent = "";
  }, 1800);
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  saveSettings({ soundEnabled });
  if (soundEnabled) primeAudio();
  updateSoundButton();
}

function updateSoundButton() {
  if (soundToggleBtn) soundToggleBtn.textContent = soundEnabled ? "Sound on" : "Sound off";
}

function primeAudio() {
  if (!soundEnabled) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
}

function playBuzzerSound() {
  if (!soundEnabled) return;
  primeAudio();
  if (!audioContext || audioContext.state !== "running") return;

  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  const low = audioContext.createOscillator();
  const high = audioContext.createOscillator();

  low.type = "sawtooth";
  high.type = "square";
  low.frequency.setValueAtTime(150, now);
  low.frequency.exponentialRampToValueAtTime(95, now + 0.32);
  high.frequency.setValueAtTime(240, now);
  high.frequency.exponentialRampToValueAtTime(180, now + 0.32);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.24, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);

  low.connect(gain);
  high.connect(gain);
  gain.connect(audioContext.destination);

  low.start(now);
  high.start(now);
  low.stop(now + 0.38);
  high.stop(now + 0.38);
}

function getBuzzKey(roomState) {
  if (!roomState?.locked || !roomState.winner) return "";
  return `${roomState.round || 1}:${roomState.winner.uid || ""}:${roomState.winner.name || ""}:${roomState.winner.at || ""}`;
}

function updateUrl() {
  const url = role === "host" ? makeHostUrl() : makePlayerUrl();
  history.replaceState(null, "", url);
}

function makePlayerUrl(code = roomCode) {
  const url = new URL("./join.html", location.href);
  if (code) url.searchParams.set("room", code);
  url.searchParams.delete("host");
  url.searchParams.delete("name");
  return url;
}

function makeHostUrl() {
  const url = new URL("./index.html", location.href);
  url.searchParams.set("room", roomCode);
  url.searchParams.set("host", "1");
  url.searchParams.set("name", playerName);
  return url;
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function normalizeRoom(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function renderSummary() {
  roundValue.textContent = String(currentRound || 1);
  onlineValue.textContent = String(onlineCount);
  playerCountValue.textContent = String(playerCount);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) throw new Error("Clipboard copy was blocked.");
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    const current = readSettings();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...settings }));
  } catch {
    // Persistence is a convenience only; private browsing may block it.
  }
}

function ensureFirebaseConfig() {
  const missing = Object.values(firebaseConfig).some((value) => !value || value.includes("PASTE_YOUR_VALUE_HERE"));
  if (missing) {
    throw new Error("Firebase is not configured yet. Open firebase-config.js and paste your Firebase web app config.");
  }
}

function showError(message) {
  setupError.textContent = message;
}

function cleanError(err) {
  const message = err?.message || String(err);
  if (message.includes("permission_denied")) {
    return "Firebase permission denied. Enable Anonymous Auth and check your Realtime Database rules.";
  }
  if (message.includes("auth/configuration-not-found")) {
    return "Firebase Anonymous Auth is not enabled yet.";
  }
  return message;
}
