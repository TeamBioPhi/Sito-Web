// BioPhi · Area Riservata — guardia di autenticazione + Centrale Operativa
//
// Tre viste (hash routing): #operativa (default) · #calendario · #gantt
// Modello dati e logica: vedi ARCHITETTURA.md §5 e §10.
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

/* ═══════════════ COSTANTI ═══════════════ */
const CANTIERI = ["Raccolta fondi", "Biomasse", "Visibilità", "Commerciale"];
const PRIO_ORDER = { Alta: 0, Media: 1, Bassa: 2 };
const MAX_TASK_PER_CANTIERE = 5;
const DOC_STALE_GIORNI = 30;
const DOC_STATI_ALERT = ["Da creare", "Da verificare"];

// Soci: mappa nome ⇄ email di login. In import/export "Simone"/"Edoardo"/"Entrambi"
// vengono convertiti automaticamente nelle email; `assignee` è salvato come
// email singola oppure lista "email1,email2" (Entrambi).
const MEMBERS = {
  "simone.battisti.sb@gmail.com": "Simone",
  "edoardomontiwork@gmail.com": "Edoardo",
};
const MEMBER_BY_NAME = Object.fromEntries(
  Object.entries(MEMBERS).map(([email, name]) => [name.toLowerCase(), email]));
const BOTH_EMAILS = Object.keys(MEMBERS).join(",");
const BOTH_WORDS = ["entrambi", "both", "tutti e due", "tutti", "edoardo e simone", "simone e edoardo"];

function normalizeAssignee(raw) {
  const s = (raw ?? "").toString().trim();
  if (!s) return "";
  if (BOTH_WORDS.includes(s.toLowerCase())) return BOTH_EMAILS;
  const emails = s.split(/[,;/]+/).map((p) => {
    const t = p.trim();
    return MEMBER_BY_NAME[t.toLowerCase()] || t;
  }).filter(Boolean);
  return [...new Set(emails)].join(",");
}
const assigneeEmails = (a) => (a || "").split(",").map((x) => x.trim()).filter(Boolean);
function assigneeLabel(a, myEmail) {
  const em = assigneeEmails(a);
  if (!em.length) return "";
  if (em.length > 1) return "entrambi";
  return em[0] === myEmail ? "io" : (MEMBERS[em[0]] || em[0].split("@")[0]);
}
function assigneeExportLabel(a) {
  const em = assigneeEmails(a);
  if (!em.length) return "";
  if (em.length > 1 && em.every((e) => MEMBERS[e])) return "Entrambi";
  return em.map((e) => MEMBERS[e] || e).join(", ");
}
const VIEWS = ["operativa", "calendario", "gantt"];
const GG = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

let started = false;
function startDashboard() {
  if (started) return;
  started = true;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const myEmail = () => auth.currentUser?.email || "";

  /* ---- Firestore ---- */
  const tasksCol     = collection(db, "tasks");
  const deadlinesCol = collection(db, "deadlines");
  const emailsCol    = collection(db, "emails");
  const routineCol   = collection(db, "routine");
  const documentsCol = collection(db, "documents");
  const metaRef      = doc(db, "meta", "dashboard");

  /* ---- Stato locale ---- */
  const tasks = [], deadlines = [], emails = [], routines = [], documents = [];
  let lastImport = null;
  let myTasksOnly = false;
  let calMonth = firstOfMonth(new Date());
  let currentView = "operativa";
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
  sub(tasksCol, "tasks", tasks);
  sub(deadlinesCol, "deadlines", deadlines);
  sub(emailsCol, "emails", emails);
  sub(routineCol, "routine", routines);
  sub(documentsCol, "documents", documents);
  onSnapshot(metaRef, (snap) => {
    lastImport = snap.exists() ? (snap.data().lastImport || null) : null;
    render();
  }, onErr("meta"));

  /* ---- Routing per vista ---- */
  function syncView() {
    const h = (location.hash || "").replace("#", "");
    currentView = VIEWS.includes(h) ? h : "operativa";
    document.querySelectorAll(".ar-views a").forEach((a) =>
      a.classList.toggle("active", a.getAttribute("href") === "#" + currentView));
    render();
  }
  window.addEventListener("hashchange", syncView);
  syncView();

  /* ═══════════ HELPER DATE / TESTO ═══════════ */
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function lastOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseYmd(s) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(s || "")) return null;
    const d = new Date(s.slice(0, 10) + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function mondayIndex(d) { return (d.getDay() + 6) % 7; }   // 0 = lunedì
  function daysUntil(dateStr) {
    const d = parseYmd(dateStr); if (!d) return null;
    return Math.round((d - today) / 86400000);
  }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function fmtDate(dateStr) {
    const d = parseYmd(dateStr);
    return d ? d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) : "—";
  }
  function dateSortKey(s) { const d = parseYmd(s); return d ? d.getTime() : Infinity; }
  function advanceDate(dateStr, cadenza) {
    const d = parseYmd(dateStr) || new Date();
    if (cadenza === "mensile") d.setMonth(d.getMonth() + 1); else d.setDate(d.getDate() + 7);
    return ymd(d);
  }
  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Badge di urgenza DERIVATO dalla data
  function urgencyBadge(dateStr) {
    const days = daysUntil(dateStr);
    if (days === null) return '<span class="days far">nessuna data</span>';
    const cls = days <= 14 ? "soon" : days <= 45 ? "mid" : "far";
    const label = days < 0 ? "in ritardo" : days === 0 ? "oggi" : `tra ${days}g`;
    return `<span class="days ${cls}">${label}</span>`;
  }
  const dateMoved = (orig, cur) => !!(orig && cur && orig !== cur);
  // Nota "spostata da X a Y" (X = prima data inserita, fissa)
  function movedNote(orig, cur) {
    if (!dateMoved(orig, cur)) return "";
    const dd = daysBetween(parseYmd(orig), parseYmd(cur));
    const verso = dd > 0 ? "posticipata" : "anticipata";
    return `spostata da ${fmtDate(orig)} a ${fmtDate(cur)} · ${verso} di ${Math.abs(dd)}g`;
  }
  const movedBadge = (orig, cur) => dateMoved(orig, cur)
    ? `<span class="days moved" title="Data originale: ${escapeHtml(fmtDate(orig))}">↔ da ${escapeHtml(fmtDate(orig))}</span>` : "";

  const isDeadlineOpen = (d) => !/fatt|complet|chius/i.test(d.stato || "");
  function docIsAlert(dc) {
    if (!DOC_STATI_ALERT.includes(dc.stato)) return false;
    const since = daysUntil(dc.ultimoAggiornamento);
    return since === null || -since > DOC_STALE_GIORNI;
  }
  const taskTipo = (t) => (t.tipo === "routine" ? "routine" : "iniziativa");
  const deadlineName = (id) => deadlines.find((d) => d.id === id)?.name || "";
  const isMine = (t) => assigneeEmails(t.assignee).includes(myEmail());
  const mine = (t) => !myTasksOnly || isMine(t);
  const aLabel = (a) => assigneeLabel(a, myEmail());

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
      inizio: "", scadenza: "", scadenzaOrig: "", stato: "Da iniziare", tonight: true,
      assignee: null, linkedDeadlineId: null, azione: "", note: "",
      createdAt: serverTimestamp(),
    });
  }
  const snoozeEmail = (id) => {
    updateDoc(doc(emailsCol, id), { next: ymd(addDays(new Date(), 3)) });
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
      prossimaOccorrenza: advanceDate(ymd(new Date()), cadenza), attiva: true,
    });
  }

  /* ═══════════ MODALE MODIFICA / NUOVO TASK ═══════════ */
  const dlg = document.getElementById("task-dialog");
  const dlgForm = document.getElementById("task-form");
  const dlgTitle = document.getElementById("task-dialog-title");
  const dlgDelete = document.getElementById("task-delete");
  let editingId = null;

  function openTaskModal(id, prefill) {
    editingId = id || null;
    const t = (id && tasks.find((x) => x.id === id)) || prefill || {};
    dlgTitle.textContent = id ? "Modifica task" : "Nuovo task";
    dlgDelete.hidden = !id;

    dlgForm.linkedDeadlineId.innerHTML = '<option value="">— nessun vincolo —</option>' +
      [...deadlines].filter(isDeadlineOpen).sort((a, b) => dateSortKey(a.data) - dateSortKey(b.data))
        .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");
    const curA = normalizeAssignee(t.assignee);
    const knownA = ["", BOTH_EMAILS, ...Object.keys(MEMBERS)];
    dlgForm.assignee.innerHTML =
      '<option value="">— nessuno —</option>' +
      Object.entries(MEMBERS).map(([email, name]) => `<option value="${escapeHtml(email)}">${escapeHtml(name)}</option>`).join("") +
      `<option value="${escapeHtml(BOTH_EMAILS)}">Entrambi</option>` +
      (curA && !knownA.includes(curA) ? `<option value="${escapeHtml(curA)}">${escapeHtml(curA)}</option>` : "");
    const stati = ["Da iniziare", "In corso", "In attesa", "Fatto"];
    if (t.stato && !stati.includes(t.stato)) stati.unshift(t.stato);
    dlgForm.stato.innerHTML = stati.map((s) => `<option>${escapeHtml(s)}</option>`).join("");

    dlgForm.text.value = t.text || "";
    dlgForm.cantiere.value = CANTIERI.includes(t.cantiere) ? t.cantiere : CANTIERI[0];
    dlgForm.tipo.value = taskTipo(t);
    dlgForm.priorita.value = t.priorita || "Media";
    dlgForm.inizio.value = /^\d{4}-\d{2}-\d{2}$/.test(t.inizio) ? t.inizio : "";
    dlgForm.scadenza.value = /^\d{4}-\d{2}-\d{2}$/.test(t.scadenza) ? t.scadenza : "";
    dlgForm.stato.value = t.stato || "Da iniziare";
    dlgForm.assignee.value = curA;
    dlgForm.linkedDeadlineId.value = t.linkedDeadlineId || "";
    dlgForm.azione.value = t.azione || "";
    dlgForm.note.value = t.note || "";
    dlgForm.tonight.checked = !!t.tonight;
    const mvEl = document.getElementById("task-moved");
    const mv = movedNote(t.scadenzaOrig, t.scadenza);
    mvEl.textContent = mv ? "Scadenza " + mv : "";
    mvEl.hidden = !mv;
    dlg.showModal();
  }
  dlgForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const prev = editingId ? tasks.find((x) => x.id === editingId) : null;
    const p = {
      text: dlgForm.text.value.trim(), cantiere: dlgForm.cantiere.value,
      tipo: dlgForm.tipo.value, priorita: dlgForm.priorita.value,
      inizio: dlgForm.inizio.value || "", scadenza: dlgForm.scadenza.value || "",
      stato: dlgForm.stato.value, tonight: dlgForm.tonight.checked,
      assignee: normalizeAssignee(dlgForm.assignee.value) || null,
      linkedDeadlineId: dlgForm.linkedDeadlineId.value || null,
      azione: dlgForm.azione.value.trim(), note: dlgForm.note.value.trim(),
    };
    if (!p.text) return;
    // scadenzaOrig = prima data mai inserita, poi fissa
    p.scadenzaOrig = (prev && prev.scadenzaOrig) || p.scadenza || "";
    if (editingId) updateDoc(doc(tasksCol, editingId), p);
    else addDoc(tasksCol, { ...p, createdAt: serverTimestamp() });
    dlg.close();
  });
  dlgDelete.addEventListener("click", () => {
    if (editingId && confirm("Eliminare definitivamente questo task?")) {
      deleteDoc(doc(tasksCol, editingId)); dlg.close();
    }
  });
  document.getElementById("task-cancel").addEventListener("click", () => dlg.close());

  /* ═══════════ MODALE MODIFICA SCADENZA ═══════════ */
  const ddlg = document.getElementById("deadline-dialog");
  const ddForm = document.getElementById("deadline-form");
  let editingDeadlineId = null;

  function openDeadlineModal(id) {
    const d = deadlines.find((x) => x.id === id);
    if (!d) return;
    editingDeadlineId = id;
    const opts = ["", ...CANTIERI];
    if (d.cantiere && !opts.includes(d.cantiere)) opts.push(d.cantiere);
    ddForm.cantiere.innerHTML = opts.map((o) => `<option value="${escapeHtml(o)}">${o || "— nessuno —"}</option>`).join("");
    ddForm.name.value = d.name || "";
    ddForm.data.value = /^\d{4}-\d{2}-\d{2}$/.test(d.data) ? d.data : "";
    ddForm.cantiere.value = d.cantiere || "";
    ddForm.stato.value = d.stato || "Da fare";
    ddForm.note.value = d.note || "";
    ddForm.makeTask.checked = false;
    const mvEl = document.getElementById("deadline-moved");
    const mv = movedNote(d.dataOrig, d.data);
    mvEl.textContent = mv ? "Data " + mv : "";
    mvEl.hidden = !mv;
    ddlg.showModal();
  }
  ddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = deadlines.find((x) => x.id === editingDeadlineId);
    if (!d) { ddlg.close(); return; }
    const data = ddForm.data.value || "";
    updateDoc(doc(deadlinesCol, editingDeadlineId), {
      name: ddForm.name.value.trim() || d.name,
      data,
      dataOrig: d.dataOrig || data || "",
      cantiere: ddForm.cantiere.value,
      stato: ddForm.stato.value.trim() || "Da fare",
      note: ddForm.note.value.trim(),
    });
    if (ddForm.makeTask.checked) {
      openTaskModal(null, {
        cantiere: CANTIERI.includes(d.cantiere) ? d.cantiere : CANTIERI[0],
        text: d.name, scadenza: ymd(today), linkedDeadlineId: editingDeadlineId, tonight: true,
      });
    }
    ddlg.close();
  });
  document.getElementById("deadline-delete").addEventListener("click", () => {
    if (editingDeadlineId && confirm("Eliminare questa scadenza?")) {
      deleteDoc(doc(deadlinesCol, editingDeadlineId));
      ddlg.close();
    }
  });
  document.getElementById("deadline-cancel").addEventListener("click", () => ddlg.close());

  /* ═══════════ IMPORT / EXPORT EXCEL ═══════════ */
  function sheetToRows(wb, name) {
    const ws = wb.Sheets[name];
    return ws ? XLSX.utils.sheet_to_json(ws, { defval: "" }) : null;
  }
  function asDateStr(v) {
    if (v instanceof Date) return ymd(v);
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
        const T = sheetToRows(wb, "Task");
        if (T) jobs.push(replaceCollection(tasksCol, T.filter((r) => r["Attività"]).map((r) => ({
          cantiere: CANTIERI.includes(r["Cantiere"]) ? r["Cantiere"] : CANTIERI[0],
          text: r["Attività"] || "",
          tipo: (r["Tipo"] || "").toLowerCase() === "routine" ? "routine" : "iniziativa",
          priorita: r["Priorità"] || "Media",
          inizio: asDateStr(r["Inizio"]), scadenza: asDateStr(r["Scadenza"]),
          scadenzaOrig: asDateStr(r["Scadenza originale"]) || asDateStr(r["Scadenza"]),
          stato: r["Stato"] || "Da iniziare", tonight: false,
          assignee: normalizeAssignee(r["Assegnatario"]) || null, linkedDeadlineId: null,
          azione: r["Prossima azione concreta"] || "", note: r["Note"] || "",
        }))));
        const D = sheetToRows(wb, "Scadenze chiave");
        if (D) jobs.push(replaceCollection(deadlinesCol, D.filter((r) => r["Milestone / Evento"]).map((r) => ({
          name: r["Milestone / Evento"] || "", data: asDateStr(r["Data"]),
          dataOrig: asDateStr(r["Data originale"]) || asDateStr(r["Data"]),
          cantiere: r["Cantiere"] || "", stato: r["Stato"] || "Da fare", note: r["Note"] || "",
        }))));
        const E = sheetToRows(wb, "Email");
        if (E) jobs.push(replaceCollection(emailsCol, E.filter((r) => r["Destinatario"] && (r["Stato"] || "") !== "Chiusa").map((r) => ({
          who: r["Destinatario"] || "", ctx: r["Oggetto / contesto"] || "", cantiere: r["Cantiere"] || "",
          stato: r["Stato"] || "Da inviare", next: asDateStr(r["Prossimo controllo"]) || ymd(new Date()), note: r["Note"] || "",
        }))));
        const DOC = sheetToRows(wb, "Documenti");
        if (DOC) jobs.push(replaceCollection(documentsCol, DOC.filter((r) => r["Documento"]).map((r) => ({
          documento: r["Documento"] || "", cantiere: r["Cantiere"] || "", versione: (r["Versione"] || "").toString(),
          ultimoAggiornamento: asDateStr(r["Ultimo aggiornamento"]), stato: r["Stato"] || "", dove: r["Dove"] || "", note: r["Note"] || "",
        }))));
        const R = sheetToRows(wb, "Routine");
        if (R) jobs.push(replaceCollection(routineCol, R.filter((r) => r["Attività"]).map((r) => ({
          label: r["Attività"] || "", cantiere: r["Cantiere"] || CANTIERI[0],
          cadenza: (r["Cadenza"] || "").toLowerCase() === "mensile" ? "mensile" : "settimanale",
          prossimaOccorrenza: asDateStr(r["Prossima occorrenza"]) || ymd(new Date()),
          attiva: !/^(no|falso|false|0)$/i.test((r["Attiva"] || "").toString().trim()),
        }))));
        if (!jobs.length) { alert('Nessun foglio riconosciuto. Attesi: "Task", "Scadenze chiave", "Email", "Documenti", "Routine".'); return; }
        await Promise.all(jobs);
        await setDoc(metaRef, { lastImport: new Date().toLocaleString("it-IT") }, { merge: true });
      } catch (err) {
        console.error(err);
        alert("Non sono riuscito a leggere il file. Controlla i nomi dei fogli e delle colonne.");
      } finally { importing = false; }
    };
    reader.readAsArrayBuffer(file);
  }
  function exportToExcel() {
    const wb = XLSX.utils.book_new();
    const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
    add(tasks.map((t) => ({
      "Cantiere": t.cantiere, "Attività": t.text, "Tipo": taskTipo(t), "Priorità": t.priorita,
      "Inizio": t.inizio || "", "Scadenza": t.scadenza || "", "Scadenza originale": t.scadenzaOrig || t.scadenza || "",
      "Stato": t.stato, "Assegnatario": assigneeExportLabel(t.assignee), "Vincolo collegato": deadlineName(t.linkedDeadlineId),
      "Prossima azione concreta": t.azione || "", "Note": t.note || "",
    })), "Task");
    add(deadlines.map((d) => ({
      "Data": d.data, "Data originale": d.dataOrig || d.data || "", "Milestone / Evento": d.name,
      "Cantiere": d.cantiere || "", "Stato": d.stato || "Da fare", "Note": d.note || "",
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
    XLSX.writeFile(wb, "BioPhi_Dashboard_Export_" + ymd(new Date()) + ".xlsx");
  }

  /* ═══════════ DATI DI ESEMPIO (fittizi) ═══════════ */
  async function loadSampleData() {
    if (!confirm("Carico un set di dati di ESEMPIO (fittizi) per provare la dashboard?")) return;
    const soon = (n) => ymd(addDays(new Date(), n));
    const batch = writeBatch(db);
    [
      { cantiere: "Raccolta fondi", text: "Bozza pitch deck v1", tipo: "iniziativa", priorita: "Alta", inizio: soon(-2), scadenza: soon(6), stato: "In corso", tonight: true, azione: "Struttura 12 slide", note: "" },
      { cantiere: "Raccolta fondi", text: "Business plan — sezione mercato", tipo: "iniziativa", priorita: "Media", inizio: soon(4), scadenza: soon(18), stato: "Da iniziare", tonight: false, azione: "", note: "" },
      { cantiere: "Biomasse", text: "Contattare 3 birrifici locali", tipo: "iniziativa", priorita: "Alta", inizio: "", scadenza: soon(3), stato: "Da iniziare", tonight: true, azione: "Email icebreaker", note: "" },
      { cantiere: "Biomasse", text: "Scheda tecnica scarto tipo A", tipo: "iniziativa", priorita: "Bassa", inizio: "", scadenza: "", stato: "Da iniziare", tonight: false, azione: "", note: "" },
      { cantiere: "Visibilità", text: "Restyling pagina LinkedIn", tipo: "iniziativa", priorita: "Media", inizio: soon(1), scadenza: soon(21), stato: "Da iniziare", tonight: false, azione: "", note: "" },
      { cantiere: "Commerciale", text: "Preparare 5 preventivi tipo", tipo: "iniziativa", priorita: "Media", inizio: soon(2), scadenza: soon(14), stato: "Da iniziare", tonight: false, azione: "", note: "" },
    ].forEach((t, i) => batch.set(doc(tasksCol), {
      ...t, linkedDeadlineId: null, createdAt: serverTimestamp(),
      scadenzaOrig: i === 0 ? soon(2) : (t.scadenza || ""),   // il 1° task simula una scadenza spostata
      assignee: [normalizeAssignee("Simone"), normalizeAssignee("Edoardo"), normalizeAssignee("Entrambi"), null, normalizeAssignee("Edoardo"), normalizeAssignee("Edoardo")][i],
    }));
    [
      { name: "Scadenza domanda bando (esempio)", data: soon(9), dataOrig: soon(9), cantiere: "Raccolta fondi", stato: "Da fare", note: "" },
      { name: "Fiera di settore (esempio)", data: soon(40), dataOrig: soon(33), cantiere: "Visibilità", stato: "Da fare", note: "spostata" },
      { name: "Rinnovo iscrizione registro (esempio)", data: soon(80), dataOrig: soon(80), cantiere: "Raccolta fondi", stato: "Da fare", note: "" },
    ].forEach((d) => batch.set(doc(deadlinesCol), d));
    [
      { who: "Referente scientifico (esempio)", ctx: "Sollecito proposta", cantiere: "Raccolta fondi", stato: "Da inviare", next: soon(0), note: "" },
      { who: "Fornitore biomassa (esempio)", ctx: "Richiesta campione", cantiere: "Biomasse", stato: "Da scrivere", next: soon(4), note: "" },
    ].forEach((e) => batch.set(doc(emailsCol), e));
    [
      { documento: "Business plan", cantiere: "Raccolta fondi", versione: "0.3", ultimoAggiornamento: soon(-45), stato: "Da verificare", dove: "Drive", note: "" },
      { documento: "Visura camerale aggiornata", cantiere: "Raccolta fondi", versione: "", ultimoAggiornamento: "", stato: "Da creare", dove: "", note: "" },
    ].forEach((d) => batch.set(doc(documentsCol), d));
    [
      { label: "Mail aggiornamento investitori", cantiere: "Raccolta fondi", cadenza: "mensile", prossimaOccorrenza: soon(6), attiva: true },
      { label: "Review settimanale dei task", cantiere: "Raccolta fondi", cadenza: "settimanale", prossimaOccorrenza: soon(2), attiva: true },
      { label: "Post LinkedIn", cantiere: "Visibilità", cadenza: "settimanale", prossimaOccorrenza: soon(1), attiva: true },
    ].forEach((r) => batch.set(doc(routineCol), r));
    await batch.commit();
  }

  /* ═══════════ RENDER — dispatcher ═══════════ */
  function render() {
    if (!Object.values(ready).every(Boolean)) {
      app.innerHTML = '<div class="loading">Carico il tuo cruscotto…</div>';
      return;
    }
    if (currentView === "calendario") renderCalendario();
    else if (currentView === "gantt") renderGantt();
    else renderOperativa();
  }

  function headerHtml(sub) {
    const now = new Date();
    return `
      <div class="header">
        <div>
          <h1>BioPhi — Centrale Operativa</h1>
          <div class="sub">${sub}${lastImport ? " · ultimo import: " + lastImport : ""}</div>
        </div>
        <div class="header-actions">
          <div class="clock">${now.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long" })}</div>
          <label class="io-btn" for="import-input">Importa Excel</label>
          <input id="import-input" type="file" accept=".xlsx" hidden />
          <button class="io-btn" id="export-btn">Esporta Excel</button>
        </div>
      </div>`;
  }
  function wireCommon() {
    const $ = (id) => document.getElementById(id);
    if ($("import-input")) $("import-input").onchange = (ev) => { const f = ev.target.files[0]; if (f) handleImportFile(f); };
    if ($("export-btn")) $("export-btn").onclick = exportToExcel;
    if ($("sample-btn")) $("sample-btn").onclick = loadSampleData;
  }

  /* ═══════════ VISTA: OPERATIVA (layout originale) ═══════════ */
  function renderOperativa() {
    const now = new Date();
    const isEvening = now.getHours() >= 18 || now.getHours() < 6;
    const everythingEmpty = ![tasks, deadlines, emails, routines, documents].some((a) => a.length);

    const tonight = tasks.filter((t) => t.stato !== "Fatto" && t.tonight && mine(t)).slice(0, 5);
    const openDeadlines = [...deadlines].filter(isDeadlineOpen).sort((a, b) => dateSortKey(a.data) - dateSortKey(b.data)).slice(0, 6);
    const docAlerts = documents.filter(docIsAlert);
    const sortedEmails = [...emails].sort((a, b) => dateSortKey(a.next) - dateSortKey(b.next));
    const routineList = [...routines].sort((a, b) =>
      (a.attiva === false) - (b.attiva === false) || dateSortKey(a.prossimaOccorrenza) - dateSortKey(b.prossimaOccorrenza));
    const iniziative = (c) => tasks
      .filter((t) => t.cantiere === c && t.stato !== "Fatto" && taskTipo(t) === "iniziativa" && mine(t))
      .sort((a, b) => (a.linkedDeadlineId ? 0 : 1) - (b.linkedDeadlineId ? 0 : 1)
        || dateSortKey(a.scadenza) - dateSortKey(b.scadenza)
        || (PRIO_ORDER[a.priorita] ?? 3) - (PRIO_ORDER[b.priorita] ?? 3));
    const cantOpts = CANTIERI.map((c) => `<option value="${c}">${c}</option>`).join("");

    app.innerHTML = headerHtml(isEvening ? "Sessione serale — scegli poche cose, falle bene" : "Vista operativa") + `
      ${everythingEmpty ? `<div class="card empty-state"><p>Dashboard vuota. Importa l'Excel o carica dei dati di esempio.</p><button class="io-btn" id="sample-btn">Carica dati di esempio</button></div>` : ""}

      <div class="quickadd">
        <select id="qa-cantiere" aria-label="Cantiere">${cantOpts}</select>
        <input id="qa-input" type="text" placeholder="Aggiungi un'iniziativa al volo… (invio)"/>
        <button id="qa-btn">Aggiungi</button>
        <button class="chip-toggle ${myTasksOnly ? "on" : ""}" id="mine-toggle">${myTasksOnly ? "● I miei" : "○ Tutti"}</button>
        <button class="io-btn" id="new-task-btn">+ Task</button>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Stasera <span class="tag">max 5</span></h2>
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

        <div class="card">
          <h2>Scadenze chiave</h2>
          ${openDeadlines.length ? openDeadlines.map((d) => `
            <div class="deadline-row" data-deadline="${d.id}">
              <div class="name">${escapeHtml(d.name)} ${movedBadge(d.dataOrig, d.data)}</div>
              ${urgencyBadge(d.data)}
            </div>`).join("") : '<div class="empty">Nessuna scadenza aperta.</div>'}
          ${docAlerts.length ? `<div class="deadline-sep">Documenti da sistemare</div>` +
            docAlerts.map((dc) => `
              <div class="deadline-row">
                <div class="name">${escapeHtml(dc.documento)} <span class="c-meta">${escapeHtml(dc.stato || "")}</span></div>
                <span class="days soon">azione</span>
              </div>`).join("") : ""}
        </div>
      </div>

      <div class="cantieri">
        ${CANTIERI.map((c) => {
          const all = iniziative(c);
          const items = all.slice(0, MAX_TASK_PER_CANTIERE);
          const hidden = all.length - items.length;
          return `<div class="cant-col">
            <h3>${escapeHtml(c)} <span>${all.length}</span></h3>
            ${items.length ? items.map((t) => `
              <div class="task">
                <div class="top">
                  <span class="prio ${t.priorita}"></span>
                  <span class="name ${t.stato === "Fatto" ? "done" : ""}">${escapeHtml(t.text)}</span>
                </div>
                ${(t.scadenza || t.linkedDeadlineId || t.assignee) ? `<div class="task-sub">
                  ${t.scadenza ? urgencyBadge(t.scadenza) : ""}
                  ${movedBadge(t.scadenzaOrig, t.scadenza)}
                  ${t.linkedDeadlineId ? `<span class="chip">↳ ${escapeHtml(deadlineName(t.linkedDeadlineId))}</span>` : ""}
                  ${t.assignee ? `<span class="chip who">${escapeHtml(aLabel(t.assignee))}</span>` : ""}
                </div>` : ""}
                <div class="actions">
                  <button data-toggle="${t.id}">${t.stato === "Fatto" ? "riapri" : "fatto"}</button>
                  <button data-tonight="${t.id}">${t.tonight ? "✓ stasera" : "stasera"}</button>
                  <button data-edit="${t.id}">modifica</button>
                </div>
              </div>`).join("") : '<div class="empty">Nessuna iniziativa aperta.</div>'}
            ${hidden > 0 ? `<div class="cant-more">+${hidden} in coda</div>` : ""}
          </div>`;
        }).join("")}
      </div>

      <div class="card">
        <h2>Email in sospeso</h2>
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

      <details class="card routine-card" ${routineList.some((r) => { const dd = daysUntil(r.prossimaOccorrenza); return r.attiva !== false && dd !== null && dd <= 2; }) ? "open" : ""}>
        <summary><h2>Routine <span class="tag">${routineList.filter((r) => r.attiva !== false).length} attive</span></h2></summary>
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
      </details>
    `;

    wireCommon();
    const $ = (id) => document.getElementById(id);
    const doQuick = () => { addQuick($("qa-input").value, $("qa-cantiere").value); $("qa-input").value = ""; };
    $("qa-btn").onclick = doQuick;
    $("qa-input").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doQuick(); });
    $("mine-toggle").onclick = () => { myTasksOnly = !myTasksOnly; render(); };
    $("new-task-btn").onclick = () => openTaskModal(null);
    if ($("ro-btn")) {
      const doRo = () => { addRoutine($("ro-label").value, $("ro-cadenza").value); $("ro-label").value = ""; };
      $("ro-btn").onclick = doRo;
      $("ro-label").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doRo(); });
    }
    app.querySelectorAll("[data-toggle]").forEach((el) => el.onclick = () => toggleDone(el.dataset.toggle));
    app.querySelectorAll("[data-tonight]").forEach((el) => el.onclick = () => toggleTonight(el.dataset.tonight));
    app.querySelectorAll("[data-edit]").forEach((el) => el.onclick = () => openTaskModal(el.dataset.edit));
    app.querySelectorAll("[data-deadline]").forEach((el) => el.onclick = () => openDeadlineModal(el.dataset.deadline));
    app.querySelectorAll("[data-snooze]").forEach((el) => el.onclick = () => snoozeEmail(el.dataset.snooze));
    app.querySelectorAll("[data-doneemail]").forEach((el) => el.onclick = () => doneEmail(el.dataset.doneemail));
    app.querySelectorAll("[data-routinedone]").forEach((el) => el.onclick = () => routineDone(el.dataset.routinedone));
    app.querySelectorAll("[data-routinetoggle]").forEach((el) => el.onclick = () => routineToggle(el.dataset.routinetoggle));
  }

  /* ═══════════ SORGENTE DATATA COMUNE (calendario + gantt) ═══════════ */
  // Espande le occorrenze di una routine attiva nell'intervallo [from, to]
  function routineOccurrences(r, from, to) {
    const out = [];
    let d = parseYmd(r.prossimaOccorrenza);
    if (!d || r.attiva === false) return out;
    // arretra fino a prima di `from`
    let guard = 0;
    while (d > from && guard++ < 200) d = r.cadenza === "mensile" ? addMonths(d, -1) : addDays(d, -7);
    guard = 0;
    while (d < from && guard++ < 200) d = r.cadenza === "mensile" ? addMonths(d, 1) : addDays(d, 7);
    guard = 0;
    while (d <= to && guard++ < 400) { out.push(new Date(d)); d = r.cadenza === "mensile" ? addMonths(d, 1) : addDays(d, 7); }
    return out;
  }
  // Eventi puntuali in un intervallo: {date, type, label, cantiere, id?}
  function pointEvents(from, to) {
    const ev = [];
    const inRange = (d) => d && d >= from && d <= to;
    tasks.forEach((t) => {
      const d = parseYmd(t.scadenza);
      if (inRange(d) && mine(t)) ev.push({ date: d, type: "task", label: t.text, cantiere: t.cantiere, id: t.id, done: t.stato === "Fatto", moved: dateMoved(t.scadenzaOrig, t.scadenza) });
    });
    deadlines.forEach((d) => {
      const dd = parseYmd(d.data);
      if (inRange(dd)) ev.push({ date: dd, type: "deadline", label: d.name, cantiere: d.cantiere, id: d.id, moved: dateMoved(d.dataOrig, d.data) });
    });
    emails.forEach((e) => {
      const dd = parseYmd(e.next);
      if (inRange(dd)) ev.push({ date: dd, type: "email", label: e.who, cantiere: e.cantiere });
    });
    routines.forEach((r) => routineOccurrences(r, from, to).forEach((d) =>
      ev.push({ date: d, type: "routine", label: r.label, cantiere: r.cantiere })));
    return ev;
  }
  const TYPE_LABEL = { task: "Task", deadline: "Scadenza", email: "Email", routine: "Routine" };

  /* ═══════════ VISTA: CALENDARIO ═══════════ */
  function renderCalendario() {
    const first = firstOfMonth(calMonth);
    const gridStart = addDays(first, -mondayIndex(first));
    const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
    const from = cells[0], to = cells[41];
    const events = pointEvents(from, to);
    const byDay = {};
    events.forEach((e) => { (byDay[ymd(e.date)] ||= []).push(e); });

    app.innerHTML = headerHtml("Calendario — tutto ciò che è datato") + `
      <div class="cal-toolbar">
        <button class="io-btn" id="cal-prev">‹</button>
        <button class="io-btn" id="cal-today">oggi</button>
        <button class="io-btn" id="cal-next">›</button>
        <span class="cal-title">${MESI[first.getMonth()]} ${first.getFullYear()}</span>
        <span class="cal-legend">
          <i class="dot task"></i>task <i class="dot deadline"></i>scadenza
          <i class="dot routine"></i>routine <i class="dot email"></i>email
        </span>
      </div>
      <div class="cal-grid">
        ${GG.map((g) => `<div class="cal-dow">${g}</div>`).join("")}
        ${cells.map((c) => {
          const key = ymd(c);
          const items = (byDay[key] || []).sort((a, b) => a.type.localeCompare(b.type));
          const other = c.getMonth() !== first.getMonth();
          const isToday = key === ymd(today);
          return `<div class="cal-cell ${other ? "other" : ""} ${isToday ? "today" : ""}">
            <div class="cal-num">${c.getDate()}</div>
            ${items.slice(0, 4).map((e) => `
              <div class="cal-chip ${e.type} ${e.done ? "done" : ""} ${e.moved ? "moved" : ""}"
                   ${(e.type === "task" || e.type === "deadline") ? `data-kind="${e.type}" data-id="${e.id}"` : ""}
                   title="${escapeHtml(TYPE_LABEL[e.type] + ": " + e.label + (e.moved ? " (data spostata)" : ""))}">${e.moved ? "↔ " : ""}${escapeHtml(e.label)}</div>`).join("")}
            ${items.length > 4 ? `<div class="cal-more">+${items.length - 4}</div>` : ""}
          </div>`;
        }).join("")}
      </div>
      <p class="gantt-hint">Clicca un task o una scadenza per modificarlo. ↔ = data spostata dall'originale.</p>
    `;
    wireCommon();
    document.getElementById("cal-prev").onclick = () => { calMonth = addMonths(calMonth, -1); render(); };
    document.getElementById("cal-next").onclick = () => { calMonth = addMonths(calMonth, 1); render(); };
    document.getElementById("cal-today").onclick = () => { calMonth = firstOfMonth(new Date()); render(); };
    app.querySelectorAll("[data-kind]").forEach((el) => el.onclick = () =>
      (el.dataset.kind === "task" ? openTaskModal(el.dataset.id) : openDeadlineModal(el.dataset.id)));
  }

  /* ═══════════ VISTA: GANTT ═══════════ */
  function renderGantt() {
    const DAY = 22;                                   // px per giorno
    const from = firstOfMonth(addMonths(today, -1));  // dal 1° del mese scorso
    const to = addDays(today, 150);
    const width = (daysBetween(from, to) + 1) * DAY;
    const xOf = (d) => daysBetween(from, d) * DAY;

    // Costruzione righe: gruppi di cantiere + "Altre scadenze"
    const groups = [];
    [...CANTIERI, "Altre scadenze"].forEach((c) => {
      const isOther = c === "Altre scadenze";
      const items = [];
      if (!isOther) {
        tasks.filter((t) => t.cantiere === c && t.stato !== "Fatto" && taskTipo(t) === "iniziativa" && mine(t))
          .forEach((t) => {
            const s = parseYmd(t.inizio), e = parseYmd(t.scadenza);
            if (!s && !e) return;
            const start = s || e, end = e || s;
            items.push({
              label: t.text, id: t.id, dkind: "task", kind: (s && e && s < e) ? "bar" : "milestone",
              start, end, moved: dateMoved(t.scadenzaOrig, t.scadenza),
              orig: dateMoved(t.scadenzaOrig, t.scadenza) ? parseYmd(t.scadenzaOrig) : null,
            });
          });
      }
      deadlines.filter((d) => isDeadlineOpen(d) && parseYmd(d.data)
          && (isOther ? !CANTIERI.includes(d.cantiere) : d.cantiere === c))
        .forEach((d) => items.push({
          label: d.name, id: d.id, dkind: "deadline", kind: "milestone",
          start: parseYmd(d.data), end: parseYmd(d.data),
          moved: dateMoved(d.dataOrig, d.data),
          orig: dateMoved(d.dataOrig, d.data) ? parseYmd(d.dataOrig) : null,
        }));
      if (!isOther) {
        routines.filter((r) => r.cantiere === c && r.attiva !== false)
          .forEach((r) => items.push({ label: r.label, dkind: "routine", kind: "routine", ticks: routineOccurrences(r, from, to) }));
      }
      if (items.length) groups.push({ name: c, items });
    });

    // Etichette dei mesi + linee di mese
    const months = [];
    let m = firstOfMonth(from);
    for (; m <= to; m = addMonths(m, 1)) months.push(new Date(m));
    // Tacche di settimana (lunedì)
    const weeks = [];
    let w = addDays(from, (8 - from.getDay()) % 7);
    for (; w <= to; w = addDays(w, 7)) weeks.push(new Date(w));

    if (!groups.length) {
      app.innerHTML = headerHtml("Gantt") +
        '<div class="card"><div class="empty">Nessuna attività datata. Aggiungi Inizio/Scadenza ai task o importa l\'Excel.</div></div>';
      wireCommon();
      return;
    }

    const nameCol = (rows) => rows.map((r) => r.group
      ? `<div class="g2-grouprow">${escapeHtml(r.group)}</div>`
      : `<div class="g2-name" ${r.id ? `data-kind="${r.dkind}" data-id="${r.id}"` : ""} title="${escapeHtml(r.label)}">${r.moved ? "↔ " : ""}${escapeHtml(r.label)}</div>`).join("");

    // Sequenza piatta di righe (gruppo + item…)
    const flat = [];
    groups.forEach((g) => { flat.push({ group: g.name }); g.items.forEach((it) => flat.push(it)); });

    const bg = `background-image:linear-gradient(90deg,var(--color-divider) 1px,transparent 1px);background-size:${DAY}px 100%;`;

    app.innerHTML = headerHtml("Gantt — attività per cantiere sulla linea del tempo") + `
      <div class="g2">
        <div class="g2-side">
          <div class="g2-axis-spacer"></div>
          ${nameCol(flat)}
        </div>
        <div class="g2-main">
          <div class="g2-canvas" style="width:${width}px;${bg}">
            <div class="g2-axis">
              ${months.map((d) => `<span class="g2-month" style="left:${xOf(d)}px">${MESI[d.getMonth()].slice(0, 3)} ${String(d.getFullYear()).slice(2)}</span>`).join("")}
              ${weeks.map((d) => `<span class="g2-wk" style="left:${xOf(d)}px">${d.getDate()}</span>`).join("")}
            </div>
            ${months.slice(1).map((d) => `<span class="g2-monthline" style="left:${xOf(d)}px"></span>`).join("")}
            <span class="g2-today" style="left:${xOf(today)}px" title="oggi"></span>
            ${flat.map((r) => {
              if (r.group) return '<div class="g2-grouprow"></div>';
              if (r.kind === "routine") {
                return `<div class="g2-track">${(r.ticks || []).map((d) => `<span class="g-tick" style="left:${xOf(d)}px"></span>`).join("")}</div>`;
              }
              if (r.kind === "milestone") {
                const o = r.orig ? `<span class="g-orig" style="left:${xOf(r.orig)}px" title="originale"></span>` : "";
                return `<div class="g2-track">${o}<span class="g-ms ${r.dkind}" style="left:${xOf(r.start)}px" data-kind="${r.dkind}" data-id="${r.id}"></span></div>`;
              }
              const bw = Math.max(DAY, (daysBetween(r.start, r.end) + 1) * DAY);
              return `<div class="g2-track"><span class="g-bar" style="left:${xOf(r.start)}px;width:${bw}px" data-kind="task" data-id="${r.id}"></span></div>`;
            }).join("")}
          </div>
        </div>
      </div>
      <p class="gantt-hint">Barra = task con Inizio→Scadenza · rombo = scadenza/milestone · quadratino tratteggiato = data originale · pallini = routine · linea verde = oggi. Clicca un nome, una barra o un rombo per modificarlo.</p>
    `;
    wireCommon();
    app.querySelectorAll("[data-kind]").forEach((el) => el.onclick = () =>
      (el.dataset.kind === "task" ? openTaskModal(el.dataset.id) : openDeadlineModal(el.dataset.id)));
  }
}
