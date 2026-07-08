import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
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
const roomInput = $("roomInput");
const nameInput = $("nameInput");
const joinBtn = $("joinBtn");
const makeRoomBtn = $("makeRoomBtn");
const setupError = $("setupError");

const roomTitle = $("roomTitle");
const copyLinkBtn = $("copyLinkBtn");
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

const params = new URLSearchParams(location.search);
if (params.get("room")) roomInput.value = params.get("room").toUpperCase();
if (params.get("name")) nameInput.value = params.get("name");
if (params.get("host") === "1") {
  document.querySelector('input[name="role"][value="host"]').checked = true;
}

makeRoomBtn.addEventListener("click", () => {
  roomInput.value = makeRoomCode();
});

joinBtn.addEventListener("click", joinRoom);
buzzBtn.addEventListener("click", buzz);
resetBtn.addEventListener("click", resetBuzzer);
lockBtn.addEventListener("click", lockWithoutWinner);
clearBtn.addEventListener("click", clearRoom);
copyLinkBtn.addEventListener("click", copyPlayerLink);
leaveBtn.addEventListener("click", () => location.href = location.pathname);

window.addEventListener("beforeunload", () => {
  if (db && roomCode && uid) {
    update(ref(db, `rooms/${roomCode}/players/${uid}`), {
      online: false,
      lastSeen: serverTimestamp()
    });
  }
});

async function joinRoom() {
  setupError.textContent = "";

  roomCode = normalizeRoom(roomInput.value);
  playerName = nameInput.value.trim();
  role = document.querySelector('input[name="role"]:checked').value;

  if (!roomCode) return showError("Enter a room code.");
  if (!playerName) return showError("Enter your name or team name.");

  try {
    ensureFirebaseConfig();
    app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    auth = getAuth(app);

    const cred = await signInAnonymously(auth);
    uid = cred.user.uid;

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

    enterGame();
    subscribe();
  } catch (err) {
    console.error(err);
    showError(cleanError(err));
  }
}

function enterGame() {
  setup.classList.add("hidden");
  game.classList.remove("hidden");
  roomTitle.textContent = roomCode;
  hostControls.classList.toggle("hidden", role !== "host");
  buzzBtn.disabled = role === "host";
  updateUrl();
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

function renderState() {
  if (!state) {
    statusText.textContent = "Connecting…";
    statusBox.className = "status waiting";
    buzzBtn.disabled = true;
    return;
  }

  if (state.locked) {
    const winner = state.winner?.name || "Someone";
    statusText.textContent = `${winner} buzzed first.`;
    statusBox.className = "status locked";
    buzzBtn.disabled = true;
  } else {
    statusText.textContent = role === "host" ? "Ready for the next question." : "Ready. Buzz now!";
    statusBox.className = "status ready";
    buzzBtn.disabled = role === "host";
  }
}

function renderPlayers(players) {
  const rows = Object.values(players)
    .sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));

  playersList.innerHTML = "";

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

  await navigator.clipboard.writeText(url.toString());
  copyLinkBtn.textContent = "Copied!";
  setTimeout(() => copyLinkBtn.textContent = "Copy player link", 1200);
}

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set("room", roomCode);
  url.searchParams.set("name", playerName);
  if (role === "host") url.searchParams.set("host", "1");
  else url.searchParams.delete("host");
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
