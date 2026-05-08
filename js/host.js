// =====================================================
// ياللي - Host Logic
// -----------------------------------------------------
// يدير شاشة الهوست: Lobby → Writing → Voting → Results → Finished
// =====================================================

import {
  initFirebase, ensureSignedIn, generateRoomCode, getQueryParam,
  createRoom, listenRoom, setRoomState, startNextRound,
  tallyAndCloseRound, finishGame, fetchRandomGif, showToast,
  escapeHtml, randomWaitingMessage, randomWinnerTagline,
  STATES,
} from './game-logic.js';

const $ = (id) => document.getElementById(id);

// =====================================================
// State
// =====================================================
let roomCode = null;
let myUid    = null;
let unsubRoom = null;
let lastState = null;
let currentRoundQid = null; // علشان نمنع تكرار جلب الـ GIF لنفس الجولة
let funnyMsgTimer = null;
let lastWinnerUid = null;

// =====================================================
// Init
// =====================================================
(async function init() {
  roomCode = (getQueryParam('room') || '').toUpperCase();

  if (!roomCode || roomCode.length !== 6) {
    showToast('كود الغرفة مو صحيح', 'error');
    setTimeout(() => location.href = 'index.html', 1500);
    return;
  }

  initFirebase();

  try {
    myUid = await ensureSignedIn();
  } catch (err) {
    showToast('مشكلة في الاتصال - أعد المحاولة', 'error');
    return;
  }

  // عرض شاشة إدخال الاسم للهوست
  $('screen-name').classList.remove('hidden');
  $('host-name-input').focus();

  $('host-name-go').addEventListener('click', startHosting);
  $('host-name-input').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') startHosting();
  });
})();

async function startHosting() {
  const name = $('host-name-input').value.trim();
  if (name.length < 2) {
    showToast('اكتب اسمك يا شيخ', 'error');
    return;
  }

  $('host-name-go').disabled = true;
  $('host-name-go').innerHTML = '<span class="spinner"></span>';

  try {
    await createRoom(roomCode, myUid, name);
  } catch (err) {
    console.error(err);
    showToast('فشل إنشاء الغرفة - حاول مرة ثانية', 'error');
    $('host-name-go').disabled = false;
    $('host-name-go').innerHTML = 'دخول';
    return;
  }

  $('screen-name').classList.add('hidden');
  setupLobbyUI();
  startListeningToRoom();
}

// =====================================================
// Lobby setup (room code, QR)
// =====================================================
function setupLobbyUI() {
  $('screen-lobby').classList.remove('hidden');
  $('room-code-big').textContent = roomCode;

  // QR code يوصل لـ index.html?room=XXX (فيه يدخل الكود لقد ما يجيه)
  // أو نوصله مباشرة لشاشة player.html بس يحتاج اسم - نخليه يدخل الكود يدوياً
  const playerUrl = `${location.origin}${location.pathname.replace('host.html', 'index.html')}?room=${roomCode}`;
  try {
    $('qr-container').innerHTML = '';
    new QRCode($('qr-container'), {
      text: playerUrl,
      width: 160,
      height: 160,
      colorDark: '#0F0F1E',
      colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (err) {
    console.warn('QR generation failed', err);
  }

  // عرض الدومين
  $('link-domain').textContent = location.host;

  // نسخ الكود
  $('btn-copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      showToast('انتسخ الكود', 'success');
    } catch {
      showToast('ما قدرت أنسخه — انسخه يدوياً', 'error');
    }
  });

  $('btn-start-game').addEventListener('click', () => {
    setRoomState(roomCode, STATES.WRITING).catch(console.error);
  });

  $('btn-start-voting').addEventListener('click', startVotingRound);
  $('btn-reveal').addEventListener('click', revealRound);
  $('btn-next-q').addEventListener('click', startVotingRound);
  $('btn-end-game').addEventListener('click', () => finishGame(roomCode).catch(console.error));
}

// =====================================================
// Real-time listener
// =====================================================
function startListeningToRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = listenRoom(roomCode, (room) => {
    if (!room) {
      showToast('الغرفة انحذفت', 'error');
      return;
    }
    renderRoom(room);
  });
}

// =====================================================
// Render based on state
// =====================================================
function renderRoom(room) {
  const state = room.state;
  $('state-label').textContent = stateToArabic(state);

  // عرض الشاشة الصحيحة
  if (state !== lastState) {
    ['lobby','writing','voting','results','finished'].forEach((s) => {
      $(`screen-${s}`).classList.toggle('hidden', s !== state);
    });
    lastState = state;
  }

  switch (state) {
    case STATES.LOBBY:    renderLobby(room); break;
    case STATES.WRITING:  renderWriting(room); break;
    case STATES.VOTING:   renderVoting(room); break;
    case STATES.RESULTS:  renderResults(room); break;
    case STATES.FINISHED: renderFinished(room); break;
  }
}

function stateToArabic(s) {
  return ({
    lobby: 'الانتظار',
    writing: 'كتابة الأسئلة',
    voting: 'التصويت',
    results: 'النتيجة',
    finished: 'انتهت',
  })[s] || s;
}

// =====================================================
// LOBBY
// =====================================================
function renderLobby(room) {
  const players = playersArray(room);
  $('player-count').textContent = players.length;

  const list = $('lobby-players');
  list.innerHTML = players.length
    ? players.map((p, i) => `
        <div class="slide-in-right flex items-center gap-3 p-3 glass rounded-xl" style="animation-delay:${i*60}ms">
          <span class="status-dot ${p.isHost ? 'host' : 'done'}"></span>
          <span class="font-bold flex-1">${escapeHtml(p.name)}</span>
          ${p.isHost ? '<span class="text-xs text-muted">(الهوست)</span>' : ''}
        </div>
      `).join('')
    : '<p class="text-center text-muted py-12">يبيلهم يدخلون...</p>';

  $('btn-start-game').disabled = players.length < 2;
}

// =====================================================
// WRITING
// =====================================================
function renderWriting(room) {
  const players = playersArray(room);
  const done = players.filter((p) => p.finishedWriting).length;
  const total = players.length;

  $('writing-done').textContent = done;
  $('writing-total').textContent = total;
  $('writing-progress').style.width = total ? `${(done/total)*100}%` : '0%';

  $('writing-players').innerHTML = players.map((p) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl">
      <span class="status-dot ${p.finishedWriting ? 'done' : ''}"></span>
      <span class="font-bold flex-1 truncate">${escapeHtml(p.name)}</span>
    </div>
  `).join('');

  $('btn-start-voting').disabled = !(total >= 2 && done === total);

  // رسالة عشوائية تتجدد كل 4 ثواني
  if (!funnyMsgTimer) {
    $('writing-funny-msg').textContent = randomWaitingMessage();
    funnyMsgTimer = setInterval(() => {
      $('writing-funny-msg').textContent = randomWaitingMessage();
    }, 4000);
  }
}

async function startVotingRound() {
  $('btn-start-voting').disabled = true;
  $('btn-next-q').disabled = true;

  if (funnyMsgTimer) { clearInterval(funnyMsgTimer); funnyMsgTimer = null; }

  try {
    const result = await startNextRound(roomCode);
    if (!result) {
      // ما في أسئلة - أنهِ اللعبة
      showToast('خلّصت كل الأسئلة', 'success');
      await finishGame(roomCode);
    }
  } catch (err) {
    console.error(err);
    showToast('فشل بدء الجولة', 'error');
    $('btn-start-voting').disabled = false;
    $('btn-next-q').disabled = false;
  }
}

// =====================================================
// VOTING
// =====================================================
function renderVoting(room) {
  const round = room.currentRound;
  if (!round) return;

  const players = playersArray(room);
  const votes = round.votes || {};
  const voted = Object.keys(votes).length;
  const total = players.length;

  $('voting-question').textContent = round.questionText;
  $('voting-done').textContent = voted;
  $('voting-total').textContent = total;
  $('voting-progress').style.width = total ? `${(voted/total)*100}%` : '0%';

  $('voting-players-status').innerHTML = players.map((p) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl">
      <span class="status-dot ${votes[p.uid] ? 'done' : ''}"></span>
      <span class="font-bold flex-1 truncate">${escapeHtml(p.name)}</span>
    </div>
  `).join('');

  $('btn-reveal').disabled = !(voted === total && total >= 2);
}

async function revealRound() {
  $('btn-reveal').disabled = true;
  try {
    await tallyAndCloseRound(roomCode);
  } catch (err) {
    console.error(err);
    showToast('فشل عرض النتيجة', 'error');
    $('btn-reveal').disabled = false;
  }
}

// =====================================================
// RESULTS
// =====================================================
async function renderResults(room) {
  const round = room.currentRound;
  if (!round) return;

  const players = playersArray(room);
  const winnerUid = round.winnerUid;
  const winner = players.find((p) => p.uid === winnerUid);
  const tally = round.tally || {};

  $('results-tagline').textContent = randomWinnerTagline();
  $('winner-name').textContent = winner ? winner.name : 'ما حد فاز';
  $('winner-votes').textContent = winnerUid ? (tally[winnerUid] || 0) : 0;

  // mini board (مرتب)
  const sorted = [...players].sort((a, b) => b.score - a.score);
  $('mini-board').innerHTML = sorted.map((p, i) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl">
      <span class="rank-pill rank-${i+1}">${arabicDigit(i+1)}</span>
      <span class="font-bold flex-1 text-right">${escapeHtml(p.name)}</span>
      <span class="score-badge">${p.score}</span>
    </div>
  `).join('');

  // تحقق إذا في أسئلة باقية
  const remainingQs = await countUnusedQuestions(room);
  if (remainingQs === 0) {
    $('btn-next-q').classList.add('hidden');
    $('btn-end-game').textContent = 'الفايز النهائي';
  } else {
    $('btn-next-q').classList.remove('hidden');
    $('btn-next-q').disabled = false;
    $('btn-end-game').textContent = 'إنهاء اللعبة';
  }

  // Confetti + GIF (مرة واحدة لكل جولة)
  if (round.questionId !== currentRoundQid) {
    currentRoundQid = round.questionId;
    lastWinnerUid = winnerUid;

    if (typeof confetti === 'function') {
      confetti({ particleCount: 150, spread: 90, origin: { y: 0.5 }, colors: ['#FFD700', '#E94560', '#00D9A3'] });
    }

    // جلب GIF
    $('gif-container').innerHTML = '<div class="spinner"></div>';
    const gifUrl = await fetchRandomGif('celebration');
    if (gifUrl) {
      $('gif-container').innerHTML = `<img src="${gifUrl}" alt="celebration" class="max-h-72 mx-auto" />`;
    } else {
      $('gif-container').innerHTML = '<div class="winner-divider"></div>';
    }
  }
}

// =====================================================
// FINISHED
// =====================================================
function renderFinished(room) {
  const players = playersArray(room);
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const champion = sorted[0];

  $('champion-name').textContent = champion ? champion.name : '—';

  $('final-board').innerHTML = sorted.map((p, i) => `
    <div class="flex items-center gap-3 p-4 glass rounded-xl ${i===0 ? 'glass-red' : ''}">
      <span class="rank-pill rank-${i+1}">${arabicDigit(i+1)}</span>
      <span class="font-bold flex-1 text-right text-lg">${escapeHtml(p.name)}</span>
      <span class="score-badge">${p.score}</span>
    </div>
  `).join('');

  if (typeof confetti === 'function') {
    confetti({ particleCount: 250, spread: 120, origin: { y: 0.4 }, colors: ['#FFD700', '#E94560', '#00D9A3'] });
    setTimeout(() => confetti({ particleCount: 100, spread: 70, origin: { x: 0.2 } }), 400);
    setTimeout(() => confetti({ particleCount: 100, spread: 70, origin: { x: 0.8 } }), 700);
  }
}

// =====================================================
// Helpers
// =====================================================
function playersArray(room) {
  const obj = room.players || {};
  return Object.entries(obj).map(([uid, p]) => ({ uid, ...p }));
}

// أرقام عربية - بدل إيموجيز الميداليات
function arabicDigit(n) {
  return String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]);
}

async function countUnusedQuestions(room) {
  const qs = room.questions || {};
  return Object.values(qs).filter((q) => !q.used).length;
}
