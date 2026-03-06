/**
 * engine.js — Motor de reglas de Screaming Eagles / Band of Brothers.
 *
 * Implementa: LOS, Fire, Morale Check, Op Fire, Rout, Melee, Recovery,
 * Movement validation, Conceal, Victory check.
 *
 * Todas las funciones son puras (sin efectos secundarios en el DOM).
 * Las funciones que necesitan aleatoriedad reciben `rnd` = función que devuelve d10 (1-10).
 */

'use strict';

const Engine = (() => {

// ────────────────────────────────────────────────────────────────────────────
// Estado de partida
// ────────────────────────────────────────────────────────────────────────────

/**
 * Inicializa un GameState desde los datos de escenario y unidades.
 * @param {ScenarioData} scenario
 * @param {Map} allUnits - nombre → UnitData
 * @param {string} playerSide - 'aliados' o 'eje'
 * @returns {GameState}
 */
function initGame(scenario, allUnits, playerSide) {
    const aiSide = playerSide === 'aliados' ? 'eje' : 'aliados';
    const units = _buildUnitInstances(scenario, allUnits);

    return {
        scenario,
        allUnits,
        turno: 1,
        maxTurnos: scenario.meta.turnos,
        fase: 'despliegue',
        moves_first: scenario.meta.moves_first === 'american' ? 'aliados' : 'eje',
        deploys_first: scenario.meta.deploys_first === 'german' ? 'eje' : 'aliados',
        playerSide,
        aiSide,
        jugadorActivo: null,    // se establece al iniciar ops
        unidades: units,
        mapa: scenario.mapa,
        cpRestantes: {
            aliados: scenario.factions.aliados.cps,
            eje:     scenario.factions.eje.cps,
        },
        // Ops phase tracking
        opsActivados: { aliados: 0, eje: 0 },
        secuenciaActual: 0,    // quién va primero en esta secuencia
        pasados: { aliados: false, eje: false },
        victoria: null,
        log: [],
        smoke: {},   // coord → { tipo: 'smoke'|'dispersed', turnoPlaced }
    };
}

/** Crea las instancias de unidades a partir del escenario. */
function _buildUnitInstances(scenario, allUnits) {
    const instances = [];
    let id = 0;
    for (const lado of ['aliados', 'eje']) {
        for (const entry of scenario.unidades[lado]) {
            const uData = _findUnit(allUnits, entry.tipo, entry.categoria);
            if (!uData) {
                console.warn(`Unidad no encontrada: "${entry.tipo}" (${entry.categoria})`);
                continue;
            }
            for (let i = 0; i < entry.fichas_escenario; i++) {
                instances.push(_createInstance(id++, uData, lado, entry.reducida));
            }
        }
    }
    return instances;
}

/** Busca una unidad con coincidencia exacta o parcial. */
function _findUnit(allUnits, tipo, categoria) {
    if (allUnits.has(tipo)) return allUnits.get(tipo);
    // Búsqueda parcial por tipo
    for (const [name, data] of allUnits.entries()) {
        if (data.categoria === categoria && name.toLowerCase().includes(tipo.toLowerCase())) {
            return data;
        }
    }
    // Sólo categoría como último recurso
    for (const [, data] of allUnits.entries()) {
        if (data.categoria === categoria) return data;
    }
    return null;
}

/** Crea una instancia de unidad. */
function _createInstance(id, uData, lado, startReduced) {
    return {
        id:          `u${id}`,
        tipo:        uData.nombre,
        lado,
        coord:       null,          // sin posición inicial
        cara:        startReduced ? 'reduced' : 'full',
        supresion:   0,             // 0=normal, 1=parcial, 2=total
        marcadores:  new Set(),     // 'usado', 'op_fire', 'movido', 'flanco'
        oculto:      false,
        eliminado:   false,
        data:        uData,         // referencia a UnitData
        // Prop computada
        get fp_actual() {
            const d = this.data;
            if (!d.fp_normal) return 0;
            const base = this.cara === 'reduced' && d.reducida
                ? d.reducida.fp_normal
                : d.fp_normal;
            // -1 por supresión parcial, -2 por supresión total
            return Math.max(0, base - this.supresion);
        },
        get morale_actual() {
            const d = this.data;
            if (!d.moral) return 0;
            const base = this.cara === 'reduced' && d.reducida ? d.reducida.moral : d.moral;
            if (this.supresion === 2) return d.moral_full || Math.max(1, base - 3);
            if (this.supresion === 1) return d.moral_sup  || Math.max(1, base - 1);
            return base;
        },
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Cálculo de LOS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evalúa una línea de hexes (resultado de hexesInLine) para blocking/hindrance.
 * @private
 */
function _evalLine(mapa, line, smoke = {}) {
    let hinderAllCount = 0;    // trigo + huerto (para infantería)
    let hinderOrchardCount = 0; // solo huerto (para vehículos — trigo no afecta a vehículos)
    let bocageHindrance = 0;   // hexsides de bocage atravesados
    let smokeInPath = false;    // cualquier humo (activo o disperso)
    let smokeNDInPath = false;  // solo humo no disperso
    for (let i = 1; i < line.length - 1; i++) {
        const coord = line[i];
        const hex = mapa[coord];
        if (!hex) continue;
        if (HexMap.TERRAIN_BLOCKS_LOS.has(hex.terreno)) {
            return { visible: false, hindrance: 99, hindranceVehicle: 99, hexes: line, smokeInPath: false, smokeNDInPath: false };
        }
        // PDF: 1 hindrance por cada 2 hexes de trigo/huerto (redondeado arriba)
        // Trigo/CAMPO TRIGO: NO afecta a vehículos
        if (hex.terreno === 'CAMPO TRIGO') hinderAllCount++;
        else if (hex.terreno === 'HUERTO') { hinderAllCount++; hinderOrchardCount++; }
        // Bocage hexsides: hindrance al cruzar el lado entre hex i-1 e i
        if (i > 0 && line[i - 1]) {
            if (HexMap.hexsideValue(line[i - 1], coord, mapa)) bocageHindrance++;
        }
        // Smoke tracking: separar disperso de activo
        if (smoke[coord]) {
            smokeInPath = true;
            if (smoke[coord].tipo === 'smoke') smokeNDInPath = true;
        }
    }
    const hindrance = Math.ceil(hinderAllCount / 2) + bocageHindrance;
    const hindranceVehicle = Math.ceil(hinderOrchardCount / 2) + bocageHindrance;
    return { visible: true, hindrance, hindranceVehicle, hexes: line, smokeInPath, smokeNDInPath };
}

/**
 * Calcula la línea de visión entre dos hexes.
 * Usa la técnica de epsilon-nudge: prueba la línea central y dos variantes
 * ligeramente desplazadas en dirección perpendicular. Si alguna variante
 * da LOS libre, la usamos (disparo tangente a un lado del hexágono).
 * @returns {{ visible: boolean, hindrance: number, hexes: string[] }}
 */
function calcLOS(mapa, from, to, smoke = {}) {
    if (from === to) return { visible: true, hindrance: 0, hindranceVehicle: 0, hexes: [from], smokeInPath: false, smokeNDInPath: false };

    // Epsilon pequeño — suficiente para resolver ambigüedades en bordes
    // sin saltar al hex siguiente. 1e-4 funciona bien para distancias típicas.
    const EPS = 1e-4;

    // Dirección perpendicular en coords cúbicas al vector from→to
    const c1 = HexMap.toCube(from);
    const c2 = HexMap.toCube(to);
    const dq = c2.q - c1.q;
    const dr = c2.r - c1.r;
    // Perpendicular en espacio cúbico (rotación 90°): (dr, -dq) normalizada
    const len = Math.sqrt(dq * dq + dr * dr) || 1;
    const pq = (dr / len) * EPS;
    const pr = (-dq / len) * EPS;

    const offsets = [
        { dq: 0,   dr: 0   },   // línea central
        { dq: pq,  dr: pr  },   // nudge +perp
        { dq: -pq, dr: -pr },   // nudge -perp
    ];

    let best = null;
    for (const eps of offsets) {
        const line = HexMap.hexesInLine(from, to, mapa, eps);
        const result = _evalLine(mapa, line, smoke);
        // Preferir resultado que sea visible, o el de menor hindrance
        if (best === null) {
            best = result;
        } else if (result.visible && !best.visible) {
            best = result;
        } else if (result.visible && best.visible && result.hindrance < best.hindrance) {
            best = result;
        }
        // Si ya encontramos LOS limpio, no hace falta seguir
        if (best.visible && best.hindrance === 0) break;
    }
    // Comprobar humo en hexes de origen y destino
    const smokeInPath = best.smokeInPath || !!(smoke[from] || smoke[to]);
    const smokeNDInPath = best.smokeNDInPath
        || smoke[from]?.tipo === 'smoke'
        || smoke[to]?.tipo === 'smoke';
    return { ...best, smokeInPath, smokeNDInPath };
}

/**
 * ¿Puede la unidad `u` disparar a `target`?
 * Devuelve {puede, fp, motivo}.
 */
function canFire(attacker, targetUnit, gs) {
    const d = attacker.data;
    // Suprimido total no puede disparar
    if (attacker.supresion === 2) return { puede: false, motivo: 'Totalmente suprimida' };
    if (!attacker.coord || !targetUnit.coord) return { puede: false, motivo: 'Sin posición' };
    if (attacker.lado === targetUnit.lado) return { puede: false, motivo: 'Mismo bando' };
    if (attacker.marcadores.has('usado')) return { puede: false, motivo: 'Ya activada' };

    // Unidad en melé (comparte hex con enemigo) no puede disparar
    const inMelee = gs.unidades.some(e =>
        e.coord === attacker.coord && e.lado !== attacker.lado && !e.eliminado
    );
    if (inMelee) return { puede: false, motivo: 'En situación de melé' };

    // Verificar restricción SATW: solo aplica a infantería sin SATW (no a vehículos)
    const targetCat = targetUnit.data.categoria;
    const isArmoredTarget = ['vehicle', 'gun'].includes(targetCat);
    const isVehicleAttacker = d.fp_vs_inf !== undefined;
    if (isArmoredTarget && !isVehicleAttacker) {
        const satw = d.satw || (attacker.cara === 'reduced' && d.reducida?.satw) || null;
        if (!satw) return { puede: false, motivo: 'Sin arma antitanque (SATW)' };
    }

    const dist = HexMap.hexDistance(attacker.coord, targetUnit.coord);
    const maxRange = d.alcance_max || 99;
    if (dist > maxRange * 2) return { puede: false, motivo: 'Fuera de alcance máximo' };

    // Alcance mínimo: morteros no pueden disparar a hexes adyacentes
    if (d.es_mortar && d.alcance_min > 1 && dist < d.alcance_min) {
        return { puede: false, motivo: `Mortero: alcance mínimo ${d.alcance_min} hexes` };
    }

    // No se puede disparar a un hex que también contenga unidades propias
    const friendlyInTarget = gs.unidades.some(u =>
        u.coord === targetUnit.coord && u.lado === attacker.lado && !u.eliminado
    );
    if (friendlyInTarget) return { puede: false, motivo: 'Hex objetivo contiene unidades propias' };

    const los = calcLOS(gs.mapa, attacker.coord, targetUnit.coord, gs.smoke || {});
    if (!los.visible) return { puede: false, motivo: 'LOS bloqueada' };

    const isVehAtk = attacker.data.fp_vs_inf !== undefined;
    const hindrance = isVehAtk ? los.hindranceVehicle : los.hindrance;
    const fp = _calcFP(attacker, targetUnit, gs, dist, hindrance, false, los.smokeNDInPath, los.smokeInPath);
    return { puede: fp > 0, fp, motivo: fp > 0 ? 'OK' : 'FP insuficiente', los };
}

/**
 * Calcula la FP ajustada del atacante contra un objetivo.
 * Para vehículos atacantes: usa fp_vs_inf / fp_vs_veh.
 * Para infantería vs blindados: usa SATW vs blindaje.
 * Para infantería vs infantería: FP normal con modificadores.
 */
function _calcFP(attacker, targetUnit, gs, dist, hindrance, isOpFire, smokeNDInPath = false, smokeInPath = false) {
    const d = attacker.data;
    const targetCat = targetUnit.data.categoria;

    // ── Vehículo atacante (tiene fp_vs_inf / fp_vs_veh) ───────────────────
    if (d.fp_vs_inf !== undefined) {
        let fp;
        if (['vehicle', 'gun'].includes(targetCat)) {
            // vs blindado: FP directo de la tabla (fp_vs_veh)
            fp = d.fp_vs_veh || 0;
            // Modificadores de distancia veh vs veh
            if (dist === 1) fp += 1;   // adyacente: +1
            if (dist > 20)  fp -= 1;   // >20 hexes: -1
            if (dist > 30)  fp -= 1;   // >30 hexes: -1 adicional
        } else {
            // vs infantería/WT
            fp = d.fp_vs_inf || 0;
        }
        if (targetUnit.oculto) fp -= 1;
        // Fortification del objetivo
        const tgtHexV = gs.mapa[targetUnit.coord];
        const fortifModV = HexMap.FORTIF_FP_MOD[tgtHexV?.fortif] || 0;
        fp += fortifModV;
        // Elevación para vehículos/cañones vs infantería/blindados (upper_level: +1 ele efectiva)
        const attHexV = gs.mapa[attacker.coord];
        const attEleV = (attHexV?.elevacion || 0) + (attHexV?.upper_level ? 1 : 0);
        const tgtEleV = (tgtHexV?.elevacion || 0) + (tgtHexV?.upper_level ? 1 : 0);
        if (tgtEleV < attEleV) fp += 1;  // objetivo en cota más baja
        if (tgtEleV > attEleV) fp -= 1;  // objetivo en cota más alta
        return Math.max(0, fp);
    }

    // ── Infantería/WT vs blindado: SATW comparado contra blindaje ─────────
    if (['vehicle', 'gun'].includes(targetCat)) {
        const satw = d.satw || (attacker.cara === 'reduced' && d.reducida?.satw) || 0;
        if (!satw) return 0;

        const isFlank = attacker.marcadores?.has('flanco');
        const armor = isFlank
            ? (targetUnit.data.blindaje_s || targetUnit.data.blindaje_f || 0)
            : (targetUnit.data.blindaje_f || 0);

        if (satw < armor) return 0;
        return Math.max(1, satw - armor + 1);
    }

    // ── Fuego normal contra infantería/WT ──────────────────────────────────
    if (!d.fp_normal) return 0;

    // Base FP según tipo de fuego
    const isAssault = !isOpFire && attacker.marcadores.has('movido');
    let fp;
    if (isOpFire || isAssault) {
        // Fuego de Op/Asalto usa FP de Eficiencia (Proficient FP)
        const redData = attacker.cara === 'reduced' && d.reducida;
        fp = redData ? d.reducida.fp_eficiente : (d.fp_eficiente || d.fp_normal);

        // Op Fire bonuses (PDF): +1 si adyacente, +1 si ya marcado como Op Fire
        // Cap: no puede superar la FP normal de la unidad
        if (isOpFire) {
            if (dist === 1) fp += 1;                            // op fire at adjacent
            if (attacker.marcadores.has('op_fire')) fp += 1;   // ya marcado como op fire
            const normalFP = redData ? d.reducida.fp_normal : d.fp_normal;
            fp = Math.min(fp, normalFP);
        }
    } else {
        fp = attacker.fp_actual;  // incluye penalización por supresión
    }

    // Rango largo: mitad FP (redondeado abajo)
    const normalRange = d.alcance_max || 5;
    if (dist > normalRange) fp = Math.floor(fp / 2);

    // Adyacente: +3
    if (dist === 1) fp += 3;

    // Terreno del objetivo (usar solo el mejor modificador del objetivo)
    const targetHex = gs.mapa[targetUnit.coord];
    if (targetHex) {
        const mod = HexMap.TERRAIN_FP_MOD[targetHex.terreno] || 0;
        fp += mod;
        // Fortification adicional (PILLBOX/BUNKER): extra FP mod sobre el terreno base
        const fortifMod = HexMap.FORTIF_FP_MOD[targetHex.fortif] || 0;
        fp += fortifMod;
    }

    // Elevación (solo si objetivo NO está en terreno beneficioso)
    // Upper level: +1 elevación efectiva para los ocupantes del edificio
    if (!targetHex || !HexMap.TERRAIN_BENEFICIAL.has(targetHex.terreno)) {
        const attackerHexE = gs.mapa[attacker.coord];
        const attEle = (attackerHexE?.elevacion || 0) + (attackerHexE?.upper_level ? 1 : 0);
        const tgtEle = (targetHex?.elevacion || 0) + (targetHex?.upper_level ? 1 : 0);
        if (tgtEle > attEle) fp -= 1;  // objetivo en cota más alta
        if (tgtEle < attEle) fp += 1;  // objetivo en cota más baja
    }

    // Atacante en ALAMBRE: -1 FP al disparar desde hex con alambre
    const attackerHex = gs.mapa[attacker.coord];
    if (attackerHex && attackerHex.terreno === 'ALAMBRE') fp -= 1;

    // Objetivo en movimiento en terreno NO beneficioso: +4 (rango 1-4) o +2 (rango 5-8)
    // Negado si el objetivo tiene terreno beneficioso O hay humo en la trayectoria (activo o disperso)
    if (targetUnit.marcadores?.has('movido')) {
        const terrainOk = !targetHex || !HexMap.TERRAIN_BENEFICIAL.has(targetHex.terreno);
        if (terrainOk && !smokeInPath) {
            if (dist <= 4) fp += 4;
            else if (dist <= 8) fp += 2;
        }
    }

    // Obstáculos de LOS (hindrance: trigo/huerto)
    fp -= hindrance;

    // Humo no disperso en el camino: -1 FP (infantería/WT únicamente; vehículos ven su Prof afectada)
    if (smokeNDInPath) fp -= 1;

    // Oculto: -1
    if (targetUnit.oculto) fp -= 1;

    return Math.max(0, fp);
}

/**
 * Devuelve un texto con el desglose de FP y modificadores para mostrar antes del dado.
 * @returns {string} línea lista para log()
 */
function calcFPBreakdown(attacker, targetUnit, gs, dist, hindrance, isOpFire, smokeNDInPath = false, smokeInPath = false) {
    const d = attacker.data;
    const targetCat = targetUnit.data.categoria;
    const parts = [];

    if (d.fp_vs_inf !== undefined) {
        // Vehículo
        const isVsVeh = ['vehicle', 'gun'].includes(targetCat);
        let fp = isVsVeh ? (d.fp_vs_veh || 0) : (d.fp_vs_inf || 0);
        parts.push(`Base ${fp}`);
        if (isVsVeh) {
            if (dist === 1) { fp += 1; parts.push('Adyac. +1'); }
            if (dist > 20)  { fp -= 1; parts.push('>20hex -1'); }
            if (dist > 30)  { fp -= 1; parts.push('>30hex -1'); }
        }
        if (targetUnit.oculto)          { fp -= 1; parts.push('Oculto -1'); }
        const attEle = (gs.mapa[attacker.coord] || {}).elevacion || 0;
        const tgtEle = (gs.mapa[targetUnit.coord] || {}).elevacion || 0;
        if (tgtEle < attEle)            { fp += 1; parts.push('Cota alta +1'); }
        if (tgtEle > attEle)            { fp -= 1; parts.push('Cota baja -1'); }
        return `FP ${Math.max(0,fp)} [${parts.join(' │ ')}]`;
    }

    if (['vehicle', 'gun'].includes(targetCat)) {
        // SATW
        const satw = d.satw || (attacker.cara === 'reduced' && d.reducida?.satw) || 0;
        const isFlank = attacker.marcadores?.has('flanco');
        const armor = isFlank ? (targetUnit.data.blindaje_s || targetUnit.data.blindaje_f || 0)
                               : (targetUnit.data.blindaje_f || 0);
        const fp = Math.max(0, satw - armor + 1);
        parts.push(`SATW ${satw}`, `Blindaje ${armor}${isFlank?' flanco':''}`);
        return `FP ${fp} [${parts.join(' │ ')}]`;
    }

    // Infantería normal
    const isAssault = !isOpFire && attacker.marcadores.has('movido');
    let fp;
    const redData = attacker.cara === 'reduced' && d.reducida;
    if (isOpFire || isAssault) {
        fp = redData ? d.reducida.fp_eficiente : (d.fp_eficiente || d.fp_normal);
        parts.push(`Base${isAssault?' asalto':' op'} ${fp}`);
        if (isOpFire) {
            if (dist === 1)                        { fp += 1; parts.push('Adyac. op +1'); }
            if (attacker.marcadores.has('op_fire')){ fp += 1; parts.push('OP marcado +1'); }
            const normalFP = redData ? d.reducida.fp_normal : d.fp_normal;
            fp = Math.min(fp, normalFP);
        }
    } else {
        fp = attacker.fp_actual;
        parts.push(`Base ${fp}`);
    }

    const normalRange = d.alcance_max || 5;
    if (dist > normalRange)  { fp = Math.floor(fp / 2); parts.push('Rango largo /2'); }
    if (dist === 1)          { fp += 3; parts.push('Adyacente +3'); }

    const targetHex = gs.mapa[targetUnit.coord];
    if (targetHex) {
        const mod = HexMap.TERRAIN_FP_MOD[targetHex.terreno] || 0;
        if (mod !== 0) { fp += mod; parts.push(`Terreno ${mod > 0 ? '+' : ''}${mod}`); }
        const fortifMod = HexMap.FORTIF_FP_MOD[targetHex.fortif] || 0;
        if (fortifMod !== 0) { fp += fortifMod; parts.push(`Fortif. ${fortifMod}`); }
    }
    if (!targetHex || !HexMap.TERRAIN_BENEFICIAL.has(targetHex.terreno)) {
        const atkHexBD = gs.mapa[attacker.coord];
        const attEle = (atkHexBD?.elevacion || 0) + (atkHexBD?.upper_level ? 1 : 0);
        const tgtEle = (targetHex?.elevacion || 0) + (targetHex?.upper_level ? 1 : 0);
        if (tgtEle > attEle) { fp -= 1; parts.push('Cota alta -1'); }
        if (tgtEle < attEle) { fp += 1; parts.push('Cota baja +1'); }
    }
    const attackerHex = gs.mapa[attacker.coord];
    if (attackerHex?.terreno === 'ALAMBRE') { fp -= 1; parts.push('Alambre -1'); }
    if (targetUnit.marcadores?.has('movido')) {
        const terrainOk = !targetHex || !HexMap.TERRAIN_BENEFICIAL.has(targetHex.terreno);
        if (terrainOk && !smokeInPath) {
            if (dist <= 4)      { fp += 4; parts.push('En movimiento +4'); }
            else if (dist <= 8) { fp += 2; parts.push('En movimiento +2'); }
        }
    }
    if (hindrance)       { fp -= hindrance;  parts.push(`Obstáculo -${hindrance}`); }
    if (smokeNDInPath)   { fp -= 1;          parts.push('Humo -1'); }
    if (targetUnit.oculto) { fp -= 1;        parts.push('Oculto -1'); }

    return `FP ${Math.max(0, fp)} [${parts.join(' │ ')}]`;
}

// ────────────────────────────────────────────────────────────────────────────
// Resolución de fuego
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve un disparo.
 * @param {UnitInstance} attacker
 * @param {UnitInstance} target
 * @param {number} roll - dado d10 (1-10)
 * @param {number} fpOverride - FP precalculada (null = calcular)
 * @param {GameState} gs
 * @param {boolean} isOpFire
 * @returns {FireResult}
 */
function resolveFire(attacker, target, roll, fpOverride, gs, isOpFire = false) {
    const dist = HexMap.hexDistance(attacker.coord, target.coord);
    const los = calcLOS(gs.mapa, attacker.coord, target.coord, gs.smoke || {});
    const isVehAtk = attacker.data.fp_vs_inf !== undefined;
    const hindrance = isVehAtk ? los.hindranceVehicle : los.hindrance;
    const fp = fpOverride !== null
        ? fpOverride
        : _calcFP(attacker, target, gs, dist, hindrance, isOpFire, los.smokeNDInPath, los.smokeInPath);

    const result = { roll, fp, effect: 'miss', oldState: _unitSnapshot(target) };

    // Roll de 10: siempre fallo sin efecto (regla universal)
    if (roll === 10) {
        return result;
    }

    if (roll > fp) {
        result.effect = 'miss';
    } else {
        // Obtener umbral de baja
        const casThreshold = _getCasThreshold(target);

        if (roll <= casThreshold) {
            result.effect = _applyCasualty(target);
        } else {
            result.effect = 'suppress';
            _applySuppression(target, 1);
        }
    }

    // Roll de 1: garantía mínima (incluso si FP=0 o falló por otro motivo)
    // - Adyacente (dist=1): mínimo Reducida
    // - Cualquier alcance normal: mínimo Supresión
    if (roll === 1 && result.effect === 'miss') {
        if (dist === 1) {
            result.effect = _applyCasualty(target);
        } else {
            result.effect = 'suppress';
            _applySuppression(target, 1);
        }
    }

    // El atacante pierde conceal al disparar (independientemente del resultado)
    _loseConcealment(attacker);

    return result;
}

function _getCasThreshold(unit) {
    const d = unit.data;
    if (unit.cara === 'reduced') {
        // Cara reducida: sólo eliminación
        return (d.reducida && d.reducida.cas_elim) || d.cas_elim || 0;
    }
    return d.cas_red || 0;
}

function _applyCasualty(unit) {
    if (unit.cara === 'reduced' || !unit.data.tiene_reducida) {
        // Categorías sin cara reducida (WT, cañones) → eliminados directamente
        if (['wt_mg', 'wt_mortar', 'gun'].includes(unit.data.categoria)) {
            unit.eliminado = true;
            return 'eliminated';
        }
        // Squads sin reducida también eliminados
        if (!unit.data.tiene_reducida) {
            unit.eliminado = true;
            return 'eliminated';
        }
        unit.eliminado = true;
        return 'eliminated';
    }
    // Pasar a cara reducida + supresión total
    unit.cara = 'reduced';
    unit.supresion = 2;
    _loseConcealment_direct(unit);
    return 'reduced';
}

function _applySuppression(unit, levels) {
    unit.supresion = Math.min(2, unit.supresion + levels);
    if (unit.supresion > 0) _loseConcealment_direct(unit);
}

function _unitSnapshot(unit) {
    return { cara: unit.cara, supresion: unit.supresion, eliminado: unit.eliminado };
}

// ────────────────────────────────────────────────────────────────────────────
// Morale Check
// ────────────────────────────────────────────────────────────────────────────

/**
 * Realiza un Chequeo de Moral.
 * @returns {{ pasa: boolean, roll: number, morale: number }}
 */
function moralCheck(unit, roll, mod = 0) {
    const morale = unit.morale_actual + mod;
    const pasa = roll <= morale;
    if (!pasa) {
        _applySuppression(unit, 1);
    }
    return { pasa, roll, morale };
}

// ────────────────────────────────────────────────────────────────────────────
// Movimiento
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calcula todos los hexes a los que puede moverse una unidad.
 * @returns {Map<string, number>} coord → coste de MP para llegar
 */
function getMovableHexes(unit, gs, overrideMps = null) {
    if (!unit.coord) return new Map();
    if (unit.supresion === 2) return new Map();
    if (unit.marcadores.has('usado')) return new Map();

    const maxMPs = overrideMps !== null ? overrideMps : (unit.data.mps || 5);
    const isVehicle = ['vehicle', 'gun'].includes(unit.data.categoria);
    // BFS con coste (usa flotantes para carretera=2/3, campo trigo=1.5, etc.)
    const visited = new Map([[unit.coord, 0]]);
    const queue = [{ coord: unit.coord, mps: maxMPs }];

    while (queue.length) {
        const { coord, mps } = queue.shift();
        const currentHex = gs.mapa[coord];
        const leavingWire = !isVehicle && currentHex?.terreno === 'ALAMBRE';
        for (const { coord: nb } of HexMap.hexNeighbors(coord, gs.mapa)) {
            const hex = gs.mapa[nb];
            if (!hex) continue;
            // Río/Canal: intransitable para todas las unidades. Solo se cruza por PUENTE (terreno separado)
            if (hex.terreno === 'RIO / CANAL') continue;

            // Verificar límite de apilamiento
            if (!canStack(nb, unit.lado, gs, unit)) continue;

            // Salir de alambre cuesta todos los MPs restantes (infantería)
            let cost = leavingWire ? mps : HexMap.terrainMoveCost(hex.terreno, isVehicle, maxMPs);

            // Hexside bocage (SI): coste extra al cruzar el lado
            const bocageSide = HexMap.hexsideValue(coord, nb, gs.mapa);
            if (bocageSide) {
                // Mismo coste que cruzar setos: vehículo = ½ MPs totales, infantería = +1
                cost += isVehicle ? Math.ceil(maxMPs / 2) : 1;
            }

            // Asalto cercano: +1 MP para entrar en hex con vehículo/cañón enemigo
            const hasEnemyVeh = gs.unidades.some(u =>
                u.coord === nb && u.lado !== unit.lado && !u.eliminado &&
                ['vehicle', 'gun'].includes(u.data.categoria)
            );
            if (hasEnemyVeh) cost += 1;

            if (mps - cost < -1e-9) continue;

            // Entrar en alambre: la unidad debe detenerse (infantería)
            const enteringWire = !isVehicle && hex.terreno === 'ALAMBRE';
            const newMps = enteringWire ? 0 : (mps - cost);
            const spent = maxMPs - newMps;

            if (!visited.has(nb) || visited.get(nb) > spent) {
                visited.set(nb, spent);
                queue.push({ coord: nb, mps: newMps });
            }
        }
    }
    visited.delete(unit.coord);  // No incluir posición actual
    return visited;
}

/**
 * Mueve una unidad a un hex destino.
 * @returns {string[]} lista de hexes recorridos (para op fire checks)
 */
function moveUnit(unit, toCoord, gs) {
    const oldCoord = unit.coord;
    unit.coord = toCoord;
    unit.marcadores.add('movido');
    // checkAllConcealment() se llama desde main.js tras resolver el op-fire
    return [oldCoord, toCoord];
}

// ────────────────────────────────────────────────────────────────────────────
// Op Fire
// ────────────────────────────────────────────────────────────────────────────

/**
 * Comprueba si hay unidades enemigas con Op Fire que disparan a la unidad
 * que se está moviendo.
 * @returns {OpFireEvent[]} lista de disparos a resolver
 */
function checkOpFire(movingUnit, toCoord, gs) {
    const events = [];
    const enemies = gs.unidades.filter(u =>
        u.lado !== movingUnit.lado &&
        !u.eliminado &&
        u.coord &&
        u.marcadores.has('op_fire')
    );

    for (const enemy of enemies) {
        const dist = HexMap.hexDistance(enemy.coord, toCoord);
        const maxRange = enemy.data.alcance_max || 5;
        if (dist > maxRange * 2) continue;

        const los = calcLOS(gs.mapa, enemy.coord, toCoord, gs.smoke || {});
        if (!los.visible) continue;

        const isFinal = dist === 1;  // Final Op Fire (adyacente)
        const isVehEn = enemy.data.fp_vs_inf !== undefined;
        const hind = isVehEn ? los.hindranceVehicle : los.hindrance;
        // PDF: Final Op Fire -2 FP solo para infantería/WT; vehículos/cañones no tienen penalización FP
        // (su penalización es -1 adicional al Prof Check, ya gestionado en needsProfCheck)
        const finalFpMod = (isFinal && !isVehEn) ? 2 : 0;
        const fp = _calcFP(enemy, { ...movingUnit, coord: toCoord }, gs, dist, hind, true, los.smokeNDInPath, los.smokeInPath)
                 - finalFpMod;

        if (fp <= 0) continue;

        events.push({ shooter: enemy, target: movingUnit, fp, isFinal });
    }
    return events;
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Huida (Rout Phase)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Retorna las unidades que deben hacer Chequeo de Moral en la fase de huida.
 * Condición 1: cualquier unidad en el mismo hex que un enemigo (independiente del terreno).
 * Condición 2: unidades suprimidas en terreno abierto/carretera con enemigo a ≤5 hexes con LOS.
 */
function getRoutCandidates(gs) {
    const candidates = [];
    const seen = new Set();

    for (const unit of gs.unidades) {
        if (unit.eliminado || !unit.coord) continue;

        // Condición 1a: comparte hex con enemigo → siempre debe chequear
        const enemyInSameHex = gs.unidades.some(e =>
            e.coord === unit.coord && e.lado !== unit.lado && !e.eliminado
        );
        if (enemyInSameHex && !seen.has(unit.id)) {
            candidates.push(unit);
            seen.add(unit.id);
            continue;
        }

        // Condición 1b: adyacente (dist=1) a un enemigo → siempre debe chequear
        const enemyAdjacent = gs.unidades.some(e =>
            e.lado !== unit.lado && !e.eliminado && e.coord &&
            HexMap.hexDistance(unit.coord, e.coord) === 1
        );
        if (enemyAdjacent && !seen.has(unit.id)) {
            candidates.push(unit);
            seen.add(unit.id);
            continue;
        }

        // Condición 2: en terreno abierto/carretera con enemigo a ≤5 con LOS
        const hex = gs.mapa[unit.coord];
        if (!hex) continue;
        if (!['TERRENO ABIERTO', 'CARRETERA'].includes(hex.terreno)) continue;

        const hasNearEnemy = gs.unidades.some(enemy => {
            if (enemy.lado === unit.lado || enemy.eliminado || !enemy.coord) return false;
            const dist = HexMap.hexDistance(unit.coord, enemy.coord);
            if (dist > 5) return false;
            const los = calcLOS(gs.mapa, unit.coord, enemy.coord, gs.smoke || {});
            return los.visible;
        });

        if (hasNearEnemy && !seen.has(unit.id)) {
            candidates.push(unit);
            seen.add(unit.id);
        }
    }
    return candidates;
}

/**
 * Resuelve la huida de una unidad que ha fallado el CM.
 * Devuelve la nueva coord (o null si eliminada).
 */
function resolveRout(unit, gs, rnd, morMod = 0) {
    const roll = rnd();
    const check = moralCheck(unit, roll, morMod);

    if (check.pasa) return { moved: false, roll, check, casualty: false };

    // Baja por huida: si el fallo supera el umbral de baja, la unidad también sufre reducción
    let casualty = false;
    const casThreshold = unit.data.cas_red || 0;
    if (casThreshold > 0 && (roll - check.morale) >= casThreshold) {
        _applyCasualty(unit);
        casualty = true;
    }

    if (unit.eliminado) return { moved: false, roll, check, casualty };

    // Mover hacia ruta de huida
    const faction = unit.lado === 'aliados'
        ? gs.scenario.factions.aliados
        : gs.scenario.factions.eje;
    const rutaHuida = faction.ruta_huida;  // 'W', 'E', 'N', 'S'

    const newCoord = _routMove(unit, rutaHuida, gs);
    if (newCoord) {
        unit.coord = newCoord;
    } else {
        // Sin hex válido → eliminada
        unit.eliminado = true;
    }

    return { moved: !unit.eliminado, newCoord, roll, check, casualty };
}

function _routMove(unit, direction, gs) {
    // Preferir hexes en dirección de ruta de huida
    const nb = HexMap.hexNeighbors(unit.coord, gs.mapa);
    const dirPreference = {
        W: (a, b) => HexMap.coordParts(a.coord).ci - HexMap.coordParts(b.coord).ci,
        E: (a, b) => HexMap.coordParts(b.coord).ci - HexMap.coordParts(a.coord).ci,
        N: (a, b) => HexMap.coordParts(a.coord).row - HexMap.coordParts(b.coord).row,
        S: (a, b) => HexMap.coordParts(b.coord).row - HexMap.coordParts(a.coord).row,
    };
    const sorted = [...nb].sort(dirPreference[direction] || (() => 0));
    // Preferir hexes no en abierto o con menos enemigos
    for (const { coord } of sorted) {
        const hex = gs.mapa[coord];
        if (!hex) continue;
        if (hex.terreno === 'RIO / CANAL') continue;
        // No ir a hex con muchos enemigos
        const enemyCount = gs.unidades.filter(u =>
            u.coord === coord && u.lado !== unit.lado && !u.eliminado
        ).length;
        if (enemyCount === 0) return coord;
    }
    return sorted[0]?.coord || null;
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Melé (Melee Phase)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Encuentra todos los hexes con unidades de ambos bandos.
 */
function getMeleeHexes(gs) {
    const hexes = new Set();
    for (const unit of gs.unidades) {
        if (unit.eliminado || !unit.coord) continue;
        const hasEnemy = gs.unidades.some(u =>
            u.coord === unit.coord && u.lado !== unit.lado && !u.eliminado
        );
        if (hasEnemy) hexes.add(unit.coord);
    }
    return [...hexes];
}

/**
 * Resuelve el melé en un hex.
 * Cada unidad tira 2 dados vs su Melee FP.
 * @returns {MeleeResult}
 */
function resolveMelee(coord, gs, rnd) {
    const combatants = gs.unidades.filter(u =>
        u.coord === coord && !u.eliminado
    );
    const byLado = {};
    for (const u of combatants) {
        if (!byLado[u.lado]) byLado[u.lado] = [];
        byLado[u.lado].push(u);
    }

    const results = {};
    const casualties = { aliados: [], eje: [] };

    // Resolver simultáneamente: primero calcular, luego aplicar
    for (const lado of Object.keys(byLado)) {
        results[lado] = [];
        for (const unit of byLado[lado]) {
            // WT y cañones en cara reducida tienen Melé FP = 1
            let meleeFP = unit.data.fp_melee || 1;
            if (unit.cara === 'reduced' && ['wt_mg', 'wt_mortar', 'gun'].includes(unit.data.categoria)) {
                meleeFP = 1;
            }
            const roll1 = rnd();
            const roll2 = rnd();
            const hits = (roll1 <= meleeFP ? 1 : 0) + (roll2 <= meleeFP ? 1 : 0);
            results[lado].push({ unit, roll1, roll2, hits });
        }
    }

    // Aplicar bajas al bando contrario (simultáneo)
    for (const lado of Object.keys(results)) {
        const enemyLado = lado === 'aliados' ? 'eje' : 'aliados';
        if (!byLado[enemyLado]) continue;

        let totalHits = results[lado].reduce((sum, r) => sum + r.hits, 0);
        const enemyPool = [...byLado[enemyLado]].sort(
            (a, b) => (a.supresion - b.supresion)  // Atacar menos suprimidas primero
        );

        for (const enemy of enemyPool) {
            if (totalHits <= 0) break;
            const wasReduced = _applyCasualty(enemy);
            casualties[enemyLado].push({ unit: enemy, result: wasReduced });
            totalHits--;
        }
    }

    return { coord, results, casualties };
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Recuperación (Recovery Phase)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Aplica la recuperación estándar de fin de turno.
 * Reduce supresión en 1 paso por unidad.
 * Excepción: unidades en melé (comparten hex con enemigo) NO recuperan supresión.
 * Limpia marcadores: usado, movido, op_fire.
 */
function runRecovery(gs) {
    const recovered = [];
    const regainedConceal = [];
    const coverTerrains = new Set(['EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'TRINCHERA', 'SETOS']);

    for (const unit of gs.unidades) {
        if (unit.eliminado) continue;

        // No recuperar supresión si está en melé
        const inMelee = unit.coord && gs.unidades.some(e =>
            e.coord === unit.coord && e.lado !== unit.lado && !e.eliminado
        );

        if (unit.supresion > 0 && !inMelee) {
            unit.supresion--;
            recovered.push(unit);
        }
        unit.marcadores.delete('usado');
        unit.marcadores.delete('movido');
        unit.marcadores.delete('op_fire');
        unit.marcadores.delete('flanco');

        // Recuperar ocultamiento: unidad en terreno de cobertura sin LOS enemigo
        if (!unit.oculto && unit.coord && !inMelee) {
            const hex = gs.mapa[unit.coord];
            if (hex && coverTerrains.has(hex.terreno)) {
                const enemyLOS = gs.unidades.some(enemy => {
                    if (enemy.lado === unit.lado || enemy.eliminado || !enemy.coord) return false;
                    return calcLOS(gs.mapa, enemy.coord, unit.coord, gs.smoke || {}).visible;
                });
                if (!enemyLOS) {
                    unit.oculto = true;
                    regainedConceal.push(unit);
                }
            }
        }
    }
    // Restaurar CPs
    gs.cpRestantes.aliados = gs.scenario.factions.aliados.cps;
    gs.cpRestantes.eje     = gs.scenario.factions.eje.cps;
    return { recovered, regainedConceal };
}

// ────────────────────────────────────────────────────────────────────────────
// Ocultación (Concealment)
// ────────────────────────────────────────────────────────────────────────────

// Elimina el ocultamiento de una unidad (y al señuelo si lo es).
function _loseConcealment(unit) {
    if (!unit.oculto) return;
    unit.oculto = false;
    if (unit.data.categoria === 'decoy') unit.eliminado = true;
}

// Alias mantenido para _applySuppression (no tiene gs en scope)
const _loseConcealment_direct = _loseConcealment;

/**
 * Comprueba el ocultamiento de TODAS las unidades ocultas tras un movimiento.
 * Aplica las reglas de pérdida según tipo (infantería/vehículo).
 * @returns {object[]} unidades que perdieron su ocultamiento en esta llamada
 */
function checkAllConcealment(gs) {
    const revealed = [];
    for (const unit of gs.unidades) {
        if (!unit.oculto || unit.eliminado || !unit.coord) continue;
        const hex = gs.mapa[unit.coord];
        if (!hex) continue;

        const isVehicle = ['vehicle', 'gun'].includes(unit.data.categoria);
        const hasMoved  = unit.marcadores.has('movido');

        // Vehículos: pierden ocultamiento al mover (cualquier terreno)
        if (isVehicle && hasMoved) {
            _loseConcealment(unit);
            revealed.push(unit);
            continue;
        }

        // Enemigo adyacente (infantería/cañón/WT): pierde ocultamiento
        const enemyAdj = HexMap.hexNeighbors(unit.coord, gs.mapa).some(({ coord: nb }) =>
            gs.unidades.some(e =>
                e.coord === nb && e.lado !== unit.lado && !e.eliminado &&
                e.data.categoria !== 'vehicle'
            )
        );
        if (enemyAdj) {
            _loseConcealment(unit);
            revealed.push(unit);
            continue;
        }

        // LOS enemigo:
        //  - Infantería que movió: cualquier terreno
        //  - Infantería estacionaria en terreno abierto
        //  - Vehículo estacionario: cualquier terreno (más restrictivo que infantería)
        const openTerrain = ['TERRENO ABIERTO', 'CARRETERA'].includes(hex.terreno);
        const needsLOSCheck = hasMoved || openTerrain || isVehicle;
        if (needsLOSCheck) {
            const hasLOS = gs.unidades.some(enemy => {
                if (enemy.lado === unit.lado || enemy.eliminado || !enemy.coord) return false;
                return calcLOS(gs.mapa, enemy.coord, unit.coord).visible;
            });
            if (hasLOS) {
                _loseConcealment(unit);
                revealed.push(unit);
            }
        }
    }
    return revealed;
}

/**
 * Aplica conceal inicial a una unidad en su hex de despliegue.
 */
function applyInitialConceal(unit, gs) {
    const hex = gs.mapa[unit.coord];
    if (!hex) return;
    const coverTerrains = new Set(['EDIF. PIEDRA', 'EDIF. MADERA', 'BOSQUE', 'TRINCHERA', 'SETOS']);
    if (coverTerrains.has(hex.terreno)) {
        unit.oculto = true;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Comprobación de victoria
// ────────────────────────────────────────────────────────────────────────────

/**
 * Comprueba las condiciones de victoria del escenario.
 * @returns {null | 'aliados' | 'eje' | 'empate'}
 */
function checkVictory(gs) {
    const victoria = gs.scenario.meta.victoria.toLowerCase();

    // Comprobar si algún bando está eliminado completamente
    for (const lado of ['aliados', 'eje']) {
        const alive = gs.unidades.filter(u => u.lado === lado && !u.eliminado && u.data.categoria !== 'decoy');
        if (alive.length === 0) {
            return lado === 'aliados' ? 'eje' : 'aliados';
        }
    }

    // Turno final alcanzado
    if (gs.turno > gs.maxTurnos) {
        return _evalVictoryCondition(victoria, gs);
    }

    return null;  // Juego continúa
}

function _evalVictoryCondition(texto, gs) {
    // Intentar extraer hexes objetivo del texto de victoria
    // Patrón: hex como "E5", "B5", "5E5" (con número de mapa)
    const hexPattern = /\b(?:\d+)?([A-I]\d)\b/g;
    const hexes = [];
    let m;
    while ((m = hexPattern.exec(texto)) !== null) {
        hexes.push(m[1]);
    }

    if (hexes.length === 0) return 'empate';

    // El bando aliado gana si controla los hexes objetivos
    const playerSide = gs.playerSide;
    const aliadosWin = hexes.every(coord => {
        const ali = gs.unidades.filter(u => u.coord === coord && u.lado === 'aliados' && !u.eliminado);
        const eje = gs.unidades.filter(u => u.coord === coord && u.lado === 'eje' && !u.eliminado && u.data.categoria !== 'decoy');
        return ali.length > 0 && eje.length === 0;
    });

    if (aliadosWin) return 'aliados';

    const ejeWin = hexes.some(coord => {
        const eje = gs.unidades.filter(u => u.coord === coord && u.lado === 'eje' && !u.eliminado && u.data.categoria !== 'decoy');
        return eje.length > 0;
    });

    return ejeWin ? 'eje' : 'empate';  // Si aliados no controlan objetivos y eje tampoco → empate
}

// ────────────────────────────────────────────────────────────────────────────
// Utilidades de validación de despliegue
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calcula los hexes válidos para el despliegue inicial de un bando.
 */
function getDeploymentHexes(lado, gs) {
    const faction = lado === 'aliados'
        ? gs.scenario.factions.aliados
        : gs.scenario.factions.eje;
    const texto = faction.despliegue.toLowerCase();
    const allCoords = Object.keys(gs.mapa);

    let validHexes = allCoords.filter(coord => {
        const hex = gs.mapa[coord];
        return hex && hex.terreno !== 'RIO / CANAL';
    });

    // Parsear instrucciones comunes
    if (texto.includes('west edge') || texto.includes('borde oeste') || texto.includes('enter the west')) {
        validHexes = allCoords.filter(coord => HexMap.coordParts(coord).ci === 0);
    } else if (texto.includes('east edge') || texto.includes('east of the canal')) {
        // Este del canal = columnas F en adelante (E es el canal)
        validHexes = allCoords.filter(coord => HexMap.coordParts(coord).ci >= 5);
    } else if (texto.includes('north')) {
        const rows = allCoords.map(c => HexMap.coordParts(c).row);
        const midRow = Math.floor((Math.max(...rows) + Math.min(...rows)) / 2);
        validHexes = allCoords.filter(coord => HexMap.coordParts(coord).row <= midRow);
    } else if (texto.includes('south')) {
        const rows = allCoords.map(c => HexMap.coordParts(c).row);
        const midRow = Math.floor((Math.max(...rows) + Math.min(...rows)) / 2);
        validHexes = allCoords.filter(coord => HexMap.coordParts(coord).row > midRow);
    }

    // Excluir hexes con unidades enemigas ya desplegadas
    return validHexes.filter(coord => {
        const enemigos = gs.unidades.filter(u =>
            u.coord === coord && u.lado !== lado && !u.eliminado
        );
        return enemigos.length === 0;
    });
}

/**
 * Verifica si una unidad puede entrar en un hex respetando los límites de apilamiento.
 * Reglas:
 *  - Infantería y EM (WT): máx 2 por bando por hex (vehículos no cuentan)
 *  - Cañones (gun): máx 1 por hex por bando
 *  - Vehículos: sin límite de apilamiento
 */
function canStack(coord, lado, gs, unit = null) {
    const allies = gs.unidades.filter(u =>
        u.coord === coord && u.lado === lado && !u.eliminado
    );
    const cat = unit?.data?.categoria;

    if (cat === 'gun') {
        return allies.filter(u => u.data.categoria === 'gun').length === 0;
    }
    if (cat === 'vehicle' || cat === 'aircraft') {
        return true;  // vehículos no tienen límite
    }
    // Infantería y EM: contar sólo unidades no-vehículo
    const infCount = allies.filter(u =>
        !['vehicle', 'gun', 'aircraft', 'decoy'].includes(u.data.categoria)
    ).length;
    return infCount < 2;
}

// ────────────────────────────────────────────────────────────────────────────
// Gestión de activaciones (Ops Phase)
// ────────────────────────────────────────────────────────────────────────────

/** Activa una unidad para esta secuencia. */
function activateUnit(unit) {
    if (unit.marcadores.has('usado')) return false;
    unit.marcadores.delete('op_fire');   // Op fire se consume al activar para otra acción
    return true;
}

/** Marca una unidad como "usada" en este turno. */
function markUsed(unit) {
    unit.marcadores.add('usado');
}

/**
 * ¿Puede el lado `side` seguir activando unidades?
 * Incluye unidades fuera del mapa (sin coord) que aún no han sido activadas,
 * ya que entrar al tablero también cuenta como activación.
 * Los decoys se excluyen: nunca participan en activaciones de operaciones.
 */
function canActivate(lado, gs) {
    return gs.unidades.some(u =>
        u.lado === lado && !u.eliminado && !u.marcadores.has('usado') &&
        u.data.categoria !== 'decoy'
    );
}

/** Revela y elimina un decoy (se usa cuando un enemigo queda adyacente). */
function revealDecoy(decoy) {
    decoy.oculto   = false;
    decoy.eliminado = true;
}

/**
 * Coste en ops de activar una unidad.
 * Vehículos, cañones y aeronaves cuentan como 3 ops; infantería y WT como 1.
 * (Regla: "Vehicles, Guns, and Artillery count as THREE units used against the Operations Range.")
 */
function unitOpsCost(unit) {
    return ['vehicle', 'gun', 'aircraft'].includes(unit.data.categoria) ? 3 : 1;
}

// ────────────────────────────────────────────────────────────────────────────
// Prof Check (Chequeo de Eficiencia) — Vehículos y Cañones
// ────────────────────────────────────────────────────────────────────────────

/**
 * Comprueba si un vehículo/cañón necesita Chequeo de Eficiencia antes de disparar.
 * @returns {{ needed: boolean, modProf: number }}
 */
function needsProfCheck(attacker, target, gs, dist, hindrance, isOpFire, isFinalOpFire = false) {
    if (!attacker.data.eficacia) return { needed: false, modProf: 0 };

    const targetMoved  = target.marcadores?.has('movido');
    const atkMoved     = attacker.marcadores.has('movido');
    const atkOpFire    = attacker.marcadores.has('op_fire');
    const attEle = (gs.mapa[attacker.coord] || {}).elevacion || 0;
    const tgtEle = (gs.mapa[target.coord]   || {}).elevacion || 0;
    const higherEle    = tgtEle > attEle;

    // Humo: cualquier humo exige chequeo; -1 solo si no disperso
    const los = calcLOS(gs.mapa, attacker.coord, target.coord, gs.smoke || {});
    const smokeForceCheck = los.smokeInPath;

    // PDF: el chequeo solo es necesario cuando al menos una condición aplica
    const needed = dist > 5 || targetMoved || isOpFire || isFinalOpFire ||
                   atkMoved || atkOpFire || smokeForceCheck || higherEle || hindrance > 0;

    if (!needed) return { needed: false, modProf: 0 };

    let mod = 0;

    // Distancia (>5: +0, >10: -1, >20: -2, >30: -3)
    if      (dist > 30) mod -= 3;
    else if (dist > 20) mod -= 2;
    else if (dist > 10) mod -= 1;
    // dist 6-10: +0 (dispara el chequeo pero sin penalización)

    // Estado del objetivo / tipo de fuego (usar solo el peor)
    if (isFinalOpFire)    mod -= 3;
    else if (isOpFire)    mod -= 2;
    else if (targetMoved) mod -= 1;

    // Estado del tirador
    if (atkOpFire) mod += 1;
    if (atkMoved)  mod -= 4;

    // Elevación superior del objetivo: -1
    if (higherEle) mod -= 1;

    // Humo: no disperso -1, disperso +0 (pero sigue requiriendo chequeo)
    if (los.smokeNDInPath) mod -= 1;

    // Obstáculos (-1 por obstáculo)
    mod -= hindrance;

    return { needed: true, modProf: attacker.data.eficacia + mod, smokeForceCheck };
}

// ────────────────────────────────────────────────────────────────────────────
// SATW Check — Chequeo moral previo al uso de armas antitanque
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calcula la moral modificada para el Chequeo SATW.
 * El jugador tira 1d10 y debe sacar ≤ satwMorale para que el arma funcione.
 * @returns {number} moral objetivo modificada
 */
function satwCheckMorale(attacker, target, gs, dist, hindrance, isOpFire, isAssault, smokeNDInPath = false) {
    let morale = attacker.morale_actual;

    // Restar el SATW number de la unidad (campo satw del CSV, ej: 2 para Bazooka)
    // (p.16: "modifier -4 = -2 SATW number, -2 Range")
    morale -= attacker.data.satw || 0;

    // -1 por hex de distancia
    morale -= dist;

    if (isOpFire) morale -= 2;
    if (attacker.marcadores.has('op_fire')) morale += 1;
    if (isAssault) morale -= 1;

    // -1 por cada obstáculo (trigo/huerto en la trayectoria)
    morale -= hindrance;

    // Humo no disperso: -1 (p.24: "non-Dispersed smoke reduces SATW Morale by -1")
    if (smokeNDInPath) morale -= 1;

    return morale;
}

// ────────────────────────────────────────────────────────────────────────────
// Sistema de Humo (Smoke)
// ────────────────────────────────────────────────────────────────────────────

/** Coloca un marcador de humo (tipo 'smoke') en el hex indicado. */
function placeSmoke(coord, gs) {
    if (!gs.smoke) gs.smoke = {};
    gs.smoke[coord] = { tipo: 'smoke', turnoPlaced: gs.turno };
}

/**
 * Avanza el estado del humo un turno:
 * 'smoke' → 'dispersed', 'dispersed' → eliminado.
 * Llamar al inicio de cada nuevo turno.
 */
function tickSmoke(gs) {
    if (!gs.smoke) return;
    for (const coord of Object.keys(gs.smoke)) {
        if (gs.smoke[coord].tipo === 'dispersed') {
            delete gs.smoke[coord];
        } else {
            gs.smoke[coord].tipo = 'dispersed';
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Op Fire eligibility
// ────────────────────────────────────────────────────────────────────────────

/**
 * Comprueba si una unidad puede marcar Op Fire.
 * Los vehículos/cañones solo pueden hacerlo si han usado ≤1/3 de sus MPs.
 */
function canMarkOpFire(unit, mpsSpent) {
    const isVeh = ['vehicle', 'gun'].includes(unit.data.categoria);
    if (!isVeh) return { puede: true };
    const maxMPs = unit.data.mps || 5;
    if (mpsSpent > maxMPs / 3) {
        return { puede: false, motivo: `Vehículo usó ${mpsSpent} MPs (máx ${Math.floor(maxMPs/3)} para Op Fire)` };
    }
    return { puede: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Comprobación de stacking + occupancy
// ────────────────────────────────────────────────────────────────────────────

function getUnitsAt(coord, gs) {
    return gs.unidades.filter(u => u.coord === coord && !u.eliminado);
}

function getEnemiesAt(coord, lado, gs) {
    return gs.unidades.filter(u => u.coord === coord && u.lado !== lado && !u.eliminado);
}

// ────────────────────────────────────────────────────────────────────────────
// Aeronaves (Aircraft)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve un ataque aéreo de `aircraft` sobre `targetCoord`.
 * Ataca a TODAS las unidades enemigas en el hex destino.
 * @param {UnitInstance} aircraft
 * @param {string}       targetCoord
 * @param {object}       gs
 * @param {Function}     rnd  — función que devuelve un número 1-10
 * @returns {{ hits: Array<{unit, roll, result}>, logs: string[] }}
 */
function resolveAircraft(aircraft, targetCoord, gs, rnd) {
    const d = aircraft.data;
    const targets = gs.unidades.filter(u =>
        u.coord === targetCoord && u.lado !== aircraft.lado && !u.eliminado
    );

    const hits = [];
    const logs = [];

    for (const target of targets) {
        const isVeh = ['vehicle', 'gun'].includes(target.data.categoria);
        const fp    = isVeh ? (d.fp_vs_veh || 0) : (d.fp_vs_inf || 0);
        if (fp <= 0) { logs.push(`  ${target.tipo}: FP 0 — sin efecto`); continue; }

        const roll = rnd();
        let effect = 'miss';
        if (roll !== 10) {
            if (roll <= fp) {
                const casThreshold = _getCasThreshold(target);
                effect = (roll <= casThreshold) ? _applyCasualty(target) : 'suppress';
                if (effect === 'suppress') _applySuppression(target, 1);
            }
            if (roll === 1 && effect === 'miss') {
                effect = 'suppress';
                _applySuppression(target, 1);
            }
        }
        // El ataque aéreo quita ocultamiento al objetivo
        _loseConcealment(target);
        hits.push({ unit: target, roll, fp, result: effect });
        logs.push(`  ${target.tipo} FP${fp} dado:${roll} → ${effect}`);
    }

    // La aeronave pierde ocultamiento al atacar y queda marcada como usada
    _loseConcealment(aircraft);
    markUsed(aircraft);

    return { hits, logs };
}

// ────────────────────────────────────────────────────────────────────────────
// Exportar
// ────────────────────────────────────────────────────────────────────────────
return {
    initGame,
    calcLOS,
    calcFPBreakdown,
    canFire,
    resolveFire,
    moralCheck,
    getMovableHexes,
    moveUnit,
    checkOpFire,
    getRoutCandidates,
    resolveRout,
    getMeleeHexes,
    resolveMelee,
    runRecovery,
    applyInitialConceal,
    checkVictory,
    getDeploymentHexes,
    canStack,
    canActivate,
    revealDecoy,
    unitOpsCost,
    activateUnit,
    markUsed,
    getUnitsAt,
    getEnemiesAt,
    needsProfCheck,
    satwCheckMorale,
    placeSmoke,
    tickSmoke,
    canMarkOpFire,
    checkAllConcealment,
    resolveAircraft,
};

})();

window.Engine = Engine;
