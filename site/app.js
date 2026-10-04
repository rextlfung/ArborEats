const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
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

const state = { day: annArborNow().day, category: "all", owner: "all", now: false, query: "", selected: null };
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
  if (!days.length) return "Days not stated";
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
  const conditions = d.conditions ? ` · ${escapeHtml(d.conditions)}` : "";
  return `<div class="deal">
    <span class="price">${escapeHtml(d.price ?? "Deal")}</span>
    <span>${d.description.startsWith(d.title.replace(/…$/, "")) ? escapeHtml(d.description) : `<strong>${escapeHtml(d.title)}</strong>: ${escapeHtml(d.description)}`}</span>
    <span class="when">${escapeHtml(formatWhen(d))}${conditions} ·
      <a href="${escapeHtml(d.source_url)}" target="_blank" rel="noopener">${d.from_image ? "read from an image" : "source"}, checked ${daysAgo(d.verified_at)}</a></span>
  </div>`;
}

function restaurantHtml(r) {
  const meta = [r.address, r.cuisine.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  return `<h2>${escapeHtml(r.name)}</h2><div class="meta">${escapeHtml(meta)}</div>${r.deals.map(dealHtml).join("")}`;
}

function select(r, { fly }) {
  state.selected = r.id;
  for (const card of document.querySelectorAll(".card")) card.classList.toggle("selected", card.dataset.id === r.id);
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 14, maxWidth: "320px" })
    .setLngLat([r.lon, r.lat])
    .setHTML(restaurantHtml(r))
    .addTo(map);
  if (fly) map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 15.5) });
}

function render() {
  const shown = visible();
  const count = shown.reduce((n, r) => n + r.deals.length, 0);
  const dayText = state.now ? "right now" : state.day === "all" ? "this week" : `on ${DAY_LABEL[state.day]}`;
  $("summary").textContent = `${count} deal${count === 1 ? "" : "s"} at ${shown.length} place${shown.length === 1 ? "" : "s"} ${dayText}`;

  $("list").innerHTML = shown.length
    ? shown.map((r) => `<li class="card" data-id="${escapeHtml(r.id)}">${restaurantHtml(r)}</li>`).join("")
    : `<li class="empty">No deals match these filters.</li>`;

  map?.getSource("places")?.setData({
    type: "FeatureCollection",
    features: shown.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: { id: r.id, name: r.name, count: r.deals.length },
    })),
  });
  if (state.selected && !shown.some((r) => r.id === state.selected)) popup?.remove();
}

function setUpFilters() {
  const today = annArborNow().day;
  $("days").innerHTML = ["all", ...DAYS]
    .map((d) => `<button data-day="${d}" class="${d === today ? "today" : ""}">${d === "all" ? "All week" : DAY_LABEL[d]}</button>`)
    .join("");
  const sync = () => {
    for (const b of $("days").children) b.classList.toggle("active", b.dataset.day === state.day);
    for (const b of $("categories").children) b.classList.toggle("active", b.dataset.category === state.category);
    for (const b of $("owners").children) b.classList.toggle("active", b.dataset.owner === state.owner);
  };
  $("days").addEventListener("click", (e) => {
    if (!e.target.dataset.day) return;
    state.day = e.target.dataset.day;
    sync();
    render();
  });
  $("categories").addEventListener("click", (e) => {
    if (!e.target.dataset.category) return;
    state.category = e.target.dataset.category;
    sync();
    render();
  });
  $("owners").addEventListener("click", (e) => {
    if (!e.target.dataset.owner) return;
    state.owner = e.target.dataset.owner;
    sync();
    render();
  });
  $("now").addEventListener("change", (e) => {
    state.now = e.target.checked;
    if (state.now) state.day = annArborNow().day;
    sync();
    render();
  });
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });
  $("list").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const card = e.target.closest(".card");
    const r = card && visible().find((x) => x.id === card.dataset.id);
    if (r) select(r, { fly: true });
  });
  sync();
}

function setUpMap(boundary) {
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/positron",
    center: [-83.743, 42.2808],
    zoom: 12.6,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");

  map.on("load", () => {
    map.addSource("boundary", { type: "geojson", data: boundary });
    map.addLayer({
      id: "boundary",
      type: "line",
      source: "boundary",
      paint: { "line-color": "#d9480f", "line-width": 1.5, "line-dasharray": [3, 3], "line-opacity": 0.5 },
    });
    map.addSource("places", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "places",
      type: "circle",
      source: "places",
      paint: { "circle-radius": 12, "circle-color": "#d9480f", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: "place-counts",
      type: "symbol",
      source: "places",
      layout: { "text-field": ["to-string", ["get", "count"]], "text-size": 12, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
      paint: { "text-color": "#fff" },
    });
    map.on("click", "places", (e) => {
      const r = visible().find((x) => x.id === e.features[0].properties.id);
      if (!r) return;
      select(r, { fly: false });
      document.querySelector(".card.selected")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    map.on("mouseenter", "places", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "places", () => (map.getCanvas().style.cursor = ""));
    render();
  });
}

async function main() {
  setUpFilters();
  const [deals, boundary] = await Promise.all([
    fetch("data/deals.json").then((r) => r.json()),
    fetch("data/boundary.geojson").then((r) => r.json()),
  ]);
  data = deals;
  $("footer").textContent = `Scraped from restaurant websites. ${deals.restaurants_checked} places checked, last run ${daysAgo(deals.generated_at)}. Confirm with the restaurant before you go.`;
  render();
  setUpMap(boundary);
}

main().catch((err) => {
  $("summary").textContent = "Could not load deals.";
  console.error(err);
});
