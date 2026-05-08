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

import { firebaseConfig, GIPHY_API_KEY } from './firebase-config.js';

// =====================================================
// 1) Firebase init - lazy singleton
// =====================================================
let _app = null;
let _db  = null;
let _auth = null;

export function initFirebase() {
  if (_app) return { app: _app, db: _db, auth: _auth };

  if (firebaseConfig.apiKey?.startsWith('REPLACE_ME')) {
    console.warn('[ياللي] Firebase config لسا فاضي - عبّيه في js/firebase-config.js');
  }

  _app  = initializeApp(firebaseConfig);
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

// إنشاء غرفة جديدة - الهوست يستدعيها
export async function createRoom(code, hostUid, hostName = 'الهوست') {
  const { db } = initFirebase();
  const roomData = {
    host: hostUid,
    state: STATES.LOBBY,
    createdAt: serverTimestamp(),
    players: {
      [hostUid]: {
        name: hostName,
        score: 0,
        finishedWriting: false,
        joinedAt: serverTimestamp(),
        isHost: true,
      }
    },
    questions: {},
    currentRound: null,
  };
  await set(ref(db, `rooms/${code}`), roomData);
}

// دخول لاعب لغرفة موجودة
export async function joinRoomAsPlayer(code, uid, name) {
  const { db } = initFirebase();

  // تأكد أن الغرفة موجودة
  const snap = await get(ref(db, `rooms/${code}`));
  if (!snap.exists()) {
    throw new Error('الغرفة مو موجودة');
  }
  const room = snap.val();
  if (room.state === STATES.FINISHED) {
    throw new Error('اللعبة خلصت يا شيخ');
  }

  // أضف اللاعب
  await update(ref(db, `rooms/${code}/players/${uid}`), {
    name,
    score: 0,
    finishedWriting: false,
    joinedAt: serverTimestamp(),
    isHost: false,
  });

  // اربط onDisconnect لإزالة اللاعب لو خرج
  onDisconnect(ref(db, `rooms/${code}/players/${uid}`)).remove();
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
export async function castVote(code, voterUid, votedForUid) {
  const { db } = initFirebase();
  if (voterUid === votedForUid) {
    throw new Error('ما تقدر تصوّت لنفسك يا شيخ');
  }
  await update(ref(db, `rooms/${code}/currentRound/votes`), {
    [voterUid]: votedForUid,
  });
}

// حساب الفائز للجولة الحالية + إضافة نقطة
export async function tallyAndCloseRound(code) {
  const { db } = initFirebase();
  const roundSnap = await get(ref(db, `rooms/${code}/currentRound`));
  if (!roundSnap.exists()) return null;

  const round = roundSnap.val();
  const votes = round.votes || {};
  const tally = {};
  Object.values(votes).forEach((uid) => {
    tally[uid] = (tally[uid] || 0) + 1;
  });

  // الفائز = اللي عنده أعلى عدد. لو تعادل، خذ أول واحد.
  let winnerUid = null;
  let max = -1;
  Object.entries(tally).forEach(([uid, count]) => {
    if (count > max) { max = count; winnerUid = uid; }
  });

  if (winnerUid) {
    // أضف نقطة للفائز - استخدم transaction علشان امان
    const scoreRef = ref(db, `rooms/${code}/players/${winnerUid}/score`);
    await runTransaction(scoreRef, (curr) => (curr || 0) + 1);
  }

  await update(ref(db, `rooms/${code}/currentRound`), { winnerUid, tally });
  await setRoomState(code, STATES.RESULTS);

  return { winnerUid, tally };
}

// إنهاء اللعبة
export async function finishGame(code) {
  await setRoomState(code, STATES.FINISHED);
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
// 5) Giphy
// =====================================================
const GIPHY_KEYWORDS = ['celebration', 'winner', 'funny', 'lol', 'crown', 'party', 'fire'];

export async function fetchRandomGif(keyword) {
  const k = keyword || GIPHY_KEYWORDS[Math.floor(Math.random() * GIPHY_KEYWORDS.length)];

  if (!GIPHY_API_KEY || GIPHY_API_KEY.startsWith('REPLACE_ME')) {
    console.warn('[ياللي] مفتاح Giphy ما تم ضبطه - راح نرجع GIF placeholder');
    return null;
  }

  try {
    const url = `https://api.giphy.com/v1/gifs/random?api_key=${encodeURIComponent(GIPHY_API_KEY)}&tag=${encodeURIComponent(k)}&rating=pg-13`;
    const res = await fetch(url);
    const json = await res.json();
    return json?.data?.images?.original?.url || json?.data?.images?.downsized_medium?.url || null;
  } catch (err) {
    console.error('Giphy fetch failed:', err);
    return null;
  }
}

// =====================================================
// 6) UI helpers
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
// 7) رسائل عشوائية مضحكة لشاشات الانتظار
// =====================================================
const WAITING_MESSAGES = [
  'يبيلها صبر... شكل فلان لسا يفكّر',
  'حسبتوها سهلة؟ خذوا وقتكم',
  'اللي يخلّص بمرجلة، عليه القهوة',
  'يا شيخ ما عندنا وقت',
  'فكّر في أحرج موقف صار لكم',
  'الفايز اللي عنده أجرأ سؤال',
  'لا تكتبون شي يحرج أمكم',
  'المحترش تكفي من السوالف',
  'خل المرجلة فيك واكتب',
  'الشلة كلها تنتظرك',
];

export function randomWaitingMessage() {
  return WAITING_MESSAGES[Math.floor(Math.random() * WAITING_MESSAGES.length)];
}

const WINNER_TAGLINES = [
  'الفايز هو',
  'صاحب الموقف',
  'بمرجلة',
  'يا حلاوة',
  'ولد الزين',
  'فكّوا حظكم',
  'هذا الرجّال',
];

export function randomWinnerTagline() {
  return WINNER_TAGLINES[Math.floor(Math.random() * WINNER_TAGLINES.length)];
}

// =====================================================
// 8) Helpers لاستخراج معلومات من الـ URL
// =====================================================
export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
