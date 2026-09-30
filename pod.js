// Pod rundown: read-only summary of every submitted review. Never writes to the database.
(() => {
  const CFG = window.RF_CONFIG || {};
  const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const GRADES = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
  const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", M: "Gold", C: "Colorless" };
  const WUBRG = ["W", "U", "B", "R", "G"];
  const PAIRS = [
    ["W", "U", "Azorius"], ["U", "B", "Dimir"], ["B", "R", "Rakdos"], ["R", "G", "Gruul"], ["G", "W", "Selesnya"],
    ["W", "B", "Orzhov"], ["U", "R", "Izzet"], ["B", "G", "Golgari"], ["R", "W", "Boros"], ["G", "U", "Simic"],
  ];
  const RARITY_RANK = { mythic: 3, rare: 2, uncommon: 1, common: 0 };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const letter = (v) => (v == null ? "–" : GRADES[Math.max(0, Math.min(12, Math.round(v)))]);
  const gradeColor = (v) => `hsl(${Math.round((v / 12) * 130)}, 55%, 42%)`;
  const chip = (v) => `<span class="grade" style="background:${gradeColor(v)}">${letter(v)}</span>`;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sd = (a) => { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : null; };
  const pips = (keys) => `<span class="pips">${keys.map((k) => `<span class="sw" style="background:var(--${k})"></span>`).join("")}</span>`;
  const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2);
  const sgn = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1);
  const list = (xs) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} & ${xs.at(-1)}`;

  let cards = [], byId = {}, players = [];

  // ---------- Data ----------
  async function loadCards() {
    const cacheKey = `rf_cards_an_v1_${CFG.SET_CODE}`; // shared with the analysis page
    try { const c = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (c && Date.now() - c.t < 12 * 3600e3) return c.cards; } catch {}
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`set:${CFG.SET_CODE} cn<=${CFG.MAIN_SET_SIZE} -t:basic`)}&unique=prints&order=set`;
    const out = [];
    while (url) {
      const d = await (await fetch(url)).json();
      if (d.object === "error") throw new Error(d.details);
      for (const c of d.data) {
        const faces = c.card_faces || [c], f0 = faces[0], imgs = c.image_uris || f0.image_uris;
        const cols = c.colors ?? [...new Set(faces.flatMap((f) => f.colors || []))];
        const typeLine = f0.type_line || c.type_line || "";
        const types = ["Creature", "Instant", "Sorcery", "Enchantment", "Artifact", "Planeswalker", "Battle", "Land"].filter((t) => typeLine.includes(t));
        const num = (x) => (x != null && /^\d+$/.test(x) ? +x : null);
        out.push({ id: c.id, name: c.name, cn: parseInt(c.collector_number, 10), rarity: c.rarity, cmc: c.cmc ?? 0,
          colors: cols, color: cols.length === 0 ? "C" : cols.length > 1 ? "M" : cols[0], types, type: types[0] || "Other",
          keywords: c.keywords || [], power: num(f0.power), toughness: num(f0.toughness), img: imgs.normal, small: imgs.small });
      }
      url = d.has_more ? d.next_page : null;
      if (url) await new Promise((r) => setTimeout(r, 100));
    }
    out.sort((a, b) => a.cn - b.cn);
    try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), cards: out })); } catch {}
    return out;
  }
  async function loadPlayers() {
    if (!REMOTE) {
      let all = {}; try { all = JSON.parse(localStorage.getItem("rf_reviews") || "{}"); } catch {}
      return Object.values(all).filter((r) => r.submitted);
    }
    const k = CFG.SUPABASE_ANON_KEY;
    const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/reviews?submitted=eq.true&select=*`, {
      headers: { apikey: k, ...(k.startsWith("eyJ") ? { Authorization: `Bearer ${k}` } : {}) },
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  // ---------- Per-player stats ----------
  const avgOf = (grades, xs) => mean(xs.filter((c) => grades[c.id] != null).map((c) => grades[c.id]));
  function deckStrength(grades, a, b) {
    const top = cards.filter((c) => grades[c.id] != null && c.colors.every((x) => x === a || x === b))
      .map((c) => grades[c.id]).sort((x, y) => y - x).slice(0, 23);
    return mean(top);
  }
  function profile(p) {
    const g = p.grades || {};
    const vals = cards.map((c) => g[c.id]).filter((v) => v != null);
    const avg = mean(vals);
    const colorAvg = {};
    for (const k of Object.keys(COLOR_NAMES)) colorAvg[k] = avgOf(g, cards.filter((c) => c.color === k));
    const pairs = PAIRS.map(([a, b, name]) => ({ a, b, name, v: deckStrength(g, a, b) })).filter((x) => x.v != null).sort((x, y) => y.v - x.v);
    const byR = (r) => avgOf(g, cards.filter((c) => c.rarity === r));
    const rareAvg = mean([byR("rare"), byR("mythic")].filter((x) => x != null));
    const mono = WUBRG.map((k) => ({ k, v: colorAvg[k] })).filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    return {
      name: p.display, g, n: vals.length, avg, sd: sd(vals), colorAvg, pairs, mono,
      big: avgOf(g, cards.filter((c) => c.cmc >= 5)), cheap: avgOf(g, cards.filter((c) => c.cmc <= 2)),
      common: byR("common"), rareAvg, notes: Object.keys(p.notes || {}).length,
    };
  }
  // How much a player favors a card's colors (used to break favorite-card ties)
  function colorLove(pr, c) {
    if (c.color === "M") return mean(c.colors.map((k) => pr.colorAvg[k]).filter((v) => v != null)) ?? -1;
    return pr.colorAvg[c.color] ?? -1;
  }

  // ---------- Tooltip & zoom (same behavior as the analysis page) ----------
  const tip = $("tip");
  function showTip(el, x, y) {
    tip.innerHTML = el.getAttribute("data-tip"); tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x + 14))}px`;
    tip.style.top = `${y + h + 20 > innerHeight ? y - h - 12 : y + 16}px`;
  }
  document.addEventListener("mouseover", (e) => { const t = e.target.closest("[data-tip]"); if (t) showTip(t, e.clientX, e.clientY); });
  document.addEventListener("mousemove", (e) => { const t = e.target.closest("[data-tip]"); if (t && !tip.hidden) showTip(t, e.clientX, e.clientY); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) tip.hidden = true; });
  document.addEventListener("focusin", (e) => { const t = e.target.closest("[data-tip]"); if (t) { const r = t.getBoundingClientRect(); showTip(t, r.left, r.bottom - 10); } });
  document.addEventListener("focusout", () => { tip.hidden = true; });
  document.addEventListener("click", (e) => {
    const z = e.target.closest("[data-zoom]");
    if (z) { const c = byId[z.dataset.zoom]; $("zoomImg").src = c.img; $("zoomImg").alt = c.name; $("zoomCap").textContent = c.name; $("zoom").showModal(); return; }
    if (e.target === $("zoom")) $("zoom").close();
    const t = e.target.closest("[data-tip]");
    if (t && matchMedia("(hover: none)").matches) showTip(t, e.clientX, e.clientY); else if (!t) tip.hidden = true;
  });

  // ---------- Awards ----------
  // Picks the player(s) with the highest (or lowest) value; values within 0.005 count as a tie.
  function pick(prs, fn, dir = "max") {
    const scored = prs.map((p) => ({ p, v: fn(p) })).filter((x) => x.v != null && !Number.isNaN(x.v))
      .sort((a, b) => (dir === "max" ? b.v - a.v : a.v - b.v));
    if (!scored.length) return null;
    const best = scored[0].v;
    const winners = scored.filter((x) => Math.abs(x.v - best) < 0.005);
    const runner = scored.find((x) => Math.abs(x.v - best) >= 0.005) || null;
    return { winners, runner, all: scored };
  }
  const medal = `<svg class="medal" viewBox="0 0 32 32" aria-hidden="true"><path d="M10 2h5l3 8h-5z" fill="#6c3bd6"/><path d="M22 2h-5l-3 8h5z" fill="#b3389a"/>
    <circle cx="16" cy="20" r="9" fill="#e8c776" stroke="#8a6a2a" stroke-width="1.5"/><path d="M16 14.5l1.7 3.4 3.8.5-2.7 2.6.6 3.7-3.4-1.8-3.4 1.8.6-3.7-2.7-2.6 3.8-.5z" fill="#8a6a2a"/></svg>`;

  function buildAwards(prs) {
    const out = [];
    const names = (res) => list(res.winners.map((w) => esc(w.p.name)));
    const ru = (res, fmt) => (res.runner ? `<br><span class="m">Runner-up: ${esc(res.runner.p.name)} (${fmt(res.runner.v, res.runner.p)})</span>` : "");
    const add = (title, blurb, res, stat, why, extra = "") => {
      if (!res) return;
      out.push({ title, blurb, winner: names(res), stat, why, extra });
    };

    let r = pick(prs, (p) => p.big != null ? p.big - p.avg : null);
    if (r) { const w = r.winners[0]; add("Biggest Timmy", "Loves the big, splashy stuff", r,
      `5+ mana: ${sgn(w.v)} steps vs their average`,
      `Graded cards costing 5 or more mana at ${f1(w.p.big)} on average, ${sgn(w.v)} steps above their own overall average (${f1(w.p.avg)}). Nobody else boosted big spells more.` + ru(r, (v) => `${sgn(v)} steps`)); }

    r = pick(prs, (p) => p.cheap != null ? p.cheap - p.avg : null);
    if (r) { const w = r.winners[0]; add("Tempo Goblin", "Cheap spells, fast clocks", r,
      `1–2 mana: ${sgn(w.v)} steps vs their average`,
      `Graded cards costing 2 or less at ${f1(w.p.cheap)} on average, ${sgn(w.v)} steps relative to their overall average (${f1(w.p.avg)}). The pod's biggest fan of the low end.` + ru(r, (v) => `${sgn(v)} steps`)); }

    r = pick(prs, (p) => p.avg);
    if (r) { const w = r.winners[0]; add("Most Optimistic", "Sees a playable in every pack", r,
      `Average grade ${letter(w.v)} (${f2(w.v)})`,
      `Highest average grade in the pod: ${f2(w.v)} (${letter(w.v)}) across ${w.p.n} cards. Pod average is ${f2(mean(prs.map((p) => p.avg)))}.` + ru(r, (v) => f2(v))); }

    r = pick(prs, (p) => p.avg, "min");
    if (r) { const w = r.winners[0]; add("Doomer Award", "This format is unplayable", r,
      `Average grade ${letter(w.v)} (${f2(w.v)})`,
      `Lowest average grade in the pod: ${f2(w.v)} (${letter(w.v)}) across ${w.p.n} cards. Pod average is ${f2(mean(prs.map((p) => p.avg)))}.` + ru(r, (v) => f2(v))); }

    r = pick(prs, (p) => p.rareAvg != null && p.common != null ? p.rareAvg - p.common : null);
    if (r) { const w = r.winners[0]; add("Bomb Chaser", "Opens pack, looks for the foil", r,
      `Rares ${sgn(w.v)} steps over commons`,
      `Biggest gap between rares/mythics (${f1(w.p.rareAvg)}) and commons (${f1(w.p.common)}): ${sgn(w.v)} steps. Values the rare slot above all else.` + ru(r, (v) => `${sgn(v)} steps`)); }

    r = pick(prs, (p) => p.rareAvg != null && p.common != null ? p.rareAvg - p.common : null, "min");
    if (r) { const w = r.winners[0]; add("Commons Connoisseur", "Wins with the boring stuff", r,
      `Rares only ${sgn(w.v)} steps over commons`,
      `Smallest gap between rares/mythics (${f1(w.p.rareAvg)}) and commons (${f1(w.p.common)}): only ${sgn(w.v)} steps. Rates the common slot closer to the rares than anyone else.` + ru(r, (v) => `${sgn(v)} steps`)); }

    // Distance from everyone else, card by card
    const podDist = (p) => {
      const ds = cards.map((c) => {
        const mine = p.g[c.id]; if (mine == null) return null;
        const others = prs.filter((o) => o !== p).map((o) => o.g[c.id]).filter((v) => v != null);
        return others.length ? Math.abs(mine - mean(others)) : null;
      }).filter((v) => v != null);
      return mean(ds);
    };
    if (prs.length >= 3) {
      r = pick(prs, podDist, "min");
      if (r) add("Hive Mind", "Basically the pod average", r, `${f2(r.winners[0].v)} steps from the pod`,
        `On average, their grade was ${f2(r.winners[0].v)} steps from everyone else's average on each card, the closest of anyone. Consensus in human form.` + ru(r, (v) => `${f2(v)} steps`));
      r = pick(prs, podDist);
      if (r) add("Lone Wolf", "Marches to their own drum", r, `${f2(r.winners[0].v)} steps from the pod`,
        `On average, their grade was ${f2(r.winners[0].v)} steps from everyone else's average on each card, the furthest of anyone.` + ru(r, (v) => `${f2(v)} steps`));
    }

    r = pick(prs, (p) => p.sd, "min");
    if (r) add("Fence Sitter", "Everything is a C+", r, `Spread σ ${f2(r.winners[0].v)}`,
      `Narrowest spread of grades in the pod (standard deviation ${f2(r.winners[0].v)} grade steps). Their grades hug the middle.` + ru(r, (v) => f2(v)));
    r = pick(prs, (p) => p.sd);
    if (r) add("Chaos Agent", "It's an A+ or it's an F", r, `Spread σ ${f2(r.winners[0].v)}`,
      `Widest spread of grades in the pod (standard deviation ${f2(r.winners[0].v)} grade steps). Strong opinions, both directions.` + ru(r, (v) => f2(v)));

    r = pick(prs, (p) => p.mono.length >= 2 ? p.mono[0].v - p.mono.at(-1).v : null);
    if (r) { const w = r.winners[0].p; add("Color Snob", "Has a favorite and it shows", r,
      `${COLOR_NAMES[w.mono[0].k]} ${f1(w.mono[0].v)} vs ${COLOR_NAMES[w.mono.at(-1).k]} ${f1(w.mono.at(-1).v)}`,
      `Biggest gap between their best color (${COLOR_NAMES[w.mono[0].k]}, ${f1(w.mono[0].v)}) and worst (${COLOR_NAMES[w.mono.at(-1).k]}, ${f1(w.mono.at(-1).v)}): ${f1(r.winners[0].v)} steps.` + ru(r, (v) => `${f1(v)} steps`)); }

    // Hottest take: the single biggest disagreement between one player and everyone else
    let hot = null;
    for (const p of prs) for (const c of cards) {
      const mine = p.g[c.id]; if (mine == null) continue;
      const others = prs.filter((o) => o !== p).map((o) => o.g[c.id]).filter((v) => v != null);
      if (!others.length) continue;
      const d = mine - mean(others);
      if (!hot || Math.abs(d) > Math.abs(hot.d) + 1e-9) hot = { p, c, d, mine, others: mean(others) };
    }
    if (hot) out.push({ title: "Hottest Take", blurb: "The single spiciest grade", winner: esc(hot.p.name),
      stat: `${esc(hot.c.name)}: ${letter(hot.mine)} vs pod ${letter(hot.others)}`,
      why: `Graded <b>${esc(hot.c.name)}</b> ${letter(hot.mine)} while everyone else averaged ${letter(hot.others)} (${f1(hot.others)}): ${sgn(hot.d)} steps, the biggest single-card disagreement in the pod.`,
      extra: `<div class="card-mini"><img src="${hot.c.small}" alt="" data-zoom="${hot.c.id}">${chip(hot.mine)}</div>` });

    r = pick(prs, (p) => p.notes);
    if (r && r.winners[0].v > 0) add("Lore Keeper", "Wrote the most notes", r, `${r.winners[0].v} notes`,
      `Left ${r.winners[0].v} notes explaining their grades, more than anyone else.` + ru(r, (v) => `${v} notes`));
    return out;
  }

  // ---------- Render ----------
  function render(prs) {
    const podAvg = mean(prs.map((p) => p.avg));
    // Pod-wide favorite pair: count each player's top pair
    const counts = {};
    prs.forEach((p) => { if (p.pairs[0]) counts[p.pairs[0].name] = (counts[p.pairs[0].name] || 0) + 1; });
    const popular = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topCount = popular[0]?.[1] || 0;
    const popNames = popular.filter(([, n]) => n === topCount).map(([n]) => n);

    $("podSub").textContent = `${prs.length} players · ${cards.length} cards · every review submitted`;
    $("podLede").innerHTML = `Pod average grade <b>${letter(podAvg)}</b> (${podAvg.toFixed(2)}). `
      + (popNames.length ? `Most popular deck: <b>${list(popNames)}</b>${topCount > 1 ? ` (${topCount} players)` : ""}.` : "");

    // Awards
    $("awards").innerHTML = buildAwards(prs).map((a) =>
      `<article class="award" tabindex="0" data-tip="${esc(`<b>${a.title}</b><br>${a.why}`)}">
        <span class="why" aria-hidden="true">?</span>${medal}
        <h3>${a.title}</h3><p class="blurb">${a.blurb}</p>
        <div class="winner">${a.winner}</div><div class="stat">${a.stat}</div>${a.extra}</article>`).join("");

    // Color pairs
    $("pairSummary").innerHTML = popular.length
      ? `<p class="pair-sum">${popular.map(([n, c]) => `<b>${n}</b> ×${c}`).join(" · ")}</p>` : "";
    $("pairs").innerHTML = prs.map((p) => {
      const [top, second] = p.pairs;
      if (!top) return "";
      const tipTxt = `<b>${esc(p.name)}</b><br>Best deck: ${top.name}, ${letter(top.v)} (${f2(top.v)})`
        + (second ? `<br>Runner-up: ${second.name}, ${letter(second.v)} (${f2(second.v)})` : "")
        + `<br><span class="m">Average of their best 23 cards castable in ${top.a}${top.b}</span>`;
      return `<div class="pair" data-tip="${esc(tipTxt)}"><div class="who">${esc(p.name)}</div>
        <div class="guild">${pips([top.a, top.b])}${top.name}</div>
        <div class="strip" style="background:linear-gradient(90deg,var(--${top.a}),var(--${top.b}))"></div>
        <div class="ds">Deck strength ${letter(top.v)} · ${f2(top.v)}</div></div>`;
    }).join("");

    // Favorite cards
    $("favs").innerHTML = prs.map((p) => {
      const graded = cards.filter((c) => p.g[c.id] != null);
      if (!graded.length) return "";
      const max = Math.max(...graded.map((c) => p.g[c.id]));
      const tied = graded.filter((c) => p.g[c.id] === max);
      const ranked = [...tied].sort((a, b) => colorLove(p, b) - colorLove(p, a) || RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || a.cn - b.cn);
      const fav = ranked[0];
      // Explain each tiebreak stage that actually narrowed the field
      let why;
      if (tied.length === 1) why = `Their only ${letter(max)}.`;
      else {
        const colorName = (c) => c.color === "M" ? c.colors.map((k) => COLOR_NAMES[k]).join("-") : COLOR_NAMES[c.color];
        const steps = [];
        const bestLove = colorLove(p, fav);
        let pool = tied.filter((c) => Math.abs(colorLove(p, c) - bestLove) < 1e-9);
        if (pool.length < tied.length) steps.push(`${colorName(fav)} is their highest-rated color among the tied cards (avg ${f1(bestLove)})`);
        if (pool.length > 1) {
          const rarPool = pool.filter((c) => c.rarity === fav.rarity);
          if (rarPool.length < pool.length) steps.push(`${steps.length ? "then " : ""}highest rarity (${fav.rarity})`);
          if (rarPool.length > 1) steps.push(`${steps.length ? "then " : ""}lowest card number (#${fav.cn})`);
        }
        why = `Tied with ${tied.length - 1} other ${letter(max)} card${tied.length > 2 ? "s" : ""}. Won on: ${steps.join(", ")}.`
          + `<br><span class="m">Also ${letter(max)}: ${ranked.slice(1, 6).map((c) => esc(c.name)).join(", ")}${tied.length > 6 ? ", …" : ""}</span>`;
      }
      return `<div class="fav" data-tip="${esc(`<b>${esc(p.name)}: ${esc(fav.name)}</b><br>${why}`)}">
        <img src="${fav.img}" alt="${esc(fav.name)}" loading="lazy" data-zoom="${fav.id}">
        <div class="who"><span>${esc(p.name)}</span>${chip(max)}</div>
        <div class="nm">${esc(fav.name)}</div>${tied.length > 1 ? `<div class="tie">1 of ${tied.length} at ${letter(max)}</div>` : ""}</div>`;
    }).join("");
  }

  // ---------- Boot ----------
  (async () => {
    let passOk = false;
    try { passOk = !CFG.PASSCODE_SHA256 || localStorage.getItem("rf_pass_ok") === CFG.PASSCODE_SHA256; } catch {}
    if (!passOk) { $("status").innerHTML = `Enter the passcode on the <a href="./">front page</a> first, then come back here.`; return; }
    try {
      cards = await loadCards(); cards.forEach((c) => (byId[c.id] = c));
      players = (await loadPlayers()).filter((p) => Object.keys(p.grades || {}).length);
    } catch (e) { console.error(e); $("status").textContent = `Couldn't load the pod (${e.message}). Refresh to try again.`; return; }
    if (players.length < 2) { $("status").textContent = "The rundown needs at least two submitted reviews."; return; }
    const prs = players.map(profile).sort((a, b) => a.name.localeCompare(b.name));
    $("status").hidden = true; $("report").hidden = false;
    render(prs);
  })();
})();
