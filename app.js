// Gavelisten: a shared wish list per group (family or friends).
// Static page; data, sign-in, images and live updates come from Supabase.
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
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  // ---------- time in Europe/Oslo: "i dag 14:05", "i går 09:30", "3. des. 18:10" ----------
  const TZ = "Europe/Oslo";
  const fmtKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const fmtTime = new Intl.DateTimeFormat("nb-NO", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDay = new Intl.DateTimeFormat("nb-NO", { timeZone: TZ, day: "numeric", month: "short" });
  const fmtYear = new Intl.DateTimeFormat("nb-NO", { timeZone: TZ, year: "numeric" });
  function when(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    const d = new Date(ms), now = new Date();
    const k = fmtKey.format(d), today = fmtKey.format(now), yest = fmtKey.format(new Date(now.getTime() - 86400000));
    const t = fmtTime.format(d).replace(".", ":");
    if (k === today) return "i dag " + t;
    if (k === yest) return "i går " + t;
    let day = fmtDay.format(d);
    if (!/\.$/.test(day)) day += ".";
    if (fmtYear.format(d) !== fmtYear.format(now)) day += " " + fmtYear.format(d);
    return day + " " + t;
  }

  // ---------- links: only http/https; add https:// when no scheme is given ----------
  function normalizeLink(raw) {
    let s = str(raw).trim();
    if (!s) return { ok: true, value: "" };
    if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) {
      if (/^[a-z][a-z0-9+.\-]*:/i.test(s) && !/^[^:\/]+\.[^:\/]+:\d/.test(s) && !/^localhost:/i.test(s)) {
        return { ok: false, msg: "Lenken må være en nettadresse som starter med http eller https." };
      }
      s = "https://" + s.replace(/^\/+/, "");
    }
    let u;
    try { u = new URL(s); } catch { return { ok: false, msg: "Lenken ser ikke riktig ut. Sjekk adressen." }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, msg: "Bare lenker som starter med http eller https er lov." };
    if (!u.hostname.includes(".")) return { ok: false, msg: "Lenken ser ikke riktig ut. Sjekk adressen." };
    if (u.href.length > 2000) return { ok: false, msg: "Lenken er for lang." };
    return { ok: true, value: u.href };
  }
  function safeHref(v) {
    if (typeof v !== "string" || !v) return null;
    try { const u = new URL(v); return (u.protocol === "http:" || u.protocol === "https:") ? u.href : null; } catch { return null; }
  }
  // Shop name from the address, without fetching anything: the part before
  // the public suffix, capitalised, with a few known spellings.
  const SITE_NAMES = { trekbikes: "Trek", sprell: "Sprell", amazon: "Amazon", komplett: "Komplett", elkjop: "Elkjøp", xxl: "XXL", ikea: "IKEA", lekekassen: "Lekekassen", br: "BR", clasohlson: "Clas Ohlson", power: "Power", zalando: "Zalando", platekompaniet: "Platekompaniet", adlibris: "Adlibris", ark: "Ark", norli: "Norli", lego: "LEGO", apotek1: "Apotek 1", boozt: "Boozt" };
  function siteName(href) {
    try {
      const host = new URL(href).hostname.replace(/^www\./, "");
      const parts = host.split(".");
      let base = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      if (parts.length >= 3 && /^(co|com|org|net)$/.test(base)) base = parts[parts.length - 3];
      if (SITE_NAMES[base]) return SITE_NAMES[base];
      return base.charAt(0).toUpperCase() + base.slice(1);
    } catch { return "nettsiden"; }
  }

  // ---------- local storage keys ----------
  const LS = { hide: "gl-hide", filter: "gl-filter", group: "gl-group", invite: "gl-invite", theme: "gl-theme" };

  // ---------- read the URL before supabase-js does ----------
  // Page address without query or hash: where magic links and invites point.
  const PAGE_URL = location.origin + location.pathname;

  // Invite link: ?bli-med=<group-name-slug>-<token>. The name part is only there
  // so people can tell which group a link is for; the random token after the
  // last "-" is what grants access. Plain ?bli-med=<token> (older links) still works. Kept in localStorage so it survives the
  // round trip through the sign-in e-mail, then stripped from the address bar.
  let pendingInvite = null;
  let initialBanner = null;
  {
    const url = new URL(location.href);
    let changed = false;
    if (url.searchParams.has("bli-med")) {
      const raw = (url.searchParams.get("bli-med") || "").trim().toLowerCase();
      const m = /^(?:[a-z0-9-]{0,60}-)?([0-9a-f]{16,100})$/.exec(raw);
      if (m) { const tok = m[1]; pendingInvite = tok; lsSet(LS.invite, tok); }
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
  // "Stokke Caleiro Simensen" -> "stokke-caleiro-simensen", "Bjørn & Åse" -> "bjorn-ase".
  function slug(name) {
    return String(name || "").toLowerCase()
      .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  }
  function inviteLink(token, groupName) {
    const s = slug(groupName);
    return PAGE_URL + "?bli-med=" + encodeURIComponent(s ? s + "-" + token : token);
  }

  // ---------- state ----------
  const freshUi = () => ({
    renaming: null, confirmPerson: null, editingWish: null, confirmWish: null,
    menuOpen: false, panelOpen: false, appOpen: false, renamingGroup: false, confirmRegen: false, confirmMember: null, confirmLeave: false,
  });
  const S = {
    sb: null, url: "", key: "", token: null,
    view: "loading",          // loading | config | auth | name | create | list
    uid: null, myName: "",
    groups: [], gid: null, members: [],
    people: new Map(), wishes: new Map(), names: {},
    purchases: new Map(),     // wish id -> [{ userId, n, at }]
    myOrder: new Map(),       // person id -> my own position (personal chip order)
    locks: new Map(),         // wish id -> { by, tab, startedAt, expiresAt }
    loaded: false,
    fatal: null,
    filter: lsGet(LS.filter) || "all",
    hide: lsGet(LS.hide) === "1",
    ui: freshUi(),
    banner: initialBanner,    // {kind: "error" | "warn" | "ok", text}
    loadSlow: false, rtDown: false, offline: !navigator.onLine,
    dragging: false, orderOverride: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    menuWrap: $("menuWrap"), menuBtn: $("menuBtn"), menu: $("menu"), topTheme: $("topTheme"), lead: $("lead"),
    menuGroupSec: $("menuGroupSec"), menuGroupName: $("menuGroupName"), groupSelectWrap: $("groupSelectWrap"), menuListSec: $("menuListSec"), menuShareSec: $("menuShareSec"),
    inviteBtn: $("inviteBtn"), newGroupBtn: $("newGroupBtn"), panelClose: $("panelClose"), hiddenNote: $("hiddenNote"),
    groupSelect: $("groupSelect"), who: $("who"), signOut: $("signOut"),
    hideToggle: $("hideToggle"),
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
    inviteHint: $("inviteHint"), copyApp: $("copyApp"),
    appPanel: $("appPanel"), appClose: $("appClose"), appLink: $("appLink"), copyAppLink: $("copyAppLink"), copyAppStatus: $("copyAppStatus"),
    membersTitle: $("membersTitle"), memberList: $("memberList"), panelFoot: $("panelFoot"),
    listView: $("listView"),
    addPersonBtn: $("addPersonBtn"), addPersonForm: $("addPersonForm"), newPersonName: $("newPersonName"),
    savePerson: $("savePerson"), cancelAddPerson: $("cancelAddPerson"), addPersonErr: $("addPersonErr"),
    filters: $("filters"),
    state: $("state"),
    cards: $("cards"),
  };

  const cardEls = new Map(); // person id -> card view
  const rowEls = new Map();  // wish id -> row view

  const currentGroup = () => S.groups.find(g => g.id === S.gid) || null;
  const isOwner = () => { const g = currentGroup(); return !!g && g.ownerId === S.uid; };

  // ---------- data access ----------
  // Shared order first (the starting point for everyone), then my own order on
  // top of it. People I have not placed yet (added later) go after the rest.
  function sortedPeople() {
    const list = [...S.people.values()].sort((a, b) =>
      (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    if (S.myOrder.size) {
      const shared = new Map(list.map((p, i) => [p.id, i]));
      const key = (p) => S.myOrder.has(p.id) ? S.myOrder.get(p.id) : 1e6 + shared.get(p.id);
      list.sort((a, b) => key(a) - key(b));
    }
    if (S.orderOverride) {
      const ix = (id) => { const i = S.orderOverride.indexOf(id); return i < 0 ? 1e9 : i; };
      list.sort((a, b) => ix(a.id) - ix(b.id));
    }
    return list;
  }
  function wishesOf(pid) {
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
    const q = Math.floor(Number(r.quantity));
    return {
      id: r.id, personId: str(r.person_id, 200), title: str(r.title, 200), link: str(r.link), price: str(r.price, 60),
      note: str(r.note, 300), quantity: q >= 1 ? Math.min(q, 99) : 1, imagePath: str(r.image_path, 200),
      bought: r.bought === true, boughtBy: typeof r.bought_by === "string" ? r.bought_by : null,
      boughtAt: toMs(r.bought_at), createdAt: toMs(r.created_at) ?? 0,
    };
  }

  // ---------- quantity and purchases ----------
  // A wish's bought items are the per-person rows in wish_purchases plus one
  // item for the single "Kjøpt" checkbox (bought / bought_by). Keeping both
  // means a wish bought with the checkbox stays bought when its quantity is
  // raised, and purchases stay when the quantity is lowered.
  const qtyOf = (w) => w.quantity;
  function purchasesOf(w) {
    const m = new Map();
    for (const p of S.purchases.get(w.id) || []) m.set(p.userId, { id: p.userId, n: p.n, at: p.at });
    if (w.bought) {
      const e = w.boughtBy && m.get(w.boughtBy);
      if (e) { e.n += 1; e.at = Math.max(e.at || 0, w.boughtAt || 0); }
      else m.set(w.boughtBy || "?", { id: w.boughtBy, n: 1, at: w.boughtAt });
    }
    return [...m.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
  }
  const boughtCount = (w) => purchasesOf(w).reduce((s, x) => s + x.n, 0);
  const isDone = (w) => boughtCount(w) >= qtyOf(w);
  const myPurchaseRow = (w) => (S.purchases.get(w.id) || []).find(p => p.userId === S.uid) || null;
  function parseQty(v) { const t = String(v).trim(); if (!t) return 1; const n = Number(t); return (Number.isInteger(n) && n >= 1 && n <= 99) ? n : null; }
  const nf = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
  // "1 192 kr" when the price is a single number, otherwise "".
  function totalPrice(price, q) {
    const m = /^\s*(ca\.?\s*)?(\d{1,3}(?:[\s .]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(kr\.?|nok|,-)?\s*$/i.exec(str(price));
    if (!m || q <= 1) return "";
    const v = Number(m[2].replace(/[\s .]/g, "") + (m[3] ? "." + m[3] : ""));
    if (!isFinite(v)) return "";
    return (m[1] ? "ca. " : "") + nf.format(v * q) + " kr";
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
  const FULL_TEXT = "Alle er allerede kjøpt, så det ble ikke registrert. Listen er oppdatert.";
  function writeErrText(e, status) {
    const code = e && e.code;
    if (isNetErr(e, status)) return "Mistet kontakten, så endringen ble ikke lagret. Sjekk nettforbindelsen og prøv igjen.";
    if (isAuthErr(e, status)) return "Du er logget ut, så endringen ble ikke lagret. Last siden inn på nytt og logg inn igjen.";
    if (status === 429) return "For mange endringer på kort tid. Vent litt og prøv igjen.";
    if (code === "42501") return "Du har ikke tilgang til dette lenger, så endringen ble ikke lagret.";
    if (code === "23514" && /quantity/i.test((e && e.message) || "")) return FULL_TEXT;
    if (code === "23514" || code === "22001" || code === "23502") return "Noe av det du skrev ble ikke godtatt, så endringen ble ikke lagret. Sjekk feltene og prøv igjen.";
    if (code === "23503") return "Det du endret finnes ikke lenger. Listen er oppdatert, så prøv igjen.";
    return "Noe gikk galt, så endringen ble ikke lagret. Prøv igjen.";
  }

  // ---------- writes ----------
  function setBanner(kind, text) { S.banner = text ? { kind, text } : null; renderBanner(); }
  // fn returns a supabase-js promise ({ data, error, status }). Retries once
  // on network trouble. Errors go to errEl when given, otherwise the banner.
  async function write(fn, errEl) {
    if (!S.sb || !S.uid) { setBanner("error", "Du er ikke logget inn. Last siden inn på nytt og logg inn."); return null; }
    if (errEl) errEl.textContent = "";
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
      const text = writeErrText(e, res.status);
      if (errEl) errEl.textContent = text;
      else { S.banner = { kind: "error", text, fromWrite: true }; renderBanner(); }
      scheduleRefetch(0);
      return null;
    }
    return null;
  }

  // ---------- names, avatars, toast ----------
  function nameFor(id) {
    if (!id) return "noen";
    if (id === S.uid) return "deg";
    return S.names[id] || "noen";
  }
  function displayName(id) { if (id === S.uid) return "Du"; return S.names[id] || "Noen"; }
  // Initials from the display name: first letters of the first and last
  // word, or the first two letters of a single word. E-mail addresses are
  // never shown to other members.
  function initialsFor(id) {
    const n = str(id === S.uid ? S.myName : S.names[id]).trim();
    const parts = n.split(/\s+/).filter(Boolean).filter(p => /[\p{L}\p{N}]/u.test(p));
    const s = parts.length >= 2 ? [...parts[0]][0] + [...parts[parts.length - 1]][0] : [...(parts[0] || "?")].slice(0, 2).join("");
    return s.toUpperCase();
  }
  const AV_COLORS = [["#264b1b", "#ffffff"], ["#f7c5c5", "#12300e"], ["#88a784", "#12300e"], ["#c9352a", "#ffffff"], ["#3f7a5a", "#ffffff"], ["#a2e595", "#12300e"]];
  function avatar(id) {
    let hsh = 0; for (const ch of str(id)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    const [bg, fg] = AV_COLORS[hsh % AV_COLORS.length];
    const nm = displayName(id);
    return h("span", { class: "avatar", style: "background:" + bg + ";color:" + fg, title: nm, "aria-label": nm }, initialsFor(id));
  }
  const toastEl = h("div", { class: "toast", role: "status", "aria-live": "polite" });
  document.body.appendChild(toastEl);
  let toastT = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), 5000); }

  // ---------- banner and views ----------
  function renderBanner() {
    let msg = null;
    if (S.fatal) msg = { kind: "error", text: S.fatal };
    else if (S.banner) msg = S.banner;
    else if (S.offline) msg = { kind: "warn", text: "Du er uten nett. Det du ser kan være utdatert, og endringer lagres ikke før du er på nett igjen." };
    else if (S.view === "list" && (S.loadSlow || S.rtDown)) msg = S.loaded
      ? { kind: "warn", text: "Får ikke kontakt med listen akkurat nå. Det du ser kan være utdatert, men vi prøver fortsatt." }
      : { kind: "warn", text: "Får ikke kontakt med listen ennå. Sjekk nettet, vi prøver fortsatt." };
    const b = els.banner;
    b.replaceChildren();
    if (!msg) { b.hidden = true; return; }
    b.hidden = false;
    b.className = "banner " + (msg.kind === "error" ? "err" : "info");
    b.setAttribute("role", msg.kind === "error" ? "alert" : "status");
    b.append(h("span", { text: msg.text }));
    if (S.banner && msg === S.banner) b.append(h("button", { class: "btn", type: "button", text: "Lukk", onclick: () => setBanner(null) }));
  }
  function setView(v) { S.view = v; render(); }
  function renderViews() {
    const v = S.view;
    els.authView.hidden = v !== "auth";
    els.nameView.hidden = v !== "name";
    els.createView.hidden = v !== "create";
    els.listView.hidden = v !== "list";
    // Signed in: everything except the list lives in the menu.
    const signedIn = v === "list" || v === "create" || v === "name";
    els.menuWrap.hidden = !signedIn;
    els.topTheme.hidden = signedIn;
    els.lead.hidden = signedIn;
    document.body.classList.toggle("signed-in", signedIn);
    if (!signedIn && S.ui.menuOpen) S.ui.menuOpen = false;
    els.menu.hidden = !S.ui.menuOpen;
    els.menuBtn.setAttribute("aria-expanded", S.ui.menuOpen ? "true" : "false");
    els.groupPanel.hidden = !(v === "list" && S.ui.panelOpen);
    els.appPanel.hidden = !((v === "list" || v === "create") && S.ui.appOpen);
    els.authInvited.hidden = !pendingInvite;

    const g = v === "list" ? currentGroup() : null;
    els.menuGroupName.textContent = g ? (g.name || "Uten navn") : "";
    els.menuGroupName.hidden = !g;
    els.menuListSec.hidden = v !== "list";
    els.menuShareSec.hidden = v !== "list";
    const showSwitch = (v === "list" && S.groups.length > 1) || (v === "create" && S.groups.length > 0);
    els.groupSelectWrap.hidden = !showSwitch;
    els.newGroupBtn.hidden = v !== "list";
    els.menuGroupSec.hidden = !g && !showSwitch;
    els.who.textContent = S.myName ? "Logget inn som " + S.myName : "";
    if (showSwitch) {
      const opts = S.groups.map(g => h("option", { value: g.id, text: g.name || "Uten navn" }));
      const same = els.groupSelect.options.length === opts.length &&
        opts.every((o, i) => els.groupSelect.options[i].value === o.value && els.groupSelect.options[i].textContent === o.textContent);
      if (!same) els.groupSelect.replaceChildren(...opts);
      if (S.gid) els.groupSelect.value = S.gid;
    }
    els.createCancel.hidden = S.groups.length === 0;
    els.createIntro.textContent = S.groups.length === 0
      ? "Du er ikke med i noen gruppe ennå. Lag en gruppe for familien eller vennegjengen, og inviter de andre med en lenke. Har noen allerede laget en gruppe, kan du be om invitasjonslenken og åpne den, så blir du med."
      : "En ny gruppe får sin egen liste og sin egen invitasjonslenke, for eksempel for venner eller en annen del av familien. De du inviterer, ser ikke de andre gruppene dine. Du bytter mellom gruppene i menyen.";
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
    stopEditSession();
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
  // ---------- menu ----------
  function setMenu(open, refocus) {
    S.ui.menuOpen = open;
    render();
    if (open) ([...els.menu.querySelectorAll("select, .menu-item, input")].find(el => el.getClientRects().length) || els.signOut).focus();
    else if (refocus) els.menuBtn.focus();
  }
  els.menuBtn.addEventListener("click", () => setMenu(!S.ui.menuOpen, false));
  els.menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false, true); } });
  document.addEventListener("pointerdown", (e) => {
    if (S.ui.menuOpen && !els.menuWrap.contains(e.target)) setMenu(false, false);
  });
  document.addEventListener("focusin", (e) => {
    if (S.ui.menuOpen && !els.menuWrap.contains(e.target)) { S.ui.menuOpen = false; render(); }
  });

  function openPanel(focusEl) {
    S.ui.menuOpen = false; S.ui.appOpen = false;
    S.ui.panelOpen = true;
    els.copyStatus.textContent = "";
    render();
    focusEl.focus({ preventScroll: true });
    els.groupPanel.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  function closePanel() {
    S.ui.panelOpen = false;
    S.ui.renamingGroup = false; S.ui.confirmRegen = false; S.ui.confirmMember = null; S.ui.confirmLeave = false;
    render();
    els.menuBtn.focus();
  }
  els.inviteBtn.addEventListener("click", () => openPanel(els.copyInvite));
  els.newGroupBtn.addEventListener("click", () => {
    S.ui.menuOpen = false; S.ui.panelOpen = false;
    els.createErr.textContent = "";
    setView("create");
    els.createName.focus();
  });
  els.panelClose.addEventListener("click", closePanel);
  els.groupPanel.addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.tagName !== "INPUT") closePanel(); });

  async function copyLink(input, status, okText) {
    const link = input.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      status.textContent = okText;
    } catch {
      input.focus(); input.select();
      status.textContent = "Kunne ikke kopiere automatisk. Lenken er merket, så du kan kopiere den selv.";
    }
  }
  els.copyInvite.addEventListener("click", () => copyLink(els.inviteLink, els.copyStatus,
    "Kopiert! Send lenken bare til dem som skal være med i denne gruppen."));
  els.appLink.value = PAGE_URL;
  function closeAppPanel() { S.ui.appOpen = false; render(); els.menuBtn.focus(); }
  els.copyApp.addEventListener("click", () => {
    S.ui.menuOpen = false; S.ui.panelOpen = false; S.ui.appOpen = true;
    els.copyAppStatus.textContent = "";
    render();
    els.copyAppLink.focus({ preventScroll: true });
    els.appPanel.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  els.copyAppLink.addEventListener("click", () => copyLink(els.appLink, els.copyAppStatus,
    "Kopiert! Den som åpner lenken, lager sin egen gruppe og ser ikke listene deres."));
  els.appClose.addEventListener("click", closeAppPanel);
  els.appPanel.addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.tagName !== "INPUT") closeAppPanel(); });

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
      const ok = await write(() => S.sb.from("groups").update({ name: v }).eq("id", g.id), els.groupRenameErr);
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
    return h("div", { class: "confirm" },
      h("span", { text }),
      h("button", { class: "btn danger", type: "button", text: yesText, onclick: onYes }),
      h("button", { class: "btn", type: "button", text: "Nei", onclick: onNo }));
  }

  function renderPanel() {
    const g = currentGroup();
    if (!g || !S.ui.panelOpen) return;
    const owner = isOwner();
    const focusKey = document.activeElement && els.groupPanel.contains(document.activeElement) ? document.activeElement.dataset.key : null;

    els.groupTitle.textContent = g.name || "Uten navn";
    els.groupHeadActions.replaceChildren();
    if (owner && !S.ui.renamingGroup) {
      els.groupHeadActions.append(h("button", { class: "icon-btn", type: "button", text: "✏️", title: "Gi gruppen nytt navn", "aria-label": "Gi gruppen nytt navn", dataset: { key: "grename" }, onclick: openGroupRename }));
    }
    if (!owner) S.ui.renamingGroup = false;
    els.groupRename.hidden = !S.ui.renamingGroup;

    const link = g.token ? inviteLink(g.token, g.name) : "";
    if (els.inviteLink.value !== link) { els.inviteLink.value = link; els.copyStatus.textContent = ""; }
    els.copyInvite.textContent = "Kopier invitasjon til " + g.name;
    els.inviteHint.textContent = "Lenken legger folk til i " + g.name + ", så de kan se og endre listene. Del den bare med dem som skal være med.";

    els.regenArea.replaceChildren();
    if (owner) {
      if (S.ui.confirmRegen) {
        els.regenArea.append(confirmBox("Lage en ny lenke? Den gamle lenken slutter å virke, men alle som allerede er med, blir med videre.",
          "Ja, lag ny lenke", regenerateInvite, () => { S.ui.confirmRegen = false; render(); }));
      } else {
        els.regenArea.append(h("button", { class: "btn ghost", type: "button", text: "Lag ny lenke (den gamle slutter å virke)", dataset: { key: "regen" },
          onclick: () => { S.ui.confirmRegen = true; render(); els.regenArea.querySelector(".confirm button")?.focus(); } }));
      }
    }

    els.membersTitle.textContent = `Medlemmer (${S.members.length})`;
    if (S.ui.confirmMember && !S.members.some(m => m.id === S.ui.confirmMember)) S.ui.confirmMember = null;
    const items = S.members.map(m => {
      const tags = [];
      if (m.id === S.uid) tags.push("deg");
      if (m.id === g.ownerId) tags.push("eier");
      const li = h("li", null,
        avatar(m.id),
        h("span", { class: "mname", text: m.name || "Uten navn" }),
        tags.length ? h("span", { class: "tag", text: "(" + tags.join(", ") + ")" }) : null);
      if (owner && m.id !== S.uid) {
        if (S.ui.confirmMember === m.id) {
          li.append(confirmBox(`Fjerne ${m.name || "denne personen"} fra gruppen? Personen mister tilgang til listene, men kan bli med igjen med invitasjonslenken. Lag gjerne en ny lenke også.`,
            "Ja, fjern", () => removeMember(m.id), () => { S.ui.confirmMember = null; render(); }));
        } else {
          li.append(h("button", { class: "btn ghost mact", type: "button", text: "Fjern", dataset: { key: "rm-" + m.id }, "aria-label": `Fjern ${m.name || "medlem"} fra gruppen`,
            onclick: () => { S.ui.confirmMember = m.id; render(); els.memberList.querySelector(".confirm button")?.focus(); } }));
        }
      }
      return li;
    });
    els.memberList.replaceChildren(...items);

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
        h("button", { class: "btn", type: "button", text: "Lag ny gruppe", dataset: { key: "newgroup" },
          onclick: () => { S.ui.panelOpen = false; els.createErr.textContent = ""; setView("create"); els.createName.focus(); } }),
        h("button", { class: "btn ghost", type: "button", text: "Forlat gruppen", dataset: { key: "leave" },
          onclick: () => { S.ui.confirmLeave = true; render(); els.panelFoot.querySelector(".confirm button")?.focus(); } }));
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
    stopEditSession();
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
  function openAddPerson() {
    S.ui.menuOpen = false; render();
    els.addPersonForm.hidden = false; els.addPersonErr.textContent = ""; els.newPersonName.focus();
  }
  els.addPersonBtn.addEventListener("click", openAddPerson);
  els.cancelAddPerson.addEventListener("click", () => { els.addPersonForm.hidden = true; els.newPersonName.value = ""; els.addPersonErr.textContent = ""; });
  els.newPersonName.addEventListener("keydown", (e) => { if (e.key === "Escape") els.cancelAddPerson.click(); });
  els.addPersonForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.newPersonName.value.trim().slice(0, 60);
    if (!name) { els.addPersonErr.textContent = "Skriv inn et navn."; els.newPersonName.focus(); return; }
    els.savePerson.disabled = true;
    const maxOrder = Math.max(0, ...[...S.people.values()].map(p => p.order || 0));
    const gid = S.gid;
    const ok = await write(() => S.sb.from("people").insert({ group_id: gid, name, sort_order: maxOrder + 1 }), els.addPersonErr);
    els.savePerson.disabled = false;
    if (ok) { els.newPersonName.value = ""; els.addPersonForm.hidden = true; }
  });

  // ---------- hide toggle ----------
  els.hideToggle.addEventListener("change", () => {
    S.hide = els.hideToggle.checked; lsSet(LS.hide, S.hide ? "1" : "0");
    S.ui.confirmWish = null; render();
  });
  els.hiddenNote.addEventListener("click", () => {
    S.hide = false; lsSet(LS.hide, "0");
    S.ui.confirmWish = null; render();
  });

  // ---------- images (private Storage bucket, signed URLs) ----------
  const BUCKET = "wish-images";
  const MAX_BYTES = 5 * 1024 * 1024;
  const URL_TTL = 3600; // seconds
  const urlCache = new Map(); // path -> { url, exp, retryAt }
  const urlWanted = new Set();
  let urlTimer = null, urlBusy = false;
  // Returns a usable signed URL for an image path, or null while it is being
  // fetched. URLs are fetched in batches and refreshed 5 minutes before expiry.
  function imgUrl(path) {
    if (!path) return null;
    const now = Date.now();
    const c = urlCache.get(path);
    if (!c || now >= c.retryAt) { urlWanted.add(path); if (!urlTimer) urlTimer = setTimeout(fetchUrls, 0); }
    return c && c.url && c.exp > now ? c.url : null;
  }
  async function fetchUrls() {
    urlTimer = null;
    if (urlBusy || !S.sb || !urlWanted.size) return;
    urlBusy = true;
    const paths = [...urlWanted]; urlWanted.clear();
    const now = Date.now();
    for (const p of paths) { const c = urlCache.get(p) || { url: null, exp: 0 }; c.retryAt = now + 30000; urlCache.set(p, c); }
    let res;
    try { res = await S.sb.storage.from(BUCKET).createSignedUrls(paths, URL_TTL); } catch (e) { res = { error: e }; }
    urlBusy = false;
    if (!res.error && Array.isArray(res.data)) {
      const t = Date.now();
      for (const d of res.data) {
        if (d && d.path && d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: t + URL_TTL * 1000, retryAt: t + (URL_TTL - 300) * 1000 });
      }
    }
    if (urlWanted.size) urlTimer = setTimeout(fetchUrls, 0);
    render();
  }
  // Scales to at most 1600 px on the longest side and encodes as JPEG.
  async function prepImage(file) {
    let src = null, url = null;
    try {
      try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch {
        url = URL.createObjectURL(file);
        src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      }
      const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
      const sc = Math.min(1, 1600 / Math.max(w0, h0));
      const cw = Math.max(1, Math.round(w0 * sc)), ch = Math.max(1, Math.round(h0 * sc));
      const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
      const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cw, ch); cx.drawImage(src, 0, 0, cw, ch);
      const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.85));
      if (!blob) throw new Error("encode");
      return blob;
    } catch { throw { code: "unsupported_type" }; }
    finally { if (src && src.close) src.close(); if (url) URL.revokeObjectURL(url); }
  }
  function assetErr(e) {
    const code = e && (e.code || e.statusCode || e.status);
    if (code === "too_large" || String(code) === "413") return "Bildet er for stort (maks 5 MB).";
    if (code === "unsupported_type" || String(code) === "415") return "Bildet kunne ikke leses. Bruk JPG, PNG eller WebP.";
    if (String(code) === "403" || String(code) === "401" || /row-level security|unauthorized/i.test((e && e.message) || "")) return "Du har ikke tilgang til å laste opp bilder i denne gruppen.";
    if (String(code) === "429") return "For mange opplastinger på kort tid. Vent litt og prøv igjen.";
    return "Fikk ikke lastet opp bildet. Sjekk nettet og prøv igjen.";
  }
  async function uploadImage(file, gid) {
    const blob = await prepImage(file);
    if (blob.size > MAX_BYTES) throw { code: "too_large" };
    const path = gid + "/" + uuid() + ".jpg";
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try { res = await S.sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", cacheControl: "3600", upsert: false }); }
      catch (e) { res = { error: e }; }
      if (!res.error) return path;
      if (attempt === 0 && isNetErr(res.error, res.error.status)) { await sleep(800); continue; }
      throw res.error;
    }
  }
  async function dropImages(paths) {
    const list = paths.filter(Boolean);
    if (!list.length || !S.sb) return;
    try { await S.sb.storage.from(BUCKET).remove(list); } catch {}
    for (const p of list) urlCache.delete(p);
  }
  function field(label, control) { return h("label", { class: "field" }, h("span", { class: "lbl", text: label }), control); }
  function imagePicker(initialPath) {
    let file = null, removed = false, objUrl = null;
    const input = h("input", { type: "file", accept: "image/*", class: "sr", tabindex: "-1", "aria-hidden": "true" });
    const prev = h("img", { class: "pick-prev", alt: "" });
    const pick = h("button", { class: "btn", type: "button", onclick: () => input.click() });
    const rm = h("button", { class: "btn ghost", type: "button", onclick: () => { file = null; removed = true; paint(); } }, "Fjern bilde");
    function paint() {
      if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
      let src = null;
      if (file) { objUrl = URL.createObjectURL(file); src = objUrl; }
      else if (!removed && initialPath) src = imgUrl(initialPath);
      const has = !!file || (!removed && !!initialPath);
      prev.hidden = !src; if (src) prev.src = src; else prev.removeAttribute("src");
      pick.textContent = has ? "Bytt bilde" : "📷 Velg bilde";
      rm.hidden = !has;
    }
    input.addEventListener("change", () => { const f = input.files && input.files[0]; input.value = ""; if (f) { file = f; removed = false; paint(); } });
    paint();
    return {
      el: h("div", { class: "field" }, h("span", { class: "lbl", text: "Bilde (valgfritt)" }), h("span", { class: "hint", text: "Dersom lenken ikke virker, legg inn et bilde av ønsket." }), h("div", { class: "pick" }, prev, pick, rm, input)),
      state: () => ({ file, removed }),
      reset: () => { file = null; removed = false; initialPath = null; paint(); },
    };
  }
  // lightbox
  const lbImg = h("img", { alt: "" }), lbCap = h("div", { class: "cap" });
  const lbClose = h("button", { class: "x", type: "button", "aria-label": "Lukk bildet" }, "×");
  const lb = h("div", { class: "lightbox", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Bilde" }, lbClose, lbImg, lbCap);
  document.body.appendChild(lb);
  let lbReturn = null;
  function openLightbox(src, caption) {
    lbReturn = document.activeElement; lbImg.src = src; lbImg.alt = caption || ""; lbCap.textContent = caption || "";
    lb.hidden = false; lbClose.focus();
  }
  function closeLightbox() { if (lb.hidden) return; lb.hidden = true; lbImg.removeAttribute("src"); if (lbReturn && lbReturn.focus) lbReturn.focus(); }
  lb.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeLightbox(); });

  // ---------- buying ----------
  async function setBought(w, on) {
    if (on) return write(() => S.sb.from("wishes").update({ bought: true }).eq("id", w.id));
    // Unticking: clear the checkbox purchase and your own counted purchase.
    // Other members' counted purchases can only be undone by themselves.
    const mine = myPurchaseRow(w);
    const others = (S.purchases.get(w.id) || []).filter(p => p.userId !== S.uid);
    if (!w.bought && !mine) {
      const who = others.map(p => S.names[p.userId] || "noen").join(" og ");
      toast(`Kjøpt av ${who}. Bare den som har kjøpt, kan angre kjøpet.`);
      return null;
    }
    let ok = true;
    if (w.bought) ok = !!(await write(() => S.sb.from("wishes").update({ bought: false }).eq("id", w.id)));
    if (ok && mine) ok = !!(await write(() => S.sb.from("wish_purchases").delete().eq("wish_id", w.id).eq("user_id", S.uid)));
    return ok;
  }
  // +1 or -1 on "Jeg har kjøpt". The server refuses going above the quantity.
  async function stepMine(w, d) {
    const row = myPurchaseRow(w);
    if (d > 0) {
      return row
        ? write(() => S.sb.from("wish_purchases").update({ n: row.n + 1 }).eq("wish_id", w.id).eq("user_id", S.uid))
        : write(() => S.sb.from("wish_purchases").insert({ wish_id: w.id, group_id: S.gid, n: 1 }));
    }
    if (row && row.n > 1) return write(() => S.sb.from("wish_purchases").update({ n: row.n - 1 }).eq("wish_id", w.id).eq("user_id", S.uid));
    if (row) return write(() => S.sb.from("wish_purchases").delete().eq("wish_id", w.id).eq("user_id", S.uid));
    if (w.bought && w.boughtBy === S.uid) return write(() => S.sb.from("wishes").update({ bought: false }).eq("id", w.id));
    return null;
  }

  // ---------- edit locks: one editor per wish ----------
  // The lock lives in wish_locks and is only written through RPCs. It is
  // taken when the editor opens, renewed on activity (at most every 20 s),
  // and released on save, cancel, click outside and when the tab closes.
  // After 7 minutes without activity the editor saves and closes itself.
  const LOCK_IDLE_MS = 7 * 60 * 1000;
  const TAB = (() => { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); })();
  let editSess = null;
  function lockOf(wid) { const l = S.locks.get(wid); return l && typeof l.expiresAt === "number" && l.expiresAt > Date.now() ? l : null; }
  function lockedByOther(wid) { const l = lockOf(wid); if (!l || !l.by || l.by === S.uid) return null; return l; }
  const lockedMsg = (by) => displayName(by) + " redigerer dette ønsket nå. Prøv igjen litt senere.";
  function requestEdit(w) {
    const other = lockedByOther(w.id);
    if (other) { toast(lockedMsg(other.by)); return; }
    stopEditSession();
    const sess = { wid: w.id, lastActivity: Date.now(), lastPush: Date.now(), ok: false };
    editSess = sess;
    sess.timer = setInterval(() => tickEdit(sess), 1000);
    S.ui.editingWish = w.id; S.ui.confirmWish = null; render();
    claimLock(sess);
  }
  async function lockRpc(name, wid) {
    try { return await S.sb.rpc(name, { wid, tab: TAB }); } catch (e) { return { error: e, status: 0 }; }
  }
  async function claimLock(sess) {
    if (!S.uid || !S.sb) return;
    const res = await lockRpc("acquire_wish_lock", sess.wid);
    if (editSess !== sess) { if (res.data && res.data.ok) lockRpc("release_wish_lock", sess.wid); return; }
    if (res.error || !res.data) return; // locking unavailable: editing still works
    if (!res.data.ok) return lostLock(sess, res.data.locked_by);
    sess.ok = true;
  }
  function lostLock(sess, by) {
    if (editSess !== sess) return;
    stopEditSession(true);
    const r = rowEls.get(sess.wid); if (r) r.sig = null;
    S.ui.editingWish = null; render();
    toast((by && by !== S.uid ? displayName(by) : "Noen andre") + " begynte å redigere ønsket samtidig. Prøv igjen litt senere.");
  }
  function stopEditSession(skipRelease) {
    const sess = editSess; if (!sess) return;
    editSess = null; clearInterval(sess.timer);
    if (sess.ok && !skipRelease) lockRpc("release_wish_lock", sess.wid).then(() => scheduleRefetch(0));
  }
  function markActive() { if (editSess) editSess.lastActivity = Date.now(); }
  function tickEdit(sess) {
    if (editSess !== sess) return;
    const left = LOCK_IDLE_MS - (Date.now() - sess.lastActivity);
    if (sess.tickEl) {
      if (left < 60000) {
        const sec = Math.max(0, Math.ceil(left / 1000));
        sess.tickEl.textContent = "Lukkes om 0:" + String(sec).padStart(2, "0") + " uten aktivitet, endringene lagres";
        sess.headEl.classList.add("warn");
      } else {
        sess.tickEl.textContent = "Du redigerer · lukkes etter 7 min uten aktivitet";
        sess.headEl.classList.remove("warn");
      }
    }
    if (left <= 0) { if (sess.save) sess.save(true); else { stopEditSession(); S.ui.editingWish = null; render(); } return; }
    if (sess.ok && !sess.pushing && sess.lastActivity - sess.lastPush > 20000) {
      sess.pushing = true; sess.lastPush = sess.lastActivity;
      lockRpc("renew_wish_lock", sess.wid).then(res => {
        sess.pushing = false;
        if (res.data && res.data.ok === false) lostLock(sess, res.data.locked_by);
      });
    }
  }
  // Click outside the wish being edited = save and close. A click on another
  // wish (or a card name) only closes this one; it takes a second click.
  let swallowClick = false;
  document.addEventListener("pointerdown", e => {
    if (!S.ui.editingWish || !editSess || !editSess.save) return;
    const r = rowEls.get(S.ui.editingWish);
    if (!r || r.el.contains(e.target)) return;
    if (e.target.closest(".lightbox,.toast")) return;
    if (e.target.closest(".wish .body, .wish .icon-btn, .card-head h2")) swallowClick = true;
    editSess.save();
  }, true);
  document.addEventListener("click", e => {
    if (!swallowClick) return;
    swallowClick = false; e.stopPropagation(); e.preventDefault();
  }, true);
  // Release the lock when the tab closes. supabase-js calls may not finish
  // during unload, so this is a plain fetch with keepalive to the RPC
  // endpoint, sent with the publishable key and the user's access token.
  window.addEventListener("pagehide", () => {
    if (!editSess || !editSess.ok || !S.token) return;
    try {
      fetch(S.url.replace(/\/+$/, "") + "/rest/v1/rpc/release_wish_lock", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", apikey: S.key, Authorization: "Bearer " + S.token },
        body: JSON.stringify({ wid: editSess.wid, tab: TAB }),
      }).catch(() => {});
    } catch {}
  });

  // ---------- rendering ----------
  function render() {
    renderViews();
    renderBanner();
    if (S.fatal) { els.state.hidden = false; els.state.textContent = "Listen kan ikke vises her."; return; }
    if (S.view === "loading") { els.state.hidden = false; els.state.textContent = "Henter listen …"; return; }
    if (S.view !== "list") { els.state.hidden = true; return; }

    els.hideToggle.checked = S.hide;
    els.hiddenNote.hidden = !S.hide;
    renderPanel();
    if (!S.loaded) { els.state.hidden = false; els.state.textContent = "Henter listen …"; els.filters.hidden = true; els.addPersonBtn.disabled = true; return; }
    els.addPersonBtn.disabled = false;
    els.filters.hidden = false;
    const people = sortedPeople();
    if (S.filter !== "all" && !S.people.has(S.filter)) S.filter = "all";
    renderFilters(people);
    renderCards(people);
    scheduleLockExpiry();
  }

  // Re-render the moment someone else's lock runs out.
  let lockTimer = null;
  function scheduleLockExpiry() {
    clearTimeout(lockTimer);
    const now = Date.now();
    let next = Infinity;
    for (const l of S.locks.values()) if (l.expiresAt > now && l.expiresAt < next) next = l.expiresAt;
    if (next < Infinity) lockTimer = setTimeout(render, Math.min(next - now + 50, 2 ** 31 - 1));
  }

  function renderFilters(people) {
    const box = els.filters;
    if (S.dragging) return;
    if (!drag) clearGhosts();
    const items = [{ id: "all", label: "Alle", n: [...S.wishes.values()].filter(w => S.people.has(w.personId)).length }]
      .concat(people.map(p => ({ id: p.id, label: p.name || "Uten navn", n: wishesOf(p.id).length })));
    const sig = JSON.stringify([S.filter, items]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    // The add chip comes first so it stays visible when the row scrolls on phones.
    const addChip = h("button", { type: "button", class: "chip add-chip", onclick: openAddPerson }, "+ Legg til person");
    box.replaceChildren(addChip, ...items.map(it => h("button", {
      type: "button", class: "chip", "aria-pressed": String(S.filter === it.id),
      "data-pid": it.id === "all" ? null : it.id,
      title: it.id === "all" ? null : "Hold inne og dra for å endre rekkefølgen",
      onclick: () => { if (suppressClick) return; S.filter = it.id; lsSet(LS.filter, it.id); render(); },
      onkeydown: it.id === "all" ? null : (e) => {
        // Keyboard alternative to dragging: Alt + arrow left/right.
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        const ids = people.map(p => p.id), i = ids.indexOf(it.id), j = i + (e.key === "ArrowLeft" ? -1 : 1);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        saveOrder(ids).then(() => box.querySelector(`[data-pid="${CSS.escape(it.id)}"]`)?.focus());
      },
    }, it.label, h("span", { class: "n", text: String(it.n) }))));
  }

  function makeCard(pid) {
    const c = { pid, head: h("div", { class: "card-head" }), summary: h("div", { class: "summary" }), list: h("ul", { class: "list" }), empty: h("div", { class: "empty" }), headSig: null, headMode: null };
    const title = h("input", { type: "text", placeholder: "F.eks. Lego-sett", maxlength: "200", autocomplete: "off" });
    const link = h("input", { type: "text", inputmode: "url", placeholder: "https://…", maxlength: "1000", autocomplete: "off" });
    const price = h("input", { type: "text", placeholder: "F.eks. 599 kr", maxlength: "60", autocomplete: "off" });
    const qty = h("input", { type: "number", min: "1", max: "99", step: "1", value: "1", inputmode: "numeric" });
    const priceField = field("Pris (valgfri)", price);
    qty.addEventListener("input", () => { priceField.firstChild.textContent = (parseQty(qty.value) || 1) > 1 ? "Pris per stk. (valgfri)" : "Pris (valgfri)"; });
    const pic = imagePicker(null);
    const err = h("div", { class: "ferr", role: "alert" });
    const btn = h("button", { class: "btn primary", type: "submit" }, "Lagre");
    const openBtn = h("button", { class: "btn add-open", type: "button" }, "+ Nytt ønske");
    const bar = h("div", { class: "addbar" }, openBtn);
    const cancelBtn = h("button", { class: "btn", type: "button", onclick: () => { closeForm(); openBtn.focus(); } }, "Avbryt");
    const form = h("form", { class: "addform", novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const t = title.value.trim().slice(0, 200);
      if (!t) { err.textContent = "Skriv inn hva ønsket er."; title.focus(); return; }
      const l = normalizeLink(link.value);
      if (!l.ok) { err.textContent = l.msg; link.focus(); return; }
      const q = parseQty(qty.value);
      if (q == null) { err.textContent = "Antall må være et helt tall fra 1 til 99."; qty.focus(); return; }
      err.textContent = "";
      btn.disabled = true;
      const gid = S.gid;
      let image = "";
      const st = pic.state();
      if (st.file) {
        btn.textContent = "Laster opp bilde …";
        try { image = await uploadImage(st.file, gid); }
        catch (e) { err.textContent = assetErr(e); btn.disabled = false; btn.textContent = "Lagre"; return; }
      }
      const ok = await write(() => S.sb.from("wishes").insert({
        group_id: gid, person_id: pid, title: t, link: l.value, price: price.value.trim().slice(0, 60), note: "", quantity: q, image_path: image,
      }), err);
      btn.disabled = false; btn.textContent = "Lagre";
      if (ok) { closeForm(); openBtn.focus(); }
      else if (image) dropImages([image]);
    } }, field("Ønske", title), field("Lenke (valgfri)", link), h("div", { class: "qp" }, field("Antall", qty), priceField), pic.el, h("div", { class: "go" }, btn, cancelBtn), err);
    form.hidden = true;
    function closeForm() { title.value = ""; link.value = ""; price.value = ""; qty.value = "1"; priceField.firstChild.textContent = "Pris (valgfri)"; err.textContent = ""; pic.reset(); form.hidden = true; bar.hidden = false; }
    openBtn.addEventListener("click", () => { bar.hidden = true; form.hidden = false; title.focus(); });
    form.addEventListener("keydown", e => { if (e.key === "Escape") { closeForm(); openBtn.focus(); } });
    c.form = form; c.bar = bar;
    c.root = h("section", { class: "card" }, c.head, c.summary, c.list, c.empty, bar, form);
    return c;
  }

  function renderHead(c, p, wishes) {
    const name = p.name || "Uten navn";
    const mode = S.ui.renaming === p.id ? "rename" : S.ui.confirmPerson === p.id ? "confirm" : "view";
    if (mode === "rename" && c.headMode === "rename") return; // keep the input untouched
    const sig = JSON.stringify([mode, name, wishes.length]);
    if (c.headSig === sig) return;
    c.headSig = sig; c.headMode = mode;
    const nodes = [];
    if (mode === "rename") {
      const inp = h("input", { type: "text", value: name, maxlength: "60", "aria-label": "Nytt navn" });
      const err = h("div", { class: "ferr", role: "alert" });
      const save = async () => {
        const v = inp.value.trim().slice(0, 60);
        if (!v) { err.textContent = "Navnet kan ikke være tomt."; return; }
        if (v === name) { S.ui.renaming = null; c.headSig = null; render(); return; }
        const ok = await write(() => S.sb.from("people").update({ name: v }).eq("id", p.id), err);
        if (ok) { S.ui.renaming = null; c.headSig = null; render(); }
      };
      const cancel = () => { S.ui.renaming = null; c.headSig = null; render(); };
      inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); save(); } else if (e.key === "Escape") { cancel(); } });
      nodes.push(h("div", { class: "rename" }, inp, h("button", { class: "btn primary", type: "button", onclick: save }, "Lagre"), h("button", { class: "btn", type: "button", onclick: cancel }, "Avbryt")), err);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      const startRename = () => { S.ui.renaming = p.id; S.ui.confirmPerson = null; c.headSig = null; render(); };
      nodes.push(h("h2", { text: name, class: "clickable", title: "Klikk for å gi nytt navn", onclick: startRename }));
      nodes.push(h("div", { class: "actions" },
        h("button", { class: "icon-btn", type: "button", title: "Gi nytt navn", "aria-label": "Gi nytt navn til " + name, onclick: startRename }, "✏️"),
        h("button", { class: "icon-btn", type: "button", title: "Slett kortet", "aria-label": "Slett kortet til " + name, onclick: () => { S.ui.confirmPerson = p.id; S.ui.renaming = null; c.headSig = null; render(); c.head.querySelector(".confirm .btn")?.focus(); } }, "🗑")));
      if (mode === "confirm") {
        const err = h("div", { class: "ferr", role: "alert" });
        const n = wishes.length;
        nodes.push(h("div", { class: "confirm" },
          h("span", { text: "Slette kortet til " + name + (n ? " og " + (n === 1 ? "det ene ønsket" : "alle " + n + " ønskene") : "") + "?" }),
          h("button", { class: "btn danger", type: "button", onclick: async (e) => { e.target.disabled = true; const ok = await deletePerson(p.id, err); if (!ok) e.target.disabled = false; } }, "Ja, slett"),
          h("button", { class: "btn", type: "button", onclick: () => { S.ui.confirmPerson = null; c.headSig = null; render(); } }, "Nei")
        ), err);
      }
    }
    c.head.replaceChildren(...nodes);
  }
  async function deletePerson(pid, errEl) {
    // Images first (the database cannot delete Storage objects), then the
    // person; the database deletes the wishes, purchases and locks with it.
    if (editSess && S.wishes.get(editSess.wid)?.personId === pid) { stopEditSession(); S.ui.editingWish = null; }
    await dropImages(wishesOf(pid).map(w => w.imagePath));
    const ok = await write(() => S.sb.from("people").delete().eq("id", pid), errEl);
    if (!ok) return false;
    S.ui.confirmPerson = null;
    S.people.delete(pid);
    for (const [id, w] of S.wishes) if (w.personId === pid) S.wishes.delete(id);
    if (S.filter === pid) { S.filter = "all"; lsSet(LS.filter, "all"); }
    render();
    return true;
  }

  function renderRow(w) {
    const mode = S.ui.editingWish === w.id ? "edit" : "view";
    let r = rowEls.get(w.id);
    if (r && mode === "edit" && r.mode === "edit") return r.el; // keep edit inputs while typing
    const href = safeHref(w.link);
    const q = qtyOf(w), multi = q > 1;
    const purch = purchasesOf(w), got = purch.reduce((s, x) => s + x.n, 0);
    const bought = got >= q;
    const mine = (purch.find(x => x.id === S.uid) || {}).n || 0;
    let label = "";
    if (!S.hide && purch.length) {
      const last = purch.reduce((a, x) => (x.at || 0) > (a.at || 0) ? x : a, purch[0]);
      if (!multi) label = "Kjøpt av " + nameFor(last.id) + (last.at ? ", " + when(last.at) : "");
      else label = "Kjøpt av " + purch.map(x => nameFor(x.id) + " (" + x.n + ")").join(", ") + (last.at ? ", sist " + when(last.at) : "");
    }
    const img = w.imagePath ? imgUrl(w.imagePath) : null;
    const lockBy = mode === "view" ? (lockedByOther(w.id) || {}).by || null : null;
    const sig = JSON.stringify([mode, lockBy, lockBy ? displayName(lockBy) + initialsFor(lockBy) : "", S.ui.confirmWish === w.id, w.title, href, w.price, w.note, w.imagePath, img, q, got, mine, bought, label, S.hide]);
    if (r && r.sig === sig) return r.el;
    if (!r) { r = { el: h("li", { class: "wish" }) }; rowEls.set(w.id, r); }
    r.sig = sig; r.mode = mode;
    const el = r.el;
    el.className = "wish" + (bought && !S.hide ? " bought" : "") + (lockBy ? " locked" : "");
    const title = w.title || "Uten tittel";

    if (mode === "edit") { renderEdit(r, w); return el; }

    let lead;
    if (multi) {
      lead = h("div", { class: "count" + (S.hide ? " locked" : bought ? " done" : ""), title: S.hide ? "Skjult" : got + " av " + q + " kjøpt", "aria-label": S.hide ? "Antall: " + q : got + " av " + q + " kjøpt" }, S.hide ? "" : got + "/" + q);
    }
    const cb = h("input", { type: "checkbox", "aria-label": "Kjøpt: " + title });
    cb.checked = bought && !S.hide;
    cb.disabled = S.hide;
    if (S.hide) cb.title = "Låst mens kjøpt-informasjon er skjult";
    cb.addEventListener("change", async () => {
      const want = cb.checked;
      cb.disabled = true;
      const ok = await setBought(w, want);
      if (!ok) { cb.checked = !want; r.sig = null; }
      cb.disabled = S.hide;
    });

    const meta = [];
    if (w.price) {
      const tot = totalPrice(w.price, q);
      meta.push(h("span", { class: "price", text: multi ? w.price + " per stk." + (tot ? " · " + tot + " totalt" : "") : w.price }));
    }
    if (href) meta.push(h("a", { href, target: "_blank", rel: "noopener noreferrer" }, "Se hos " + siteName(href) + " ↗"));

    const body = h("div", { class: "body" },
      h("div", { class: "title" }, title, multi ? h("span", { class: "qtychip", text: "× " + q }) : null,
        (!href && !w.imagePath) ? h("span", { class: "moreinfo", text: " (mer info kommer)" }) : null),
      meta.length ? h("div", { class: "meta" }, ...meta) : null,
      w.note ? h("div", { class: "note", text: w.note }) : null,
      label ? h("div", { class: "boughtby", text: label }) : null
    );
    if (multi && !S.hide) {
      const left = Math.max(0, q - got);
      const step = async (d, btn) => { btn.disabled = true; const ok = await stepMine(w, d); if (!ok) { btn.disabled = false; r.sig = null; } };
      const minus = h("button", { type: "button", "aria-label": "Ett færre kjøpt av meg", disabled: mine <= 0 }, "−");
      const plus = h("button", { type: "button", "aria-label": "Ett til kjøpt av meg", disabled: left <= 0 }, "+");
      minus.addEventListener("click", () => step(-1, minus));
      plus.addEventListener("click", () => step(1, plus));
      body.appendChild(h("div", { class: "stepper" },
        h("span", { text: "Jeg har kjøpt" }),
        h("span", { class: "ctl" }, minus, h("output", { text: String(mine) }), plus),
        h("span", { class: "left", text: left ? left + " igjen" : "Alle er kjøpt 🎉" })));
    }
    if (lockBy) body.insertBefore(h("div", { class: "editing" }, avatar(lockBy), h("span", { class: "dots", text: displayName(lockBy) + " redigerer" })), body.firstChild);
    body.classList.add("clickable");
    body.title = lockBy ? displayName(lockBy) + " redigerer dette ønsket" : "Klikk for å redigere";
    body.addEventListener("click", e => {
      if (e.target.closest("a,button,input,select,.confirm")) return;
      const sel = window.getSelection && String(window.getSelection());
      if (sel) return;
      requestEdit(w);
    });
    const thumb = w.imagePath ? h("button", { class: "thumb", type: "button", "aria-label": "Vis bilde av " + title, onclick: () => { if (img) openLightbox(img, title); } },
      img ? h("img", { src: img, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: e => { const b = e.target.closest(".thumb"); if (b) b.hidden = true; } }) : null) : null;
    if (S.ui.confirmWish === w.id) {
      const err = h("div", { class: "ferr", role: "alert" });
      body.appendChild(h("div", { class: "confirm" },
        h("span", { text: "Slette «" + title + "»?" }),
        h("button", { class: "btn danger", type: "button", onclick: async (e) => {
          const o = lockedByOther(w.id); if (o) { toast(lockedMsg(o.by)); return; }
          e.target.disabled = true;
          await dropImages([w.imagePath]);
          const ok = await write(() => S.sb.from("wishes").delete().eq("id", w.id), err);
          if (ok) { S.ui.confirmWish = null; S.wishes.delete(w.id); render(); } else e.target.disabled = false;
        } }, "Ja"),
        h("button", { class: "btn", type: "button", onclick: () => { S.ui.confirmWish = null; r.sig = null; render(); } }, "Nei")
      ));
      body.appendChild(err);
    }
    const tools = h("div", { class: "tools" },
      h("button", { class: "icon-btn", type: "button", title: lockBy ? displayName(lockBy) + " redigerer" : "Rediger", "aria-label": "Rediger " + title, "aria-disabled": lockBy ? "true" : null, onclick: () => requestEdit(w) }, "✏️"),
      h("button", { class: "icon-btn", type: "button", title: lockBy ? displayName(lockBy) + " redigerer" : "Slett", "aria-label": "Slett " + title, "aria-disabled": lockBy ? "true" : null, onclick: () => {
        const o = lockedByOther(w.id); if (o) { toast(lockedMsg(o.by)); return; }
        S.ui.confirmWish = w.id; render(); r.el.querySelector(".confirm .btn")?.focus();
      } }, "🗑"));
    el.replaceChildren(...[multi ? h("div", { class: "chk" }, lead) : h("label", { class: "chk" }, cb), thumb, body, tools].filter(Boolean));
    return el;
  }

  function renderEdit(r, w) {
    const el = r.el, q = qtyOf(w);
    const t = h("input", { type: "text", value: w.title, maxlength: "200" });
    const l = h("input", { type: "text", inputmode: "url", value: w.link, placeholder: "https://…", maxlength: "1000" });
    const pr = h("input", { type: "text", value: w.price, placeholder: "F.eks. 599 kr", maxlength: "60" });
    const qn = h("input", { type: "number", min: "1", max: "99", step: "1", value: String(q), inputmode: "numeric" });
    const prField = field(q > 1 ? "Pris per stk. (valgfri)" : "Pris (valgfri)", pr);
    qn.addEventListener("input", () => { prField.firstChild.textContent = (parseQty(qn.value) || 1) > 1 ? "Pris per stk. (valgfri)" : "Pris (valgfri)"; });
    const who = h("select", {},
      ...sortedPeople().map(p => { const o = h("option", { value: p.id, text: p.name || "Uten navn" }); if (p.id === w.personId) o.selected = true; return o; }));
    const pic = imagePicker(w.imagePath);
    const saveBtn = h("button", { class: "btn primary", type: "submit" }, "Lagre");
    const err = h("div", { class: "ferr", role: "alert" });
    const close = () => {
      if (editSess && editSess.wid === w.id) stopEditSession();
      if (S.ui.editingWish === w.id) S.ui.editingWish = null;
      r.sig = null; render();
    };
    const cancel = close;
    const IDLE = "Redigeringen ble lukket etter 7 minutter uten aktivitet.";
    let saving = false;
    const save = async (auto) => {
      if (saving) return;
      saving = true;
      try { await doSave(auto); } finally { saving = false; }
    };
    const doSave = async (auto) => {
      auto = auto === true;
      const cur = S.wishes.get(w.id) || w; // latest copy, in case it changed meanwhile
      const bail = msg => { if (auto) { close(); toast(IDLE + " " + msg); return true; } return false; };
      const tv = t.value.trim().slice(0, 200);
      if (!tv) { if (bail("Endringene ble ikke lagret fordi ønsket manglet navn.")) return; err.textContent = "Ønsket må ha et navn."; t.focus(); return; }
      const lv = normalizeLink(l.value);
      if (!lv.ok) { if (bail("Endringene ble ikke lagret fordi lenken var ugyldig.")) return; err.textContent = lv.msg; l.focus(); return; }
      const nq = parseQty(qn.value);
      if (nq == null) { if (bail("Endringene ble ikke lagret fordi antallet var ugyldig.")) return; err.textContent = "Antall må være et helt tall fra 1 til 99."; qn.focus(); return; }
      const patch = {};
      if (tv !== w.title) patch.title = tv;
      if (lv.value !== w.link) patch.link = lv.value;
      const pv = pr.value.trim().slice(0, 60);
      if (pv !== w.price) patch.price = pv;
      if (nq !== q) patch.quantity = nq;
      if (who.value && who.value !== cur.personId && S.people.has(who.value)) patch.person_id = who.value;
      const st = pic.state();
      let newImg = null;
      if (st.file) {
        saveBtn.disabled = true; saveBtn.textContent = "Laster opp …";
        try { newImg = await uploadImage(st.file, S.gid); }
        catch (e) { if (bail("Bildet kunne ikke lastes opp.")) return; err.textContent = assetErr(e); saveBtn.disabled = false; saveBtn.textContent = "Lagre"; return; }
        patch.image_path = newImg;
      } else if (st.removed && cur.imagePath) patch.image_path = "";
      if (!Object.keys(patch).length) { close(); if (auto) toast(IDLE); return; }
      const oldImg = cur.imagePath;
      saveBtn.disabled = true;
      const ok = await write(() => S.sb.from("wishes").update(patch).eq("id", w.id), err);
      saveBtn.disabled = false; saveBtn.textContent = "Lagre";
      if (ok) {
        if ("image_path" in patch && oldImg) dropImages([oldImg]);
        if (newImg) urlCache.delete(newImg);
        close(); if (auto) toast(IDLE + " Endringene dine er lagret.");
      } else { if (newImg) dropImages([newImg]); if (auto) { close(); toast(IDLE + " Endringene kunne ikke lagres."); } }
    };
    [t, l, qn, pr, who].forEach(inp => inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); save(); } else if (e.key === "Escape") { cancel(); }
    }));
    const tickEl = h("span", { text: "Du redigerer · lukkes etter 7 min uten aktivitet" });
    const headEl = h("div", { class: "edithead" }, avatar(S.uid), tickEl);
    if (editSess && editSess.wid === w.id) { editSess.save = save; editSess.tickEl = tickEl; editSess.headEl = headEl; }
    const form = h("form", { class: "edit", novalidate: true, onsubmit: e => { e.preventDefault(); save(); } },
      headEl, field("Ønske", t), field("Lenke (valgfri)", l), h("div", { class: "qp" }, field("Antall", qn), prField), pic.el, field("Ønske til", who),
      h("div", { class: "btns" }, saveBtn, h("button", { class: "btn", type: "button", onclick: cancel }, "Avbryt")), err);
    ["input", "keydown", "pointerdown", "change", "focusin"].forEach(ev => form.addEventListener(ev, markActive));
    el.replaceChildren(form);
    setTimeout(() => t.focus(), 0);
  }

  function renderCards(people) {
    if (S.ui.editingWish && !S.wishes.has(S.ui.editingWish)) { stopEditSession(); S.ui.editingWish = null; }
    if (people.length === 0) {
      els.state.hidden = false;
      els.state.textContent = "Ingen personer på listen ennå. Trykk «Legg til person» for å begynne.";
    } else els.state.hidden = true;

    const nodes = [];
    for (const p of people) {
      let c = cardEls.get(p.id);
      if (!c) { c = makeCard(p.id); cardEls.set(p.id, c); }
      const ws = wishesOf(p.id);
      const name = p.name || "Uten navn";
      renderHead(c, p, ws);
      const n = ws.length, b = ws.filter(isDone).length;
      if (S.hide) c.summary.textContent = n === 1 ? "1 ønske" : n + " ønsker";
      else c.summary.replaceChildren(h("b", { text: b + " av " + n }), " kjøpt");
      placeChildren(c.list, ws.map(w => renderRow(w)));
      c.list.hidden = !n;
      c.empty.hidden = !!n;
      c.empty.textContent = "Ingen ønsker for " + name + " ennå. Trykk «Nytt ønske» for å legge til det første.";
      if (c.form.hidden) c.bar.hidden = false;
      c.root.hidden = S.filter !== "all" && S.filter !== p.id;
      nodes.push(c.root);
    }
    placeChildren(els.cards, nodes);
    for (const [pid] of cardEls) if (!S.people.has(pid)) cardEls.delete(pid);
    for (const [wid] of rowEls) if (!S.wishes.has(wid)) rowEls.delete(wid);
  }

  // ---------- theme ----------
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function currentTheme() { return document.documentElement.dataset.theme || (mq && mq.matches ? "dark" : "light"); }
  function paintTheme() { const t = currentTheme(); document.querySelectorAll(".theme button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === t))); }
  document.querySelectorAll(".theme button").forEach(b => b.addEventListener("click", () => {
    document.documentElement.dataset.theme = b.dataset.t; lsSet(LS.theme, b.dataset.t); paintTheme();
  }));
  if (mq && mq.addEventListener) mq.addEventListener("change", paintTheme);
  paintTheme();

  // ---------- drag chips to reorder cards ----------
  // Mouse: press and drag. Touch: hold about 0.4 s, then drag. The floating
  // copy is removed on every way a gesture can end, including phones that
  // never send pointerup after a long press.
  let drag = null, suppressClick = false;
  function clearGhosts() { document.querySelectorAll(".chip.ghost").forEach(g => g.remove()); document.body.classList.remove("chip-dragging"); }
  function moveGhost(x, y) { drag.ghost.style.transform = "translate3d(" + (x - drag.offX) + "px," + (y - drag.offY) + "px,0) scale(1.06)"; }

  // Moves chips with a short slide instead of a jump: remember where every chip
  // was, change the DOM, then animate each chip from its old spot to its new one.
  function flip(mutate) {
    const chips = [...els.filters.querySelectorAll(".chip")];
    const before = new Map(chips.map(c => [c, c.getBoundingClientRect()]));
    mutate();
    const moved = [];
    for (const c of chips) {
      const a = before.get(c), b = c.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      c.style.transition = "none";
      c.style.transform = "translate(" + dx + "px," + dy + "px)";
      moved.push(c);
    }
    if (!moved.length) return;
    void els.filters.offsetWidth; // apply the start position before animating
    for (const c of moved) {
      c.style.transition = "transform .18s cubic-bezier(.2,.7,.3,1)";
      c.style.transform = "";
      c.addEventListener("transitionend", () => { c.style.transition = ""; }, { once: true });
    }
  }

  // Where the dragged chip belongs for a pointer at (x, y). Uses layout
  // positions (offsetLeft/Top), which ignore the slide animations, and leaves
  // the dragged chip out, so the answer does not flip back and forth.
  function dropTarget(x, y) {
    const box = els.filters, br = box.getBoundingClientRect();
    const others = [...box.querySelectorAll(".chip[data-pid]")].filter(c => c !== drag.chip);
    if (!others.length) return null;
    const px = x - br.left + box.scrollLeft, py = y - br.top + box.scrollTop;
    // Pick the row under the pointer (or the nearest one).
    let rowTop = null, best = Infinity;
    for (const c of others) {
      const mid = c.offsetTop + c.offsetHeight / 2, d = Math.abs(py - mid);
      if (d < best - 1) { best = d; rowTop = c.offsetTop; }
    }
    const row = others.filter(c => Math.abs(c.offsetTop - rowTop) < 4);
    const before = row.find(c => px < c.offsetLeft + c.offsetWidth / 2);
    return { ref: before || row[row.length - 1].nextSibling };
  }
  function placeAt(x, y) {
    const t = dropTarget(x, y);
    if (!t || t.ref === drag.chip || t.ref === drag.chip.nextSibling) return;
    flip(() => els.filters.insertBefore(drag.chip, t.ref));
  }

  // While dragging near the ends of a sideways-scrolling row, keep scrolling
  // even when the finger holds still.
  function autoScroll() {
    if (!drag || !drag.active) return;
    const box = els.filters, r = box.getBoundingClientRect(), edge = 36;
    let v = 0;
    if (drag.x < r.left + edge) v = -Math.ceil((r.left + edge - drag.x) / 6);
    else if (drag.x > r.right - edge) v = Math.ceil((drag.x - (r.right - edge)) / 6);
    if (v && box.scrollWidth > box.clientWidth) {
      const prev = box.scrollLeft;
      box.scrollLeft += v;
      if (box.scrollLeft !== prev) placeAt(drag.x, drag.y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function startDrag(x, y) {
    if (!drag || drag.active) return;
    drag.active = true; S.dragging = true;
    const r = drag.chip.getBoundingClientRect();
    drag.offX = x - r.left; drag.offY = y - r.top; drag.x = x; drag.y = y;
    clearGhosts();
    const g = drag.chip.cloneNode(true); g.classList.add("ghost"); g.removeAttribute("data-pid"); g.style.width = r.width + "px";
    g.setAttribute("aria-hidden", "true");
    document.body.appendChild(g); drag.ghost = g; moveGhost(x, y);
    drag.chip.classList.add("dragging"); document.body.classList.add("chip-dragging");
    // Capture on the row, not the chip: the chip moves around in the DOM while
    // dragging, and moving a captured element makes the browser drop the
    // capture, which used to end the drag after one step.
    try { els.filters.setPointerCapture(drag.pointerId); } catch {}
    try { if (navigator.vibrate) navigator.vibrate(15); } catch {}
    drag.raf = requestAnimationFrame(autoScroll);
  }
  els.filters.addEventListener("pointerdown", e => {
    if (drag) endDrag(drag.active);
    clearGhosts();
    const chip = e.target.closest(".chip[data-pid]");
    if (!chip || !S.sb || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { id: chip.dataset.pid, chip, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== "mouse" };
    if (drag.touch) { const x = e.clientX, y = e.clientY; drag.timer = setTimeout(() => startDrag(drag ? drag.x : x, drag ? drag.y : y), 350); }
  });
  els.filters.addEventListener("contextmenu", e => { if (e.target.closest(".chip[data-pid]")) e.preventDefault(); });
  document.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    const dist = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
    if (!drag.active) {
      if (drag.touch) { if (dist > 10) { clearTimeout(drag.timer); drag = null; } return; }
      if (dist < 6) return;
      startDrag(e.clientX, e.clientY);
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    placeAt(e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener("touchmove", e => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
  function endDrag(commit) {
    if (!drag) return;
    clearTimeout(drag.timer);
    cancelAnimationFrame(drag.raf);
    const d = drag; drag = null;
    if (!d.active) return;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 80);
    document.body.classList.remove("chip-dragging");
    S.dragging = false;
    const ids = [...els.filters.querySelectorAll(".chip[data-pid]")].map(c => c.dataset.pid);
    // Let the floating copy glide into the chip's new spot, then remove it.
    const g = d.ghost, r = d.chip.getBoundingClientRect();
    const finish = () => {
      if (g) g.remove();
      d.chip.classList.remove("dragging");
      els.filters.dataset.sig = "";
      if (commit) saveOrder(ids); else render();
    };
    if (g && commit && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      g.style.transition = "transform .15s ease-out";
      g.style.transform = "translate3d(" + r.left + "px," + r.top + "px,0) scale(1)";
      setTimeout(finish, 150);
    } else finish();
  }
  document.addEventListener("pointerup", e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
  document.addEventListener("pointercancel", e => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
  document.addEventListener("touchend", e => { if (drag && !e.touches.length) endDrag(drag.active); });
  document.addEventListener("touchcancel", () => { if (drag) endDrag(false); });
  els.filters.addEventListener("lostpointercapture", e => { if (e.target === els.filters && drag && drag.active && e.pointerId === drag.pointerId) setTimeout(() => { if (drag && drag.active) endDrag(true); }, 0); });
  window.addEventListener("blur", () => { if (drag) endDrag(false); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && drag) endDrag(false); });
  // Saves my personal order (1..n). Others keep their own order.
  async function saveOrder(ids) {
    ids = ids.filter(id => S.people.has(id));
    const current = sortedPeople().map(p => p.id);
    if (ids.length === current.length && ids.every((id, i) => id === current[i]) &&
        ids.every((id, i) => S.myOrder.get(id) === i + 1)) { render(); return; }
    const gid = S.gid;
    S.orderOverride = ids;
    ids.forEach((id, i) => S.myOrder.set(id, i + 1));
    render();
    const rows = ids.map((id, i) => ({ person_id: id, group_id: gid, position: i + 1 }));
    const ok = await write(() => S.sb.from("person_order").upsert(rows, { onConflict: "user_id,person_id" }));
    S.orderOverride = null;
    if (!ok) scheduleRefetch(0);
    render();
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
        sb.from("wishes").select("id,person_id,title,link,price,note,quantity,image_path,bought,bought_by,bought_at,created_at").eq("group_id", gid),
        sb.from("wish_purchases").select("wish_id,user_id,n,at").eq("group_id", gid),
        sb.from("wish_locks").select("wish_id,locked_by,tab,started_at,expires_at").eq("group_id", gid),
        sb.from("person_order").select("person_id,position").eq("group_id", gid).eq("user_id", S.uid),
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
    const [g, m, p, w, pu, lk, po] = res;
    S.loadSlow = false;
    const oldName = currentGroup()?.name || "gruppen";
    S.groups = g.data.map(readGroup);
    if (!S.groups.some(x => x.id === gid)) {
      // Removed from the group (or it was deleted) while we were looking at it.
      stopEditSession(true);
      S.banner = { kind: "error", text: `Du er ikke lenger med i «${oldName}».` };
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
    S.myOrder.clear();
    for (const r of po.data) { const n = Math.floor(Number(r.position)); if (n >= 1 && S.people.has(r.person_id)) S.myOrder.set(r.person_id, n); }
    S.wishes.clear();
    for (const r of w.data) S.wishes.set(r.id, readWish(r));
    S.purchases.clear();
    for (const r of pu.data) {
      const n = Math.floor(Number(r.n));
      if (!(n >= 1)) continue;
      if (!S.purchases.has(r.wish_id)) S.purchases.set(r.wish_id, []);
      S.purchases.get(r.wish_id).push({ userId: r.user_id, n, at: toMs(r.at) });
    }
    S.locks.clear();
    for (const r of lk.data) S.locks.set(r.wish_id, { by: r.locked_by, tab: str(r.tab, 64), startedAt: toMs(r.started_at), expiresAt: toMs(r.expires_at) ?? 0 });
    // Someone else holds the lock for what I am editing (my lock expired).
    if (editSess && editSess.ok) { const l = lockedByOther(editSess.wid); if (l) lostLock(editSess, l.by); }
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
    for (const table of ["people", "wishes", "group_members", "wish_purchases", "wish_locks", "person_order"]) {
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
    if (changed) stopEditSession();
    S.gid = gid || null;
    if (S.gid) lsSet(LS.group, S.gid);
    if (changed) {
      const panelOpen = S.ui.panelOpen, appOpen = S.ui.appOpen;
      S.ui = freshUi();
      S.ui.panelOpen = panelOpen; S.ui.appOpen = appOpen;
      S.people.clear(); S.myOrder.clear(); S.wishes.clear(); S.purchases.clear(); S.locks.clear(); S.members = []; S.names = {}; S.loaded = false;
      cardEls.clear(); rowEls.clear(); els.cards.replaceChildren(); els.filters.dataset.sig = "";
      els.addPersonForm.hidden = true; els.newPersonName.value = ""; els.addPersonErr.textContent = "";
      els.copyStatus.textContent = "";
      resubscribe();
    }
    render();
    if (S.gid) scheduleRefetch(0);
  }

  // ---------- session lifecycle ----------
  function resetSession() {
    fetchGen++;
    stopEditSession(true);
    clearTimeout(refetchTimer); clearTimeout(retryTimer);
    if (channel) { const old = channel; channel = null; S.sb.removeChannel(old); }
    S.uid = null; S.myName = ""; S.groups = []; S.gid = null; S.members = [];
    S.people.clear(); S.myOrder.clear(); S.wishes.clear(); S.purchases.clear(); S.locks.clear(); S.names = {}; S.loaded = false;
    S.ui = freshUi(); S.loadSlow = false; S.rtDown = false; S.fatal = null;
    cardEls.clear(); rowEls.clear(); els.cards.replaceChildren(); els.filters.dataset.sig = "";
    urlCache.clear();
    if (S.banner && S.banner.kind !== "error") S.banner = null;
  }

  async function handleSession(session) {
    const user = session && session.user;
    const uid = user ? user.id : null;
    S.token = session && session.access_token || null;
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
  // Refresh relative times ("i dag"/"i går") and signed image URLs once a minute.
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
    S.url = url; S.key = key;
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
