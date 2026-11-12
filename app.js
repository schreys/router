'use strict';

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers';
const TRACK_COLORS = ['#1f78b4', '#6a3d9a', '#e31a1c', '#ff7f00', '#33a02c', '#b15928', '#a6118f', '#008080'];
const SPEEDS = { trekking: 18, fastbike: 25, safety: 16, mtb: 14, shortest: 16, 'hiking-mountain': 4.5 };

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function computeStats(coords, speedKmh = 18) {
  let dist = 0, up = 0, down = 0, ref = null;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) dist += haversine(coords[i - 1], coords[i]);
    const ele = coords[i][2];
    if (ele == null || isNaN(ele)) continue;
    if (ref == null) { ref = ele; continue; }
    // Hysteresis filters out GPS/DEM noise
    const d = ele - ref;
    if (d >= 3) { up += d; ref = ele; } else if (d <= -3) { down -= d; ref = ele; }
  }
  const climbRate = speedKmh < 8 ? 300 : 700; // vertical meters per hour
  const hours = dist / 1000 / speedKmh + up / climbRate;
  return { dist, up, down, hours };
}

const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
const fmtTime = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} u`;

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const escapeHtml = escapeXml;

// ---------- Map & layers ----------
const map = L.map('map', { zoomControl: true }).setView([50.95, 4.2], 9);
L.control.scale({ imperial: false }).addTo(map);

let layerControl = null;
let baseLayers = {};

// Overlay with BRouter's 5x5° routing data tiles (named after their south-west corner, e.g. E0_N50);
// tiles available on the own server (listed in /segments.json by the Docker image) are green.
const segmentLayer = L.layerGroup();
const tileName = (lng, lat) => `${lng < 0 ? 'W' : 'E'}${Math.abs(lng)}_${lat < 0 ? 'S' : 'N'}${Math.abs(lat)}`;

async function buildSegmentLayer() {
  let available = [];
  try {
    const res = await fetch('segments.json');
    if (res.ok) available = await res.json();
  } catch { /* no own server: show the grid only */ }
  segmentLayer.clearLayers();
  for (let lng = -25; lng < 45; lng += 5) {
    for (let lat = 30; lat < 75; lat += 5) {
      const name = tileName(lng, lat);
      const own = available.includes(name);
      L.rectangle([[lat, lng], [lat + 5, lng + 5]], {
        interactive: false, weight: own ? 2 : 1, color: own ? '#2f9e2f' : '#666',
        fillColor: '#2f9e2f', fillOpacity: own ? 0.12 : 0, dashArray: own ? null : '4 4',
      }).addTo(segmentLayer);
      L.marker([lat + 2.5, lng + 2.5], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: `segment-label${own ? ' own' : ''}`, html: own ? `${name} ✓` : name, iconSize: [90, 18], iconAnchor: [45, 9] }),
      }).addTo(segmentLayer);
    }
  }
}
buildSegmentLayer();

function buildLayers() {
  const key = localStorage.getItem('tfKey') || '';
  const tf = (style, name) => L.tileLayer(`https://{s}.tile.thunderforest.com/${style}/{z}/{x}/{y}{r}.png?apikey=${encodeURIComponent(key)}`, {
    maxZoom: 22, attribution: `Kaarten &copy; <a href="https://www.thunderforest.com">Thunderforest</a>, ${OSM_ATTR}`, name,
  });

  const layers = {};
  if (key) {
    layers['OpenCycleMap'] = tf('cycle');
    layers['Outdoors'] = tf('outdoors');
    layers['Landscape'] = tf('landscape');
  }
  layers['CyclOSM'] = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 20, attribution: `<a href="https://www.cyclosm.org">CyclOSM</a> | ${OSM_ATTR}`,
  });
  layers['OpenStreetMap'] = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: OSM_ATTR,
  });
  const overlays = {
    'Fietsknooppunten & -routes': L.tileLayer('https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', {
      maxZoom: 18, opacity: 0.8, attribution: '<a href="https://cycling.waymarkedtrails.org">Waymarked Trails</a>',
    }),
    'BRouter-segmenten': segmentLayer,
  };

  Object.values(baseLayers).forEach((l) => map.removeLayer(l));
  if (layerControl) layerControl.remove();
  baseLayers = layers;

  const preferred = localStorage.getItem('baseLayer');
  const start = layers[preferred] || layers['OpenCycleMap'] || layers['CyclOSM'];
  start.addTo(map);
  layerControl = L.control.layers(layers, overlays, { position: 'topright' }).addTo(map);
}

map.on('baselayerchange', (e) => localStorage.setItem('baseLayer', e.name));

$('apiKey').value = localStorage.getItem('tfKey') || '';
$('saveKey').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (key) localStorage.setItem('tfKey', key); else localStorage.removeItem('tfKey');
  localStorage.removeItem('baseLayer');
  buildLayers();
  toast(key ? 'OpenCycleMap geactiveerd' : 'Key verwijderd – CyclOSM wordt gebruikt');
});
buildLayers();

// ---------- Place search (Photon geocoder by komoot, OpenStreetMap data) ----------
const searchMarker = L.marker([0, 0], { keyboard: false });

const SearchControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const box = L.DomUtil.create('div', 'search-box');
    box.innerHTML = '<input type="search" placeholder="🔍 Zoek een plaats…" aria-label="Zoek een plaats" autocomplete="off" /><ul class="search-results hidden" role="listbox"></ul>';
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  },
});
const searchBox = new SearchControl().addTo(map).getContainer();
searchBox.parentNode.prepend(searchBox); // above the zoom buttons
const searchInput = searchBox.querySelector('input');
const searchList = searchBox.querySelector('ul');
let searchResults = [];
let searchActive = -1;
let searchTimer = null;
let searchSeq = 0;
// Cities, villages and boroughs are searched instantly in a local list (places.json, built into the
// Docker image from GeoNames); streets, addresses and POIs come from an online geocoder. Photon (made
// for search-as-you-type) is preferred, Nominatim is the fallback when Photon is down; Nominatim's
// usage policy allows at most 1 request per second, hence the throttle and slower debounce.
let photonDownUntil = +localStorage.getItem('photonDownUntil') || 0;
let lastNominatim = 0;
let places = null;
const COUNTRY_NAMES = { BE: 'België', NL: 'Nederland', LU: 'Luxemburg', FR: 'Frankrijk', DE: 'Duitsland' };
const normalize = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-'’.]/g, ' ').replace(/\s+/g, ' ').trim();

let placesLoading = null;
function loadPlaces() {
  placesLoading ??= fetch('places.json')
    .then((res) => (res.ok ? res.json() : []))
    .catch(() => [])
    .then((rows) => {
      if (rows.length) map.attributionControl.addAttribution('Plaatsnamen &copy; <a href="https://www.geonames.org">GeoNames</a>');
      places = rows.map(([name, lat, lng, region, cc, pop, alt]) => ({
        name, lat, lng, region, cc, pop, key: normalize(name), alts: alt ? alt.split('|').map(normalize) : [],
      }));
      const q = searchInput.value.trim();
      if (q.length >= 2 && document.activeElement === searchInput) showLocalResults(q);
    });
  return placesLoading;
}

function searchPlaces(q) {
  if (!places) return [];
  const nq = normalize(q);
  const matches = [];
  for (const p of places) {
    let score;
    if (p.key === nq || p.alts.includes(nq)) score = 0;
    else if (p.key.startsWith(nq)) score = 1;
    else if (p.alts.some((a) => a.startsWith(nq))) score = 2;
    else if (p.key.includes(` ${nq}`)) score = 3;
    else continue;
    matches.push({ p, score });
  }
  matches.sort((a, b) => a.score - b.score || b.p.pop - a.p.pop);
  return matches.slice(0, 5).map(({ p }) => ({
    name: p.name,
    where: [p.region, COUNTRY_NAMES[p.cc] || p.cc].filter((x) => x && x !== p.name).join(', '),
    lat: p.lat, lng: p.lng,
    zoom: p.pop > 100000 ? 12 : p.pop > 10000 ? 13 : 14,
  }));
}

function placeLabel(p) {
  const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
  const where = [p.postcode && p.city ? `${p.postcode} ${p.city}` : p.city || p.county, p.country].filter((x) => x && x !== name);
  return { name: name || where.shift() || '?', where: where.join(', ') };
}

async function searchPhoton(q) {
  const c = map.getCenter();
  const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`,
    { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  return (await res.json()).features.map((f) => {
    const ext = f.properties.extent; // [minLon, maxLat, maxLon, minLat]
    return {
      ...placeLabel(f.properties),
      lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      bounds: ext && [[ext[3], ext[0]], [ext[1], ext[2]]],
    };
  });
}

async function searchNominatim(q) {
  await sleep(Math.max(0, lastNominatim + 1000 - Date.now()));
  lastNominatim = Date.now();
  const b = map.getBounds();
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&accept-language=nl&q=${encodeURIComponent(q)}`
    + `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`);
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return (await res.json()).map((r) => {
    const a = r.address || {};
    const bb = r.boundingbox.map(Number); // [minLat, maxLat, minLon, maxLon]
    return {
      ...placeLabel({ name: r.name, street: a.road, housenumber: a.house_number, postcode: a.postcode,
        city: a.city || a.town || a.village, county: a.county, country: a.country }),
      lat: +r.lat, lng: +r.lon,
      bounds: [[bb[0], bb[2]], [bb[1], bb[3]]],
    };
  });
}

let searchStatus = ''; // '' | 'busy' (online search pending) | 'none' (nothing found)

function setSearchStatus(status) {
  searchStatus = status;
  searchBox.classList.toggle('loading', status === 'busy');
}

function renderSearchResults() {
  const status = searchStatus === 'busy' ? 'Zoeken naar straten en adressen…'
    : searchStatus === 'none' && !searchResults.length ? 'Niets gevonden' : '';
  searchList.innerHTML = searchResults.map((r, i) =>
    `<li role="option" data-i="${i}" class="${i === searchActive ? 'active' : ''}"><b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.where)}</span></li>`).join('')
    + (status ? `<li class="search-status">${status}</li>` : '');
  searchList.classList.toggle('hidden', !searchResults.length && !status);
}

function setSearchResults(results) {
  // Drop duplicates, e.g. the same town from the local list and the online geocoder.
  const unique = [];
  for (const r of results) {
    const dup = unique.some((u) => normalize(u.name) === normalize(r.name)
      && (u.where === r.where || L.latLng(u.lat, u.lng).distanceTo([r.lat, r.lng]) < 3000));
    if (!dup) unique.push(r);
  }
  searchResults = unique.slice(0, 8);
  searchActive = searchResults.length ? 0 : -1;
  renderSearchResults();
}

function showLocalResults(q) {
  setSearchResults(searchPlaces(q));
}

async function searchOnline(q) {
  if (Date.now() > photonDownUntil) {
    try { return await searchPhoton(q); } catch (err) {
      console.warn('Photon niet bereikbaar, Nominatim wordt gebruikt', err);
      photonDownUntil = Date.now() + 60 * 60 * 1000;
      localStorage.setItem('photonDownUntil', photonDownUntil);
    }
  }
  return searchNominatim(q);
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const local = searchPlaces(q);
  let online = [];
  try { online = await searchOnline(q); } catch (err) { console.warn(err); }
  if (seq !== searchSeq) return;
  const results = [...local, ...online];
  setSearchStatus(results.length ? '' : 'none');
  setSearchResults(results);
}

function clearSearchResults() {
  clearTimeout(searchTimer);
  searchSeq++;
  setSearchStatus('');
  searchResults = [];
  renderSearchResults();
}

function selectSearchResult(i) {
  const r = searchResults[i];
  if (!r) return;
  const { lat, lng } = r;
  if (r.bounds) map.fitBounds(r.bounds, { maxZoom: 16 });
  else map.setView([lat, lng], r.zoom || 16);

  const popup = L.DomUtil.create('div', 'search-popup');
  popup.innerHTML = `<b>${escapeHtml(r.name)}</b><br><small>${escapeHtml(r.where)}</small><br><button class="small">${editingId ? '➕ Aan route toevoegen' : '➕ Nieuwe route vanaf hier'}</button>`;
  popup.querySelector('button').addEventListener('click', () => {
    if (!editingId) createRoute();
    addWaypoint({ lat, lng });
    map.removeLayer(searchMarker);
  });
  searchMarker.setLatLng([lat, lng]).bindPopup(popup).addTo(map).openPopup();

  searchInput.value = r.name;
  clearSearchResults();
  searchInput.blur();
}

searchInput.addEventListener('focus', loadPlaces);
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (q.length < 2) return clearSearchResults();
  clearTimeout(searchTimer);
  searchSeq++;
  loadPlaces();
  setSearchStatus('busy');
  showLocalResults(q);
  searchTimer = setTimeout(() => runSearch(q), Date.now() > photonDownUntil ? 200 : 500);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!searchResults.length) return;
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
    renderSearchResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchResults.length) return selectSearchResult(Math.max(searchActive, 0));
    const q = searchInput.value.trim();
    if (q.length < 2) return;
    clearTimeout(searchTimer);
    setSearchStatus('busy');
    renderSearchResults();
    runSearch(q).then(() => selectSearchResult(0));
  } else if (e.key === 'Escape') {
    clearSearchResults();
    searchInput.blur();
  }
});
searchInput.addEventListener('blur', () => setTimeout(() => searchList.classList.add('hidden'), 150));
// mousedown instead of click so the selection happens before the input's blur hides the list.
searchList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); selectSearchResult(+li.dataset.i); }
});

// ---------- Route state ----------
// All routes (drawn or imported from GPX) live in `routes`: { id, name, color, visible, wps, segs, wpts }.
// wps are the waypoints [{lat,lng}]; segs[i] connects wps[i] -> wps[i+1] with coords [[lat,lng,ele?]];
// wpts are named points from an imported GPX file.
// At most one route is in edit mode: its wps/segs are the editor's `waypoints`/`segments` (same
// arrays, synced back in changed()); all other routes are drawn read-only.
const routes = [];
let routeSeq = 0;
let editingId = null;
let selectedId = null;
let waypoints = [];
let segments = [];
let undoStack = [];
let dragging = false;
let cutting = false;

const editingRoute = () => routes.find((r) => r.id === editingId) || null;
const routeById = (id) => routes.find((r) => r.id === id);

const routeLayer = L.layerGroup().addTo(map);
let segLines = [];

const routeCache = new Map();
const cacheKey = (a, b, profile) => `${profile}|${a.lat.toFixed(6)},${a.lng.toFixed(6)}|${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;

const pendingRoutes = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Docker image (also used locally via docker compose) runs its own BRouter, proxied at /brouter on
// the same origin. brouter.de is the fallback when it isn't available (e.g. a plain static file server)
// or when it lacks the map tile for the requested area.
const OWN_ROUTER = `${location.origin}/brouter`;
const PUBLIC_ROUTER = 'https://brouter.de/brouter';
let ownRouter = null;

function setOwnRouter(url) {
  ownRouter = url;
  $('routerStatus').textContent = url ? '⚡ Eigen BRouter-server' : 'Routing via brouter.de';
}

async function checkOwnRouter() {
  try {
    const res = await fetch(OWN_ROUTER, { signal: AbortSignal.timeout(1500) });
    // BRouter answers 404 here, with a CORS header that other static servers don't send;
    // a 5xx comes from the proxy while BRouter is still starting or down.
    setOwnRouter(res.status < 500 && res.headers.has('access-control-allow-origin') ? OWN_ROUTER : null);
  } catch { setOwnRouter(null); }
}
checkOwnRouter();
setInterval(() => { if (!ownRouter) checkOwnRouter(); }, 30000);

const parseRoute = (json) => json.features[0].geometry.coordinates.map((c) => [c[1], c[0], c[2]]);

// Cached and de-duplicated: identical requests that are still in flight share one promise.
function routeBetween(a, b, profile, retries = 0) {
  const key = cacheKey(a, b, profile);
  if (routeCache.has(key)) return Promise.resolve(routeCache.get(key));
  if (pendingRoutes.has(key)) return pendingRoutes.get(key);
  const query = `?lonlats=${a.lng},${a.lat}|${b.lng},${b.lat}&profile=${profile}&alternativeidx=0&format=geojson`;
  const p = (async () => {
    let coords;
    if (ownRouter) {
      try {
        const res = await fetch(ownRouter + query);
        if (res.ok) coords = parseRoute(await res.json());
        else console.warn('Eigen BRouter:', (await res.text()).slice(0, 200));
      } catch { setOwnRouter(null); }
    }
    for (let attempt = 0; !coords; attempt++) {
      const res = await fetch(PUBLIC_ROUTER + query);
      if (res.ok) { coords = parseRoute(await res.json()); break; }
      const msg = (await res.text()).slice(0, 200);
      // BRouter answers 403 "Please, retry later!" when rate limited.
      if (attempt >= retries || ![403, 429, 503].includes(res.status)) throw new Error(msg);
      await sleep(1000 * (attempt + 1));
    }
    routeCache.set(key, coords);
    if (routeCache.size > 200) routeCache.delete(routeCache.keys().next().value);
    return coords;
  })().finally(() => pendingRoutes.delete(key));
  pendingRoutes.set(key, p);
  return p;
}

// A loading segment is only drawn dashed when routing takes longer than this; until then a routed
// placeholder stays solid and a plain straight line is hidden, so fast (local) routing doesn't flicker.
const DASH_DELAY = 150;

function newSeg(a, b, placeholder) {
  const straight = $('straight').checked;
  const cached = !straight && routeCache.get(cacheKey(a, b, $('profile').value));
  if (cached) return { a, b, coords: cached, loading: false };
  const seg = { a, b, coords: placeholder || [[a.lat, a.lng], [b.lat, b.lng]], loading: !straight, slow: false, placeholder: !!placeholder };
  if (seg.loading) {
    setTimeout(() => { if (seg.loading) { seg.slow = true; renderRoute(); } }, DASH_DELAY);
    routeBetween(a, b, $('profile').value, 2)
      .then((coords) => { seg.coords = coords; })
      .catch((err) => { console.warn(err); toast(placeholder ? 'Routeberekening mislukt – voorlopige route gebruikt' : 'Routeberekening mislukt – rechte lijn gebruikt'); })
      .finally(() => { seg.loading = false; changed(); });
  }
  return seg;
}

// extra.restoreRoute: a route that was removed by this step (e.g. joined into the edited one) and
// comes back on undo.
function snapshot(extra = {}) {
  undoStack.push(JSON.stringify({
    wps: waypoints,
    segs: segments.map((s) => ({ coords: s.coords, loading: s.loading })),
    ...(extra.restoreRoute && { restoreRoute: serializeRoute(extra.restoreRoute), restoreIndex: routes.indexOf(extra.restoreRoute) }),
  }));
  if (undoStack.length > 100) undoStack.shift();
}

function restore(json) {
  const snap = JSON.parse(json);
  waypoints = snap.wps;
  segments = buildSegs(waypoints, snap.segs);
  if (snap.restoreRoute) routes.splice(snap.restoreIndex, 0, deserializeRoute(snap.restoreRoute));
}

// Rebuilds segment objects from stored { coords, loading }; unfinished ones are routed again.
function buildSegs(wps, segs) {
  return segs.map((s, i) => (s.loading
    ? newSeg(wps[i], wps[i + 1])
    : { a: wps[i], b: wps[i + 1], coords: s.coords, loading: false }));
}

function addWaypoint(latlng) {
  snapshot();
  const wp = { lat: latlng.lat, lng: latlng.lng };
  if (waypoints.length) segments.push(newSeg(waypoints[waypoints.length - 1], wp));
  waypoints.push(wp);
  changed();
}

// segIndex: segment to split. When k (index in its coords before the split point) is given, the existing
// route is split at latlng, which lies on it, so both halves are already routed.
function insertWaypoint(segIndex, latlng, k) {
  snapshot();
  const wp = { lat: latlng.lat, lng: latlng.lng };
  const a = waypoints[segIndex];
  const b = waypoints[segIndex + 1];
  const old = segments[segIndex];
  waypoints.splice(segIndex + 1, 0, wp);
  const halves = k != null && !old.loading
    ? [{ a, b: wp, coords: [...old.coords.slice(0, k + 1), [wp.lat, wp.lng]], loading: false },
      { a: wp, b, coords: [[wp.lat, wp.lng], ...old.coords.slice(k + 1)], loading: false }]
    : [newSeg(a, wp), newSeg(wp, b)];
  segments.splice(segIndex, 1, ...halves);
  changed();
}

function moveWaypoint(i, latlng, preview = {}, snap = true) {
  if (snap) snapshot();
  const wp = { lat: latlng.lat, lng: latlng.lng };
  waypoints[i] = wp;
  if (i > 0) segments[i - 1] = newSeg(waypoints[i - 1], wp, preview.prev);
  if (i < waypoints.length - 1) segments[i] = newSeg(wp, waypoints[i + 1], preview.next);
  changed();
}

// ---------- Live re-routing while dragging a waypoint ----------
// Only one request pair is in flight at a time (and at most one every liveInterval() ms, to stay within
// brouter.de's rate limits); when it returns, the latest marker position is routed next.
const liveInterval = () => (ownRouter ? 40 : 300);
let live = null;

function liveCoords(l) {
  const p = [l.pos.lat, l.pos.lng];
  return {
    prev: l.i > 0 ? [...(l.prev || [[waypoints[l.i - 1].lat, waypoints[l.i - 1].lng]]), p] : null,
    next: l.i < waypoints.length - 1 ? [p, ...(l.next || [[waypoints[l.i + 1].lat, waypoints[l.i + 1].lng]])] : null,
  };
}

function drawLive() {
  const c = liveCoords(live);
  const prevLine = segLines[live.i - 1];
  const nextLine = segLines[live.i];
  const routing = !$('straight').checked;
  if (prevLine) prevLine.setLatLngs(c.prev).setStyle({ opacity: 0.9, dashArray: routing && !live.prev ? '6 8' : null });
  if (nextLine) nextLine.setLatLngs(c.next).setStyle({ opacity: 0.9, dashArray: routing && !live.next ? '6 8' : null });
}

async function fetchLive(l) {
  const p = l.pos;
  const profile = $('profile').value;
  l.busy = true;
  const minWait = sleep(liveInterval());
  try {
    const [prev, next] = await Promise.all([
      l.i > 0 ? routeBetween(waypoints[l.i - 1], p, profile) : null,
      l.i < waypoints.length - 1 ? routeBetween(p, waypoints[l.i + 1], profile) : null,
    ]);
    if (live !== l) return;
    l.prev = prev;
    l.next = next;
    drawLive();
  } catch (err) {
    console.warn(err);
  }
  await minWait;
  l.busy = false;
  if (live === l && l.pos !== p) fetchLive(l);
}

function startLive(i) {
  // Until the first live result arrives, extend the existing routed segments to the cursor.
  const routed = (s) => (s && !s.loading && !$('straight').checked ? s.coords : null);
  live = { i, pos: waypoints[i], prev: routed(segments[i - 1]), next: routed(segments[i]), busy: false };
}

function updateLive(latlng) {
  live.pos = { lat: latlng.lat, lng: latlng.lng };
  drawLive();
  if (!$('straight').checked && !live.busy) fetchLive(live);
}

function endLive(latlng, snap = true) {
  const l = live;
  live = null;
  l.pos = { lat: latlng.lat, lng: latlng.lng };
  const c = liveCoords(l);
  moveWaypoint(l.i, latlng, { prev: l.prev && c.prev, next: l.next && c.next }, snap);
}

function removeWaypoint(i) {
  snapshot();
  const last = waypoints.length - 1;
  if (i === 0) { waypoints.shift(); segments.shift(); }
  else if (i === last) { waypoints.pop(); segments.pop(); }
  else {
    waypoints.splice(i, 1);
    segments.splice(i - 1, 2, newSeg(waypoints[i - 1], waypoints[i]));
  }
  changed();
}

const joinSegs = (segs) => {
  const out = [];
  segs.forEach((s, i) => out.push(...(i === 0 ? s.coords : s.coords.slice(1))));
  return out;
};
const routeCoords = () => joinSegs(segments);
const coordsOf = (r) => (r.id === editingId ? routeCoords() : joinSegs(r.segs));

const wpIcon = (cls) => L.divIcon({ className: '', html: `<div class="wp-icon ${cls}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });

let pendingRender = false;
let wpMarkers = [];
function renderRoute() {
  if (dragging) { pendingRender = true; return; }
  routeLayer.clearLayers();
  segLines = segments.map((s, i) => {
    const dashed = s.loading && s.slow;
    const hidden = s.loading && !s.slow && !s.placeholder;
    return L.polyline(s.coords, {
      color: '#e2621b', weight: 5, opacity: hidden ? 0 : 0.9, dashArray: dashed ? '6 8' : null, interactive: false,
    }).addTo(routeLayer);
  });
  // Wide invisible lines on top make the route easy to hit for inserting points (or cutting).
  segments.forEach((s, i) => {
    const hit = L.polyline(s.coords, { weight: 20, opacity: 0, bubblingMouseEvents: false }).addTo(routeLayer);
    hit.on('mousemove', (e) => (cutting ? showCutMarker(i, e.latlng) : showGhost(i, e.latlng)));
    hit.on('click', (e) => {
      const g = nearestOnSegment(i, e.latlng);
      if (cutting) return cutRoute(g);
      hideGhost();
      insertWaypoint(i, g.latlng, g.k);
    });
  });

  wpMarkers = waypoints.map((wp, i) => {
    const cls = i === 0 ? 'start' : i === waypoints.length - 1 ? 'end' : '';
    const m = L.marker(wp, { icon: wpIcon(cls), draggable: true, title: `Punt ${i + 1} – rechtsklik om te verwijderen` }).addTo(routeLayer);
    m.on('dragstart', () => { dragging = true; startLive(i); });
    m.on('drag', (e) => updateLive(e.target.getLatLng()));
    m.on('dragend', (e) => { dragging = false; pendingRender = false; endLive(e.target.getLatLng()); });
    m.on('contextmenu dblclick', (e) => { L.DomEvent.stop(e); removeWaypoint(i); });
    return m;
  });
}

// ---------- Inserting points by dragging the route ----------
// Hovering the route shows a "ghost" point on it; dragging it inserts a waypoint there (with live
// re-routing), clicking it inserts one in place.
const ghostLayer = L.layerGroup().addTo(map);
const ghost = L.marker([0, 0], {
  icon: wpIcon('ghost'), draggable: true, zIndexOffset: -1000, title: 'Sleep om een tussenpunt toe te voegen',
});
let ghostAt = null;
let ghostDragging = false;

function nearestOnSegment(segIndex, latlng) {
  const coords = segments[segIndex].coords;
  const p = map.latLngToLayerPoint(latlng);
  let best = null;
  for (let k = 0; k < coords.length - 1; k++) {
    const q = L.LineUtil.closestPointOnSegment(p, map.latLngToLayerPoint(coords[k]), map.latLngToLayerPoint(coords[k + 1]));
    const d = q.distanceTo(p);
    if (!best || d < best.d) best = { d, k, q };
  }
  return { seg: segIndex, k: best.k, dist: best.d, latlng: map.layerPointToLatLng(best.q) };
}

function showGhost(segIndex, latlng) {
  if (cutting || ghostDragging || dragging || segments[segIndex].loading) return;
  const g = nearestOnSegment(segIndex, latlng);
  const pt = map.latLngToLayerPoint(g.latlng);
  // Leave room to grab the existing waypoints.
  if (waypoints.some((w) => map.latLngToLayerPoint(w).distanceTo(pt) < 14)) return hideGhost();
  ghostAt = g;
  ghost.setLatLng(g.latlng);
  if (!ghostLayer.hasLayer(ghost)) ghost.addTo(ghostLayer);
}

function hideGhost() {
  if (ghostDragging) return;
  ghostLayer.clearLayers();
  ghostAt = null;
}

// Map mousemove only fires off the route (the route and markers don't bubble their events).
map.on('mousemove', hideGhost);
ghost.on('mousemove', (e) => {
  if (!ghostAt || ghostDragging) return;
  if (nearestOnSegment(ghostAt.seg, e.latlng).dist > 12) hideGhost();
  else showGhost(ghostAt.seg, e.latlng);
});
ghost.on('click', (e) => {
  L.DomEvent.stop(e);
  const g = ghostAt;
  hideGhost();
  if (g) insertWaypoint(g.seg, g.latlng, g.k);
});
ghost.on('dragstart', () => {
  const g = ghostAt;
  ghostDragging = true;
  insertWaypoint(g.seg, g.latlng, g.k);
  const i = g.seg + 1;
  wpMarkers[i].setOpacity(0);
  dragging = true;
  startLive(i);
});
ghost.on('drag', (e) => updateLive(e.target.getLatLng()));
ghost.on('dragend', (e) => {
  ghostDragging = false;
  dragging = false;
  pendingRender = false;
  hideGhost();
  // insertWaypoint already made the undo snapshot.
  endLive(e.target.getLatLng(), false);
});

// ---------- Routes: list, view mode and edit mode ----------
const viewLayer = L.layerGroup().addTo(map);

function newRoute(data = {}) {
  const r = {
    id: ++routeSeq, name: `Route ${routeSeq}`, color: TRACK_COLORS[(routeSeq - 1) % TRACK_COLORS.length],
    visible: true, wps: [], segs: [], wpts: [], ...data,
  };
  return r;
}

const serializeRoute = (r) => ({
  id: r.id, name: r.name, color: r.color, visible: r.visible, wpts: r.wpts,
  wps: r.id === editingId ? waypoints : r.wps,
  segs: (r.id === editingId ? segments : r.segs).map((s) => ({ coords: s.coords, loading: s.loading })),
});

function deserializeRoute(d) {
  routeSeq = Math.max(routeSeq, d.id);
  return { ...d, wpts: d.wpts || [], segs: buildSegs(d.wps, d.segs) };
}

let saveFailed = false;
function saveRoutes() {
  try {
    localStorage.setItem('routes', JSON.stringify({ routes: routes.map(serializeRoute), editingId, selectedId }));
    saveFailed = false;
  } catch (e) {
    console.warn('Routes niet opgeslagen', e);
    if (!saveFailed) toast('Routes konden niet bewaard worden in de browser (te groot?)', 5000);
    saveFailed = true;
  }
}

// Read-only drawing of all visible routes except the one being edited.
function renderViews() {
  viewLayer.clearLayers();
  routes.forEach((r) => {
    if (!r.visible || r.id === editingId) return;
    const coords = coordsOf(r);
    if (coords.length > 1) {
      L.polyline(coords, { color: r.color, weight: r.id === selectedId ? 6 : 4, opacity: 0.85 })
        .bindTooltip(escapeHtml(r.name), { sticky: true })
        .on('click', (e) => { L.DomEvent.stop(e); selectRoute(r.id); })
        .on('dblclick', (e) => { L.DomEvent.stop(e); startEdit(r.id); })
        .addTo(viewLayer);
    }
    r.wpts.forEach((w) => L.circleMarker(w.p, { radius: 5, color: r.color, fillOpacity: 1 })
      .bindTooltip(escapeHtml(w.name || 'Punt')).addTo(viewLayer));
  });
}

function statsHtml(coords) {
  const s = computeStats(coords, SPEEDS[$('profile').value]);
  return `<div><b>${fmtKm(s.dist)}</b><span>afstand</span></div>
    <div><b>${fmtTime(s.hours)}</b><span>duur</span></div>
    <div><b>↗ ${Math.round(s.up)} m</b><span>↘ ${Math.round(s.down)} m</span></div>`;
}

function metaText(coords) {
  if (coords.length < 2) return 'Nog geen punten';
  const s = computeStats(coords, SPEEDS[$('profile').value]);
  return `${fmtKm(s.dist)} · ${fmtTime(s.hours)} · ↗ ${Math.round(s.up)} m · ↘ ${Math.round(s.down)} m`;
}

function renderRouteList() {
  $('routesEmpty').classList.toggle('hidden', routes.length > 0);
  $('routeList').innerHTML = routes.map((r) => {
    const coords = coordsOf(r);
    if (r.id === editingId) {
      const others = routes.filter((o) => o.id !== r.id && coordsOf(o).length > 1);
      return `
      <li data-id="${r.id}" style="--c:${r.color}" class="editing">
        <input class="name-input" data-act="rename" value="${escapeHtml(r.name)}" aria-label="Naam van de route" />
        <div class="stats">${coords.length > 1 ? statsHtml(coords) : ''}</div>
        <div class="row wrap">
          <button class="small primary" data-act="done" title="Klaar met bewerken (Esc)">✔ Klaar</button>
          <button class="small" data-act="undo" title="Ongedaan maken (Ctrl+Z)">↶ Ongedaan</button>
          <button class="small" data-act="reverse" ${waypoints.length < 2 ? 'disabled' : ''}>⇄ Omkeren</button>
          <button class="small${cutting ? ' active' : ''}" data-act="cut" ${coords.length < 3 ? 'disabled' : ''}>${cutting ? '✂ Annuleer' : '✂ Knippen'}</button>
          <select class="small" data-act="join" ${others.length ? '' : 'disabled'} title="Voeg een andere route achteraan toe">
            <option value="">➕ Route toevoegen…</option>
            ${others.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}
          </select>
          <button class="small" data-act="download" ${coords.length < 2 ? 'disabled' : ''} title="Download als GPX">⬇ GPX</button>
          <button class="small" data-act="remove" title="Route verwijderen">🗑</button>
        </div>
        <p class="hint">${cutting
          ? 'Klik op de route waar je wilt knippen.'
          : 'Klik op de kaart om punten toe te voegen. Sleep een punt om het te verplaatsen, sleep de lijn om een tussenpunt toe te voegen, rechtsklik of dubbelklik op een punt om het te verwijderen.'}</p>
      </li>`;
    }
    return `
      <li data-id="${r.id}" style="--c:${r.color}" class="${r.id === selectedId ? 'selected' : ''}${r.visible ? '' : ' dimmed'}">
        <div class="name" data-act="select" title="Toon op de kaart">${escapeHtml(r.name)}</div>
        <div class="meta">${metaText(coords)}</div>
        <div class="row wrap">
          <button class="small" data-act="edit">✏️ Bewerken</button>
          <button class="small" data-act="toggle">${r.visible ? '🙈 Verberg' : '👁 Toon'}</button>
          <button class="small" data-act="download" ${coords.length < 2 ? 'disabled' : ''} title="Download als GPX">⬇ GPX</button>
          <button class="small" data-act="remove" title="Route verwijderen">🗑</button>
        </div>
      </li>`;
  }).join('');
}

// Lighter update while editing: only the stats of the edited route (keeps focus in the name field).
function updateEditingInfo() {
  const li = $('routeList').querySelector('li.editing');
  if (!li) return renderRouteList();
  const coords = routeCoords();
  li.querySelector('.stats').innerHTML = coords.length > 1 ? statsHtml(coords) : '';
  const set = (act, disabled) => { const b = li.querySelector(`[data-act="${act}"]`); if (b) b.disabled = disabled; };
  set('reverse', waypoints.length < 2);
  set('cut', coords.length < 3);
  set('download', coords.length < 2);
}

function changed() {
  const r = editingRoute();
  if (r) { r.wps = waypoints; r.segs = segments; }
  renderRoute();
  renderViews();
  if (r) updateEditingInfo(); else renderRouteList();
  renderElevation();
  saveRoutes();
}

function fitRoute(r) {
  const coords = coordsOf(r);
  if (coords.length > 1) map.fitBounds(L.latLngBounds(coords.map((c) => [c[0], c[1]])), { padding: [30, 30] });
  else if (coords.length === 1) map.panTo([coords[0][0], coords[0][1]]);
  else if (r.wps.length) map.panTo(r.wps[0]);
}

function selectRoute(id, fit = true) {
  const r = routeById(id);
  if (!r) return;
  if (!r.visible) r.visible = true;
  selectedId = id;
  elevClosedFor = null;
  if (fit) fitRoute(r);
  renderViews();
  renderRouteList();
  renderElevation();
  saveRoutes();
}

function startEdit(id) {
  const r = routeById(id);
  if (!r || id === editingId) return;
  stopEdit();
  editingId = id;
  selectedId = id;
  elevClosedFor = null;
  r.visible = true;
  waypoints = r.wps;
  segments = r.segs;
  undoStack = [];
  $('map').classList.add('editing');
  map.doubleClickZoom.disable();
  renderRouteList();
  changed();
}

function stopEdit() {
  const r = editingRoute();
  if (!r) return;
  setCutting(false);
  hideGhost();
  r.wps = waypoints;
  r.segs = segments;
  editingId = null;
  waypoints = [];
  segments = [];
  undoStack = [];
  $('map').classList.remove('editing');
  map.doubleClickZoom.enable();
  // A route without any points is not worth keeping.
  if (!r.wps.length) {
    routes.splice(routes.indexOf(r), 1);
    if (selectedId === r.id) selectedId = null;
  }
  renderRoute();
  renderRouteList();
  changed();
}

function createRoute() {
  const r = newRoute();
  routes.unshift(r);
  startEdit(r.id);
  toast('Klik op de kaart om punten toe te voegen');
  return r;
}

function removeRoute(r) {
  if (coordsOf(r).length > 1 && !confirm(`Route "${r.name}" verwijderen?`)) return;
  if (r.id === editingId) {
    setCutting(false);
    editingId = null;
    waypoints = [];
    segments = [];
    undoStack = [];
    $('map').classList.remove('editing');
    map.doubleClickZoom.enable();
  }
  routes.splice(routes.indexOf(r), 1);
  if (selectedId === r.id) selectedId = null;
  renderRouteList();
  changed();
}

function downloadRoute(r) {
  const coords = coordsOf(r);
  if (coords.length < 2) return toast('Deze route heeft nog geen lijn');
  downloadGpx(r.name || 'route', [coords], r.wpts);
}

// ---------- Cutting the edited route in two ----------
const cutMarker = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#c4200f', fillOpacity: 1, interactive: false });

function setCutting(on) {
  cutting = on;
  $('map').classList.toggle('cutting', on);
  if (!on) map.removeLayer(cutMarker);
  else hideGhost();
  const li = $('routeList').querySelector('li.editing');
  if (li) renderRouteList();
}

function showCutMarker(segIndex, latlng) {
  cutMarker.setLatLng(nearestOnSegment(segIndex, latlng).latlng).addTo(map);
}

// g: point on the route from nearestOnSegment(). Cutting at (or right next to) a waypoint cuts there;
// elsewhere a new waypoint is made at the cut point, which ends the first part and starts the second.
function cutRoute(g) {
  const r = editingRoute();
  const pt = map.latLngToLayerPoint(g.latlng);
  const near = waypoints.findIndex((w) => map.latLngToLayerPoint(w).distanceTo(pt) < 8);
  let wpsA, segsA, wpsB, segsB;
  if (near >= 0) {
    if (near === 0 || near === waypoints.length - 1) return toast('Knip ergens tussen begin en einde van de route');
    wpsA = waypoints.slice(0, near + 1); segsA = segments.slice(0, near);
    wpsB = waypoints.slice(near); segsB = segments.slice(near);
  } else {
    const s = segments[g.seg];
    const wp = { lat: g.latlng.lat, lng: g.latlng.lng };
    const p = [wp.lat, wp.lng];
    wpsA = [...waypoints.slice(0, g.seg + 1), wp];
    segsA = [...segments.slice(0, g.seg), { a: waypoints[g.seg], b: wp, coords: [...s.coords.slice(0, g.k + 1), p], loading: false }];
    wpsB = [wp, ...waypoints.slice(g.seg + 1)];
    segsB = [{ a: wp, b: waypoints[g.seg + 1], coords: [p, ...s.coords.slice(g.k + 1)], loading: false }, ...segments.slice(g.seg + 1)];
  }
  // Named points go with the part they are nearest to.
  const cutIndex = joinSegs(segsA).length - 1;
  const all = routeCoords();
  const wptsA = [], wptsB = [];
  r.wpts.forEach((w) => {
    let best = 0, bd = Infinity;
    all.forEach((c, i) => { const d = haversine(c, w.p); if (d < bd) { bd = d; best = i; } });
    (best <= cutIndex ? wptsA : wptsB).push(w);
  });

  setCutting(false);
  const baseName = r.name;
  waypoints = wpsA; segments = segsA;
  r.name = `${baseName} (1)`;
  r.wpts = wptsA;
  const b = newRoute({ name: `${baseName} (2)`, wps: wpsB, segs: segsB, wpts: wptsB });
  routes.splice(routes.indexOf(r) + 1, 0, b);
  stopEdit();
  selectRoute(r.id, false);
  toast('Route geknipt in 2 delen');
}

// ---------- Joining another route onto the end of the edited one ----------
// The other route is reversed when its end is closer to our end than its start; the gap in between
// is routed (or bridged straight in straight-line mode). Undo brings the other route back.
function joinRoute(other) {
  if (!other || other.id === editingId) return;
  let wps = other.wps.map((w) => ({ ...w }));
  let segs = other.segs.map((s) => ({ coords: s.coords, loading: false }));
  const tail = waypoints.at(-1);
  if (tail && wps.length > 1) {
    const d = (w) => haversine([tail.lat, tail.lng], [w.lat, w.lng]);
    if (d(wps.at(-1)) < d(wps[0])) {
      wps = wps.reverse();
      segs = segs.reverse().map((s) => ({ coords: [...s.coords].reverse(), loading: false }));
    }
  }
  snapshot({ restoreRoute: other });
  const joined = buildSegs(wps, segs);
  if (tail) {
    const gap = haversine([tail.lat, tail.lng], [wps[0].lat, wps[0].lng]);
    if (gap < 1) wps.shift();
    else segments.push(newSeg(tail, wps[0]));
  }
  waypoints.push(...wps);
  segments.push(...joined);
  // Re-link segment endpoints to the actual waypoint objects.
  segments.forEach((s, i) => { s.a = waypoints[i]; s.b = waypoints[i + 1]; });
  const r = editingRoute();
  r.wpts = [...r.wpts, ...other.wpts];
  routes.splice(routes.indexOf(other), 1);
  if (selectedId === other.id) selectedId = editingId;
  renderRouteList();
  changed();
  toast(`"${other.name}" toegevoegd`);
}

// ---------- Route list events ----------
$('newRoute').addEventListener('click', createRoute);

$('routeList').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  const li = e.target.closest('li[data-id]');
  if (!el || !li || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const r = routeById(+li.dataset.id);
  if (!r) return;
  switch (el.dataset.act) {
    case 'select': selectRoute(r.id); break;
    case 'edit': startEdit(r.id); fitRoute(r); break;
    case 'done': stopEdit(); break;
    case 'toggle': r.visible = !r.visible; renderViews(); renderRouteList(); saveRoutes(); break;
    case 'download': downloadRoute(r); break;
    case 'remove': removeRoute(r); break;
    case 'undo': undo(); break;
    case 'reverse': reverseRoute(); break;
    case 'cut': setCutting(!cutting); if (cutting) toast('Klik op de route waar je wilt knippen (Esc om te annuleren)', 4000); break;
    default:
  }
});

$('routeList').addEventListener('change', (e) => {
  if (e.target.dataset.act === 'join' && e.target.value) joinRoute(routeById(+e.target.value));
});

$('routeList').addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'rename') return;
  const r = editingRoute();
  if (!r) return;
  r.name = e.target.value;
  renderElevation();
  saveRoutes();
});

map.on('click', (e) => {
  if (cutting) return;
  if (editingId) addWaypoint(e.latlng);
});

function undo() {
  if (!editingId) return;
  if (!undoStack.length) return toast('Niets om ongedaan te maken');
  restore(undoStack.pop());
  renderRouteList();
  changed();
}

function reverseRoute() {
  if (waypoints.length < 2) return;
  snapshot();
  waypoints.reverse();
  segments = segments.reverse().map((s) => ({ a: s.b, b: s.a, coords: [...s.coords].reverse(), loading: s.loading }));
  changed();
}

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !typing) {
    e.preventDefault();
    undo();
  }
  if (e.key === 'Escape' && !typing) {
    if (cutting) setCutting(false);
    else stopEdit();
  }
});

$('profile').addEventListener('change', () => {
  renderRouteList();
  if (waypoints.length > 1 && !$('straight').checked && confirm('Route opnieuw berekenen met dit profiel?')) {
    snapshot();
    segments = segments.map((s, i) => newSeg(waypoints[i], waypoints[i + 1]));
    changed();
  }
});

// lines: one or more track segments [[lat, lng, ele?], ...]; wpts: [{ p: [lat, lng, ele?], name }].
function downloadGpx(name, lines, wpts = []) {
  const pt = (tag, c, indent, inner = '') => `${indent}<${tag} lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}">${c[2] != null && !isNaN(c[2]) ? `<ele>${(+c[2]).toFixed(1)}</ele>` : ''}${inner}</${tag}>`;
  const wptXml = wpts.map((w) => pt('wpt', w.p, '  ', w.name ? `<name>${escapeXml(w.name)}</name>` : '') + '\n').join('');
  const segs = lines.map((l) => `    <trkseg>\n${l.map((c) => pt('trkpt', c, '      ')).join('\n')}\n    </trkseg>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Fietsplanner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name></metadata>
${wptXml}  <trk>
    <name>${escapeXml(name)}</name>
${segs}
  </trk>
</gpx>
`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = name.replace(/[^\w\- ]+/g, '_') + '.gpx';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- GPX import ----------
function parseGpx(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Ongeldig GPX-bestand');
  const byTag = (el, tag) => Array.from(el.getElementsByTagNameNS('*', tag));
  const pt = (el) => {
    const ele = byTag(el, 'ele')[0];
    const p = [parseFloat(el.getAttribute('lat')), parseFloat(el.getAttribute('lon'))];
    if (ele) p.push(parseFloat(ele.textContent));
    return p;
  };

  const lines = [];
  byTag(doc, 'trkseg').forEach((seg) => lines.push(byTag(seg, 'trkpt').map(pt)));
  byTag(doc, 'rte').forEach((rte) => lines.push(byTag(rte, 'rtept').map(pt)));
  const wpts = byTag(doc, 'wpt').map((w) => ({ p: pt(w), name: byTag(w, 'name')[0]?.textContent || '' }));

  const nameEl = byTag(doc, 'trk').concat(byTag(doc, 'rte'), byTag(doc, 'metadata'))
    .map((el) => Array.from(el.children).find((c) => c.localName === 'name'))
    .find(Boolean);

  const valid = lines.filter((l) => l.length > 1);
  if (!valid.length) throw new Error('Geen track of route gevonden');
  return { name: nameEl?.textContent.trim() || fileName.replace(/\.gpx$/i, ''), lines: valid, wpts };
}

// An imported track keeps its exact geometry; waypoints are placed at regular intervals along it so
// parts of it can be re-routed by dragging them in edit mode.
function routeFromTrack({ name, lines, wpts }) {
  const coords = lines.flat();
  const dist = computeStats(coords).dist;
  const step = Math.min(5000, Math.max(300, dist / 25));
  const idx = [0];
  let acc = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc >= step) { idx.push(i); acc = 0; }
  }
  idx.push(coords.length - 1);
  const wps = idx.map((i) => ({ lat: coords[i][0], lng: coords[i][1] }));
  const segs = idx.slice(0, -1).map((start, k) => ({
    a: wps[k], b: wps[k + 1], coords: coords.slice(start, idx[k + 1] + 1), loading: false,
  }));
  return newRoute({ name, wps, segs, wpts });
}

async function loadFiles(files) {
  let last = null;
  for (const file of files) {
    try {
      last = routeFromTrack(parseGpx(await file.text(), file.name));
      routes.unshift(last);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 5000);
    }
  }
  if (last) {
    toast(files.length > 1 ? 'GPX-bestanden geïmporteerd' : `"${last.name}" geïmporteerd – klik ✏️ Bewerken om aan te passen`, 4000);
    selectRoute(last.id);
  }
}

$('gpxInput').addEventListener('change', (e) => { loadFiles(Array.from(e.target.files)); e.target.value = ''; });

let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = Array.from(e.dataTransfer.files).filter((f) => /\.gpx$/i.test(f.name));
  if (files.length) loadFiles(files); else toast('Sleep een .gpx-bestand');
});

// ---------- Elevation profile ----------
// Shows the profile of the selected route; closing it hides it until another route is selected.
let elevClosedFor = null;
let elevData = null;
const hoverMarker = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#e2621b', fillOpacity: 1 });

$('elevClose').addEventListener('click', () => { elevClosedFor = selectedId; renderElevation(); });

function renderElevation() {
  const panel = $('elevation');
  const r = routeById(selectedId);
  const coords = r && elevClosedFor !== r.id ? coordsOf(r) : null;
  const title = r?.name || 'Route';

  if (!coords || coords.length < 2 || !coords.some((c) => c[2] != null && !isNaN(c[2]))) {
    panel.classList.add('hidden');
    elevData = null;
    map.removeLayer(hoverMarker);
    return;
  }
  panel.classList.remove('hidden');
  $('elevTitle').textContent = `Hoogteprofiel – ${title}`;

  const dist = [0];
  for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
  let lastEle = coords.find((c) => c[2] != null && !isNaN(c[2]))[2];
  const ele = coords.map((c) => (c[2] != null && !isNaN(c[2]) ? (lastEle = c[2]) : lastEle));
  elevData = { coords, dist, ele };
  drawElevation();
}

function drawElevation(hoverIdx = null) {
  if (!elevData) return;
  const canvas = $('elevCanvas');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const { dist, ele } = elevData;
  const pad = { l: 44, r: 12, t: 8, b: 20 };
  const total = dist[dist.length - 1] || 1;
  let min = Math.min(...ele), max = Math.max(...ele);
  if (max - min < 20) { const mid = (max + min) / 2; min = mid - 10; max = mid + 10; }
  const x = (d) => pad.l + (d / total) * (w - pad.l - pad.r);
  const y = (e) => pad.t + (1 - (e - min) / (max - min)) * (h - pad.t - pad.b);

  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#777';
  ctx.strokeStyle = '#e5e5e0';
  for (let k = 0; k <= 3; k++) {
    const e = min + ((max - min) * k) / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, y(e)); ctx.lineTo(w - pad.r, y(e)); ctx.stroke();
    ctx.fillText(`${Math.round(e)} m`, 4, y(e) + 4);
  }
  const kmStep = [1, 2, 5, 10, 20, 50, 100].find((s) => total / 1000 / s <= 10) || 200;
  for (let km = 0; km * 1000 <= total; km += kmStep) ctx.fillText(`${km} km`, x(km * 1000) - 8, h - 5);

  ctx.beginPath();
  ctx.moveTo(x(0), y(min));
  ele.forEach((e, i) => ctx.lineTo(x(dist[i]), y(e)));
  ctx.lineTo(x(total), y(min));
  ctx.closePath();
  ctx.fillStyle = 'rgba(90,158,47,.35)';
  ctx.fill();
  ctx.beginPath();
  ele.forEach((e, i) => ctx.lineTo(x(dist[i]), y(e)));
  ctx.strokeStyle = '#4a8a24';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (hoverIdx != null) {
    const hx = x(dist[hoverIdx]);
    ctx.strokeStyle = '#e2621b';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
    const label = `${(dist[hoverIdx] / 1000).toFixed(2)} km · ${Math.round(ele[hoverIdx])} m`;
    ctx.fillStyle = '#222';
    ctx.fillText(label, Math.min(hx + 6, w - ctx.measureText(label).width - 4), pad.t + 12);
  }
}

$('elevCanvas').addEventListener('mousemove', (e) => {
  if (!elevData) return;
  const rect = e.target.getBoundingClientRect();
  const { dist, coords } = elevData;
  const total = dist[dist.length - 1];
  const d = ((e.clientX - rect.left - 44) / (rect.width - 56)) * total;
  let lo = 0, hi = dist.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (dist[mid] < d) lo = mid + 1; else hi = mid; }
  drawElevation(lo);
  hoverMarker.setLatLng([coords[lo][0], coords[lo][1]]).addTo(map);
});
$('elevCanvas').addEventListener('mouseleave', () => { drawElevation(); map.removeLayer(hoverMarker); });
window.addEventListener('resize', () => drawElevation());

// ---------- Restore saved routes ----------
try {
  const saved = JSON.parse(localStorage.getItem('routes') || 'null');
  if (saved) {
    saved.routes.forEach((d) => routes.push(deserializeRoute(d)));
    selectedId = routeById(saved.selectedId) ? saved.selectedId : null;
  } else {
    // Migrate the single route stored by earlier versions.
    const old = JSON.parse(localStorage.getItem('route') || 'null');
    if (old && old.wps?.length) routes.push(deserializeRoute({ id: 1, name: old.name || 'Mijn route', color: TRACK_COLORS[0], visible: true, wps: old.wps, segs: old.segs }));
    localStorage.removeItem('route');
  }
  if (saved?.editingId && routeById(saved.editingId)) startEdit(saved.editingId);
  else changed();
  const focus = routeById(editingId || selectedId);
  if (focus) fitRoute(focus);
} catch (e) {
  console.warn('Opgeslagen routes konden niet geladen worden', e);
  changed();
}
