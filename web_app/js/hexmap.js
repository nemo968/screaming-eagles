/**
 * hexmap.js — Renderizado SVG del mapa hexagonal (flat-top hexes).
 *
 * Sistema de coordenadas:
 *   - Columnas: letras A-Q (A=0, B=1, ...)
 *   - Filas: 0-9
 *   - Columnas pares (A,C,E...): filas 1-9 (sin fila 0)
 *   - Columnas impares (B,D,F...): filas 0-9
 *   - Hexágonos flat-top: N y S son lados planos
 *
 * Conversión offset ↔ cubo (para distancias y LOS):
 *   cube: q=colIdx, r=row - floor(colIdx/2), s=-q-r
 */

'use strict';

const HexMap = (() => {

// ── Geometría ──────────────────────────────────────────────────────────────
const HEX_R  = 52;                         // radio (centro a vértice), px
const HEX_H  = Math.sqrt(3) * HEX_R;       // altura de hex flat-top ≈ 90 px
const MARGIN = 20;                          // margen SVG en px

// Colores de terreno
const TERRAIN_COLOR = {
    'TERRENO ABIERTO': '#8db88d',
    'CARRETERA':       '#c8b880',
    'EDIF. PIEDRA':    '#9a9090',
    'EDIF. MADERA':    '#b09070',
    'RIO / CANAL':     '#4070b0',
    'PUENTE':          '#b09060',
    'BOSQUE':          '#2d5a2d',
    'SETOS':           '#3a6a2a',
    'TRINCHERA':       '#6a5030',
    'ALAMBRE':         '#888060',
    'CAMPO TRIGO':     '#d0b840',
    'HUERTO':          '#609060',
    'CRESTA':          '#a08060',
    'COLINA':          '#c0a870',
};

const TERRAIN_FP_MOD = {
    'EDIF. PIEDRA':  -2,
    'EDIF. MADERA':  -1,
    'BOSQUE':        -1,
    'SETOS':         -2,
    'TRINCHERA':     -2,
    'CAMPO TRIGO':   -1,
    // HUERTO = 0 (orchard): no FP penalty cuando el objetivo está ahí,
    //   pero sí cuenta como hindrance al disparar A TRAVÉS de él.
};

// Terrenos considerados "beneficiosos": niegan el bono de "objetivo en movimiento
// en terreno abierto" y el modificador de elevación sobre infantería.
const TERRAIN_BENEFICIAL = new Set([
    'EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'SETOS', 'TRINCHERA', 'CAMPO TRIGO', 'HUERTO',
]);

const TERRAIN_MOVE_COST = {
    'TERRENO ABIERTO': 1,
    'CARRETERA':       1,
    'EDIF. PIEDRA':    2,
    'EDIF. MADERA':    2,
    'BOSQUE':          2,
    'PUENTE':          1,
    'RIO / CANAL':     999, // intransitable — nunca se usa (bloqueado antes del coste)
    'SETOS':           2,
    'TRINCHERA':       1,
    'ALAMBRE':         5,
    'CAMPO TRIGO':     2,   // PDF: 1.5 MPs → redondeado arriba a 2 para BFS entero
    'HUERTO':          1,
    'CRESTA':          2,
    'COLINA':          2,
};

const TERRAIN_BLOCKS_LOS = new Set([
    'EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'SETOS'
]);

// Modificador de FP por fortification en el hex objetivo (campo `fortif` del CSV)
const FORTIF_FP_MOD = {
    'PILLBOX': -3,
    'BUNKER':  -3,
    'FORTIF':  -2,  // fortín genérico
};

/**
 * Coste de movimiento por hex según el terreno y el tipo de unidad.
 * Valores del reglamento (Hoja de ayuda v2.3):
 *   Carretera:    inf=2/3, veh=1/2  (fractional — usa comparación float en BFS)
 *   Setos:        inf=1 (igual que terreno abierto), veh=½ del MP total (calculado fuera)
 *   Campo Trigo:  inf=1.5, veh=1
 *   Resto:        TERRAIN_MOVE_COST
 * @param {string}  terrain
 * @param {boolean} isVehicle  — true si vehículo o cañón
 * @param {number|null} totalMPs — MPs totales de la unidad (necesario para setos con vehículos)
 * @returns {number} coste en MPs (puede ser fraccionario)
 */
function terrainMoveCost(terrain, isVehicle, totalMPs = null) {
    if (terrain === 'CARRETERA') return isVehicle ? 0.5 : (2 / 3);
    if (terrain === 'CAMPO TRIGO') return isVehicle ? 1 : 1.5;
    if (terrain === 'SETOS') {
        if (isVehicle) {
            // Vehículos pagan ½ de sus MPs totales para cruzar un seto
            return totalMPs != null ? Math.ceil(totalMPs / 2) : 999;
        }
        return 1;  // infantería: igual que terreno abierto
    }
    return TERRAIN_MOVE_COST[terrain] || 1;
}

// Colores por bando
const FACTION_COLOR = {
    aliados: { fill: '#3a5818', bg2: '#2e4412', text: '#d8ff70', border: '#88c030', sel: '#ffff44' },
    eje:     { fill: '#4a3e24', bg2: '#382e18', text: '#f0dc88', border: '#9a7838', sel: '#ffff44' },
};

// ── Conversión de coordenadas ──────────────────────────────────────────────

function colIdx(col) { return col.charCodeAt(0) - 65; }
function colLetter(idx) { return String.fromCharCode(65 + idx); }

// Tablas de lookup para el formato de coordenadas ensambladas ("5A3", etc.)
// Se construyen en init() a partir de los datos _col/_row del CSV.
let _coordToGrid = {};   // coord → { q, r }  (coordenadas cúbicas globales)
let _gridToCoord = {};   // "q,r" → coord      (inverso, para fromCube)

/**
 * Extrae {ci, row} de un string de coordenada.
 * Soporta formatos:
 *   - Clásico: "A1", "I9"           (single-char col + row)
 *   - Ensamblado: "5A3", "12B7"     (map prefix + col + row)
 * Si hay lookup table disponible, la usa directamente.
 */
function _parseCoord(coord) {
    if (_coordToGrid[coord]) {
        const { q, r } = _coordToGrid[coord];
        return { ci: q, row: r + Math.floor(q / 2) };
    }
    // Parsear string: dígitos opcionales + letra(s) + dígitos
    const m = coord.match(/^(\d*)([A-Za-z]+)(\d+)$/);
    if (m) {
        const ci = colIdx(m[2].toUpperCase());
        return { ci, row: parseInt(m[3]) };
    }
    return { ci: 0, row: 0 };
}

/** Centro de un hex en píxeles SVG. */
function hexCenter(coord) {
    const { ci, row } = _parseCoord(coord);
    const cx = ci * HEX_R * 1.5 + HEX_R + MARGIN;
    // Columnas impares están desplazadas hacia abajo medio hex
    const cy = row * HEX_H + (ci % 2 === 1 ? HEX_H / 2 : 0) + MARGIN;
    return { cx, cy };
}

/** Polígono SVG de un hex centrado en (cx, cy). */
function hexPoints(cx, cy) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
        const angle = (60 * i) * Math.PI / 180;
        pts.push(`${(cx + HEX_R * Math.cos(angle)).toFixed(1)},${(cy + HEX_R * Math.sin(angle)).toFixed(1)}`);
    }
    return pts.join(' ');
}

/** Convierte coord a coordenadas cúbicas {q, r, s}. */
function toCube(coord) {
    if (_coordToGrid[coord]) {
        const { q, r } = _coordToGrid[coord];
        return { q, r, s: -q - r };
    }
    const { ci, row } = _parseCoord(coord);
    const q = ci;
    const r = row - Math.floor(q / 2);
    return { q, r, s: -q - r };
}

/** Convierte cubo {q, r} a coordenada. Usa lookup si está disponible. */
function fromCube(q, r) {
    const key = `${q},${r}`;
    if (_gridToCoord[key]) return _gridToCoord[key];
    const col = colLetter(q);
    const row = r + Math.floor(q / 2);
    return `${col}${row}`;
}

/** Distancia en hexes entre dos coordenadas. */
function hexDistance(a, b) {
    const ca = toCube(a);
    const cb = toCube(b);
    return Math.max(Math.abs(ca.q - cb.q), Math.abs(ca.r - cb.r), Math.abs(ca.s - cb.s));
}

// Direcciones cúbicas para flat-top: N, NE, SE, S, SW, NW
const CUBE_DIRS = {
    N:  { dq:  0, dr: -1 },
    NE: { dq: +1, dr: -1 },
    SE: { dq: +1, dr:  0 },
    S:  { dq:  0, dr: +1 },
    SW: { dq: -1, dr: +1 },
    NW: { dq: -1, dr:  0 },
};
const ALL_DIRS = Object.keys(CUBE_DIRS);

/** Vecinos válidos de un hex (que existen en el mapa). */
function hexNeighbors(coord, mapData) {
    const { q, r } = toCube(coord);
    const neighbors = [];
    for (const dir of ALL_DIRS) {
        const { dq, dr } = CUBE_DIRS[dir];
        const nb = fromCube(q + dq, r + dr);
        if (mapData[nb]) neighbors.push({ coord: nb, dir });
    }
    return neighbors;
}

/**
 * Interpola linealmente para LOS: retorna todos los hexes entre from y to.
 * @param {string} from
 * @param {string} to
 * @param {object} mapData
 * @param {{dq:number, dr:number}} [eps] — desplazamiento épsilon en coords cúbicas (nudge para tangentes)
 */
function hexesInLine(from, to, mapData, eps = { dq: 0, dr: 0 }) {
    const c1 = toCube(from);
    const c2 = toCube(to);
    const dist = hexDistance(from, to);
    if (dist === 0) return [from];
    const hexes = [];
    for (let i = 0; i <= dist; i++) {
        const t = i / dist;
        const fq = c1.q + (c2.q - c1.q) * t + eps.dq;
        const fr = c1.r + (c2.r - c1.r) * t + eps.dr;
        const fs = -fq - fr;
        // Redondeo cúbico
        let rq = Math.round(fq);
        let rr = Math.round(fr);
        let rs = Math.round(fs);
        const qd = Math.abs(rq - fq);
        const rd = Math.abs(rr - fr);
        const sd = Math.abs(rs - fs);
        if (qd > rd && qd > sd) rq = -rr - rs;
        else if (rd > sd) rr = -rq - rs;
        else rs = -rq - rr;
        const h = fromCube(rq, rr);
        if (mapData[h]) hexes.push(h);
    }
    return hexes;
}

/**
 * Detecta la coordenada de un hex a partir de un punto (x, y) en el SVG.
 */
function hexFromPoint(x, y, mapData) {
    let best = null;
    let bestDist = Infinity;
    for (const coord of Object.keys(mapData)) {
        const { cx, cy } = hexCenter(coord);
        const d = Math.hypot(x - cx, y - cy);
        if (d < bestDist && d < HEX_R * 1.1) {
            bestDist = d;
            best = coord;
        }
    }
    return best;
}

// ── Renderizado SVG ─────────────────────────────────────────────────────────

let _svg = null;
let _mapData = null;
let _units = null;
let _highlights = {};   // coord → Set of class names
let _onHexClick = null;

/**
 * Calcula el tamaño del SVG necesario para el mapa dado.
 */
function calcSVGSize(mapData) {
    let maxX = 0, maxY = 0;
    for (const coord of Object.keys(mapData)) {
        const { cx, cy } = hexCenter(coord);
        if (cx + HEX_R + MARGIN > maxX) maxX = cx + HEX_R + MARGIN;
        if (cy + HEX_H / 2 + MARGIN > maxY) maxY = cy + HEX_H / 2 + MARGIN;
    }
    return { w: maxX, h: maxY };
}

/**
 * Inicializa el SVG en el elemento dado y dibuja el mapa base.
 * @param {SVGSVGElement} svgEl
 * @param {object} mapData - ScenarioData.mapa
 * @param {function} onHexClick(coord)
 */
function init(svgEl, mapData, onHexClick) {
    _svg = svgEl;
    _mapData = mapData;
    _units = [];
    _highlights = {};
    _onHexClick = onHexClick;

    // Construir tablas de lookup si el CSV tiene columnas Col/Row (formato ensamblado)
    _coordToGrid = {};
    _gridToCoord = {};
    for (const [coord, hex] of Object.entries(mapData)) {
        if (hex._col !== undefined && hex._row !== undefined) {
            const q = hex._col;
            const r = hex._row - Math.floor(hex._col / 2);
            _coordToGrid[coord] = { q, r };
            _gridToCoord[`${q},${r}`] = coord;
        }
    }

    const { w, h } = calcSVGSize(mapData);
    _svg.setAttribute('width', w);
    _svg.setAttribute('height', h);
    _svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    _svg.innerHTML = '';

    // Capa de terreno
    const terrainG = _createG('layer-terrain');
    _svg.appendChild(terrainG);

    // Capa de highlights
    const hlG = _createG('layer-highlights');
    _svg.appendChild(hlG);

    // Capa de unidades
    const unitsG = _createG('layer-units');
    _svg.appendChild(unitsG);

    // Capa de etiquetas de coordenada
    const labelsG = _createG('layer-labels');
    _svg.appendChild(labelsG);

    // Dibujar hexes de terreno
    for (const [coord, hex] of Object.entries(mapData)) {
        const { cx, cy } = hexCenter(coord);
        const color = TERRAIN_COLOR[hex.terreno] || '#888';
        const poly = _svgEl('polygon', {
            points: hexPoints(cx, cy),
            fill: color,
            stroke: '#1a2a1a',
            'stroke-width': '1.5',
            'data-coord': coord,
        });
        poly.addEventListener('click', () => _handleHexClick(coord));
        terrainG.appendChild(poly);

        // Etiqueta de coordenada
        const lbl = _svgEl('text', {
            x: cx, y: cy + HEX_R * 0.65,
            'text-anchor': 'middle',
            'font-family': 'Courier New, monospace',
            'font-size': '11',
            fill: '#1e4a1e',
            'pointer-events': 'none',
        });
        lbl.textContent = coord;
        labelsG.appendChild(lbl);

        // Símbolo de terreno especial
        const sym = _terrainSymbol(hex.terreno, cx, cy);
        if (sym) terrainG.appendChild(sym);

        // Símbolo de fortification
        if (hex.fortif && hex.fortif !== 'NINGUNA' && hex.fortif !== 'NO' && hex.fortif !== '') {
            const fsym = _fortifSymbol(hex.fortif, cx, cy);
            if (fsym) terrainG.appendChild(fsym);
        }

        // Símbolo de upper level (pequeño "▲" en la esquina)
        if (hex.upper_level) {
            const ul = _svgEl('text', {
                x: cx + HEX_R * 0.55, y: cy - HEX_R * 0.45,
                'text-anchor': 'middle', 'font-size': '11',
                fill: '#e0d0b0', 'font-weight': 'bold',
                'pointer-events': 'none',
            });
            ul.textContent = '▲';
            terrainG.appendChild(ul);
        }
    }

    // Click en SVG vacío
    _svg.addEventListener('click', (e) => {
        if (e.target === _svg) _handleHexClick(null);
    });
}

function _handleHexClick(coord) {
    if (_onHexClick) _onHexClick(coord);
}

function _createG(id) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', id);
    return g;
}

function _svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

function _terrainSymbol(terreno, cx, cy) {
    if (terreno === 'RIO / CANAL') {
        const lines = _svgEl('g', {});
        for (let i = -1; i <= 1; i++) {
            const l = _svgEl('line', {
                x1: cx - 15, y1: cy + i * 8,
                x2: cx + 15, y2: cy + i * 8,
                stroke: '#6ab0f0', 'stroke-width': '2', opacity: '0.6',
            });
            lines.appendChild(l);
        }
        return lines;
    }
    if (terreno === 'BOSQUE') {
        const t = _svgEl('text', {
            x: cx, y: cy + 5,
            'text-anchor': 'middle',
            'font-size': '18',
            'pointer-events': 'none',
        });
        t.textContent = '🌲';
        return t;
    }
    if (terreno === 'PUENTE') {
        const r = _svgEl('rect', {
            x: cx - 14, y: cy - 4, width: 28, height: 8,
            fill: '#d0b060', stroke: '#806020', 'stroke-width': '1',
            rx: '2', 'pointer-events': 'none',
        });
        return r;
    }
    return null;
}

function _fortifSymbol(fortif, cx, cy) {
    const g = _svgEl('g', { 'pointer-events': 'none' });
    // Rectángulo exterior del fortín
    const rect = _svgEl('rect', {
        x: cx - 12, y: cy - 9, width: 24, height: 18,
        fill: 'none', stroke: '#c0a840', 'stroke-width': '2',
        rx: '2',
    });
    g.appendChild(rect);
    // Texto del tipo
    const lbl = _svgEl('text', {
        x: cx, y: cy + 4,
        'text-anchor': 'middle', 'font-size': '8',
        fill: '#c0a840', 'font-weight': 'bold',
    });
    lbl.textContent = fortif.slice(0, 4);
    g.appendChild(lbl);
    return g;
}

/**
 * Actualiza los highlights de hexes.
 * @param {object} highlights - { coord: ['class1', ...] }
 */
function setHighlights(highlights) {
    _highlights = highlights || {};
    _redrawHighlights();
}

function clearHighlights() {
    _highlights = {};
    _redrawHighlights();
}

function _redrawHighlights() {
    const hlG = _svg.querySelector('#layer-highlights');
    hlG.innerHTML = '';
    for (const [coord, classes] of Object.entries(_highlights)) {
        if (!_mapData[coord]) continue;
        const { cx, cy } = hexCenter(coord);
        for (const cls of classes) {
            const poly = _svgEl('polygon', {
                points: hexPoints(cx, cy),
                class: `hex-hl ${cls}`,
                'pointer-events': 'none',
            });
            hlG.appendChild(poly);
        }
    }
}

/**
 * Redibuja las unidades en el mapa.
 * @param {UnitInstance[]} units
 * @param {string|null} selectedId - id de unidad seleccionada
 */
function drawUnits(units, selectedId = null, playerSide = null) {
    _units = units;
    const unitsG = _svg.querySelector('#layer-units');
    unitsG.innerHTML = '';

    // Agrupar unidades por coord
    const byCoord = {};
    for (const u of units) {
        if (u.eliminado || !u.coord) continue;
        if (!byCoord[u.coord]) byCoord[u.coord] = [];
        byCoord[u.coord].push(u);
    }

    for (const [coord, hexUnits] of Object.entries(byCoord)) {
        const { cx, cy } = hexCenter(coord);
        hexUnits.forEach((u, idx) => {
            const offsetX = (idx - (hexUnits.length - 1) / 2) * 20;
            const isHidden = playerSide && u.lado !== playerSide && u.oculto;
            _drawCounter(unitsG, u, cx + offsetX, cy - 2, u.id === selectedId, isHidden);
        });
    }
}

function _drawCounter(parent, unit, cx, cy, selected, isHidden = false) {
    const W = 48, H = 40;

    if (isHidden) {
        // Render concealed enemy counter as "???"
        const fc = FACTION_COLOR[unit.lado] || FACTION_COLOR.eje;
        const g = _svgEl('g', { 'data-unit-id': unit.id, cursor: 'pointer' });
        g.appendChild(_svgEl('rect', {
            x: cx - W/2 + 2, y: cy - H/2 + 2, width: W, height: H,
            rx: '3', fill: '#00000050', 'pointer-events': 'none',
        }));
        g.appendChild(_svgEl('rect', {
            x: cx - W/2, y: cy - H/2, width: W, height: H,
            rx: '3', fill: '#1a1a2e', stroke: fc.border, 'stroke-width': '1.5',
        }));
        const qEl = _svgEl('text', {
            x: cx, y: cy + 5,
            'text-anchor': 'middle', 'dominant-baseline': 'middle',
            'font-family': 'Courier New, monospace',
            'font-size': '16', 'font-weight': 'bold',
            fill: fc.border, 'pointer-events': 'none',
        });
        qEl.textContent = '???';
        g.appendChild(qEl);
        g.addEventListener('click', () => _onUnitClick(unit.id));
        parent.appendChild(g);
        return;
    }

    const fc = FACTION_COLOR[unit.lado] || FACTION_COLOR.eje;
    const g = _svgEl('g', { 'data-unit-id': unit.id, cursor: 'pointer' });

    // ── Color de borde según supresión / selección ──────────────────────────
    const borderColor = selected           ? fc.sel
                      : unit.supresion === 2 ? '#e03030'
                      : unit.supresion === 1 ? '#e09020'
                      : fc.border;
    const borderW = selected ? '2.5' : '1.5';

    // ── Sombra (depth) ────────────────────────────────────────────────────────
    g.appendChild(_svgEl('rect', {
        x: cx - W/2 + 2, y: cy - H/2 + 2, width: W, height: H,
        rx: '3', fill: '#00000050', 'pointer-events': 'none',
    }));

    // ── Fondo principal ───────────────────────────────────────────────────────
    g.appendChild(_svgEl('rect', {
        x: cx - W/2, y: cy - H/2, width: W, height: H,
        rx: '3', fill: fc.fill, stroke: borderColor, 'stroke-width': borderW,
    }));

    // ── Franja superior más oscura (cabecera) ─────────────────────────────────
    const HEADER_H = 14;
    g.appendChild(_svgEl('rect', {
        x: cx - W/2 + 1, y: cy - H/2 + 1, width: W - 2, height: HEADER_H,
        rx: '2', fill: fc.bg2, 'pointer-events': 'none',
    }));

    // ── Nombre abreviado (en la cabecera) ─────────────────────────────────────
    const nameEl = _svgEl('text', {
        x: cx, y: cy - H/2 + 11,
        'text-anchor': 'middle', 'dominant-baseline': 'auto',
        'font-family': 'Courier New, monospace',
        'font-size': '10', 'font-weight': 'bold',
        fill: fc.text, 'pointer-events': 'none',
    });
    nameEl.textContent = _abbrev(unit.tipo, unit.cara === 'reduced');
    g.appendChild(nameEl);

    // ── Línea divisoria ────────────────────────────────────────────────────────
    g.appendChild(_svgEl('line', {
        x1: cx - W/2 + 2, y1: cy - H/2 + HEADER_H + 1,
        x2: cx + W/2 - 2, y2: cy - H/2 + HEADER_H + 1,
        stroke: fc.border, 'stroke-width': '0.8', 'pointer-events': 'none',
    }));

    // ── Cuerpo: FP (izq) y MP (der) ──────────────────────────────────────────
    const bodyY = cy - H/2 + HEADER_H + 14;
    const fpColor = unit.supresion === 2 ? '#ff6060'
                  : unit.supresion === 1 ? '#ffbb44'
                  : fc.text;

    const fpEl = _svgEl('text', {
        x: cx - W/2 + 5, y: bodyY,
        'text-anchor': 'start',
        'font-family': 'Courier New, monospace',
        'font-size': '10', 'font-weight': 'bold',
        fill: fpColor, 'pointer-events': 'none',
    });
    fpEl.textContent = `${unit.fp_actual ?? '?'}`;
    g.appendChild(fpEl);

    // Etiqueta "FP" pequeña debajo
    const fpLblEl = _svgEl('text', {
        x: cx - W/2 + 5, y: bodyY + 9,
        'text-anchor': 'start',
        'font-family': 'Courier New, monospace',
        'font-size': '7',
        fill: fc.border, 'pointer-events': 'none',
    });
    fpLblEl.textContent = 'FP';
    g.appendChild(fpLblEl);

    // MPs (derecha)
    const mpEl = _svgEl('text', {
        x: cx + W/2 - 4, y: bodyY,
        'text-anchor': 'end',
        'font-family': 'Courier New, monospace',
        'font-size': '10',
        fill: fc.text, 'pointer-events': 'none',
    });
    mpEl.textContent = `${unit.data.mps ?? '?'}`;
    g.appendChild(mpEl);

    const mpLblEl = _svgEl('text', {
        x: cx + W/2 - 4, y: bodyY + 9,
        'text-anchor': 'end',
        'font-family': 'Courier New, monospace',
        'font-size': '7',
        fill: fc.border, 'pointer-events': 'none',
    });
    mpLblEl.textContent = 'MP';
    g.appendChild(mpLblEl);

    // ── Badges de marcadores (esquina superior derecha) ───────────────────────
    let badgeX = cx + W/2 - 3;
    const badgeY = cy - H/2 + 9;

    if (unit.marcadores.has('usado')) {
        const bw = 12;
        badgeX -= bw;
        g.appendChild(_svgEl('rect', {
            x: badgeX, y: badgeY - 7, width: bw, height: 8,
            rx: '1', fill: '#505050', 'pointer-events': 'none',
        }));
        const bt = _svgEl('text', {
            x: badgeX + bw/2, y: badgeY - 0.5,
            'text-anchor': 'middle',
            'font-family': 'Courier New, monospace',
            'font-size': '6', fill: '#aaaaaa', 'pointer-events': 'none',
        });
        bt.textContent = 'USED';
        g.appendChild(bt);
    }
    if (unit.marcadores.has('op_fire')) {
        const bw = 12;
        badgeX -= bw + 1;
        g.appendChild(_svgEl('rect', {
            x: badgeX, y: cy - H/2 + 2, width: bw, height: 8,
            rx: '1', fill: '#5a3800', 'pointer-events': 'none',
        }));
        const bt = _svgEl('text', {
            x: badgeX + bw/2, y: cy - H/2 + 9,
            'text-anchor': 'middle',
            'font-family': 'Courier New, monospace',
            'font-size': '6', fill: '#ffcc44', 'pointer-events': 'none',
        });
        bt.textContent = 'OP';
        g.appendChild(bt);
    }

    // ── Indicador OCULTO (punto verde, esquina inf-izq) ─────────────────────
    if (unit.oculto) {
        g.appendChild(_svgEl('circle', {
            cx: cx - W/2 + 5, cy: cy + H/2 - 5, r: '3.5',
            fill: '#44ff44', stroke: '#22aa22', 'stroke-width': '0.5',
            'pointer-events': 'none',
        }));
    }

    // ── Indicador cara REDUCIDA (esquina inf-der) ─────────────────────────────
    if (unit.cara === 'reduced') {
        g.appendChild(_svgEl('circle', {
            cx: cx + W/2 - 5, cy: cy + H/2 - 5, r: '3.5',
            fill: '#cc4444', stroke: '#881111', 'stroke-width': '0.5',
            'pointer-events': 'none',
        }));
    }

    // ── Overlay de supresión ──────────────────────────────────────────────────
    if (unit.supresion === 2) {
        g.appendChild(_svgEl('rect', {
            x: cx - W/2, y: cy - H/2, width: W, height: H,
            rx: '3', fill: '#ff000025', 'pointer-events': 'none',
        }));
        // Cruz de supresión total
        g.appendChild(_svgEl('line', {
            x1: cx - W/2 + 4, y1: cy - H/2 + 4,
            x2: cx + W/2 - 4, y2: cy + H/2 - 4,
            stroke: '#cc2020', 'stroke-width': '1.5',
            opacity: '0.6', 'pointer-events': 'none',
        }));
        g.appendChild(_svgEl('line', {
            x1: cx + W/2 - 4, y1: cy - H/2 + 4,
            x2: cx - W/2 + 4, y2: cy + H/2 - 4,
            stroke: '#cc2020', 'stroke-width': '1.5',
            opacity: '0.6', 'pointer-events': 'none',
        }));
    } else if (unit.supresion === 1) {
        g.appendChild(_svgEl('rect', {
            x: cx - W/2, y: cy - H/2, width: W, height: H,
            rx: '3', fill: '#ffaa0018', 'pointer-events': 'none',
        }));
    }

    g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_onHexClick) _onHexClick(unit.coord, unit.id);
    });

    parent.appendChild(g);
}

function _abbrev(tipo, isReduced) {
    // Reglas especiales para nombres comunes de Screaming Eagles
    const t = tipo.trim();
    const up = t.toUpperCase();
    let s;
    if (up.includes('DECOY'))        s = 'DECOY';
    else if (up.includes('MACHINE GUN') || up.includes(' MG')) s = t.replace(/machine gun/i,'MG').split(' ').slice(0,2).join(' ');
    else if (up.includes('MORTAR'))  s = t.split(' ').filter(w => /\d|mm|mortar/i.test(w)).slice(0,2).join(' ') || 'MORT';
    else if (up.includes('SQUAD'))   s = t.split(' ').slice(0,2).join(' ');
    else if (up.includes('PANZER') || up.includes('TIGER') || up.includes('SHERMAN')) {
        s = t.split(' ').slice(0, 2).join(' ');
    }
    else {
        // Genérico: 2 primeras palabras, max 5 chars cada una
        s = t.split(' ').slice(0, 2).map(w => w.slice(0, 5)).join(' ');
    }
    // Limitar longitud total a 9 caracteres (cabe en W=48 a font-size 10)
    if (s.length > 9) s = s.slice(0, 9);
    if (isReduced) s = s.replace(/\(R\)$/,'').trim() + '(R)';
    return s;
}

/**
 * Dibuja una línea de LOS desde `from` a `to` en el SVG.
 */
function drawLOS(from, to) {
    const g = _svg.querySelector('#layer-highlights');
    const c1 = hexCenter(from);
    const c2 = hexCenter(to);
    const existing = _svg.querySelector('#los-line');
    if (existing) existing.remove();
    const line = _svgEl('line', {
        id: 'los-line',
        x1: c1.cx, y1: c1.cy,
        x2: c2.cx, y2: c2.cy,
        stroke: '#ffaa00',
        'stroke-width': '1.5',
        'stroke-dasharray': '4,3',
        opacity: '0.7',
        'pointer-events': 'none',
    });
    g.appendChild(line);
}

function clearLOS() {
    const el = _svg ? _svg.querySelector('#los-line') : null;
    if (el) el.remove();
}

/**
 * Dibuja overlays de humo sobre el SVG.
 * @param {Object} smoke — coord → { tipo: 'smoke'|'dispersed' }
 */
function drawSmoke(smoke) {
    if (!_svg) return;
    // Eliminar overlays anteriores
    _svg.querySelectorAll('.smoke-overlay').forEach(el => el.remove());
    if (!smoke || Object.keys(smoke).length === 0) return;

    const g = _svg.querySelector('#layer-highlights') || _svg;
    for (const [coord, s] of Object.entries(smoke)) {
        const { cx, cy } = hexCenter(coord);
        const pts = hexPoints(cx, cy);
        const isND = s.tipo === 'smoke';  // no disperso = más denso

        // Polígono semitransparente de humo
        const poly = _svgEl('polygon', {
            class: 'smoke-overlay',
            points: pts,
            fill: isND ? 'rgba(200,200,215,0.45)' : 'rgba(200,200,215,0.20)',
            stroke: isND ? 'rgba(160,160,180,0.6)' : 'rgba(160,160,180,0.3)',
            'stroke-width': '1',
            'pointer-events': 'none',
        });
        g.appendChild(poly);

        // Símbolo de humo
        const label = _svgEl('text', {
            class: 'smoke-overlay',
            x: cx,
            y: cy + 5,
            'text-anchor': 'middle',
            'font-size': '18',
            fill: isND ? 'rgba(100,100,120,0.8)' : 'rgba(130,130,150,0.5)',
            'pointer-events': 'none',
        });
        label.textContent = isND ? '☁' : '~';
        g.appendChild(label);
    }
}

// ── Hexsides ────────────────────────────────────────────────────────────────

// Direcciones opuestas (para la comprobación del lado compartido)
const OPPOSITE_DIR = { N: 'S', NE: 'SW', SE: 'NW', S: 'N', SW: 'NE', NW: 'SE' };

/**
 * Devuelve la dirección de toCoord vista desde fromCoord (N/NE/SE/S/SW/NW),
 * o null si no son adyacentes.
 */
function hexDirBetween(fromCoord, toCoord) {
    const c1 = toCube(fromCoord);
    const c2 = toCube(toCoord);
    const dq = c2.q - c1.q, dr = c2.r - c1.r;
    for (const [dir, d] of Object.entries(CUBE_DIRS)) {
        if (d.dq === dq && d.dr === dr) return dir;
    }
    return null;
}

/**
 * Devuelve el valor del hexside entre fromCoord y toCoord (según el campo `lados` del hex origen).
 * Si el lado está marcado con cualquier valor truthy ('SI'), devuelve ese valor; si no, null.
 */
function hexsideValue(fromCoord, toCoord, mapa) {
    const dir = hexDirBetween(fromCoord, toCoord);
    if (!dir) return null;
    const hex = mapa[fromCoord];
    if (!hex?.lados) return null;
    return hex.lados[dir] || null;
}

const HEXSIDE_BOCAGE_VALUE = 'SI';  // el CSV usa 'SI' para marcar hexsides de bocage

/**
 * Dibuja los hexsides de bocage sobre el SVG como líneas gruesas verdes.
 * @param {object} mapData
 */
function drawHexsides(mapData) {
    if (!_svg) return;
    _svg.querySelectorAll('.hexside-bocage').forEach(el => el.remove());

    const drawn = new Set();  // evitar duplicar cada lado (A→B y B→A)
    for (const [coord, hex] of Object.entries(mapData)) {
        if (!hex.lados) continue;
        const { cx: x1, cy: y1 } = hexCenter(coord);
        const c = toCube(coord);

        for (const [dir, d] of Object.entries(CUBE_DIRS)) {
            if (!hex.lados[dir]) continue;

            const nb = fromCube(c.q + d.dq, c.r + d.dr);
            const key = [coord, nb].sort().join('|');
            if (drawn.has(key)) continue;
            drawn.add(key);

            // Calcular los dos vértices del hexside
            // En flat-top, los vértices del lado `dir` están en los ángulos i y i+1
            const dirIdx = ALL_DIRS.indexOf(dir);
            const a1 = (60 * dirIdx - 30) * Math.PI / 180;
            const a2 = (60 * (dirIdx + 1) - 30) * Math.PI / 180;
            const vx1 = x1 + HEX_R * Math.cos(a1);
            const vy1 = y1 + HEX_R * Math.sin(a1);
            const vx2 = x1 + HEX_R * Math.cos(a2);
            const vy2 = y1 + HEX_R * Math.sin(a2);

            const line = _svgEl('line', {
                class: 'hexside-bocage',
                x1: vx1.toFixed(1), y1: vy1.toFixed(1),
                x2: vx2.toFixed(1), y2: vy2.toFixed(1),
                stroke: '#5a8a30', 'stroke-width': '4',
                'stroke-linecap': 'round',
                'pointer-events': 'none',
            });
            _svg.querySelector('#layer-terrain').appendChild(line);
        }
    }
}

// ── Exports ─────────────────────────────────────────────────────────────────
return {
    HEX_R, HEX_H, MARGIN,
    TERRAIN_COLOR, TERRAIN_FP_MOD, TERRAIN_MOVE_COST, TERRAIN_BLOCKS_LOS, TERRAIN_BENEFICIAL,
    FORTIF_FP_MOD,
    FACTION_COLOR,
    colIdx, colLetter, coordParts: _parseCoord, terrainMoveCost, hexCenter, hexPoints,
    toCube, fromCube, hexDistance, hexNeighbors, hexesInLine, hexFromPoint,
    hexDirBetween, hexsideValue,
    init, drawUnits, setHighlights, clearHighlights, drawLOS, clearLOS,
    drawSmoke, drawHexsides,
    calcSVGSize,
};

})();

window.HexMap = HexMap;
