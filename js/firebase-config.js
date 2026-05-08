// =====================================================
// Firebase + Giphy Config
// -----------------------------------------------------
// عبّي القيم اللي راح تجيك من Firebase Console + Giphy.
// Firebase: Project Settings → General → Your apps → SDK setup
// Giphy:    https://developers.giphy.com → My Apps → API Key
// =====================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyB6suvwX3LNtCLFgiw6OCMXvN7M8zVPV1c",
  authDomain:        "yallale.firebaseapp.com",
  databaseURL:       "https://yallale-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "yallale",
  storageBucket:     "yallale.firebasestorage.app",
  messagingSenderId: "1027047448861",
  appId:             "1:1027047448861:web:84fc51ac7c3dc49c7781f4",
  measurementId:     "G-QDGMR94W41",
};

// مفتاح Giphy (مجاني - https://developers.giphy.com)
// لو ما عبّيته، اللعبة تشتغل عادي بس ما راح يطلع GIF.
export const GIPHY_API_KEY = "hXJXZSgVi6150aWY3OKDkgQsE4Hq4JkE";

// App Check reCAPTCHA v3 site key (اختياري لكن منصوح به).
// اتركه فاضي إذا ما تبي تفعّل App Check حالياً.
export const RECAPTCHA_SITE_KEY = "";
