/**
 * loader.js — Parsea CSVs de escenario y unidades para Screaming Eagles AI.
 *
 * Funciones principales:
 *   loadScenario(url)  → Promise<ScenarioData>
 *   loadUnits(url)     → Promise<Map<string, UnitData>>
 */

'use strict';

// ── Secciones del CSV de escenario ─────────────────────────────────────────
const _SCENARIO_SECTIONS = new Set([
    'ESCENARIO', 'ALIADOS', 'EJE', 'UNIDADES_ALIADOS', 'UNIDADES_EJE', 'MAPA'
]);

// ── Mapeo de secciones de SE_Units.csv ─────────────────────────────────────
// clave minúsculas → { faccion, cat_base }
const _UNIT_SECTIONS = {
    'american infantry':   { faccion: 'american', cat_base: 'squad'   },
    'american veh & guns': { faccion: 'american', cat_base: 'vehicle' },
    'german infantry':     { faccion: 'german',   cat_base: 'squad'   },
    'german veh. & guns':  { faccion: 'german',   cat_base: 'vehicle' },
    'russian veh & guns':  { faccion: 'russian',  cat_base: 'vehicle' },
    'neutral counters':    { faccion: 'neutral',  cat_base: 'vehicle' },
};

// Columnas de SE_Units.csv (respetando espacios exactos)
const _C = {
    name:     'Tipo de unidad',
    count:    'Número de fichas',
    fp:       'Potencia de fuego',
    prof_fp:  'Potencia eficiente',
    melee:    'Potencia en melee',
    range:    'Alcance',
    satw:     'SATW',
    cas_red:  'Baja reducción',
    cas_elim: 'Baja de elimin.',
    mor_hi:   'Moral    alta',   // 4 espacios
    mor_mid:  'Moral   media',   // 3 espacios
    mor_lo:   'Moral   baja',    // 3 espacios
    arm_f:    'Blindaje frontal',
    arm_s:    'Blindaje lat/trasero',
    mov_veh:  'Mov. vehículos',
    eficacia: 'Eficacia',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function _int(val, def = 0) {
    const n = parseInt((val || '').trim(), 10);
    return isNaN(n) ? def : n;
}

function _optInt(val) {
    const n = parseInt((val || '').trim(), 10);
    return isNaN(n) ? null : n;
}

function _parseRange(val) {
    const v = (val || '').trim();
    if (!v) return { min: 1, max: null };
    if (v.startsWith('>')) return { min: _int(v.slice(1)) + 1, max: null };
    if (v.includes('-')) {
        const [lo, hi] = v.split('-');
        return { min: _int(lo), max: _int(hi) };
    }
    return { min: 1, max: _int(v) };
}

/**
 * Parsea una fila CSV (separador ';') teniendo en cuenta comillas simples/dobles.
 * Devuelve un array de strings.
 */
function _parseCsvRow(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ';' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

/**
 * Parsea un CSV completo en un array de objetos {col → valor}.
 * Busca la fila de cabecera que contiene `headerKey`.
 */
function _parseCsvWithHeader(text, headerKey) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    // Encontrar cabecera
    let headerIdx = lines.findIndex(l => l.includes(headerKey));
    if (headerIdx === -1) headerIdx = 0;
    const headers = _parseCsvRow(lines[headerIdx]);
    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const vals = _parseCsvRow(lines[i]);
        if (vals.every(v => !v)) continue;
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
        rows.push(obj);
    }
    return rows;
}

// ── Detección de categoría de unidad ───────────────────────────────────────

function _detectCategory(name, row, cat_base) {
    const n = name.toUpperCase();
    if (n.includes('DECOY')) return 'decoy';
    if (cat_base === 'squad') {
        if (n.includes('MG') || n.includes('MACHINE GUN')) return 'wt_mg';
        if (n.includes('MORTAR')) return 'wt_mortar';
        return 'squad';
    }
    // Sección vehículos
    if (n.includes('STUKA') || n.includes('JU87')) return 'aircraft';
    if ((row[_C.mor_hi] || '').trim()) return 'gun';
    return 'vehicle';
}

// MPs estándar por categoría
const _DEFAULT_MPS = {
    squad: 5, wt_mg: 4, wt_mortar: 4, vehicle: 6,
    gun: 0, aircraft: 0, decoy: 5,
};

// ── Cargador de unidades ────────────────────────────────────────────────────

/**
 * Carga y parsea SE_Units.csv.
 * @returns {Promise<Map<string, UnitData>>} mapa nombre → UnitData
 */
async function loadUnits(url) {
    const resp = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`No se pudo cargar ${url}: ${resp.status}`);
    const text = await resp.text();
    return parseUnitsText(text);
}

function parseUnitsText(text) {
    const rows = _parseCsvWithHeader(text, _C.name);
    const unitMap = new Map();   // nombre_base → {full_row, red_row, faccion, cat}
    const order = [];

    let faccion = 'neutral';
    let cat_base = 'vehicle';

    for (const row of rows) {
        const name = (row[_C.name] || '').trim();
        if (!name) continue;

        // ¿Es cabecera de sección?
        const hasOtherData = Object.entries(row)
            .some(([k, v]) => k !== _C.name && v && v.trim());
        if (!hasOtherData) {
            const key = name.toLowerCase();
            if (_UNIT_SECTIONS[key]) {
                faccion = _UNIT_SECTIONS[key].faccion;
                cat_base = _UNIT_SECTIONS[key].cat_base;
            }
            continue;
        }

        // Fila de datos
        const isReduced = name.toLowerCase().includes('(reducida)');
        const baseName = name
            .replace(/\(Reducida\)/gi, '')
            .trim();
        const cat = _detectCategory(baseName, row, cat_base);

        if (!unitMap.has(baseName)) {
            unitMap.set(baseName, { full: null, red: null, faccion, cat });
            order.push(baseName);
        }
        const entry = unitMap.get(baseName);
        if (isReduced) entry.red = row;
        else entry.full = row;
    }

    // Construir UnitData final
    const result = new Map();
    for (const baseName of order) {
        const { full, red, faccion: f, cat } = unitMap.get(baseName);
        if (!full) continue;

        const count = _int(full[_C.count]);
        const mps = cat === 'vehicle' ? _int(full[_C.mov_veh], 6) : _DEFAULT_MPS[cat] || 4;

        let unitData;
        if (['squad', 'wt_mg', 'wt_mortar', 'decoy'].includes(cat)) {
            const range = _parseRange(full[_C.range]);
            unitData = {
                nombre: baseName, faccion: f, categoria: cat,
                fichas: count, mps,
                fp_normal:   _int(full[_C.fp]),
                fp_eficiente: _int(full[_C.prof_fp]),
                fp_melee:    _optInt(full[_C.melee]),
                alcance_min: range.min,
                alcance_max: range.max,
                satw:        _optInt(full[_C.satw]),
                cas_red:     _optInt(full[_C.cas_red]),
                cas_elim:    _int(full[_C.cas_elim]),
                moral:       _int(full[_C.mor_hi]),
                moral_sup:   _int(full[_C.mor_mid]),
                moral_full:  _int(full[_C.mor_lo]),
                es_mortar:   (range.min > 1),
                tiene_reducida: !!red,
                // Cara reducida
                reducida: red ? {
                    fp_normal:   _int(red[_C.fp]),
                    fp_eficiente: _int(red[_C.prof_fp]),
                    cas_elim:    _int(red[_C.cas_red]),  // columna Baja reducción
                    moral:       _int(red[_C.mor_hi]),
                    satw:        _optInt(red[_C.satw]),
                } : null,
            };
        } else if (cat === 'vehicle') {
            unitData = {
                nombre: baseName, faccion: f, categoria: cat,
                fichas: count, mps,
                fp_vs_veh:   _int(full[_C.fp]),
                fp_vs_inf:   _int(full[_C.prof_fp]),
                blindaje_f:  _int(full[_C.arm_f]),
                blindaje_s:  _int(full[_C.arm_s]),
                eficacia:    _int(full[_C.eficacia]),
                tiene_reducida: false,
            };
        } else if (cat === 'gun') {
            unitData = {
                nombre: baseName, faccion: f, categoria: cat,
                fichas: count, mps: 0,
                fp_vs_veh:   _int(full[_C.fp]),
                fp_vs_inf:   _int(full[_C.prof_fp]),
                cas_red:     _optInt(full[_C.cas_red]),
                cas_elim:    _int(full[_C.cas_elim]),
                moral:       _int(full[_C.mor_hi]),
                moral_sup:   _int(full[_C.mor_mid]),
                moral_full:  _int(full[_C.mor_lo]),
                eficacia:    _int(full[_C.eficacia]),
                tiene_reducida: false,
            };
        } else if (cat === 'aircraft') {
            unitData = {
                nombre: baseName, faccion: f, categoria: cat,
                fichas: count, mps: 0,
                fp_vs_veh:  _int(full[_C.fp]),
                fp_vs_inf:  _int(full[_C.prof_fp]),
                tiene_reducida: false,
            };
        }

        if (unitData) result.set(baseName, unitData);
    }
    return result;
}

// ── Cargador de escenario ────────────────────────────────────────────────────

/**
 * Carga y parsea un fichero CSV de escenario.
 * @returns {Promise<ScenarioData>}
 */
async function loadScenario(url) {
    const resp = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`No se pudo cargar ${url}: ${resp.status}`);
    const text = await resp.text();
    return parseScenarioText(text);
}

function parseScenarioText(text) {
    const lines = text.split(/\r?\n/);
    const sections = {};
    let currentSection = null;
    let currentLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        // Detectar sección [XXX]
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            if (currentSection) sections[currentSection] = currentLines;
            currentSection = trimmed.slice(1, -1);
            currentLines = [];
        } else if (currentSection) {
            currentLines.push(line);
        }
    }
    if (currentSection) sections[currentSection] = currentLines;

    // Parsear cada sección
    const meta    = _parseKeyValue(sections['ESCENARIO'] || []);
    const aliados = _parseKeyValue(sections['ALIADOS']   || []);
    const eje     = _parseKeyValue(sections['EJE']       || []);
    const uniAli  = _parseUnitList(sections['UNIDADES_ALIADOS'] || []);
    const uniEje  = _parseUnitList(sections['UNIDADES_EJE']     || []);
    const mapa    = _parseMapData(sections['MAPA'] || []);

    return {
        meta: {
            titulo:        meta['Titulo'] || '',
            turnos:        parseInt(meta['Turnos'] || '4'),
            norte:         meta['Norte'] || 'N',
            deploys_first: (meta['Despliega_primero'] || 'German').toLowerCase(),
            moves_first:   (meta['Mueve_primero']     || 'American').toLowerCase(),
            descripcion:   (meta['Descripcion'] || '').replace(/\\n/g, '\n'),
            victoria:      meta['Victoria'] || '',
        },
        factions: {
            aliados: {
                faccion:    aliados['Faccion'] || 'American',
                ops_range:  _parseOpsRange(aliados['Ops_rango'] || '1-2'),
                cps:        parseInt(aliados['Puntos_comando'] || '1'),
                ruta_huida: aliados['Ruta_huida'] || 'W',
                despliegue: aliados['Despliegue_inicial'] || '',
                despliegue_alt: aliados['Despliegue_alternativo'] || '',
            },
            eje: {
                faccion:    eje['Faccion'] || 'German',
                ops_range:  _parseOpsRange(eje['Ops_rango'] || '1-2'),
                cps:        parseInt(eje['Puntos_comando'] || '1'),
                ruta_huida: eje['Ruta_huida'] || 'E',
                despliegue: eje['Despliegue_inicial'] || '',
                despliegue_alt: eje['Despliegue_alternativo'] || '',
            },
        },
        unidades: { aliados: uniAli, eje: uniEje },
        mapa,
    };
}

function _parseKeyValue(lines) {
    const obj = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(';');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        obj[key] = val;
    }
    return obj;
}

function _parseOpsRange(val) {
    const parts = val.split('-');
    return { min: parseInt(parts[0]) || 1, max: parseInt(parts[1]) || 2 };
}

function _parseUnitList(lines) {
    const result = [];
    // First non-empty line is header
    let headerSkipped = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!headerSkipped) { headerSkipped = true; continue; }
        const parts = trimmed.split(';');
        if (parts.length < 5) continue;
        result.push({
            tipo:            parts[0].trim(),
            categoria:       parts[1].trim(),
            reducida:        parts[2].trim().toUpperCase() === 'SI',
            fichas_max:      parseInt(parts[3]) || 0,
            fichas_escenario: parseInt(parts[4]) || 0,
        });
    }
    return result;
}

function _parseMapData(lines) {
    const mapa = {};
    let hasGridCols = false;  // true si el CSV tiene columnas Col y Row al final
    let headerParsed = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!headerParsed) {
            // Detectar si el CSV tiene columnas Col y Row (formato ensamblado)
            const headers = trimmed.split(';').map(h => h.trim());
            hasGridCols = headers.includes('Col') && headers.includes('Row');
            headerParsed = true;
            continue;
        }
        const parts = trimmed.split(';');
        if (parts.length < 11) continue;
        const coord = parts[0].trim();
        const entry = {
            terreno:     parts[1].trim(),
            elevacion:   parseInt(parts[2]) || 0,
            upper_level: parts[3].trim().toUpperCase() !== 'NO',
            fortif:      parts[4].trim(),
            lados: {
                N:  parts[5].trim().toUpperCase() !== 'NO' ? parts[5].trim() : null,
                NE: parts[6].trim().toUpperCase() !== 'NO' ? parts[6].trim() : null,
                SE: parts[7].trim().toUpperCase() !== 'NO' ? parts[7].trim() : null,
                S:  parts[8].trim().toUpperCase() !== 'NO' ? parts[8].trim() : null,
                SW: parts[9].trim().toUpperCase() !== 'NO' ? parts[9].trim() : null,
                NW: parts[10].trim().toUpperCase() !== 'NO' ? parts[10].trim() : null,
            },
        };
        if (hasGridCols && parts.length >= 13) {
            // Columnas Col y Row dan la posición global entera para rendering
            entry._col = parseInt(parts[11]) || 0;
            entry._row = parseInt(parts[12]) || 0;
        }
        mapa[coord] = entry;
    }
    return mapa;
}

/**
 * Detecta qué escenarios están disponibles.
 * Intenta por orden:
 *   1. scenarios.json  (GitHub Pages / cualquier servidor estático)
 *   2. Listado de directorio del servidor Python
 *   3. Fallback: sondeo GET individual (lento, último recurso)
 */
async function detectScenarios(baseUrl) {
    // 1. Manifiesto JSON (GitHub Pages y servidores estáticos)
    try {
        const resp = await fetch(`${baseUrl}scenarios.json?t=${Date.now()}`, { cache: 'no-store' });
        if (resp.ok) {
            const list = await resp.json();
            // list = [{ num, url }, ...]  donde url es relativo al baseUrl
            if (Array.isArray(list) && list.length > 0) {
                return list
                    .map(e => ({ num: e.num, url: baseUrl + e.url }))
                    .sort((a, b) => a.num.localeCompare(b.num));
            }
        }
    } catch (_) { /* continuar al siguiente método */ }

    // 2. Listado de directorio (servidor Python SimpleHTTPRequestHandler)
    try {
        const resp = await fetch(baseUrl);
        if (resp.ok) {
            const html = await resp.text();
            const found = [];
            const re = /href="(Scenario[^"]*\.csv)"/gi;
            let m;
            while ((m = re.exec(html)) !== null) {
                const encoded = m[1];
                const decoded = decodeURIComponent(encoded);
                const nm = decoded.match(/Scenario\s*(\d{2})\.csv/i);
                if (nm) found.push({ num: nm[1], url: baseUrl + encoded });
            }
            if (found.length > 0) return found.sort((a, b) => a.num.localeCompare(b.num));
        }
    } catch (_) { /* continuar al fallback */ }

    // 3. Sondeo individual (último recurso)
    const promises = [];
    for (let i = 0; i <= 18; i++) {
        const num = String(i).padStart(2, '0');
        const urlSpace   = `${baseUrl}Scenario%20${num}.csv`;
        const urlNoSpace = `${baseUrl}Scenario${num}.csv`;
        promises.push(
            fetch(urlSpace, { method: 'GET' })
                .then(r => r.ok ? { num, url: urlSpace } : null)
                .catch(() => null)
                .then(res => res || fetch(urlNoSpace, { method: 'GET' })
                    .then(r => r.ok ? { num, url: urlNoSpace } : null)
                    .catch(() => null)
                )
        );
    }
    const results = await Promise.all(promises);
    return results.filter(Boolean);
}

// Exportar al namespace global
window.Loader = {
    loadScenario,
    loadUnits,
    parseScenarioText,
    parseUnitsText,
    detectScenarios,
};
