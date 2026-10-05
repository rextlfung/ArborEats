const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAME = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

// "Today" and "now" are Ann Arbor's, wherever the visitor is.
function annArborNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Detroit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.weekday.toLowerCase().slice(0, 3), time: `${parts.hour}:${parts.minute}` };
}

const state = { day: annArborNow().day, category: "all", owner: "all", cap: null, period: null, now: false, query: "", selected: null };

// Times of day as [start, end) in hours; "late" runs past midnight.
const PERIODS = { lunch: [11, 15], afternoon: [15, 18], evening: [18, 22], late: [22, 26] };

// The dollar amount you pay, or null for discounts ("$2 off", "25% off",
// "half off") and deals with no price, which a price cap cannot judge.
function dollarPrice(deal) {
  if (!deal.price || /off|%|half|bogo/i.test(deal.price)) return null;
  const m = deal.price.match(/\$\s?(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// Whether a deal runs during a time of day. No stated hours means all day;
// only a start means "until close", only an end means "from opening".
function runsDuring(deal, [from, to]) {
  if (!deal.start_time && !deal.end_time) return true;
  const hours = (t) => Number(t.slice(0, 2)) + Number(t.slice(3)) / 60;
  const start = deal.start_time ? hours(deal.start_time) : 6;
  let end = deal.end_time ? hours(deal.end_time) : 26;
  if (end <= start) end += 24; // past midnight
  // Compare on a clock that runs 06:00 to 30:00, so "1 AM" counts as late night.
  const overlaps = (s, e) => s < to && e > from;
  return overlaps(start, end) || overlaps(start + 24, end + 24) || overlaps(start - 24, end - 24);
}
let data = { restaurants: [] };
let map;
let popup;

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
}

function formatDays(days) {
  if (!days.length) return "Any day";
  if (days.length === 7) return "Every day";
  const idx = days.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b);
  const consecutive = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (consecutive && idx.length > 2) return `${DAY_LABEL[DAYS[idx[0]]]}–${DAY_LABEL[DAYS[idx.at(-1)]]}`;
  return idx.map((i) => DAY_LABEL[DAYS[i]]).join(", ");
}

function formatWhen(d) {
  let when = formatDays(d.days);
  if (d.start_time && d.end_time) when += `, ${formatTime(d.start_time)}–${formatTime(d.end_time)}`;
  else if (d.start_time) when += `, from ${formatTime(d.start_time)}`;
  else if (d.end_time) when += `, until ${formatTime(d.end_time)}`;
  return when;
}

function daysAgo(iso) {
  const n = Math.floor((Date.now() - Date.parse(iso)) / 86400e3);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

function matches(deal, restaurant) {
  // A deal with no stated days is shown on every day rather than hidden.
  if (state.day !== "all" && deal.days.length && !deal.days.includes(state.day)) return false;
  if (state.category !== "all" && deal.category !== state.category && deal.category !== "both") return false;
  if (state.cap !== null) {
    const price = dollarPrice(deal);
    if (price === null || price > state.cap) return false;
  }
  if (state.period && !runsDuring(deal, PERIODS[state.period])) return false;
  if (state.now) {
    const { day, time } = annArborNow();
    if (deal.days.length && !deal.days.includes(day)) return false;
    if (deal.start_time && time < deal.start_time) return false;
    if (deal.end_time && time > deal.end_time) return false;
  }
  if (state.query) {
    const haystack = `${restaurant.name} ${restaurant.cuisine.join(" ")} ${deal.title} ${deal.description}`.toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  return true;
}

function visible() {
  return data.restaurants
    .filter((r) => state.owner === "all" || (state.owner === "chain") === r.chain)
    .map((r) => ({ ...r, deals: r.deals.filter((d) => matches(d, r)) }))
    .filter((r) => r.deals.length);
}

function dealHtml(d) {
  // Rule-extracted deals often have the page's own line as both title and description.
  const sameText = d.description.startsWith(d.title.replace(/…$/, ""));
  const title = sameText ? d.description : d.title;
  const detail = [formatWhen(d), sameText ? null : d.description, d.conditions].filter(Boolean).join(" · ");
  return `<div class="deal">
    <span class="price${d.price ? "" : " none"}">${escapeHtml(d.price ?? "Deal")}</span>
    <span class="deal-text">
      <span class="deal-title">${escapeHtml(title)}</span>
      <span class="when">${escapeHtml(detail)}</span>
    </span>
  </div>`;
}

function restaurantHtml(r) {
  const meta = [r.address, r.cuisine.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  // One "checked" line per card: the oldest check among its deals, linking to the first source.
  const oldest = r.deals.reduce((a, d) => (d.verified_at < a ? d.verified_at : a), r.deals[0].verified_at);
  const fromImage = r.deals.some((d) => d.from_image) ? " · some read from images" : "";
  return `<div class="place">
      <div class="place-name"><h2>${escapeHtml(r.name)}</h2>${r.chain ? '<span class="badge">Chain</span>' : ""}</div>
      ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
    </div>
    ${r.deals.map(dealHtml).join("")}
    <div class="checked">
      <span>Checked ${daysAgo(oldest)}${fromImage}</span>
      <a href="${escapeHtml(r.deals[0].source_url)}" target="_blank" rel="noopener">View source</a>
    </div>`;
}

function popupHtml(r) {
  const n = r.deals.length;
  const rows = r.deals
    .slice(0, 3)
    .map((d) => `<li><b>${escapeHtml(d.price ?? "Deal")}</b><span>${escapeHtml(d.title)}</span></li>`)
    .join("");
  const more = n > 3 ? `<p>and ${n - 3} more in the list</p>` : "";
  return `<h2>${escapeHtml(r.name)}</h2><p>${n} deal${n === 1 ? "" : "s"}${r.address ? " · " + escapeHtml(r.address) : ""}</p><ul>${rows}</ul>${more}`;
}

function select(r, { fly }) {
  state.selected = r.id;
  for (const card of document.querySelectorAll(".card")) card.classList.toggle("selected", card.dataset.id === r.id);
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 22, maxWidth: "300px" }).setLngLat([r.lon, r.lat]).setHTML(popupHtml(r)).addTo(map);
  popup.on("close", () => {
    if (state.selected !== r.id) return;
    state.selected = null;
    render();
  });
  drawMarkers(visible());
  if (fly) map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 15.5) });
}

function drawMarkers(shown) {
  map?.getSource("places")?.setData({
    type: "FeatureCollection",
    features: shown.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: { id: r.id, name: r.name, selected: r.id === state.selected },
    })),
  });
}

function render() {
  const shown = visible();
  const count = shown.reduce((n, r) => n + r.deals.length, 0);
  const dayText = state.now ? "right now" : state.day === "all" ? "this week" : `on ${DAY_NAME[state.day]}`;
  $("count").textContent = count;
  $("summary").textContent = `deal${count === 1 ? "" : "s"} at ${shown.length} place${shown.length === 1 ? "" : "s"} ${dayText}`;

  $("list").innerHTML = shown.length
    ? shown
        .map((r) => `<li class="card${r.id === state.selected ? " selected" : ""}" data-id="${escapeHtml(r.id)}">${restaurantHtml(r)}</li>`)
        .join("")
    : `<li class="empty">No deals match these filters.</li>`;

  if (state.selected && !shown.some((r) => r.id === state.selected)) {
    state.selected = null;
    popup?.remove();
  }
  drawMarkers(shown);
}

function setUpFilters() {
  const today = annArborNow().day;
  // "Now" lives in the same bar as the days: it means today, at this hour.
  $("days").innerHTML =
    `<button data-day="now" class="now"><span class="dot" aria-hidden="true"></span>Now</button>` +
    ["all", ...DAYS]
      .map((d) => `<button data-day="${d}" class="${d === today ? "today" : ""}">${d === "all" ? "All" : DAY_LABEL[d]}</button>`)
      .join("");
  const sync = () => {
    for (const b of $("days").children) {
      const on = b.dataset.day === "now" ? state.now : !state.now && b.dataset.day === state.day;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on);
    }
    for (const b of $("categories").children) b.classList.toggle("active", b.dataset.category === state.category);
    for (const b of $("owners").children) {
      b.classList.toggle("active", b.dataset.owner === state.owner);
      b.setAttribute("aria-pressed", b.dataset.owner === state.owner);
    }
    for (const b of $("prices").children) {
      b.classList.toggle("active", Number(b.dataset.cap) === state.cap);
      b.setAttribute("aria-pressed", Number(b.dataset.cap) === state.cap);
    }
    for (const b of $("times").children) {
      b.classList.toggle("active", b.dataset.period === state.period);
      b.setAttribute("aria-pressed", b.dataset.period === state.period);
    }
    // How many filters differ from what the page opens with.
    const changed =
      (state.now || state.day !== today) +
      (state.category !== "all") +
      (state.owner !== "all") +
      (state.cap !== null) +
      (state.period !== null) +
      (state.query !== "");
    $("filters-count").textContent = changed || "";
  };
  const update = () => {
    sync();
    render();
  };
  $("days").addEventListener("click", (e) => {
    const day = e.target.closest("button")?.dataset.day;
    if (!day) return;
    state.now = day === "now";
    state.day = state.now ? annArborNow().day : day;
    update();
  });
  $("categories").addEventListener("click", (e) => {
    const category = e.target.closest("button")?.dataset.category;
    if (!category) return;
    state.category = category;
    update();
  });
  // "Local only" and "Chains only" are toggles: pressing the active one clears it.
  $("owners").addEventListener("click", (e) => {
    const owner = e.target.closest("button")?.dataset.owner;
    if (!owner) return;
    state.owner = state.owner === owner ? "all" : owner;
    update();
  });
  $("prices").addEventListener("click", (e) => {
    const cap = e.target.closest("button")?.dataset.cap;
    if (!cap) return;
    state.cap = state.cap === Number(cap) ? null : Number(cap);
    update();
  });
  $("times").addEventListener("click", (e) => {
    const period = e.target.closest("button")?.dataset.period;
    if (!period) return;
    state.period = state.period === period ? null : period;
    update();
  });
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    update();
  });
  $("list").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const card = e.target.closest(".card");
    const r = card && visible().find((x) => x.id === card.dataset.id);
    if (r) select(r, { fly: true });
  });

  // On a phone the filters are a sheet over the list, opened from a button.
  const setOpen = (open) => {
    document.body.classList.toggle("filters-open", open);
    $("filters-open").setAttribute("aria-expanded", open);
    (open ? $("filters-close") : $("filters-open")).focus();
  };
  $("filters-open").addEventListener("click", () => setOpen(true));
  $("filters-close").addEventListener("click", () => setOpen(false));
  $("filters").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("filters-open")) setOpen(false);
  });
  sync();
}

// Map colours per theme: the base style, and the dots and labels drawn on it.
const THEMES = {
  light: { style: "positron", dot: "#0e1b2e", ring: "#ffffff", text: "#0e1b2e", halo: "#ffffff", selectedRing: "#0e1b2e", line: "#0e1b2e" },
  dark: { style: "dark", dot: "#eef2f8", ring: "#0d1522", text: "#eef2f8", halo: "#0d1522", selectedRing: "#ffffff", line: "#eef2f8" },
};
const currentTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const styleUrl = () => `https://tiles.openfreemap.org/styles/${THEMES[currentTheme()].style}`;

// Our own layers. Runs again after every theme switch, because loading a new
// base style discards them.
function addLayers(boundary) {
  const c = THEMES[currentTheme()];
  if (map.getLayer("places")) return;
  map.addSource("boundary", { type: "geojson", data: boundary });
  map.addLayer({
    id: "boundary",
    type: "line",
    source: "boundary",
    paint: { "line-color": c.line, "line-width": 1.5, "line-dasharray": [3, 3], "line-opacity": 0.35 },
  });
  map.addSource("places", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "places",
    type: "circle",
    source: "places",
    layout: { "circle-sort-key": ["case", ["get", "selected"], 1, 0] },
    paint: {
      "circle-radius": ["case", ["get", "selected"], 9, 6.5],
      "circle-color": ["case", ["get", "selected"], "#ffcb05", c.dot],
      "circle-stroke-color": ["case", ["get", "selected"], c.selectedRing, c.ring],
      "circle-stroke-width": 2.5,
    },
  });
  // Names sit beside the dots. Where two would overlap, one is left out (the
  // dot stays); the selected place's name always wins.
  map.addLayer({
    id: "place-names",
    type: "symbol",
    source: "places",
    layout: {
      "text-field": ["get", "name"],
      "text-size": 12.5,
      "text-font": ["Noto Sans Bold"],
      "text-variable-anchor": ["top", "bottom", "left", "right"],
      "text-radial-offset": 0.9,
      "text-max-width": 9,
      "symbol-sort-key": ["case", ["get", "selected"], 0, 1],
    },
    paint: { "text-color": c.text, "text-halo-color": c.halo, "text-halo-width": 2 },
  });
  drawMarkers(visible());
}

function setUpMap(boundary) {
  map = new maplibregl.Map({
    container: "map",
    style: styleUrl(),
    center: [-83.743, 42.2808],
    zoom: 12.6,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
  map.on("style.load", () => addLayers(boundary));
  for (const layer of ["places", "place-names"]) {
    map.on("click", layer, (e) => {
      const r = visible().find((x) => x.id === e.features[0].properties.id);
      if (!r) return;
      select(r, { fly: false });
      document.querySelector(".card.selected")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
}

function setUpTheme() {
  const label = () => $("theme").setAttribute("aria-label", `Switch to ${currentTheme() === "dark" ? "light" : "dark"} mode`);
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    label();
    // A full reload of the style, so "style.load" fires and our layers are re-added.
    map?.setStyle(styleUrl(), { diff: false });
  };
  $("theme").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("theme", next);
    } catch {}
    apply(next);
  });
  // Follow the device until the visitor picks a theme here.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null;
    try {
      saved = localStorage.getItem("theme");
    } catch {}
    if (!saved) apply(e.matches ? "dark" : "light");
  });
  label();
}

async function main() {
  setUpFilters();
  setUpTheme();
  const [deals, boundary] = await Promise.all([
    fetch("data/deals.json").then((r) => r.json()),
    fetch("data/boundary.geojson").then((r) => r.json()),
  ]);
  data = deals;
  $("status").textContent = `${deals.restaurants_checked} places checked · updated ${daysAgo(deals.generated_at)}`;
  render();
  setUpMap(boundary);
}

main().catch((err) => {
  $("count").textContent = "";
  $("summary").textContent = "Could not load deals.";
  console.error(err);
});
