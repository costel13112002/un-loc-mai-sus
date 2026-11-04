'use strict';

// Foot routing from FOSSGIS: its usage policy allows one request per second at most.
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';
const MIN_REQUEST_GAP_MS = 1100;
const MAX_REQUESTS = 24;
const MAX_ROUTES = 3;
const MAX_REPEATED_SHARE = 0.25;
const MIN_WALK_KM = 0.6;
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const STORE_KEY = 'un-loc-mai-sus.v1';
const SHARED_CACHE = 'un-loc-shared';
const ROUTE_COLORS = ['#d6186e', '#2647d8', '#d95f00'];
const DEFAULTS = {
  me: null, next: null, reserve: null, stepsPerKm: 1300, maxKm: 10,
  updatedAt: null, myKey: '', history: [],
};

const $ = (id) => document.getElementById(id);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

let state = loadState();
let map, startMarker;
let start = null;
let routes = [];
let selected = 0;
let generation = null;
let lastRequestAt = 0;
let lastRows = [];
let installPrompt = null;
let following = null;

/* Saved values */

function loadState() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // The page keeps working for this visit without saved values.
  }
}

/* Numbers and wording */

const steps = (n) => Math.round(n).toLocaleString('ro-RO', { useGrouping: true, minimumFractionDigits: 0 });
const kilometres = (m) => (m / 1000).toLocaleString('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function whenRead(time) {
  if (!time) return '';
  const date = new Date(time);
  const clock = date.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(time).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `azi, ${clock}`;
  if (days === 1) return `ieri, ${clock}`;
  return date.toLocaleDateString('ro-RO', { day: 'numeric', month: 'long' }) + `, ${clock}`;
}

function digits(text) {
  const clean = String(text).replace(/\D/g, '');
  return clean ? Number(clean) : null;
}

/* How many steps it takes to pass the next person */

function dailyRateOfNext() {
  const list = state.history;
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  for (let i = list.length - 2; i >= 0; i--) {
    const days = (last.t - list[i].t) / 864e5;
    if (days < 0.25) continue;
    const rate = (last.next - list[i].next) / days;
    // A jump this large means the row above is now somebody else.
    return rate > 0 && rate <= 40000 ? rate : null;
  }
  return null;
}

function reserveSteps() {
  if (state.reserve != null) return state.reserve;
  return Math.max(1000, Math.ceil((dailyRateOfNext() || 0) / 100) * 100);
}

function plan() {
  if (state.me == null || state.next == null) return null;
  const gap = state.next - state.me;
  if (gap < 0) return { passed: true };
  const reserve = reserveSteps();
  const needed = gap + reserve + 1;
  const km = needed / state.stepsPerKm;
  const walks = Math.max(1, Math.ceil(km / state.maxKm));
  return { gap, reserve, needed, km, walks, walkMetres: Math.max(km / walks, MIN_WALK_KM) * 1000 };
}

/* Loop generation */

function offset(point, bearing, metres) {
  const R = 6371000, toRad = Math.PI / 180;
  const a = metres / R, b = bearing * toRad, f = point.lat * toRad, l = point.lon * toRad;
  const f2 = Math.asin(Math.sin(f) * Math.cos(a) + Math.cos(f) * Math.sin(a) * Math.cos(b));
  const l2 = l + Math.atan2(Math.sin(b) * Math.sin(a) * Math.cos(f), Math.cos(a) - Math.sin(f) * Math.sin(f2));
  return { lat: f2 / toRad, lon: l2 / toRad };
}

// Three points on a circle that passes through the start, so the walk comes back around.
function circlePoints(origin, bearing, radius) {
  const centre = offset(origin, bearing, radius);
  return [90, 180, 270].map((turn) => offset(centre, bearing + 180 + turn, radius));
}

async function requestRoute(points, signal) {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt = Date.now();
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${ROUTER}${coords}?overview=full&geometries=geojson&continue_straight=true`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Router HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 'Ok' || !body.routes?.length) throw new Error(`Router ${body.code}`);
  return body;
}

function segmentsOf(coords) {
  const counts = new Map();
  const cell = (c) => `${c[0].toFixed(4)},${c[1].toFixed(4)}`;
  for (let i = 1; i < coords.length; i++) {
    const a = cell(coords[i - 1]), b = cell(coords[i]);
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function repeatedShare(segments) {
  let repeated = 0, total = 0;
  for (const count of segments.values()) {
    total += count;
    if (count > 1) repeated += count;
  }
  return total ? repeated / total : 0;
}

function overlap(a, b) {
  let shared = 0;
  for (const key of a.keys()) if (b.has(key)) shared++;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

const longEnough = (distance, target) => distance >= target && distance <= Math.max(target * 1.12, target + 300);
const missBy = (distance, target) => (distance >= target ? distance - target : (target - distance) * 3);

async function buildLoop(origin, target, bearing, budget, signal) {
  let radius = target / (2 * Math.PI * 1.3);
  let best = null;
  for (let attempt = 0; attempt < 4 && budget.left > 0; attempt++) {
    budget.left--;
    const body = await requestRoute([origin, ...circlePoints(origin, bearing, radius), origin], signal);
    const route = body.routes[0];
    const segments = segmentsOf(route.geometry.coordinates);
    const loop = {
      distance: route.distance,
      seconds: route.duration,
      coords: route.geometry.coordinates,
      stops: body.waypoints.slice(1, -1).map((w) => w.location),
      segments,
      repeated: repeatedShare(segments),
    };
    if (!best || missBy(loop.distance, target) < missBy(best.distance, target)) best = loop;
    if (longEnough(loop.distance, target)) break;
    radius = Math.max(60, radius * (target * 1.05) / loop.distance);
  }
  return best;
}

async function generateRoutes() {
  const goal = plan();
  if (!goal || goal.passed || !start) return;
  generation?.abort();
  const control = new AbortController();
  generation = control;
  clearRoutes();
  const target = goal.walkMetres;
  const budget = { left: MAX_REQUESTS };
  const spare = [];
  const firstBearing = Math.random() * 360;
  setStatus('Caut trasee…');
  try {
    for (let i = 0; i < 8 && routes.length < MAX_ROUTES && budget.left > 0; i++) {
      const loop = await buildLoop(start, target, (firstBearing + i * 137.5) % 360, budget, control.signal);
      if (!loop) continue;
      const duplicate = [...routes, ...spare].some((other) => overlap(other.segments, loop.segments) > 0.55);
      if (duplicate) continue;
      if (longEnough(loop.distance, target) && loop.repeated <= MAX_REPEATED_SHARE) {
        addRoute(loop, target);
        if (routes.length < MAX_ROUTES) setStatus(`Caut trasee… ${routes.length} din ${MAX_ROUTES}`);
      } else {
        spare.push(loop);
      }
    }
    const quality = (loop) => loop.repeated + missBy(loop.distance, target) / target;
    spare.sort((a, b) => quality(a) - quality(b));
    for (const loop of spare) {
      if (routes.length >= MAX_ROUTES) break;
      if (loop.distance >= target) addRoute(loop, target);
    }
    if (!routes.length && spare.length) addRoute(spare[0], target);
    setStatus(routes.length ? '' : 'Nu am găsit trasee de aici. Ține apăsat pe hartă și alege alt loc de plecare.', !routes.length);
  } catch (error) {
    if (error.name === 'AbortError') return;
    setStatus('Serverul de trasee nu a răspuns. Apasă Alte trasee ca să încerc din nou.', true);
  }
}

/* Map */

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([45.9, 25.0], 6);
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Rutare <a href="https://routing.openstreetmap.de/about.html">FOSSGIS</a> · <a href="https://www.openstreetmap.org/fixthemap">Corectează harta</a>',
  }).addTo(map);
  map.on('click', (event) => {
    if (!start) setStart({ lat: event.latlng.lat, lon: event.latlng.lng });
  });
  map.on('contextmenu', (event) => setStart({ lat: event.latlng.lat, lon: event.latlng.lng }));
}

function setStart(point) {
  start = point;
  if (startMarker) startMarker.remove();
  startMarker = L.circleMarker([point.lat, point.lon], {
    radius: 8, color: '#ffffff', weight: 3, fillColor: '#0e6a55', fillOpacity: 1,
  }).addTo(map);
  if (map.getZoom() < 13) map.setView([point.lat, point.lon], 15);
  generateRoutes();
}

function clearRoutes() {
  stopFollowing();
  routes.forEach((route) => route.line.remove());
  routes = [];
  selected = 0;
  $('routes').replaceChildren();
  $('routeActions').hidden = true;
}

function addRoute(loop, target) {
  const index = routes.length;
  const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
  const line = L.polyline(loop.coords.map((c) => [c[1], c[0]]), { color, weight: 4, opacity: 0.6 }).addTo(map);
  line.on('click', (event) => {
    L.DomEvent.stop(event);
    selectRoute(index);
  });
  const route = { ...loop, line, color };
  routes.push(route);

  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = color;
  const length = document.createElement('strong');
  length.textContent = `${kilometres(loop.distance)} km`;
  const info = document.createElement('span');
  info.textContent = `≈ ${steps(loop.distance / 1000 * state.stepsPerKm)} pași · ${duration(loop.seconds)}`;
  const main = document.createElement('span');
  main.className = 'route-main';
  main.append(length, info);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'route';
  button.append(swatch, main);
  const note = routeNote(loop, target);
  if (note) {
    const noteEl = document.createElement('span');
    noteEl.className = 'route-note';
    noteEl.textContent = note;
    button.append(noteEl);
  }
  button.addEventListener('click', () => selectRoute(index));
  const item = document.createElement('li');
  item.append(button);
  $('routes').append(item);
  selectRoute(index === 0 ? 0 : selected);
}

function routeNote(loop, target) {
  if (loop.distance < target) return `Cu ${kilometres(target - loop.distance)} km prea scurt: mai mergi puțin la final.`;
  if (loop.distance > target * 1.35) return 'Mai lung decât e nevoie, dar e cel mai scurt găsit în această direcție.';
  if (loop.repeated > MAX_REPEATED_SHARE) return 'O parte din drum se face dus-întors.';
  return '';
}

function selectRoute(index) {
  const fit = index !== selected || $('routeActions').hidden;
  if (index !== selected) stopFollowing();
  selected = index;
  routes.forEach((route, i) => {
    const active = i === index;
    route.line.setStyle({ weight: active ? 6 : 4, opacity: active ? 0.95 : 0.45 });
    if (active) route.line.bringToFront();
  });
  [...$('routes').querySelectorAll('.route')].forEach((button, i) => {
    button.setAttribute('aria-pressed', String(i === index));
  });
  const route = routes[index];
  if (!route) return;
  $('openMaps').href = mapsLink(route);
  const goal = plan();
  const minimum = goal && !goal.passed ? ` Ai nevoie de cel puțin ${kilometres(goal.walkMetres)} km.` : '';
  $('routeHint').textContent = `Google Maps își alege singur străzile, deci drumul lui poate ieși mai scurt sau mai lung.${minimum} Fișierul GPX se deschide cu Garmin Connect.`;
  $('routeActions').hidden = false;
  if (fit) map.fitBounds(route.line.getBounds(), { padding: [24, 24] });
}

/* Following a route on this map, which keeps the exact length that was calculated */

function metresBetween(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad, dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function densify(coords, spacing) {
  const path = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const parts = Math.max(1, Math.ceil(metresBetween(coords[i - 1], coords[i]) / spacing));
    for (let part = 1; part <= parts; part++) {
      path.push([
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * (part / parts),
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * (part / parts),
      ]);
    }
  }
  return path;
}

function startFollowing() {
  const route = routes[selected];
  if (!route || !navigator.geolocation) return;
  const path = densify(route.coords, 20);
  const along = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + metresBetween(path[i - 1], path[i]));
  following = { path, along, progress: 0, marker: null, wakeLock: null, watchId: null };
  following.watchId = navigator.geolocation.watchPosition(onFollowPosition, onFollowError, {
    enableHighAccuracy: true, maximumAge: 3000, timeout: 20000,
  });
  keepScreenOn();
  $('follow').textContent = 'Oprește urmărirea';
  setStatus('Caut locul în care ești…');
}

function stopFollowing() {
  if (!following) return;
  navigator.geolocation.clearWatch(following.watchId);
  following.marker?.remove();
  following.wakeLock?.release().catch(() => {});
  following = null;
  $('follow').textContent = 'Pornește pe traseu';
  setStatus('');
}

function onFollowPosition(position) {
  if (!following) return;
  const { path, along } = following;
  const here = [position.coords.longitude, position.coords.latitude];
  // Only look ahead, so the end of a loop is not mistaken for its start.
  const reach = along[following.progress] + 400;
  let nearest = following.progress, nearestMetres = Infinity;
  for (let i = following.progress; i < path.length && along[i] <= reach; i++) {
    const metres = metresBetween(here, path[i]);
    if (metres < nearestMetres) {
      nearestMetres = metres;
      nearest = i;
    }
  }
  const onRoute = nearestMetres <= 60;
  if (onRoute) following.progress = nearest;
  const left = along[along.length - 1] - along[following.progress];

  const latLng = [here[1], here[0]];
  if (following.marker) {
    following.marker.setLatLng(latLng);
    map.panTo(latLng);
  } else {
    following.marker = L.circleMarker(latLng, {
      radius: 9, color: '#ffffff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(map);
    map.setView(latLng, Math.max(map.getZoom(), 16));
  }
  if (left < 30) setStatus('Ai terminat traseul. Sincronizează ceasul, apoi fă o captură nouă din clasament.');
  else if (onRoute) setStatus(`Mai ai ${kilometres(left)} km din traseu.`);
  else setStatus(`Ești la ${Math.round(nearestMetres)} m de traseu. Mai ai ${kilometres(left)} km.`, true);
}

function onFollowError(error) {
  if (!following) return;
  if (error.code === 1) {
    stopFollowing();
    setStatus('Nu am primit locația. Permite accesul la locație ca să urmăresc traseul.', true);
  } else {
    setStatus('Semnalul GPS este slab. Încerc în continuare.', true);
  }
}

async function keepScreenOn() {
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (following) following.wakeLock = lock;
    else lock.release();
  } catch {
    // Following still works; the phone may just turn its screen off.
  }
}

function mapsLink(route) {
  const origin = `${start.lat.toFixed(6)},${start.lon.toFixed(6)}`;
  const stops = route.stops.map((c) => `${c[1].toFixed(6)},${c[0].toFixed(6)}`).join('|');
  const params = new URLSearchParams({ api: '1', origin, destination: origin, waypoints: stops, travelmode: 'walking' });
  return `https://www.google.com/maps/dir/?${params}`;
}

function gpxText(route) {
  const points = route.coords
    .map((c) => `<trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"></trkpt>`)
    .join('');
  const name = `Un loc mai sus ${kilometres(route.distance)} km`;
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="Un loc mai sus" xmlns="http://www.topografix.com/GPX/1/1">'
    + `<metadata><name>${name}</name></metadata><trk><name>${name}</name><trkseg>${points}</trkseg></trk></gpx>\n`;
}

function downloadGpx() {
  const route = routes[selected];
  if (!route) return;
  const url = URL.createObjectURL(new Blob([gpxText(route)], { type: 'application/gpx+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `un-loc-mai-sus-${kilometres(route.distance).replace(',', '-')}km.gpx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* Location */

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('No geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 },
    );
  });
}

async function useMyLocation() {
  setStatus('Caut locul în care ești…');
  try {
    setStart(await locate());
  } catch {
    setStatus('Nu am primit locația. Permite accesul la locație sau apasă pe hartă de unde vrei să pleci.', true);
  }
}

async function locationAllowed() {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted';
  } catch {
    return false;
  }
}

/* Reading the leaderboard from a screenshot, entirely on the phone */

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TESSERACT;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

async function prepareShot(file) {
  const bitmap = await createImageBitmap(file);
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 32;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  probeCtx.drawImage(bitmap, 0, 0, 32, 32);
  const pixels = probeCtx.getImageData(0, 0, 32, 32).data;
  let light = 0;
  for (let i = 0; i < pixels.length; i += 4) light += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  const dark = light / (pixels.length / 4) < 110;

  const scale = Math.min(2, 2000 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.filter = `grayscale(1) contrast(1.25)${dark ? ' invert(1)' : ''}`;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function readText(file) {
  await loadTesseract();
  const canvas = await prepareShot(file);
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (event) => {
      if (event.status === 'recognizing text') setStatus(`Citesc captura… ${Math.round(event.progress * 100)}%`);
    },
  });
  try {
    // Treat the screenshot as one block, so a name and its total stay on the same line.
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

function nameKey(text) {
  return text.normalize('NFD').replace(/[^\p{L}]/gu, '').toLowerCase();
}

function parseRows(text) {
  const rows = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const numbers = [...line.matchAll(/\d{1,3}(?:[ .,'’]\d{3})+|\d{4,}/g)];
    if (!numbers.length) continue;
    const last = numbers[numbers.length - 1];
    const value = digits(last[0]);
    const label = line.slice(0, last.index).replace(/[^\p{L}\s.-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!rows.has(value) || label.length > rows.get(value).label.length) {
      rows.set(value, { value, label, key: nameKey(label) });
    }
  }
  return [...rows.values()].sort((a, b) => b.value - a.value);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (text) => {
    const list = [];
    for (let i = 0; i < text.length - 1; i++) list.push(text.slice(i, i + 2));
    return list;
  };
  const first = pairs(a), second = pairs(b);
  let common = 0;
  for (const pair of first) {
    const at = second.indexOf(pair);
    if (at >= 0) {
      common++;
      second.splice(at, 1);
    }
  }
  return first.length + pairs(b).length ? (2 * common) / (first.length + pairs(b).length) : 0;
}

function findMyRow(rows) {
  if (state.myKey) {
    let best = null, score = 0;
    for (const row of rows) {
      const value = similarity(state.myKey, row.key);
      if (value > score) {
        score = value;
        best = row;
      }
    }
    if (score >= 0.6) return best;
  }
  if (state.me != null) {
    const later = rows.filter((row) => row.value >= state.me && row.value <= state.me + 150000);
    if (later.length) return later[later.length - 1];
  }
  return null;
}

function applyMyRow(row) {
  const above = lastRows.filter((other) => other.value > row.value).pop();
  state.me = row.value;
  if (row.key) state.myKey = row.key;
  state.next = above ? above.value : null;
  state.updatedAt = Date.now();
  if (state.next != null) {
    state.history = [...state.history, { t: state.updatedAt, next: state.next }].slice(-14);
  }
  saveState();
  syncInputs();
  refresh();
}

function openPicker() {
  const list = $('pickRows');
  list.replaceChildren();
  for (const row of lastRows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick';
    const total = document.createElement('b');
    total.textContent = `${steps(row.value)} pași`;
    const name = document.createElement('span');
    name.textContent = row.label;
    button.append(total, name);
    button.addEventListener('click', () => {
      $('picker').close();
      applyMyRow(row);
    });
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
  $('picker').showModal();
}

async function handleShot(file) {
  setStatus('Citesc captura…');
  try {
    lastRows = parseRows(await readText(file));
  } catch {
    setStatus('Nu am putut citi captura. Verifică internetul la prima folosire sau scrie totalurile în Totaluri și reglaje.', true);
    return;
  }
  if (lastRows.length < 2) {
    setStatus('Nu găsesc cel puțin două totaluri în captură. Fă o captură în care se văd rândul tău și cel de deasupra.', true);
    return;
  }
  setStatus('');
  const mine = findMyRow(lastRows);
  if (mine) applyMyRow(mine);
  else openPicker();
}

async function takeSharedShot() {
  if (new URLSearchParams(location.search).get('shared') !== '1') return null;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open(SHARED_CACHE);
    const response = await cache.match('shot');
    if (!response) return null;
    const blob = await response.blob();
    await cache.delete('shot');
    return blob;
  } catch {
    return null;
  }
}

/* Screen */

function setStatus(text, warn = false) {
  $('status').textContent = text;
  $('status').classList.toggle('warn', warn);
}

function renderGoal() {
  const goal = plan();
  const big = $('goalBig');
  big.classList.remove('small');
  $('goalTotals').replaceChildren();
  let label, title, detail;
  if (state.me == null) {
    label = 'Începe de aici';
    title = 'Arată-mi clasamentul';
    detail = 'În Walk15, deschide clasamentul și fă o captură în care se văd rândul tău și cel de deasupra. Apoi apasă Distribuie și alege Un loc mai sus, sau apasă Citește o captură.';
  } else if (state.next == null) {
    label = 'Clasament';
    title = 'Nimeni deasupra';
    detail = 'Nu văd pe nimeni peste tine în ultima captură. Dacă nu ești pe primul loc, fă o captură în care se vede și rândul de deasupra.';
  } else if (goal.passed) {
    label = 'Clasament';
    title = 'Ai urcat un loc';
    detail = 'Totalul tău a trecut de rândul de deasupra din ultima captură. Fă o captură nouă ca să vezi următorul loc.';
  } else {
    label = 'Până treci de următorul';
    title = `${kilometres(goal.km * 1000)} km`;
    detail = `${steps(goal.needed)} pași: ${steps(goal.gap)} diferență și ${steps(goal.reserve)} rezervă.`;
    if (goal.walks > 1) detail += ` Împărțit în ${goal.walks} plimbări de ${kilometres(goal.walkMetres)} km.`;
  }
  if (state.me == null || state.next == null || goal.passed) big.classList.add('small');
  $('goalLabel').textContent = label;
  big.textContent = title;
  $('goalDetail').textContent = detail;
  $('shotLabel').classList.toggle('primary', !goal || Boolean(goal.passed));

  if (state.me != null) {
    const parts = [`Tu ${steps(state.me)}`];
    if (state.next != null) parts.push(`deasupra ${steps(state.next)}`);
    if (state.updatedAt) parts.push(whenRead(state.updatedAt));
    const totals = $('goalTotals');
    totals.append(`${parts.join(' · ')} `);
    if (lastRows.length) {
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'link';
      change.textContent = 'Alt rând';
      change.addEventListener('click', openPicker);
      totals.append(change);
    }
  }
  const canRoute = goal && !goal.passed;
  $('more').hidden = !canRoute;
  $('here').hidden = !canRoute;
}

function syncInputs() {
  $('inMe').value = state.me ?? '';
  $('inNext').value = state.next ?? '';
  $('inReserve').value = state.reserve ?? '';
  $('inStepsPerKm').value = state.stepsPerKm;
  $('inMaxKm').value = String(state.maxKm).replace('.', ',');
}

function readInputs() {
  const me = digits($('inMe').value);
  const next = digits($('inNext').value);
  if (me !== state.me || next !== state.next) {
    state.me = me;
    state.next = next;
    state.updatedAt = Date.now();
    if (next != null) state.history = [...state.history, { t: state.updatedAt, next }].slice(-14);
  }
  state.reserve = digits($('inReserve').value);
  const perKm = digits($('inStepsPerKm').value);
  if (perKm >= 500 && perKm <= 3000) state.stepsPerKm = perKm;
  const maxKm = Number.parseFloat($('inMaxKm').value.replace(',', '.'));
  if (maxKm >= 1 && maxKm <= 60) state.maxKm = maxKm;
  saveState();
  syncInputs();
  refresh();
}

async function refresh() {
  renderGoal();
  const goal = plan();
  if (!goal || goal.passed) {
    generation?.abort();
    clearRoutes();
    if (!start && await locationAllowed()) {
      try {
        setStart(await locate());
      } catch {
        // The map stays on the country view until a place is chosen.
      }
    }
    return;
  }
  if (start) generateRoutes();
  else useMyLocation();
}

function bindScreen() {
  $('shot').addEventListener('change', () => {
    const file = $('shot').files[0];
    $('shot').value = '';
    if (file) handleShot(file);
  });
  $('more').addEventListener('click', generateRoutes);
  $('here').addEventListener('click', useMyLocation);
  $('gpx').addEventListener('click', downloadGpx);
  $('follow').addEventListener('click', () => (following ? stopFollowing() : startFollowing()));
  document.addEventListener('visibilitychange', () => {
    if (following && document.visibilityState === 'visible') keepScreenOn();
  });
  $('pickCancel').addEventListener('click', () => $('picker').close());
  ['inMe', 'inNext', 'inReserve', 'inStepsPerKm', 'inMaxKm'].forEach((id) => {
    $(id).addEventListener('change', readInputs);
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('install').hidden = false;
  });
  $('install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('install').hidden = true;
  });
}

async function boot() {
  initMap();
  bindScreen();
  syncInputs();
  renderGoal();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const shared = await takeSharedShot();
  if (shared) await handleShot(shared);
  else await refresh();
}

boot();
