/**
 * ALBIPOLLA - Motor de la Aplicación (Versión Optimizada)
 * 
 * Aplicación modularizada y optimizada para el Mundial 2026.
 * Características de rendimiento y estabilidad incluidas:
 * 1. Conexión de entornos dinámica por URL/Host sin duplicación de archivos.
 * 2. Escrituras independientes en Firebase (/predictions/playerId/matchId) para eliminar colisiones.
 * 3. Indexación O(1) en memoria para el cálculo de puntajes y ranking general.
 * 4. Optimización de re-renderizado para evitar sobreescritura de DOM y bloqueos de teclado.
 * 5. Soporte offline nativo de transacciones locales y caché de Firebase.
 */

// ╔══════════════════════════════════════════════════╗
// ║  1. CONFIGURACIÓN Y ENTORNOS                     ║
// ╚══════════════════════════════════════════════════╝
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA8bWp0zjBYPVzCgTx5YP7C0R7j7-nbtIM",
  authDomain: "polla-mundial-2026-8b6e5.firebaseapp.com",
  databaseURL: "https://polla-mundial-2026-8b6e5-default-rtdb.firebaseio.com",
  projectId: "polla-mundial-2026-8b6e5",
  storageBucket: "polla-mundial-2026-8b6e5.firebasestorage.app",
  messagingSenderId: "1045950676554",
  appId: "1:1045950676554:web:0aff47964578649fddb0b3"
};

// Configuración de entornos dinámica
const ENV = {
  prod: {
    root: 'wc26prod',
    title: 'ALBIPOLLA · Pronósticos',
    warning: '',
    matchKey: 'fifa_matches',
    matchCacheKey: 'wc26_matches',
    hasSponsor: false
  },
  test: {
    root: 'wc26prueba',
    title: 'ALBIPOLLA · Pronósticos [PRUEBA]',
    warning: '⚠️ VERSIÓN DE PRUEBA — los datos no afectan la quiniela real',
    matchKey: 'fifa_matches',
    matchCacheKey: 'wc26_matches_test',
    hasSponsor: true
  },
  laliga: {
    root: 'wc26laliga',
    title: 'FIFA Match Centre [LALIGA PRUEBAS]',
    warning: '⚠️ FIFA Match Centre — Modo de pruebas Liga Española',
    matchKey: 'fifa_match_centre_matches',
    matchCacheKey: 'wc26_fifa_match_centre_matches',
    hasSponsor: false
  }
};

// Determinar el entorno de ejecución según URL o subdominio
function getActiveEnvironment() {
  const params = new URLSearchParams(window.location.search);
  const envParam = params.get('env');
  
  if (ENV[envParam]) return ENV[envParam];
  
  const pathname = window.location.pathname.toLowerCase();
  const hostname = window.location.hostname.toLowerCase();
  
  if (pathname.includes('laliga')) return ENV.laliga;
  if (pathname.includes('prueba') || hostname.includes('prueba') || hostname.includes('test')) return ENV.test;
  
  return ENV.prod; // Entorno predeterminado
}

const currentEnv = getActiveEnvironment();
const FB_ROOT = currentEnv.root;
const MATCH_CACHE_KEY = currentEnv.matchCacheKey;
const MATCHES_FB_KEY = currentEnv.matchKey;

// Aplicar títulos y advertencias visuales del entorno
document.title = currentEnv.title;
const bannerEl = document.getElementById('env-banner');
if (currentEnv.warning && bannerEl) {
  bannerEl.textContent = currentEnv.warning;
  bannerEl.style.display = 'block';
}

// ╔══════════════════════════════════════════════════╗
// ║  2. BASE DE DATOS Y CAPA DE PERSISTENCIA         ║
// ╚══════════════════════════════════════════════════╝
const _cache = {};
const _writeTimers = {};
let _fbDatabase = null;
let _playersReady = false;

// Estructuras de índices rápidos O(1) en memoria
const _predictionIndex = new Map(); // Llave: "playerId::matchId" -> predObj
const _playerIndex = new Map();     // Llave: playerId -> playerObj

// Throttle de toasts de error Firebase: máx 1 cada 10s para no spamear
let _fbErrorLastToast = 0;
function fbErrorToast(context, err) {
  console.warn('FB error:', context, err);
  const now = Date.now();
  if (now - _fbErrorLastToast < 10000) return;
  _fbErrorLastToast = now;
  toast('⚠ Sin sincronización con servidor. Tus cambios pueden no guardarse.', 'err');
}

/**
 * Normaliza las predicciones almacenadas en Firebase Realtime Database.
 * Soporta de forma retrocompatible arrays planos, mapas de arrays y el formato optimizado nested.
 */
function parsePredictions(raw) {
  if (!raw) return [];
  const arr = [];
  
  if (Array.isArray(raw)) {
    return raw.filter(Boolean);
  } else if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    
    // Si Firebase convirtió el array en un mapa indexado por enteros:
    const isArrayLike = keys.length && keys.every(k => !isNaN(parseInt(k)));
    if (isArrayLike) {
      return keys.map(k => raw[k]).filter(Boolean);
    }
    
    // Formato optimizado: { playerId: { matchId: { predObj } } }
    keys.forEach(playerId => {
      const playerPreds = raw[playerId];
      if (playerPreds && typeof playerPreds === 'object') {
        Object.keys(playerPreds).forEach(matchId => {
          const pred = playerPreds[matchId];
          if (pred) {
            arr.push({
              id: pred.id || `${playerId}::${matchId}`,
              playerId: playerId,
              matchId: matchId,
              homeScore: Number.isInteger(pred.homeScore) ? pred.homeScore : null,
              awayScore: Number.isInteger(pred.awayScore) ? pred.awayScore : null,
              penWinner: pred.penWinner || null
            });
          }
        });
      }
    });
  }
  return arr;
}

const DB = {
  get(k, fb = null) {
    if (!_cache.hasOwnProperty(k)) return fb;
    const v = _cache[k];
    // Normalizar arrays convertidos en objetos por Firebase
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length && keys.every(k2 => !isNaN(parseInt(k2)))) {
        return keys.map(k2 => v[k2]);
      }
    }
    return v;
  },
  
  set(k, v) {
    _cache[k] = v;
    clearTimeout(_writeTimers[k]);
    _writeTimers[k] = setTimeout(() => {
      if (_fbDatabase) {
        _fbDatabase.ref(FB_ROOT + '/' + k).set(v).catch(err => fbErrorToast('write ' + k, err));
      }
    }, 300);
  },

  getPlayers:      () => DB.get('players', []),
  getPredictions:  () => {
    // Si viene de caché estructurada local, ya es array.
    const raw = DB.get('predictions', []);
    return Array.isArray(raw) ? raw : parsePredictions(raw);
  },
  getWildcards:    () => DB.get('wildcards', {}),
  getSpecial:      () => DB.get('special', []),
  savePlayers:     v  => DB.set('players', v),
  savePredictions: v  => DB.set('predictions', v),
  saveWildcards:   v  => DB.set('wildcards', v),
  saveSpecial:     v  => DB.set('special', v),
  getSnapshots:    () => DB.get('rank_snaps', []),
  saveSnapshots:   v  => DB.set('rank_snaps', v),
  getChat:    (matchId) => DB.get('chat_' + matchId, []),
  saveChat:   (matchId, v) => DB.set('chat_' + matchId, v),
};

// Indexar datos de Firebase para búsquedas de alta velocidad O(1)
function updateIndices() {
  _predictionIndex.clear();
  const preds = DB.getPredictions();
  preds.forEach(p => {
    if (p && p.playerId && p.matchId) {
      _predictionIndex.set(`${p.playerId}::${p.matchId}`, p);
    }
  });

  _playerIndex.clear();
  const players = DB.getPlayers();
  players.forEach(p => {
    if (p && p.id) {
      _playerIndex.set(p.id, p);
    }
  });
}

function savePlayersMerged(nextPlayers) {
  const arr = Array.isArray(nextPlayers) ? nextPlayers.filter(Boolean) : [];
  _cache.players = arr;

  if (!_fbDatabase) {
    DB.set('players', arr);
    return;
  }

  _fbDatabase.ref(FB_ROOT + '/players').transaction(current => {
    const remote = normalizeFirebaseValue(current);
    const merged = new Map();
    if (Array.isArray(remote)) {
      remote.filter(Boolean).forEach(p => { if (p.id) merged.set(String(p.id), p); });
    }
    arr.forEach(p => { if (p && p.id) merged.set(String(p.id), p); });
    return Array.from(merged.values());
  }).catch(err => fbErrorToast('players merge', err));
}

// Guarda la predicción en un nodo individual para evitar colisiones y bloqueos por transacciones concurrentes
async function savePredictionMerged(rec) {
  if (!rec || !rec.playerId || !rec.matchId) return false;
  
  // Guardar en la caché local para respuesta instantánea de UI
  const key = `${rec.playerId}::${rec.matchId}`;
  _predictionIndex.set(key, rec);
  
  // Sincronizar array de cache plano
  const localList = DB.getPredictions().filter(p => `${p.playerId}::${p.matchId}` !== key);
  localList.push(rec);
  _cache.predictions = localList;

  if (!_fbDatabase) {
    DB.set('predictions', localList);
    return true;
  }

  try {
    // Escritura en nodo exclusivo del jugador y partido para máxima concurrencia
    await _fbDatabase.ref(`${FB_ROOT}/predictions/${rec.playerId}/${rec.matchId}`).set({
      id: rec.id,
      homeScore: rec.homeScore,
      awayScore: rec.awayScore,
      penWinner: rec.penWinner || null
    });
    return true;
  } catch(err) {
    console.warn('FB prediction write error:', err);
    return false;
  }
}

// ── Listeners de tiempo real en Firebase ──
const REALTIME_KEYS = ['players', 'predictions', 'wildcards', 'special', 'meta', 'rank_snaps'];

function normalizeFirebaseValue(val) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const keys = Object.keys(val);
    const isArrayLike = keys.every(k => !isNaN(parseInt(k)));
    if (isArrayLike) return keys.map(k => val[k]);
  }
  return val;
}

function firebaseMatchesToArray(val) {
  if (Array.isArray(val)) return val.filter(Boolean);
  if (val && typeof val === 'object') {
    return Object.keys(val)
      .sort((a,b)=>Number(a)-Number(b))
      .map(k=>val[k])
      .filter(Boolean);
  }
  return [];
}

let _lastStateString = ""; // Evita renderizar vistas completas si la información no ha cambiado

function setupFirebaseListeners(db) {
  REALTIME_KEYS.forEach(key => {
    db.ref(FB_ROOT + '/' + key).on('value', snap => {
      const raw = snap.val();
      if (raw === null) {
        if (key === 'players') { _cache.players = []; _playersReady = true; }
        return;
      }
      
      const val = key === 'predictions' ? parsePredictions(raw) : normalizeFirebaseValue(raw);
      if (key === 'players') _playersReady = true;

      _cache[key] = val;
      updateIndices();

      // Optimización de renderizado selectivo
      const currentStateStr = JSON.stringify({
        players: _cache.players,
        predictions: _cache.predictions,
        wildcards: _cache.wildcards,
        special: _cache.special,
        meta: _cache.meta,
        rank_snaps: _cache.rank_snaps,
        view: currentView
      });

      if (_lastStateString === currentStateStr) return;
      _lastStateString = currentStateStr;

      if (currentPlayer && !document.activeElement?.matches('input,textarea,select')) {
        renderView(currentView);
      }
    });
  });

  // Listener para partidos (actualizados por el script centralizado)
  db.ref(FB_ROOT + '/' + MATCHES_FB_KEY).on('value', snap => {
    const raw = snap.val();
    if (!raw) return;
    const val = firebaseMatchesToArray(raw);
    if (!val.length) return;
    
    const merged = mergeMatchesWithHistory(matches, val);
    const prev = JSON.stringify(matches);
    const next = JSON.stringify(merged);
    
    if (prev === next) return; // Salir si no hay cambios
    
    matches = merged;
    try { localStorage.setItem(MATCH_CACHE_KEY, JSON.stringify(matches)); } catch(e) {}
    
    if (currentPlayer && !document.activeElement?.matches('input,textarea,select')) {
      renderView(currentView);
    }
  });
}

function loadCachedMatchesFromFirebase(callback) {
  if (_fbDatabase) {
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    Promise.race([_fbDatabase.ref(FB_ROOT + '/' + MATCHES_FB_KEY).get(), timeout])
      .then(snap => {
        if (!snap) return callback([]);
        const val = snap.val();
        const arr = firebaseMatchesToArray(val);
        callback(arr.length ? arr : []);
      }).catch(() => callback([]));
  } else {
    callback([]);
  }
}

async function initFirebase() {
  firebase.initializeApp(FIREBASE_CONFIG);
  const db = firebase.database();
  _fbDatabase = db;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Firebase timeout (8s)')), 8000)
  );

  let snap;
  try {
    snap = await Promise.race([db.ref(FB_ROOT).get(), timeout]);
  } catch(e) {
    console.warn('Firebase connection failed, working with local cache:', e.message);
    setupFirebaseListeners(db);
    return;
  }

  const data = snap.val() || {};
  Object.entries(data).forEach(([k, v]) => {
    if (k === 'predictions') {
      _cache[k] = parsePredictions(v);
    } else {
      _cache[k] = v;
    }
  });
  if (!Object.prototype.hasOwnProperty.call(data, 'players')) _cache.players = [];
  _playersReady = true;

  updateIndices();
  setupFirebaseListeners(db);
}

// ╔══════════════════════════════════════════════════╗
// ║  3. MOTOR DE PARTIDOS DE FIFA                    ║
// ╚══════════════════════════════════════════════════╝
const FIFA_URL = "https://api.fifa.com/api/v3/calendar/matches?from=2026-06-10&to=2026-07-20&language=es&count=500";
let matches = [];
let fifaLoading = false;
let fifaSource  = 'Sin datos';

function loadCachedMatches() {
  try {
    const d = JSON.parse(localStorage.getItem(MATCH_CACHE_KEY) || '[]');
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function saveCachedMatches(arr) {
  try { localStorage.setItem(MATCH_CACHE_KEY, JSON.stringify(arr)); } catch(e) {}
  if (_fbDatabase && arr && arr.length) {
    _fbDatabase.ref(FB_ROOT + '/' + MATCHES_FB_KEY).set(arr).catch(() => {});
  }
}

function sortMatchesChronologically(arr) {
  return [...arr].sort((a,b) => new Date(a.kickoff||a.date) - new Date(b.kickoff||b.date));
}

function mergeMatchesWithHistory(existing, fresh) {
  const byId = new Map();
  for (const m of existing || []) { if (m && m.id) byId.set(String(m.id), m); }
  for (const m of fresh || []) {
    if (!m || !m.id) continue;
    const id = String(m.id);
    const cached = byId.get(id);
    if (!cached) { byId.set(id, m); continue; }
    if (cached.manualOverride || (cached.status === 'finished' && m.status !== 'finished') || (cached.status === 'closed' && m.status === 'pending')) {
      byId.set(id, cached); continue;
    }
    byId.set(id, { ...cached, ...m });
  }
  return sortMatchesChronologically(Array.from(byId.values()));
}

function localizedText(arr, fb = '') {
  return arr && arr[0] && arr[0].Description ? arr[0].Description : fb;
}

function teamName(team, placeholder) {
  if (!team) return placeholder || 'Por definir';
  return localizedText(team.TeamName, '') || team.ShortClubName || team.Abbreviation || placeholder || 'Por definir';
}

function countryCode(team) {
  if (!team) return '';
  return String(team.IdCountry || team.Abbreviation || '').toUpperCase().slice(0,3);
}

function mapFifaStatus(m) {
  const statusCode = Number(m.MatchStatus);
  const hasScore = Number.isInteger(m.HomeTeamScore) && Number.isInteger(m.AwayTeamScore);
  const matchTime = String(m.MatchTime || '').trim();

  if ([0,11,12,13].includes(statusCode)) return 'finished';
  if ([3,4,5,6,9,10].includes(statusCode)) return 'live';
  if (hasScore && matchTime && matchTime !== "0'") return 'live';
  return 'pending';
}

function mapPhase(match) {
  const g = localizedText(match.GroupName, '').toLowerCase();
  const s = (localizedText(match.StageName, '') || '').toLowerCase();
  if (g.includes('grupo') || g.includes('group') || s.includes('regular') || s.includes('temporada')) return 'grupos';
  if (s.includes('32') || s.includes('treinta')) return 'r32';
  if (s.includes('16') || s.includes('octavo') || s.includes('round of 16')) return 'r16';
  if (s.includes('cuarto') || s.includes('quarter')) return 'qf';
  if (s.includes('semi')) return 'sf';
  if (s.includes('tercer') || s.includes('third')) return 'third';
  if (s.includes('final')) return 'final';
  return 'grupos';
}

function normalizeFifaMatch(m) {
  const group = localizedText(m.GroupName, '');
  // Extraer letra de grupo para visualización
  const groupLetter = group.match(/[A-L]$/i) ? group.match(/[A-L]$/i)[0].toUpperCase() : group || '?';
  const status = mapFifaStatus(m);
  return {
    id:        String(m.IdMatch),
    matchNumber: m.MatchNumber || null,
    homeTeam:  teamName(m.Home, m.PlaceHolderA),
    awayTeam:  teamName(m.Away, m.PlaceHolderB),
    homeCode:  countryCode(m.Home),
    awayCode:  countryCode(m.Away),
    group:     groupLetter,
    phase:     mapPhase(m),
    date:      m.Date,
    kickoff:   m.Date,
    status,
    homeScore: Number.isInteger(m.HomeTeamScore) ? m.HomeTeamScore : null,
    awayScore: Number.isInteger(m.AwayTeamScore) ? m.AwayTeamScore : null,
    venue:     localizedText(m.Stadium && m.Stadium.Name, ''),
    city:      localizedText(m.Stadium && m.Stadium.CityName, ''),
    liveMinute: status === 'live' ? String(m.MatchTime || '').replace("'", '') || null : null,
    liveDetail: status === 'live' ? (m.MatchTime || 'En juego') : '',
  };
}

// Consulta a la API de FIFA en background. Nota: Si utilizas sync-fifa.js de forma centralizada, esto funciona como respaldo.
async function loadFifaMatches({ silent = false } = {}) {
  if (fifaLoading) return;
  fifaLoading = true;
  updateFifaStrip('Actualizando...', true);
  if (!silent) toast('Actualizando partidos desde FIFA…');

  try {
    const res  = await fetch(FIFA_URL, { cache:'no-store' });
    if (!res.ok) throw new Error(`FIFA: ${res.status}`);
    const data = await res.json();

    const prevFinished = new Set(matches.filter(m => m.status === 'finished').map(m => m.id));

    const fresh = (data.Results || [])
      .map(normalizeFifaMatch)
      .sort((a,b) => new Date(a.kickoff) - new Date(b.kickoff));

    if (!fresh.length) throw new Error('FIFA devolvió 0 partidos');

    matches = mergeMatchesWithHistory(matches, fresh);
    saveCachedMatches(matches);

    const newlyFinished = matches.filter(m => m.status === 'finished' && !prevFinished.has(m.id));
    if (newlyFinished.length > 0) {
      newlyFinished.forEach(m => {
        const label = `${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam}`;
        saveRankSnapshot(m.id, label);
      });
      if (silent) toast(`✓ ${newlyFinished.length} resultados nuevos de FIFA`, 'ok');
    }

    const hasLive = matches.some(m => m.status === 'live');
    const now = new Date().toLocaleTimeString('es-PY', {hour:'2-digit', minute:'2-digit'});
    fifaSource = `FIFA · ${matches.length} partidos · ${now}`;
    if (!silent) toast(`✓ ${matches.length} partidos cargados`, 'ok');
    updateFifaStrip(fifaSource, false);
    scheduleNextRefresh(hasLive);
    if (currentPlayer) renderView(currentView);
  } catch(err) {
    fifaSource = matches.length ? `Caché · ${matches.length} partidos` : 'FIFA no disponible';
    updateFifaStrip(fifaSource, false);
    if (!silent) toast('No se pudo conectar con FIFA', 'err');
    scheduleNextRefresh(false);
  } finally {
    fifaLoading = false;
  }
}

let _refreshTimer = null;
function scheduleNextRefresh(hasLive) {
  clearTimeout(_refreshTimer);
  const delay = hasLive ? 60_000 : 3 * 60_000;
  _refreshTimer = setTimeout(() => {
    if (currentPlayer) loadFifaMatches({ silent: true });
  }, delay);
}

function updateFifaStrip(text, loading) {
  document.querySelectorAll('.fifa-source').forEach(el => el.textContent = text);
  document.querySelectorAll('.fifa-refresh-btn').forEach(btn => { btn.disabled = loading; });
}

// ╔══════════════════════════════════════════════════╗
// ║  4. REGLAS DE NEGOCIO Y CALCULOS MATEMÁTICOS     ║
// ╚══════════════════════════════════════════════════╗
const ADMIN_PASS = 'mundial2026';
const AVATAR_COLORS = [
  {bg:'#1a3a4a',tc:'#7dd3fc'},{bg:'#3a1a4a',tc:'#c084fc'},
  {bg:'#4a1a1a',tc:'#fca5a5'},{bg:'#1a4a2a',tc:'#86efac'},
  {bg:'#4a3a1a',tc:'#fcd34d'},{bg:'#1a4a4a',tc:'#5eead4'},
  {bg:'#4a1a3a',tc:'#f9a8d4'},{bg:'#2a3a1a',tc:'#bef264'},
  {bg:'#3a2a1a',tc:'#fdba74'},{bg:'#1a2a4a',tc:'#93c5fd'},
];
const PHASES = {
  grupos:'Fase de Grupos', r32:'Ronda de 32',
  r16:'Octavos de Final', qf:'Cuartos de Final',
  sf:'Semifinales', third:'3er Puesto', final:'Final'
};

const PLAYOFF_PHASES = new Set(['r32','r16','qf','sf','third','final']);
const WC_QUOTA    = { grupos:1, r32:2, r16:1, qf:1, sf:0, third:0, final:0 };
const PHASE_MULT  = { grupos:1, r32:2, r16:3, qf:4, sf:5, third:5, final:7 };
const PEN_BONUS_PTS = { r32:2, r16:4, qf:6, sf:8, third:10, final:12 };
const MUNDIAL_START = new Date('2026-06-11T00:00:00-03:00');

const ACHIEVEMENTS = [
  {id:'first_exact', icon:'🎯', title:'Francotirador',   desc:'Primer resultado exacto',              check:(s,r)=>s.exact>=1},
  {id:'exact5',      icon:'🧠', title:'Vidente',         desc:'5 resultados exactos',                 check:(s,r)=>s.exact>=5},
  {id:'exact10',     icon:'🔮', title:'Oráculo',         desc:'10 resultados exactos',                check:(s,r)=>s.exact>=10},
  {id:'streak3',     icon:'🔥', title:'En llamas',       desc:'3 aciertos seguidos',                  check:(s,r)=>s.maxStreak>=3},
  {id:'streak5',     icon:'⚡', title:'Imparable',       desc:'5 aciertos consecutivos',              check:(s,r)=>s.maxStreak>=5},
  {id:'wc_win',      icon:'🎯', title:'Redoblona certera', desc:'Puntos dobles con una redoblona',      check:(s,r)=>s.wildcardWin},
  {id:'top3',        icon:'🏆', title:'Top 3',           desc:'Estás en el podio',                    check:(s,r)=>r<=3&&r>0},
  {id:'leader',      icon:'👑', title:'Líder',           desc:'Llegaste al primer puesto',             check:(s,r)=>r===1},
  {id:'no_blank',    icon:'💪', title:'Comprometido',    desc:'Pronosticaste 10+ partidos',            check:(s,r)=>s.totalPreds>=10},
  {id:'champion_ok', icon:'🏅', title:'El que sabe',     desc:'Acertaste el campeón del Mundial',      check:(s,r)=>s.championOk},
  {id:'valiente',    icon:'🦁', title:'El Valiente',     desc:'Fuiste el único que sumó puntos en un partido',   check:(s,r)=>s.soloSurprise>=1},
  {id:'conservador', icon:'🐢', title:'El Conservador',  desc:'3+ veces apostaste 1-0, 2-1 ó 1-1',    check:(s,r)=>s.conservador>=3},
  {id:'pleno_grupo', icon:'⭐', title:'Pleno de Grupo',  desc:'Acertaste todos los ganadores de una jornada', check:(s,r)=>s.plenoGrupo>=1},
  {id:'batacazo',    icon:'💥', title:'Batacazo',        desc:'Acertaste un resultado inesperado (solo vos)', check:(s,r)=>s.soloSurprise>=1},
  {id:'penales_ok',  icon:'🥅', title:'Leyenda del Penal',desc:'Acertaste quién ganó en penales',     check:(s,r)=>s.penalesOk>=1},
];

const REACTIONS = ['🔥','😮','😂','👏','💀'];

// Utiliza indexación O(1) para calcular el bonus de riesgo
function calcRiskBonus(pred, hScore, aScore, matchId) {
  if (!pred || hScore===null) return 0;
  const base = calcPtsBase(pred, hScore, aScore);
  if (base === 0) return 0;
  
  // Buscar todas las predicciones de este partido en la caché rápida
  const allPredictions = DB.getPredictions();
  const onMatch = allPredictions.filter(p => p.matchId === matchId);
  const total = onMatch.length;
  if (total < 4) return 0;

  const myOutcome = outcome(pred.homeScore, pred.awayScore);
  const sameOutcome = onMatch.filter(p => outcome(p.homeScore, p.awayScore) === myOutcome).length;
  const pct = sameOutcome / total;
  
  if (pct < 0.15) return 3;
  if (pct < 0.25) return 2;
  return 0;
}

function calcPtsBase(pred, hScore, aScore) {
  if (!pred || hScore===null || aScore===null) return 0;
  const isExact  = pred.homeScore===hScore && pred.awayScore===aScore;
  const isWinner = outcome(pred.homeScore,pred.awayScore)===outcome(hScore,aScore);
  const isGdOk   = (pred.homeScore-pred.awayScore)===(hScore-aScore);
  if (isExact) return 5;
  if (isWinner) return isGdOk ? 4 : 3;
  return 0;
}

function calcPts(pred, hScore, aScore, isWC, phase, penWinner) {
  const raw = calcPtsBase(pred, hScore, aScore);
  if (raw === 0) return 0;
  const mult = PHASE_MULT[phase] || 1;
  let pts = raw * mult;
  if (penWinner && pred.penWinner && pred.penWinner === penWinner) pts += (PEN_BONUS_PTS[phase] || 0);
  if (isWC) pts *= 2;
  return pts;
}

function isWCUsed(wcData, match) {
  if (!wcData) return false;
  if (match.phase==='grupos') {
    return (wcData.grupos || {})[match.group] === match.id;
  }
  const used = wcData[match.phase];
  return Array.isArray(used) ? used.includes(match.id) : used===match.id;
}

function wcRemaining(wcData, phase, groupLetter) {
  const quota = WC_QUOTA[phase] || 0;
  if (phase==='grupos') {
    return (wcData.grupos||{})[groupLetter] ? 0 : 1;
  }
  const used = wcData[phase];
  if (!used) return quota;
  const usedCount = Array.isArray(used) ? used.length : 1;
  return Math.max(0, quota - usedCount);
}

// Búsqueda acelerada O(1) de estadísticas lúdicas
function calcFunStats(playerId) {
  const finished = matches.filter(m => m.status==='finished');
  let soloSurprise=0, conservador=0, penalesOk=0, plenoGrupo=0;
  const CONSERVATIVE = new Set(['1-0','2-1','1-1','0-0','2-0']);
  
  for (const m of finished) {
    const myP = _predictionIndex.get(`${playerId}::${m.id}`);
    if (!myP) continue;
    
    const scKey = myP.homeScore+'-'+myP.awayScore;
    if (CONSERVATIVE.has(scKey)) conservador++;
    
    if (calcPtsBase(myP, m.homeScore, m.awayScore) >= 3) {
      const allOnMatch = DB.getPredictions().filter(x => x.matchId === m.id);
      const sameOutcome = allOnMatch.filter(x => outcome(x.homeScore, x.awayScore) === outcome(m.homeScore, m.awayScore));
      if (sameOutcome.length === 1) soloSurprise++;
    }
    if (m.penWinner && myP.penWinner && myP.penWinner === m.penWinner) penalesOk++;
  }
  
  const byDay = {};
  for (const m of finished.filter(x => x.phase === 'grupos')) {
    const day = new Date(m.kickoff || m.date).toDateString();
    (byDay[day] = byDay[day] || []).push(m);
  }
  for (const [day, dayMatches] of Object.entries(byDay)) {
    if (dayMatches.length < 2) continue;
    const allHit = dayMatches.every(m => {
      const p = _predictionIndex.get(`${playerId}::${m.id}`);
      return p && outcome(p.homeScore, p.awayScore) === outcome(m.homeScore, m.awayScore);
    });
    if (allHit) plenoGrupo++;
  }
  return {soloSurprise, conservador, penalesOk, plenoGrupo};
}

// Puntuación por jugador optimizada mediante Map Index O(1)
function scorePlayer(playerId) {
  const wcData   = DB.getWildcards()[playerId] || {};
  const finished = matches.filter(m => m.status==='finished');
  const live     = matches.filter(m => m.status==='live');
  let confirmedPts=0, provisionalPts=0;
  let exact=0, partial=0, gdBonus=0, maxStreak=0, curStreak=0;
  let wildcardWin=false, totalPreds=0;
  
  for (const m of finished) {
    const p = _predictionIndex.get(`${playerId}::${m.id}`);
    if (!p) { curStreak=0; continue; }
    totalPreds++;
    const isWC   = isWCUsed(wcData, m);
    const rawBase = calcPtsBase(p, m.homeScore, m.awayScore);
    const mult   = PHASE_MULT[m.phase] || 1;
    let mp = rawBase * mult;
    if (m.penWinner && p.penWinner && p.penWinner===m.penWinner) mp += (PEN_BONUS_PTS[m.phase]||0);
    if (isWC && mp>0) { mp*=2; wildcardWin=true; }
    const risk  = rawBase>0 ? calcRiskBonus(p, m.homeScore, m.awayScore, m.id) : 0;
    let total = mp + risk;
    
    if (rawBase>0 && total>0) {
      const onMatch = DB.getPredictions().filter(x => x.matchId === m.id);
      const soloScorer = onMatch.filter(x => calcPtsBase(x, m.homeScore, m.awayScore) > 0).length === 1;
      if (soloScorer) total *= 2;
    }
    
    if (rawBase===5) { exact++; curStreak++; }
    else if (rawBase>=3) { partial++; curStreak++; }
    else { curStreak=0; }
    if (rawBase===4) gdBonus++;
    maxStreak = Math.max(maxStreak, curStreak);
    confirmedPts += total;
  }
  
  for (const m of live) {
    const p = _predictionIndex.get(`${playerId}::${m.id}`);
    if (!p||m.homeScore===null) continue;
    const isWC = isWCUsed(wcData, m);
    provisionalPts += calcPts(p, m.homeScore, m.awayScore, isWC, m.phase, m.penWinner);
  }
  
  const meta = DB.get('meta',{});
  let championOk=false;
  const special = DB.getSpecial().find(s => s.playerId === playerId);
  if (special?.champion && meta.champion &&
      special.champion.trim().toLowerCase()===meta.champion.trim().toLowerCase()) {
    confirmedPts+=15; championOk=true;
  }
  if (special?.subCampeon && meta.subCampeon &&
      special.subCampeon.trim().toLowerCase()===meta.subCampeon.trim().toLowerCase()) {
    confirmedPts+=8;
  }
  if (special?.tercerPuesto && meta.tercerPuesto &&
      special.tercerPuesto.trim().toLowerCase()===meta.tercerPuesto.trim().toLowerCase()) {
    confirmedPts+=5;
  }
  if (special?.topScorer && meta.topScorer &&
      special.topScorer.trim().toLowerCase()===meta.topScorer.trim().toLowerCase()) {
    confirmedPts+=10;
  }
  
  const fun = calcFunStats(playerId);
  const pts = confirmedPts + provisionalPts;
  return {pts, confirmedPts, provisionalPts, exact, partial, gdBonus,
          maxStreak, curStreak, wildcardWin, totalPreds, championOk, ...fun};
}

function allScores() {
  return DB.getPlayers()
    .map(p => ({...p, ...scorePlayer(p.id)}))
    .sort((a,b) => b.pts - a.pts || b.exact - a.exact);
}

function provPtsForMatch(playerId, matchId) {
  const m = matches.find(x => x.id===matchId);
  if (!m||m.homeScore===null) return null;
  const p = _predictionIndex.get(`${playerId}::${matchId}`);
  if (!p) return null;
  const wcData = DB.getWildcards()[playerId]||{};
  const isWC = isWCUsed(wcData, m);
  let pts = calcPts(p, m.homeScore, m.awayScore, isWC, m.phase, m.penWinner);
  if (pts > 0) {
    const onMatch = DB.getPredictions().filter(x => x.matchId === matchId);
    const soloScorer = onMatch.filter(x => calcPtsBase(x, m.homeScore, m.awayScore) > 0).length === 1;
    if (soloScorer) pts *= 2;
  }
  return pts;
}

function ptsEarnedInMatch(playerId, matchId) {
  const m = matches.find(x => x.id===matchId);
  if (!m || m.status!=='finished') return 0;
  const p = _predictionIndex.get(`${playerId}::${matchId}`);
  if (!p) return 0;
  const wcData = DB.getWildcards()[playerId]||{};
  const isWC = isWCUsed(wcData, m);
  const pts = calcPts(p, m.homeScore, m.awayScore, isWC, m.phase, m.penWinner);
  const risk = pts>0 ? calcRiskBonus(p, m.homeScore, m.awayScore, m.id) : 0;
  let total = pts + risk;
  
  if (total > 0) {
    const onMatch = DB.getPredictions().filter(x => x.matchId === matchId);
    const soloScorer = onMatch.filter(x => calcPtsBase(x, m.homeScore, m.awayScore) > 0).length === 1;
    if (soloScorer) total *= 2;
  }
  return total;
}

function pointsBreakdownForMatch(playerId, m, pred) {
  if (!pred) return null;
  if (!m || m.homeScore===null || m.awayScore===null) {
    return {total:null, rows:[{label:'Estado', value:'Esperando resultado FIFA'}]};
  }

  const wcData = DB.getWildcards()[playerId] || {};
  const isWC = isWCUsed(wcData, m);
  const rawBase = calcPtsBase(pred, m.homeScore, m.awayScore);
  const rows = [];

  if (rawBase === 5) rows.push({label:'Acierto', value:'+5 exacto'});
  else if (rawBase === 4) rows.push({label:'Acierto', value:'+4 ganador y diferencia'});
  else if (rawBase === 3) rows.push({label:'Acierto', value:'+3 ganador'});
  else rows.push({label:'Acierto', value:'+0'});

  const mult = PHASE_MULT[m.phase] || 1;
  let subtotal = rawBase * mult;
  const phaseName = PHASES[m.phase] || m.phase || 'fase';
  if (rawBase > 0) {
    rows.push({label:'Fase', value:rawBase + ' × ' + mult + ' (' + phaseName + ') = +' + subtotal});
  }

  const penBonus = (m.penWinner && pred.penWinner && pred.penWinner === m.penWinner) ? (PEN_BONUS_PTS[m.phase] || 0) : 0;
  if (penBonus > 0) {
    subtotal += penBonus;
    rows.push({label:'Penales', value:'+' + penBonus});
  }

  if (isWC && subtotal > 0) {
    const before = subtotal;
    subtotal *= 2;
    rows.push({label:'Redoblona', value:before + ' × 2 = +' + subtotal});
  }

  const risk = (m.status === 'finished' && rawBase > 0) ? calcRiskBonus(pred, m.homeScore, m.awayScore, m.id) : 0;
  let total = subtotal + risk;
  if (risk > 0) rows.push({label:'Bonus riesgo', value:'+' + risk});

  if (rawBase > 0 && total > 0) {
    const onMatch = DB.getPredictions().filter(x => x.matchId === m.id);
    const soloScorer = onMatch.filter(x => calcPtsBase(x, m.homeScore, m.awayScore) > 0).length === 1;
    if (soloScorer) {
      const before = total;
      total *= 2;
      rows.push({label:'Único que sumó', value:before + ' × 2 = +' + total});
    }
  }

  if (m.status === 'live') rows.push({label:'Estado', value:'Provisorio'});
  rows.push({label:'Total', value:total > 0 ? '+' + total + ' pts' : '0 pts', total:true});
  return {total, rows};
}

// ╔══════════════════════════════════════════════════╗
// ║  5. UTILS Y AUXILIARES DE UI                     ║
// ╚══════════════════════════════════════════════════╝
const genId    = () => Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const initials = n => n.trim().split(/\s+/).map(w=>w[0]).join('').toUpperCase().slice(0,2);
const color    = idx => AVATAR_COLORS[idx % AVATAR_COLORS.length];
const outcome  = (h,a) => h>a?'H':a>h?'A':'D';

function fmtDate(d) {
  try {
    return new Intl.DateTimeFormat('es-PY', {
      weekday:'short', day:'2-digit', month:'short',
      hour:'2-digit', minute:'2-digit', hour12: false
    }).format(new Date(d));
  } catch { return d || ''; }
}

function toast(msg, type='') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.className = 'toast show ' + type;
  setTimeout(() => { el.className = 'toast'; }, 2600);
}

function avaEl(player, size=36) {
  const c  = color(player.colorIdx);
  const fs = Math.round(size * 0.38);
  return `<div class="ava" style="width:${size}px;height:${size}px;background:${c.bg};color:${c.tc};font-size:${fs}px;">${initials(player.name)}</div>`;
}

function renderFlag(code, teamNameStr) {
  const c = String(code || '').trim().toUpperCase();
  const ini = initials(teamNameStr || '??');
  if (!/^[A-Z]{3}$/.test(c)) {
    return `<span class="flag-badge">${ini}</span>`;
  }
  const src = `https://api.fifa.com/api/v3/picture/flags-sq-2/${c}`;
  const fallback = `this.style.display='none';this.insertAdjacentHTML('afterend','<span class=\\'flag-badge\\'>${ini}</span>')`;
  return `<img class="flag" src="${src}" alt="${teamNameStr}" loading="lazy" onerror="${fallback}">`;
}

function inlineFlag(code, teamNameStr) {
  const c = String(code || '').trim().toUpperCase();
  const ini = initials(teamNameStr || '??');
  if (!/^[A-Z]{3}$/.test(c)) return `<span class="flag-badge" style="width:18px;height:18px;font-size:7px;">${ini}</span>`;
  const src = `https://api.fifa.com/api/v3/picture/flags-sq-2/${c}`;
  const fb  = `this.style.display='none';this.insertAdjacentHTML('afterend','<span class=\\'flag-badge\\'style=\\'width:18px;height:18px;font-size:7px;\\'>${ini}</span>')`;
  return `<img class="flag" src="${src}" alt="" loading="lazy" style="width:22px;height:16px;vertical-align:middle;" onerror="${fb}">`;
}

function renderSponsorBox(extraClass = '') {
  if (!currentEnv.hasSponsor) return '';
  return '<div class="sponsor-box ' + extraClass + '">' +
    '<div class="tecsul-logo" aria-label="TECSUL S.A.E.">' +
      '<span class="tec">tec</span><span class="sul">sul<sup class="reg">&reg;</sup><span class="sae">S.A.E.</span></span>' +
    '</div>' +
  '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleReglamento() {
  const body = document.getElementById('regl-body');
  const icon = document.getElementById('regl-icon');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (icon) icon.textContent = open ? '▼' : '▲';
}

// ╔══════════════════════════════════════════════════╗
// ║  6. CAPA DE INTERFAZ Y LOGIN                     ║
// ╚══════════════════════════════════════════════════╝
let currentPlayer = null;
let currentView   = 'predictions';
let predSortMode    = 'fase';   // 'fecha' | 'grupo' | 'fase'
let apuestasSortMode = 'fecha'; // 'fecha' | 'grupo' | 'fase'
let predSortFilter  = 'all';    // sub-filtro activo en Pronósticos
let apuestasFilter  = 'all';    // sub-filtro activo en Mis Apuestas
let adminAuth     = false;

function renderLoginScreen() {
  const players = DB.getPlayers();
  let chips = '';
  if (players.length > 0 && players.length <= 8) {
    let chipItems = '';
    players.forEach(p => {
      const c = color(p.colorIdx);
      chipItems += '<div class="player-chip" data-player-id="'+p.id+'">'+
        '<div class="ava" style="width:28px;height:28px;background:'+c.bg+';color:'+c.tc+';font-size:10px;">'+initials(p.name)+'</div>'+
        '<span>'+p.name+'</span></div>';
    });
    chips = '<div class="login-divider">¿Ya jugás? Seleccioná tu nombre</div>'+
            '<div class="player-chips">'+chipItems+'</div>';
  } else if (players.length > 8) {
    chips = '<div class="login-divider">¿Ya jugás? Ingresá tu nombre y PIN</div>';
  }

  return `
    ${renderSponsorBox('login-sponsor')}
    <div style="text-align:center;">
      <img class="brand-logo" src="albipolla-icon-512-v5.png" alt="ALBIPOLLA">
      <div class="brand-title">ALBIPOLLA</div>
      <div style="font-size:13px;color:var(--text-m);margin-top:.25rem;">Pronósticos entre amigos</div>
    </div>
    <div class="login-box">
      <div>
        <div class="login-title">Tu nombre</div>
        <input id="ln-name" type="text" placeholder="Ej: Diego" maxlength="20" style="width:100%;">
      </div>
      <div>
        <div class="login-title">PIN de 4 dígitos</div>
        <div class="pin-row">
          ${[0,1,2,3].map(i => `<input class="pin-input" id="ln-pin-${i}" type="tel" maxlength="1" inputmode="numeric">`).join('')}
        </div>
      </div>
      <button class="btn btn-primary" id="btn-login-submit" style="width:100%;justify-content:center;">Entrar →</button>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-m);">
        <input type="checkbox" id="ln-remember" style="width:16px;height:16px;accent-color:var(--accent);">
        Recordarme en este dispositivo
      </label>
      ${chips}
    </div>`;
}

function renderPlayerSelect() {
  const el = document.getElementById('player-select');
  if (el) el.innerHTML = renderLoginScreen();
  bindLoginEvents();
}

function hashPin(pin) {
  let h = 0;
  for (let i = 0; i < pin.length; i++) h = (Math.imul(31, h) + pin.charCodeAt(i)) | 0;
  return h.toString(36);
}

function getPin() {
  return [0,1,2,3].map(i => document.getElementById('ln-pin-'+i)?.value || '').join('');
}

function loginWithPin() {
  if (!_playersReady) {
    toast('Cargando jugadores desde Firebase. Esperá unos segundos y reintentá.', 'err');
    return;
  }

  const name = document.getElementById('ln-name')?.value?.trim();
  const pin  = getPin();
  if (!name || name.length < 2) { toast('Ingresá tu nombre','err'); return; }
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { toast('PIN de 4 dígitos numéricos','err'); return; }

  const pinHash = hashPin(pin);
  const players = DB.getPlayers();
  const existing = players.find(p => p.name.toLowerCase() === name.toLowerCase());

  if (existing) {
    if (!existing.pinHash) {
      existing.pinHash = pinHash;
      savePlayersMerged(players);
      const rem = document.getElementById('ln-remember')?.checked;
      doLogin(existing, rem);
    } else if (existing.pinHash === pinHash) {
      const rem = document.getElementById('ln-remember')?.checked;
      doLogin(existing, rem);
    } else {
      toast('PIN incorrecto 🔒','err');
    }
  } else {
    const np = { id:genId(), name, colorIdx:players.length, pinHash, joinedAt:Date.now() };
    players.push(np);
    savePlayersMerged(players);
    toast('¡Bienvenido/a ' + name + '! 🎉','ok');
    const rem = document.getElementById('ln-remember')?.checked;
    doLogin(np, rem);
  }
}

function quickLogin(id) {
  const p = _playerIndex.get(id);
  if (!p) return;
  const nameEl = document.getElementById('ln-name');
  if (nameEl) {
    nameEl.value = p.name;
    document.getElementById('ln-pin-0').focus();
  }
}

function doLogin(p, remember=false) {
  currentPlayer = p;
  sessionStorage.setItem('wc26_cp', JSON.stringify(p));
  if (remember) localStorage.setItem('wc26_remember', JSON.stringify({id: p.id}));
  showApp();
}

function changePlayer() {
  sessionStorage.removeItem('wc26_cp');
  localStorage.removeItem('wc26_remember');
  currentPlayer = null;
  const appEl = document.getElementById('app');
  if (appEl) appEl.style.display = 'none';
  const selEl = document.getElementById('player-select');
  if (selEl) {
    selEl.style.display = 'flex';
    selEl.innerHTML = renderLoginScreen();
  }
  bindLoginEvents();
}

function showApp() {
  const selEl = document.getElementById('player-select');
  if (selEl) selEl.style.display = 'none';
  const appEl = document.getElementById('app');
  if (appEl) appEl.style.display = 'flex';

  const c  = color(currentPlayer.colorIdx);
  const av = document.getElementById('header-ava');
  if (av) {
    av.style.background = c.bg; av.style.color = c.tc;
    av.textContent = initials(currentPlayer.name);
  }
  const nameEl = document.getElementById('header-name');
  if (nameEl) nameEl.textContent = currentPlayer.name;

  navigate('predictions');
  const hasLive = matches.some(m => m.status === 'live');
  scheduleNextRefresh(hasLive);
}

function navigate(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('nav-' + view);
  if (el) el.classList.add('active');
  renderView(view);
}

// ── Captura y Restauración de Inputs (Evita pérdida de datos) ──
function capturePredState() {
  const state = { scores: {}, penWinners: {}, specials: {} };
  document.querySelectorAll('input.score-box').forEach(inp => {
    if (inp.value !== '' && !inp.disabled) state.scores[inp.id] = inp.value;
  });
  document.querySelectorAll('button.pen-btn.active').forEach(btn => {
    const isHome = btn.id.startsWith('pen-h-');
    const matchId = btn.id.slice(6);
    state.penWinners[matchId] = isHome ? 'home' : 'away';
  });
  ['sp-champ','sp-sub','sp-third','sp-scorer'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.disabled && el.value.trim() !== '') state.specials[id] = el.value;
  });
  return state;
}

function restorePredState(state) {
  const restoredIds = new Set();
  Object.entries(state.scores).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && !el.disabled) { el.value = val; restoredIds.add(id.slice(2)); }
  });
  restoredIds.forEach(matchId => checkPenSelector(matchId));
  Object.entries(state.penWinners).forEach(([matchId, side]) => {
    setPenWinner(matchId, side === 'home');
  });
  Object.entries(state.specials).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && !el.disabled) el.value = val;
  });
}

function renderView(v) {
  const c = document.getElementById('main-content');
  if (!c) return;
  
  if (v === 'predictions') {
    const saved = capturePredState();
    renderPredictions(c);
    restorePredState(saved);
  }
  else if (v === 'ranking')     renderRanking(c);
  else if (v === 'grupos')      renderGrupos(c);
  else if (v === 'perfil')      renderPerfil(c);
  else if (v === 'misapuestas') renderMisApuestas(c);
  else if (v === 'admin')       renderAdmin(c);
}

// ╔══════════════════════════════════════════════════╗
// ║  7. COMPONENTES Y VISTAS DE NEGOCIO              ║
// ╚══════════════════════════════════════════════════╝

// ── VISTA DE PREDICCIONES ──
function renderPredictions(con) {
  let reglHtml = reglamentoHTML();
  const preds  = DB.getPredictions();
  const wcs    = DB.getWildcards();
  const myWC   = wcs[currentPlayer.id] || {};
  const special = DB.getSpecial().find(s => s.playerId === currentPlayer.id);

  let html = `<div class="fifa-strip">
    <span class="fifa-source">${fifaSource}</span>
    <button class="fifa-refresh-btn btn" id="btn-fifa-refresh">↻ Actualizar</button>
  </div>`;

  html += reglHtml;

  if (!matches.length) {
    html += `<div class="empty"><div class="empty-icon">📶</div>
      <p style="margin-bottom:1rem;">Conectando con FIFA…</p>
      <div class="loading-row"><span class="loading-dot">●</span><span class="loading-dot"> ●</span><span class="loading-dot"> ●</span></div>
    </div>`;
    con.innerHTML = html; 
    bindPredictionsEvents();
    return;
  }

  // Pronósticos especiales
  const spLocked = new Date() >= MUNDIAL_START;
  const allTeams = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]))].filter(Boolean).sort();
  
  const spRow = (label, id, placeholder, savedVal, type) => {
    const val = savedVal || '';
    if (spLocked) {
      return `<div>
        <div class="form-label">${label}</div>
        <div style="display:flex;gap:8px;">
          <input type="text" style="flex:1;" value="${val}" disabled>
          <span style="padding:10px;font-size:18px;">${val ? '🔒' : '–'}</span>
        </div>
      </div>`;
    }
    return `<div>
      <div class="form-label">${label}</div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="${id}" placeholder="${placeholder}" style="flex:1;" value="${val}" list="sp-teams">
        <button class="btn btn-gold btn-sp-save" data-sp-type="${type}" data-input-id="${id}" style="padding:10px 14px;">${val ? 'Actualizar' : 'Guardar'}</button>
      </div>
    </div>`;
  };
  
  const teamsDatalist = `<datalist id="sp-teams">${allTeams.map(t => `<option value="${t}">`).join('')}</datalist>`;
  
  html += `${teamsDatalist}<div class="special-card">
    <div class="sp-header">
      <div class="sp-icon">🏆</div>
      <div>
        <div class="sp-title">Pronósticos Especiales</div>
        <div class="sp-sub">Hasta 38 puntos en juego · ${spLocked ? '🔒 Cerrados al inicio' : 'Editables hasta el inicio'}</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${spRow('🥇 Campeón del Mundial <span style="color:var(--gold);">+15 pts</span>','sp-champ','País campeón',special?.champion,'champion')}
      ${spRow('🥈 Subcampeón <span style="color:var(--gold);">+8 pts</span>','sp-sub','País subcampeón',special?.subCampeon,'subCampeon')}
      ${spRow('🥉 Tercer puesto <span style="color:var(--gold);">+5 pts</span>','sp-third','País tercer puesto',special?.tercerPuesto,'tercerPuesto')}
      ${spRow('⚽ Goleador del torneo <span style="color:var(--gold);">+10 pts</span>','sp-scorer','Nombre del jugador',special?.topScorer,'scorer')}
    </div>
  </div>`;

  const allSorted    = sortMatchesChronologically(matches);
  const upcoming     = allSorted.filter(m => m.status !== 'finished');
  const finishedList = allSorted.filter(m => m.status === 'finished').reverse();

  // Filtros y ordenamiento
  {
    const modes = [{v:'fase',icon:'🏆',lbl:'Fase'},{v:'grupo',icon:'👥',lbl:'Grupo'},{v:'fecha',icon:'📅',lbl:'Fecha'}];
    let selHtml = '';
    
    if (predSortMode === 'fase') {
      selHtml = '<option value="all">Todas las fases</option>';
      for (const [key, label] of Object.entries(PHASES)) {
        if (allSorted.some(m => m.phase === key))
          selHtml += `<option value="${key}"${predSortFilter===key?' selected':''}>${label}</option>`;
      }
    } else if (predSortMode === 'grupo') {
      selHtml = '<option value="all">Todos los grupos</option>';
      const keys = [], seen = new Set();
      for (const m of allSorted) {
        const k = m.group && m.group !== '?' ? m.group : (m.phase||'?');
        if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
      keys.sort((a,b)=>{
        const aG=/^[A-Z]$/.test(a), bG=/^[A-Z]$/.test(b);
        if(aG&&bG) return a.localeCompare(b);
        if(aG) return -1; if(bG) return 1;
        return Object.keys(PHASES).indexOf(a) - Object.keys(PHASES).indexOf(b);
      });
      for (const k of keys) {
        const lbl = /^[A-Z]$/.test(k) ? 'Grupo '+k : (PHASES[k]||k);
        selHtml += `<option value="${k}"${predSortFilter===k?' selected':''}>${lbl}</option>`;
      }
    } else {
      selHtml = '<option value="all">Todas las fechas</option>';
      const seen = new Set();
      for (const m of allSorted) {
        const d = new Date(m.kickoff||m.date);
        const key = d.toISOString().slice(0,10);
        if (!seen.has(key)) {
          seen.add(key);
          const lbl = new Intl.DateTimeFormat('es-PY',{weekday:'short',day:'2-digit',month:'short'}).format(d);
          selHtml += `<option value="${key}"${predSortFilter===key?' selected':''}>${lbl}</option>`;
        }
      }
    }
    
    html += `<div style="margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;overflow-x:auto;padding-bottom:2px;">
        <span style="font-size:11px;color:var(--text-m);white-space:nowrap;flex-shrink:0;">Ordenar:</span>
        ${modes.map(mode => `<button class="btn btn-secondary btn-sm btn-sort-mode${predSortMode===mode.v?' btn-primary':''}" data-sort-mode="${mode.v}">${mode.icon} ${mode.lbl}</button>`).join('')}
      </div>
      <select id="pred-filter-select" style="font-size:13px;padding:7px 12px;">${selHtml}</select>
    </div>`;
  }

  let filteredUpcoming = upcoming;
  let filteredFinished = finishedList;
  if (predSortFilter !== 'all') {
    const filterFn = m => {
      if (predSortMode === 'fase') return m.phase === predSortFilter;
      if (predSortMode === 'grupo') return (m.group&&m.group!=='?'?m.group:(m.phase||'?')) === predSortFilter;
      if (predSortMode === 'fecha') return new Date(m.kickoff||m.date).toISOString().slice(0,10) === predSortFilter;
      return true;
    };
    filteredUpcoming = upcoming.filter(filterFn);
    filteredFinished = finishedList.filter(filterFn);
  }
  
  const imprevisibleId = getImprevisibleMatchId();

  const cardHTML = (m, pred) => {
    const closed    = isClosed(m);
    const isWC      = isWCUsed(myWC, m);
    const rem       = wcRemaining(myWC, m.phase, m.group);
    const quota     = WC_QUOTA[m.phase] || 0;
    const canWC     = quota > 0 && (rem > 0 || isWC);
    const metaLeft  = m.group && m.group !== '?' ? `Grupo ${m.group}` : (PHASES[m.phase]||m.phase);
    const metaRight = fmtDate(m.kickoff || m.date);
    const isLiveMatch = m.status === 'live';
    const liveTimeStr = isLiveMatch
      ? (m.liveDetail === 'Descanso' ? '⏱ Descanso' : m.liveMinute ? `⏱ ${m.liveMinute}'` : '⏱ En juego')
      : '';
      
    return `<div class="match-card ${pred?'has-pred':''} ${closed?'closed':''}">
        <div class="match-meta">
          <span>${metaLeft}${m.city?' · '+m.city:''}</span>
          <span>${metaRight}</span>
        </div>
        ${m.id===imprevisibleId ? `<div style="display:flex;align-items:center;gap:5px;padding:5px 10px;margin-bottom:4px;background:rgba(251,191,36,.08);border:.5px solid rgba(251,191,36,.3);border-radius:6px;font-size:11px;color:var(--gold);font-weight:600;">🎲 Partido Imprevisible · Apuestas divididas</div>` : ''}
        <div class="match-body">
          <div class="team-side">
            <div class="team-flag">${renderFlag(m.homeCode, m.homeTeam)}</div>
            <div class="team-name">${m.homeTeam}</div>
          </div>
          <div class="score-area" ${isLiveMatch?'style="flex-direction:column;align-items:center;gap:3px;"':''}>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" class="score-box score-input" id="h-${m.id}" data-match-id="${m.id}" min="0" max="20" placeholder="–"
                value="${pred!=null?pred.homeScore:''}" ${closed?'disabled':''}>
              <span class="score-sep">:</span>
              <input type="number" class="score-box score-input" id="a-${m.id}" data-match-id="${m.id}" min="0" max="20" placeholder="–"
                value="${pred!=null?pred.awayScore:''}" ${closed?'disabled':''}>
            </div>
            ${isLiveMatch?`<div style="font-size:11px;font-weight:700;color:#f97316;letter-spacing:.03em;">${liveTimeStr}</div>`:''}
            ${isLiveMatch&&m.homeScore!==null?`<div style="font-size:15px;font-weight:800;color:#f97316;font-family:var(--fd);letter-spacing:.05em;">${m.homeScore}–${m.awayScore}</div>`:''}
          </div>
          <div class="team-side">
            <div class="team-flag">${renderFlag(m.awayCode, m.awayTeam)}</div>
            <div class="team-name">${m.awayTeam}</div>
          </div>
        </div>
        ${(() => {
          if (!PLAYOFF_PHASES.has(m.phase)) return '';
          if (closed) {
            if (!pred?.penWinner) return '';
            const penName = pred.penWinner===m.homeCode ? m.homeTeam : pred.penWinner===m.awayCode ? m.awayTeam : pred.penWinner;
            return `<div style="margin-top:8px;font-size:11px;color:var(--text-m);padding:6px 10px;background:var(--bg-el);border-radius:var(--radius-s);">⚽ Gana en penales: <strong style="color:var(--text);">${penName}</strong></div>`;
          }
          const initDraw = pred && pred.homeScore===pred.awayScore;
          const hActive  = pred?.penWinner===m.homeCode;
          const aActive  = pred?.penWinner===m.awayCode;
          return `<div class="pen-selector" id="pen-row-${m.id}" style="display:${initDraw?'block':'none'};">
            <div class="pen-label">⚽ ¿Quién gana en penales?</div>
            <div class="pen-btns">
              <button class="pen-btn btn-set-pen${hActive?' active':''}" id="pen-h-${m.id}" data-match-id="${m.id}" data-home="true">${m.homeTeam}</button>
              <button class="pen-btn btn-set-pen${aActive?' active':''}" id="pen-a-${m.id}" data-match-id="${m.id}" data-home="false">${m.awayTeam}</button>
            </div>
          </div>`;
        })()}
        <div class="match-footer">
          ${closed
            ? `<span class="closed-lbl">🔒 ${m.status==='finished'?'Finalizado':'Cerrado'}</span>`
            : quota > 0
              ? `<button class="wc-btn btn-toggle-wc ${isWC?'active':''}" id="wc-${m.id}" data-match-id="${m.id}" ${!canWC?'disabled':''}
                  title="${isWC?'Quitar redoblona':rem>0?'Usar redoblona (×2 pts)':'Ya usaste tu redoblona'}">
                  🎯 ${isWC?'Redoblona ×2':'Redoblona'}
                </button>`
              : ''}
          <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap;">
            ${closed&&m.status!=='live'
              ? `<span class="pill pill-info">${pred!=null?pred.homeScore+'-'+pred.awayScore:'Sin pronóstico'}</span>`
              : !closed&&pred!=null
                ? `<button class="btn-save editing btn-save-pred" id="sv-${m.id}" data-match-id="${m.id}">✏️ Actualizar</button>`
                : !closed
                  ? `<button class="btn-save btn-save-pred" id="sv-${m.id}" data-match-id="${m.id}">Guardar</button>`
                  : ''}
          </div>
        </div>
        ${!closed ? renderTrends(m.id) : ''}
        ${canSeeBets(m) ? renderBetsPanel(m) : ''}
      </div>`;
  };

  if (predSortMode === 'fecha') {
    for (const m of filteredUpcoming) {
      html += cardHTML(m, _predictionIndex.get(`${currentPlayer.id}::${m.id}`));
    }
  } else if (predSortMode === 'grupo') {
    const byKey = {}, keyOrder = [];
    for (const m of filteredUpcoming) {
      const key = m.group && m.group !== '?' ? m.group : (m.phase||'?');
      if (!byKey[key]) { byKey[key]=[]; keyOrder.push(key); }
      byKey[key].push(m);
    }
    keyOrder.sort((a,b) => {
      const aG=/^[A-Z]$/.test(a), bG=/^[A-Z]$/.test(b);
      if(aG&&bG) return a.localeCompare(b);
      if(aG) return -1; if(bG) return 1;
      return Object.keys(PHASES).indexOf(a) - Object.keys(PHASES).indexOf(b);
    });
    for (const key of keyOrder) {
      html += `<div class="sec-title">${/^[A-Z]$/.test(key)?'Grupo '+key:(PHASES[key]||key)}</div>`;
      for (const m of byKey[key]) {
        html += cardHTML(m, _predictionIndex.get(`${currentPlayer.id}::${m.id}`));
      }
    }
  } else {
    const byPhase = {};
    for (const m of filteredUpcoming) {
      (byPhase[m.phase] = byPhase[m.phase] || []).push(m);
    }
    const order = Object.keys(PHASES);
    Object.keys(byPhase).sort((a,b) => order.indexOf(a) - order.indexOf(b)).forEach(ph => {
      html += `<div class="sec-title">${PHASES[ph]||ph}</div>`;
      for (const m of byPhase[ph]) {
        html += cardHTML(m, _predictionIndex.get(`${currentPlayer.id}::${m.id}`));
      }
    });
  }

  // Resultados pasados
  if (filteredFinished.length > 0) {
    html += '<div class="sec-title">Resultados finalizados</div>';
    for (const m of filteredFinished) {
      html += cardHTML(m, _predictionIndex.get(`${currentPlayer.id}::${m.id}`));
    }
  }

  con.innerHTML = html;
  bindPredictionsEvents();
}

function checkPenSelector(matchId) {
  const h = document.getElementById('h-'+matchId)?.value;
  const a = document.getElementById('a-'+matchId)?.value;
  const row = document.getElementById('pen-row-'+matchId);
  if (!row) return;
  const isDraw = h!=='' && a!=='' && parseInt(h)===parseInt(a);
  row.style.display = isDraw ? 'block' : 'none';
  if (!isDraw) {
    document.getElementById('pen-h-'+matchId)?.classList.remove('active');
    document.getElementById('pen-a-'+matchId)?.classList.remove('active');
  }
}

function setPenWinner(matchId, isHome) {
  const hBtn = document.getElementById('pen-h-'+matchId);
  const aBtn = document.getElementById('pen-a-'+matchId);
  if (isHome) { hBtn?.classList.add('active'); aBtn?.classList.remove('active'); }
  else        { aBtn?.classList.add('active'); hBtn?.classList.remove('active'); }
}

async function savePred(matchId) {
  const h = document.getElementById('h-'+matchId).value;
  const a = document.getElementById('a-'+matchId).value;
  if (h===''||a==='') { toast('Ingresá ambos marcadores','err'); return; }
  const m = matches.find(x => x.id === matchId);
  if (m && isClosed(m)) { toast('El partido ya no acepta pronósticos','err'); return; }
  const hInt = parseInt(h), aInt = parseInt(a);
  let penWinner = null;
  if (PLAYOFF_PHASES.has(m?.phase) && hInt===aInt) {
    if (document.getElementById('pen-h-'+matchId)?.classList.contains('active')) penWinner = m.homeCode;
    else if (document.getElementById('pen-a-'+matchId)?.classList.contains('active')) penWinner = m.awayCode;
  }
  const existing = _predictionIndex.get(`${currentPlayer.id}::${matchId}`);
  const rec = { id:existing?.id || genId(), playerId:currentPlayer.id, matchId, homeScore:hInt, awayScore:aInt };
  if (penWinner) rec.penWinner = penWinner;
  const btn = document.getElementById('sv-'+matchId);
  if (btn) { btn.textContent='Guardando...'; btn.disabled=true; }
  const saved = await savePredictionMerged(rec);
  if (btn) btn.disabled=false;
  if (!saved) {
    if (btn) { btn.textContent='Guardar'; btn.classList.remove('saved'); }
    toast('No se pudo guardar. Revisá conexión','err');
    return;
  }
  if (btn) { btn.textContent='✓ Guardado'; btn.classList.add('saved'); }
  toast('Pronóstico guardado ✓','ok');
}

function toggleWC(matchId) {
  const m = matches.find(x => x.id===matchId);
  if (!m || isClosed(m)) return;
  if ((WC_QUOTA[m.phase]||0) === 0) { toast('No hay redoblona disponible en esta fase','err'); return; }
  const wcs = DB.getWildcards();
  let wcData = wcs[currentPlayer.id] || {};
  const currently = isWCUsed(wcData, m);
  if (currently) {
    if (m.phase==='grupos') {
      if (!wcData.grupos) wcData.grupos={};
      delete wcData.grupos[m.group];
    } else {
      const used = wcData[m.phase] || [];
      const arr = Array.isArray(used) ? used : [used];
      wcData[m.phase] = arr.filter(id=>id!==matchId);
      if (wcData[m.phase].length===0) delete wcData[m.phase];
    }
    toast('Redoblona quitada');
  } else {
    const rem = wcRemaining(wcData, m.phase, m.group);
    if (rem <= 0) { toast('No te quedan redoblones en esta fase','err'); return; }
    if (m.phase==='grupos') {
      if (!wcData.grupos) wcData.grupos={};
      wcData.grupos[m.group] = matchId;
    } else {
      if (!wcData[m.phase]) wcData[m.phase]=[];
      if (!Array.isArray(wcData[m.phase])) wcData[m.phase]=[wcData[m.phase]];
      wcData[m.phase].push(matchId);
    }
    toast('🎯 Redoblona activada — puntos ×2','ok');
  }
  wcs[currentPlayer.id] = wcData;
  DB.saveWildcards(wcs);
  renderView(currentView);
}

function saveSpecial(type) {
  if (new Date() >= MUNDIAL_START) { toast('Los pronósticos especiales están cerrados','err'); return; }
  const idMap = { champion:'sp-champ', subCampeon:'sp-sub', tercerPuesto:'sp-third', scorer:'sp-scorer' };
  const val = document.getElementById(idMap[type])?.value.trim();
  if (!val) { toast('Ingresá el valor','err'); return; }
  const specials = DB.getSpecial();
  let sp = specials.find(s => s.playerId===currentPlayer.id);
  if (!sp) { sp={id:genId(),playerId:currentPlayer.id}; specials.push(sp); }
  if (type==='champion') sp.champion=val;
  else if (type==='subCampeon') sp.subCampeon=val;
  else if (type==='tercerPuesto') sp.tercerPuesto=val;
  else sp.topScorer=val;
  DB.saveSpecial(specials);
  toast('Pronóstico especial guardado 🏆','ok');
  renderView('predictions');
}

// ── RENDER DE TENDENCIAS ──
function renderTrends(matchId) {
  const allPreds = DB.getPredictions().filter(p => p.matchId === matchId && _playerIndex.has(p.playerId));
  const total = allPreds.length;
  const players = DB.getPlayers();
  if (!total) return `<div class="trends-box"><div class="trends-title">📊 Tendencias · Nadie apostó todavía</div></div>`;

  const homeWins = allPreds.filter(p => p.homeScore > p.awayScore).length;
  const draws    = allPreds.filter(p => p.homeScore === p.awayScore).length;
  const awayWins = allPreds.filter(p => p.homeScore < p.awayScore).length;
  const m = matches.find(x => x.id === matchId);

  const bar = (count, color) => {
    const pct = total > 0 ? Math.round(count/total*100) : 0;
    return `<div class="trend-row">
      <span class="trend-label">${color === '#4ade80' ? (m?.homeTeam?.split(' ')[0]||'Local') : color === '#94a3b8' ? 'Empate' : (m?.awayTeam?.split(' ')[0]||'Visit.')}</span>
      <div class="trend-bar-wrap"><div class="trend-bar" style="width:${pct}%;background:${color};"></div></div>
      <span class="trend-pct" style="color:${color};">${pct}%</span>
    </div>`;
  };

  const scoreCounts = {};
  for (const p of allPreds) {
    const k = `${p.homeScore}-${p.awayScore}`;
    scoreCounts[k] = (scoreCounts[k]||0)+1;
  }
  const topScores = Object.entries(scoreCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const topHtml = topScores.map(([sc, n]) =>
    `<span style="font-size:11px;background:var(--bg-card);padding:2px 8px;border-radius:4px;border:.5px solid var(--border-md);">${sc} <span style="color:var(--text-m);">(${n})</span></span>`
  ).join('');

  return `<div class="trends-box">
    <div class="trends-title">📊 Tendencias · ${total} de ${players.length} apostaron</div>
    ${bar(homeWins,'#4ade80')}
    ${bar(draws,'#94a3b8')}
    ${bar(awayWins,'#60a5fa')}
    ${topScores.length ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${topHtml}</div>` : ''}
  </div>`;
}

// ── APUESTAS Y COMENTARIOS DE UN PARTIDO (ACORDEÓN) ──
function renderBetsPanel(m) {
  const isLive = m.status === 'live';
  const label  = isLive ? '⏱ Apuestas en vivo' : m.status === 'finished' ? '✅ Apuestas finales' : '🔒 Apuestas (Cerrado)';
  const wcData = DB.getWildcards();
  const finished = m.status === 'finished';

  let rowsHTML = '';
  const players = DB.getPlayers();
  
  for (const pl of players) {
    const pred = _predictionIndex.get(`${pl.id}::${m.id}`);
    if (!pred) continue;

    const isMe  = pl.id === currentPlayer.id;
    const isWC  = isWCUsed(wcData[pl.id] || {}, m);
    const res   = betResult(pred, m.homeScore, m.awayScore);
    const pp    = provPtsForMatch(pl.id, m.id);
    const risk  = m.status === 'finished' && calcPtsBase(pred, m.homeScore, m.awayScore) > 0 ? calcRiskBonus(pred, m.homeScore, m.awayScore, m.id) : 0;
    const isExact = res === 'exact';
    const isPart  = res === 'partial';
    const isWrong = res === 'wrong';

    let rowBg = '';
    if (isExact)      rowBg = 'background:rgba(74,222,128,.04)';
    else if (isPart)  rowBg = 'background:rgba(245,158,11,.04)';
    else if (isWrong) rowBg = 'background:rgba(248,113,113,.04)';

    const ptsLbl = ptsLabel(pp, res, isWC);
    const ptsCls = isExact ? 'exact' : isPart ? 'partial' : isWrong ? 'wrong' : 'pending';
    const breakdown = pointsBreakdownForMatch(pl.id, m, pred);
    const bdId = `bd-${pl.id}-${m.id}`;

    // Optimizando render del breakdown de puntos
    const ptsHTML = breakdown
      ? `<button type="button" class="bet-pts pts-toggle ${ptsCls} btn-toggle-breakdown" data-breakdown-id="${bdId}" title="Ver desglose">${ptsLbl}</button>`
      : `<span class="bet-pts ${ptsCls}">${ptsLbl}</span>`;

    rowsHTML += `<div class="bet-row ${isMe?'is-me':''}" style="${rowBg}">
      ${avaEl(pl, 26)}
      <span style="font-size:13px;flex:1;${isMe?'font-weight:600;':''}">${pl.name}${isMe?' <span style="font-size:10px;color:var(--accent);">(vos)</span>':''}</span>
      ${isWC?'<span class="bet-badge">🎯</span>':''}
      ${risk>0?`<span class="risk-badge">🎲+${risk}</span>`:''}
      <div style="flex-shrink:0;min-width:38px;text-align:center;">
        <div style="font-family:var(--fd);font-size:16px;font-weight:700;letter-spacing:.03em;">${pred.homeScore}-${pred.awayScore}</div>
        ${m.homeScore !== null ? `<div style="font-size:10px;font-weight:600;margin-top:2px;color:${isLive?'#f97316':'var(--text-m)'};">${isLive?'⏱ ':'✅ '}${m.homeScore}-${m.awayScore}</div>` : ''}
      </div>
      ${ptsHTML}
      ${renderPointsBreakdownHTML(bdId, breakdown)}
    </div>`;
  }

  return `<div class="bets-toggle" id="bt-${m.id}" data-match-id="${m.id}">
      <span>${label}</span>
      <span class="toggle-icon">▼</span>
    </div>
    <div class="bets-panel" id="bp-${m.id}">
      ${rowsHTML}
      ${renderChatPanel(m.id)}
    </div>`;
}

function renderPointsBreakdownHTML(id, breakdown) {
  if (!breakdown) return '';
  const rows = breakdown.rows.map(r =>
    `<div class="points-breakdown-row${r.total?' points-breakdown-total':''}">
      <span>${escapeHtml(r.label)}</span>
      <span>${escapeHtml(r.value)}</span>
    </div>`
  ).join('');
  return `<div class="points-breakdown" id="${id}">${rows}</div>`;
}

function betResult(pred, hScore, aScore) {
  if (hScore===null||aScore===null) return 'pending';
  if (pred.homeScore===hScore && pred.awayScore===aScore) return 'exact';
  if (outcome(pred.homeScore,pred.awayScore)===outcome(hScore,aScore)) return 'partial';
  return 'wrong';
}

function ptsLabel(pts, res, isWC) {
  if (pts===null) return '–';
  if (pts===0) return res==='wrong'?'✗ 0':'–';
  return (isWC?'🎯 ':'')+'+'+pts+' pts';
}

function canSeeBets(m) {
  return m.status==='live' || m.status==='finished' || isClosed(m);
}

function isClosed(m) {
  if (m.status==='finished'||m.status==='live'||m.status==='closed') return true;
  if (!m.kickoff && !m.date) return false;
  return new Date(m.kickoff||m.date) <= new Date();
}

function fmtAgo(ts) {
  const diff=Date.now()-ts;
  if (diff<60000) return 'ahora';
  if (diff<3600000) return Math.floor(diff/60000)+'min';
  if (diff<86400000) return Math.floor(diff/3600000)+'h';
  return Math.floor(diff/86400000)+'d';
}

// ── COMENTARIOS Y CHAT INDEPENDIENTE ──
function renderChatPanel(matchId) {
  const m = matches.find(x => x.id===matchId);
  const canChat = canSeeBets(m);
  if (!canChat) return '<div class="chat-section"><div class="chat-locked">💬 Los comentarios se abren cuando empieza el partido</div></div>';
  const msgs = DB.getChat(matchId);
  const players = DB.getPlayers();
  
  let html=`<div class="chat-section" id="chat-${matchId}">
    <div class="chat-title">💬 Comentarios (${msgs.length})</div>
    <div class="chat-messages" id="chat-msgs-${matchId}">`;
    
  if (!msgs.length) {
    html+='<div style="font-size:12px;color:var(--text-d);text-align:center;padding:10px;">Sé el primero en comentar</div>';
  } else {
    for (const msg of msgs) {
      const sender=_playerIndex.get(msg.playerId) || {name:'?',colorIdx:0};
      const isMe=msg.playerId===currentPlayer.id;
      const c=color(sender.colorIdx);
      const timeAgo=fmtAgo(msg.ts);
      const myReactions=msg.reactions||{};
      html+=`<div class="chat-msg ${isMe?'mine':''}">
        <div class="ava" style="width:26px;height:26px;background:${c.bg};color:${c.tc};font-size:10px;flex-shrink:0;">${initials(sender.name)}</div>
        <div>
          <div class="chat-bubble">${escapeHtml(msg.text)}</div>
          <div class="chat-meta">${isMe?'Vos':sender.name} · ${timeAgo}</div>
          <div class="chat-reactions">
            ${REACTIONS.map(emoji => {
              const who = myReactions[emoji] || [];
              const hasReacted = who.includes(currentPlayer.id);
              const count = who.length;
              return `<button class="react-btn ${hasReacted?'reacted':''} btn-chat-reaction" data-match-id="${matchId}" data-msg-id="${msg.id}" data-emoji="${emoji}">
                ${emoji}${count>0?`<span class="react-count">${count}</span>`:''}
              </button>`;
            }).join('')}
          </div>
        </div>
      </div>`;
    }
  }
  html+=`</div>
    <div class="chat-input-row">
      <input class="chat-input chat-text-input" id="chat-in-${matchId}" data-match-id="${matchId}" placeholder="Escribí algo..." maxlength="120">
      <button class="chat-send btn-send-chat" data-match-id="${matchId}">➤</button>
    </div>
  </div>`;
  return html;
}

// Envío y actualización dirigida del DOM del Chat para no romper inputs
function sendChat(matchId) {
  const inp=document.getElementById('chat-in-'+matchId);
  if (!inp) return;
  const text=inp.value.trim();
  if (!text) return;
  const msgs=DB.getChat(matchId);
  msgs.push({id:genId(),playerId:currentPlayer.id,text,ts:Date.now(),reactions:{}});
  DB.saveChat(matchId,msgs);
  inp.value='';
  
  // Renderizar selectivamente solo el chat de esta tarjeta
  const chatSection = document.getElementById('chat-'+matchId);
  if (chatSection) {
    const parent = chatSection.parentElement;
    if (parent) {
      parent.innerHTML = renderBetsPanel(matches.find(x => x.id === matchId)) 
        + renderChatPanel(matchId);
      // Volver a enlazar eventos
      bindPredictionsEvents();
    }
  }
  toast('💬 Enviado','ok');
}

function toggleReaction(matchId, msgId, emoji) {
  const msgs=DB.getChat(matchId);
  const msg=msgs.find(x=>x.id===msgId);
  if (!msg) return;
  if (!msg.reactions) msg.reactions={};
  if (!msg.reactions[emoji]) msg.reactions[emoji]=[];
  const idx=msg.reactions[emoji].indexOf(currentPlayer.id);
  if (idx>=0) msg.reactions[emoji].splice(idx,1);
  else msg.reactions[emoji].push(currentPlayer.id);
  DB.saveChat(matchId,msgs);
  
  // Re-render selectivo
  const chatSection = document.getElementById('chat-'+matchId);
  if (chatSection) {
    const parent = chatSection.parentElement;
    if (parent) {
      parent.innerHTML = renderBetsPanel(matches.find(x => x.id === matchId)) 
        + renderChatPanel(matchId);
      bindPredictionsEvents();
    }
  }
}

// ── VISTA DE MIS APUESTAS ──
function renderMisApuestas(con) {
  const myPreds=DB.getPredictions().filter(p=>p.playerId===currentPlayer.id);
  const wcData=DB.getWildcards()[currentPlayer.id]||{};
  const allM=sortMatchesChronologically(matches);
  const sc=scorePlayer(currentPlayer.id);
  
  let html=`<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
    <div class="card" style="text-align:center;padding:12px 8px;">
      <div style="font-size:11px;color:var(--text-m);">Apostados</div>
      <div style="font-family:var(--fd);font-size:28px;font-weight:700;color:var(--accent);">${myPreds.length}</div>
      <div style="font-size:10px;color:var(--text-d);">de ${allM.length}</div>
    </div>
    <div class="card" style="text-align:center;padding:12px 8px;">
      <div style="font-size:11px;color:var(--text-m);">Pendientes</div>
      <div style="font-family:var(--fd);font-size:28px;font-weight:700;color:var(--danger);">${allM.filter(m=>m.status==='upcoming'&&!_predictionIndex.has(`${currentPlayer.id}::${m.id}`)).length}</div>
      <div style="font-size:10px;color:var(--text-d);">por cargar</div>
    </div>
    <div class="card" style="text-align:center;padding:12px 8px;">
      <div style="font-size:11px;color:var(--text-m);">Mis pts</div>
      <div style="font-family:var(--fd);font-size:28px;font-weight:700;color:var(--accent);">${sc.pts}</div>
      <div style="font-size:10px;color:var(--text-d);">${sc.exact} exactos</div>
    </div>
  </div>
  <div style="display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;padding-bottom:2px;">
    <button class="btn btn-secondary btn-sm btn-filter-apuestas btn-primary" data-filter="all" id="fa-all">Todos</button>
    <button class="btn btn-secondary btn-sm btn-filter-apuestas" data-filter="pending" id="fa-pending">Sin cargar</button>
    <button class="btn btn-secondary btn-sm btn-filter-apuestas" data-filter="exact" id="fa-exact">🎯 Exactos</button>
    <button class="btn btn-secondary btn-sm btn-filter-apuestas" data-filter="wrong" id="fa-wrong">✗ Perdidos</button>
  </div>
  <div id="apuestas-list">`;

  // Barra de ordenamiento
  {
    const modes=[{v:'fecha',icon:'📅',lbl:'Fecha'},{v:'grupo',icon:'👥',lbl:'Grupo'},{v:'fase',icon:'🏆',lbl:'Fase'}];
    let selHtml='';
    if(apuestasSortMode==='fase'){
      selHtml='<option value="all">Todas las fases</option>';
      for(const [key,label] of Object.entries(PHASES)){
        if(allM.some(m=>m.phase===key))
          selHtml+=`<option value="${key}"${apuestasFilter===key?' selected':''}>${label}</option>`;
      }
    }else if(apuestasSortMode==='grupo'){
      selHtml='<option value="all">Todos los grupos</option>';
      const keys=[],seen=new Set();
      for(const m of allM){const k=m.group&&m.group!=='?'?m.group:(m.phase||'?');if(!seen.has(k)){seen.add(k);keys.push(k);}}
      keys.sort((a,b)=>{const aG=/^[A-Z]$/.test(a),bG=/^[A-Z]$/.test(b);if(aG&&bG)return a.localeCompare(b);if(aG)return -1;if(bG)return 1;return Object.keys(PHASES).indexOf(a)-Object.keys(PHASES).indexOf(b);});
      for(const k of keys){const lbl=/^[A-Z]$/.test(k)?'Grupo '+k:(PHASES[k]||k);selHtml+=`<option value="${k}"${apuestasFilter===k?' selected':''}>${lbl}</option>`;}
    }else{
      selHtml='<option value="all">Todas las fechas</option>';
      const seen=new Set();
      for(const m of allM){
        const d=new Date(m.kickoff||m.date);
        const key=d.toISOString().slice(0,10);
        if(!seen.has(key)){
          seen.add(key);
          const lbl=new Intl.DateTimeFormat('es-PY',{weekday:'short',day:'2-digit',month:'short'}).format(d);
          selHtml+=`<option value="${key}"${apuestasFilter===key?' selected':''}>${lbl}</option>`;
        }
      }
    }
    
    html+=`<div style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;overflow-x:auto;padding-bottom:2px;">
        <span style="font-size:11px;color:var(--text-m);white-space:nowrap;flex-shrink:0;">Ordenar:</span>
        ${modes.map(mode=>`<button class="btn btn-secondary btn-sm btn-apuestas-sort${apuestasSortMode===mode.v?' btn-primary':''}" data-sort-mode="${mode.v}">${mode.icon} ${mode.lbl}</button>`).join('')}
      </div>
      <select id="apuestas-filter-select" style="font-size:13px;padding:7px 12px;">${selHtml}</select>
    </div>`;
  }

  let filteredM=allM;
  if(apuestasFilter!=='all'){
    filteredM=allM.filter(m=>{
      if(apuestasSortMode==='fase') return m.phase===apuestasFilter;
      if(apuestasSortMode==='grupo') return (m.group&&m.group!=='?'?m.group:(m.phase||'?'))===apuestasFilter;
      if(apuestasSortMode==='fecha') return new Date(m.kickoff||m.date).toISOString().slice(0,10)===apuestasFilter;
      return true;
    });
  }

  const apuestaGroups = [];
  if (apuestasSortMode === 'grupo') {
    const byKey={}, keyOrder=[];
    for(const m of filteredM){
      const key=m.group&&m.group!=='?'?m.group:(m.phase||'?');
      if(!byKey[key]){byKey[key]=[];keyOrder.push(key);}
      byKey[key].push(m);
    }
    keyOrder.sort((a,b)=>{const aG=/^[A-Z]$/.test(a),bG=/^[A-Z]$/.test(b);if(aG&&bG)return a.localeCompare(b);if(aG)return -1;if(bG)return 1;return Object.keys(PHASES).indexOf(a)-Object.keys(PHASES).indexOf(b);});
    for(const key of keyOrder) apuestaGroups.push({hdr:/^[A-Z]$/.test(key)?'Grupo '+key:(PHASES[key]||key),matches:byKey[key]});
  } else if (apuestasSortMode === 'fase') {
    const byPhase={};
    for(const m of filteredM){(byPhase[m.phase]=byPhase[m.phase]||[]).push(m);}
    const phOrd=Object.keys(PHASES);
    Object.keys(byPhase).sort((a,b)=>phOrd.indexOf(a)-phOrd.indexOf(b)).forEach(ph=>apuestaGroups.push({hdr:PHASES[ph]||ph,matches:byPhase[ph]}));
  } else {
    apuestaGroups.push({matches:filteredM});
  }

  for(const grp of apuestaGroups){
    if(grp.hdr) html+=`<div style="font-size:11px;font-weight:600;color:var(--text-m);text-transform:uppercase;letter-spacing:.06em;padding:6px 2px 4px;margin-top:2px;">${grp.hdr}</div>`;
    for (const m of grp.matches) {
      const pred=_predictionIndex.get(`${currentPlayer.id}::${m.id}`);
      const isWC=isWCUsed(wcData, m);
      const pp=pred&&m.homeScore!==null?provPtsForMatch(currentPlayer.id,m.id):null;
      const res=pred&&m.homeScore!==null?betResult(pred,m.homeScore,m.awayScore):'pending';
      const isOpen=m.status==='upcoming'&&!isClosed(m);
      const isLive=m.status==='live';
      const isFin=m.status==='finished';
      
      let rowBg='background:var(--bg-card)', statusIcon='', statusClass='';
      if (!pred&&isOpen){rowBg='background:rgba(248,113,113,.05)';statusIcon='⚠️';statusClass='pending';}
      else if(!pred){statusIcon='–';statusClass='none';}
      else if(res==='exact'){rowBg='background:rgba(74,222,128,.06)';statusIcon='🎯';statusClass='exact';}
      else if(res==='partial'){rowBg='background:rgba(245,158,11,.06)';statusIcon='✓';statusClass='partial';}
      else if(res==='wrong'){rowBg='background:rgba(248,113,113,.06)';statusIcon='✗';statusClass='wrong';}
      else if(pred&&isOpen){statusIcon='✓';statusClass='saved';}
      else if(pred&&isLive){statusIcon='⏱';statusClass='live';}
      
      const ptsStr=pp!==null?ptsLabel(pp,res,isWC):'–';
      const ptsCls=res==='exact'?'exact':res==='partial'?'partial':res==='wrong'?'wrong':'pending';
      
      html+=`<div class="apuesta-row" data-status="${statusClass}" style="display:flex;align-items:center;gap:9px;padding:9px 12px;${rowBg};border-radius:var(--radius-s);border:.5px solid var(--border);margin-bottom:6px;">
        <div style="font-size:16px;flex-shrink:0;width:20px;text-align:center;">${statusIcon}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${m.homeTeam} vs ${m.awayTeam}${isWC?' 🎯':''}
          </div>
          <div style="font-size:11px;color:var(--text-m);">${(PHASES[m.phase]||m.phase)}${m.group?' · Gr.'+m.group:''}
            ${isLive?`<span class="live-badge"><span class="live-dot"></span>${m.homeScore!==null?m.homeScore+'-'+m.awayScore+' · ':''}${m.liveDetail==='Descanso'?'Descanso':m.liveMinute?m.liveMinute+"'":'En vivo'}</span>`:''}
            ${isFin&&m.homeScore!==null?` · ${m.homeScore}-${m.awayScore}`:''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${pred?`<div style="font-family:var(--fd);font-size:15px;font-weight:700;">${pred.homeScore}-${pred.awayScore}</div>`:''}
          ${m.homeScore!==null&&(isLive||isFin)?`<div style="font-size:10px;font-weight:600;margin-top:2px;color:${isLive?'#f97316':'var(--text-m)'}">${isLive?'⏱ ':'✅ '}${m.homeScore}-${m.awayScore}</div>`:''}
          <div class="bet-pts ${ptsCls}">${ptsStr}</div>
        </div>
        ${isOpen&&!pred?'<button class="btn-save btn-goto-load" style="flex-shrink:0;padding:5px 10px;font-size:11px;">Cargar</button>':''}
      </div>`;
    }
  }
  html+='</div>';
  con.innerHTML=html;
  bindApuestasEvents();
}

function filterApuestas(filter) {
  document.querySelectorAll('.btn-filter-apuestas').forEach(b=>b.classList.remove('btn-primary'));
  const btn=document.getElementById('fa-'+filter);
  if (btn) btn.classList.add('btn-primary');
  
  document.querySelectorAll('.apuesta-row').forEach(row=>{
    const st=row.dataset.status;
    let show=true;
    if (filter==='pending') show=st==='pending';
    else if (filter==='exact') show=st==='exact';
    else if (filter==='wrong') show=st==='wrong';
    row.style.display=show?'flex':'none';
  });
}

// ── VISTA DE RANKING ──
let rankingView = 'general';

function getMvpData() {
  const jornadasMap = {};
  for (const m of matches.filter(x => x.status === 'finished')) {
    const day = new Date(m.kickoff||m.date).toDateString();
    jornadasMap[day] = true;
  }
  const sortedDays = Object.keys(jornadasMap).sort((a, b) => new Date(a) - new Date(b));
  const mvpCounts  = {};
  const mvpHistory = [];

  sortedDays.forEach((day, i) => {
    const scores = scoresByJornada(day).filter(p => p.pts > 0);
    if (!scores.length) return;
    const topPts   = scores[0].pts;
    const winners  = scores.filter(p => p.pts === topPts);
    winners.forEach(w => { mvpCounts[w.id] = (mvpCounts[w.id] || 0) + 1; });
    mvpHistory.push({ day, winners, pts: topPts, jNum: i + 1 });
  });

  const lastMvp = mvpHistory.length ? mvpHistory[mvpHistory.length - 1] : null;
  return { mvpCounts, lastMvp };
}

function scoresByJornada(jornadaKey) {
  const dayMatches = matches.filter(m => {
    const day = new Date(m.kickoff||m.date).toDateString();
    return m.status==='finished' && day===jornadaKey;
  });
  return DB.getPlayers().map(p => ({
    ...p,
    pts: dayMatches.reduce((sum, m) => sum + ptsEarnedInMatch(p.id, m.id), 0),
    games: dayMatches.filter(m => _predictionIndex.has(`${p.id}::${m.id}`)).length,
  })).sort((a, b) => b.pts - a.pts);
}

function renderRanking(con) {
  const scores = allScores();
  if (!scores.length) {
    con.innerHTML='<div class="empty"><div class="empty-icon">👥</div><p>Aún no hay jugadores registrados.</p></div>'; return;
  }

  const jornadasMap = {};
  for (const m of matches.filter(x => x.status === 'finished')) {
    const day = new Date(m.kickoff||m.date).toDateString();
    jornadasMap[day] = (jornadasMap[day] || 0) + 1;
  }
  const jornadas = Object.keys(jornadasMap);

  let tabsHTML = `<div class="jornada-tabs">
    <button class="jornada-tab btn-tab-rank ${rankingView==='general' ? 'active' : ''}" data-target="general">📊 General</button>`;
  jornadas.forEach((day, i) => {
    tabsHTML += `<button class="jornada-tab btn-tab-rank ${rankingView===day ? 'active' : ''}" data-target="${day}">Jornada ${i+1}</button>`;
  });
  tabsHTML += '</div>';

  const { mvpCounts, lastMvp } = getMvpData();

  if (rankingView !== 'general') {
    const jScores    = scoresByJornada(rankingView).filter(p => p.games > 0 || p.pts > 0);
    const dayMatches = matches.filter(m => new Date(m.kickoff||m.date).toDateString() === rankingView && m.status === 'finished');
    const matchSummary = dayMatches.map(m => m.homeTeam+' '+m.homeScore+'-'+m.awayScore+' '+m.awayTeam).join(' · ');
    const jTopPts    = jScores.length ? jScores[0].pts : -1;
    let rowsHTML = '';
    
    jScores.forEach((p, i) => {
      const isMe    = p.id === currentPlayer.id;
      const isMvp   = p.pts > 0 && p.pts === jTopPts;
      const ptColor = p.pts > 0 ? 'var(--accent)' : p.pts < 0 ? 'var(--danger)' : 'var(--text-d)';
      rowsHTML += `<div class="rank-row ${isMe?'me':''}">
        <span class="rank-num">${i+1}</span>
        ${avaEl(p, 32)}
        <div class="rank-info">
          <div class="rank-name">${p.name}${isMe?' <span style="font-size:10px;color:var(--accent);">· vos</span>':''}</div>
          <div class="rank-stats">${p.games} partido${p.games!==1?'s':''} apostados</div>
        </div>
        ${isMvp ? '<span class="mvp-badge">🏅 MVP</span>' : ''}
        <span class="rank-pts" style="color:${ptColor};">${p.pts>0?'+':''}${p.pts}</span>
      </div>`;
    });
    
    if (!jScores.length) rowsHTML = '<div style="padding:16px;text-align:center;color:var(--text-d);font-size:13px;">Nadie apostó en esta jornada</div>';
    con.innerHTML = tabsHTML +
      `<div style="font-size:12px;color:var(--text-m);margin:8px 0 10px;">${matchSummary}</div>
      <div class="card" style="padding:0 16px;">${rowsHTML}</div>`;
    bindRankingEvents();
    return;
  }

  // Vista General
  let mvpCardHTML = '';
  if (lastMvp) {
    const winnerNames = lastMvp.winners.map(w => w.name).join(' & ');
    const isTie       = lastMvp.winners.length > 1;
    const isMe        = lastMvp.winners.some(w => w.id === currentPlayer.id);
    mvpCardHTML = `<div class="mvp-card">
      <div class="mvp-crown">🏅</div>
      <div class="mvp-card-info">
        <div class="mvp-card-label">MVP · Jornada ${lastMvp.jNum}</div>
        <div class="mvp-card-name">${winnerNames}${isMe?' <span style="font-size:11px;color:var(--accent);">(vos 🎉)</span>':''}</div>
        <div class="mvp-card-sub">${isTie?'Empate en ':''}${lastMvp.pts} pts este día</div>
      </div>
      <div class="mvp-card-pts">+${lastMvp.pts}</div>
    </div>`;
  }

  let podHTML = '<div class="podium-wrap">';
  const podOrder = scores.length>=3 ? [scores[1],scores[0],scores[2]]
                 : scores.length===2 ? [scores[1],scores[0]] : [scores[0]];
  const pbClass  = scores.length>=2 ? ['pb2','pb1','pb3'] : ['pb1'];
  const medals   = scores.length>=2 ? ['🥈','👑','🥉'] : ['👑'];
  const pColors  = ['var(--silver)','var(--gold)','var(--bronze)'];

  podOrder.forEach((p,i) => {
    const c    = color(p.colorIdx);
    const ci   = scores.length>=2 ? i : 0;
    const ptsC = pColors[ci] || 'var(--text)';
    podHTML += `<div class="podium-col">
      <div class="podium-ava" style="background:${c.bg};color:${c.tc};border:2px solid ${ptsC};">${initials(p.name)}</div>
      <div class="podium-block ${pbClass[ci]||'pb1'}">
        <span style="font-size:${ci===1?'22':'16'}px;margin-bottom:2px;">${medals[ci]}</span>
        <span class="podium-pts" style="color:${ptsC};">${p.pts}</span>
      </div>
      <div class="podium-name">${p.name}</div>
    </div>`;
  });
  podHTML += '</div>';

  const snaps = DB.getSnapshots();
  const prevSnap = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const goldColors = ['var(--gold)','var(--silver)','var(--bronze)'];

  let tableHTML = '<div class="card" style="padding:0 16px;">';
  scores.forEach((p,i) => {
    const isMe    = p.id === currentPlayer.id;
    const curRank = i + 1;
    const myMvps  = mvpCounts[p.id] || 0;
    let deltaHTML = '';
    
    if (prevSnap && prevSnap.ranks && prevSnap.ranks[p.id]) {
      const prevRank = prevSnap.ranks[p.id].rank;
      const diff = prevRank - curRank;
      if (diff > 0)      deltaHTML = '<span style="font-size:11px;color:var(--accent);font-weight:700;">▲'+diff+'</span>';
      else if (diff < 0) deltaHTML = '<span style="font-size:11px;color:var(--danger);font-weight:700;">▼'+Math.abs(diff)+'</span>';
      else               deltaHTML = '<span style="font-size:11px;color:var(--text-d);">═</span>';
    }
    const unlockedAchs = ACHIEVEMENTS.filter(a => a.check(p, curRank));
    const achLine = unlockedAchs.length
      ? `<div style="font-size:13px;margin-top:2px;letter-spacing:.05em;" title="${unlockedAchs.map(a=>a.title).join(' · ')}">${unlockedAchs.map(a=>a.icon).join('')}</div>`
      : '';
      
    tableHTML += `<div class="rank-row ${isMe?'me':''}">
      <span class="rank-num" style="color:${i<3?goldColors[i]:'var(--text-d)'};">${curRank}</span>
      ${avaEl(p,36)}
      <div class="rank-info">
        <div class="rank-name">${p.name}${isMe?' <span style="font-size:10px;color:var(--accent);">· vos</span>':''}</div>
        <div class="rank-stats">🎯 ${p.exact} exactos &nbsp;✓ ${p.partial} parciales</div>
        ${achLine}
      </div>
      ${deltaHTML}
      ${myMvps > 0 ? `<span class="mvp-badge">🏅 ×${myMvps}</span>` : ''}
      ${p.curStreak>=2 ? `<span class="streak-badge">🔥 ${p.curStreak}</span>` : ''}
      <span class="rank-pts">${p.pts}</span>
    </div>`;
  });
  tableHTML += '</div>';

  con.innerHTML = tabsHTML + mvpCardHTML + podHTML + tableHTML;
  bindRankingEvents();
}

// ── VISTA DE GRUPOS (POSICIONES) ──
function renderGrupos(con) {
  const groupsFromMatches = {};
  for (const m of matches) {
    if (!m.group || m.group==='?' || !m.homeTeam || !m.awayTeam) continue;
    if (!groupsFromMatches[m.group]) groupsFromMatches[m.group] = {};
    groupsFromMatches[m.group][m.homeTeam] = m.homeCode||'';
    groupsFromMatches[m.group][m.awayTeam] = m.awayCode||'';
  }

  const groupKeys = Object.keys(groupsFromMatches).sort();
  if (!groupKeys.length) {
    con.innerHTML='<div class="empty"><div class="empty-icon">📋</div><p>Los grupos se cargarán cuando FIFA publique los datos.</p></div>';
    return;
  }

  const hasLive=matches.some(m => m.status==='live');
  let html=`<div style="font-size:12px;color:var(--text-m);margin-bottom:12px;">
    <span style="display:inline-block;width:10px;height:10px;background:rgba(74,222,128,.3);border-radius:2px;margin-right:4px;"></span>Top 2 clasifican &nbsp;
    ${hasLive?'<span style="display:inline-block;width:10px;height:10px;background:var(--live-dim);border-radius:2px;margin-right:4px;"></span>En curso':''}
  </div>`;

  if (hasLive) {
    html+=`<div style="padding:8px 12px;background:var(--live-dim);border:.5px solid rgba(239,68,68,.3);border-radius:var(--radius-s);font-size:12px;color:var(--live);margin-bottom:12px;display:flex;gap:7px;align-items:center;">
      <span class="live-dot"></span><span>Tabla actualizada en tiempo real</span>
    </div>`;
  }

  for (const groupLetter of groupKeys) {
    const teamsObj = groupsFromMatches[groupLetter];
    const groupTeams = Object.entries(teamsObj).map(([name,code])=>({name,code}));
    const standings = calcGroupStandings(groupLetter, groupTeams);
    const liveTeams = new Set();
    for (const m of matches.filter(x => x.group===groupLetter&&x.status==='live')) {
      liveTeams.add(m.homeTeam); liveTeams.add(m.awayTeam);
    }
    
    html+=`<div class="group-block">
      <div class="group-header">
        <span class="group-title">GRUPO ${groupLetter}</span>
        <span style="font-size:11px;color:var(--text-m);">${groupTeams.length} equipos</span>
      </div>
      <table class="standings-table">
        <thead>
          <tr>
            <th>Equipo</th><th>PJ</th><th>PG</th><th>PE</th><th>PP</th><th>GF</th><th>GA</th><th>DIF</th><th>PTS</th>
          </tr>
        </thead>
        <tbody>`;
        
    standings.forEach((team,idx)=>{
      const isLiveT=liveTeams.has(team.name);
      const gd=team.gf-team.ga;
      const gdStr=gd>0?'+'+gd:String(gd);
      const gdCls=gd>0?'gd-pos':gd<0?'gd-neg':'';
      html+=`<tr class="${isLiveT?'live-team ':''}">
        <td>
          <div class="team-cell">
            ${renderFlagSm(team.code,team.name)}
            <span>${team.name}</span>
            ${isLiveT?'<span class="live-dot" style="margin-left:3px;"></span>':''}
          </div>
        </td>
        <td>${team.pj}</td><td>${team.w}</td><td>${team.d}</td><td>${team.l}</td>
        <td>${team.gf}</td><td>${team.ga}</td><td class="${gdCls}">${gdStr}</td>
        <td class="pts-cell">${team.pts}</td>
      </tr>`;
    });
    html+='</tbody></table></div>';
  }
  con.innerHTML=html;
}

function calcGroupStandings(groupLetter, groupTeams) {
  const teams={};
  for (const t of groupTeams) {
    teams[t.name]={name:t.name, code:t.code, pj:0, w:0, d:0, l:0, gf:0, ga:0, pts:0};
  }
  const relevantMatches=matches.filter(m => m.group===groupLetter && (m.status==='finished'||m.status==='live') && m.homeScore!==null && m.awayScore!==null);
  for (const m of relevantMatches) {
    const h=teams[m.homeTeam], a=teams[m.awayTeam];
    if (!h||!a) continue;
    h.pj++; a.pj++;
    h.gf+=m.homeScore; h.ga+=m.awayScore;
    a.gf+=m.awayScore; a.ga+=m.homeScore;
    if (m.homeScore>m.awayScore){h.w++;h.pts+=3;a.l++;}
    else if (m.homeScore<m.awayScore){a.w++;a.pts+=3;h.l++;}
    else {h.d++;h.pts++;a.d++;a.pts++;}
  }
  return Object.values(teams).sort((a,b)=>
    b.pts-a.pts||(b.gf-b.ga)-(a.gf-a.ga)||b.gf-a.gf||a.name.localeCompare(b.name));
}

function renderFlagSm(code, name) {
  if (!code) return '<span style="font-size:12px;color:var(--text-m);">'+( name?name.slice(0,3).toUpperCase():'?')+'</span>';
  return '<span class="team-flag-sm"><img src="https://api.fifa.com/api/v3/picture/flags-sq-2/'+code+'" alt="'+name+'" onerror="this.style.display=\'none\'"></span>';
}

function getImprevisibleMatchId() {
  const allPreds = DB.getPredictions();
  let bestId = null, bestScore = -1;
  for (const m of matches.filter(x => x.status!=='finished')) {
    const on = allPreds.filter(x => x.matchId===m.id && _playerIndex.has(x.playerId));
    if (on.length < 3) continue;
    const h = on.filter(x => outcome(x.homeScore,x.awayScore)==='H').length;
    const d = on.filter(x => outcome(x.homeScore,x.awayScore)==='D').length;
    const v = on.filter(x => outcome(x.homeScore,x.awayScore)==='A').length;
    const maxPct = Math.max(h,d,v) / on.length;
    if (maxPct > 0.4) continue;
    if ((1 - maxPct) > bestScore) { bestScore = 1 - maxPct; bestId = m.id; }
  }
  return bestId;
}

// ── VISTA DE MI PERFIL ──
let perfilTab = 'stats';

function renderPerfil(con) {
  const scores=allScores();
  const myRank=scores.findIndex(s=>s.id===currentPlayer.id)+1;
  const sc=scores.find(s=>s.id===currentPlayer.id)||{};
  const myPreds=DB.getPredictions().filter(p=>p.playerId===currentPlayer.id);
  const finished=matches.filter(m=>m.status==='finished');
  const c=color(currentPlayer.colorIdx);
  const medals=['👑','🥈','🥉'];
  const rankLabel=myRank<=3?medals[myRank-1]+' #'+myRank:'#'+myRank;
  
  const scoreCounts={};
  for (const p of myPreds) { const k=p.homeScore+'-'+p.awayScore; scoreCounts[k]=(scoreCounts[k]||0)+1; }
  const favScore=Object.entries(scoreCounts).sort((a,b)=>b[1]-a[1])[0];
  const played=finished.filter(m=>_predictionIndex.has(`${currentPlayer.id}::${m.id}`)).length;
  
  const correct=myPreds.filter(p=>{
    const m=finished.find(x=>x.id===p.matchId); if(!m) return false;
    return outcome(p.homeScore,p.awayScore)===outcome(m.homeScore,m.awayScore);
  }).length;
  const hitRate=played>0?Math.round(correct/played*100):0;

  let html=`<div class="profile-header">
    <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:12px;">
      <div class="ava" style="width:56px;height:56px;background:${c.bg};color:${c.tc};font-size:20px;border:2px solid var(--accent);">${initials(currentPlayer.name)}</div>
      <div style="text-align:left;">
        <div style="font-family:var(--fd);font-size:22px;font-weight:800;">${currentPlayer.name}</div>
        <div class="profile-rank-badge">${rankLabel} del ranking</div>
      </div>
    </div>
    <div class="profile-pts">${sc.pts||0}</div>
    <div class="profile-pts-sub">${sc.confirmedPts||0} pts confirmados${sc.provisionalPts>0?` · <span style="color:var(--gold)">+${sc.provisionalPts} en juego</span>`:''}</div>
  </div>
  <div class="jornada-tabs" style="margin-bottom:12px;">
    <button class="jornada-tab btn-tab-perfil ${perfilTab==='stats'?'active':''}" data-tab="stats">📊 Stats</button>
    <button class="jornada-tab btn-tab-perfil ${perfilTab==='logros'?'active':''}" data-tab="logros">🏆 Logros</button>
    <button class="jornada-tab btn-tab-perfil ${perfilTab==='historial'?'active':''}" data-tab="historial">📋 Historial</button>
    <button class="jornada-tab btn-tab-perfil ${perfilTab==='badges'?'active':''}" data-tab="badges">⭐ Fun Stats</button>
  </div>`;

  if (perfilTab==='stats') {
    const h=myPreds.filter(p=>p.homeScore>p.awayScore).length;
    const d=myPreds.filter(p=>p.homeScore===p.awayScore).length;
    const a=myPreds.filter(p=>p.homeScore<p.awayScore).length;
    const tot=myPreds.length||1;
    html+=`<div class="stats-grid">
      <div class="stat-card"><div class="stat-val" style="color:var(--accent);">${sc.exact||0}</div><div class="stat-lbl">🎯 Exactos</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--gold);">${sc.partial||0}</div><div class="stat-lbl">✓ Parciales</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--text-m);">${played-(sc.exact||0)-(sc.partial||0)}</div><div class="stat-lbl">✗ Perdidos</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--accent);">${hitRate}%</div><div class="stat-lbl">% Acierto</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--gold);">${sc.maxStreak||0}</div><div class="stat-lbl">🔥 Racha máx.</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--text-m);">${myPreds.length}</div><div class="stat-lbl">Apostados</div></div>
    </div>
    <div class="card" style="margin-bottom:10px;">
      <div style="font-size:12px;color:var(--text-m);margin-bottom:8px;">Tu marcador favorito</div>
      <div style="font-family:var(--fd);font-size:32px;font-weight:800;color:var(--accent);">${favScore?favScore[0]:'–'}</div>
      <div style="font-size:11px;color:var(--text-m);margin-top:3px;">${favScore?`Lo apostaste ${favScore[1]} ${favScore[1]>1?'veces':'vez'}`:'Sin apuestas aún'}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:var(--text-m);margin-bottom:10px;">Distribución de apuestas</div>
      <div style="display:flex;flex-direction:column;gap:7px;">
        <div style="display:flex;align-items:center;gap:8px;"><span style="font-size:11px;color:var(--text-m);width:50px;">Local</span><div style="flex:1;height:6px;background:var(--bg-el);border-radius:3px;"><div style="width:${Math.round(h/tot*100)}%;height:100%;background:var(--accent);border-radius:3px;"></div></div><span style="font-family:var(--fd);font-size:14px;font-weight:700;width:36px;text-align:right;">${Math.round(h/tot*100)}%</span></div>
        <div style="display:flex;align-items:center;gap:8px;"><span style="font-size:11px;color:var(--text-m);width:50px;">Empate</span><div style="flex:1;height:6px;background:var(--bg-el);border-radius:3px;"><div style="width:${Math.round(d/tot*100)}%;height:100%;background:var(--gold);border-radius:3px;"></div></div><span style="font-family:var(--fd);font-size:14px;font-weight:700;width:36px;text-align:right;">${Math.round(d/tot*100)}%</span></div>
        <div style="display:flex;align-items:center;gap:8px;"><span style="font-size:11px;color:var(--text-m);width:50px;">Visitante</span><div style="flex:1;height:6px;background:var(--bg-el);border-radius:3px;"><div style="width:${Math.round(a/tot*100)}%;height:100%;background:#60a5fa;border-radius:3px;"></div></div><span style="font-family:var(--fd);font-size:14px;font-weight:700;width:36px;text-align:right;">${Math.round(a/tot*100)}%</span></div>
      </div>
    </div>`;
  }

  if (perfilTab==='logros') {
    const unlocked=ACHIEVEMENTS.filter(a => a.check(sc,myRank));
    html+=`<div class="card" style="text-align:center;margin-bottom:12px;">
      <div style="font-size:12px;color:var(--text-m);">Logros desbloqueados</div>
      <div style="font-family:var(--fd);font-size:34px;font-weight:700;color:var(--gold);">${unlocked.length} <span style="font-size:18px;color:var(--text-m);">/ ${ACHIEVEMENTS.length}</span></div>
    </div>
    <div class="ach-grid">
      ${ACHIEVEMENTS.map(a => {
        const ok=a.check(sc,myRank);
        return `<div class="ach-card ${ok?'unlocked':'locked'}">
          <div class="ach-icon">${a.icon}</div>
          <div class="ach-title">${a.title}</div>
          <div class="ach-desc">${a.desc}</div>
          <div class="ach-status" style="color:${ok?'var(--accent)':'var(--text-d)'};">${ok?'✓ Desbloqueado':'🔒 Pendiente'}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  if (perfilTab==='historial') {
    const wcData=DB.getWildcards()[currentPlayer.id]||{};
    const sortedFin=[...finished].sort((a,b)=>new Date(b.kickoff||b.date)-new Date(a.kickoff||a.date));
    html+='<div class="card" style="padding:0 14px;">';
    if (!sortedFin.length) html+='<div style="padding:16px;text-align:center;color:var(--text-d);font-size:13px;">Sin partidos finalizados aún</div>';
    
    for (const m of sortedFin) {
      const p=myPreds.find(x => x.matchId===m.id);
      const isWC=isWCUsed(wcData,m);
      const total=p?ptsEarnedInMatch(currentPlayer.id,m.id):0;
      const res=p?betResult(p,m.homeScore,m.awayScore):'none';
      const ptsCls=res==='exact'?'exact':res==='partial'?'partial':'wrong';
      const risk=p?calcRiskBonus(p,m.homeScore,m.awayScore,m.id):0;
      html+=`<div class="hist-row">
        <div class="hist-match">
          <div class="hist-teams">${m.homeTeam} vs ${m.awayTeam}</div>
          <div class="hist-meta">${(PHASES[m.phase]||m.phase)} · ${m.homeScore}-${m.awayScore}${isWC?' 🎯':''}${risk>0?` <span class="risk-badge">🎲 +${risk}</span>`:''}</div>
        </div>
        <div class="hist-pred" style="color:${p?'var(--text)':'var(--text-d)'};">${p?`${p.homeScore}-${p.awayScore}`:'–'}</div>
        <div class="hist-pts bet-pts ${ptsCls}">${p?`+${total}`:'–'}</div>
      </div>`;
    }
    html+='</div>';

    // Evolución de posición
    const snapsEv = DB.getSnapshots();
    if (snapsEv.length) {
      html += '<div class="sec-title" style="margin-top:1rem;">📈 Evolución de posición</div>';
      html += '<div class="card" style="padding:0 16px;">';
      snapsEv.forEach((snap, idx) => {
        const cur  = snap.ranks[currentPlayer.id];
        if (!cur) return;
        const prev = idx > 0 ? snapsEv[idx-1].ranks[currentPlayer.id] : null;
        const diff = prev ? prev.rank - cur.rank : 0;
        let arrow = '';
        if      (diff > 0) arrow = `<span style="color:var(--accent);font-weight:700;font-size:12px;">▲${diff}</span>`;
        else if (diff < 0) arrow = `<span style="color:var(--danger);font-weight:700;font-size:12px;">▼${Math.abs(diff)}</span>`;
        else if (idx > 0)  arrow = `<span style="color:var(--text-d);font-size:12px;">═</span>`;
        html += `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:.5px solid var(--border);">
          <span style="font-family:var(--fd);font-size:22px;font-weight:700;color:var(--accent);min-width:32px;">#${cur.rank}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${snap.label}</div>
            <div style="font-size:11px;color:var(--text-m);">${cur.pts} pts acumulados</div>
          </div>
          ${arrow}
        </div>`;
      });
      html += '</div>';
    }
  }

  if (perfilTab==='badges') {
    const CONSERVATIVE=['1-0','2-1','1-1','0-0','2-0'];
    const conservCount=myPreds.filter(p => CONSERVATIVE.includes(p.homeScore+'-'+p.awayScore)).length;
    html+=`<div class="fun-badges-grid">
      <div class="fun-badge-card"><div class="fun-badge-icon">🦁</div><div class="fun-badge-info"><div class="fun-badge-name">El Valiente</div><div class="fun-badge-val">${sc.soloSurprise||0} vez${(sc.soloSurprise||0)!==1?'es':''} el único en acertar (×2 pts)</div></div></div>
      <div class="fun-badge-card"><div class="fun-badge-icon">🐢</div><div class="fun-badge-info"><div class="fun-badge-name">El Conservador</div><div class="fun-badge-val">${conservCount} apuestas clásicas</div></div></div>
      <div class="fun-badge-card"><div class="fun-badge-icon">⭐</div><div class="fun-badge-info"><div class="fun-badge-name">Pleno de Jornada</div><div class="fun-badge-val">${sc.plenoGrupo||0} jornada${(sc.plenoGrupo||0)!==1?'s':''} perfectas</div></div></div>
      <div class="fun-badge-card"><div class="fun-badge-icon">🔥</div><div class="fun-badge-info"><div class="fun-badge-name">Racha actual</div><div class="fun-badge-val">${sc.curStreak||0} aciertos · máx ${sc.maxStreak||0}</div></div></div>
      <div class="fun-badge-card"><div class="fun-badge-icon">🥅</div><div class="fun-badge-info"><div class="fun-badge-name">Penales</div><div class="fun-badge-val">${sc.penalesOk||0} ganador de penales acertado</div></div></div>
    </div>`;
  }
  
  html += `<div id="baja-zone" style="margin-top:18px;padding:14px;background:rgba(248,113,113,.07);border:.5px solid rgba(248,113,113,.2);border-radius:12px;">
    <div style="font-size:13px;font-weight:600;color:var(--danger);margin-bottom:8px;">Darme de baja</div>
    <p style="font-size:12px;color:var(--text-m);margin-bottom:10px;">Elimina tu cuenta, pronósticos y redoblones de forma permanente.</p>
    <div id="baja-confirm" style="display:none;margin-bottom:10px;padding:10px 12px;background:rgba(248,113,113,.12);border-radius:8px;font-size:13px;color:var(--danger);">
      ¿Estás seguro? Esta acción no se puede deshacer.
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn" id="btn-confirm-delete" style="flex:1;padding:8px;background:var(--danger);color:#fff;border:none;">Sí, darme de baja</button>
        <button class="btn btn-secondary" id="btn-cancel-delete" style="flex:1;padding:8px;">Cancelar</button>
      </div>
    </div>
    <button id="baja-btn" class="btn btn-secondary" style="width:100%;color:var(--danger);border-color:rgba(248,113,113,.4);">Darme de baja</button>
  </div>`;

  con.innerHTML=html;
  bindPerfilEvents();
}

function darseDeBaja() {
  document.getElementById('baja-btn').style.display='none';
  document.getElementById('baja-confirm').style.display='block';
}

function confirmarBaja() {
  const playerId = currentPlayer.id;
  DB.savePlayers(DB.getPlayers().filter(x=>x.id!==playerId));
  
  // Limpieza en Firebase para el nodo de predicciones optimizado del usuario
  if (_fbDatabase) {
    _fbDatabase.ref(`${FB_ROOT}/predictions/${playerId}`).remove().catch(()=>{});
  }
  
  // Limpieza local
  const wc = DB.getWildcards(); delete wc[playerId]; DB.saveWildcards(wc);
  DB.saveSpecial(DB.getSpecial().filter(x=>x.playerId!==playerId));
  sessionStorage.removeItem('wc26_cp');
  currentPlayer = null;
  toast('Tu cuenta fue eliminada','ok');
  setTimeout(() => {
    document.getElementById('app').style.display='none';
    renderPlayerSelect();
  }, 900);
}

// ── VISTA DE ADMINISTRADOR ──
function renderAdmin(con) {
  if (!adminAuth) {
    con.innerHTML = `<div style="max-width:300px;margin:3rem auto;text-align:center;">
      <div style="font-size:40px;margin-bottom:1rem;">🔐</div>
      <div style="font-size:16px;font-weight:500;margin-bottom:.5rem;">Área de Administración</div>
      <div style="font-size:13px;color:var(--text-m);margin-bottom:1.25rem;">Solo el organizador puede gestionar resultados.</div>
      <div style="display:flex;gap:8px;justify-content:center;">
        <input type="password" id="ap" placeholder="Contraseña" style="width:180px;">
        <button class="btn btn-primary" id="btn-admin-login">Entrar</button>
      </div>
    </div>`;
    bindAdminLoginEvents();
    return;
  }

  const pending   = matches.filter(m => m.status !== 'finished');
  const finished  = matches.filter(m => m.status === 'finished');
  const meta     = DB.get('meta', {});

  con.innerHTML = `
  <div class="admin-section">
    <div class="sec-title">Sincronización FIFA</div>
    <div class="fifa-strip" style="margin-bottom:0;">
      <span class="fifa-source">${fifaSource}</span>
      <button class="fifa-refresh-btn btn btn-primary" id="btn-fifa-admin-refresh" style="padding:7px 14px;font-size:13px;">↻ Actualizar desde FIFA</button>
    </div>
    <p style="font-size:12px;color:var(--text-d);margin-top:.6rem;">El organizador puede refrescar manualmente el estado de partidos desde aquí.</p>
  </div>

  ${finished.length ? `<div class="admin-section">
    <div class="sec-title">Partidos finalizados</div>
    <p style="font-size:12px;color:var(--text-m);margin-bottom:.75rem;">Podés revertir un partido manualmente para que vuelva a depender de FIFA.</p>
    ${finished.slice().reverse().map(m=>`<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--bg-el);border-radius:var(--radius-s);border:.5px solid var(--border);margin-bottom:7px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam}</div>
        <div style="font-size:11px;color:var(--text-m);">${PHASES[m.phase]||m.phase}${m.manualOverride?' <span style="color:#c084fc;">· Override manual</span>':' · FIFA'}</div>
      </div>
      <button class="btn btn-secondary btn-admin-revert" data-match-id="${m.id}" style="padding:5px 10px;font-size:11px;flex-shrink:0;">↩ Revertir</button>
    </div>`).join('')}
  </div>` : ''}

  <div class="admin-section">
    <div class="sec-title">Override de resultados</div>
    <p style="font-size:12px;color:var(--text-m);margin-bottom:.75rem;">Si FIFA no tiene el resultado aún, podés ingresarlo manualmente.</p>
    ${!pending.length ? '<p style="font-size:13px;color:var(--text-m);">No hay partidos pendientes.</p>' : ''}
    ${pending.map(m=>`<div class="result-row">
      <div class="result-match-info">
        <div style="font-weight:500;font-size:13px;">${inlineFlag(m.homeCode,m.homeTeam)} ${m.homeTeam} vs ${m.awayTeam} ${inlineFlag(m.awayCode,m.awayTeam)}</div>
        <div style="font-size:11px;color:var(--text-m);">${PHASES[m.phase]||m.phase} · ${fmtDate(m.kickoff||m.date)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <input type="number" class="res-box" id="rh-${m.id}" min="0" max="20" placeholder="0">
        <span style="color:var(--text-d);font-family:var(--fd);font-size:18px;">:</span>
        <input type="number" class="res-box" id="ra-${m.id}" min="0" max="20" placeholder="0">
        <button class="btn btn-primary btn-admin-save-result" data-match-id="${m.id}">OK</button>
      </div>
    </div>`).join('')}
  </div>

  <div class="admin-section">
    <div class="sec-title">Validar pronósticos especiales</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <div class="form-label">🥇 Campeón del Mundial (+15 pts)</div>
        <div style="display:flex;gap:8px;">
          <input type="text" id="meta-champ" placeholder="País campeón" value="${meta.champion||''}">
          <button class="btn btn-gold btn-admin-save-meta" data-meta-type="champion" data-input-id="meta-champ">Guardar</button>
        </div>
      </div>
      <div>
        <div class="form-label">Subcampeón (+8 pts)</div>
        <div style="display:flex;gap:8px;">
          <input type="text" id="meta-sub" placeholder="País subcampeón" value="${meta.subCampeon||''}">
          <button class="btn btn-gold btn-admin-save-meta" data-meta-type="subCampeon" data-input-id="meta-sub">Guardar</button>
        </div>
      </div>
      <div>
        <div class="form-label">Tercer puesto (+5 pts)</div>
        <div style="display:flex;gap:8px;">
          <input type="text" id="meta-third" placeholder="País tercer puesto" value="${meta.tercerPuesto||''}">
          <button class="btn btn-gold btn-admin-save-meta" data-meta-type="tercerPuesto" data-input-id="meta-third">Guardar</button>
        </div>
      </div>
      <div>
        <div class="form-label">Goleador del torneo (+10 pts)</div>
        <div style="display:flex;gap:8px;">
          <input type="text" id="meta-scorer" placeholder="Nombre del goleador" value="${meta.topScorer||''}">
          <button class="btn btn-gold btn-admin-save-meta" data-meta-type="scorer" data-input-id="meta-scorer">Guardar</button>
        </div>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <div class="sec-title">Copias de seguridad</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="btn-admin-export">📤 Exportar JSON</button>
      <button class="btn btn-secondary" id="btn-admin-import">📥 Importar JSON</button>
    </div>
  </div>

  <div class="admin-section">
    <div class="sec-title" style="color:var(--danger);">Zona de peligro</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="padding:12px 14px;background:rgba(248,113,113,.07);border:.5px solid rgba(248,113,113,.2);border-radius:10px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;">👤 Gestión de jugadores</div>
        ${DB.getPlayers().length === 0
          ? '<p style="font-size:12px;color:var(--text-d);">No hay jugadores registrados.</p>'
          : DB.getPlayers().map(p => {
              const c = color(p.colorIdx);
              return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:.5px solid var(--border);">
                <div class="ava" style="width:32px;height:32px;background:${c.bg};color:${c.tc};font-size:11px;flex-shrink:0;">${initials(p.name)}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;font-weight:500;">${p.name}</div>
                  <div style="font-size:11px;color:var(--text-d);">PIN: ${p.pinHash ? '••••' : 'sin PIN'}</div>
                </div>
                <button class="btn btn-secondary btn-admin-reset-pin" data-player-id="${p.id}" data-player-name="${p.name}" style="padding:5px 10px;font-size:11px;">🔑 Reset PIN</button>
                <button class="btn btn-danger btn-admin-delete-player" data-player-id="${p.id}" data-player-name="${p.name}" style="padding:5px 10px;font-size:11px;">✕</button>
              </div>`;
            }).join('')}
      </div>

      <div style="padding:12px 14px;background:rgba(248,113,113,.07);border:.5px solid rgba(248,113,113,.2);border-radius:10px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px;">Reiniciar todo</div>
        <button class="btn btn-danger" id="btn-admin-clear-all">💣 Borrar todo</button>
      </div>
    </div>
  </div>`;
  bindAdminEvents();
}

function authAdmin() {
  const pass = document.getElementById('ap')?.value;
  if (pass === ADMIN_PASS) {
    adminAuth = true;
    const navBtn = document.getElementById('nav-admin');
    if (navBtn) navBtn.style.display = '';
    renderView('admin');
  } else { toast('Contraseña incorrecta','err'); }
}

let _adminTapCount = 0;
let _adminTapTimer = null;
function tryEnableAdmin() {
  if (adminAuth) { navigate('admin'); return; }
  _adminTapCount++;
  clearTimeout(_adminTapTimer);
  _adminTapTimer = setTimeout(() => { _adminTapCount = 0; }, 2000);
  if (_adminTapCount >= 5) {
    _adminTapCount = 0;
    const pass = prompt('Modo administrador — ingresá la contraseña:');
    if (pass === null) return;
    if (pass === ADMIN_PASS) {
      adminAuth = true;
      const navBtn = document.getElementById('nav-admin');
      if (navBtn) navBtn.style.display = '';
      toast('Modo administrador activo','ok');
      navigate('admin');
    } else {
      toast('Contraseña incorrecta','err');
    }
  }
}

function saveRankSnapshot(matchId, matchLabel) {
  const scores = allScores();
  const snap = { matchId, label: matchLabel, ts: Date.now(), ranks: {} };
  scores.forEach((p, i) => { snap.ranks[p.id] = { rank: i + 1, pts: p.pts }; });
  const snaps = DB.getSnapshots();
  const updated = snaps.filter(s => s.matchId !== matchId);
  updated.push(snap);
  DB.saveSnapshots(updated);
}

function adminResult(matchId) {
  const h = document.getElementById('rh-'+matchId).value;
  const a = document.getElementById('ra-'+matchId).value;
  if (h===''||a==='') { toast('Ingresá el resultado','err'); return; }
  const m = matches.find(x => x.id===matchId);
  if (!m) return;
  m.status='finished';
  m.homeScore=parseInt(h);
  m.awayScore=parseInt(a);
  m.manualOverride=true;
  saveCachedMatches(matches);
  saveRankSnapshot(matchId, m.homeTeam+' '+h+'-'+a+' '+m.awayTeam);
  toast(m.homeTeam+' '+h+' – '+a+' '+m.awayTeam+' ✓','ok');
  renderView('admin');
}

function adminResetMatch(matchId) {
  const m = matches.find(x => x.id===matchId);
  if (!m) return;
  if (!confirm(`¿Revertir "${m.homeTeam} vs ${m.awayTeam}"?\nEl resultado volverá a depender de FIFA.`)) return;
  m.status='upcoming';
  m.homeScore=null;
  m.awayScore=null;
  m.manualOverride=false;
  saveCachedMatches(matches);
  toast('Partido revertido — esperando datos de FIFA','ok');
  renderView('admin');
}

function saveMeta(type, inputId) {
  const val = document.getElementById(inputId)?.value.trim();
  if (!val) { toast('Ingresá el valor','err'); return; }
  const meta = DB.get('meta',{});
  if (type==='champion') meta.champion=val;
  else if (type==='subCampeon') meta.subCampeon=val;
  else if (type==='tercerPuesto') meta.tercerPuesto=val;
  else meta.topScorer=val;
  DB.set('meta',meta);
  toast('Guardado — se recalculan los puntos especiales ✓','ok');
}

function exportData() {
  const data = {
    players:DB.getPlayers(), matches,
    predictions:DB.getPredictions(), wildcards:DB.getWildcards(),
    special:DB.getSpecial(), meta:DB.get('meta',{})
  };
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download=`mundial2026_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('Exportado ✓','ok');
}

function importData() {
  const input = document.createElement('input');
  input.type='file'; input.accept='.json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const d = JSON.parse(ev.target.result);
        if (d.players)     DB.savePlayers(d.players);
        if (d.matches)     { matches = d.matches; saveCachedMatches(matches); }
        if (d.predictions) DB.savePredictions(d.predictions);
        if (d.wildcards)   DB.saveWildcards(d.wildcards);
        if (d.special)     DB.saveSpecial(d.special);
        if (d.meta)        DB.set('meta',d.meta);
        toast('Datos importados ✓','ok');
        renderView('admin');
      } catch { toast('Archivo inválido','err'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

function adminDeletePlayer(playerId, name) {
  if (!confirm(`¿Eliminar a ${name}? Sus pronósticos también serán borrados.`)) return;
  DB.savePlayers(DB.getPlayers().filter(x => x.id !== playerId));
  if (_fbDatabase) {
    _fbDatabase.ref(`${FB_ROOT}/predictions/${playerId}`).remove().catch(()=>{});
  }
  const wc = DB.getWildcards(); delete wc[playerId]; DB.saveWildcards(wc);
  DB.saveSpecial(DB.getSpecial().filter(x => x.playerId !== playerId));
  toast(`${name} eliminado ✓`, 'ok');
  renderView('admin');
}

function adminResetPin(playerId, name) {
  if (!confirm(`¿Resetear el PIN de ${name}?\nLa próxima vez que ingrese podrá elegir un PIN nuevo.`)) return;
  const players = DB.getPlayers();
  const p = players.find(x => x.id === playerId);
  if (p) {
    delete p.pinHash;
    DB.savePlayers(players);
    toast(`PIN de ${name} reseteado ✓`, 'ok');
    renderView('admin');
  }
}

function clearAll() {
  if (!confirm('¿Borrar TODOS los datos?\nIncluye jugadores, pronósticos y caché. Esta acción no se puede deshacer.')) return;
  const word = prompt('Escribí la palabra BORRAR en mayúsculas para confirmar:');
  if (word !== 'BORRAR') { toast('Borrado cancelado','err'); return; }
  
  DB.savePlayers([]);
  DB.saveWildcards({});
  DB.saveSpecial([]);
  DB.set('meta',{});
  
  if (_fbDatabase) {
    _fbDatabase.ref(`${FB_ROOT}/predictions`).remove().catch(()=>{});
    _fbDatabase.ref(`${FB_ROOT}/fifa_matches`).remove().catch(()=>{});
  }
  
  matches = []; localStorage.removeItem(MATCH_CACHE_KEY);
  fifaSource = 'Sin datos';
  toast('Datos borrados','err');
  changePlayer();
}

// ── VISTA DE REGLAMENTO MODAL ──
let currentRulesTab = 'puntos';

function openRules() {
  const modal = document.getElementById('rules-modal');
  if (modal) {
    modal.classList.add('open');
    switchRulesTab('puntos');
  }
}
function closeRules() {
  const modal = document.getElementById('rules-modal');
  if (modal) modal.classList.remove('open');
}
function switchRulesTab(tab) {
  currentRulesTab = tab;
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
  const tabNames = ['puntos','comodines','playoffs','especiales','faq'];
  const tabBtn = document.getElementById('btn-tab-' + tab);
  if (tabBtn) tabBtn.classList.add('active');
  const rulesBody = document.getElementById('rules-body-modal');
  if (rulesBody) rulesBody.innerHTML = getRulesContent(tab);
}

function reglamentoHTML() {
  return `<div class="reglamento-toggle" id="btn-toggle-reglamento">
    <span>📋 Reglamento de puntuación</span><span id="regl-icon">▼</span>
  </div>
  <div class="reglamento-body" id="regl-body" style="display:none;">
    <table>
      <tr><td>🎯 Resultado exacto</td><td>5 pts base</td></tr>
      <tr><td>✓ Ganador / empate correcto</td><td>3 pts base</td></tr>
      <tr><td>+ Diferencia de goles exacta</td><td>+1 pt adicional</td></tr>
      <tr><td>🎯 Redoblona</td><td>× 2 todos los puntos del partido</td></tr>
      <tr><td>⚽ Penales (playoffs)</td><td>+2 a +12 pts según fase</td></tr>
      <tr><td>🦁 El Valiente (único acierto)</td><td>× 2 todos los puntos</td></tr>
    </table>
    <div style="margin-top:10px;font-size:11px;"><strong style="color:var(--text);">Multiplicadores:</strong> Grupos ×1 · 16vos ×2 · 8vos ×3 · Cuartos ×4 · Semis/3er ×5 · Final ×7</div>
    <div style="margin-top:6px;font-size:11px;"><strong style="color:var(--text);">Redoblones:</strong> 1 por grupo · 16vos: 2 · 8vos: 1 · Cuartos: 1 · Semis/Final: sin redoblona</div>
    <div style="margin-top:10px;font-size:11px;background:rgba(251,191,36,.08);border:.5px solid rgba(251,191,36,.25);border-radius:6px;padding:8px 10px;"><strong style="color:var(--gold);">Especiales:</strong> Goleador +10 · Campeón +15 · Subcampeón +8 · Tercer puesto +5</div>
  </div>`;
}

function getRulesContent(tab) {
  if (tab === 'puntos') return `
    <div class="rules-section">
      <div class="rules-section-title">Sistema de puntuación</div>
      <table class="pts-table">
        <tr><td class="pts-val">5</td><td><div class="pts-desc"><strong>Resultado exacto</strong></div><div class="pts-sub">Marcador preciso · ej: apuestas 2-1 y sale 2-1</div></td></tr>
        <tr><td class="pts-val">3</td><td><div class="pts-desc"><strong>Ganador o empate correcto</strong></div><div class="pts-sub">Acertas ganador o empate, con marcador distinto</div></td></tr>
        <tr><td class="pts-val" style="color:var(--gold);">+1</td><td><div class="pts-desc"><strong>Bonus: diferencia de goles</strong></div><div class="pts-sub">Acertas ganador Y diferencia exacta · ej: apuestas 3-1 y sale 2-0</div></td></tr>
        <tr><td class="pts-val" style="color:var(--gold);">×2</td><td><div class="pts-desc"><strong>🎯 Redoblona activada</strong></div><div class="pts-sub">Duplica todos los puntos de ese partido. Si haces 0, no cambia nada.</div></td></tr>
      </table>
    </div>`;
  if (tab === 'comodines') return `
    <div class="rules-section">
      <div class="rules-section-title">¿Qué es la redoblona?</div>
      <p style="font-size:13px;color:var(--text-m);line-height:1.6;margin-bottom:12px;">
        La redoblona 🎯 duplica todos los puntos que ganes en ese partido.
      </p>
      <p style="font-size:12px;color:var(--text-m);line-height:1.5;padding:10px 12px;background:var(--bg-el);border-radius:var(--radius-s);border:.5px solid var(--border-md);">
        ⚠️ La redoblona se asigna antes del inicio del partido.
      </p>
    </div>`;
  if (tab === 'playoffs') return `
    <div class="rules-section">
      <div class="rules-section-title">¿Cómo funcionan los playoffs?</div>
      <p style="font-size:13px;color:var(--text-m);line-height:1.6;">
        Marcador oficial cuenta hasta el final del alargue. Las tandas de penales no cambian el marcador oficial, pero otorgan bonus si pronosticas empate y aciertas el ganador.
      </p>
    </div>`;
  if (tab === 'especiales') return `
    <div class="rules-section">
      <div class="rules-section-title">Especiales</div>
      <p style="font-size:13px;color:var(--text-m);line-height:1.6;">
        Predicciones a largo plazo cargadas antes del inicio del torneo: Campeón (+15 pts), Subcampeón (+8 pts), Tercer puesto (+5 pts) y Goleador (+10 pts).
      </p>
    </div>`;
  if (tab === 'faq') return `
    <div class="faq-item">
      <div class="faq-q">¿Cuándo se bloquean mis pronósticos?</div>
      <div class="faq-a">Al inicio oficial de cada partido.</div>
    </div>`;
  return '';
}

// ╔══════════════════════════════════════════════════╗
// ║  8. MANEJADORES DE EVENTOS Y VINCULOS DOM        ║
// ╚══════════════════════════════════════════════════╝

// Vincular eventos de la pantalla de Login
function bindLoginEvents() {
  const btnLogin = document.getElementById('btn-login-submit');
  if (btnLogin) btnLogin.onclick = loginWithPin;

  // Enfocar campos PIN secuencialmente
  for (let i = 0; i < 4; i++) {
    const pinInp = document.getElementById(`ln-pin-${i}`);
    if (pinInp) {
      pinInp.oninput = function() {
        if (this.value && i < 3) document.getElementById(`ln-pin-${i+1}`).focus();
      };
      pinInp.onkeydown = function(e) {
        if (e.key === 'Backspace' && !this.value && i > 0) document.getElementById(`ln-pin-${i-1}`).focus();
        if (e.key === 'Enter') loginWithPin();
      };
    }
  }

  // Chips de acceso rápido
  document.querySelectorAll('.player-chip').forEach(chip => {
    chip.onclick = function() {
      quickLogin(this.dataset.playerId);
    };
  });
}

// Vincular eventos de la vista principal (Partidos / Predicciones)
function bindPredictionsEvents() {
  // Botón FIFA refresh
  const refreshBtn = document.getElementById('btn-fifa-refresh');
  if (refreshBtn) refreshBtn.onclick = () => loadFifaMatches();

  // Guardado de especiales
  document.querySelectorAll('.btn-sp-save').forEach(btn => {
    btn.onclick = function() {
      saveSpecial(this.dataset.spType);
    };
  });

  // Modos de ordenamiento
  document.querySelectorAll('.btn-sort-mode').forEach(btn => {
    btn.onclick = function() {
      predSortMode = this.dataset.sortMode;
      predSortFilter = 'all';
      renderView('predictions');
    };
  });

  // Sub-filtro
  const filterSelect = document.getElementById('pred-filter-select');
  if (filterSelect) {
    filterSelect.onchange = function() {
      predSortFilter = this.value;
      renderView('predictions');
    };
  }

  // Guardado de predicción de partido
  document.querySelectorAll('.btn-save-pred').forEach(btn => {
    btn.onclick = function() {
      savePred(this.dataset.matchId);
    };
  });

  // Inputs de goles para disparar selector de penales
  document.querySelectorAll('.score-input').forEach(inp => {
    inp.oninput = function() {
      checkPenSelector(this.dataset.matchId);
    };
  });

  // Selector de ganador de penales
  document.querySelectorAll('.btn-set-pen').forEach(btn => {
    btn.onclick = function() {
      setPenWinner(this.dataset.matchId, this.dataset.home === 'true');
    };
  });

  // Botón de redoblona
  document.querySelectorAll('.btn-toggle-wc').forEach(btn => {
    btn.onclick = function() {
      toggleWC(this.dataset.matchId);
    };
  });

  // Acordeón de apuestas y chat
  document.querySelectorAll('.bets-toggle').forEach(el => {
    el.onclick = function() {
      const matchId = this.dataset.matchId;
      const panel = document.getElementById('bp-' + matchId);
      const isOpen = panel?.classList.contains('open');
      panel?.classList.toggle('open', !isOpen);
      this.classList.toggle('open', !isOpen);
    };
  });

  // Botón para desplegar desglose de puntos
  document.querySelectorAll('.btn-toggle-breakdown').forEach(btn => {
    btn.onclick = function(e) {
      e.stopPropagation();
      const bId = this.dataset.breakdownId;
      document.getElementById(bId)?.classList.toggle('open');
    };
  });

  // Envío de chat
  document.querySelectorAll('.btn-send-chat').forEach(btn => {
    btn.onclick = function() {
      sendChat(this.dataset.matchId);
    };
  });

  // Enter en input de chat
  document.querySelectorAll('.chat-text-input').forEach(inp => {
    inp.onkeydown = function(e) {
      if (e.key === 'Enter') sendChat(this.dataset.matchId);
    };
  });

  // Reacciones a comentarios
  document.querySelectorAll('.btn-chat-reaction').forEach(btn => {
    btn.onclick = function() {
      toggleReaction(this.dataset.matchId, this.dataset.msgId, this.dataset.emoji);
    };
  });

  // Reglamento colapsable
  const reglBtn = document.getElementById('btn-toggle-reglamento');
  if (reglBtn) reglBtn.onclick = toggleReglamento;
}

// Vincular eventos de apuestas
function bindApuestasEvents() {
  document.querySelectorAll('.btn-filter-apuestas').forEach(btn => {
    btn.onclick = function() {
      filterApuestas(this.dataset.filter);
    };
  });

  document.querySelectorAll('.btn-apuestas-sort').forEach(btn => {
    btn.onclick = function() {
      apuestasSortMode = this.dataset.sortMode;
      apuestasFilter = 'all';
      renderView('misapuestas');
    };
  });

  const select = document.getElementById('apuestas-filter-select');
  if (select) {
    select.onchange = function() {
      apuestasFilter = this.value;
      renderView('misapuestas');
    };
  }

  document.querySelectorAll('.btn-goto-load').forEach(btn => {
    btn.onclick = function() {
      navigate('predictions');
    };
  });
}

// Vincular eventos del ranking
function bindRankingEvents() {
  document.querySelectorAll('.btn-tab-rank').forEach(btn => {
    btn.onclick = function() {
      rankingView = this.dataset.target;
      renderView('ranking');
    };
  });
}

// Vincular eventos de perfil
function bindPerfilEvents() {
  document.querySelectorAll('.btn-tab-perfil').forEach(btn => {
    btn.onclick = function() {
      perfilTab = this.dataset.tab;
      renderView('perfil');
    };
  });

  const btnBaja = document.getElementById('baja-btn');
  if (btnBaja) btnBaja.onclick = darseDeBaja;

  const btnConfirm = document.getElementById('btn-confirm-delete');
  if (btnConfirm) btnConfirm.onclick = confirmarBaja;

  const btnCancel = document.getElementById('btn-cancel-delete');
  if (btnCancel) {
    btnCancel.onclick = function() {
      document.getElementById('baja-confirm').style.display = 'none';
      document.getElementById('baja-btn').style.display = 'block';
    };
  }
}

// Vincular eventos de administrador
function bindAdminLoginEvents() {
  const btn = document.getElementById('btn-admin-login');
  if (btn) btn.onclick = authAdmin;
  
  const pwInput = document.getElementById('ap');
  if (pwInput) {
    pwInput.onkeydown = function(e) {
      if (e.key === 'Enter') authAdmin();
    };
  }
}

function bindAdminEvents() {
  const btnRefresh = document.getElementById('btn-fifa-admin-refresh');
  if (btnRefresh) btnRefresh.onclick = () => loadFifaMatches();

  document.querySelectorAll('.btn-admin-revert').forEach(btn => {
    btn.onclick = function() {
      adminResetMatch(this.dataset.matchId);
    };
  });

  document.querySelectorAll('.btn-admin-save-result').forEach(btn => {
    btn.onclick = function() {
      adminResult(this.dataset.matchId);
    };
  });

  document.querySelectorAll('.btn-admin-save-meta').forEach(btn => {
    btn.onclick = function() {
      saveMeta(this.dataset.metaType, this.dataset.inputId);
    };
  });

  const btnExport = document.getElementById('btn-admin-export');
  if (btnExport) btnExport.onclick = exportData;

  const btnImport = document.getElementById('btn-admin-import');
  if (btnImport) btnImport.onclick = importData;

  document.querySelectorAll('.btn-admin-reset-pin').forEach(btn => {
    btn.onclick = function() {
      adminResetPin(this.dataset.playerId, this.dataset.playerName);
    };
  });

  document.querySelectorAll('.btn-admin-delete-player').forEach(btn => {
    btn.onclick = function() {
      adminDeletePlayer(this.dataset.playerId, this.dataset.playerName);
    };
  });

  const btnClearAll = document.getElementById('btn-admin-clear-all');
  if (btnClearAll) btnClearAll.onclick = clearAll;
}

// ╔══════════════════════════════════════════════════╗
// ║  9. INICIALIZACIÓN                               ║
// ╚══════════════════════════════════════════════════╝
(async function init() {
  const selEl = document.getElementById('player-select');
  if (selEl) {
    selEl.style.display = 'flex';
    selEl.innerHTML = `
      <div style="text-align:center;padding:2rem;">
        <img class="brand-logo loading" src="albipolla-icon-512-v5.png" alt="ALBIPOLLA">
        <div class="brand-title" style="color:#ecfdf5;">ALBIPOLLA</div>
        <div style="font-size:13px;color:#7a9e82;margin-top:.5rem;">Conectando al servidor...</div>
      </div>`;
  }

  // 1. Inicializar Firebase
  try {
    await initFirebase();
  } catch(e) {
    console.error('Firebase init error:', e);
    if (selEl) {
      selEl.innerHTML = `<div style="text-align:center;padding:2rem;max-width:340px;">
        <div style="font-size:40px;">🔌</div>
        <div style="font-size:16px;font-weight:600;margin-top:1rem;color:#f87171;">Sin conexión</div>
        <div style="font-size:13px;color:#7a9e82;margin-top:.5rem;line-height:1.6;">No se pudo conectar a Firebase.<br>Error: ${String(e.message||e)}</div>
        <button onclick="location.reload()" style="margin-top:1.5rem;padding:10px 20px;background:#4ade80;color:#0e1a10;border:none;border-radius:8px;font-weight:700;cursor:pointer;">🔄 Reintentar</button>
      </div>`;
    }
    return;
  }

  // 2. Cargar partidos: fusionar caché local + Firebase, luego FIFA en background
  matches = loadCachedMatches();
  await new Promise(resolve => {
    loadCachedMatchesFromFirebase(fbMatches => {
      if (fbMatches.length) {
        matches = mergeMatchesWithHistory(matches, fbMatches);
        saveCachedMatches(matches);
      }
      resolve();
    });
  });
  fifaSource = matches.length ? `Caché · ${matches.length} partidos` : 'Sin datos';

  // 3. Restaurar HTML del selector de jugador
  try {
    renderPlayerSelect();
  } catch(e) {
    console.error('renderLoginScreen error:', e);
    if (selEl) {
      selEl.innerHTML = `<div style="text-align:center;padding:2rem;">
        <img class="brand-logo loading" src="albipolla-icon-512-v5.png" alt="ALBIPOLLA">
        <div class="brand-title">ALBIPOLLA</div>
        <div style="font-size:12px;color:#f87171;margin-top:.5rem;">Error de carga: ${String(e.message||e)}</div>
        <button onclick="location.reload()" style="margin-top:1rem;padding:10px 20px;background:#4ade80;color:#0e1a10;border:none;border-radius:8px;font-weight:700;cursor:pointer;">🔄 Recargar</button>
      </div>`;
    }
  }

  // 4. Restaurar sesión activa
  let autoLogged = false;
  const savedSession = sessionStorage.getItem('wc26_cp');
  const savedRemember = localStorage.getItem('wc26_remember');

  if (savedSession) {
    try {
      const sp = JSON.parse(savedSession);
      const found = _playerIndex.get(sp.id);
      if (found) { currentPlayer=found; showApp(); autoLogged=true; }
    } catch {}
  }
  if (!autoLogged && savedRemember) {
    try {
      const sr = JSON.parse(savedRemember);
      const found = _playerIndex.get(sr.id);
      if (found) {
        currentPlayer=found;
        sessionStorage.setItem('wc26_cp', JSON.stringify(found));
        showApp();
        autoLogged=true;
      }
    } catch {}
  }
  
  if (!autoLogged) renderPlayerSelect();

  // 5. Vincular eventos de componentes estáticos
  const appLogo = document.getElementById('app-header-logo');
  if (appLogo) appLogo.onclick = tryEnableAdmin;

  const playerHeaderBtn = document.getElementById('header-player-btn');
  if (playerHeaderBtn) playerHeaderBtn.onclick = changePlayer;

  // Botones de bottom bar navigation
  document.getElementById('nav-predictions').onclick = () => navigate('predictions');
  document.getElementById('nav-ranking').onclick = () => navigate('ranking');
  document.getElementById('nav-grupos').onclick = () => navigate('grupos');
  document.getElementById('nav-perfil').onclick = () => navigate('perfil');
  document.getElementById('nav-misapuestas').onclick = () => navigate('misapuestas');
  document.getElementById('nav-admin').onclick = () => navigate('admin');

  // Eventos de cerrar / pestañas del reglamento modal
  const modalClose = document.getElementById('rules-modal-close-btn');
  if (modalClose) modalClose.onclick = closeRules;

  const overlay = document.getElementById('rules-modal');
  if (overlay) {
    overlay.onclick = function(e) {
      if (e.target === overlay) closeRules();
    };
  }

  document.getElementById('btn-tab-puntos').onclick = () => switchRulesTab('puntos');
  document.getElementById('btn-tab-comodines').onclick = () => switchRulesTab('comodines');
  document.getElementById('btn-tab-playoffs').onclick = () => switchRulesTab('playoffs');
  document.getElementById('btn-tab-especiales').onclick = () => switchRulesTab('especiales');
  document.getElementById('btn-tab-faq').onclick = () => switchRulesTab('faq');

  // 6. Obtener datos frescos de FIFA en background
  loadFifaMatches({ silent: true });

  // 7. Registrar Service Worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/mundial2026/optimizada/sw.js?v=6', { scope: '/mundial2026/optimizada/' })
      .then(reg => console.log('SW registrado:', reg.scope))
      .catch(err => console.warn('SW error:', err));
  }
})();
