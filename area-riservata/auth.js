// BioPhi · Area Riservata — logica pagina di login
import { auth, firebaseErrorIt } from "../firebase-config.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const form     = document.getElementById("login-form");
const emailEl   = document.getElementById("email");
const passEl    = document.getElementById("password");
const loginBtn  = document.getElementById("login-btn");
const resetBtn  = document.getElementById("reset-btn");
const msgEl     = document.getElementById("msg");

const DASHBOARD_URL = "/area-riservata/dashboard.html";

function showMsg(text, kind = "error") {
  msgEl.textContent = text;
  msgEl.className = "ar-msg" + (text ? " ar-msg--" + kind : "");
}

function setLoading(on) {
  loginBtn.disabled = on;
  loginBtn.textContent = on ? "Accesso in corso…" : "Accedi";
}

// Ripristina lo stato del bottone anche quando la pagina torna dalla
// cache di navigazione (tasto "indietro" del browser): in quel caso gli
// script del modulo non vengono rieseguiti.
window.addEventListener("pageshow", () => setLoading(false));

// Se l'utente è già autenticato, salta il login e vai alla dashboard.
onAuthStateChanged(auth, (user) => {
  if (user) window.location.replace(DASHBOARD_URL);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showMsg("");

  const email = emailEl.value.trim();
  const pass  = passEl.value;
  if (!email || !pass) { showMsg("Inserisci email e password."); return; }

  setLoading(true);
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    window.location.replace(DASHBOARD_URL);
  } catch (err) {
    showMsg(firebaseErrorIt(err.code));
    setLoading(false);
  }
});

resetBtn.addEventListener("click", async () => {
  const email = emailEl.value.trim();
  if (!email) {
    showMsg("Scrivi prima la tua email nel campo qui sopra, poi premi di nuovo “Password dimenticata?”.");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    showMsg("Email inviata: controlla la posta per reimpostare la password.", "ok");
  } catch (err) {
    showMsg(firebaseErrorIt(err.code));
  }
});
