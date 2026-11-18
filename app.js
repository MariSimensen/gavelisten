// Gavelisten: a shared wish list per group (family or friends).
// Static page; data, sign-in and live updates come from Supabase.
// All user data is put into the page with textContent or attributes, never innerHTML.
(() => {
  "use strict";

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
  const placeChildren = (parent, nodes) => {
    nodes.forEach((node, i) => {
      if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
    });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const toMs = (v) => { const n = v ? Date.parse(v) : NaN; return isFinite(n) ? n : null; };

  const MONTHS = ["jan.", "feb.", "mars", "apr.", "mai", "juni", "juli", "aug.", "sep.", "okt.", "nov.", "des."];
  const tzFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function osloParts(ms) {
    const o = {};
    for (const p of tzFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
    return o;
  }
  function dayKey(p) { return p.year + "-" + p.month + "-" + p.day; }
  function fmtWhen(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    const p = osloParts(ms), n = osloParts(Date.now());
    const hm = p.hour + ":" + p.minute;
    const today = dayKey(n);
    const y = new Date(Date.UTC(+n.year, +n.month - 1, +n.day - 1));
    const yKey = y.getUTCFullYear() + "-" + String(y.getUTCMonth() + 1).padStart(2, "0") + "-" + String(y.getUTCDate()).padStart(2, "0");
    const key = dayKey(p);
    if (key === today) return "i dag " + hm;
    if (key === yKey) return "i går " + hm;
    return Number(p.day) + ". " + MONTHS[Number(p.month) - 1] + (p.year !== n.year ? " " + p.year : "") + " " + hm;
  }

  // Link handling: only http/https; add https:// when no scheme is given.
  function normalizeLink(raw) {
    let s = str(raw).trim();
    if (!s) return { ok: true, value: "" };
    if (!/^https?:\/\//i.test(s)) {
      if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return { ok: false };
      s = "https://" + s.replace(/^\/+/, "");
    }
    try {
      const u = new URL(s);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.includes(".")) return { ok: false };
      if (u.href.length > 2000) return { ok: false };
      return { ok: true, value: u.href };
    } catch { return { ok: false }; }
  }
  function safeUrl(link) {
    try {
      const u = new URL(str(link));
      return (u.protocol === "http:" || u.protocol === "https:") ? u : null;
    } catch { return null; }
  }
  const LINK_ERR = "Lenken må være en nettadresse som begynner med http:// eller https://.";

  // ---------- local storage keys ----------
  const LS = { hide: "gl-hide", filter: "gl-filter", group: "gl-group", invite: "gl-invite" };

  // ---------- read the URL before supabase-js does ----------
  // Page address without query or hash: where magic links and invites point.
  const PAGE_URL = location.origin + location.pathname;

  // Invite link: ?bli-med=<token>. Kept in localStorage so it survives the
  // round trip through the sign-in e-mail, then stripped from the address bar.
  let pendingInvite = null;
  let initialBanner = null;
  {
    const url = new URL(location.href);
    let changed = false;
    if (url.searchParams.has("bli-med")) {
      const tok = (url.searchParams.get("bli-med") || "").trim().toLowerCase();
      if (/^[0-9a-f]{16,100}$/.test(tok)) { pendingInvite = tok; lsSet(LS.invite, tok); }
      else initialBanner = { kind: "error", text: "Invitasjonslenken ser ikke riktig ut. Be den som inviterte deg om å sende den på nytt." };
      url.searchParams.delete("bli-med");
      changed = true;
    }
    // A failed or expired magic link comes back with error parameters.
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const errCode = hash.get("error_code") || hash.get("error") || url.searchParams.get("error_code") || url.searchParams.get("error");
    if (errCode) {
      initialBanner = {
        kind: "error",
        text: /expired|otp/i.test(errCode)
          ? "Innloggingslenken er utløpt eller allerede brukt. Be om en ny lenke nedenfor."
          : "Innloggingen mislyktes. Be om en ny lenke og prøv igjen.",
      };
      for (const k of ["error", "error_code", "error_description"]) url.searchParams.delete(k);
      url.hash = "";
      changed = true;
    }
    if (changed) history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (!pendingInvite) pendingInvite = lsGet(LS.invite);
  }
  function clearInvite() { pendingInvite = null; lsDel(LS.invite); }
  function inviteLink(token) { return PAGE_URL + "?bli-med=" + encodeURIComponent(token); }

  // ---------- state ----------
  const freshUi = () => ({
    renaming: null, confirmPerson: null, editingWish: null, confirmWish: null,
    panelOpen: false, renamingGroup: false, confirmRegen: false, confirmMember: null, confirmLeave: false,
  });
  const S = {
    sb: null,
    view: "loading",          // loading | config | auth | name | create | list
    uid: null, myName: "",
    groups: [], gid: null, members: [],
    people: new Map(), wishes: new Map(), names: {},
    loaded: false,
    fatal: null,
    filter: lsGet(LS.filter) || "all",
    hide: lsGet(LS.hide) === "1",
    ui: freshUi(),
    banner: initialBanner,    // {kind: "error" | "warn" | "ok", text}
    loadSlow: false, rtDown: false, offline: !navigator.onLine,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    summary: $("summary"),
    groupbar: $("groupbar"), groupSelect: $("groupSelect"), panelBtn: $("panelBtn"), who: $("who"), signOut: $("signOut"),
    toolbar: $("toolbar"), hideToggle: $("hideToggle"),
    banner: $("banner"),
    authView: $("authView"), authAsk: $("authAsk"), authInvited: $("authInvited"), authForm: $("authForm"), authEmail: $("authEmail"),
    authGo: $("authGo"), authErr: $("authErr"), authSent: $("authSent"), authSentText: $("authSentText"), authAgain: $("authAgain"),
    nameView: $("nameView"), nameForm: $("nameForm"), nameInput: $("nameInput"), nameGo: $("nameGo"), nameErr: $("nameErr"),
    createView: $("createView"), createIntro: $("createIntro"), createForm: $("createForm"), createName: $("createName"),
    createGo: $("createGo"), createCancel: $("createCancel"), createErr: $("createErr"),
    groupPanel: $("groupPanel"), groupTitle: $("groupTitle"), groupHeadActions: $("groupHeadActions"),
    groupRename: $("groupRename"), groupRenameInput: $("groupRenameInput"), groupRenameSave: $("groupRenameSave"),
    groupRenameCancel: $("groupRenameCancel"), groupRenameErr: $("groupRenameErr"),
    inviteLink: $("inviteLink"), copyInvite: $("copyInvite"), copyStatus: $("copyStatus"), regenArea: $("regenArea"),
    membersTitle: $("membersTitle"), memberList: $("memberList"), panelFoot: $("panelFoot"),
    listView: $("listView"),
    addPersonBtn: $("addPersonBtn"), addPerson: $("addPerson"), newPersonName: $("newPersonName"),
    savePerson: $("savePerson"), cancelPerson: $("cancelPerson"), personErr: $("personErr"),
    pills: $("pills"),
    state: $("state"),
    cards: $("cards"),
  };

  const cards = new Map(); // pid -> card view
  const rows = new Map();  // wid -> row view

  const currentGroup = () => S.groups.find(g => g.id === S.gid) || null;
  const isOwner = () => { const g = currentGroup(); return !!g && g.ownerId === S.uid; };

  // ---------- data access ----------
  function sortedPeople() {
    return [...S.people.values()].sort((a, b) =>
      (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  }
  function wishesFor(pid) {
    return [...S.wishes.values()].filter(w => w.personId === pid)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  }
  function readGroup(r) {
    return { id: r.id, name: str(r.name, 60), ownerId: r.owner_id || null, token: str(r.invite_token, 100), createdAt: toMs(r.created_at) ?? 0 };
  }
  function readPerson(r) {
    return { id: r.id, name: str(r.name, 60), order: typeof r.sort_order === "number" ? r.sort_order : 0, createdAt: toMs(r.created_at) ?? 0 };
  }
  function readWish(r) {
    return {
      id: r.id, personId: str(r.person_id, 200), title: str(r.title, 200), link: str(r.link), price: str(r.price, 60),
      note: str(r.note, 300), bought: r.bought === true, boughtBy: typeof r.bought_by === "string" ? r.bought_by : null,
      boughtAt: toMs(r.bought_at), createdAt: toMs(r.created_at) ?? 0,
    };
  }

  // ---------- errors ----------
  function isNetErr(e, status) {
    if (!navigator.onLine) return true;
    if (status === 0) return true;
    const m = (e && (e.message || e.details)) || "";
    return /failed to fetch|networkerror|network request|load failed|fetch failed/i.test(m);
  }
  function isAuthErr(e, status) {
    return status === 401 || (e && /^PGRST30[0-3]$/.test(e.code || "")) || /jwt/i.test((e && e.message) || "");
  }
  function writeErrText(e, status) {
    const code = e && e.code;
    if (isNetErr(e, status)) return "Mistet kontakten, så endringen ble ikke lagret. Sjekk nettforbindelsen og prøv igjen.";
    if (isAuthErr(e, status)) return "Du er logget ut, så endringen ble ikke lagret. Last siden inn på nytt og logg inn igjen.";
    if (status === 429) return "For mange endringer på kort tid. Vent litt og prøv igjen.";
    if (code === "42501") return "Du har ikke tilgang til dette lenger, så endringen ble ikke lagret.";
    if (code === "23514" || code === "22001" || code === "23502") return "Noe av det du skrev ble ikke godtatt, så endringen ble ikke lagret. Sjekk feltene og prøv igjen.";
    if (code === "23503") return "Det du endret finnes ikke lenger. Listen er oppdatert, så prøv igjen.";
    return "Noe gikk galt, så endringen ble ikke lagret. Prøv igjen.";
  }

  // ---------- writes ----------
  function setBanner(kind, text) { S.banner = text ? { kind, text } : null; renderBanner(); }
  // fn returns a supabase-js promise ({ data, error, status }). Retries once on network trouble.
  async function write(fn) {
    if (!S.sb || !S.uid) { setBanner("error", "Du er ikke logget inn. Last siden inn på nytt og logg inn."); return null; }
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try { res = await fn(); } catch (e) { res = { error: e, status: 0 }; }
      const e = res && res.error;
      if (!e) {
        if (S.banner && S.banner.fromWrite) setBanner(null);
        scheduleRefetch(0);
        return res;
      }
      if (isNetErr(e, res.status) && attempt === 0) { await sleep(400 + Math.random() * 600); continue; }
      S.banner = { kind: "error", text: writeErrText(e, res.status), fromWrite: true };
      renderBanner();
      scheduleRefetch(0);
      return null;
    }
    return null;
  }

  // ---------- header / toolbar ----------
  function renderSummary() {
    if (S.fatal || S.view === "config") { els.summary.textContent = ""; return; }
    if (S.view === "loading") { els.summary.textContent = "Henter listen …"; return; }
    if (S.view !== "list") { els.summary.textContent = "Ønskelister for familie og venner"; return; }
    if (!S.loaded) { els.summary.textContent = "Henter listen …"; return; }
    const all = [...S.wishes.values()].filter(w => S.people.has(w.personId));
    const n = all.length;
    const b = all.filter(w => w.bought).length;
    const word = n === 1 ? "ønske" : "ønsker";
    els.summary.textContent = S.hide ? `${n} ${word} på listen` : `${n} ${word} på listen, ${b} er kjøpt`;
  }
  function renderBanner() {
    let msg = null;
    if (S.fatal) msg = { kind: "error", text: S.fatal };
    else if (S.banner) msg = S.banner;
    else if (S.offline) msg = { kind: "warn", text: "Du er uten nett. Det du ser kan være utdatert, og endringer lagres ikke før du er på nett igjen." };
    else if (S.view === "list" && (S.loadSlow || S.rtDown)) msg = S.loaded
      ? { kind: "warn", text: "Får ikke kontakt med listen akkurat nå. Det du ser kan være utdatert." }
      : { kind: "warn", text: "Får ikke kontakt med listen ennå. Sjekk nettforbindelsen." };
    const b = els.banner;
    b.replaceChildren();
    if (!msg) { b.hidden = true; return; }
    b.hidden = false;
    b.className = "banner" + (msg.kind === "error" ? " error" : msg.kind === "ok" ? " ok" : "");
    b.append(h("span", { text: msg.text }));
    if (S.banner && msg === S.banner) b.append(h("button", { class: "linkbtn", type: "button", text: "Lukk", onclick: () => setBanner(null) }));
  }
  function renderToolbar() {
    els.hideToggle.setAttribute("aria-checked", S.hide ? "true" : "false");
  }
  function renderPills(people) {
    const active = document.activeElement;
    const activeKey = active && els.pills.contains(active) ? active.dataset.key : null;
    const total = [...S.wishes.values()].filter(w => S.people.has(w.personId)).length;
    const mk = (key, label, n) => h("button", {
      class: "pill", type: "button", "aria-pressed": S.filter === key ? "true" : "false", dataset: { key },
      onclick: () => { S.filter = key; lsSet(LS.filter, key); render(); },
    }, label, h("span", { class: "n", text: String(n) }));
    const nodes = [mk("all", "Alle", total)];
    for (const p of people) nodes.push(mk(p.id, p.name || "Uten navn", wishesFor(p.id).length));
    els.pills.replaceChildren(...nodes);
    els.pills.hidden = people.length === 0;
    if (activeKey) { const t = els.pills.querySelector(`[data-key="${CSS.escape(activeKey)}"]`); if (t) t.focus(); }
  }

  // ---------- views ----------
  function setView(v) {
    S.view = v;
    render();
  }
  function renderViews() {
    const v = S.view;
    els.authView.hidden = v !== "auth";
    els.nameView.hidden = v !== "name";
    els.createView.hidden = v !== "create";
    els.listView.hidden = v !== "list";
    els.toolbar.hidden = v !== "list";
    els.groupbar.hidden = !(v === "list" || v === "create" || v === "name");
    els.groupPanel.hidden = !(v === "list" && S.ui.panelOpen);
    els.authInvited.hidden = !pendingInvite;

    // group bar
    const showSwitch = v === "list" || (v === "create" && S.groups.length > 0);
    els.groupSelect.hidden = !showSwitch;
    els.panelBtn.hidden = v !== "list";
    els.panelBtn.setAttribute("aria-expanded", S.ui.panelOpen ? "true" : "false");
    els.who.textContent = S.myName ? "Logget inn som " + S.myName : "";
    if (showSwitch) {
      const opts = S.groups.map(g => h("option", { value: g.id, text: g.name || "Uten navn" }));
      const same = els.groupSelect.options.length === opts.length &&
        opts.every((o, i) => els.groupSelect.options[i].value === o.value && els.groupSelect.options[i].textContent === o.textContent);
      if (!same) els.groupSelect.replaceChildren(...opts);
      if (S.gid) els.groupSelect.value = S.gid;
    }

    // create view: cancel only makes sense when there is a group to go back to
    els.createCancel.hidden = S.groups.length === 0;
    els.createIntro.textContent = S.groups.length === 0
      ? "Du er ikke med i noen gruppe ennå. Lag en gruppe for familien eller vennegjengen, og inviter de andre med en lenke. Har noen allerede laget en gruppe, kan du be om invitasjonslenken og åpne den, så blir du med."
      : "Lag en ny gruppe, for eksempel for en annen del av familien. Du kan bytte mellom gruppene øverst på siden.";
  }

  // ---------- sign in ----------
  els.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = els.authEmail.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { els.authErr.textContent = "Skriv inn en gyldig e-postadresse."; els.authEmail.focus(); return; }
    els.authErr.textContent = "";
    els.authGo.disabled = true;
    let error = null;
    try {
      ({ error } = await S.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: PAGE_URL } }));
    } catch (err) { error = err; }
    els.authGo.disabled = false;
    if (error) {
      const st = error.status;
      els.authErr.textContent = st === 429
        ? "For mange forsøk. Vent litt og prøv igjen."
        : isNetErr(error, st) ? "Mistet kontakten. Sjekk nettforbindelsen og prøv igjen."
        : "Kunne ikke sende innloggingslenken. Sjekk e-postadressen og prøv igjen.";
      return;
    }
    els.authSentText.textContent = `Vi har sendt en innloggingslenke til ${email}. Åpne e-posten og trykk på lenken for å logge inn.`;
    els.authAsk.hidden = true;
    els.authSent.hidden = false;
  });
  els.authAgain.addEventListener("click", () => {
    els.authSent.hidden = true; els.authAsk.hidden = false; els.authEmail.focus();
  });

  els.signOut.addEventListener("click", async () => {
    els.signOut.disabled = true;
    try { await S.sb.auth.signOut({ scope: "local" }); } catch {}
    els.signOut.disabled = false;
    // onAuthStateChange(SIGNED_OUT) resets the page; make sure it happens even if the call failed.
    handleSession(null);
  });

  // ---------- display name ----------
  els.nameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim().slice(0, 60);
    if (!name) { els.nameErr.textContent = "Skriv inn et navn."; els.nameInput.focus(); return; }
    els.nameErr.textContent = "";
    els.nameGo.disabled = true;
    const uid = S.uid;
    let res;
    try { res = await S.sb.from("profiles").insert({ id: uid, display_name: name }); } catch (err) { res = { error: err, status: 0 }; }
    els.nameGo.disabled = false;
    if (uid !== S.uid) return;
    if (res.error && res.error.code !== "23505") { els.nameErr.textContent = writeErrText(res.error, res.status); return; }
    S.myName = name;
    els.nameInput.value = "";
    afterProfile();
  });

  // ---------- create group ----------
  els.createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.createName.value.trim().slice(0, 60);
    if (!name) { els.createErr.textContent = "Skriv inn et navn på gruppen."; els.createName.focus(); return; }
    els.createErr.textContent = "";
    els.createGo.disabled = true;
    let res;
    try { res = await S.sb.rpc("create_group", { group_name: name }); } catch (err) { res = { error: err, status: 0 }; }
    els.createGo.disabled = false;
    if (res.error) { els.createErr.textContent = writeErrText(res.error, res.status); return; }
    els.createName.value = "";
    await openGroups(res.data);
  });
  els.createCancel.addEventListener("click", () => {
    els.createName.value = ""; els.createErr.textContent = "";
    if (S.groups.length) setView("list");
  });

  // ---------- group bar and panel ----------
  els.groupSelect.addEventListener("change", () => {
    const gid = els.groupSelect.value;
    if (S.view === "create") S.view = "list";
    chooseGroup(gid);
  });
  els.panelBtn.addEventListener("click", () => {
    const open = !S.ui.panelOpen;
    S.ui.panelOpen = open;
    if (!open) { S.ui.renamingGroup = false; S.ui.confirmRegen = false; S.ui.confirmMember = null; S.ui.confirmLeave = false; }
    els.copyStatus.textContent = "";
    render();
    if (open) els.copyInvite.focus();
  });

  els.copyInvite.addEventListener("click", async () => {
    const link = els.inviteLink.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      els.copyStatus.textContent = "Kopiert! Lim inn lenken i en melding til dem du vil invitere.";
    } catch {
      els.inviteLink.focus(); els.inviteLink.select();
      els.copyStatus.textContent = "Kunne ikke kopiere automatisk. Lenken er merket, så du kan kopiere den selv.";
    }
  });

  function openGroupRename() {
    const g = currentGroup(); if (!g) return;
    S.ui.renamingGroup = true;
    els.groupRenameInput.value = g.name;
    els.groupRenameErr.textContent = "";
    render();
    els.groupRenameInput.focus(); els.groupRenameInput.select();
  }
  function closeGroupRename() { S.ui.renamingGroup = false; render(); }
  async function saveGroupRename() {
    const g = currentGroup(); if (!g) return;
    const v = els.groupRenameInput.value.trim().slice(0, 60);
    if (!v) { els.groupRenameErr.textContent = "Navnet kan ikke være tomt."; els.groupRenameInput.focus(); return; }
    if (v !== g.name) {
      els.groupRenameSave.disabled = true;
      const ok = await write(() => S.sb.from("groups").update({ name: v }).eq("id", g.id));
      els.groupRenameSave.disabled = false;
      if (!ok) return;
      g.name = v;
    }
    closeGroupRename();
  }
  els.groupRenameSave.addEventListener("click", saveGroupRename);
  els.groupRenameCancel.addEventListener("click", closeGroupRename);
  els.groupRenameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveGroupRename(); }
    if (e.key === "Escape") closeGroupRename();
  });

  function confirmBox(text, yesText, onYes, onNo) {
    return h("div", { class: "confirm-box" },
      h("p", { text }),
      h("div", { class: "btns" },
        h("button", { class: "btn danger small", type: "button", text: yesText, onclick: onYes }),
        h("button", { class: "btn ghost small", type: "button", text: "Nei", onclick: onNo })));
  }

  function renderPanel() {
    const g = currentGroup();
    if (!g || !S.ui.panelOpen) return;
    const owner = isOwner();
    const focusKey = document.activeElement && els.groupPanel.contains(document.activeElement) ? document.activeElement.dataset.key : null;

    els.groupTitle.textContent = g.name || "Uten navn";
    els.groupHeadActions.replaceChildren();
    if (owner && !S.ui.renamingGroup) {
      els.groupHeadActions.append(h("button", { class: "linkbtn", type: "button", text: "Gi nytt navn", dataset: { key: "grename" }, onclick: openGroupRename }));
    }
    if (!owner) S.ui.renamingGroup = false;
    els.groupRename.hidden = !S.ui.renamingGroup;

    const link = g.token ? inviteLink(g.token) : "";
    if (els.inviteLink.value !== link) { els.inviteLink.value = link; els.copyStatus.textContent = ""; }

    // regenerate invite (owner only)
    els.regenArea.replaceChildren();
    if (owner) {
      if (S.ui.confirmRegen) {
        els.regenArea.append(confirmBox("Lage en ny lenke? Den gamle lenken slutter å virke, men alle som allerede er med, blir med videre.",
          "Ja, lag ny lenke", regenerateInvite, () => { S.ui.confirmRegen = false; render(); }));
      } else {
        els.regenArea.append(h("button", { class: "linkbtn", type: "button", text: "Lag ny lenke (den gamle slutter å virke)", dataset: { key: "regen" },
          onclick: () => { S.ui.confirmRegen = true; render(); els.regenArea.querySelector(".confirm-box button")?.focus(); } }));
      }
    }

    // members
    els.membersTitle.textContent = `Medlemmer (${S.members.length})`;
    if (S.ui.confirmMember && !S.members.some(m => m.id === S.ui.confirmMember)) S.ui.confirmMember = null;
    const items = S.members.map(m => {
      const tags = [];
      if (m.id === S.uid) tags.push("deg");
      if (m.id === g.ownerId) tags.push("eier");
      const li = h("li", null,
        h("span", { class: "mname", text: m.name || "Uten navn" }),
        tags.length ? h("span", { class: "tag", text: "(" + tags.join(", ") + ")" }) : null);
      if (owner && m.id !== S.uid) {
        if (S.ui.confirmMember === m.id) {
          li.append(confirmBox(`Fjerne ${m.name || "denne personen"} fra gruppen? Personen mister tilgang til listene, men kan bli med igjen med invitasjonslenken. Lag gjerne en ny lenke også.`,
            "Ja, fjern", () => removeMember(m.id), () => { S.ui.confirmMember = null; render(); }));
        } else {
          li.append(h("button", { class: "linkbtn mact", type: "button", text: "Fjern", dataset: { key: "rm-" + m.id }, "aria-label": `Fjern ${m.name || "medlem"} fra gruppen`,
            onclick: () => { S.ui.confirmMember = m.id; render(); els.memberList.querySelector(".confirm-box button")?.focus(); } }));
        }
      }
      return li;
    });
    els.memberList.replaceChildren(...items);

    // footer: leave, new group
    els.panelFoot.replaceChildren();
    if (S.ui.confirmLeave) {
      const alone = S.members.length <= 1;
      const text = alone
        ? `Forlate «${g.name}»? Du er den eneste i gruppen, så gruppen og alle listene i den blir slettet.`
        : owner
          ? `Forlate «${g.name}»? Du mister tilgang til listene, og den som har vært lengst med, blir ny eier.`
          : `Forlate «${g.name}»? Du mister tilgang til listene, men kan bli med igjen med invitasjonslenken.`;
      els.panelFoot.append(confirmBox(text, "Ja, forlat", leaveGroup, () => { S.ui.confirmLeave = false; render(); }));
    } else {
      els.panelFoot.append(
        h("button", { class: "btn ghost small", type: "button", text: "Lag ny gruppe", dataset: { key: "newgroup" },
          onclick: () => { S.ui.panelOpen = false; els.createErr.textContent = ""; setView("create"); els.createName.focus(); } }),
        h("button", { class: "linkbtn", type: "button", text: "Forlat gruppen", dataset: { key: "leave" },
          onclick: () => { S.ui.confirmLeave = true; render(); els.panelFoot.querySelector(".confirm-box button")?.focus(); } }));
    }
    if (focusKey) { const t = els.groupPanel.querySelector(`[data-key="${CSS.escape(focusKey)}"]`); if (t) t.focus(); }
  }

  async function regenerateInvite() {
    const gid = S.gid;
    const res = await write(() => S.sb.rpc("regenerate_invite", { gid }));
    if (!res) return;
    const g = S.groups.find(x => x.id === gid);
    if (g && typeof res.data === "string") g.token = res.data;
    S.ui.confirmRegen = false;
    els.copyStatus.textContent = "";
    render();
    if (gid === S.gid) els.copyStatus.textContent = "Ny lenke er laget. Den gamle virker ikke lenger.";
  }
  async function removeMember(userId) {
    const gid = S.gid;
    const ok = await write(() => S.sb.from("group_members").delete().eq("group_id", gid).eq("user_id", userId));
    if (!ok) return;
    S.members = S.members.filter(m => m.id !== userId);
    S.ui.confirmMember = null;
    render();
  }
  async function leaveGroup() {
    const g = currentGroup(); if (!g) return;
    const ok = await write(() => S.sb.from("group_members").delete().eq("group_id", g.id).eq("user_id", S.uid));
    if (!ok) return;
    S.groups = S.groups.filter(x => x.id !== g.id);
    if (lsGet(LS.group) === g.id) lsDel(LS.group);
    S.ui = freshUi();
    S.banner = { kind: "ok", text: `Du har forlatt «${g.name}».` };
    if (S.groups.length) chooseGroup(S.groups[0].id);
    else { chooseGroup(null); setView("create"); }
  }

  // ---------- add person ----------
  els.addPersonBtn.addEventListener("click", () => {
    els.addPerson.hidden = false; els.personErr.textContent = ""; els.newPersonName.focus();
  });
  els.cancelPerson.addEventListener("click", () => { els.addPerson.hidden = true; els.newPersonName.value = ""; els.personErr.textContent = ""; });
  els.newPersonName.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); savePerson(); }
    if (e.key === "Escape") els.cancelPerson.click();
  });
  els.savePerson.addEventListener("click", savePerson);
  async function savePerson() {
    const name = els.newPersonName.value.trim().slice(0, 60);
    if (!name) { els.personErr.textContent = "Skriv inn et navn."; els.newPersonName.focus(); return; }
    els.savePerson.disabled = true;
    const maxOrder = Math.max(0, ...[...S.people.values()].map(p => p.order || 0));
    const gid = S.gid;
    const ok = await write(() => S.sb.from("people").insert({ group_id: gid, name, sort_order: maxOrder + 1 }));
    els.savePerson.disabled = false;
    if (ok) { els.newPersonName.value = ""; els.personErr.textContent = ""; els.addPerson.hidden = true; }
  }

  // ---------- hide toggle ----------
  els.hideToggle.addEventListener("click", () => {
    S.hide = !S.hide; lsSet(LS.hide, S.hide ? "1" : "0");
    render();
  });

  // ---------- cards ----------
  function makeCard(pid) {
    const head = h("div", { class: "head" });
    const bar = h("div", { class: "bar", "aria-hidden": "true" }, h("span"));
    const list = h("ul", { class: "wishes" });
    const empty = h("p", { class: "empty" });
    const title = h("input", { type: "text", placeholder: "Ønske", "aria-label": "Ønske", maxlength: "200", autocomplete: "off" });
    const link = h("input", { type: "url", placeholder: "Lenke (valgfri)", "aria-label": "Lenke (valgfri)", inputmode: "url", autocomplete: "off" });
    const price = h("input", { type: "text", placeholder: "Pris (valgfri)", "aria-label": "Pris (valgfri)", maxlength: "60", autocomplete: "off" });
    const go = h("button", { class: "btn go", type: "submit", text: "Legg til ønske" });
    const err = h("p", { class: "err", "aria-live": "polite" });
    const form = h("form", { class: "addwish", novalidate: true }, title, h("div", { class: "two" }, link, price), go, err);
    const card = { pid, sig: null, root: h("section", { class: "card", dataset: { pid } }, head, bar, list, empty, form), head, bar, list, empty, form, inputs: { title, link, price }, go, err };
    form.addEventListener("submit", (e) => { e.preventDefault(); addWish(card); });
    return card;
  }
  async function addWish(card) {
    const { title, link, price } = card.inputs;
    const t = title.value.trim().slice(0, 200);
    if (!t) { card.err.textContent = "Skriv inn hva som ønskes."; title.focus(); return; }
    const l = normalizeLink(link.value);
    if (!l.ok) { card.err.textContent = LINK_ERR; link.focus(); return; }
    card.err.textContent = "";
    card.go.disabled = true;
    const gid = S.gid;
    const ok = await write(() => S.sb.from("wishes").insert({
      group_id: gid, person_id: card.pid, title: t, link: l.value, price: price.value.trim().slice(0, 60), note: "",
    }));
    card.go.disabled = false;
    if (ok) { title.value = ""; link.value = ""; price.value = ""; title.focus(); }
  }

  function renderHead(card, person, list) {
    const total = list.length, bought = list.filter(w => w.bought).length;
    const mode = S.ui.renaming === person.id ? "rename" : S.ui.confirmPerson === person.id ? "confirm" : "normal";
    const sig = JSON.stringify(mode === "rename" ? [mode] : [mode, person.name, total, bought, S.hide]);
    // progress bar always updates
    card.bar.hidden = S.hide || total === 0;
    card.bar.firstChild.style.width = total ? (bought / total * 100) + "%" : "0";
    if (sig === card.sig) return;
    card.sig = sig;
    const name = person.name || "Uten navn";
    const head = card.head;
    head.replaceChildren();
    head.className = "head" + (mode === "rename" ? " editing" : mode === "confirm" ? " confirm" : "");
    if (mode === "rename") {
      const input = h("input", { type: "text", value: person.name, "aria-label": "Nytt navn", maxlength: "60", autocomplete: "off" });
      const err = h("p", { class: "err" });
      const save = async () => {
        const v = input.value.trim().slice(0, 60);
        if (!v) { err.textContent = "Navnet kan ikke være tomt."; input.focus(); return; }
        if (v !== person.name) {
          const ok = await write(() => S.sb.from("people").update({ name: v }).eq("id", person.id));
          if (!ok) return;
        }
        S.ui.renaming = null; render();
        const c = cards.get(person.id); c && c.head.querySelector("button")?.focus();
      };
      const cancel = () => { S.ui.renaming = null; render(); };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); save(); }
        if (e.key === "Escape") cancel();
      });
      head.append(h("div", { class: "rename-row" }, input,
        h("button", { class: "btn small", type: "button", text: "Lagre", onclick: save }),
        h("button", { class: "btn ghost small", type: "button", text: "Avbryt", onclick: cancel })), err);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return;
    }
    const countText = S.hide ? `${total} ${total === 1 ? "ønske" : "ønsker"}` : `${bought} av ${total} kjøpt`;
    head.append(h("h2", { text: name }), h("span", { class: "count", text: countText }));
    head.append(h("div", { class: "card-actions" },
      h("button", { class: "linkbtn", type: "button", text: "Gi nytt navn", onclick: () => { S.ui.renaming = person.id; S.ui.confirmPerson = null; render(); } }),
      h("button", { class: "linkbtn", type: "button", text: "Slett kort", onclick: () => { S.ui.confirmPerson = person.id; S.ui.renaming = null; render(); card.head.querySelector(".confirm-box button")?.focus(); } })));
    if (mode === "confirm") {
      const msg = total
        ? `Slette kortet for ${name} og ${total === 1 ? "ønsket" : total === 2 ? "begge ønskene" : `alle ${total} ønskene`} på det?`
        : `Slette kortet for ${name}?`;
      head.append(h("div", { class: "confirm-box", style: "flex-basis:100%;margin-top:10px" },
        h("p", { text: msg }),
        h("div", { class: "btns" },
          h("button", { class: "btn danger small", type: "button", text: "Ja, slett", onclick: () => deletePerson(person.id) }),
          h("button", { class: "btn ghost small", type: "button", text: "Nei", onclick: () => { S.ui.confirmPerson = null; render(); } }))));
    }
  }
  async function deletePerson(pid) {
    // The database deletes the person's wishes too (on delete cascade).
    const ok = await write(() => S.sb.from("people").delete().eq("id", pid));
    if (ok) {
      S.ui.confirmPerson = null;
      S.people.delete(pid);
      for (const [id, w] of S.wishes) if (w.personId === pid) S.wishes.delete(id);
      if (S.filter === pid) { S.filter = "all"; lsSet(LS.filter, "all"); }
      render();
    }
  }

  // ---------- wish rows ----------
  function checkSvg() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    for (const [k, v] of Object.entries({ d: "M3 8.5l3.2 3L13 4.5", fill: "none", stroke: "#fff", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(k, v);
    svg.append(path);
    return svg;
  }

  function renderRow(row, w) {
    const mode = S.ui.editingWish === w.id ? "edit" : S.ui.confirmWish === w.id ? "confirm" : "normal";
    const buyer = w.boughtBy ? (w.boughtBy === S.uid ? "deg" : (S.names[w.boughtBy] || "noen")) : "noen";
    const today = dayKey(osloParts(Date.now()));
    const sig = JSON.stringify(mode === "edit" ? [mode] :
      [mode, w.title, w.link, w.price, w.note, w.bought, w.boughtBy, w.boughtAt, buyer, S.hide, today]);
    if (sig === row.sig) return;
    row.sig = sig;
    const li = row.el;
    li.replaceChildren();
    const showBought = !S.hide && w.bought;
    li.className = "wish" + (showBought ? " bought" : "");

    if (mode === "edit") { renderEdit(row, w); return; }

    const locked = S.hide;
    const cb = h("input", { type: "checkbox", checked: showBought, disabled: locked, "aria-label": `Kjøpt: ${w.title}` });
    cb.addEventListener("change", () => toggleBought(w.id, cb.checked));
    const box = h("span", { class: "box" }, checkSvg());
    const check = h("label", { class: "check" + (locked ? " locked" : ""), title: S.hide ? "Skjult mens «Skjul hva som er kjøpt» er på" : null },
      cb, box, h("span", { class: "cap", "aria-hidden": "true", text: "Kjøpt" }));

    const meta = h("div", { class: "meta" });
    const u = safeUrl(w.link);
    if (u) meta.append(h("a", { href: u.href, target: "_blank", rel: "noopener noreferrer", text: u.hostname.replace(/^www\./, "") + " ↗" }));
    if (w.price) meta.append(h("span", { class: "price", text: w.price }));

    let boughtLine = null;
    if (showBought) {
      const when = fmtWhen(w.boughtAt);
      boughtLine = h("p", { class: "boughtby", text: `Kjøpt av ${buyer}${when ? ", " + when : ""}` });
    }

    const body = h("div", { class: "wbody" },
      h("div", { class: "wtitle", text: w.title || "Uten navn" }),
      meta.childNodes.length ? meta : null,
      w.note ? h("p", { class: "note", text: w.note }) : null,
      boughtLine,
      mode === "confirm" ? h("div", { class: "confirm-box" },
        h("p", { text: `Slette «${w.title}»?` }),
        h("div", { class: "btns" },
          h("button", { class: "btn danger small", type: "button", text: "Ja", onclick: () => deleteWish(w.id) }),
          h("button", { class: "btn ghost small", type: "button", text: "Nei", onclick: () => { S.ui.confirmWish = null; render(); } }))) : null);

    li.append(check, body);
    if (mode !== "confirm") {
      li.append(h("div", { class: "wactions" },
        h("button", { class: "linkbtn", type: "button", "aria-label": `Endre «${w.title}»`, title: "Endre", text: "✏️",
          onclick: () => { S.ui.editingWish = w.id; S.ui.confirmWish = null; render(); } }),
        h("button", { class: "linkbtn", type: "button", "aria-label": `Slett «${w.title}»`, text: "Slett",
          onclick: () => { S.ui.confirmWish = w.id; S.ui.editingWish = null; render(); row.el.querySelector(".confirm-box button")?.focus(); } })));
    }
  }

  function renderEdit(row, w) {
    const title = h("input", { type: "text", value: w.title, "aria-label": "Ønske", maxlength: "200", autocomplete: "off" });
    const link = h("input", { type: "url", value: w.link, placeholder: "Lenke (valgfri)", "aria-label": "Lenke (valgfri)", inputmode: "url", autocomplete: "off" });
    const price = h("input", { type: "text", value: w.price, placeholder: "Pris (valgfri)", "aria-label": "Pris (valgfri)", maxlength: "60", autocomplete: "off" });
    const err = h("p", { class: "err", "aria-live": "polite" });
    const cancel = () => { S.ui.editingWish = null; row.sig = null; render(); };
    const save = async () => {
      const t = title.value.trim().slice(0, 200);
      if (!t) { err.textContent = "Ønsket kan ikke være tomt."; title.focus(); return; }
      const l = normalizeLink(link.value);
      if (!l.ok) { err.textContent = LINK_ERR; link.focus(); return; }
      const ok = await write(() => S.sb.from("wishes").update({ title: t, link: l.value, price: price.value.trim().slice(0, 60) }).eq("id", w.id));
      if (ok) { S.ui.editingWish = null; row.sig = null; render(); }
    };
    for (const i of [title, link, price]) i.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); save(); }
      if (e.key === "Escape") cancel();
    });
    row.el.append(h("div", { class: "wedit" }, title, h("div", { class: "two" }, link, price),
      h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", text: "Lagre", onclick: save }),
        h("button", { class: "btn ghost small", type: "button", text: "Avbryt", onclick: cancel })), err));
    requestAnimationFrame(() => title.focus());
  }

  async function toggleBought(id, checked) {
    if (S.hide) return;
    // The database fills in bought_by (the signed-in user) and bought_at (now).
    const ok = await write(() => S.sb.from("wishes").update({ bought: checked }).eq("id", id));
    if (!ok) { const r = rows.get(id); if (r) r.sig = null; render(); }
  }
  async function deleteWish(id) {
    const ok = await write(() => S.sb.from("wishes").delete().eq("id", id));
    if (ok) { S.ui.confirmWish = null; S.wishes.delete(id); render(); }
  }

  // ---------- main render ----------
  function render() {
    renderViews();
    renderBanner();
    renderSummary();
    if (S.fatal) { els.state.hidden = false; els.state.textContent = "Listen kan ikke vises her."; return; }
    if (S.view === "loading") { els.state.hidden = false; els.state.textContent = "Henter listen …"; return; }
    if (S.view !== "list") { els.state.hidden = true; return; }

    renderToolbar();
    renderPanel();
    if (!S.loaded) { els.state.hidden = false; els.state.textContent = "Henter listen …"; els.pills.hidden = true; els.addPersonBtn.hidden = true; return; }
    els.addPersonBtn.hidden = false;

    const people = sortedPeople();
    if (S.filter !== "all" && !S.people.has(S.filter)) S.filter = "all";
    renderPills(people);

    if (people.length === 0) {
      els.state.hidden = false;
      els.state.textContent = "Ingen personer på listen ennå. Trykk «Legg til person» for å lage det første kortet.";
    } else els.state.hidden = true;

    const cardNodes = [];
    for (const p of people) {
      let card = cards.get(p.id);
      if (!card) { card = makeCard(p.id); cards.set(p.id, card); }
      const list = wishesFor(p.id);
      card.root.hidden = S.filter !== "all" && S.filter !== p.id;
      renderHead(card, p, list);

      const rowNodes = [];
      for (const w of list) {
        let row = rows.get(w.id);
        if (!row) { row = { el: h("li", { class: "wish" }), sig: null }; rows.set(w.id, row); }
        renderRow(row, w);
        rowNodes.push(row.el);
      }
      placeChildren(card.list, rowNodes);
      card.list.hidden = list.length === 0;
      card.empty.hidden = list.length > 0;
      card.empty.textContent = `Ingen ønsker for ${p.name || "denne personen"} ennå. Legg til det første nedenfor.`;
      cardNodes.push(card.root);
    }
    placeChildren(els.cards, cardNodes);
    for (const [pid] of cards) if (!S.people.has(pid)) cards.delete(pid);
    for (const [wid] of rows) if (!S.wishes.has(wid)) rows.delete(wid);
  }

  // ---------- loading data ----------
  // Every change (ours or someone else's, via Realtime) triggers a refetch of
  // the current group. Simple and robust at family scale. fetchGen makes
  // answers for a group we have since left or switched away from harmless.
  let fetchGen = 0, refetchTimer = null, retryTimer = null, refetching = false, refetchAgain = false;

  function scheduleRefetch(delay = 150) {
    if (!S.uid || !S.gid) return;
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(refetch, delay);
  }
  async function refetch() {
    if (!S.uid || !S.gid) return;
    if (refetching) { refetchAgain = true; return; }
    refetching = true;
    try { await loadGroupData(); }
    finally {
      refetching = false;
      if (refetchAgain) { refetchAgain = false; scheduleRefetch(0); }
    }
  }

  async function loadGroupData() {
    const gen = fetchGen, sb = S.sb, gid = S.gid;
    let res;
    try {
      res = await Promise.all([
        sb.from("groups").select("id,name,owner_id,invite_token,created_at").order("created_at"),
        sb.from("group_members").select("user_id,joined_at,profile:profiles(display_name)").eq("group_id", gid).order("joined_at"),
        sb.from("people").select("id,name,sort_order,created_at").eq("group_id", gid),
        sb.from("wishes").select("id,person_id,title,link,price,note,bought,bought_by,bought_at,created_at").eq("group_id", gid),
      ]);
    } catch (e) { res = [{ error: e, status: 0 }]; }
    if (gen !== fetchGen) return;
    const bad = res.find(r => r.error);
    if (bad) {
      S.loadSlow = true; renderBanner();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => scheduleRefetch(0), 5000 + Math.random() * 3000);
      return;
    }
    const [g, m, p, w] = res;
    S.loadSlow = false;
    const oldName = currentGroup()?.name || "gruppen";
    S.groups = g.data.map(readGroup);
    if (!S.groups.some(x => x.id === gid)) {
      // Removed from the group (or it was deleted) while we were looking at it.
      const name = oldName;
      S.banner = { kind: "error", text: `Du er ikke lenger med i «${name}».` };
      if (lsGet(LS.group) === gid) lsDel(LS.group);
      S.ui = freshUi();
      if (S.groups.length) chooseGroup(S.groups[0].id);
      else { chooseGroup(null); setView("create"); }
      return;
    }
    S.members = m.data.map(r => ({ id: r.user_id, name: str(r.profile && r.profile.display_name, 60), joinedAt: toMs(r.joined_at) }));
    S.names = {};
    for (const x of S.members) S.names[x.id] = x.name;
    if (S.names[S.uid]) S.myName = S.names[S.uid];
    S.people.clear();
    for (const r of p.data) S.people.set(r.id, readPerson(r));
    S.wishes.clear();
    for (const r of w.data) S.wishes.set(r.id, readWish(r));
    S.loaded = true;
    render();
  }

  // ---------- realtime ----------
  let channel = null;
  function resubscribe() {
    if (channel) { const old = channel; channel = null; S.sb.removeChannel(old); }
    S.rtDown = false;
    if (!S.gid) return;
    const filter = "group_id=eq." + S.gid;
    const ch = S.sb.channel("gruppe-" + S.gid);
    for (const table of ["people", "wishes", "group_members"]) {
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter }, () => scheduleRefetch());
    }
    channel = ch;
    ch.subscribe((status) => {
      if (channel !== ch) return;
      if (status === "SUBSCRIBED") {
        if (S.rtDown) { S.rtDown = false; renderBanner(); }
        scheduleRefetch(); // catch anything missed while (re)connecting
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        S.rtDown = true; renderBanner(); // supabase-js keeps retrying on its own
      }
    });
  }

  function chooseGroup(gid) {
    fetchGen++;
    clearTimeout(retryTimer);
    const changed = gid !== S.gid;
    S.gid = gid || null;
    if (S.gid) lsSet(LS.group, S.gid);
    if (changed) {
      const panelOpen = S.ui.panelOpen;
      S.ui = freshUi();
      S.ui.panelOpen = panelOpen;
      S.people.clear(); S.wishes.clear(); S.members = []; S.names = {}; S.loaded = false;
      cards.clear(); rows.clear(); els.cards.replaceChildren();
      els.addPerson.hidden = true; els.newPersonName.value = ""; els.personErr.textContent = "";
      els.copyStatus.textContent = "";
      resubscribe();
    }
    render();
    if (S.gid) scheduleRefetch(0);
  }

  // ---------- session lifecycle ----------
  function resetSession() {
    fetchGen++;
    clearTimeout(refetchTimer); clearTimeout(retryTimer);
    if (channel) { const old = channel; channel = null; S.sb.removeChannel(old); }
    S.uid = null; S.myName = ""; S.groups = []; S.gid = null; S.members = [];
    S.people.clear(); S.wishes.clear(); S.names = {}; S.loaded = false;
    S.ui = freshUi(); S.loadSlow = false; S.rtDown = false; S.fatal = null;
    cards.clear(); rows.clear(); els.cards.replaceChildren();
    if (S.banner && S.banner.kind !== "error") S.banner = null;
  }

  async function handleSession(session) {
    const user = session && session.user;
    const uid = user ? user.id : null;
    if (uid && uid === S.uid) return; // token refresh or duplicate event
    if (!uid && S.view === "auth") return;
    resetSession();
    if (!uid) { setView("auth"); return; }
    S.uid = uid;
    // supabase-js clears the token hash but leaves a bare "#" behind.
    if (location.href.endsWith("#")) history.replaceState(null, "", location.pathname + location.search);
    setView("loading");
    let res;
    try { res = await S.sb.from("profiles").select("display_name").eq("id", uid).maybeSingle(); }
    catch (e) { res = { error: e, status: 0 }; }
    if (S.uid !== uid) return;
    if (res.error) {
      S.fatal = isNetErr(res.error, res.status)
        ? "Får ikke kontakt med listen. Sjekk nettforbindelsen og last siden inn på nytt."
        : "Kunne ikke hente kontoen din. Last siden inn på nytt, og prøv å logge inn igjen hvis det fortsetter.";
      render(); return;
    }
    if (!res.data) { setView("name"); els.nameInput.focus(); return; }
    S.myName = str(res.data.display_name, 60);
    afterProfile();
  }

  // After sign-in and display name: use a pending invite, then open groups.
  async function afterProfile() {
    const uid = S.uid;
    let joined = null;
    if (pendingInvite) {
      setView("loading");
      let res;
      try { res = await S.sb.rpc("join_group", { token: pendingInvite }); } catch (e) { res = { error: e, status: 0 }; }
      if (S.uid !== uid) return;
      if (res.error) {
        if (isNetErr(res.error, res.status)) {
          S.banner = { kind: "error", text: "Mistet kontakten, så du ble ikke med i gruppen ennå. Last siden inn på nytt for å prøve igjen." };
        } else {
          clearInvite();
          S.banner = { kind: "error", text: res.error.code === "P0002"
            ? "Invitasjonslenken virker ikke lenger. Be den som inviterte deg om en ny lenke."
            : "Kunne ikke bli med i gruppen. Prøv å åpne invitasjonslenken på nytt." };
        }
      } else {
        clearInvite();
        joined = res.data;
      }
    }
    await openGroups(joined, joined ? "joined" : null);
  }

  async function openGroups(preferId, reason) {
    const uid = S.uid;
    let res;
    try { res = await S.sb.from("groups").select("id,name,owner_id,invite_token,created_at").order("created_at"); }
    catch (e) { res = { error: e, status: 0 }; }
    if (S.uid !== uid) return;
    if (res.error) {
      S.fatal = "Får ikke kontakt med listen. Sjekk nettforbindelsen og last siden inn på nytt.";
      render(); return;
    }
    S.groups = res.data.map(readGroup);
    if (!S.groups.length) { chooseGroup(null); setView("create"); return; }
    const pref = preferId || lsGet(LS.group);
    const gid = S.groups.some(g => g.id === pref) ? pref : S.groups[0].id;
    if (reason === "joined") {
      const g = S.groups.find(x => x.id === gid);
      S.banner = { kind: "ok", text: `Velkommen! Du er nå med i «${g ? g.name : "gruppen"}».` };
    }
    S.view = "list";
    chooseGroup(gid);
  }

  // ---------- connectivity ----------
  window.addEventListener("offline", () => { S.offline = true; renderBanner(); });
  window.addEventListener("online", () => { S.offline = false; renderBanner(); scheduleRefetch(0); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleRefetch(0); });
  setInterval(() => { if (S.view === "list" && S.loaded) render(); }, 60000);

  // ---------- start ----------
  function init() {
    const cfg = window.GAVELISTEN_CONFIG || {};
    const url = typeof cfg.supabaseUrl === "string" ? cfg.supabaseUrl.trim() : "";
    const key = typeof cfg.supabaseAnonKey === "string" ? cfg.supabaseAnonKey.trim() : "";
    if (!/^https:\/\/\S+$/.test(url) || !key || key === "REPLACE_ME") {
      S.view = "config";
      S.fatal = "Appen er ikke satt opp ennå. Fyll inn Supabase-adressen og nøkkelen i config.js.";
      render(); return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      S.view = "config";
      S.fatal = "Kunne ikke laste appen. Sjekk nettforbindelsen og last siden inn på nytt.";
      render(); return;
    }
    S.sb = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    render();
    // Do not call Supabase from inside the callback itself (supabase-js can
    // deadlock on its auth lock); hand the session over on the next tick.
    S.sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => handleSession(session), 0); });
  }
  init();
})();
