/**
 * CENTRAL SYNC SCRIPT - FIFA Matches to Firebase (Node.js)
 * 
 * Este script se ejecuta en un servidor, VPS o de forma local (Node 18+)
 * y se encarga de consultar la API de FIFA una vez por minuto para subir
 * los marcadores en tiempo real a Firebase Realtime Database.
 * 
 * De esta forma, las apps de los usuarios no saturan la API de FIFA ni
 * sufren bloqueos de IP (Rate Limiting).
 * 
 * Uso:
 *   node sync-fifa.js [prod | test | laliga]
 */

const http = require('https');

// Configuración de entornos y rutas de Firebase
const ENVS = {
  prod: {
    root: 'wc26prod',
    matchKey: 'fifa_matches',
    url: 'https://api.fifa.com/api/v3/calendar/matches?from=2026-06-10&to=2026-07-20&language=es&count=500'
  },
  test: {
    root: 'wc26prueba',
    matchKey: 'fifa_matches',
    url: 'https://api.fifa.com/api/v3/calendar/matches?from=2026-06-10&to=2026-07-20&language=es&count=500'
  },
  laliga: {
    root: 'wc26laliga',
    matchKey: 'fifa_match_centre_matches',
    // La Liga requiere un rango dinámico semanal
    url: null 
  }
};

const DATABASE_URL = 'https://polla-mundial-2026-8b6e5-default-rtdb.firebaseio.com';

// Leer entorno de los argumentos de consola
const args = process.argv.slice(2);
const activeEnvName = args[0] || 'test'; // Por defecto corre en entorno de pruebas

if (!ENVS[activeEnvName]) {
  console.error(`Error: Entorno "${activeEnvName}" no válido. Elige entre [prod, test, laliga].`);
  process.exit(1);
}

const env = ENVS[activeEnvName];
console.log(`[INIT] Iniciando sincronizador de FIFA para el entorno: [${activeEnvName.toUpperCase()}]`);

// --- Helper: Petición HTTP simple con promesas (sin dependencias) ---
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'User-Agent': 'NodeJS/ALBIPOLLA-Sync' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`FIFA HTTP Status: ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function putJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'NodeJS/ALBIPOLLA-Sync'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// --- Calculador de rango de fecha para Liga Española ---
function getLaLigaFifaUrl() {
  const start = new Date();
  const diffToMonday = (start.getDay() + 6) % 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - diffToMonday);
  
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  
  const pad = n => String(n).padStart(2, '0');
  const from = `${start.getFullYear()}-${pad(start.getMonth()+1)}-${pad(start.getDate())}`;
  const to = `${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`;
  
  return `https://api.fifa.com/api/v3/calendar/matches?from=${from}&to=${to}&language=es&count=500`;
}

// --- Mapeo y Normalización de FIFA ---
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

function normalizeMatch(m) {
  const group = localizedText(m.GroupName, '');
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

// --- Fusión de partidos para evitar borrar overrides manuales del administrador ---
function mergeMatches(existing, fresh) {
  const byId = new Map();
  for (const m of existing || []) { if (m && m.id) byId.set(String(m.id), m); }
  for (const m of fresh || []) {
    if (!m || !m.id) continue;
    const id = String(m.id);
    const cached = byId.get(id);
    if (!cached) { byId.set(id, m); continue; }
    if (cached.manualOverride) { byId.set(id, cached); continue; }
    byId.set(id, { ...cached, ...m });
  }
  return Array.from(byId.values()).sort((a,b) => new Date(a.kickoff||a.date) - new Date(b.kickoff||b.date));
}

// --- Tarea de Sincronización Principal ---
async function sync() {
  const nowStr = new Date().toLocaleTimeString('es-PY', { hour12: false });
  console.log(`[${nowStr}] Consultando datos frescos de FIFA...`);
  
  const url = activeEnvName === 'laliga' ? getLaLigaFifaUrl() : env.url;
  
  try {
    const data = await getJson(url);
    const freshMatches = (data.Results || []).map(normalizeMatch);
    
    if (!freshMatches.length) {
      console.warn(`[WARN] FIFA devolvió 0 partidos. Abortando escritura.`);
      return;
    }
    
    // Obtener partidos actuales de Firebase para fusionar y no sobreescribir overrides manuales
    const fbUrl = `${DATABASE_URL}/${env.root}/${env.matchKey}.json`;
    const rawExisting = await getJson(fbUrl);
    const existing = Array.isArray(rawExisting) ? rawExisting.filter(Boolean) : [];
    
    const merged = mergeMatches(existing, freshMatches);
    
    // Subir marcadores actualizados a Firebase
    await putJson(fbUrl, merged);
    console.log(`[SUCCESS] Se sincronizaron ${merged.length} partidos en Firebase node: [${env.root}/${env.matchKey}]`);
    
    // Programar siguiente ejecución dinámica: 60s si hay partido en curso, 3min si no hay
    const hasLive = merged.some(m => m.status === 'live');
    const delay = hasLive ? 60000 : 180000;
    setTimeout(sync, delay);
  } catch(e) {
    console.error(`[ERROR] Fallo en la sincronización:`, e.message);
    setTimeout(sync, 60000); // Reintentar en 60s
  }
}

// Arrancar ciclo
sync();
