// ==========================================================================
// تهيئة Firebase مشتركة — يستوردها app.js (الأداة السريعة) و main-game.js
// ==========================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyA6iSOCKWGXMxwAjXkjvQgaT36XhEuDqKk",
  authDomain: "mafia-game-6dd99.firebaseapp.com",
  databaseURL: "https://mafia-game-6dd99-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "mafia-game-6dd99",
  storageBucket: "mafia-game-6dd99.firebasestorage.app",
  messagingSenderId: "912686202474",
  appId: "1:912686202474:web:440d6a8a14e29a198b1413",
};

const fbApp = initializeApp(firebaseConfig);
export const db = getDatabase(fbApp);
