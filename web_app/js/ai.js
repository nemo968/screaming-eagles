/**
 * ai.js — Lógica de decisión de la IA para Screaming Eagles.
 *
 * La IA es un sistema basado en reglas (heurísticas) que:
 * 1. Analiza el CSV del escenario: objetivos, rol atacante/defensor, urgencia por turno.
 * 2. Despliega sus unidades considerando objetivos, rol y mecánica de ocultación.
 * 3. Durante ops elige acciones con puntuación táctica contextual al escenario.
 *
 * Usa A* para pathfinding con los costes correctos del reglamento.
 */

'use strict';

const AI = (() => {

// ────────────────────────────────────────────────────────────────────────────
// A* Pathfinding
// ────────────────────────────────────────────────────────────────────────────

/**
 * A* sobre hex grid.
 * @returns {string[]} ruta de coords (sin origen, incluye destino), o [] si no hay ruta.
 */
function aStar(from, to, gs, unit) {
    if (from === to) return [];
    const open = new Map([[from, { g: 0, f: HexMap.hexDistance(from, to), prev: null }]]);
    const closed = new Set();
    const isVehicle = ['vehicle', 'gun'].includes(unit.data.categoria);
    const unitMaxMPs = unit.data.mps || 5;

    while (open.size > 0) {
        let current = null, best = Infinity;
        for (const [coord, node] of open.entries()) {
            if (node.f < best) { best = node.f; current = coord; }
        }
        if (current === to) return _reconstructPath(open, current);

        const currentNode = open.get(current);
        open.delete(current);
        closed.add(current);

        for (const { coord: nb } of HexMap.hexNeighbors(current, gs.mapa)) {
            if (closed.has(nb)) continue;
            const hex = gs.mapa[nb];
            if (!hex) continue;
            if (hex.terreno === 'RIO / CANAL') continue;

            let cost = HexMap.terrainMoveCost(hex.terreno, isVehicle, unitMaxMPs);
            // Zona de control: penalizar hexes con enemigos
            if (Engine.getEnemiesAt(nb, unit.lado, gs).length > 0) cost += 4;

            const g = currentNode.g + cost;
            const existing = open.get(nb);
            if (!existing || g < existing.g) {
                open.set(nb, { g, f: g + HexMap.hexDistance(nb, to), prev: current });
            }
        }
    }
    return [];
}

function _reconstructPath(open, to) {
    const path = [];
    let current = to;
    while (open.has(current) && open.get(current).prev !== null) {
        path.unshift(current);
        current = open.get(current).prev;
    }
    return path;
}

// ────────────────────────────────────────────────────────────────────────────
// Análisis del escenario
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extrae coordenadas de objetivo del texto de victoria.
 * Soporta formatos: "5E5" (ensamblado) y "E5" (clásico).
 */
function extractObjectives(scenario) {
    const text = scenario.meta.victoria + ' ' + (scenario.meta.descripcion || '');
    // Captura coords en ambos formatos: "5E5" o "E5"
    const hexPattern = /\b(\d+[A-Z]\d+|[A-Z]\d+)\b/g;
    const hexes = [];
    let m;
    while ((m = hexPattern.exec(text)) !== null) {
        if (scenario.mapa && scenario.mapa[m[1]]) hexes.push(m[1]);
    }
    return [...new Set(hexes)];
}

/**
 * Analiza el CSV del escenario y devuelve el contexto táctico para la IA.
 * @returns {{
 *   aiRole: 'attacker'|'defender',
 *   objectives: string[],
 *   criticalHexes: string[],
 *   urgency: number,        // 0=no urgencia, 1=máxima urgencia
 *   turnsLeft: number,
 *   victoryNeedsCapture: boolean,
 *   victoryNeedsHold: boolean,
 *   routDir: string,
 * }}
 */
function _analyzeScenario(gs) {
    const aiSide   = gs.aiSide;
    const scenario = gs.scenario;
    const aiDeplTxt  = (aiSide === 'aliados'
        ? scenario.factions.aliados.despliegue
        : scenario.factions.eje.despliegue).toLowerCase();
    const aiAltTxt   = (aiSide === 'aliados'
        ? scenario.factions.aliados.despliegue_alt
        : scenario.factions.eje.despliegue_alt).toLowerCase();

    // Determinar rol: atacante si "enter", "advance", "attack", "cross", "capture" en despliegue
    const attackWords = ['enter', 'advance', 'attack', 'cross', 'capture', 'assault', 'entran', 'avanza', 'cruza'];
    const isAttacker  = attackWords.some(w => aiDeplTxt.includes(w));
    const aiRole      = isAttacker ? 'attacker' : 'defender';

    // Objetivos del texto de victoria
    const objectives = extractObjectives(scenario);

    // Hexes críticos: objetivos + puentes + edificios adyacentes a objetivos
    const criticalHexes = new Set(objectives);
    for (const obj of objectives) {
        for (const { coord: nb } of HexMap.hexNeighbors(obj, gs.mapa)) {
            const hex = gs.mapa[nb];
            if (hex && ['EDIF. PIEDRA', 'EDIF. MADERA', 'PUENTE'].includes(hex.terreno)) {
                criticalHexes.add(nb);
            }
        }
    }
    // Añadir todos los puentes del mapa (siempre son críticos)
    for (const [coord, hex] of Object.entries(gs.mapa)) {
        if (hex.terreno === 'PUENTE') criticalHexes.add(coord);
    }

    const turnsLeft = gs.maxTurnos - gs.turno + 1;
    const urgency   = Math.max(0, 1 - (turnsLeft - 1) / gs.maxTurnos);

    // Tipo de victoria
    const victoriaText = scenario.meta.victoria.toLowerCase();
    const victoryNeedsCapture = ['controls', 'capture', 'occupy', 'controla', 'captura'].some(w => victoriaText.includes(w));
    const victoryNeedsHold    = ['holds', 'retains', 'sole occupant', 'mantiene'].some(w => victoriaText.includes(w));

    const routDir = (aiSide === 'aliados'
        ? scenario.factions.aliados.ruta_huida
        : scenario.factions.eje.ruta_huida) || 'E';

    return {
        aiRole,
        objectives,
        criticalHexes: [...criticalHexes],
        urgency,
        turnsLeft,
        victoryNeedsCapture,
        victoryNeedsHold,
        routDir,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Despliegue IA
// ────────────────────────────────────────────────────────────────────────────

/**
 * Despliega las unidades de la IA de forma táctica según el escenario.
 */
function aiDeploy(aiSide, gs) {
    const validHexes = Engine.getDeploymentHexes(aiSide, gs);
    if (validHexes.length === 0) return;

    const ctx     = _analyzeScenario(gs);
    const aiUnits = gs.unidades.filter(u => u.lado === aiSide && !u.eliminado && !u.coord);

    // Puntuar hexes de despliegue
    const scoredHexes = validHexes.map(coord => {
        const hex = gs.mapa[coord];
        const { ci, row } = HexMap.coordParts(coord);
        let score = 0;

        // Cobertura — siempre valiosa
        if (hex.terreno === 'EDIF. PIEDRA') score += 6;
        else if (['EDIF. MADERA', 'BOSQUE', 'TRINCHERA'].includes(hex.terreno)) score += 4;
        else if (hex.terreno === 'SETOS') score += 2;

        // Elevación — posiciones altas dan ventaja
        score += (hex.elevacion || 0) * 2;

        // Proximidad a hexes críticos (objetivos, puentes)
        for (const crit of ctx.criticalHexes) {
            if (gs.mapa[crit]) {
                const d = HexMap.hexDistance(coord, crit);
                score += Math.max(0, 6 - d) * (ctx.objectives.includes(crit) ? 2 : 1);
            }
        }

        // Defensor: preferir posición entre los objetivos y la entrada enemiga
        // Atacante: preferir posición más avanzada hacia el objetivo
        if (ctx.aiRole === 'defender') {
            // Mantenerse cerca de objetivos sin quedar expuesto
            for (const obj of ctx.objectives) {
                const d = HexMap.hexDistance(coord, obj);
                if (d <= 2) score += 4;
            }
        } else {
            // Atacante: proximidad al frente
            const allCi = validHexes.map(c => HexMap.coordParts(c).ci);
            const maxCi = Math.max(...allCi);
            const minCi = Math.min(...allCi);
            // Preferir columna más avanzada en dirección al objetivo
            if (ctx.objectives.length > 0) {
                const objCi = HexMap.coordParts(ctx.objectives[0]).ci;
                const advDir = objCi > (maxCi + minCi) / 2 ? ci : (maxCi - ci);
                score += advDir * 0.5;
            }
        }

        return { coord, score };
    });

    scoredHexes.sort((a, b) => b.score - a.score);

    // Ordenar unidades: MG/cañones primero → morteros → squads → decoys
    const catPriority = { wt_mg: 0, gun: 1, wt_mortar: 2, squad: 3, vehicle: 4, decoy: 5 };
    const sortedUnits = [...aiUnits].sort((a, b) =>
        (catPriority[a.data.categoria] ?? 6) - (catPriority[b.data.categoria] ?? 6)
    );

    for (const unit of sortedUnits) {
        let placed = false;

        for (const { coord } of scoredHexes) {
            // Respetar apilamiento
            const cnt = gs.unidades.filter(u => u.coord === coord && u.lado === aiSide && !u.eliminado).length;
            if (cnt >= 2) continue;

            const hex = gs.mapa[coord];

            // MG WT: sólo en cobertura con LOS (para habilitar Op Fire)
            if (unit.data.categoria === 'wt_mg') {
                if (!['EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'SETOS'].includes(hex.terreno)) continue;
            }

            // Cañones: sólo en posiciones con LOS al enfoque enemigo
            if (unit.data.categoria === 'gun') {
                if (!['TERRENO ABIERTO', 'CARRETERA', 'EDIF. PIEDRA'].includes(hex.terreno)) continue;
            }

            // DECOY: en cobertura para maximizar incertidumbre
            if (unit.data.categoria === 'decoy') {
                if (!['EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'SETOS'].includes(hex.terreno)) continue;
            }

            unit.coord = coord;
            Engine.applyInitialConceal(unit, gs);
            placed = true;
            break;
        }

        // Fallback: cualquier hex con espacio disponible
        if (!placed) {
            for (const { coord } of scoredHexes) {
                const cnt = gs.unidades.filter(u => u.coord === coord && u.lado === aiSide && !u.eliminado).length;
                if (cnt < 2) {
                    unit.coord = coord;
                    Engine.applyInitialConceal(unit, gs);
                    break;
                }
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Activación IA (Ops Phase)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Elige la mejor acción para la IA basándose en el contexto del escenario.
 * @returns {AIAction|null}
 */
function aiChooseActivation(gs) {
    const aiSide     = gs.aiSide;
    const playerSide = gs.playerSide;
    const ctx        = _analyzeScenario(gs);

    const available = gs.unidades.filter(u =>
        u.lado === aiSide && !u.eliminado && u.coord &&
        !u.marcadores.has('usado') && u.data.categoria !== 'decoy'
    );
    if (available.length === 0) return null;

    const scored = [];

    for (const unit of available) {
        const unitHex      = gs.mapa[unit.coord];
        const isHeavy      = ['wt_mg', 'gun'].includes(unit.data.categoria);
        const isMortar     = unit.data.es_mortar;
        const isVehicle    = ['vehicle', 'gun'].includes(unit.data.categoria);

        // ── OPCIÓN: DISPARAR ──────────────────────────────────────────────
        const targets = gs.unidades.filter(u => u.lado === playerSide && !u.eliminado && u.coord);
        for (const target of targets) {
            const check = Engine.canFire(unit, target, gs);
            if (!check.puede) continue;

            const pHit = Math.min(check.fp, 10) / 10;
            let score  = pHit * 12;

            // Prioridad por estado del objetivo
            if (target.cara === 'reduced')  score += 5;  // posible eliminación
            if (target.supresion > 0)       score += 3;  // ya debilitado
            if (target.supresion === 2)     score += 4;  // totalmente suprimido: rematar

            // Bonus si el objetivo está sobre un hex crítico (o lo defenderá)
            if (ctx.criticalHexes.includes(target.coord)) score += 6;
            if (ctx.objectives.includes(target.coord))    score += 4;

            // Atacante: priorizar eliminar lo que bloquea el avance
            if (ctx.aiRole === 'attacker') {
                // Bonus si el objetivo está entre la IA y sus objetivos
                for (const obj of ctx.objectives) {
                    const dTargetObj  = HexMap.hexDistance(target.coord, obj);
                    const dUnitObj    = HexMap.hexDistance(unit.coord, obj);
                    if (dTargetObj < dUnitObj) score += 3;
                }
            }

            // Defensor: máxima prioridad sobre unidades que avanzan hacia objetivos
            if (ctx.aiRole === 'defender') {
                for (const obj of ctx.objectives) {
                    const d = HexMap.hexDistance(target.coord, obj);
                    if (d <= 3) score += (4 - d);  // más cerca del objetivo = más peligroso
                }
            }

            // Urgencia: con poco tiempo, disparar es preferible a moverse
            score += ctx.urgency * (ctx.aiRole === 'defender' ? 3 : 1);

            scored.push({ tipo: 'disparar', unidad: unit, objetivo: target, fp: check.fp, score });
        }

        // ── OPCIÓN: OP FIRE ────────────────────────────────────────────────
        if (!unit.marcadores.has('op_fire') && !unit.supresion) {
            let opScore = 0;

            // MG WT: Op Fire es su principal función defensiva
            if (unit.data.categoria === 'wt_mg') opScore = 8;
            // Cañones: siempre prefieren Op Fire si hay cobertura
            else if (unit.data.categoria === 'gun') opScore = 7;
            // En buena posición defensiva con cobertura
            else if (['EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'SETOS'].includes(unitHex?.terreno)) opScore = 4;
            // Defensor: todas las unidades en posición valoran Op Fire
            else if (ctx.aiRole === 'defender') opScore = 3;

            // Reducir si no hay enemigos en rango
            const hasTargetsInRange = gs.unidades.some(enemy => {
                if (enemy.lado === aiSide || enemy.eliminado || !enemy.coord) return false;
                return HexMap.hexDistance(unit.coord, enemy.coord) <= (unit.data.alcance_max || 5);
            });
            if (!hasTargetsInRange) opScore = 0;

            // Atacante con urgencia alta: no desperdiciar turno en Op Fire
            if (ctx.aiRole === 'attacker' && ctx.urgency > 0.6) opScore = Math.max(0, opScore - 4);

            if (opScore > 0) scored.push({ tipo: 'op_fire', unidad: unit, score: opScore });
        }

        // ── OPCIÓN: MOVER ──────────────────────────────────────────────────
        // MG WT y cañones casi nunca se mueven (salvo que no estén en posición)
        const movePenalty = isHeavy ? 6 : (isMortar ? 3 : 0);

        const movables = Engine.getMovableHexes(unit, gs);
        let bestMoveScore = -Infinity;
        let bestMove      = null;

        for (const [coord] of movables.entries()) {
            const hex = gs.mapa[coord];
            let moveScore = -movePenalty;

            // ── Cobertura en destino ──
            if (hex.terreno === 'EDIF. PIEDRA')                              moveScore += 5;
            else if (['EDIF. MADERA', 'BOSQUE', 'TRINCHERA'].includes(hex.terreno)) moveScore += 3;
            else if (hex.terreno === 'SETOS')                                moveScore += 2;

            // Elevación: posiciones altas son valiosas
            moveScore += (hex.elevacion || 0) * 1.5;

            // ── Proximidad a objetivos ──
            for (const obj of ctx.objectives) {
                if (!gs.mapa[obj]) continue;
                const before = HexMap.hexDistance(unit.coord, obj);
                const after  = HexMap.hexDistance(coord, obj);
                const gain   = (before - after);

                if (ctx.aiRole === 'attacker') {
                    // Atacante: acercarse a objetivos tiene alta prioridad
                    moveScore += gain * (3 + ctx.urgency * 4);
                    // Extra si llega directamente al objetivo
                    if (coord === obj) moveScore += 10;
                } else {
                    // Defensor: acercarse para controlar el objetivo
                    if (gain > 0 && after <= 2) moveScore += gain * 2;
                    // Penalizar alejarse del objetivo que debe defender
                    if (gain < 0) moveScore += gain * 3;
                }
            }

            // ── Hexes críticos (puentes, edificios clave) ──
            if (ctx.criticalHexes.includes(coord)) moveScore += 4;

            // ── Penalizar exposición enemiga ──
            const hasEnemyLOS = gs.unidades.some(e => {
                if (e.lado === aiSide || e.eliminado || !e.coord) return false;
                return Engine.calcLOS(gs.mapa, e.coord, coord, gs.smoke || {}).visible;
            });
            const isOpenTerrain = ['TERRENO ABIERTO', 'CARRETERA'].includes(hex.terreno);
            if (isOpenTerrain && hasEnemyLOS) {
                moveScore -= unit.oculto ? 6 : 3;
            }

            // ── Penalizar adyacencia a enemigos ──
            for (const { coord: nb } of HexMap.hexNeighbors(coord, gs.mapa)) {
                if (Engine.getEnemiesAt(nb, aiSide, gs).length > 0) moveScore -= 2;
            }

            // ── Carretera: bonus de movilidad si se usa para avanzar ──
            if (hex.terreno === 'CARRETERA' && ctx.aiRole === 'attacker') moveScore += 1;

            // ── Evitar apilar demasiado (salvo necesidad táctica) ──
            const allies = gs.unidades.filter(u => u.coord === coord && u.lado === aiSide && !u.eliminado);
            if (allies.length >= 2) moveScore -= 4;

            if (moveScore > bestMoveScore) {
                bestMoveScore = moveScore;
                bestMove      = coord;
            }
        }

        // Solo proponer movimiento si la puntuación supera el umbral
        const moveThreshold = ctx.aiRole === 'attacker' ? 0 : 2;
        if (bestMove && bestMoveScore > moveThreshold) {
            const ruta = aStar(unit.coord, bestMove, gs, unit);
            scored.push({ tipo: 'mover', unidad: unit, destino: bestMove, ruta, score: bestMoveScore });
        }
    }

    // Elegir la mejor acción
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
        return { tipo: 'pasar', unidad: available[0], score: 0 };
    }

    // Desempate: si varias acciones tienen puntuación similar (< 1 de diferencia),
    // preferir disparar > op_fire > mover para el defensor, o mover > disparar para el atacante
    const best = scored[0];
    const sameScore = scored.filter(a => a.score >= best.score - 0.5);
    if (sameScore.length > 1) {
        const order = ctx.aiRole === 'defender'
            ? ['disparar', 'op_fire', 'mover', 'pasar']
            : ['disparar', 'mover', 'op_fire', 'pasar'];
        sameScore.sort((a, b) => order.indexOf(a.tipo) - order.indexOf(b.tipo));
        return sameScore[0];
    }

    return best;
}

// ────────────────────────────────────────────────────────────────────────────
// Dado aleatorio para la IA
// ────────────────────────────────────────────────────────────────────────────

/** d10 para la IA (1-10). */
function rnd() {
    const r = Math.floor(Math.random() * 10);
    return r === 0 ? 10 : r;
}

// ────────────────────────────────────────────────────────────────────────────
// Exportar
// ────────────────────────────────────────────────────────────────────────────
return {
    aStar,
    extractObjectives,
    aiDeploy,
    aiChooseActivation,
    rnd,
};

})();

window.AI = AI;
