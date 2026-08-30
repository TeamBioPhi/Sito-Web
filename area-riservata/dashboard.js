// BioPhi · Area Riservata — guardia di autenticazione + Centrale Operativa
//
// Dashboard a 3 livelli (vedi ARCHITETTURA.md §10):
//   Livello 1 — Vincoli   : deadlines + documenti in stallo (sempre visibile)
//   Livello 2 — Focus attivo : max 3 iniziative per cantiere reale
//   Livello 3 — Routine   : template di cadenza (collassato di default)
//
// Storage: Cloud Firestore + onSnapshot (sync realtime tra i soci).
// L'urgenza è DERIVATA dalla data, non dal campo `priorita` compilato a mano.

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
  gate.remove();
  shell.hidden = false;
  startDashboard();               // idempotente
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await signOut(auth); } finally { window.location.replace("/area-riservata/index.html"); }
});

/* ═══════════════ CENTRALE OPERATIVA ═══════════════ */
const CANTIERI = ["Raccolta fondi", "Biomasse", "Visibilità"];
const PRIO_ORDER = { Alta: 0, Media: 1, Bassa: 2 };
const MAX_INIZIATIVE_PER_CANTIERE = 3;
const DOC_STALE_GIORNI = 30;
const DOC_STATI_ALERT = ["Da creare", "Da verificare"];

let started = false;
function startDashboard() {
  if (started) return;
  started = true;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const myEmail = () => auth.currentUser?.email || "";

  /* ---- Riferimenti Firestore ---- */
  const tasksCol     = collection(db, "tasks");
  const deadlinesCol = collection(db, "deadlines");
  const emailsCol    = collection(db, "emails");
  const routineCol   = collection(db, "routine");
  const documentsCol = collection(db, "documents");
  const metaRef      = doc(db, "meta", "dashboard");

  /* ---- Stato locale (specchio di Firestore) ---- */
  let tasks = [], deadlines = [], emails = [], routines = [], documents = [];
  let lastImport = null;
  let myTasksOnly = false;            // filtro "i miei task" (persiste tra i render)
  const ready = { tasks: false, deadlines: false, emails: false, routine: false, documents: false };
  let importing = false;

  const app = document.getElementById("app");
  app.innerHTML = '<div class="loading">Carico il tuo cruscotto…</div>';

  /* ---- Listener realtime ---- */
  const onErr = (label) => (err) =>
    console.error("Firestore [" + label + "]:", firebaseErrorIt(err.code) || err.message);
  const sub = (col, key, target) => onSnapshot(col, (snap) => {
    target.splice(0, target.length, ...snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    ready[key] = true; render();
  }, onErr(key));

  sub(tasksCol,     "tasks",     tasks);
  sub(deadlinesCol, "deadlines", deadlines);
  sub(emailsCol,    "emails",    emails);
  sub(routineCol,   "routine",   routines);
  sub(documentsCol, "documents", documents);

  onSnapshot(metaRef, (snap) => {
    lastImport = snap.exists() ? (snap.data().lastImport || null) : null;
    render();
  }, onErr("meta"));

  /* ═══════════ HELPER DATE / TESTO ═══════════ */
  function daysUntil(dateStr) {
    const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
    const n = Math.round((d - today) / 86400000);
    return Number.isNaN(n) ? null : n;
  }
  function fmtDate(dateStr) {
    const d = new Date(dateStr);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
  }
  function dateSortKey(dateStr) {
    const ms = new Date(dateStr).getTime();
    return Number.isNaN(ms) ? Infinity : ms;
  }
  function advanceDate(dateStr, cadenza) {
    const d = new Date(dateStr + "T00:00:00");
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    if (cadenza === "mensile") d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Badge di urgenza DERIVATO dalla data (unica fonte di verità per l'urgenza)
  function urgencyBadge(dateStr) {
    const days = daysUntil(dateStr);
    if (days === null) return '<span class="days far">nessuna data</span>';
    const cls = days <= 14 ? "soon" : days <= 45 ? "mid" : "far";
    const label = days < 0 ? "in ritardo" : days === 0 ? "oggi" : `tra ${days}g`;
    return `<span class="days ${cls}">${label}</span>`;
  }

  const isDeadlineOpen = (d) => !/fatt|complet|chius/i.test(d.stato || "");
  function docIsAlert(dc) {
    if (!DOC_STATI_ALERT.includes(dc.stato)) return false;
    if (!dc.ultimoAggiornamento) return true;
    const since = daysUntil(dc.ultimoAggiornamento);
    return since === null || -since > DOC_STALE_GIORNI;
  }
  const taskTipo = (t) => (t.tipo === "routine" ? "routine" : "iniziativa");
  const deadlineName = (id) => deadlines.find((d) => d.id === id)?.name || "";

  function assigneeOptions() {
    const set = new Set(tasks.map((t) => t.assignee).filter(Boolean));
    if (myEmail()) set.add(myEmail());
    return [...set].sort();
  }
  const assigneeLabel = (a) => !a ? "" : a === myEmail() ? "io" : a.split("@")[0];

  /* ═══════════ MUTAZIONI ═══════════ */
  const toggleDone = (id) => {
    const t = tasks.find((x) => x.id === id);
    if (t) updateDoc(doc(tasksCol, id), { stato: t.stato === "Fatto" ? "Da iniziare" : "Fatto" });
  };
  const toggleTonight = (id) => {
    const t = tasks.find((x) => x.id === id);
    if (t) updateDoc(doc(tasksCol, id), { tonight: !t.tonight });
  };
  function addQuick(text, cantiere) {
    if (!text.trim()) return;
    addDoc(tasksCol, {
      cantiere: CANTIERI.includes(cantiere) ? cantiere : CANTIERI[0],
      text: text.trim(), tipo: "iniziativa", priorita: "Media",
      scadenza: "", stato: "Da iniziare", tonight: true,
      assignee: null, linkedDeadlineId: null, azione: "", note: "",
      createdAt: serverTimestamp(),
    });
  }
  const snoozeEmail = (id) => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    updateDoc(doc(emailsCol, id), { next: d.toISOString().slice(0, 10) });
  };
  const doneEmail = (id) => deleteDoc(doc(emailsCol, id));

  function routineDone(id) {
    const r = routines.find((x) => x.id === id);
    if (r) updateDoc(doc(routineCol, id), { prossimaOccorrenza: advanceDate(r.prossimaOccorrenza, r.cadenza) });
  }
  const routineToggle = (id) => {
    const r = routines.find((x) => x.id === id);
    if (r) updateDoc(doc(routineCol, id), { attiva: r.attiva === false });
  };
  function addRoutine(label, cadenza) {
    if (!label.trim()) return;
    addDoc(routineCol, {
      label: label.trim(), cantiere: CANTIERI[0],
      cadenza: cadenza === "mensile" ? "mensile" : "settimanale",
      prossimaOccorrenza: advanceDate(new Date().toISOString().slice(0, 10), cadenza),
      attiva: true,
    });
  }

  /* ═══════════ MODALE MODIFICA TASK ═══════════ */
  const dlg = document.getElementById("task-dialog");
  const dlgForm = document.getElementById("task-form");
  const dlgTitle = document.getElementById("task-dialog-title");
  const dlgDelete = document.getElementById("task-delete");
  let editingId = null;

  function openTaskModal(id) {
    editingId = id || null;
    const t = (id && tasks.find((x) => x.id === id)) || {};
    dlgTitle.textContent = id ? "Modifica task" : "Nuovo task";
    dlgDelete.hidden = !id;

    dlgForm.linkedDeadlineId.innerHTML = '<option value="">— nessun vincolo —</option>' +
      [...deadlines].filter(isDeadlineOpen).sort((a, b) => dateSortKey(a.data) - dateSortKey(b.data))
        .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");
    dlgForm.assignee.innerHTML = '<option value="">— nessuno —</option>' +
      assigneeOptions().map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");

    const stati = ["Da iniziare", "In corso", "In attesa", "Fatto"];
    if (t.stato && !stati.includes(t.stato)) stati.unshift(t.stato);  // conserva valori non standard
    dlgForm.stato.innerHTML = stati.map((s) => `<option>${escapeHtml(s)}</option>`).join("");

    dlgForm.text.value = t.text || "";
    dlgForm.cantiere.value = CANTIERI.includes(t.cantiere) ? t.cantiere : CANTIERI[0];
    dlgForm.tipo.value = taskTipo(t);
    dlgForm.priorita.value = t.priorita || "Media";
    dlgForm.scadenza.value = /^\d{4}-\d{2}-\d{2}$/.test(t.scadenza) ? t.scadenza : "";
    dlgForm.stato.value = t.stato || "Da iniziare";
    dlgForm.assignee.value = t.assignee || "";
    dlgForm.linkedDeadlineId.value = t.linkedDeadlineId || "";
    dlgForm.azione.value = t.azione || "";
    dlgForm.note.value = t.note || "";
    dlg.showModal();
  }

  dlgForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = {
      text: dlgForm.text.value.trim(),
      cantiere: dlgForm.cantiere.value,
      tipo: dlgForm.tipo.value,
      priorita: dlgForm.priorita.value,
      scadenza: dlgForm.scadenza.value || "",
      stato: dlgForm.stato.value,
      assignee: dlgForm.assignee.value || null,
      linkedDeadlineId: dlgForm.linkedDeadlineId.value || null,
      azione: dlgForm.azione.value.trim(),
      note: dlgForm.note.value.trim(),
    };
    if (!payload.text) return;
    if (editingId) updateDoc(doc(tasksCol, editingId), payload);
    else addDoc(tasksCol, { ...payload, tonight: false, createdAt: serverTimestamp() });
    dlg.close();
  });
  dlgDelete.addEventListener("click", () => {
    if (editingId && confirm("Eliminare definitivamente questo task?")) {
      deleteDoc(doc(tasksCol, editingId));
      dlg.close();
    }
  });
  document.getElementById("task-cancel").addEventListener("click", () => dlg.close());

  /* ═══════════ IMPORT / EXPORT EXCEL ═══════════ */
  function sheetToRows(wb, name) {
    const ws = wb.Sheets[name];
    return ws ? XLSX.utils.sheet_to_json(ws, { defval: "" }) : null;
  }
  function asDateStr(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "number") {
      const d = XLSX.SSF.parse_date_code(v);
      if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    return (v || "").toString().trim();
  }
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
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const jobs = [];

        const taskRows = sheetToRows(wb, "Task");
        if (taskRows) jobs.push(replaceCollection(tasksCol, taskRows
          .filter((r) => r["Attività"])
          .map((r) => ({
            cantiere: CANTIERI.includes(r["Cantiere"]) ? r["Cantiere"] : CANTIERI[0],
            text: r["Attività"] || "",
            tipo: (r["Tipo"] || "").toLowerCase() === "routine" ? "routine" : "iniziativa",
            priorita: r["Priorità"] || "Media",
            scadenza: asDateStr(r["Scadenza"]),
            stato: r["Stato"] || "Da iniziare",
            tonight: false,
            assignee: (r["Assegnatario"] || "").toString().trim() || null,
            linkedDeadlineId: null,
            azione: r["Prossima azione concreta"] || "",
            note: r["Note"] || "",
          }))));

        const deadRows = sheetToRows(wb, "Scadenze chiave");
        if (deadRows) jobs.push(replaceCollection(deadlinesCol, deadRows
          .filter((r) => r["Milestone / Evento"])
          .map((r) => ({
            name: r["Milestone / Evento"] || "", data: asDateStr(r["Data"]),
            cantiere: r["Cantiere"] || "", stato: r["Stato"] || "Da fare", note: r["Note"] || "",
          }))));

        const emailRows = sheetToRows(wb, "Email");
        if (emailRows) jobs.push(replaceCollection(emailsCol, emailRows
          .filter((r) => r["Destinatario"] && (r["Stato"] || "") !== "Chiusa")
          .map((r) => ({
            who: r["Destinatario"] || "", ctx: r["Oggetto / contesto"] || "",
            cantiere: r["Cantiere"] || "", stato: r["Stato"] || "Da inviare",
            next: asDateStr(r["Prossimo controllo"]) || new Date().toISOString().slice(0, 10),
            note: r["Note"] || "",
          }))));

        const docRows = sheetToRows(wb, "Documenti");
        if (docRows) jobs.push(replaceCollection(documentsCol, docRows
          .filter((r) => r["Documento"])
          .map((r) => ({
            documento: r["Documento"] || "", cantiere: r["Cantiere"] || "",
            versione: (r["Versione"] || "").toString(), ultimoAggiornamento: asDateStr(r["Ultimo aggiornamento"]),
            stato: r["Stato"] || "", dove: r["Dove"] || "", note: r["Note"] || "",
          }))));

        const routRows = sheetToRows(wb, "Routine");
        if (routRows) jobs.push(replaceCollection(routineCol, routRows
          .filter((r) => r["Attività"])
          .map((r) => ({
            label: r["Attività"] || "", cantiere: r["Cantiere"] || CANTIERI[0],
            cadenza: (r["Cadenza"] || "").toLowerCase() === "mensile" ? "mensile" : "settimanale",
            prossimaOccorrenza: asDateStr(r["Prossima occorrenza"]) || new Date().toISOString().slice(0, 10),
            attiva: !/^(no|falso|false|0)$/i.test((r["Attiva"] || "").toString().trim()),
          }))));

        if (!jobs.length) {
          alert('Nessun foglio riconosciuto. Attesi: "Task", "Scadenze chiave", "Email", "Documenti", "Routine".');
          return;
        }
        await Promise.all(jobs);
        await setDoc(metaRef, { lastImport: new Date().toLocaleString("it-IT") }, { merge: true });
      } catch (err) {
        console.error(err);
        alert('Non sono riuscito a leggere il file. Controlla i nomi dei fogli e delle colonne.');
      } finally {
        importing = false;
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function exportToExcel() {
    const wb = XLSX.utils.book_new();
    const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
    add(tasks.map((t) => ({
      "Cantiere": t.cantiere, "Attività": t.text, "Tipo": taskTipo(t), "Priorità": t.priorita,
      "Scadenza": t.scadenza || "", "Stato": t.stato, "Assegnatario": t.assignee || "",
      "Vincolo collegato": deadlineName(t.linkedDeadlineId), "Prossima azione concreta": t.azione || "", "Note": t.note || "",
    })), "Task");
    add(deadlines.map((d) => ({
      "Data": d.data, "Milestone / Evento": d.name, "Cantiere": d.cantiere || "",
      "Stato": d.stato || "Da fare", "Note": d.note || "",
    })), "Scadenze chiave");
    add(emails.map((e) => ({
      "Destinatario": e.who, "Oggetto / contesto": e.ctx, "Cantiere": e.cantiere || "",
      "Stato": e.stato || "Da inviare", "Data invio": "", "Prossimo controllo": e.next, "Note": e.note || "",
    })), "Email");
    add(documents.map((d) => ({
      "Documento": d.documento, "Cantiere": d.cantiere || "", "Versione": d.versione || "",
      "Ultimo aggiornamento": d.ultimoAggiornamento || "", "Stato": d.stato || "", "Dove": d.dove || "", "Note": d.note || "",
    })), "Documenti");
    add(routines.map((r) => ({
      "Attività": r.label, "Cantiere": r.cantiere || "", "Cadenza": r.cadenza || "",
      "Prossima occorrenza": r.prossimaOccorrenza || "", "Attiva": r.attiva === false ? "no" : "sì",
    })), "Routine");
    XLSX.writeFile(wb, "BioPhi_Dashboard_Export_" + new Date().toISOString().slice(0, 10) + ".xlsx");
  }

  /* ═══════════ DATI DI ESEMPIO (fittizi, per il test locale) ═══════════ */
  async function loadSampleData() {
    if (!confirm("Carico un set di dati di ESEMPIO (fittizi) per provare la dashboard?")) return;
    const soon = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const batch = writeBatch(db);
    [
      { cantiere: "Raccolta fondi", text: "Bozza pitch deck v1", tipo: "iniziativa", priorita: "Alta", scadenza: soon(5), stato: "In corso", tonight: true, azione: "Struttura 12 slide", note: "" },
      { cantiere: "Raccolta fondi", text: "Compilare business plan sezione mercato", tipo: "iniziativa", priorita: "Media", scadenza: soon(12), stato: "Da iniziare", tonight: false, azione: "", note: "" },
      { cantiere: "Biomasse", text: "Contattare 3 birrifici locali", tipo: "iniziativa", priorita: "Alta", scadenza: soon(3), stato: "Da iniziare", tonight: true, azione: "Email icebreaker", note: "" },
      { cantiere: "Biomasse", text: "Scheda tecnica scarto tipo A", tipo: "iniziativa", priorita: "Bassa", scadenza: "", stato: "Da iniziare", tonight: false, azione: "", note: "" },
      { cantiere: "Visibilità", text: "Aggiornare pagina LinkedIn aziendale", tipo: "iniziativa", priorita: "Media", scadenza: soon(20), stato: "Da iniziare", tonight: false, azione: "", note: "" },
    ].forEach((t) => batch.set(doc(tasksCol), { ...t, assignee: null, linkedDeadlineId: null, createdAt: serverTimestamp() }));
    [
      { name: "Scadenza domanda bando (esempio)", data: soon(9), cantiere: "Raccolta fondi", stato: "Da fare", note: "" },
      { name: "Fiera di settore (esempio)", data: soon(40), cantiere: "Visibilità", stato: "Da fare", note: "" },
      { name: "Rinnovo iscrizione registro (esempio)", data: soon(75), cantiere: "Raccolta fondi", stato: "Da fare", note: "" },
    ].forEach((d) => batch.set(doc(deadlinesCol), d));
    [
      { who: "Referente scientifico (esempio)", ctx: "Sollecito proposta", cantiere: "Raccolta fondi", stato: "Da inviare", next: soon(0), note: "" },
      { who: "Fornitore biomassa (esempio)", ctx: "Richiesta campione", cantiere: "Biomasse", stato: "Da scrivere", next: soon(4), note: "" },
    ].forEach((e) => batch.set(doc(emailsCol), e));
    [
      { documento: "Business plan", cantiere: "Raccolta fondi", versione: "0.3", ultimoAggiornamento: soon(-45), stato: "Da verificare", dove: "Drive", note: "" },
      { documento: "Visura camerale aggiornata", cantiere: "Raccolta fondi", versione: "", ultimoAggiornamento: "", stato: "Da creare", dove: "", note: "" },
      { documento: "One-pager commerciale", cantiere: "Visibilità", versione: "1.0", ultimoAggiornamento: soon(-10), stato: "OK", dove: "Drive", note: "" },
    ].forEach((d) => batch.set(doc(documentsCol), d));
    [
      { label: "Mail aggiornamento investitori", cantiere: "Raccolta fondi", cadenza: "mensile", prossimaOccorrenza: soon(6), attiva: true },
      { label: "Review settimanale dei task", cantiere: "Raccolta fondi", cadenza: "settimanale", prossimaOccorrenza: soon(2), attiva: true },
      { label: "Post LinkedIn", cantiere: "Visibilità", cadenza: "settimanale", prossimaOccorrenza: soon(1), attiva: true },
    ].forEach((r) => batch.set(doc(routineCol), r));
    await batch.commit();
  }

  /* ═══════════ RENDER ═══════════ */
  function render() {
    if (!Object.values(ready).every(Boolean)) {
      app.innerHTML = '<div class="loading">Carico il tuo cruscotto…</div>';
      return;
    }

    const now = new Date();
    const isEvening = now.getHours() >= 18 || now.getHours() < 6;
    const everythingEmpty = !tasks.length && !deadlines.length && !emails.length && !routines.length && !documents.length;

    const mine = (t) => !myTasksOnly || t.assignee === myEmail();

    // — Livello 1: vincoli —
    const vincoliDeadlines = [...deadlines].filter(isDeadlineOpen)
      .sort((a, b) => dateSortKey(a.data) - dateSortKey(b.data));
    const docAlerts = documents.filter(docIsAlert);

    // — "Stasera" —
    const tonight = tasks.filter((t) => t.stato !== "Fatto" && t.tonight && mine(t)).slice(0, 5);

    // — Livello 2: iniziative per cantiere —
    const iniziativeByCantiere = (c) => tasks
      .filter((t) => t.cantiere === c && t.stato !== "Fatto" && taskTipo(t) === "iniziativa" && mine(t))
      .sort((a, b) => {
        const la = a.linkedDeadlineId ? 0 : 1, lb = b.linkedDeadlineId ? 0 : 1;
        return la - lb || dateSortKey(a.scadenza) - dateSortKey(b.scadenza)
          || (PRIO_ORDER[a.priorita] ?? 3) - (PRIO_ORDER[b.priorita] ?? 3);
      });

    // — Livello 3: routine —
    const routineList = [...routines]
      .sort((a, b) => (a.attiva === false) - (b.attiva === false)
        || dateSortKey(a.prossimaOccorrenza) - dateSortKey(b.prossimaOccorrenza));

    // — Email —
    const sortedEmails = [...emails].sort((a, b) => dateSortKey(a.next) - dateSortKey(b.next));

    const cantiereOptions = CANTIERI.map((c) => `<option value="${c}">${c}</option>`).join("");

    app.innerHTML = `
      <div class="header">
        <div>
          <h1>BioPhi — Centrale Operativa</h1>
          <div class="sub">${isEvening ? "Sessione serale — scegli poche cose, falle bene" : "Vista operativa"}${lastImport ? " · ultimo import: " + lastImport : ""}</div>
        </div>
        <div class="header-actions">
          <div class="clock">${now.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long" })}</div>
          <label class="io-btn" for="import-input">Importa Excel</label>
          <input id="import-input" type="file" accept=".xlsx" hidden />
          <button class="io-btn" id="export-btn">Esporta Excel</button>
        </div>
      </div>

      ${everythingEmpty ? `
        <div class="card empty-state">
          <p>La dashboard è vuota. Importa il file Excel, oppure carica un set di dati di esempio per fare una prova.</p>
          <button class="io-btn" id="sample-btn">Carica dati di esempio</button>
        </div>` : ""}

      <div class="toolbar">
        <div class="quickadd">
          <select id="qa-cantiere" aria-label="Cantiere">${cantiereOptions}</select>
          <input id="qa-input" type="text" placeholder="Aggiungi un'iniziativa al volo… (invio)"/>
          <button id="qa-btn">Aggiungi</button>
        </div>
        <div class="toolbar-right">
          <button class="chip-toggle ${myTasksOnly ? "on" : ""}" id="mine-toggle">${myTasksOnly ? "● I miei task" : "○ Tutti"}</button>
          <button class="io-btn" id="new-task-btn">+ Task</button>
        </div>
      </div>

      <!-- LIVELLO 1 — VINCOLI -->
      <section class="level level-1">
        <div class="level-head"><span class="level-tag">Livello 1</span><h2>Vincoli</h2></div>
        <div class="card">
          ${vincoliDeadlines.length ? vincoliDeadlines.map((d) => `
            <div class="constraint-row">
              <div class="c-main">
                <span class="c-kind">Scadenza</span>
                <span class="c-name">${escapeHtml(d.name)}</span>
                <span class="c-meta">${escapeHtml(d.cantiere || "")} · ${fmtDate(d.data)}</span>
              </div>
              ${urgencyBadge(d.data)}
            </div>`).join("") : '<div class="empty">Nessuna scadenza aperta.</div>'}

          ${docAlerts.length ? `
            <div class="constraint-sep">Documenti da sistemare</div>
            ${docAlerts.map((dc) => {
              const since = daysUntil(dc.ultimoAggiornamento);
              return `<div class="constraint-row">
                <div class="c-main">
                  <span class="c-kind doc">Documento</span>
                  <span class="c-name">${escapeHtml(dc.documento)}</span>
                  <span class="c-meta">${escapeHtml(dc.stato || "")}${since !== null && since < 0 ? " · fermo da " + (-since) + "g" : dc.ultimoAggiornamento ? "" : " · mai aggiornato"}</span>
                </div>
                <span class="days soon">azione</span>
              </div>`;
            }).join("")}` : ""}
        </div>
      </section>

      <!-- STASERA -->
      <section class="level">
        <div class="level-head"><h2>Stasera</h2><span class="tag">max 5 · derivate da "metti stasera"</span></div>
        <div class="card">
          ${tonight.length ? tonight.map((t) => `
            <div class="tonight-item">
              <input type="checkbox" ${t.stato === "Fatto" ? "checked" : ""} data-toggle="${t.id}"/>
              <div class="txt">
                <div class="${t.stato === "Fatto" ? "done" : ""}">${escapeHtml(t.text)}</div>
                <div class="meta">${escapeHtml(t.cantiere)}${t.scadenza ? " · scad. " + fmtDate(t.scadenza) : ""}</div>
              </div>
              <button class="mini" data-edit="${t.id}" aria-label="Modifica">✎</button>
            </div>`).join("") : '<div class="empty">Niente segnato per stasera.</div>'}
        </div>
      </section>

      <!-- LIVELLO 2 — FOCUS ATTIVO -->
      <section class="level level-2">
        <div class="level-head"><span class="level-tag">Livello 2</span><h2>Focus attivo</h2><span class="tag">max ${MAX_INIZIATIVE_PER_CANTIERE} per cantiere</span></div>
        <div class="cantieri">
          ${CANTIERI.map((c) => {
            const all = iniziativeByCantiere(c);
            const items = all.slice(0, MAX_INIZIATIVE_PER_CANTIERE);
            const hidden = all.length - items.length;
            return `<div class="cant-col">
              <h3>${escapeHtml(c)} <span>${all.length}</span></h3>
              ${items.length ? items.map((t) => `
                <div class="task">
                  <div class="top">
                    <span class="name ${t.stato === "Fatto" ? "done" : ""}">${escapeHtml(t.text)}</span>
                  </div>
                  <div class="task-sub">
                    ${t.scadenza ? urgencyBadge(t.scadenza) : ""}
                    ${t.linkedDeadlineId ? `<span class="chip">↳ ${escapeHtml(deadlineName(t.linkedDeadlineId))}</span>` : ""}
                    ${t.assignee ? `<span class="chip who">${escapeHtml(assigneeLabel(t.assignee))}</span>` : ""}
                  </div>
                  <div class="actions">
                    <button data-toggle="${t.id}">${t.stato === "Fatto" ? "riapri" : "fatto"}</button>
                    <button data-tonight="${t.id}">${t.tonight ? "✓ stasera" : "stasera"}</button>
                    <button data-edit="${t.id}">modifica</button>
                  </div>
                </div>`).join("") : '<div class="empty">Nessuna iniziativa aperta.</div>'}
              ${hidden > 0 ? `<div class="cant-more">+${hidden} in coda (oltre le prime ${MAX_INIZIATIVE_PER_CANTIERE})</div>` : ""}
            </div>`;
          }).join("")}
        </div>
      </section>

      <!-- LIVELLO 3 — ROUTINE -->
      <section class="level level-3">
        <details ${routineList.some((r) => { const dd = daysUntil(r.prossimaOccorrenza); return r.attiva !== false && dd !== null && dd <= 2; }) ? "open" : ""}>
          <summary><span class="level-tag">Livello 3</span><h2>Routine</h2><span class="tag">${routineList.filter((r) => r.attiva !== false).length} attive</span></summary>
          <div class="card">
            ${routineList.length ? routineList.map((r) => `
              <div class="routine-row ${r.attiva === false ? "off" : ""}">
                <div class="r-main">
                  <span class="r-label">${escapeHtml(r.label)}</span>
                  <span class="c-meta">${escapeHtml(r.cantiere || "")} · ${escapeHtml(r.cadenza || "")}</span>
                </div>
                ${r.attiva === false ? '<span class="days far">sospesa</span>' : urgencyBadge(r.prossimaOccorrenza)}
                <div class="actions">
                  ${r.attiva === false ? "" : `<button data-routinedone="${r.id}">fatta</button>`}
                  <button data-routinetoggle="${r.id}">${r.attiva === false ? "riattiva" : "sospendi"}</button>
                </div>
              </div>`).join("") : '<div class="empty">Nessuna routine.</div>'}
            <div class="routine-add">
              <input id="ro-label" type="text" placeholder="Nuova routine…"/>
              <select id="ro-cadenza"><option value="settimanale">settimanale</option><option value="mensile">mensile</option></select>
              <button id="ro-btn">Aggiungi</button>
            </div>
          </div>
        </details>
      </section>

      <!-- EMAIL -->
      <section class="level">
        <div class="level-head"><h2>Email in sospeso</h2></div>
        <div class="card">
          ${sortedEmails.length ? sortedEmails.map((e) => {
            const days = daysUntil(e.next);
            return `<div class="email-row">
              <div style="flex:1">
                <div class="who">${escapeHtml(e.who)}</div>
                <div class="ctx">${escapeHtml(e.ctx)}</div>
              </div>
              <div class="when" style="${days !== null && days <= 0 ? "color:var(--ar-urgent)" : ""}">${days === null ? "—" : days <= 0 ? "da fare oggi" : "tra " + days + "g"}</div>
              <button data-snooze="${e.id}">+3g</button>
              <button data-doneemail="${e.id}">fatta</button>
            </div>`;
          }).join("") : '<div class="empty">Nessun follow-up in sospeso.</div>'}
        </div>
      </section>
    `;

    /* ---- wiring ---- */
    const $ = (id) => document.getElementById(id);
    $("import-input").onchange = (ev) => { const f = ev.target.files[0]; if (f) handleImportFile(f); };
    $("export-btn").onclick = exportToExcel;
    if ($("sample-btn")) $("sample-btn").onclick = loadSampleData;

    const doQuick = () => { addQuick($("qa-input").value, $("qa-cantiere").value); $("qa-input").value = ""; };
    $("qa-btn").onclick = doQuick;
    $("qa-input").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doQuick(); });

    $("mine-toggle").onclick = () => { myTasksOnly = !myTasksOnly; render(); };
    $("new-task-btn").onclick = () => openTaskModal(null);

    const doRoutine = () => { addRoutine($("ro-label").value, $("ro-cadenza").value); $("ro-label").value = ""; };
    if ($("ro-btn")) {
      $("ro-btn").onclick = doRoutine;
      $("ro-label").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doRoutine(); });
    }

    app.querySelectorAll("[data-toggle]").forEach((el) => el.onclick = () => toggleDone(el.dataset.toggle));
    app.querySelectorAll("[data-tonight]").forEach((el) => el.onclick = () => toggleTonight(el.dataset.tonight));
    app.querySelectorAll("[data-edit]").forEach((el) => el.onclick = () => openTaskModal(el.dataset.edit));
    app.querySelectorAll("[data-snooze]").forEach((el) => el.onclick = () => snoozeEmail(el.dataset.snooze));
    app.querySelectorAll("[data-doneemail]").forEach((el) => el.onclick = () => doneEmail(el.dataset.doneemail));
    app.querySelectorAll("[data-routinedone]").forEach((el) => el.onclick = () => routineDone(el.dataset.routinedone));
    app.querySelectorAll("[data-routinetoggle]").forEach((el) => el.onclick = () => routineToggle(el.dataset.routinetoggle));
  }
}
