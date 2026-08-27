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

function showMsg(text, kind = "error") {
  msgEl.textContent = text;
  msgEl.className = "ar-msg" + (text ? " ar-msg--" + kind : "");
}

// Se l'utente è già autenticato, salta il login e vai alla dashboard.
onAuthStateChanged(auth, (user) => {
  if (user) window.location.replace("dashboard.html");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showMsg("");

  const email = emailEl.value.trim();
  const pass  = passEl.value;
  if (!email || !pass) { showMsg("Inserisci email e password."); return; }

  loginBtn.disabled = true;
  loginBtn.textContent = "Accesso in corso…";
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    window.location.replace("dashboard.html");
  } catch (err) {
    showMsg(firebaseErrorIt(err.code));
    loginBtn.disabled = false;
    loginBtn.textContent = "Accedi";
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
