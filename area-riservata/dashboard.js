// BioPhi · Area Riservata — guardia di autenticazione + Centrale Operativa
// UI e logica portate da BioPhi_Dashboard_Serale.html.
// Il layer di salvataggio (window.storage) è sostituito da Cloud Firestore
// con onSnapshot per la sincronizzazione in tempo reale tra i soci.

import { auth, db, firebaseErrorIt } from "../firebase-config.js";
import {
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc,
  getDocs, setDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ═══════════════ GUARDIA DI AUTENTICAZIONE ═══════════════ */
const gate   = document.getElementById("ar-gate");
const shell  = document.getElementById("ar-shell");
const userEl = document.getElementById("ar-user");

onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.replace("/area-riservata/index.html"); return; }
  userEl.textContent = user.email;
  gate.remove();                  // via del tutto il placeholder a tutto schermo
  shell.hidden = false;
  startDashboard();               // idempotente
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await signOut(auth); } finally { window.location.replace("/area-riservata/index.html"); }
});

/* ═══════════════ CENTRALE OPERATIVA ═══════════════ */
let started = false;
function startDashboard() {
  if (started) return;
  started = true;

  const CANTIERI = ["Raccolta fondi", "Biomasse", "Visibilità"];
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Nessun dato iniziale nel codice: al primo accesso la dashboard è vuota.
  // I dati reali vivono SOLO su Firestore. Per popolarla: "Importa da Excel"
  // (una volta), oppure aggiungili a mano dalla dashboard / console Firestore.

  /* ---- Riferimenti Firestore ---- */
  const tasksCol     = collection(db, "tasks");
  const deadlinesCol = collection(db, "deadlines");
  const emailsCol    = collection(db, "emails");
  const metaRef      = doc(db, "meta", "dashboard");

  /* ---- Stato locale (specchio dei dati Firestore) ---- */
  let tasks = [], deadlines = [], emails = [], lastImport = null;
  const ready = { tasks: false, deadlines: false, emails: false };
  let importing = false;

  const app = document.getElementById("app");
  app.innerHTML = '<div class="loading">Carico il tuo cruscotto…</div>';

  /* ---- Listener realtime ---- */
  const onErr = (label) => (err) =>
    console.error("Firestore [" + label + "]:", firebaseErrorIt(err.code) || err.message);

  onSnapshot(tasksCol, (snap) => {
    tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    ready.tasks = true; render();
  }, onErr("tasks"));

  onSnapshot(deadlinesCol, (snap) => {
    deadlines = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    ready.deadlines = true; render();
  }, onErr("deadlines"));

  onSnapshot(emailsCol, (snap) => {
    emails = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    ready.emails = true; render();
  }, onErr("emails"));

  onSnapshot(metaRef, (snap) => {
    lastImport = snap.exists() ? (snap.data().lastImport || null) : null;
    render();
  }, onErr("meta"));

  /* ═══════════ IMPORT DA EXCEL ═══════════ */
  function sheetToRows(wb, name) {
    const ws = wb.Sheets[name];
    if (!ws) return null;
    return XLSX.utils.sheet_to_json(ws, { defval: "" });
  }
  function asDateStr(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "number") {
      const d = XLSX.SSF.parse_date_code(v);
      if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    return (v || "").toString().trim();
  }

  // Sostituisce l'intero contenuto di una collection (import = replace, come l'originale)
  async function replaceCollection(col, rows) {
    const existing = await getDocs(col);
    const batch = writeBatch(db);
    existing.forEach((d) => batch.delete(d.ref));
    rows.forEach((r) => batch.set(doc(col), r));
    await batch.commit();
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (importing) return;
      importing = true;
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });

        const jobs = [];
        const taskRows = sheetToRows(wb, "Task");
        if (taskRows) {
          jobs.push(replaceCollection(tasksCol, taskRows
            .filter((r) => r["Attività"])
            .map((r) => ({
              cantiere: r["Cantiere"] || "Altro",
              text: r["Attività"] || "",
              priorita: r["Priorità"] || "Media",
              scadenza: asDateStr(r["Scadenza"]),
              stato: r["Stato"] || "Da iniziare",
              tonight: false,
              azione: r["Prossima azione concreta"] || "",
              note: r["Note"] || "",
            }))));
        }
        const deadRows = sheetToRows(wb, "Scadenze chiave");
        if (deadRows) {
          jobs.push(replaceCollection(deadlinesCol, deadRows
            .filter((r) => r["Milestone / Evento"])
            .map((r) => ({
              name: r["Milestone / Evento"] || "",
              data: asDateStr(r["Data"]),
              cantiere: r["Cantiere"] || "",
              stato: r["Stato"] || "Da fare",
              note: r["Note"] || "",
            }))));
        }
        const emailRows = sheetToRows(wb, "Email");
        if (emailRows) {
          jobs.push(replaceCollection(emailsCol, emailRows
            .filter((r) => r["Destinatario"] && (r["Stato"] || "") !== "Chiusa")
            .map((r) => ({
              who: r["Destinatario"] || "",
              ctx: r["Oggetto / contesto"] || "",
              cantiere: r["Cantiere"] || "",
              stato: r["Stato"] || "Da inviare",
              next: asDateStr(r["Prossimo controllo"]) || new Date().toISOString().slice(0, 10),
              note: r["Note"] || "",
            }))));
        }

        if (!jobs.length) {
          alert('Nessun foglio riconosciuto. Servono i fogli "Task", "Scadenze chiave", "Email".');
          return;
        }
        await Promise.all(jobs);
        await setDoc(metaRef, {
          lastImport: new Date().toLocaleString("it-IT"),
        }, { merge: true });
      } catch (err) {
        console.error(err);
        alert('Non sono riuscito a leggere il file. Controlla che sia il file "BioPhi_Sistema_di_Gestione.xlsx" con i fogli Task, Scadenze chiave, Email.');
      } finally {
        importing = false;
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /* ═══════════ EXPORT VERSO EXCEL ═══════════ */
  function exportToExcel() {
    const wb = XLSX.utils.book_new();
    const taskRows = tasks.map((t) => ({
      "Cantiere": t.cantiere, "Attività": t.text, "Priorità": t.priorita,
      "Scadenza": t.scadenza, "Stato": t.stato,
      "Prossima azione concreta": t.azione || "", "Note": t.note || "",
    }));
    const deadRows = deadlines.map((d) => ({
      "Data": d.data, "Milestone / Evento": d.name, "Cantiere": d.cantiere || "",
      "Stato": d.stato || "Da fare", "Note": d.note || "",
    }));
    const emailRows = emails.map((e) => ({
      "Destinatario": e.who, "Oggetto / contesto": e.ctx, "Cantiere": e.cantiere || "",
      "Stato": e.stato || "Da inviare", "Data invio": "", "Prossimo controllo": e.next, "Note": e.note || "",
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(taskRows), "Task");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deadRows), "Scadenze chiave");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(emailRows), "Email");
    XLSX.writeFile(wb, "BioPhi_Dashboard_Export_" + new Date().toISOString().slice(0, 10) + ".xlsx");
  }

  /* ═══════════ HELPER ═══════════ */
  function daysUntil(dateStr) {
    const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }
  function fmtDate(dateStr) {
    return new Date(dateStr).toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
  }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function pickTonight() {
    const open = tasks.filter((t) => t.stato !== "Fatto");
    const marked = open.filter((t) => t.tonight);
    if (marked.length) return marked.slice(0, 5);
    const order = { Alta: 0, Media: 1, Bassa: 2 };
    return [...open]
      .sort((a, b) => (order[a.priorita] ?? 3) - (order[b.priorita] ?? 3)
        || new Date(a.scadenza) - new Date(b.scadenza))
      .slice(0, 3);
  }

  /* ═══════════ MUTAZIONI → Firestore (onSnapshot ridisegna) ═══════════ */
  function toggleDone(id) {
    const t = tasks.find((x) => x.id === id);
    if (t) updateDoc(doc(tasksCol, id), { stato: t.stato === "Fatto" ? "Da iniziare" : "Fatto" });
  }
  function toggleTonight(id) {
    const t = tasks.find((x) => x.id === id);
    if (t) updateDoc(doc(tasksCol, id), { tonight: !t.tonight });
  }
  function addQuick(text) {
    if (!text.trim()) return;
    addDoc(tasksCol, {
      cantiere: "Altro", text: text.trim(), priorita: "Media",
      scadenza: new Date().toISOString().slice(0, 10),
      stato: "Da iniziare", tonight: true, azione: "", note: "",
      createdAt: serverTimestamp(),
    });
  }
  function snoozeEmail(id) {
    const d = new Date(); d.setDate(d.getDate() + 3);
    updateDoc(doc(emailsCol, id), { next: d.toISOString().slice(0, 10) });
  }
  function doneEmail(id) {
    deleteDoc(doc(emailsCol, id));
  }

  /* ═══════════ RENDER ═══════════ */
  function render() {
    if (!(ready.tasks && ready.deadlines && ready.emails)) {
      app.innerHTML = '<div class="loading">Carico il tuo cruscotto…</div>';
      return;
    }

    const tonight = pickTonight();
    const PRIO_ORDER = { Alta: 0, Media: 1, Bassa: 2 };
    const taskTime = (t) => {
      const ms = new Date(t.scadenza).getTime();
      return Number.isNaN(ms) ? Infinity : ms;   // task senza scadenza in fondo
    };
    // Task aperti del cantiere, ordinati per scadenza più imminente (poi priorità)
    const openTasksByCantiere = (c) => tasks
      .filter((t) => t.cantiere === c && t.stato !== "Fatto")
      .sort((a, b) => taskTime(a) - taskTime(b)
        || (PRIO_ORDER[a.priorita] ?? 3) - (PRIO_ORDER[b.priorita] ?? 3));
    const MAX_TASK_PER_CANTIERE = 5;
    const sortedDeadlines = [...deadlines].sort((a, b) => new Date(a.data) - new Date(b.data)).slice(0, 6);
    const sortedEmails = [...emails].sort((a, b) => new Date(a.next) - new Date(b.next));

    const now = new Date();
    const isEvening = now.getHours() >= 18 || now.getHours() < 6;

    app.innerHTML = `
      <div class="header">
        <div>
          <h1>BioPhi — Centrale Operativa</h1>
          <div class="sub">${isEvening ? "Sessione serale — scegli poche cose, falle bene" : "Vista rapida dei tre cantieri"}${lastImport ? " · ultimo import: " + lastImport : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div class="clock">${now.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long" })}</div>
          <label class="io-btn" for="import-input">Importa da Excel</label>
          <input id="import-input" type="file" accept=".xlsx" style="display:none;"/>
          <button class="io-btn" id="export-btn">Esporta Excel</button>
        </div>
      </div>

      <div class="quickadd">
        <input id="qa-input" type="text" placeholder="Aggiungi al volo qualcosa da non dimenticare… (invio per salvare)"/>
        <button id="qa-btn">Aggiungi</button>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Stasera <span class="tag">max 3 cose</span></h2>
          ${tonight.length ? tonight.map((t) => `
            <div class="tonight-item">
              <input type="checkbox" ${t.stato === "Fatto" ? "checked" : ""} data-toggle="${t.id}"/>
              <div class="txt">
                <div class="${t.stato === "Fatto" ? "done" : ""}">${escapeHtml(t.text)}</div>
                <div class="meta">${escapeHtml(t.cantiere)} · scad. ${fmtDate(t.scadenza)}</div>
              </div>
            </div>`).join("") : '<div class="empty">Niente in coda. Aggiungi qualcosa qui sopra.</div>'}
        </div>

        <div class="card">
          <h2>Scadenze imminenti</h2>
          ${sortedDeadlines.map((d) => {
            const days = daysUntil(d.data);
            const cls = days <= 14 ? "soon" : days <= 45 ? "mid" : "far";
            const label = days < 0 ? "passata" : days === 0 ? "oggi" : `tra ${days}g`;
            return `<div class="deadline-row"><div class="name">${escapeHtml(d.name)}</div><div class="days ${cls}">${label}</div></div>`;
          }).join("")}
        </div>
      </div>

      <div class="cantieri">
        ${CANTIERI.map((c) => {
          const all = openTasksByCantiere(c);
          const items = all.slice(0, MAX_TASK_PER_CANTIERE);
          const hidden = all.length - items.length;
          return `<div class="cant-col">
            <h3>${escapeHtml(c)} <span>${all.length}</span></h3>
            ${items.length ? items.map((t) => `
              <div class="task">
                <div class="top">
                  <span class="prio ${t.priorita}"></span>
                  <span class="name">${escapeHtml(t.text)}</span>
                </div>
                <div class="actions">
                  <button data-toggle="${t.id}">${t.stato === "Fatto" ? "riapri" : "fatto"}</button>
                  <button data-tonight="${t.id}">${t.tonight ? "✓ stasera" : "metti stasera"}</button>
                </div>
              </div>`).join("") : '<div class="empty">Tutto fatto qui.</div>'}
            ${hidden > 0 ? `<div class="cant-more">+${hidden} meno urgenti — esporta l'Excel per l'elenco completo</div>` : ""}
          </div>`;
        }).join("")}
      </div>

      <div class="card">
        <h2>Email in sospeso</h2>
        ${sortedEmails.length ? sortedEmails.map((e) => {
          const days = daysUntil(e.next);
          const urgent = days <= 0;
          return `<div class="email-row">
            <div style="flex:1">
              <div class="who">${escapeHtml(e.who)}</div>
              <div class="ctx">${escapeHtml(e.ctx)}</div>
            </div>
            <div class="when" style="${urgent ? "color:var(--ar-urgent)" : ""}">${days <= 0 ? "da fare oggi" : "tra " + days + "g"}</div>
            <button data-snooze="${e.id}">+3g</button>
            <button data-doneemail="${e.id}">fatta</button>
          </div>`;
        }).join("") : '<div class="empty">Nessun follow-up in sospeso.</div>'}
      </div>
    `;

    document.getElementById("import-input").onchange = (ev) => {
      const file = ev.target.files[0];
      if (file) handleImportFile(file);
    };
    document.getElementById("export-btn").onclick = exportToExcel;

    document.getElementById("qa-btn").onclick = () => {
      const inp = document.getElementById("qa-input");
      addQuick(inp.value); inp.value = "";
    };
    document.getElementById("qa-input").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { addQuick(ev.target.value); ev.target.value = ""; }
    });

    app.querySelectorAll("[data-toggle]").forEach((el) =>
      el.onclick = () => toggleDone(el.getAttribute("data-toggle")));
    app.querySelectorAll("[data-tonight]").forEach((el) =>
      el.onclick = () => toggleTonight(el.getAttribute("data-tonight")));
    app.querySelectorAll("[data-snooze]").forEach((el) =>
      el.onclick = () => snoozeEmail(el.getAttribute("data-snooze")));
    app.querySelectorAll("[data-doneemail]").forEach((el) =>
      el.onclick = () => doneEmail(el.getAttribute("data-doneemail")));
  }
}
