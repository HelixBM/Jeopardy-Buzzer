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

const setup = $("setup");
const game = $("game");
const teacherSetup = $("teacherSetup");
const studentSetup = $("studentSetup");
const teacherNameInput = $("teacherNameInput");
const createRoomBtn = $("createRoomBtn");
const roomInput = $("roomInput");
const nameInput = $("nameInput");
const joinBtn = $("joinBtn");
const setupError = $("setupError");

const roomTitle = $("roomTitle");
const copyLinkBtn = $("copyLinkBtn");
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

const STORAGE_KEY = "classroom-buzzer-settings";
const savedSettings = readSettings();

const params = new URLSearchParams(location.search);
const initialRoom = normalizeRoom(params.get("room") || "");
const initialHost = params.get("host") === "1";
if (initialRoom) roomInput.value = initialRoom;
if (params.get("name")) nameInput.value = params.get("name");
else if (savedSettings.name) nameInput.value = savedSettings.name;

if (savedSettings.teacherName) teacherNameInput.value = savedSettings.teacherName;
else if (initialHost && params.get("name")) teacherNameInput.value = params.get("name");

if (initialRoom && initialHost) {
  hostRoomToRejoin = initialRoom;
  teacherSetup.querySelector("h2").textContent = `Rejoin room ${initialRoom}`;
  createRoomBtn.textContent = "Rejoin as teacher";
} else if (initialRoom) {
  studentSetup.scrollIntoView({ block: "start" });
  nameInput.focus();
}

createRoomBtn.addEventListener("click", createRoom);
joinBtn.addEventListener("click", joinRoom);
buzzBtn.addEventListener("click", buzz);
resetBtn.addEventListener("click", resetBuzzer);
lockBtn.addEventListener("click", lockWithoutWinner);
clearBtn.addEventListener("click", clearRoom);
copyLinkBtn.addEventListener("click", copyPlayerLink);
leaveBtn.addEventListener("click", leaveRoom);
roomInput.addEventListener("input", () => {
  const cursor = roomInput.selectionStart;
  roomInput.value = normalizeRoom(roomInput.value);
  roomInput.setSelectionRange(cursor, cursor);
});

for (const input of [roomInput, nameInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });
}

teacherNameInput.addEventListener("keydown", (event) => {
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

async function createRoom() {
  if (createRoomBtn.disabled) return;

  setupError.textContent = "";

  roomCode = hostRoomToRejoin || makeRoomCode();
  playerName = teacherNameInput.value.trim() || "Teacher";
  role = "host";

  createRoomBtn.disabled = true;
  createRoomBtn.textContent = hostRoomToRejoin ? "Rejoining..." : "Creating...";

  try {
    await initializeFirebaseSession();
    await runTransaction(ref(db, `rooms/${roomCode}/state`), (oldState) => {
      if (oldState) return oldState;
      return {
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
    saveSettings({ name: savedSettings.name || "", teacherName: playerName });
  } catch (err) {
    console.error(err);
    showError(cleanError(err));
  } finally {
    createRoomBtn.disabled = false;
    createRoomBtn.textContent = hostRoomToRejoin ? "Rejoin as teacher" : "Create room";
  }
}

async function joinRoom() {
  if (joinBtn.disabled) return;

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
    if (!roomState.exists()) {
      throw new Error("Room not found. Check the code with your teacher.");
    }

    await registerPresence();

    enterGame();
    subscribe();
    saveSettings({ ...savedSettings, name: playerName });
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
  buzzBtn.disabled = role === "host";
  buzzBtn.textContent = role === "host" ? "HOST" : "BUZZ";
  updateUrl();
  renderSummary();
}

function subscribe() {
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

async function buzz() {
  if (!db || !roomCode || !uid || !playerName || role === "host") return;
  buzzBtn.disabled = true;
  buzzBtn.textContent = "WAIT";

  try {
    const result = await runTransaction(ref(db, `rooms/${roomCode}/state`), (oldState) => {
      const nextState = oldState || {
        locked: false,
        winner: null,
        round: 1,
        startedAt: serverTimestamp()
      };

      if (nextState.locked) return; // Abort: someone already buzzed.

      return {
        ...nextState,
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
  await update(ref(db, `rooms/${roomCode}/state`), {
    locked: false,
    winner: null,
    round: increment(1),
    startedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

async function lockWithoutWinner() {
  await update(ref(db, `rooms/${roomCode}/state`), {
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
  location.href = location.pathname;
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
    location.href = location.pathname;
  }
}

function renderState() {
  if (!state) {
    statusText.textContent = "Connecting…";
    statusBox.className = "status waiting";
    buzzBtn.disabled = true;
    buzzBtn.textContent = role === "host" ? "HOST" : "BUZZ";
    renderSummary();
    return;
  }

  currentRound = state.round || 1;
  renderSummary();

  if (state.locked) {
    const winner = state.winner?.name || "Someone";
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
}

function renderPlayers(players) {
  const rows = Object.values(players)
    .sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));

  playersList.innerHTML = "";
  playerCount = rows.length;
  onlineCount = rows.filter((player) => player.online).length;
  renderSummary();

  if (!rows.length) {
    playersList.innerHTML = "<li>No players yet.</li>";
    return;
  }

  for (const player of rows) {
    const li = document.createElement("li");
    li.className = player.online ? "online" : "offline";
    li.textContent = `${player.name}${player.role === "host" ? " — host" : ""}${player.online ? "" : " — offline"}`;
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
  const url = new URL(location.href);
  url.searchParams.set("room", roomCode);
  url.searchParams.delete("host");
  url.searchParams.delete("name");

  try {
    await copyText(url.toString());
    copyStatus.textContent = "Player link copied.";
    copyLinkBtn.textContent = "Copied";
  } catch (err) {
    console.error(err);
    copyStatus.textContent = url.toString();
    copyLinkBtn.textContent = "Copy failed";
  }

  setTimeout(() => {
    copyStatus.textContent = "";
    copyLinkBtn.textContent = "Copy player link";
  }, 1800);
}

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set("room", roomCode);
  if (role === "host") {
    url.searchParams.set("host", "1");
    url.searchParams.set("name", playerName);
  } else {
    url.searchParams.delete("host");
    url.searchParams.delete("name");
  }
  history.replaceState(null, "", url);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
