'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const CONSENSUS_THRESHOLD = 0.7; // 70 % de la classe
const DEBATE_SEC = 30;
const CAPTAIN_SEC = 20;
const ACCUSE_SEC = 60;
const MAX_PLAYERS = 40;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // une partie inactive 3 h est supprimée

const MODES = [
  { id: 'majorite', name: 'Majorité', desc: "Chacun vote en secret. La réponse la plus votée devient celle de la classe." },
  { id: 'deuxtours', name: 'Deux tours', desc: "Premier vote en secret, on affiche la répartition, 30 s de débat, puis on revote." },
  { id: 'capitaine', name: 'Capitaine', desc: "Tout le monde vote, puis un capitaine tiré au sort voit les votes et décide seul pour la classe." },
  { id: 'consensus', name: 'Consensus', desc: "Votes visibles et modifiables. La réponse passe dès que 70 % de la classe est d'accord. Pas d'accord à la fin du chrono : −1 point." },
  { id: 'direct', name: 'Vote en direct', desc: "Les votes s'affichent en temps réel et restent modifiables jusqu'à la fin du chrono. La majorité l'emporte." },
  { id: 'confiance', name: 'Mise de confiance', desc: "Chacun vote et mise 1, 2 ou 3 selon sa certitude. Les votes comptent selon la mise." },
  { id: 'reputation', name: 'Réputation', desc: "Chaque bonne réponse donne +1 de poids à ton vote pour la suite. Ceux qui ont souvent raison pèsent plus." },
  { id: 'imposteur', name: 'Imposteur', desc: "Un imposteur secret (deux à partir de 15 joueurs) voit la bonne réponse et veut faire perdre la classe. Deux tours avec débat, puis la classe désigne l'imposteur." },
];
const MODE_IDS = new Set(MODES.map(m => m.id));
const LIVE_MODES = new Set(['direct', 'consensus']);
const TWO_ROUND_MODES = new Set(['deuxtours', 'imposteur']);

// ---------- Questions ----------
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'))
  .filter(q => q && q.cat && q.q && Array.isArray(q.choices) && q.choices.length === 4 && Number.isInteger(q.a) && q.a >= 0 && q.a < 4)
  .map(q => Object.assign({ lvl: 'college' }, q));
const CATEGORIES = [...new Set(QUESTIONS.map(q => q.cat))];
const LEVELS = [
  { id: 'college', name: 'Collège' },
  { id: 'lycee', name: 'Lycée' },
  { id: 'adultes', name: 'Adultes' },
];
const LEVEL_IDS = LEVELS.map(l => l.id);

// ---------- Serveur ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/api/meta', (req, res) => res.json({
  modes: MODES,
  levels: LEVELS,
  // nombre de questions par catégorie et par niveau
  categories: CATEGORIES.map(c => {
    const counts = {};
    for (const l of LEVEL_IDS) counts[l] = QUESTIONS.filter(q => q.cat === c && q.lvl === l).length;
    return { name: c, counts };
  }),
}));
app.get('/health', (req, res) => res.send('ok'));
// QR code vers la page élève, généré ici (pas de dépendance à un CDN bloqué par le réseau du collège)
app.get('/qr/:code', async (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  try {
    const png = await QRCode.toBuffer(`${proto}://${req.get('host')}/?code=${code}`, { width: 260, margin: 1 });
    res.type('png').send(png);
  } catch (e) { res.status(500).end(); }
});

// ---------- Utilitaires ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(c));
  return c;
}
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function randomId() { return crypto.randomBytes(8).toString('hex'); }

function sanitizeSettings(s) {
  s = s || {};
  const mode = MODE_IDS.has(s.mode) ? s.mode : 'majorite';
  let cats = Array.isArray(s.cats) ? s.cats.filter(c => CATEGORIES.includes(c)) : [];
  if (!cats.length) cats = CATEGORIES.slice();
  let levels = Array.isArray(s.levels) ? s.levels.filter(l => LEVEL_IDS.includes(l)) : [];
  if (!levels.length) levels = ['college'];
  return { mode, cats, levels, nb: clampInt(s.nb, 3, 60, 10), timer: clampInt(s.timer, 10, 120, 30) };
}

function pickQuestions(cats, levels, nb) {
  return shuffle(QUESTIONS.filter(q => cats.includes(q.cat) && levels.includes(q.lvl))).slice(0, nb).map(q => {
    const order = shuffle([0, 1, 2, 3]);
    return { cat: q.cat, q: q.q, choices: order.map(i => q.choices[i]), a: order.indexOf(q.a) };
  });
}

function nameOf(room, id) { const p = room.players.get(id); return p ? p.name : '?'; }
function connectedPlayers(room) { return [...room.players.values()].filter(p => p.connected); }
function currentQ(room) { return room.questions[room.qIndex]; }

function counts(room, onlyConnected) {
  const c = [0, 0, 0, 0];
  for (const [pid, v] of room.votes) {
    if (onlyConnected) { const p = room.players.get(pid); if (!p || !p.connected) continue; }
    c[v.choice]++;
  }
  return c;
}
function weightedCounts(room) {
  const mode = room.settings.mode;
  const w = [0, 0, 0, 0];
  for (const [pid, v] of room.votes) {
    let weight = 1;
    if (mode === 'confiance') weight = v.conf || 1;
    else if (mode === 'reputation') { const p = room.players.get(pid); weight = p ? p.weight : 1; }
    w[v.choice] += weight;
  }
  return w;
}
// Réponse retenue (égalité : tirage au sort parmi les ex-aequo). null si personne n'a voté.
function tally(room) {
  const w = weightedCounts(room);
  const max = Math.max(...w);
  if (max <= 0) return null;
  const top = [0, 1, 2, 3].filter(i => w[i] === max);
  return top[Math.floor(Math.random() * top.length)];
}

// ---------- Cycle de jeu ----------
function clearTimer(room) {
  if (room.timeout) clearTimeout(room.timeout);
  room.timeout = null;
}

function resetGame(room) {
  clearTimer(room);
  room.questions = pickQuestions(room.settings.cats, room.settings.levels, room.settings.nb);
  room.qIndex = -1;
  room.phase = 'lobby';
  room.votes = new Map();
  room.round1 = null;
  room.captainId = null;
  room.captainQueue = [];
  room.timerEnd = null;
  room.score = 0;
  room.results = [];
  room.result = null;
  room.accusations = new Map();
  room.impostorResult = null;
  // on retire les joueurs déconnectés entre deux parties
  for (const [id, p] of room.players) {
    if (!p.connected) room.players.delete(id);
    else { p.isImpostor = false; p.weight = 1; }
  }
}

function createRoom(hostSocketId, settings) {
  const room = {
    code: newCode(),
    hostKey: crypto.randomBytes(12).toString('hex'),
    hostSocket: hostSocketId,
    settings,
    players: new Map(),
    lastActivity: Date.now(),
  };
  resetGame(room);
  rooms.set(room.code, room);
  return room;
}

function setPhase(room, phase, secs) {
  clearTimer(room);
  room.phase = phase;
  room.timerEnd = secs ? Date.now() + secs * 1000 : null;
  if (secs) room.timeout = setTimeout(() => advance(room), secs * 1000);
  broadcast(room);
}

function startGame(room) {
  if (room.phase !== 'lobby') return;
  const present = connectedPlayers(room);
  if (!present.length || !room.questions.length) return;
  if (room.settings.mode === 'imposteur' && present.length >= 3) {
    const n = present.length >= 15 ? 2 : 1;
    shuffle(present).slice(0, n).forEach(p => { p.isImpostor = true; });
  }
  nextQuestion(room);
}

function nextQuestion(room) {
  room.qIndex++;
  room.votes = new Map();
  room.round1 = null;
  room.captainId = null;
  room.result = null;
  if (room.qIndex >= room.questions.length) {
    const hasImp = [...room.players.values()].some(p => p.isImpostor);
    if (room.settings.mode === 'imposteur' && hasImp) {
      room.accusations = new Map();
      setPhase(room, 'accuse', ACCUSE_SEC);
    } else {
      setPhase(room, 'end', 0);
    }
    return;
  }
  setPhase(room, 'vote', room.settings.timer);
}

function pickCaptain(room) {
  for (let tries = 0; tries < 2; tries++) {
    while (room.captainQueue.length) {
      const p = room.players.get(room.captainQueue.shift());
      if (p && p.connected) return p;
    }
    room.captainQueue = shuffle(connectedPlayers(room).map(p => p.id));
  }
  return null;
}

// Fin de la phase en cours (chrono écoulé, tout le monde a voté, ou le prof passe)
function advance(room) {
  const mode = room.settings.mode;
  switch (room.phase) {
    case 'vote':
      if (TWO_ROUND_MODES.has(mode)) {
        room.round1 = counts(room);
        room.votes = new Map();
        setPhase(room, 'debate', DEBATE_SEC);
      } else if (mode === 'capitaine') {
        const cap = pickCaptain(room);
        if (cap) { room.captainId = cap.id; setPhase(room, 'captain', CAPTAIN_SEC); }
        else resolve(room, tally(room), {});
      } else if (mode === 'consensus') {
        resolve(room, null, { noConsensus: true });
      } else {
        resolve(room, tally(room), {});
      }
      break;
    case 'debate':
      setPhase(room, 'vote2', room.settings.timer);
      break;
    case 'vote2':
      resolve(room, tally(room), {});
      break;
    case 'captain':
      resolve(room, tally(room), { captainTimeout: true });
      break;
    case 'accuse':
      endAccuse(room);
      break;
    default:
      break;
  }
}

function resolve(room, answer, opts) {
  const q = currentQ(room);
  const correct = answer !== null && answer === q.a;
  let delta = correct ? 1 : 0;
  if (opts.noConsensus) delta = -1;
  room.score += delta;

  const weighted = (room.settings.mode === 'confiance' || room.settings.mode === 'reputation') ? weightedCounts(room) : null;
  if (room.settings.mode === 'reputation') {
    for (const [pid, v] of room.votes) {
      const p = room.players.get(pid);
      if (p && v.choice === q.a) p.weight += 1;
    }
  }
  room.result = {
    answer,
    correctIndex: q.a,
    correct,
    delta,
    counts: counts(room),
    weighted,
    round1: room.round1,
    noConsensus: !!opts.noConsensus,
    consensus: !!opts.consensus,
    captainName: room.captainId ? nameOf(room, room.captainId) : null,
    captainTimeout: !!opts.captainTimeout,
  };
  room.results.push({
    q: q.q,
    answer: answer === null ? null : q.choices[answer],
    good: q.choices[q.a],
    correct,
    delta,
  });
  setPhase(room, 'reveal', 0);
}

function endAccuse(room) {
  const t = new Map();
  for (const target of room.accusations.values()) t.set(target, (t.get(target) || 0) + 1);
  let max = 0;
  for (const v of t.values()) max = Math.max(max, v);
  const top = [...t.entries()].filter(([, v]) => v === max && max > 0).map(([k]) => k);
  let accusedName = null, found = false, tie = false;
  if (top.length === 1) {
    accusedName = nameOf(room, top[0]);
    const p = room.players.get(top[0]);
    found = !!(p && p.isImpostor);
  } else if (top.length > 1) tie = true;
  room.impostorResult = {
    accusedName,
    found,
    tie,
    impostors: [...room.players.values()].filter(p => p.isImpostor).map(p => p.name),
    ranking: [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => ({ name: nameOf(room, id), votes: v })),
  };
  setPhase(room, 'end', 0);
}

function checkEarlyEnd(room) {
  const present = connectedPlayers(room);
  if (!present.length) return;
  if ((room.phase === 'vote' || room.phase === 'vote2') && !LIVE_MODES.has(room.settings.mode)) {
    if (present.every(p => room.votes.has(p.id))) advance(room);
  } else if (room.phase === 'accuse') {
    if (present.every(p => room.accusations.has(p.id))) advance(room);
  }
}

function checkConsensus(room) {
  if (room.settings.mode !== 'consensus' || room.phase !== 'vote') return false;
  const n = connectedPlayers(room).length;
  if (!n) return false;
  const c = counts(room, true);
  const max = Math.max(...c);
  if (max / n >= CONSENSUS_THRESHOLD) {
    resolve(room, c.indexOf(max), { consensus: true });
    return true;
  }
  return false;
}

// ---------- Vues envoyées aux clients ----------
function publicQuestion(room) {
  const q = currentQ(room);
  if (!q || ['lobby', 'accuse', 'end'].includes(room.phase)) return null;
  return { cat: q.cat, q: q.q, choices: q.choices };
}

function baseView(room) {
  const present = connectedPlayers(room);
  const liveVisible = (LIVE_MODES.has(room.settings.mode) && room.phase === 'vote') || room.phase === 'captain';
  return {
    code: room.code,
    now: Date.now(),
    phase: room.phase,
    mode: MODES.find(m => m.id === room.settings.mode),
    timer: room.settings.timer,
    qIndex: room.qIndex,
    total: room.questions.length,
    question: publicQuestion(room),
    timerEnd: room.timerEnd,
    votedCount: room.phase === 'accuse'
      ? present.filter(p => room.accusations.has(p.id)).length
      : present.filter(p => room.votes.has(p.id)).length,
    connectedCount: present.length,
    live: liveVisible ? counts(room) : null,
    round1: room.round1,
    captainName: room.captainId ? nameOf(room, room.captainId) : null,
    result: room.phase === 'reveal' ? room.result : null,
    score: room.score,
    results: room.phase === 'end' ? room.results : null,
    impostorResult: room.phase === 'end' ? room.impostorResult : null,
    impostorCount: [...room.players.values()].filter(p => p.isImpostor).length,
    threshold: CONSENSUS_THRESHOLD,
  };
}

function hostView(room) {
  const v = baseView(room);
  v.role = 'host';
  v.settings = room.settings;
  v.players = [...room.players.values()].map(p => ({
    name: p.name,
    connected: p.connected,
    voted: room.phase === 'accuse' ? room.accusations.has(p.id) : room.votes.has(p.id),
    weight: p.weight,
  }));
  return v;
}

function playerView(room, p) {
  const v = baseView(room);
  v.role = 'player';
  v.me = { id: p.id, name: p.name, isImpostor: p.isImpostor, weight: p.weight };
  v.myVote = room.votes.get(p.id) || null;
  v.isCaptain = room.phase === 'captain' && room.captainId === p.id;
  const q = currentQ(room);
  if (p.isImpostor && q && ['vote', 'debate', 'vote2', 'captain'].includes(room.phase)) v.secret = q.a;
  if (room.phase === 'accuse') {
    v.accuseTargets = [...room.players.values()].filter(x => x.id !== p.id).map(x => ({ id: x.id, name: x.name }));
    v.myAccuse = room.accusations.get(p.id) || null;
  }
  return v;
}

function broadcast(room) {
  room.lastActivity = Date.now();
  if (room.hostSocket) io.to(room.hostSocket).emit('state', hostView(room));
  for (const p of room.players.values()) {
    if (p.connected) io.to(p.socketId).emit('state', playerView(room, p));
  }
}

// ---------- Sockets ----------
io.on('connection', socket => {
  const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };

  function hostRoom() {
    const r = rooms.get(socket.data.code);
    if (r && socket.data.host && r.hostSocket === socket.id) { r.lastActivity = Date.now(); return r; }
    return null;
  }
  function playerCtx() {
    const r = rooms.get(socket.data.code);
    if (!r) return null;
    const p = r.players.get(socket.data.pid);
    if (!p || p.socketId !== socket.id) return null;
    r.lastActivity = Date.now();
    return { r, p };
  }

  // --- Prof ---
  socket.on('host:create', (settings, cb) => {
    const room = createRoom(socket.id, sanitizeSettings(settings));
    socket.data.code = room.code;
    socket.data.host = true;
    reply(cb, { ok: true, code: room.code, hostKey: room.hostKey });
    broadcast(room);
  });

  socket.on('host:resume', (d, cb) => {
    const r = rooms.get(String((d && d.code) || '').toUpperCase());
    if (!r || r.hostKey !== (d && d.hostKey)) return reply(cb, { ok: false });
    r.hostSocket = socket.id;
    socket.data.code = r.code;
    socket.data.host = true;
    reply(cb, { ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('host:start', () => { const r = hostRoom(); if (r) startGame(r); });

  socket.on('host:skip', () => {
    const r = hostRoom();
    if (r && ['vote', 'vote2', 'debate', 'captain', 'accuse'].includes(r.phase)) advance(r);
  });

  socket.on('host:next', () => { const r = hostRoom(); if (r && r.phase === 'reveal') nextQuestion(r); });

  // Nouvelle partie avec les mêmes joueurs (réglages modifiables)
  socket.on('host:restart', settings => {
    const r = hostRoom();
    if (!r) return;
    if (settings) r.settings = sanitizeSettings(Object.assign({}, r.settings, settings));
    resetGame(r);
    broadcast(r);
  });

  socket.on('host:kick', name => {
    const r = hostRoom();
    if (!r || r.phase !== 'lobby') return;
    for (const [id, p] of r.players) {
      if (p.name === name) {
        r.players.delete(id);
        if (p.connected) io.to(p.socketId).emit('kicked');
      }
    }
    broadcast(r);
  });

  // --- Élèves ---
  socket.on('player:join', (d, cb) => {
    d = d || {};
    const code = String(d.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply(cb, { ok: false, error: 'Partie introuvable. Vérifie le code.' });

    let p = d.pid ? room.players.get(String(d.pid)) : null;
    if (p) {
      p.socketId = socket.id;
      p.connected = true;
    } else {
      const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      if (!name) return reply(cb, { ok: false, error: 'Choisis un pseudo.' });
      if (room.players.size >= MAX_PLAYERS) return reply(cb, { ok: false, error: 'La partie est pleine.' });
      const taken = new Set([...room.players.values()].map(x => x.name.toLowerCase()));
      let finalName = name, n = 2;
      while (taken.has(finalName.toLowerCase())) finalName = `${name} ${n++}`;
      p = { id: randomId(), name: finalName, socketId: socket.id, connected: true, isImpostor: false, weight: 1 };
      room.players.set(p.id, p);
    }
    socket.data.code = code;
    socket.data.pid = p.id;
    reply(cb, { ok: true, pid: p.id, code });
    broadcast(room);
  });

  socket.on('player:vote', d => {
    const c = playerCtx();
    if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'vote' && r.phase !== 'vote2') return;
    const choice = Number(d && d.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    const conf = r.settings.mode === 'confiance' ? clampInt(d.conf, 1, 3, 1) : 1;
    r.votes.set(p.id, { choice, conf });
    if (checkConsensus(r)) return;
    broadcast(r);
    checkEarlyEnd(r);
  });

  socket.on('player:captain', d => {
    const c = playerCtx();
    if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'captain' || r.captainId !== p.id) return;
    const choice = Number(d && d.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    resolve(r, choice, {});
  });

  socket.on('player:accuse', d => {
    const c = playerCtx();
    if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'accuse') return;
    const target = String((d && d.target) || '');
    if (target === p.id || !r.players.has(target)) return;
    r.accusations.set(p.id, target);
    broadcast(r);
    checkEarlyEnd(r);
  });

  socket.on('disconnect', () => {
    const r = rooms.get(socket.data.code);
    if (!r) return;
    if (socket.data.host && r.hostSocket === socket.id) { r.hostSocket = null; return; }
    const p = r.players.get(socket.data.pid);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      broadcast(r);
      checkEarlyEnd(r);
    }
  });
});

// Ménage des parties abandonnées
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.lastActivity > ROOM_TTL_MS) { clearTimer(r); rooms.delete(code); }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Quorum sur le port ${PORT}`));
