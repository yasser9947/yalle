// =====================================================
// ياللي - Player Logic
// -----------------------------------------------------
// شاشة اللاعب - يشترك في غرفة، يكتب أسئلة، يصوّت
// =====================================================

import {
  initFirebase, ensureSignedIn, getQueryParam,
  joinRoomAsPlayer, listenRoom, submitQuestion, markFinishedWriting,
  castVote, fetchRandomGif, showToast, escapeHtml,
  randomWinnerTagline,
  hideBootLoader, startSlowBootWatch, withButtonLoading, setupOfflineBanner,
  STATES,
} from './game-logic.js';

const $ = (id) => document.getElementById(id);

// =====================================================
// State
// =====================================================
let roomCode = null;
let myUid    = null;
let myName   = '';
let unsubRoom = null;
let lastState = null;
let currentRoundQid = null;
let mySubmittedCount = 0;
let voteInFlight = false;

// =====================================================
// Init
// =====================================================
(async function init() {
  // مراقبة بطء التهيئة
  const slowTimer = startSlowBootWatch(4000);

  roomCode = (getQueryParam('room') || '').toUpperCase();
  myName   = (getQueryParam('name') || '').trim();

  if (!roomCode || roomCode.length !== 6 || !myName) {
    clearTimeout(slowTimer);
    hideBootLoader();
    showError('بيانات الدخول ناقصة');
    return;
  }

  initFirebase();

  try {
    myUid = await ensureSignedIn();
    await joinRoomAsPlayer(roomCode, myUid, myName);
  } catch (err) {
    console.error(err);
    clearTimeout(slowTimer);
    hideBootLoader();
    showError(err.message || 'فشل دخول الغرفة');
    return;
  }

  // اتصلنا بنجاح
  setupOfflineBanner();
  clearTimeout(slowTimer);
  hideBootLoader();

  $('my-name-pill').textContent = myName;

  setupHandlers();
  startListeningToRoom();
})();

// =====================================================
// Handlers
// =====================================================
function setupHandlers() {
  const qInput = $('question-input');
  const charCount = $('char-count');

  qInput.addEventListener('input', () => {
    charCount.textContent = qInput.value.length;
  });

  $('btn-submit-q').addEventListener('click', async (e) => {
    const text = qInput.value.trim();
    if (text.length < 5) {
      showToast('السؤال قصير، طوّله شوي يا شيخ', 'error');
      return;
    }
    try {
      await withButtonLoading(e.currentTarget, () => submitQuestion(roomCode, myUid, text));
      mySubmittedCount++;
      qInput.value = '';
      charCount.textContent = '0';
      $('written-state').classList.remove('hidden');
      $('btn-finished-writing').disabled = false;
      showToast('انكتب السؤال', 'success');
    } catch (err) {
      console.error(err);
      showToast('فشل إرسال السؤال', 'error');
    }
  });

  $('btn-finished-writing').addEventListener('click', async (e) => {
    if (mySubmittedCount === 0) {
      showToast('اكتب على الأقل سؤال واحد', 'error');
      return;
    }
    try {
      await withButtonLoading(e.currentTarget, () => markFinishedWriting(roomCode, myUid, true));
      $('waiting-others').classList.remove('hidden');
      e.currentTarget.disabled = true;
      e.currentTarget.innerHTML = '<span>خلّصت</span>';
    } catch (err) {
      console.error(err);
      showToast('فشل التأكيد', 'error');
    }
  });
}

// =====================================================
// Listener
// =====================================================
function startListeningToRoom() {
  if (unsubRoom) unsubRoom();
  unsubRoom = listenRoom(roomCode, (room) => {
    if (!room) {
      showError('الغرفة انحذفت');
      return;
    }

    // تأكد إن اللاعب لسا في الغرفة
    if (!room.players?.[myUid]) {
      showError('انفصلت من الغرفة - أعد الدخول');
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

  // عرض النقاط
  const myScore = room.players?.[myUid]?.score || 0;
  $('my-score-pill').textContent = arabicDigit(myScore);

  if (state !== lastState) {
    ['lobby','writing','voting','results','finished'].forEach((s) => {
      $(`screen-${s}`).classList.toggle('hidden', s !== state);
    });
    $('screen-error').classList.add('hidden');
    lastState = state;

    // إعادة الضبط بين الجولات
    if (state === STATES.WRITING) {
      mySubmittedCount = 0;
      $('written-state').classList.add('hidden');
      $('waiting-others').classList.add('hidden');
      $('btn-finished-writing').disabled = true;
      $('btn-finished-writing').innerHTML = '<span>خلّصت</span>';
    }

    if (state === STATES.VOTING) {
      $('voted-state').classList.add('hidden');
      voteInFlight = false;
    }
  }

  switch (state) {
    case STATES.LOBBY:    renderLobby(room); break;
    case STATES.WRITING:  /* handlers سبق إعدادها */ break;
    case STATES.VOTING:   renderVoting(room); break;
    case STATES.RESULTS:  renderResults(room); break;
    case STATES.FINISHED: renderFinished(room); break;
  }
}

// =====================================================
// LOBBY
// =====================================================
function renderLobby(room) {
  $('lobby-greet').textContent = myName;
  $('lobby-code').textContent = roomCode;
  const players = playersArray(room);
  $('lobby-players').innerHTML = players.map((p) => `
    <span class="px-3 py-1 rounded-full bg-gold/10 border border-gold/30 text-sm font-bold ${p.uid===myUid ? 'neon-gold' : ''}">
      ${escapeHtml(p.name)}${p.isHost ? ' · هوست' : ''}
    </span>
  `).join('');
}

// =====================================================
// VOTING
// =====================================================
function renderVoting(room) {
  const round = room.currentRound;
  if (!round) return;

  $('voting-question').textContent = round.questionText;

  const players = playersArray(room);
  const myVote = round.votes?.[myUid];

  $('vote-buttons').innerHTML = players.map((p) => {
    const isMe = p.uid === myUid;
    const isSelected = myVote === p.uid;
    return `
      <button
        type="button"
        data-uid="${p.uid}"
        class="player-chip w-full ${isSelected ? 'selected' : ''}"
        ${isMe || myVote || voteInFlight ? 'disabled' : ''}
      >
        ${escapeHtml(p.name)}${isMe ? ' · أنت' : ''}
      </button>
    `;
  }).join('');

  // ربط الأزرار
  $('vote-buttons').querySelectorAll('button[data-uid]').forEach((btn) => {
    btn.addEventListener('click', () => handleVote(btn.dataset.uid));
  });

  if (myVote) {
    $('voted-state').classList.remove('hidden');
  }
}

async function handleVote(votedForUid) {
  if (voteInFlight) return;
  voteInFlight = true;

  const buttons = $('vote-buttons').querySelectorAll('button');
  const clickedBtn = $('vote-buttons').querySelector(`button[data-uid="${votedForUid}"]`);
  const originalLabel = clickedBtn ? clickedBtn.innerHTML : '';

  // تعطيل كل الأزرار + spinner على المضغوط
  buttons.forEach((b) => b.disabled = true);
  if (clickedBtn) {
    clickedBtn.classList.add('selected');
    clickedBtn.innerHTML = '<span class="spinner"></span>';
  }

  // تحذير بطء بعد 2.5s
  const slowTimer = setTimeout(() => {
    if (clickedBtn) clickedBtn.innerHTML = '<span class="spinner"></span><span class="btn-slow-text">بطيء شوي...</span>';
  }, 2500);

  try {
    await castVote(roomCode, myUid, votedForUid);
    clearTimeout(slowTimer);
  } catch (err) {
    clearTimeout(slowTimer);
    console.error(err);
    showToast(err.message || 'فشل التصويت', 'error');
    voteInFlight = false;
    // أرجع الزر لحالته الأصلية + فعّل الباقي
    if (clickedBtn) {
      clickedBtn.classList.remove('selected');
      clickedBtn.innerHTML = originalLabel;
    }
    buttons.forEach((b) => {
      b.disabled = b.dataset.uid === myUid;
    });
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

  $('player-results-tagline').textContent = randomWinnerTagline();
  $('player-winner-name').textContent = winner ? winner.name : 'ما حد فاز';
  $('player-winner-votes').textContent = winnerUid ? (tally[winnerUid] || 0) : 0;

  // إذا أنا الفايز - confetti
  if (winnerUid === myUid && round.questionId !== currentRoundQid) {
    if (typeof confetti === 'function') {
      confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 }, colors: ['#FFD700', '#E94560', '#00D9A3'] });
    }
  }

  // GIF (مرة لكل جولة)
  if (round.questionId !== currentRoundQid) {
    currentRoundQid = round.questionId;
    $('player-gif').innerHTML = '<div class="spinner"></div>';
    const gifUrl = await fetchRandomGif('funny');
    if (gifUrl) {
      $('player-gif').innerHTML = `<img src="${gifUrl}" alt="celebration" class="max-h-56 mx-auto" />`;
    } else {
      $('player-gif').innerHTML = '<div class="winner-divider"></div>';
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

  $('player-champion').textContent = champion ? champion.name : '—';

  $('player-board').innerHTML = sorted.map((p, i) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl ${p.uid===myUid ? 'glass-red' : ''}">
      <span class="rank-pill rank-${i+1}">${arabicDigit(i+1)}</span>
      <span class="font-bold flex-1 text-right">${escapeHtml(p.name)}${p.uid===myUid ? ' · أنت' : ''}</span>
      <span class="score-badge">${p.score}</span>
    </div>
  `).join('');

  if (champion?.uid === myUid && typeof confetti === 'function') {
    confetti({ particleCount: 300, spread: 130, origin: { y: 0.4 }, colors: ['#FFD700', '#E94560', '#00D9A3'] });
  }
}

// =====================================================
// Errors
// =====================================================
function showError(msg) {
  ['lobby','writing','voting','results','finished'].forEach((s) => $(`screen-${s}`).classList.add('hidden'));
  $('screen-error').classList.remove('hidden');
  $('error-msg').textContent = msg;
}

// =====================================================
// Helpers
// =====================================================
function playersArray(room) {
  const obj = room.players || {};
  return Object.entries(obj).map(([uid, p]) => ({ uid, ...p }));
}

function arabicDigit(n) {
  return String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]);
}
