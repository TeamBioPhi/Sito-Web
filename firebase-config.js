// ============================================================
//  BioPhi S.r.l. · Configurazione Firebase (client)
// ------------------------------------------------------------
//  COME COMPILARE QUESTO FILE
//  1. Vai su https://console.firebase.google.com e crea il progetto.
//  2. Impostazioni progetto → "Le tue app" → aggiungi un'app Web (</>).
//  3. Copia i valori dell'oggetto `firebaseConfig` che ti mostra la console
//     e sostituisci qui sotto TUTTI i placeholder "INSERISCI_...".
//
//  NOTA DI SICUREZZA: queste chiavi NON sono segrete. Sono progettate per
//  stare nel codice client ed essere pubbliche. La protezione dei dati è
//  garantita da: (a) Authentication con whitelist chiusa (registrazione
//  disabilitata) e (b) le Security Rules di Firestore.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyC76yQ6m-FXZf0n6cTl6ylrrCw58pq4lbA",
    authDomain: "biophi-area-riservata.firebaseapp.com",
    projectId: "biophi-area-riservata",
    storageBucket: "biophi-area-riservata.firebasestorage.app",
    messagingSenderId: "242806307245",
    appId: "1:242806307245:web:1144fcb4cab4cc69cb4924"
  };

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// Traduzione codici errore Firebase → messaggi in italiano
export function firebaseErrorIt(code) {
  const map = {
    "auth/invalid-email":            "Indirizzo email non valido.",
    "auth/missing-password":         "Inserisci la password.",
    "auth/invalid-credential":       "Email o password non corretti.",
    "auth/wrong-password":           "Password errata.",
    "auth/user-not-found":           "Nessun utente registrato con questa email.",
    "auth/user-disabled":            "Questo account è stato disabilitato.",
    "auth/too-many-requests":        "Troppi tentativi falliti. Riprova tra qualche minuto.",
    "auth/weak-password":            "La password deve avere almeno 6 caratteri.",
    "auth/network-request-failed":   "Connessione assente. Controlla la rete e riprova.",
    "auth/invalid-api-key":          "Configurazione Firebase mancante o errata: completa firebase-config.js.",
    "auth/operation-not-allowed":    "Metodo di accesso non abilitato nella console Firebase.",
    "permission-denied":             "Permessi insufficienti: controlla le Security Rules di Firestore.",
  };
  return map[code] || "Si è verificato un errore imprevisto. Riprova.";
}
