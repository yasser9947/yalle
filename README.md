# 🔥 ياللي - Yalli

> **لعبة الشلة** · Multiplayer party game لـ "مين فيكم...؟"
> صُنعت لشلة المحترش، وتنفع لأي مكان بالعالم 🌍

[![Made with Firebase](https://img.shields.io/badge/Realtime-Firebase-FFCA28?logo=firebase)](https://firebase.google.com)
[![Tailwind](https://img.shields.io/badge/UI-TailwindCSS-38BDF8?logo=tailwindcss)](https://tailwindcss.com)
[![Hosted on GitHub Pages](https://img.shields.io/badge/Hosting-GitHub_Pages-181717?logo=github)](https://pages.github.com)

---

## 🎮 وش هي اللعبة؟

لعبة جماعية أونلاين بأسلوب **Jackbox**. كل لاعب يكتب أسئلة "مين فيكم...؟"، وبعدين الكل يصوّت على اللاعب اللي ينطبق عليه السؤال. اللي تجمع له أكثر أصوات → فايز الجولة. أكثر واحد يجمع نقاط → الشامبيون.

### 🕹️ كيف تلعب؟
1. **الهوست** ينشئ غرفة → يطلع له كود من 6 أحرف + QR
2. **اللاعبين** يدخلون من جوالاتهم بالكود + اسم
3. **الكتابة**: كل واحد يكتب سؤال أو أكثر ("مين فيكم ينام في المحاضرة؟")
4. **التصويت**: يطلع سؤال عشوائي، الكل يصوّت (بدون كشف صاحب السؤال)
5. **النتيجة**: الفايز يطلع مع GIF احتفالي + نقطة
6. **الجولة الجاية**: الهوست يضغط "اللي بعده"
7. لما تخلص الأسئلة → شاشة الشامبيون النهائي 🏆

---

## 🛠️ التقنيات

| الطبقة | التقنية |
|---|---|
| Frontend | HTML + Vanilla JS (ES Modules) |
| Styling | TailwindCSS (CDN) + custom CSS |
| Realtime | Firebase Realtime Database |
| Auth | Firebase Anonymous Auth |
| GIFs | Giphy Random API |
| Hosting | GitHub Pages |
| Effects | canvas-confetti · qrcode.js |

**لا Node.js، لا npm.** كل شي يشتغل مباشرة في المتصفح.

---

## 🚀 التشغيل محلياً

ما يحتاج build step. أي static server يكفي:

```bash
cd yalli-game
python3 -m http.server 8000
# أو
npx serve .
```

افتح [http://localhost:8000](http://localhost:8000)

---

## 🔧 الإعداد

### 1) Firebase
- أنشئ مشروع في [Firebase Console](https://console.firebase.google.com)
- فعّل **Realtime Database** + **Anonymous Auth**
- انسخ الـ config إلى [`js/firebase-config.js`](js/firebase-config.js)
- ضيف **Security Rules** (راجع الـ instructions في الإعداد)

### 2) Giphy
- سجّل في [developers.giphy.com](https://developers.giphy.com)
- خذ API key مجاني → ضعه في `firebase-config.js` كـ `GIPHY_API_KEY`
- *اختياري* — اللعبة تشتغل بدونه بس بدون GIFs

### 3) النشر
```bash
git push origin main
```
GitHub Pages راح يعرضها على `https://USERNAME.github.io/yalli-game`

---

## 🎨 الفايب

- **Dark mode** بتدرج ليلي `#0F0F1E → #1A1A2E`
- **Gold accent** `#FFD700` يعكس صحراء نجد
- **Red warm** `#E94560` للـ accents الحارة
- **Glassmorphism** + **Neon glow**
- **Tajawal** للعربي، **Space Grotesk** للإنجليزي
- لمسات شبابية: "خلّصت والله"، "وش رايكم؟"، "يا الله يا شباب"

---

## 📁 هيكل المشروع

```
yalli-game/
├── index.html          # الشاشة الرئيسية (إنشاء/دخول)
├── host.html           # شاشة الهوست
├── player.html         # شاشة اللاعب
├── css/style.css       # animations, neon, glassmorphism
└── js/
    ├── firebase-config.js   # Firebase + Giphy keys
    ├── game-logic.js        # shared utilities + Firebase wrappers
    ├── host.js              # host state machine
    └── player.js            # player state machine
```

### Firebase Schema

```
rooms/
  {roomCode}/
    host: <uid>
    state: "lobby" | "writing" | "voting" | "results" | "finished"
    createdAt: <timestamp>
    players/
      {uid}: { name, score, finishedWriting, isHost }
    questions/
      {qid}: { text, authorUid, used }
    currentRound/
      questionId, questionText, votes: { voter: votedFor }, winnerUid, tally
```

---

## 💡 Roadmap

- [ ] Sound effects (freesound)
- [ ] Categories للأسئلة (شغل، دراسة، عيلة)
- [ ] Custom emoji per player
- [ ] Timer للتصويت
- [ ] Game history / re-watch
- [ ] PWA mode

---

## 🤝 Credits

- **Firebase** — realtime backend
- **Giphy** — celebration GIFs
- **TailwindCSS** — utility-first styling
- **canvas-confetti** ([catdad](https://github.com/catdad/canvas-confetti)) — party effects
- **qrcode.js** ([davidshimjs](https://github.com/davidshimjs/qrcodejs)) — QR generation
- **Google Fonts** — Tajawal · Space Grotesk

---

<div align="center">
  <strong>صُنعت بـ ❤️ لشلة المحترش 🌵</strong>
</div>
