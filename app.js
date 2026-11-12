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

// ---------- Route state ----------
// Waypoints [{lat,lng}]; segments[i] connects waypoints[i] -> waypoints[i+1] with coords [[lat,lng,ele?]].
let waypoints = [];
let segments = [];
const undoStack = [];
let drawing = false;
let dragging = false;

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

function snapshot() {
  undoStack.push(JSON.stringify({
    wps: waypoints,
    segs: segments.map((s) => ({ coords: s.coords, loading: s.loading })),
  }));
  if (undoStack.length > 100) undoStack.shift();
}

function restore(json) {
  const snap = JSON.parse(json);
  waypoints = snap.wps;
  segments = snap.segs.map((s, i) => s.loading
    ? newSeg(waypoints[i], waypoints[i + 1])
    : { a: waypoints[i], b: waypoints[i + 1], coords: s.coords, loading: false });
}

function addWaypoint(latlng) {
  snapshot();
  const wp = { lat: latlng.lat, lng: latlng.lng };
  if (waypoints.length) segments.push(newSeg(waypoints[waypoints.length - 1], wp));
  waypoints.push(wp);
  profileSource = 'route';
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

function routeCoords() {
  const out = [];
  segments.forEach((s, i) => out.push(...(i === 0 ? s.coords : s.coords.slice(1))));
  return out;
}

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
  // Wide invisible lines on top make the route easy to hit for inserting points.
  segments.forEach((s, i) => {
    const hit = L.polyline(s.coords, { weight: 20, opacity: 0, bubblingMouseEvents: false }).addTo(routeLayer);
    hit.on('mousemove', (e) => showGhost(i, e.latlng));
    hit.on('click', (e) => {
      const g = nearestOnSegment(i, e.latlng);
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
  if (ghostDragging || dragging || segments[segIndex].loading) return;
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

function renderStats() {
  const coords = routeCoords();
  if (coords.length < 2) { $('stats').innerHTML = ''; return; }
  const s = computeStats(coords, SPEEDS[$('profile').value]);
  $('stats').innerHTML = `
    <div><b>${fmtKm(s.dist)}</b><span>afstand</span></div>
    <div><b>${fmtTime(s.hours)}</b><span>duur</span></div>
    <div><b>↗ ${Math.round(s.up)} m</b><span>↘ ${Math.round(s.down)} m</span></div>`;
}

function saveRoute() {
  try {
    localStorage.setItem('route', JSON.stringify({
      name: $('routeName').value,
      wps: waypoints,
      segs: segments.map((s) => ({ coords: s.coords, loading: s.loading })),
    }));
  } catch (e) { console.warn('Route niet opgeslagen', e); }
}

function changed() {
  renderRoute();
  renderStats();
  renderElevation();
  saveRoute();
}

// ---------- Route UI ----------
function setDrawing(on) {
  drawing = on;
  $('drawToggle').classList.toggle('active', on);
  $('drawToggle').textContent = on ? '✋ Stop met tekenen' : '✏️ Route tekenen';
  $('map').classList.toggle('drawing', on);
  on ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable();
}

$('drawToggle').addEventListener('click', () => setDrawing(!drawing));
map.on('click', (e) => { if (drawing) addWaypoint(e.latlng); });

$('undo').addEventListener('click', undo);
function undo() {
  if (!undoStack.length) return toast('Niets om ongedaan te maken');
  restore(undoStack.pop());
  changed();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    undo();
  }
  if (e.key === 'Escape') setDrawing(false);
});

$('reverse').addEventListener('click', () => {
  if (waypoints.length < 2) return;
  snapshot();
  waypoints.reverse();
  segments = segments.reverse().map((s) => ({ a: s.b, b: s.a, coords: [...s.coords].reverse(), loading: s.loading }));
  changed();
});

$('clear').addEventListener('click', () => {
  if (!waypoints.length) return;
  snapshot();
  waypoints = [];
  segments = [];
  changed();
});

$('profile').addEventListener('change', () => {
  renderStats();
  if (waypoints.length > 1 && !$('straight').checked && confirm('Hele route opnieuw berekenen met dit profiel?')) {
    snapshot();
    segments = segments.map((s, i) => newSeg(waypoints[i], waypoints[i + 1]));
    changed();
  }
});

$('routeName').addEventListener('input', saveRoute);

$('export').addEventListener('click', () => {
  const coords = routeCoords();
  if (coords.length < 2) return toast('Teken eerst een route');
  downloadGpx($('routeName').value || 'route', coords);
});

function downloadGpx(name, coords) {
  const pts = coords.map((c) => `      <trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}">${c[2] != null ? `<ele>${(+c[2]).toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Fietsplanner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
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
const tracks = [];
let trackSeq = 0;

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
  if (!valid.length && !wpts.length) throw new Error('Geen track of punten gevonden');
  return { name: nameEl?.textContent.trim() || fileName.replace(/\.gpx$/i, ''), lines: valid, wpts };
}

function addTrack(data) {
  const color = TRACK_COLORS[trackSeq % TRACK_COLORS.length];
  const t = { id: ++trackSeq, color, visible: true, ...data };
  t.layer = L.featureGroup();
  t.lines.forEach((l) => L.polyline(l, { color, weight: 4, opacity: 0.85 })
    .on('click', () => selectTrack(t.id)).addTo(t.layer));
  t.wpts.forEach((w) => L.circleMarker(w.p, { radius: 5, color, fillOpacity: 1 })
    .bindTooltip(escapeHtml(w.name || 'Punt')).addTo(t.layer));
  t.layer.addTo(map);
  t.coords = t.lines.flat();
  t.stats = computeStats(t.coords);
  tracks.push(t);
  renderTrackList();
  return t;
}

async function loadFiles(files) {
  let last = null;
  for (const file of files) {
    try {
      last = addTrack(parseGpx(await file.text(), file.name));
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 5000);
    }
  }
  if (last) selectTrack(last.id);
}

function renderTrackList() {
  $('trackList').innerHTML = tracks.map((t) => `
    <li data-id="${t.id}" style="--c:${t.color}" class="${profileSource === t.id ? 'selected' : ''}">
      <div class="name" data-act="select">${escapeHtml(t.name)}</div>
      <div class="meta">${fmtKm(t.stats.dist)} · ↗ ${Math.round(t.stats.up)} m · ↘ ${Math.round(t.stats.down)} m</div>
      <div class="row wrap">
        <button class="small" data-act="toggle">${t.visible ? '🙈 Verberg' : '👁 Toon'}</button>
        <button class="small" data-act="edit" ${t.coords.length < 2 ? 'disabled' : ''}>✏️ Bewerk als route</button>
        <button class="small" data-act="remove">🗑</button>
      </div>
    </li>`).join('');
}

$('trackList').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const li = e.target.closest('li');
  if (!act || !li) return;
  const t = tracks.find((x) => x.id === +li.dataset.id);
  if (act === 'select') selectTrack(t.id);
  if (act === 'toggle') {
    t.visible = !t.visible;
    t.visible ? t.layer.addTo(map) : map.removeLayer(t.layer);
    renderTrackList();
  }
  if (act === 'remove') {
    map.removeLayer(t.layer);
    tracks.splice(tracks.indexOf(t), 1);
    if (profileSource === t.id) profileSource = 'route';
    renderTrackList();
    renderElevation();
  }
  if (act === 'edit') trackToRoute(t);
});

function selectTrack(id) {
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  if (!t.visible) { t.visible = true; t.layer.addTo(map); }
  map.fitBounds(t.layer.getBounds(), { padding: [30, 30] });
  profileSource = id;
  renderTrackList();
  renderElevation();
}

// Turns an imported track into an editable route: keeps the original geometry but places
// draggable waypoints at regular intervals so parts of it can be re-routed.
function trackToRoute(t) {
  const coords = t.coords;
  const step = Math.min(5000, Math.max(300, t.stats.dist / 25));
  const idx = [0];
  let acc = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc >= step) { idx.push(i); acc = 0; }
  }
  idx.push(coords.length - 1);

  snapshot();
  waypoints = idx.map((i) => ({ lat: coords[i][0], lng: coords[i][1] }));
  segments = idx.slice(0, -1).map((start, k) => ({
    a: waypoints[k], b: waypoints[k + 1], coords: coords.slice(start, idx[k + 1] + 1), loading: false,
  }));
  $('routeName').value = t.name;
  t.visible = false;
  map.removeLayer(t.layer);
  profileSource = 'route';
  renderTrackList();
  changed();
  map.fitBounds(L.latLngBounds(coords.map((c) => [c[0], c[1]])), { padding: [30, 30] });
  toast('Track omgezet naar bewerkbare route');
}

$('gpxInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });

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
let profileSource = 'route';
let elevData = null;
const hoverMarker = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#e2621b', fillOpacity: 1 });

$('elevClose').addEventListener('click', () => { profileSource = null; renderElevation(); renderTrackList(); });

function renderElevation() {
  const panel = $('elevation');
  let coords, title;
  if (profileSource === 'route') { coords = routeCoords(); title = $('routeName').value || 'Route'; }
  else { const t = tracks.find((x) => x.id === profileSource); coords = t?.coords; title = t?.name; }

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

// ---------- Restore saved route ----------
try {
  const saved = JSON.parse(localStorage.getItem('route') || 'null');
  if (saved && saved.wps?.length) {
    $('routeName').value = saved.name || 'Mijn route';
    restore(JSON.stringify(saved));
    changed();
    if (waypoints.length > 1) map.fitBounds(L.latLngBounds(routeCoords().map((c) => [c[0], c[1]])), { padding: [30, 30] });
  }
} catch (e) { console.warn('Opgeslagen route kon niet geladen worden', e); }
