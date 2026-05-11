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
  submitQuestion, markFinishedWriting, castVote,
  hideBootLoader, startSlowBootWatch, withButtonLoading,
  setupOfflineBanner, showPageTransition,
  scheduleRoomCleanupOnDisconnect, deleteRoom,
  applyTheme, getTheme, themeGiphyKeyword, themeGreeting, refreshThemeStrings,
  skipCurrentQuestion, getRoom, autoReclaimOnline,
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
let myQuestionsCount = 0;   // كم سؤال كتبه الهوست
let voteInFlight = false;   // قفل التصويت
let selectedTheme = 'shabaabia';  // ثيم اللعبة المختار
let cleanupScheduled = false;     // علم إن الـ onDisconnect cleanup اتسجل

// =====================================================
// Init
// =====================================================
(async function init() {
  // مراقبة التهيئة البطيئة - بعد 4 ثواني يبدّل النص لـ"بطيء شوي"
  const slowTimer = startSlowBootWatch(4000);

  roomCode = (getQueryParam('room') || '').toUpperCase();

  if (!roomCode || roomCode.length !== 6) {
    clearTimeout(slowTimer);
    hideBootLoader();
    showToast('كود الغرفة مو صحيح', 'error');
    setTimeout(() => location.href = 'index.html', 1500);
    return;
  }

  initFirebase();

  try {
    myUid = await ensureSignedIn();
  } catch (err) {
    clearTimeout(slowTimer);
    hideBootLoader();
    showToast('مشكلة في الاتصال - أعد المحاولة', 'error');
    return;
  }

  // اتصلنا بنجاح - فعّل بانر offline
  setupOfflineBanner();

  // إذا الغرفة موجودة وأنا الهوست → ارجع بدون إعادة إنشاء
  // (هذا يحل: ريفريش الهوست كان يمسح كل بيانات اللعبة)
  try {
    const existing = await getRoom(roomCode);
    if (existing && existing.host === myUid) {
      selectedTheme = existing.theme || 'shabaabia';
      applyTheme(selectedTheme);
      refreshThemeStrings(selectedTheme);
      autoReclaimOnline(roomCode, myUid);
      clearTimeout(slowTimer);
      hideBootLoader();
      setupLobbyUI();
      startListeningToRoom();
      return;
    }
  } catch (err) {
    console.warn('[ياللي] فشل فحص الغرفة:', err);
  }

  // أخفِ شاشة التحميل + اعرض شاشة الاسم (لاول مرة)
  clearTimeout(slowTimer);
  hideBootLoader();
  $('screen-name').classList.remove('hidden');
  $('host-name-input').focus();

  $('host-name-go').addEventListener('click', startHosting);
  $('host-name-input').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') startHosting();
  });

  // اختيار الثيم
  document.querySelectorAll('#theme-picker .theme-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#theme-picker .theme-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedTheme = chip.dataset.themeId;
      applyTheme(selectedTheme);
      refreshThemeStrings(selectedTheme); // يغيّر الـ placeholders تلقائياً
    });
  });
  applyTheme(selectedTheme);
  refreshThemeStrings(selectedTheme);
})();

async function startHosting() {
  const name = $('host-name-input').value.trim();
  if (name.length < 2) {
    showToast(`اكتب اسمك ${themeGreeting(selectedTheme)}`.trim(), 'error');
    return;
  }

  try {
    await withButtonLoading($('host-name-go'), () => createRoom(roomCode, myUid, name, selectedTheme));
  } catch (err) {
    console.error(err);
    showToast('فشل إنشاء الغرفة - حاول مرة ثانية', 'error');
    return;
  }

  // تأمين online + onDisconnect عند الـ reconnects
  autoReclaimOnline(roomCode, myUid);

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

  // مشاركة في واتساب
  $('btn-share-wa').addEventListener('click', () => {
    const shareUrl = new URL(`./?room=${roomCode}`, location.href).href;
    const text = `تعال العب ياللي معنا!\nكود الغرفة: ${roomCode}\n${shareUrl}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank');
  });

  $('btn-start-game').addEventListener('click', async (e) => {
    try {
      await withButtonLoading(e.currentTarget, () => setRoomState(roomCode, STATES.WRITING));
    } catch (err) { console.error(err); showToast('فشل بدء اللعبة', 'error'); }
  });

  $('btn-start-voting').addEventListener('click', startVotingRound);
  $('btn-reveal').addEventListener('click', revealRound);
  $('btn-next-q').addEventListener('click', startVotingRound);
  $('btn-end-game').addEventListener('click', async (e) => {
    try {
      await withButtonLoading(e.currentTarget, () => finishGame(roomCode));
    } catch (err) { console.error(err); showToast('فشل إنهاء اللعبة', 'error'); }
  });

  // أزرار التخطّي للهوست (override)
  $('btn-force-start-voting').addEventListener('click', async () => {
    if (!confirm('متأكد؟ في لاعبين ما خلّصوا الكتابة')) return;
    await startVotingRound();
  });
  $('btn-force-reveal').addEventListener('click', async () => {
    if (!confirm('متأكد؟ في لاعبين ما صوّتوا')) return;
    await revealRound();
  });

  // تخطّي السؤال - لو السؤال محرج أو يسبب مشكلة
  $('btn-skip-question').addEventListener('click', async (e) => {
    if (!confirm('تخطّ هذا السؤال؟ ما حد يكسب نقطة وننتقل للسؤال الجاي.')) return;
    try {
      await withButtonLoading(e.currentTarget, () => skipCurrentQuestion(roomCode));
    } catch (err) {
      console.error(err);
      showToast('فشل تخطّي السؤال', 'error');
    }
  });

  // واجهة كتابة الهوست (الهوست لاعب أيضاً)
  setupHostWritingHandlers();
}

// =====================================================
// Host-as-player: writing UI
// =====================================================
function setupHostWritingHandlers() {
  const qInput = $('host-question-input');
  const charCount = $('host-char-count');

  qInput.addEventListener('input', () => {
    charCount.textContent = qInput.value.length;
  });

  $('btn-host-submit-q').addEventListener('click', async (e) => {
    if (myQuestionsCount >= 3) {
      showToast('وصلت الحد الأقصى — ٣ أسئلة بس', 'error');
      return;
    }
    const text = qInput.value.trim();
    if (text.length < 5) {
      showToast(`السؤال قصير، طوّله شوي ${themeGreeting(selectedTheme)}`.trim(), 'error');
      return;
    }
    try {
      await withButtonLoading(e.currentTarget, () => submitQuestion(roomCode, myUid, text));
      myQuestionsCount++;
      qInput.value = '';
      charCount.textContent = '0';
      $('host-q-count').textContent = arabicDigit(myQuestionsCount);
      $('host-written-state').classList.remove('hidden');
      $('btn-host-finished-writing').disabled = false;
      showToast('تم إرسال السؤال', 'success');
      // وصل للحد الأقصى → عطّل الإرسال
      if (myQuestionsCount >= 3) {
        $('btn-host-submit-q').disabled = true;
        $('btn-host-submit-q').innerHTML = '<span>وصلت الحد ٣</span>';
      }
    } catch (err) {
      console.error(err);
      showToast('فشل إرسال السؤال', 'error');
    }
  });

  $('btn-host-finished-writing').addEventListener('click', async (e) => {
    if (myQuestionsCount === 0) {
      showToast('اكتب على الأقل سؤال واحد', 'error');
      return;
    }
    try {
      await withButtonLoading(e.currentTarget, () => markFinishedWriting(roomCode, myUid, true));
      e.currentTarget.disabled = true;
      e.currentTarget.innerHTML = '<span>خلّصت</span>';
    } catch (err) {
      console.error(err);
      showToast('فشل التأكيد', 'error');
    }
  });
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

  // طبّق ثيم الغرفة
  if (room.theme) {
    selectedTheme = room.theme;
    applyTheme(room.theme);
    refreshThemeStrings(room.theme);
  }

  // لما اللعبة تخلص: علم Firebase يحذف الغرفة لما الهوست ينقطع + timer 90s
  if (state === STATES.FINISHED && !cleanupScheduled) {
    cleanupScheduled = true;
    try { scheduleRoomCleanupOnDisconnect(roomCode); } catch (e) { console.warn(e); }
    setTimeout(() => {
      deleteRoom(roomCode).catch((e) => console.warn('cleanup failed', e));
    }, 90000);
  }

  // عرض الشاشة الصحيحة
  if (state !== lastState) {
    ['lobby','writing','voting','results','finished'].forEach((s) => {
      $(`screen-${s}`).classList.toggle('hidden', s !== state);
    });
    lastState = state;

    // إعادة الضبط بين الجولات
    if (state === STATES.WRITING) {
      myQuestionsCount = 0;
      $('host-written-state').classList.add('hidden');
      const fwBtn = $('btn-host-finished-writing');
      fwBtn.disabled = true;
      fwBtn.innerHTML = '<span>خلّصت</span>';
      $('host-question-input').value = '';
      $('host-char-count').textContent = '0';
      $('host-q-count').textContent = '٠';
      const submitBtn = $('btn-host-submit-q');
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>أرسل السؤال</span>';
    }

    if (state === STATES.VOTING) {
      voteInFlight = false;
      $('host-voted-state').classList.add('hidden');
    }
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
  const allPlayers = playersArray(room);
  const players = allPlayers.filter((p) => p.online !== false);
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
  const all = playersArray(room);
  const players = all.filter((p) => p.online !== false);
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

  // رسالة عشوائية حسب ثيم الغرفة، تتجدد كل 4 ثواني
  if (!funnyMsgTimer) {
    $('writing-funny-msg').textContent = randomWaitingMessage(selectedTheme);
    funnyMsgTimer = setInterval(() => {
      $('writing-funny-msg').textContent = randomWaitingMessage(selectedTheme);
    }, 4000);
  }
}

async function startVotingRound(ev) {
  if (funnyMsgTimer) { clearInterval(funnyMsgTimer); funnyMsgTimer = null; }

  const btn = ev?.currentTarget || $('btn-start-voting');
  try {
    await withButtonLoading(btn, async () => {
      const result = await startNextRound(roomCode);
      if (!result) {
        showToast('خلّصت كل الأسئلة', 'success');
        await finishGame(roomCode);
      }
    });
  } catch (err) {
    console.error(err);
    showToast('فشل بدء الجولة', 'error');
  }
}

// =====================================================
// VOTING
// =====================================================
function renderVoting(room) {
  const round = room.currentRound;
  if (!round) return;

  const all = playersArray(room);
  // المتصلين = من بإمكانه يصوّت الآن (للعداد)
  const onlinePlayers = all.filter((p) => p.online !== false);
  const onlineUids = new Set(onlinePlayers.map((p) => p.uid));

  const allVotes = round.votes || {};
  // فلترة الأصوات الشبحية - فقط من المتصلين تُحتسب في العداد
  const liveVotes = Object.fromEntries(
    Object.entries(allVotes).filter(([voterUid]) => onlineUids.has(voterUid))
  );
  const voted = Object.keys(liveVotes).length;
  const total = onlinePlayers.length;
  const votes = liveVotes;
  const myVote = votes[myUid];

  // أزرار التصويت — تعرض الكل (online + offline) عشان لو واحد طلع
  // الباقي يقدرون يصوّتون عليه (طلب المستخدم: لا نحذفه من الخيارات)
  // التصويت للنفس مسموح فقط لو في ٢ لاعبين بالضبط
  const allowSelfVote = all.length <= 2;
  const voteContainer = $('host-vote-buttons');
  voteContainer.innerHTML = all.map((p) => {
    const isMe = p.uid === myUid;
    const isOffline = p.online === false;
    const isSelected = myVote === p.uid;
    const blockMe = isMe && !allowSelfVote;
    return `
      <button
        type="button"
        data-uid="${p.uid}"
        class="player-chip ${isSelected ? 'selected' : ''} ${isOffline ? 'opacity-60' : ''}"
        ${blockMe || myVote || voteInFlight ? 'disabled' : ''}
      >
        ${escapeHtml(p.name)}${isMe ? ' · أنت' : ''}${isOffline ? ' · طلع' : ''}
      </button>
    `;
  }).join('');

  voteContainer.querySelectorAll('button[data-uid]').forEach((btn) => {
    btn.addEventListener('click', () => handleHostVote(btn.dataset.uid));
  });

  if (myVote) {
    $('host-voted-state').classList.remove('hidden');
  } else {
    $('host-voted-state').classList.add('hidden');
  }

  $('voting-question').textContent = round.questionText;
  $('voting-done').textContent = voted;
  $('voting-total').textContent = total;
  $('voting-progress').style.width = total ? `${(voted/total)*100}%` : '0%';

  // عداد التصويت يعرض المتصلين فقط (لأنهم اللي بيصوّتون)
  $('voting-players-status').innerHTML = onlinePlayers.map((p) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl">
      <span class="status-dot ${votes[p.uid] ? 'done' : ''}"></span>
      <span class="font-bold flex-1 truncate">${escapeHtml(p.name)}</span>
    </div>
  `).join('');

  $('btn-reveal').disabled = !(voted === total && total >= 2);
}

async function revealRound(ev) {
  const btn = ev?.currentTarget || $('btn-reveal');
  try {
    await withButtonLoading(btn, () => tallyAndCloseRound(roomCode));
  } catch (err) {
    console.error(err);
    showToast('فشل عرض النتيجة', 'error');
  }
}

async function handleHostVote(votedForUid) {
  if (voteInFlight) return;
  voteInFlight = true;

  const buttons = $('host-vote-buttons').querySelectorAll('button');
  const clickedBtn = $('host-vote-buttons').querySelector(`button[data-uid="${votedForUid}"]`);
  const originalLabel = clickedBtn ? clickedBtn.innerHTML : '';

  buttons.forEach((b) => b.disabled = true);
  if (clickedBtn) {
    clickedBtn.classList.add('selected');
    clickedBtn.innerHTML = '<span class="spinner"></span>';
  }

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
  const skipped = round.skipped === true;

  if (skipped) {
    $('results-tagline').textContent = 'اتخطّى الهوست هذا السؤال';
    $('winner-name').textContent = '—';
    $('winner-votes').textContent = '0';
  } else if (tied) {
    $('results-tagline').textContent = 'تعادل! الفايزون';
    $('winner-name').innerHTML = winnerObjs.map((p) => escapeHtml(p.name)).join('<br>');
    $('winner-votes').textContent = tally[winnersUids[0]] || 0;
  } else if (winnerObjs.length === 0) {
    $('results-tagline').textContent = randomWinnerTagline(selectedTheme);
    $('winner-name').textContent = 'ما حد فاز';
    $('winner-votes').textContent = '0';
  } else {
    $('results-tagline').textContent = randomWinnerTagline(selectedTheme);
    $('winner-name').textContent = winnerObjs[0].name;
    $('winner-votes').textContent = tally[winnerUid] || 0;
  }

  // mini board (مرتب)
  const sorted = [...players].sort((a, b) => (b.score||0) - (a.score||0));
  $('mini-board').innerHTML = sorted.map((p, i) => `
    <div class="flex items-center gap-3 p-3 glass rounded-xl ${p.online === false ? 'opacity-60' : ''}">
      <span class="rank-pill rank-${i+1}">${arabicDigit(i+1)}</span>
      <span class="font-bold flex-1 text-right">${escapeHtml(p.name)}${p.online === false ? ' · طلع' : ''}</span>
      <span class="score-badge">${p.score || 0}</span>
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

  // Confetti + GIF - فقط لو ما اتخطّى
  if (round.questionId !== currentRoundQid) {
    currentRoundQid = round.questionId;
    lastWinnerUid = winnerUid;

    if (skipped) {
      // لا confetti لما يتخطّى — بس خط ذهبي خفيف
      $('gif-container').innerHTML = '<div class="winner-divider"></div>';
    } else {
      if (typeof confetti === 'function') {
        const t = getTheme(selectedTheme);
        confetti({
          particleCount: tied ? 220 : 150,
          spread: 90,
          origin: { y: 0.5 },
          colors: [t.primary, t.secondary, '#00D9A3'],
        });
      }

      // جلب GIF حسب ثيم الغرفة
      $('gif-container').innerHTML = '<div class="spinner"></div>';
      const gifUrl = await fetchRandomGif(themeGiphyKeyword(selectedTheme));
      if (gifUrl) {
        $('gif-container').innerHTML = `<img src="${gifUrl}" alt="celebration" class="max-h-72 mx-auto" />`;
      } else {
        $('gif-container').innerHTML = '<div class="winner-divider"></div>';
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

  // الشامبيون: أعلى نقاط (لو تعادل، كلهم شامبيون)
  const topScore = sorted[0]?.score || 0;
  const champions = sorted.filter((p) => (p.score||0) === topScore && topScore > 0);

  // عنوان شخصي للثيم
  const titleEl = $('champion-title');
  if (titleEl) titleEl.textContent = getTheme(selectedTheme).championLabel;

  if (champions.length === 0) {
    $('champion-name').textContent = '—';
  } else if (champions.length === 1) {
    $('champion-name').textContent = champions[0].name;
  } else {
    $('champion-name').innerHTML = champions.map((p) => escapeHtml(p.name)).join('<br>');
  }

  $('final-board').innerHTML = sorted.map((p, i) => `
    <div class="flex items-center gap-3 p-4 glass rounded-xl ${champions.includes(p) ? 'glass-red' : ''} ${p.online === false ? 'opacity-60' : ''}">
      <span class="rank-pill rank-${i+1}">${arabicDigit(i+1)}</span>
      <span class="font-bold flex-1 text-right text-lg">${escapeHtml(p.name)}${p.online === false ? ' · طلع' : ''}</span>
      <span class="score-badge">${p.score || 0}</span>
    </div>
  `).join('');

  if (typeof confetti === 'function') {
    const t = getTheme(selectedTheme);
    const colors = [t.primary, t.secondary, '#00D9A3'];
    confetti({ particleCount: 250, spread: 120, origin: { y: 0.4 }, colors });
    setTimeout(() => confetti({ particleCount: 100, spread: 70, origin: { x: 0.2 }, colors }), 400);
    setTimeout(() => confetti({ particleCount: 100, spread: 70, origin: { x: 0.8 }, colors }), 700);
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
