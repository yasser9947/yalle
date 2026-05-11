// =====================================================
// ياللي - Game Logic (shared)
// -----------------------------------------------------
// يحتوي على:
//  - تهيئة Firebase + Auth
//  - عمليات الغرفة (إنشاء/دخول/تحديث)
//  - مستمعات Realtime
//  - أدوات مساعدة (كود غرفة، Toast، Giphy، رسائل عشوائية)
// =====================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getDatabase, ref, set, get, update, push, onValue, off, onDisconnect,
  serverTimestamp, remove, runTransaction, child
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  initializeAppCheck, ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app-check.js';

import { firebaseConfig, GIPHY_API_KEY, RECAPTCHA_SITE_KEY } from './firebase-config.js';

// =====================================================
// 1) Firebase init - lazy singleton
// =====================================================
let _app = null;
let _db  = null;
let _auth = null;
let _appCheck = null;

export function initFirebase() {
  if (_app) return { app: _app, db: _db, auth: _auth };

  if (firebaseConfig.apiKey?.startsWith('REPLACE_ME')) {
    console.warn('[ياللي] Firebase config لسا فاضي - عبّيه في js/firebase-config.js');
  }

  // App Check debug mode على localhost (الـ console يطبع debug token)
  // المستخدم لازم يضيف الـ token في Firebase Console → App Check → Apps → ⋮ → Manage debug tokens
  if (typeof self !== 'undefined' && location.hostname === 'localhost') {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }

  _app = initializeApp(firebaseConfig);

  // فعّل App Check قبل أي خدمة ثانية
  if (RECAPTCHA_SITE_KEY && !RECAPTCHA_SITE_KEY.startsWith('REPLACE') && RECAPTCHA_SITE_KEY.length > 20) {
    try {
      _appCheck = initializeAppCheck(_app, {
        provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      });
    } catch (err) {
      console.warn('[ياللي] App Check init failed:', err);
    }
  }

  _db   = getDatabase(_app);
  _auth = getAuth(_app);
  return { app: _app, db: _db, auth: _auth };
}

// تسجيل دخول مجهول وانتظار اكتمال الـ uid
export function ensureSignedIn() {
  const { auth } = initFirebase();

  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsub();
        resolve(user.uid);
      }
    }, reject);

    // إذا ما في session، سجّل دخول مجهول
    if (!auth.currentUser) {
      signInAnonymously(auth).catch((err) => {
        console.error('فشل تسجيل الدخول المجهول:', err);
        reject(err);
      });
    }
  });
}

// =====================================================
// 2) Room code helpers
// =====================================================
// كود من 6 أحرف بدون أحرف ملتبسة (0/O/1/I/L)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRoomCode(len = 6) {
  let code = '';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) {
    code += CODE_CHARS[arr[i] % CODE_CHARS.length];
  }
  return code;
}

export function normalizeCode(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

// =====================================================
// 3) Room operations
// =====================================================
// حالات اللعبة الممكنة
export const STATES = {
  LOBBY:    'lobby',     // اللاعبين يدخلون
  WRITING:  'writing',   // كتابة الأسئلة
  VOTING:   'voting',    // تصويت على سؤال
  RESULTS:  'results',   // عرض نتيجة الجولة
  FINISHED: 'finished',  // انتهت اللعبة
};

export function roomRef(code) {
  const { db } = initFirebase();
  return ref(db, `rooms/${code}`);
}

// قراءة الغرفة - يرجع null لو ما موجودة
export async function getRoom(code) {
  const { db } = initFirebase();
  const snap = await get(ref(db, `rooms/${code}`));
  return snap.exists() ? snap.val() : null;
}

// تأمين online=true باستمرار + إعادة تأسيس onDisconnect كل ما يرجع الاتصال
// هذا يحل: لما يخلّص الكتابة وتقطع الـ WS لحظة، الـ onDisconnect كان
// يخلي online=false ولا يرجع true تلقائياً → اللاعب يطلع من اللعبة
export function autoReclaimOnline(code, uid) {
  const { db } = initFirebase();
  const connRef = ref(db, '.info/connected');
  return onValue(connRef, async (snap) => {
    if (snap.val() === true) {
      try {
        await update(ref(db, `rooms/${code}/players/${uid}`), { online: true });
        onDisconnect(ref(db, `rooms/${code}/players/${uid}/online`)).set(false);
      } catch (err) {
        console.warn('[ياللي] فشل إعادة تأمين online:', err);
      }
    }
  });
}

// إنشاء غرفة جديدة - الهوست يستدعيها
export async function createRoom(code, hostUid, hostName = 'الهوست', themeId = 'shabaabia') {
  const { db } = initFirebase();
  const roomData = {
    host: hostUid,
    state: STATES.LOBBY,
    theme: themeId,
    createdAt: serverTimestamp(),
    players: {
      [hostUid]: {
        name: hostName,
        score: 0,
        finishedWriting: false,
        joinedAt: serverTimestamp(),
        isHost: true,
        online: true,
      }
    },
    questions: {},
    currentRound: null,
  };
  await set(ref(db, `rooms/${code}`), roomData);

  // لما الهوست ينقطع: نحدّث online فقط (نحفظ نقاطه إذا رجع)
  onDisconnect(ref(db, `rooms/${code}/players/${hostUid}/online`)).set(false);

  // عدّاد إجمالي الجلسات
  incrementGamesPlayed().catch((e) => console.warn('stats inc failed', e));
}

// دخول لاعب لغرفة موجودة - يدعم الرجوع (يحفظ النقاط)
export async function joinRoomAsPlayer(code, uid, name) {
  const { db } = initFirebase();

  const snap = await get(ref(db, `rooms/${code}`));
  if (!snap.exists()) {
    throw new Error('الغرفة مو موجودة');
  }
  const room = snap.val();
  if (room.state === STATES.FINISHED) {
    throw new Error('اللعبة خلصت يا شيخ');
  }

  const playerRef = ref(db, `rooms/${code}/players/${uid}`);
  const existing = room.players?.[uid];

  if (existing) {
    // رجوع: نحافظ على النقاط + finishedWriting، فقط نعلّمه online
    await update(playerRef, { online: true, name });
  } else {
    // دخول أول مرة
    await set(playerRef, {
      name,
      score: 0,
      finishedWriting: false,
      joinedAt: serverTimestamp(),
      isHost: false,
      online: true,
    });
  }

  // عند الانفصال: نحدّث online بس (نحفظ السجل علشان الرجوع)
  onDisconnect(ref(db, `rooms/${code}/players/${uid}/online`)).set(false);
}

// تغيير حالة الغرفة
export async function setRoomState(code, state) {
  const { db } = initFirebase();
  await update(ref(db, `rooms/${code}`), { state });
}

// إضافة سؤال
export async function submitQuestion(code, authorUid, text) {
  const { db } = initFirebase();
  const newQRef = push(ref(db, `rooms/${code}/questions`));
  await set(newQRef, {
    text: text.trim().slice(0, 200),
    authorUid,
    used: false,
    createdAt: serverTimestamp(),
  });
}

// تعليم لاعب أنه خلّص الكتابة
export async function markFinishedWriting(code, uid, finished = true) {
  const { db } = initFirebase();
  await update(ref(db, `rooms/${code}/players/${uid}`), { finishedWriting: finished });
}

// اختيار سؤال جديد للجولة (يستدعيها الهوست فقط)
export async function startNextRound(code) {
  const { db } = initFirebase();
  const qSnap = await get(ref(db, `rooms/${code}/questions`));
  if (!qSnap.exists()) return null;

  const allQs = qSnap.val();
  const unused = Object.entries(allQs).filter(([_, q]) => !q.used);
  if (unused.length === 0) return null;

  // اختر عشوائياً
  const [qid, q] = unused[Math.floor(Math.random() * unused.length)];

  // علّمه مستخدم
  await update(ref(db, `rooms/${code}/questions/${qid}`), { used: true });

  // ابدأ الجولة
  await update(ref(db, `rooms/${code}`), {
    state: STATES.VOTING,
    currentRound: {
      questionId: qid,
      questionText: q.text,
      authorUid: q.authorUid,
      votes: {},
      startedAt: serverTimestamp(),
      winnerUid: null,
    }
  });

  return { qid, question: q };
}

// تصويت لاعب
// التصويت للنفس مسموح فقط لو في الغرفة ٢ لاعبين بالضبط
// (عشان ما يصير دايماً تعادل في الحالة دي)
export async function castVote(code, voterUid, votedForUid) {
  const { db } = initFirebase();
  if (voterUid === votedForUid) {
    const playersSnap = await get(ref(db, `rooms/${code}/players`));
    const count = playersSnap.exists() ? Object.keys(playersSnap.val()).length : 0;
    if (count > 2) {
      throw new Error('ما تقدر تصوّت لنفسك يا شيخ');
    }
  }
  await update(ref(db, `rooms/${code}/currentRound/votes`), {
    [voterUid]: votedForUid,
  });
}

// حساب الفائز للجولة الحالية + إضافة نقطة
// يحسب أصوات اللاعبين الموجودين الآن (online) فقط، ويتجاهل أصوات اللي طلعوا.
// لو تعادل: كل المتعادلين يأخذون نقطة.
export async function tallyAndCloseRound(code) {
  const { db } = initFirebase();
  const [roundSnap, playersSnap] = await Promise.all([
    get(ref(db, `rooms/${code}/currentRound`)),
    get(ref(db, `rooms/${code}/players`)),
  ]);
  if (!roundSnap.exists()) return null;

  const round = roundSnap.val();
  const players = playersSnap.val() || {};
  const onlineUids = new Set(
    Object.entries(players)
      .filter(([_, p]) => p.online !== false)
      .map(([uid]) => uid)
  );

  const allVotes = round.votes || {};
  const tally = {};
  Object.entries(allVotes).forEach(([voterUid, votedForUid]) => {
    // أصوات شبحية (المصوّت طلع) → تجاهل
    if (!onlineUids.has(voterUid)) return;
    tally[votedForUid] = (tally[votedForUid] || 0) + 1;
  });

  // المتعادلون - كلهم يأخذون نقطة
  let max = 0;
  Object.values(tally).forEach((c) => { if (c > max) max = c; });
  const winners = max > 0
    ? Object.entries(tally).filter(([_, c]) => c === max).map(([uid]) => uid)
    : [];

  // امنح نقطة لكل فائز موجود
  for (const uid of winners) {
    if (!players[uid]) continue; // الفايز طلع ومتروك سجله
    const scoreRef = ref(db, `rooms/${code}/players/${uid}/score`);
    await runTransaction(scoreRef, (curr) => (curr || 0) + 1);
  }

  // الفايز الأساسي للعرض - أول واحد في القائمة (لو واحد بس، هو هو)
  const winnerUid = winners[0] || null;
  await update(ref(db, `rooms/${code}/currentRound`), {
    winnerUid, tally, winners, // winners[] = كل المتعادلين
  });
  await setRoomState(code, STATES.RESULTS);

  return { winnerUid, winners, tally };
}

// تخطّي السؤال الحالي (الهوست يقدر يضغطها لو السؤال محرج)
// ما حد يكسب نقطة، الكل يشوف رسالة "اتخطّى السؤال"، ثم ننتقل للسؤال الجاي
export async function skipCurrentQuestion(code) {
  const { db } = initFirebase();
  await update(ref(db, `rooms/${code}/currentRound`), {
    skipped: true,
    winnerUid: null,
    tally: {},
    winners: [],
  });
  await setRoomState(code, STATES.RESULTS);
}

// إنهاء اللعبة
export async function finishGame(code) {
  await setRoomState(code, STATES.FINISHED);
  // عدّاد الجلسات المكتملة
  incrementGamesFinished().catch((e) => console.warn('stats inc failed', e));
}

// =====================================================
// إحصائيات عامة (stats/gamesPlayed, stats/gamesFinished)
// =====================================================
export async function incrementGamesPlayed() {
  const { db } = initFirebase();
  return runTransaction(ref(db, 'stats/gamesPlayed'), (curr) => (curr || 0) + 1);
}

export async function incrementGamesFinished() {
  const { db } = initFirebase();
  return runTransaction(ref(db, 'stats/gamesFinished'), (curr) => (curr || 0) + 1);
}

export function watchStats(callback) {
  const { db } = initFirebase();
  const r = ref(db, 'stats');
  const handler = onValue(r, (snap) => callback(snap.val() || {}));
  return () => off(r, 'value', handler);
}

// أرقام عربية - مساعد يطلع للكل
export function toArabicDigits(n) {
  return String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]);
}

// حذف الغرفة بالكامل (يستدعى من الهوست لما اللعبة تخلص)
export async function deleteRoom(code) {
  const { db } = initFirebase();
  await remove(ref(db, `rooms/${code}`));
}

// لما اللعبة تخلص: نعلّم Firebase يحذف الغرفة لما الهوست ينقطع
// → توفير في تكلفة الـ DB
export function scheduleRoomCleanupOnDisconnect(code) {
  const { db } = initFirebase();
  onDisconnect(ref(db, `rooms/${code}`)).remove();
}

// إلغاء الـ onDisconnect cleanup (لو الهوست بدأ لعبة جديدة)
export function cancelRoomCleanupOnDisconnect(code) {
  const { db } = initFirebase();
  onDisconnect(ref(db, `rooms/${code}`)).cancel();
}

// =====================================================
// 4) Listeners (يرجع unsubscribe function)
// =====================================================
export function listenRoom(code, callback) {
  const r = roomRef(code);
  const handler = onValue(r, (snap) => callback(snap.val()));
  return () => off(r, 'value', handler);
}

// =====================================================
// 5) Giphy - GIFs نظيفة فقط (rating=g)
// =====================================================
// Keywords مختارة للضحك والتطقطقة بدون محتوى وسخ
const GIPHY_KEYWORDS = [
  'high five',
  'happy dance',
  'thumbs up',
  'applause',
  'congratulations',
  'fail',
  'shocked',
  'surprised',
  'mind blown',
  'celebration kids',
  'cartoon laugh',
  'spongebob',
  'minions',
  'simpsons',
];

export async function fetchRandomGif(keyword) {
  const k = keyword || GIPHY_KEYWORDS[Math.floor(Math.random() * GIPHY_KEYWORDS.length)];

  if (!GIPHY_API_KEY || GIPHY_API_KEY.startsWith('REPLACE_ME')) {
    console.warn('[ياللي] مفتاح Giphy ما تم ضبطه');
    return null;
  }

  try {
    // rating=g → general audience فقط (الأكثر أماناً)
    const url = `https://api.giphy.com/v1/gifs/random?api_key=${encodeURIComponent(GIPHY_API_KEY)}&tag=${encodeURIComponent(k)}&rating=g`;
    const res = await fetch(url);
    const json = await res.json();
    return json?.data?.images?.original?.url || json?.data?.images?.downsized_medium?.url || null;
  } catch (err) {
    console.error('Giphy fetch failed:', err);
    return null;
  }
}

// =====================================================
// 6) Loading / connection state helpers
// =====================================================

// إخفاء شاشة التحميل الأولية لما اللعبة تجهز
export function hideBootLoader() {
  const el = document.getElementById('boot-loader');
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(() => el.remove(), 450);
}

// لو التهيئة تأخّرت → ابدّل النص إلى "بطيء شوي..."
export function startSlowBootWatch(timeoutMs = 4000) {
  return setTimeout(() => {
    const t = document.querySelector('#boot-loader .boot-text');
    if (t) {
      t.textContent = 'الاتصال بطيء شوي... استنّى';
      t.classList.add('slow');
    }
  }, timeoutMs);
}

// غلاف لتشغيل عملية async مع spinner على الزر + تحذير بطء بعد 2.5s
export async function withButtonLoading(btn, asyncFn, opts = {}) {
  const slowAfterMs = opts.slowAfterMs ?? 2500;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.innerHTML = '<span class="spinner"></span>';

  const slowTimer = setTimeout(() => {
    btn.innerHTML = '<span class="spinner"></span><span class="btn-slow-text">بطيء شوي...</span>';
  }, slowAfterMs);

  try {
    return await asyncFn();
  } finally {
    clearTimeout(slowTimer);
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.innerHTML = original;
  }
}

// مراقبة حالة الاتصال - يرجع unsubscribe
export function watchOnlineStatus(callback) {
  const { db } = initFirebase();
  const r = ref(db, '.info/connected');
  const handler = onValue(r, (snap) => callback(snap.val() === true));
  return () => off(r, 'value', handler);
}

// إعداد بانر "ما في إنترنت" تلقائي
export function setupOfflineBanner() {
  let banner = null;
  let firstConnect = false;

  const show = () => {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'offline-banner';
    banner.textContent = 'ما في إنترنت — تحقق من اتصالك';
    document.body.appendChild(banner);
  };
  const hide = () => {
    if (banner) { banner.remove(); banner = null; }
  };

  return watchOnlineStatus((online) => {
    if (online) {
      firstConnect = true;
      hide();
    } else if (firstConnect) {
      // ما نظهر البانر إلا بعد ما اتصلنا أول مرة (تجنب الفلاش الأولي)
      show();
    }
  });
}

// عرض overlay لما تنتقل بين الصفحات
export function showPageTransition(text = 'يحمّل...') {
  let el = document.getElementById('page-transition');
  if (!el) {
    el = document.createElement('div');
    el.id = 'page-transition';
    el.innerHTML = `<div class="spinner"></div><p class="pt-text">${text}</p>`;
    document.body.appendChild(el);
  } else {
    el.querySelector('.pt-text').textContent = text;
  }
  // فرض re-paint قبل ما نضيف visible علشان transition يشتغل
  void el.offsetHeight;
  el.classList.add('visible');
}

// =====================================================
// 7) UI helpers (toast, escape)
// =====================================================
export function showToast(msg, type = 'info', duration = 3000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

// =====================================================
// 8) Themes - ثيمات اللعبة
// =====================================================
// كل ثيم: ألوان + كلمات GIF + رسائل انتظار + نداءات للفايز
// شبابي/بنات/عائلية - بدون لون أو كلمة وسخة
export const THEMES = {
  shabaabia: {
    id: 'shabaabia',
    name: 'شبابية',
    description: 'الشلة وأهل المرجلة',
    primary: '#FFD700',
    secondary: '#E94560',
    giphyKeywords: ['high five', 'thumbs up', 'fail', 'shocked', 'cartoon laugh', 'spongebob'],
    waitingMessages: [
      'يبيلها صبر... شكل فلان لسا يفكّر',
      'حسبتوها سهلة؟ خذوا وقتكم',
      'اللي يخلّص بمرجلة، عليه القهوة',
      'يا شيخ ما عندنا وقت',
      'فكّر في أحرج موقف صار لكم',
      'الفايز اللي عنده أجرأ سؤال',
      'خل المرجلة فيك واكتب',
      'الشلة كلها تنتظرك',
      'لا تكتبون شي يحرج أمكم',
    ],
    winnerTaglines: [
      'الفايز هو',
      'صاحب الموقف',
      'بمرجلة',
      'ولد الزين',
      'هذا الرجّال',
      'يا حلاوة',
    ],
    championLabel: 'شامبيون المرجلة',
    greeting: 'يا شيخ',
  },

  banat: {
    id: 'banat',
    name: 'بنات',
    description: 'للأخوات',
    primary: '#FF6FAB',
    secondary: '#A855F7',
    giphyKeywords: ['happy dance', 'cute animal', 'celebration', 'applause', 'congratulations', 'high five'],
    waitingMessages: [
      'الشلة بانتظاركم',
      'فكّروا في موقف يضحّك',
      'وش رأيكم نخلّص بسرعة',
      'اللي تخلّص أوّل تكسب',
      'الكل ينتظر',
      'فكّروا في أحرج موقف صار',
      'خذوا وقتكم',
      'الجولة قصيرة، يلا',
    ],
    winnerTaglines: [
      'الفايزة هي',
      'صاحبة الموقف',
      'الفايزة',
      'بطلة الجولة',
    ],
    championLabel: 'بطلة الجلسة',
    greeting: '',
  },

  family: {
    id: 'family',
    name: 'عائلية',
    description: 'لجلسات الأهل',
    primary: '#00D9A3',
    secondary: '#FFA500',
    giphyKeywords: ['cartoon laugh', 'spongebob', 'minions', 'happy kids', 'celebration kids', 'thumbs up'],
    waitingMessages: [
      'يا أهل البيت، يلا',
      'الجمعة العائلية تنتظر',
      'الأطفال أسرع من الكبار',
      'وش رايكم نضحّك بعض؟',
      'العائلة كلها معنا',
      'فكّر في موقف صار في البيت',
      'يا أهل الزين، خلّصوا',
      'الكبار أبطأ مرة',
    ],
    winnerTaglines: [
      'الفايز',
      'صاحب الموقف',
      'فخر العائلة',
      'ضحكة البيت',
      'يا حلاوة',
      'يا أهل الزين',
    ],
    championLabel: 'شامبيون العائلة',
    greeting: 'يا غالي',
  },
};

export function getTheme(id) {
  return THEMES[id] || THEMES.shabaabia;
}

// تطبيق الثيم على الـ DOM (CSS variables موجودة في style.css لكل ثيم)
export function applyTheme(themeId) {
  document.documentElement.dataset.theme = (themeId || 'shabaabia');
}

// النداء المناسب للثيم: "يا شيخ" / "يا حلوة" / "يا غالي"
export function themeGreeting(themeId) {
  return getTheme(themeId).greeting;
}

// تحديث الـ placeholders/labels اللي فيها نداء بناءً على الثيم
// لو الثيم ما فيه greeting (زي "بنات" الرسمية)، النداء ينحذف ويتنظّف الفراغ
export function refreshThemeStrings(themeId) {
  const greeting = themeGreeting(themeId);
  document.querySelectorAll('[data-theme-greeting]').forEach((el) => {
    const tmpl = el.dataset.themeGreeting;
    let value = tmpl.replace('{greeting}', greeting);
    if (!greeting) {
      value = value.replace(/\s+/g, ' ').trim();
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = value;
    } else {
      el.textContent = value;
    }
  });
}

// Random helpers لكل ثيم
export function randomWaitingMessage(themeId) {
  const list = getTheme(themeId).waitingMessages;
  return list[Math.floor(Math.random() * list.length)];
}

export function randomWinnerTagline(themeId) {
  const list = getTheme(themeId).winnerTaglines;
  return list[Math.floor(Math.random() * list.length)];
}

// مفاتيح Giphy حسب الثيم
export function themeGiphyKeyword(themeId) {
  const list = getTheme(themeId).giphyKeywords;
  return list[Math.floor(Math.random() * list.length)];
}

// =====================================================
// 9) Helpers لاستخراج معلومات من الـ URL
// =====================================================
export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
