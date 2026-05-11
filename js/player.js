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
  applyTheme, getTheme, themeGiphyKeyword, themeGreeting, refreshThemeStrings,
  autoReclaimOnline,
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
let currentTheme = 'shabaabia';

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
  autoReclaimOnline(roomCode, myUid); // تأمين online عند كل reconnect
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
    if (mySubmittedCount >= 3) {
      showToast('وصلت الحد الأقصى — ٣ أسئلة بس', 'error');
      return;
    }
    const text = qInput.value.trim();
    if (text.length < 5) {
      showToast(`السؤال قصير، طوّله شوي ${themeGreeting(currentTheme)}`.trim(), 'error');
      return;
    }
    try {
      await withButtonLoading(e.currentTarget, () => submitQuestion(roomCode, myUid, text));
      mySubmittedCount++;
      qInput.value = '';
      charCount.textContent = '0';
      $('player-q-count').textContent = arabicDigit(mySubmittedCount);
      $('written-state').classList.remove('hidden');
      $('btn-finished-writing').disabled = false;
      showToast('تم إرسال السؤال', 'success');
      // وصل للحد الأقصى → عطّل الإرسال
      if (mySubmittedCount >= 3) {
        $('btn-submit-q').disabled = true;
        $('btn-submit-q').innerHTML = '<span>وصلت الحد ٣</span>';
      }
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

  // طبّق الثيم من الغرفة
  if (room.theme && room.theme !== currentTheme) {
    currentTheme = room.theme;
    applyTheme(currentTheme);
    refreshThemeStrings(currentTheme);
  }

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
      const pq = document.getElementById('player-q-count');
      if (pq) pq.textContent = '٠';
      const sb = $('btn-submit-q');
      if (sb) {
        sb.disabled = false;
        sb.innerHTML = '<span>أرسل السؤال</span>';
      }
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
  const all = playersArray(room);
  const players = all.filter((p) => p.online !== false);
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

  const all = playersArray(room);
  const myVote = round.votes?.[myUid];

  // أزرار التصويت — تعرض الكل (online + offline) عشان لو واحد طلع
  // الباقي يقدرون يصوّتون عليه
  $('vote-buttons').innerHTML = all.map((p) => {
    const isMe = p.uid === myUid;
    const isOffline = p.online === false;
    const isSelected = myVote === p.uid;
    return `
      <button
        type="button"
        data-uid="${p.uid}"
        class="player-chip w-full ${isSelected ? 'selected' : ''} ${isOffline ? 'opacity-60' : ''}"
        ${isMe || myVote || voteInFlight ? 'disabled' : ''}
      >
        ${escapeHtml(p.name)}${isMe ? ' · أنت' : ''}${isOffline ? ' · طلع' : ''}
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
  const winnersUids = round.winners || (winnerUid ? [winnerUid] : []);
  const winnerObjs = winnersUids.map((uid) => players.find((p) => p.uid === uid)).filter(Boolean);
  const tally = round.tally || {};
  const tied = winnersUids.length > 1;
  const iAmWinner = winnersUids.includes(myUid);
  const skipped = round.skipped === true;

  if (skipped) {
    $('player-results-tagline').textContent = 'اتخطّى الهوست هذا السؤال';
    $('player-winner-name').textContent = '—';
    $('player-winner-votes').textContent = '0';
  } else if (tied) {
    $('player-results-tagline').textContent = 'تعادل! الفايزون';
    $('player-winner-name').innerHTML = winnerObjs.map((p) => escapeHtml(p.name)).join('<br>');
    $('player-winner-votes').textContent = tally[winnersUids[0]] || 0;
  } else if (winnerObjs.length === 0) {
    $('player-results-tagline').textContent = randomWinnerTagline(currentTheme);
    $('player-winner-name').textContent = 'ما حد فاز';
    $('player-winner-votes').textContent = '0';
  } else {
    $('player-results-tagline').textContent = randomWinnerTagline(currentTheme);
    $('player-winner-name').textContent = winnerObjs[0].name;
    $('player-winner-votes').textContent = tally[winnerUid] || 0;
  }

  // إذا أنا فايز - confetti (ما يصير لو اتخطّى)
  if (!skipped && iAmWinner && round.questionId !== currentRoundQid) {
    if (typeof confetti === 'function') {
      const t = getTheme(currentTheme);
      confetti({
        particleCount: 200,
        spread: 100,
        origin: { y: 0.5 },
        colors: [t.primary, t.secondary, '#00D9A3'],
      });
    }
  }

  // GIF فقط لو ما اتخطّى
  if (round.questionId !== currentRoundQid) {
    currentRoundQid = round.questionId;
    if (skipped) {
      $('player-gif').innerHTML = '<div class="winner-divider"></div>';
    } else {
      $('player-gif').innerHTML = '<div class="spinner"></div>';
      const gifUrl = await fetchRandomGif(themeGiphyKeyword(currentTheme));
      if (gifUrl) {
        $('player-gif').innerHTML = `<img src="${gifUrl}" alt="celebration" class="max-h-56 mx-auto" />`;
      } else {
        $('player-gif').innerHTML = '<div class="winner-divider"></div>';
      }
    }
  }
}

// =====================================================
// FINISHED
// =====================================================
function renderFinished(room) {
  const players = playersArray(room);
  const sorted = [...players].sort((a, b) => (b.score||0) - (a.score||0));

  const topScore = sorted[0]?.score || 0;
  const champions = sorted.filter((p) => (p.score||0) === topScore && topScore > 0);
  const iAmChamp = champions.some((p) => p.uid === myUid);

  // عنوان شخصي للثيم
  const titleEl = $('champion-title');
  if (titleEl) titleEl.textContent = getTheme(currentTheme).championLabel;

  if (champions.length === 0) {
    $('player-champion').textContent = '—';
  } else if (champions.length === 1) {
    $('player-champion').textContent = champions[0].name;
  } else {
    $('player-champion').innerHTML = champions.map((p) => escapeHtml(p.name)).join('<br>');
  }

  $('player-board').innerHTML = sorted.map((p, i) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl ${p.uid===myUid ? 'glass-red' : ''} ${p.online === false ? 'opacity-60' : ''}">
      <span class="rank-pill rank-${i+1}">${arabicDigit(i+1)}</span>
      <span class="font-bold flex-1 text-right">${escapeHtml(p.name)}${p.uid===myUid ? ' · أنت' : ''}${p.online === false && p.uid !== myUid ? ' · طلع' : ''}</span>
      <span class="score-badge">${p.score || 0}</span>
    </div>
  `).join('');

  if (iAmChamp && typeof confetti === 'function') {
    const t = getTheme(currentTheme);
    confetti({
      particleCount: 300, spread: 130, origin: { y: 0.4 },
      colors: [t.primary, t.secondary, '#00D9A3'],
    });
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
