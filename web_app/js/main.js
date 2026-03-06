/**
 * main.js — Controlador principal de la aplicación Screaming Eagles AI.
 *
 * Gestiona:
 *  - Pantalla de configuración (setup screen)
 *  - Inicialización de partida
 *  - Flujo de fases: Despliegue → Operaciones → Huida → Melé → Recuperación
 *  - Interacción del jugador (clic en hexes, botones)
 *  - Turnos de la IA
 *  - Actualización del UI
 */

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Estado global de la app
// ────────────────────────────────────────────────────────────────────────────

let GS = null;              // GameState actual
let _selectedUnitId = null; // ID de unidad seleccionada
let _pendingAction  = null; // 'mover' | 'disparar' | null
let _movableHexes   = null; // Map<coord, cost> del turno activo
let _pendingRoll    = null; // { roll, fp, target } — resultado de dado pendiente de confirmar
let _deployingUnit  = null; // unidad a desplegar (si fase === 'despliegue')
let _scenarios      = [];   // lista de escenarios disponibles
let _allUnits       = null; // Map<nombre, UnitData>
let _clockInterval  = null;
let _aiThinking     = false;
let _losCheckMode   = false; // true cuando el jugador está comprobando LOS
let _losOriginHex   = null;  // primer hex seleccionado en el LOS check
let _cpPendingBonus    = 0;    // FP bonus acumulado por CPs para el próximo disparo
let _cpMPBonus         = 0;    // MP bonus acumulado por CPs para el próximo movimiento
let _mpsSpent          = 0;    // MPs gastados en la activación actual (para movimiento continuo)
let _combinedFireUnits = [];   // IDs de unidades en el grupo de fuego combinado
let _pendingProfCheck  = null; // { attacker, target, fp, modProf } — Prof Check pendiente
let _pendingSatwCheck  = null; // { attacker, target, fp, satwMorale } — SATW Check pendiente
let _pendingSmokePlacement = false; // true cuando el jugador está colocando humo
let _pendingMCReroll   = null; // { unit, action } — CM fallido pendiente de re-tirar con CP
let _pendingRoutDeclare = null; // { unit, candidates, morMod } — Declare Retreat pendiente
let _aiPausedForCPFire = false; // señal para pausar secuencia IA tras mover
let _aiResumeCallback  = null; // callback para reanudar secuencia IA
let _pendingCPFinalOpFire = null; // { aiUnit, eligible: [units] } — oportunidad CP Final Op Fire
let _diceQueue    = [];    // cola de dados: [{label, callback}]
let _diceWaiting  = false; // true mientras esperamos que el jugador tire
let _diceCallback = null;  // callback del dado actual en cola

// ────────────────────────────────────────────────────────────────────────────
// Entrada de aplicación
// ────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    _startClock();
    _showSetupScreen();
    _setupKeyboard();
});

// ────────────────────────────────────────────────────────────────────────────
// Atajos de teclado
// ────────────────────────────────────────────────────────────────────────────

function _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Ignorar si el foco está en un input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        // Ignorar si no hay partida activa
        if (!GS || GS.fase === 'despliegue') return;

        const key = e.key.toLowerCase();

        switch (key) {
            case ' ':
            case 'enter': {
                // Tirar dado si el botón está disponible
                const rollBtn = document.getElementById('btn-roll-dice');
                if (rollBtn && !rollBtn.disabled && rollBtn.style.display !== 'none') {
                    e.preventDefault();
                    _rollDice();
                }
                break;
            }
            case 'm': {
                const btn = document.getElementById('btn-mover');
                if (btn && btn.style.display !== 'none' && !btn.disabled) _actionMover();
                break;
            }
            case 'f': {
                const btn = document.getElementById('btn-disparar');
                if (btn && btn.style.display !== 'none' && !btn.disabled) _actionDisparar();
                break;
            }
            case 'o': {
                const btn = document.getElementById('btn-opfire');
                if (btn && btn.style.display !== 'none' && !btn.disabled) _actionOpFire();
                break;
            }
            case 'p':
            case 'escape': {
                const btn = document.getElementById('btn-pasar');
                if (btn && btn.style.display !== 'none' && !btn.disabled) _actionPasar();
                break;
            }
            case 'c': {
                const btn = document.getElementById('btn-cp');
                if (btn && btn.style.display !== 'none' && !btn.disabled) _actionGastarCP();
                break;
            }
        }
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Pantalla de configuración
// ────────────────────────────────────────────────────────────────────────────

async function _showSetupScreen() {
    _show('setup-screen');
    _hide('game-screen');
    _setStatus('Detectando escenarios disponibles...', 'working');

    // Detectar escenarios
    try {
        _scenarios = await Loader.detectScenarios('../Scenarios/');
    } catch(e) {
        _scenarios = [];
    }

    // También intentar cargar unidades en paralelo
    try {
        _allUnits = await Loader.loadUnits('../Unidades/SE_Units.csv');
        log(`▶ ${_allUnits.size} tipos de unidad cargados.`);
    } catch(e) {
        log('⚠ No se pudo cargar SE_Units.csv. Usando datos básicos.');
        _allUnits = _buildFallbackUnits();
    }

    // Rellenar lista de escenarios
    const scList = document.getElementById('scenario-list');
    scList.innerHTML = '';
    if (_scenarios.length === 0) {
        scList.innerHTML = '<div class="scenario-item" style="color:#ff4444">⚠ No se encontraron escenarios.<br>Asegúrate de que el servidor está en marcha.</div>';
    } else {
        for (const sc of _scenarios) {
            const item = document.createElement('div');
            item.className = 'scenario-item';
            item.dataset.url = sc.url;
            item.textContent = `Scenario ${sc.num}`;
            item.addEventListener('click', () => _selectScenario(item, sc));
            scList.appendChild(item);
        }
        // Auto-seleccionar el primero
        if (scList.firstChild) scList.firstChild.click();
    }

    _setStatus('● SISTEMA LISTO', 'ok');
}

let _selectedScenarioUrl = null;
let _selectedScenarioData = null;

async function _selectScenario(itemEl, sc) {
    document.querySelectorAll('.scenario-item').forEach(el => el.classList.remove('selected'));
    itemEl.classList.add('selected');
    _selectedScenarioUrl = sc.url;

    try {
        _selectedScenarioData = await Loader.loadScenario(sc.url);
        const meta = _selectedScenarioData.meta;
        // Actualizar el texto del item en la lista con el título real
        if (meta.titulo) itemEl.textContent = `Scenario ${sc.num} — ${meta.titulo}`;
        document.getElementById('scenario-title').textContent = meta.titulo;
        document.getElementById('scenario-desc').textContent =
            meta.descripcion.slice(0, 400) + (meta.descripcion.length > 400 ? '...' : '');
        document.getElementById('scenario-turns').textContent = `Turnos: ${meta.turnos}`;
        document.getElementById('scenario-victoria').textContent = `Victoria: ${meta.victoria.slice(0, 120)}`;
    } catch(e) {
        document.getElementById('scenario-title').textContent = 'Error al cargar escenario';
    }
}

function _selectFaction(factionEl) {
    document.querySelectorAll('.faction-btn').forEach(el => el.classList.remove('active'));
    factionEl.classList.add('active');
}

async function _startGame() {
    const activeFaction = document.querySelector('.faction-btn.active');
    if (!activeFaction) { alert('Elige un bando.'); return; }
    if (!_selectedScenarioUrl) { alert('Selecciona un escenario.'); return; }

    // Recargar el CSV siempre al iniciar (recoge cambios en disco)
    try {
        _selectedScenarioData = await Loader.loadScenario(_selectedScenarioUrl);
    } catch(e) {
        alert(`Error al cargar el escenario: ${e.message}`); return;
    }

    const playerFactionStr = activeFaction.dataset.faction;  // 'american' o 'german'
    let playerSide;
    const aliadosFaccion = _selectedScenarioData.factions.aliados.faccion.toLowerCase();
    playerSide = playerFactionStr === aliadosFaccion ? 'aliados' : 'eje';

    GS = Engine.initGame(_selectedScenarioData, _allUnits, playerSide);
    log(`▶ PARTIDA INICIADA | Jugador: ${playerFactionStr.toUpperCase()} (${playerSide})`);
    log(`▶ IA: ${GS.aiSide.toUpperCase()} | Turnos: ${GS.maxTurnos}`);

    _show('game-screen');
    _hide('setup-screen');

    // Inicializar mapa SVG
    const svgEl = document.getElementById('hexmap');
    HexMap.init(svgEl, GS.mapa, _onHexClick);
    HexMap.drawHexsides(GS.mapa);  // bocage / hexside features

    _updateHeader();
    _updateUnitLists();
    _render();

    // Iniciar fase de despliegue
    _startDeploymentPhase();
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Despliegue
// ────────────────────────────────────────────────────────────────────────────

function _startDeploymentPhase() {
    GS.fase = 'despliegue';
    const despFirst = GS.deploys_first;

    // IA despliega primero si corresponde
    if (despFirst === GS.aiSide) {
        log('▶ IA despliega sus unidades...');
        AI.aiDeploy(GS.aiSide, GS);
        log('  IA: despliegue completado.');
        _render();
        _startPlayerDeployment();
    } else {
        _startPlayerDeployment();
    }
}

function _startPlayerDeployment() {
    // Determine if player faction enters from edge during Turn 1
    const factionData = GS.playerSide === 'aliados'
        ? GS.scenario.factions.aliados
        : GS.scenario.factions.eje;
    const deployRule = (factionData.despliegue || '').toLowerCase();
    const entersInTurn1 = deployRule.includes('enter') ||
                          deployRule.includes('turn') ||
                          deployRule.includes('turno') ||
                          deployRule.includes('edge');

    const unitsToPlace = entersInTurn1
        ? []
        : GS.unidades.filter(u => u.lado === GS.playerSide && !u.coord);

    if (unitsToPlace.length === 0) {
        if (entersInTurn1) {
            log('▶ Tus unidades entran desde el borde durante el Turno 1.');
            log('  (Selecciónalas en la fase de Operaciones para colocarlas.)');
        } else {
            log('▶ Todas las unidades ya están en el mapa.');
        }
        _setStatus('● Unidades entran en Turno 1 — [INICIAR TURNO 1]', 'ok');
        _updatePhaseActions('deployment-enter');
        return;
    }

    // Mostrar hexes válidos
    const hlMap = {};
    for (const h of validHexes) hlMap[h] = ['hl-deploy'];
    HexMap.setHighlights(hlMap);

    // Seleccionar primera unidad sin colocar
    _deployingUnit = unitsToPlace[0];
    _setStatus(`▶ DESPLIEGUE: Coloca "${_deployingUnit.tipo}" en un hex verde`, 'working');
    _updatePhaseActions('deployment');
    _updateUnitLists();
    _showUnitDetail(_deployingUnit);
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Operaciones
// ────────────────────────────────────────────────────────────────────────────

function _startOpsPhase() {
    GS.fase = 'operaciones';
    GS.opsActivados      = { aliados: 0, eje: 0 };
    GS.opsSeqEquiv       = 0;   // ops equivalents used in the current sequence (vehicles=3, rest=1)
    GS.consecutivePasses = 0;   // consecutive full-sequence passes (2 = end phase)
    GS.jugadorActivo = GS.moves_first;
    _selectedUnitId  = null;
    _pendingAction   = null;

    // Decoys se marcan como 'usado' al inicio de cada turno — nunca se activan
    GS.unidades.filter(u => !u.eliminado && u.data.categoria === 'decoy')
               .forEach(u => u.marcadores.add('usado'));

    // AI auto-deploys if it hasn't entered the map yet (Turn 1 edge-entry simplification)
    if (GS.turno === 1) {
        const aiNoCoord = GS.unidades.filter(u => u.lado === GS.aiSide && !u.coord && !u.eliminado);
        if (aiNoCoord.length > 0) {
            log('▶ IA entra al mapa...');
            AI.aiDeploy(GS.aiSide, GS);
        }
    }

    _render();
    _updateHeader();
    log(`══════════════════════════════`);
    log(`▶ TURNO ${GS.turno} — FASE OPERACIONES`);
    const opsRange = GS.scenario.factions[GS.jugadorActivo]?.ops_range;
    log(`  Empieza: ${GS.jugadorActivo.toUpperCase()} | Rango ops: ${opsRange ? `${opsRange.min}-${opsRange.max}` : '?'}`);

    if (GS.jugadorActivo === GS.aiSide) {
        _updatePhaseActions('ai-turn');
        _setStatus('▶ IA ejecutando secuencia...', 'working');
        setTimeout(_runAISequence, 1000);
    } else {
        _updatePhaseActions('ops-waiting');
        _setStatus(`▶ TU SECUENCIA — selecciona una unidad (rango: ${opsRange ? `${opsRange.min}-${opsRange.max}` : '?'})`, 'ok');
    }
}

/**
 * Called after every player activation or unit-level pass.
 * @param {boolean} wasPasar - true only when player passes the WHOLE sequence
 * @param {UnitInstance|null} activatedUnit - the unit that was activated (null for full sequence pass)
 */
function _afterPlayerActivation(wasPasar, activatedUnit = null) {
    if (!wasPasar && activatedUnit) {
        const cost = Engine.unitOpsCost(activatedUnit);
        GS.opsActivados[GS.playerSide]++;
        GS.opsSeqEquiv += cost;
        GS.consecutivePasses = 0;
    }

    _render();
    _updateUnitLists();
    _checkVictory();
    if (GS.victoria) return;

    const opsRange = GS.scenario.factions[GS.playerSide]?.ops_range || { min: 1, max: 2 };

    // Full sequence pass (no activations this sequence) → end sequence
    if (wasPasar && GS.opsSeqEquiv === 0) {
        GS.consecutivePasses++;
        log(`▶ Jugador pasa secuencia completa. (${GS.consecutivePasses}/2 pases consecutivos)`);
        setTimeout(_endCurrentSequence, 400);
        return;
    }

    // Auto-end at max ops equivalents
    if (!wasPasar && GS.opsSeqEquiv >= opsRange.max) {
        log(`▶ Secuencia completa (${GS.opsSeqEquiv}/${opsRange.max} ops).`);
        setTimeout(_endCurrentSequence, 400);
        return;
    }

    // Check if remaining units (on-map or off-map) can fit in this sequence
    const remaining = opsRange.max - GS.opsSeqEquiv;
    const canFitAny = GS.unidades.some(u =>
        u.lado === GS.playerSide && !u.eliminado &&
        !u.marcadores.has('usado') && Engine.unitOpsCost(u) <= remaining
    );

    if (!canFitAny) {
        log(`▶ No hay unidades que quepan en los ${remaining} ops restantes.`);
        setTimeout(_endCurrentSequence, 400);
        return;
    }

    // Continue sequence
    _updatePhaseActions('ops-waiting');
    _setStatus(`▶ TU SECUENCIA [${GS.opsSeqEquiv}/${opsRange.min}-${opsRange.max}] — ${remaining} ops restantes`, 'ok');
}

/** Ends the current side's sequence and switches to the other (or ends the ops phase). */
function _endCurrentSequence() {
    GS.opsSeqEquiv = 0;

    const playerCanAct = Engine.canActivate(GS.playerSide, GS);
    const aiCanAct     = Engine.canActivate(GS.aiSide, GS);

    // Phase ends when both sides have no units left to activate
    if (!playerCanAct && !aiCanAct) {
        log('▶ Todas las unidades han sido activadas. Fin de Fase de Operaciones.');
        setTimeout(_startRoutPhase, 600);
        return;
    }

    // Phase also ends when both sides have consecutively passed (no activations)
    if (GS.consecutivePasses >= 2) {
        log('▶ Ambos bandos pasaron. Fin de Fase de Operaciones.');
        setTimeout(_startRoutPhase, 600);
        return;
    }

    // Determine next active side
    let nextSide = (GS.jugadorActivo === GS.playerSide) ? GS.aiSide : GS.playerSide;

    // If next side has no units, the current side continues (opponent exhausted)
    if (nextSide === GS.aiSide && !aiCanAct) {
        nextSide = GS.playerSide;
        log('  [IA] Sin unidades disponibles — jugador continúa.');
    } else if (nextSide === GS.playerSide && !playerCanAct) {
        nextSide = GS.aiSide;
        log('  Jugador sin unidades disponibles — IA continúa.');
    }

    GS.jugadorActivo = nextSide;
    _selectedUnitId  = null;
    _pendingAction   = null;
    HexMap.clearHighlights();
    _clearUnitDetail();

    if (GS.jugadorActivo === GS.aiSide) {
        _updatePhaseActions('ai-turn');
        _setStatus('▶ IA ejecutando secuencia...', 'working');
        setTimeout(_runAISequence, 800);
    } else {
        const opsRange = GS.scenario.factions[GS.playerSide]?.ops_range || { min: 1, max: 2 };
        _updatePhaseActions('ops-waiting');
        _setStatus(`▶ TU SECUENCIA — selecciona una unidad (rango: ${opsRange.min}-${opsRange.max})`, 'ok');
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Cola de dados — el jugador tira TODOS los dados (propios y de la IA)
// ────────────────────────────────────────────────────────────────────────────

/** Añade una tirada a la cola. Si la UI no está esperando, muestra el prompt inmediatamente. */
function _enqueueDice(label, callback) {
    _diceQueue.push({ label, callback });
    if (!_diceWaiting) _nextQueuedDice();
}

/** Muestra el siguiente prompt de dado de la cola. */
function _nextQueuedDice() {
    if (_diceQueue.length === 0) {
        _diceWaiting = false;
        // Re-habilitar el botón para que _pendingRoll / _pendingProfCheck / etc. puedan usarlo
        const btn = document.getElementById('btn-roll-dice');
        if (btn) btn.disabled = false;
        const diceEl = document.getElementById('dice-result');
        if (diceEl) diceEl.textContent = '—';
        return;
    }
    _diceWaiting = true;
    const { label, callback } = _diceQueue.shift();
    _diceCallback = callback;
    const diceEl = document.getElementById('dice-result');
    if (diceEl) diceEl.textContent = '—';
    _setStatus(`⚀ ${label} — TIRA EL DADO`, 'working');
    const pendingLabelEl = document.getElementById('dice-pending-label');
    if (pendingLabelEl) pendingLabelEl.textContent = label;
    const btn = document.getElementById('btn-roll-dice');
    if (btn) btn.disabled = false;
}

/**
 * Procesa op-fire events uno a uno pidiendo al jugador que tire el dado.
 * @param {Array}    events    — copia de los eventos de op fire (se modifica)
 * @param {object}   movedUnit — unidad en movimiento (puede quedar eliminada)
 * @param {Function} onDone    — llamado cuando todos los events están resueltos o la unidad muere
 */
function _processOpFireEvents(events, movedUnit, onDone) {
    if (events.length === 0 || movedUnit.eliminado) { onDone(); return; }
    const ev = events.shift();
    const prefix = ev.shooter.lado === GS.aiSide ? '[IA] ' : '';
    log(`⚡ ${prefix}OP FIRE: ${ev.shooter.tipo} (${ev.shooter.coord}) → ${movedUnit.tipo}`);
    _logFPBreakdown(ev.shooter, movedUnit, ev.fp, true);
    _enqueueDice(`${prefix}OP FIRE — ${ev.shooter.tipo}→${movedUnit.tipo} (FP:${ev.fp})`, (roll) => {
        const result = Engine.resolveFire(ev.shooter, movedUnit, roll, ev.fp, GS, true);
        ev.shooter.marcadores.delete('op_fire');
        Engine.markUsed(ev.shooter);
        log(`⚡ OP FIRE: ${ev.shooter.tipo} → ${movedUnit.tipo} | FP:${ev.fp} dado:${roll} → ${_effectText(result.effect)}`);
        _render();
        _processOpFireEvents(events, movedUnit, onDone);
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Turno de la IA
// ────────────────────────────────────────────────────────────────────────────

/** Runs the AI's full ops sequence (up to opsRange.max ops equivalents). */
function _runAISequence() {
    if (_aiThinking) return;
    _aiThinking = true;
    _updateHeader(); // show AI indicator immediately

    const opsRange = GS.scenario.factions[GS.aiSide]?.ops_range || { min: 1, max: 2 };
    let seqEquiv = 0;   // ops equivalents used in this AI sequence

    log(`  [IA] ══ SECUENCIA IA (rango ${opsRange.min}-${opsRange.max} ops) ══`);

    function activateNext() {
        _checkVictory();
        if (GS.victoria) { _aiThinking = false; return; }

        if (seqEquiv >= opsRange.max) {
            log(`  [IA] Secuencia completa (${seqEquiv} ops).`);
            _aiThinking = false;
            _render();
            _updateUnitLists();
            setTimeout(_endCurrentSequence, 400);
            return;
        }

        const action = AI.aiChooseActivation(GS);

        if (!action || action.tipo === 'pasar') {
            if (seqEquiv === 0) {
                GS.consecutivePasses++;
                log(`  [IA] Pasa secuencia completa. (${GS.consecutivePasses}/2 consecutivos)`);
            } else {
                log(`  [IA] Finaliza secuencia (${seqEquiv} ops).`);
            }
            _aiThinking = false;
            _render();
            _updateUnitLists();
            setTimeout(_endCurrentSequence, 400);
            return;
        }

        // Check if this unit would exceed ops max
        const cost = Engine.unitOpsCost(action.unidad);
        if (seqEquiv + cost > opsRange.max) {
            log(`  [IA] Finaliza secuencia — siguiente unidad excedería max (${seqEquiv}/${opsRange.max} ops).`);
            _aiThinking = false;
            _render();
            _updateUnitLists();
            setTimeout(_endCurrentSequence, 400);
            return;
        }

        _executeAIAction(action, () => {
            seqEquiv += cost;
            GS.opsActivados[GS.aiSide]++;
            GS.consecutivePasses = 0;
            GS.opsSeqEquiv = seqEquiv;

            _render();
            _updateUnitLists();

            // ¿Pausa para CP Final Op Fire del jugador?
            if (_aiPausedForCPFire) {
                _aiPausedForCPFire = false;
                _aiThinking = false;
                _aiResumeCallback = () => {
                    _aiThinking = true;
                    setTimeout(activateNext, 600);
                };
                _showCPFinalOpFireUI();
                return;
            }

            const remaining = opsRange.max - seqEquiv;
            const canFitMore = GS.unidades.some(u =>
                u.lado === GS.aiSide && !u.eliminado && u.coord &&
                !u.marcadores.has('usado') && Engine.unitOpsCost(u) <= remaining
            );

            if (canFitMore) {
                setTimeout(activateNext, 900);
            } else {
                log(`  [IA] Secuencia completa (${seqEquiv} ops).`);
                _aiThinking = false;
                setTimeout(_endCurrentSequence, 400);
            }
        });
    }

    activateNext();
}

function _executeAIAction(action, onDone) {
    const unit = action.unidad;

    const _doAction = () => {
        if (action.tipo === 'op_fire') {
            unit.marcadores.add('op_fire');
            unit.marcadores.add('usado');
            log(`  [IA] ${unit.tipo} (${unit.coord}) — FUEGO DE OPORTUNIDAD`);
            onDone();
        } else if (action.tipo === 'mover') {
            log(`  [IA] ${unit.tipo} (${unit.coord}) → MUEVE a ${action.destino}`);
            _processAIMove(unit, action.destino, () => {
                Engine.markUsed(unit);
                _render();
                onDone();
            });
        } else if (action.tipo === 'disparar') {
            const target = action.objetivo;
            log(`  [IA] ${unit.tipo} (${unit.coord}) DISPARA a ${target.tipo} (${target.coord})`);
            _logFPBreakdown(unit, target, action.fp, false);
            _enqueueDice(`[IA] DISPARA — ${unit.tipo}→${target.tipo} FP:${action.fp}`, (roll) => {
                const result = Engine.resolveFire(unit, target, roll, action.fp, GS, false);
                log(`       DADO: ${roll} → ${_effectText(result.effect)}`);
                unit.marcadores.add('usado');
                _render();
                onDone();
            });
        } else {
            onDone();
        }
    };

    // CM requerido para unidades suprimidas antes de mover o disparar
    if (unit.supresion > 0 && action.tipo !== 'op_fire' && action.tipo !== 'pasar') {
        _enqueueDice(`[IA] CM — ${unit.tipo} (Moral:${unit.morale_actual})`, (roll) => {
            const check = Engine.moralCheck(unit, roll);
            log(`  [IA] ${unit.tipo} — CM: ${roll}≤${check.morale} → ${check.pasa ? 'PASA' : 'FALLA'}`);
            if (!check.pasa) {
                Engine.markUsed(unit);
                log(`  [IA] ${unit.tipo} — falla CM, no puede actuar.`);
                _render();
                onDone();
                return;
            }
            _doAction();
        });
        return;
    }

    _doAction();
}

function _processAIMove(unit, destino, onDone) {
    const opEvents = Engine.checkOpFire(unit, destino, GS);
    _processOpFireEvents([...opEvents], unit, () => {
        if (!unit.eliminado) {
            Engine.moveUnit(unit, destino, GS);
            _checkAllConcealmentAfterMove();

            // Comprobar si el jugador puede gastar CP para Final Op Fire extendido
            const cpEligible = _findCPFinalOpFireTargets(unit);
            if (cpEligible.length > 0 && (GS.cpRestantes[GS.playerSide] || 0) > 0) {
                _aiPausedForCPFire = true;
                _pendingCPFinalOpFire = { aiUnit: unit, eligible: cpEligible, selectedShooter: null };
            }
        }
        onDone();
    });
}

/** Encuentra unidades del jugador que puedan hacer Final Op Fire extendido sobre movedUnit */
function _findCPFinalOpFireTargets(movedUnit) {
    return GS.unidades.filter(u => {
        if (u.lado !== GS.playerSide || u.eliminado || !u.coord) return false;
        if (!u.marcadores.has('usado')) return false; // solo unidades ya usadas
        if (Engine.getEnemiesAt(u.coord, GS.playerSide, GS).length > 0) return false; // en melee
        const dist = HexMap.hexDistance(u.coord, movedUnit.coord);
        const maxRange = u.data.alcance_max || 5;
        if (dist <= 1 || dist > maxRange) return false; // adyacente ya es gratis, fuera de rango no
        const los = Engine.calcLOS(GS.mapa, u.coord, movedUnit.coord, GS.smoke || {});
        return los.visible;
    });
}

/** Muestra la UI de CP Final Op Fire: destaca unidades elegibles */
function _showCPFinalOpFireUI() {
    const { aiUnit, eligible } = _pendingCPFinalOpFire;
    const hlMap = {};
    for (const u of eligible) hlMap[u.coord] = ['hl-selected'];
    hlMap[aiUnit.coord] = ['hl-enemy'];
    HexMap.setHighlights(hlMap);
    _setStatus(`★ CP FINAL OP FIRE: ${aiUnit.tipo} se ha movido. Haz clic en unidad propia para disparar.`, 'working');
    _updatePhaseActions('cp-final-opfire', { aiUnit, eligible });
}

/** Jugador selecciona una de sus unidades usadas para hacer CP Final Op Fire */
function _selectCPFinalOpFireShooter(unit) {
    if (!_pendingCPFinalOpFire) return;
    const { eligible } = _pendingCPFinalOpFire;
    if (!eligible.find(u => u.id === unit.id)) return;
    _pendingCPFinalOpFire.selectedShooter = unit;
    _setStatus(`▶ TIRAR DADO para CP Final Op Fire: ${unit.tipo} → ${_pendingCPFinalOpFire.aiUnit.tipo}`, 'working');
    _updatePhaseActions('cp-final-opfire-roll', { unit });
}

/** Dado tirado: resolver el CP Final Op Fire */
function _doCPFinalOpFireRoll(roll) {
    if (!_pendingCPFinalOpFire?.selectedShooter) return;
    const { aiUnit, selectedShooter } = _pendingCPFinalOpFire;
    _pendingCPFinalOpFire = null;

    GS.cpRestantes[GS.playerSide]--;
    _updateHeader();

    const dist = HexMap.hexDistance(selectedShooter.coord, aiUnit.coord);
    const los  = Engine.calcLOS(GS.mapa, selectedShooter.coord, aiUnit.coord, GS.smoke || {});
    const isVeh = selectedShooter.data.fp_vs_inf !== undefined;
    const hindrance = isVeh ? los.hindranceVehicle : los.hindrance;

    // Final Op Fire: FP eficiente con todos los modificadores normales, -2 FP por ser Final
    const result = Engine.resolveFire(selectedShooter, aiUnit, roll, null, GS, true);
    // Aplicar la penalización de Final Op Fire (-2) al FP mostrado en el log
    const fpUsed = Math.max(0, (result.fp || 0));
    log(`▶ CP FINAL OP FIRE: ${selectedShooter.tipo} → ${aiUnit.tipo} | FP:${fpUsed} dado:${roll} → ${_effectText(result.effect)}`);
    log(`  (CP gastado: ${GS.cpRestantes[GS.playerSide]} restantes)`);

    _render();
    _updateUnitLists();
    HexMap.clearHighlights();

    if (_aiResumeCallback) {
        const resume = _aiResumeCallback;
        _aiResumeCallback = null;
        setTimeout(resume, 600);
    }
}

/** Jugador declina usar CP Final Op Fire */
function _declineCPFinalOpFire() {
    _pendingCPFinalOpFire = null;
    log(`▶ CP Final Op Fire — DECLINADO`);
    HexMap.clearHighlights();
    _updatePhaseActions('ai-turn');
    if (_aiResumeCallback) {
        const resume = _aiResumeCallback;
        _aiResumeCallback = null;
        setTimeout(resume, 400);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Huida (Rout)
// ────────────────────────────────────────────────────────────────────────────

function _startRoutPhase() {
    GS.fase = 'huida';
    log('══════════════════════════════');
    log('▶ FASE DE HUIDA');
    _updateHeader();
    _render();

    const candidates = Engine.getRoutCandidates(GS);
    if (candidates.length === 0) {
        log('  Sin unidades que deban chequear huida.');
        setTimeout(_startMeleePhase, 600);
        return;
    }

    _processRoutUnit([...candidates]);
}

function _processRoutUnit(candidates) {
    if (candidates.length === 0) {
        _render();
        _updateUnitLists();
        _checkVictory();
        if (GS.victoria) return;
        _setStatus('▶ FASE HUIDA completa — [CONTINUAR]', 'ok');
        _updatePhaseActions('continue-to-melee');
        return;
    }
    const unit = candidates.shift();
    const side = unit.lado === GS.playerSide ? '▶' : '[IA]';

    // Para unidades del jugador, ofrecer Declarar Retirada (+4 Moral)
    if (unit.lado === GS.playerSide) {
        _pendingRoutDeclare = { unit, candidates, morMod: 0 };
        _updatePhaseActions('rout-retreat-offer', { unit });
        return;
    }

    _doRoutRoll(unit, side, candidates, 0);
}

function _doRoutRoll(unit, side, candidates, morMod) {
    _enqueueDice(`${side} HUIDA — ${unit.tipo} CM (Moral:${unit.morale_actual + morMod})`, (roll) => {
        const result = Engine.resolveRout(unit, GS, () => roll, morMod);
        const status = result.check.pasa
            ? `PASA (${roll}≤${result.check.morale})`
            : `FALLA (${roll}>${result.check.morale})`;
        const casSuffix = result.casualty ? ' [BAJA]' : '';
        const moved = unit.eliminado ? '→ ELIMINADA'
                    : result.moved   ? `→ mueve a ${unit.coord}`
                    : '';
        log(`  ${side} ${unit.tipo} CM: ${status}${casSuffix} ${moved}`);
        _render();
        _processRoutUnit(candidates);
    });
}

function _confirmDeclareRetreat(declare) {
    if (!_pendingRoutDeclare) return;
    const { unit, candidates } = _pendingRoutDeclare;
    _pendingRoutDeclare = null;
    const morMod = declare ? 4 : 0;
    if (declare) log(`  ▶ ${unit.tipo} DECLARA RETIRADA (+4 Moral para CM)`);
    _doRoutRoll(unit, '▶', candidates, morMod);
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Melé (Melee)
// ────────────────────────────────────────────────────────────────────────────

function _startMeleePhase() {
    GS.fase = 'melee';
    log('══════════════════════════════');
    log('▶ FASE DE MELÉ');
    _updateHeader();
    _render();

    const meleeHexes = Engine.getMeleeHexes(GS);
    if (meleeHexes.length === 0) {
        log('  Sin combates cuerpo a cuerpo.');
        setTimeout(_startRecoveryPhase, 600);
        return;
    }

    _processMeleeHex([...meleeHexes]);
}

/** Procesa hexes de melé uno a uno, recogiendo dados del jugador para cada unidad. */
function _processMeleeHex(hexes) {
    if (hexes.length === 0) {
        _render();
        _updateUnitLists();
        _checkVictory();
        if (GS.victoria) return;
        _setStatus('▶ FASE MELÉ completa — [CONTINUAR]', 'ok');
        _updatePhaseActions('continue-to-recovery');
        return;
    }
    const coord = hexes.shift();
    const units = GS.unidades.filter(u => u.coord === coord && !u.eliminado);
    const rolls = [];
    _collectMeleeDice(units, 0, rolls, coord, () => {
        let rollIdx = 0;
        const result = Engine.resolveMelee(coord, GS, () => rolls[rollIdx++]);
        log(`  MELÉ en ${coord}:`);
        for (const [lado, rs] of Object.entries(result.results)) {
            for (const r of rs) {
                log(`    ${lado}: ${r.unit.tipo} dados(${r.roll1},${r.roll2}) → ${r.hits} impactos`);
            }
        }
        for (const [lado, cas] of Object.entries(result.casualties)) {
            for (const c of cas) {
                log(`    💥 ${c.unit.tipo} (${lado}): ${c.result}`);
            }
        }
        _render();
        _processMeleeHex(hexes);
    });
}

function _collectMeleeDice(units, unitIdx, rolls, coord, onDone) {
    if (unitIdx >= units.length) { onDone(); return; }
    const unit = units[unitIdx];
    const side = unit.lado === GS.playerSide ? '▶' : '[IA]';
    const dieNum = (rolls.length % 2) + 1;
    _enqueueDice(`${side} MELÉ dado ${dieNum}/2 — ${unit.tipo} (${coord})`, (roll) => {
        rolls.push(roll);
        if (rolls.length % 2 === 0) {
            // Both dice for this unit collected
            _collectMeleeDice(units, unitIdx + 1, rolls, coord, onDone);
        } else {
            // Need second die
            _collectMeleeDice(units, unitIdx, rolls, coord, onDone);
        }
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Fase de Recuperación (Recovery)
// ────────────────────────────────────────────────────────────────────────────

function _startRecoveryPhase() {
    GS.fase = 'recuperacion';
    log('══════════════════════════════');
    log('▶ FASE DE RECUPERACIÓN');
    _updateHeader();

    // Avanzar estado del humo: smoke → dispersed → eliminado
    if (GS.smoke) {
        Engine.tickSmoke(GS);
        HexMap.drawSmoke(GS.smoke);
    }

    const { recovered, regainedConceal } = Engine.runRecovery(GS);
    if (recovered.length > 0) {
        log(`  Recuperación: ${recovered.length} unidades recuperan supresión.`);
    }
    if (regainedConceal.length > 0) {
        log(`  Ocultamiento recuperado: ${regainedConceal.map(u => u.tipo).join(', ')}.`);
    }

    _render();
    _updateUnitLists();
    _checkVictory();
    if (GS.victoria) return;

    GS.turno++;
    log(`══════════════════════════════`);
    log(`▶ FIN TURNO ${GS.turno - 1} | Inicio Turno ${GS.turno}`);

    if (GS.turno > GS.maxTurnos) {
        _endGame(null);
        return;
    }

    _setStatus(`▶ TURNO ${GS.turno - 1} COMPLETADO — [INICIAR TURNO ${GS.turno}]`, 'ok');
    _updatePhaseActions('start-new-turn');
}

// ────────────────────────────────────────────────────────────────────────────
// Victoria / Fin de partida
// ────────────────────────────────────────────────────────────────────────────

function _checkVictory() {
    const v = Engine.checkVictory(GS);
    if (v) {
        GS.victoria = v;
        _endGame(v);
    }
}

function _endGame(winner) {
    GS.victoria = winner;
    GS.fase = 'fin';
    _updateHeader();
    HexMap.clearHighlights();
    _render();

    let msg, cls;
    if (!winner || winner === 'empate') {
        msg = '★ EMPATE — Ningún bando alcanzó sus objetivos ★';
        cls = 'working';
    } else if (winner === GS.playerSide) {
        msg = '★ VICTORIA ★ — ¡Has ganado la partida!';
        cls = 'ok';
    } else {
        msg = '✖ DERROTA — La IA ha ganado esta batalla.';
        cls = 'error';
    }

    log('══════════════════════════════');
    log(msg);
    _setStatus(msg, cls);
    _updatePhaseActions('game-over');
    _showVictoryModal(winner);
}

function _showVictoryModal(winner) {
    const modal = document.getElementById('victory-modal');
    const title = document.getElementById('victory-title');
    const subtitle = document.getElementById('victory-subtitle');
    if (!modal) return;

    if (!winner || winner === 'empate') {
        title.textContent = '═══ EMPATE ═══';
        subtitle.textContent = 'Ningún bando logró sus objetivos.';
    } else if (winner === GS.playerSide) {
        title.textContent = '★ VICTORIA ★';
        subtitle.textContent = '¡Has cumplido el objetivo del escenario!';
    } else {
        title.textContent = '✖ DERROTA ✖';
        subtitle.textContent = 'La IA ha ganado esta batalla táctica.';
    }
    modal.style.display = 'flex';
}

// ────────────────────────────────────────────────────────────────────────────
// Interacción del jugador con el mapa
// ────────────────────────────────────────────────────────────────────────────

function _onHexClick(coord, unitId) {
    if (!GS) return;

    // LOS check mode takes priority over all other interactions
    if (_losCheckMode) {
        _handleLOSCheck(coord || unitId && GS.unidades.find(u => u.id === unitId)?.coord);
        return;
    }

    if (GS.fase === 'despliegue') {
        _handleDeploymentClick(coord);
        return;
    }

    // CP Final Op Fire: permitir selección de unidad durante el turno de la IA
    if (_pendingCPFinalOpFire) {
        if (unitId) {
            const unit = GS.unidades.find(u => u.id === unitId);
            if (unit?.lado === GS.playerSide) {
                _selectCPFinalOpFireShooter(unit);
            }
        }
        return;
    }

    if (GS.fase !== 'operaciones') return;
    if (GS.jugadorActivo !== GS.playerSide) return;

    if (unitId) {
        _onUnitClick(unitId, coord);
    } else if (coord) {
        _onEmptyHexClick(coord);
    }
}

function _onUnitClick(unitId, coord) {
    const clickedUnit = GS.unidades.find(u => u.id === unitId);
    if (!clickedUnit) return;

    if (_pendingAction === 'post-move') {
        // En estado post-movimiento: sólo se puede disparar al enemigo (fuego de asalto)
        if (clickedUnit.lado !== GS.playerSide) {
            _handleFireAction(clickedUnit);
        }
        return;
    }

    // ── Modo fuego combinado ────────────────────────────────────────────────
    if (_pendingAction === 'fuego-combinado') {
        if (clickedUnit.lado === GS.playerSide) {
            // Añadir/quitar unidad del grupo (excepto la unidad líder)
            if (!clickedUnit.eliminado && !clickedUnit.marcadores.has('usado') && clickedUnit.supresion !== 2) {
                const idx = _combinedFireUnits.indexOf(clickedUnit.id);
                if (idx === -1) {
                    _combinedFireUnits.push(clickedUnit.id);
                    log(`▶ ${clickedUnit.tipo} (${clickedUnit.coord}) añadida al grupo de fuego`);
                } else if (idx > 0) {
                    // Sólo se puede quitar si no es la líder (índice 0)
                    _combinedFireUnits.splice(idx, 1);
                    log(`▶ ${clickedUnit.tipo} retirada del grupo`);
                } else {
                    _setStatus('⚠ No se puede quitar la unidad líder. Usa CANCELAR.', 'warning');
                    return;
                }
                _refreshCombinedFireHighlights();
                const leadUnit = GS.unidades.find(u => u.id === _combinedFireUnits[0]);
                _updatePhaseActions('fuego-combinado', leadUnit);
            }
        } else {
            // Clic en enemigo → disparar con el grupo
            _handleCombinedFireAction(clickedUnit);
        }
        return;
    }

    if (clickedUnit.lado === GS.playerSide) {
        // Seleccionar unidad propia
        _selectUnit(clickedUnit);
    } else if (_pendingAction === 'mover' && _selectedUnitId) {
        // Mover a hex ocupado por enemigo (melé)
        _handleMoveAction(clickedUnit.coord);
    } else if (_pendingAction === 'disparar' && _selectedUnitId) {
        // Disparar al enemigo
        _handleFireAction(clickedUnit);
    }
}

function _onEmptyHexClick(coord) {
    if (_pendingAction === 'humo' && _selectedUnitId) {
        // Colocación de humo
        const unit = GS.unidades.find(u => u.id === _selectedUnitId);
        if (unit) {
            Engine.placeSmoke(coord, GS);
            Engine.markUsed(unit);
            log(`▶ ${unit.tipo} (${unit.coord}) → HUMO colocado en ${coord}`);
            HexMap.drawSmoke(GS.smoke);
        }
        _pendingAction  = null;
        _selectedUnitId = null;
        _cpMPBonus      = 0;
        HexMap.clearHighlights();
        _clearUnitDetail();
        _updatePhaseActions('ops-waiting');
        if (!GS.victoria) _afterPlayerActivation(false, unit);
        return;
    } else if (_pendingAction === 'bombardeo' && _selectedUnitId) {
        _handleBombardeoAction(coord);
    } else if (_pendingAction === 'mover' && _selectedUnitId) {
        _handleMoveAction(coord);
    } else if (_pendingAction === 'fuego-combinado') {
        _setStatus(`▶ Clic en aliada verde para añadir al grupo · Clic en enemigo rojo para disparar (${_combinedFireUnits.length} unidades)`, 'working');
    } else if (_pendingAction === 'post-move') {
        // En estado post-movimiento: ignorar clics en hexes vacíos
        _setStatus('▶ Elige FUEGO DE ASALTO o TERMINAR', 'warning');
    } else if (_pendingAction === 'entrar' && _selectedUnitId) {
        _handleEntryAction(coord);
    } else if (_pendingAction === 'desplegar' && _deployingUnit) {
        _handleDeploymentClick(coord);
    } else {
        // Clic en hex vacío → deseleccionar
        _selectedUnitId = null;
        _pendingAction = null;
        HexMap.clearHighlights();
        _clearUnitDetail();
        _updatePhaseActions('ops-waiting');
    }
}

function _handleDeploymentClick(coord) {
    if (!_deployingUnit || !coord) return;
    const validHexes = Engine.getDeploymentHexes(GS.playerSide, GS);
    if (!validHexes.includes(coord)) {
        _setStatus('⚠ Hex inválido para despliegue', 'warning');
        return;
    }
    if (!Engine.canStack(coord, GS.playerSide, GS, _deployingUnit)) {
        _setStatus('⚠ Límite de apilamiento alcanzado en ese hex', 'warning');
        return;
    }

    _deployingUnit.coord = coord;
    Engine.applyInitialConceal(_deployingUnit, GS);
    log(`▶ Desplegado: ${_deployingUnit.tipo} en ${coord}${_deployingUnit.oculto ? ' [OCULTO]' : ''}`);

    // Siguiente unidad a desplegar
    const next = GS.unidades.find(u => u.lado === GS.playerSide && !u.coord);
    if (next) {
        _deployingUnit = next;
        const validH = Engine.getDeploymentHexes(GS.playerSide, GS);
        const hlMap = {};
        for (const h of validH) hlMap[h] = ['hl-deploy'];
        HexMap.setHighlights(hlMap);
        _setStatus(`▶ DESPLIEGUE: Coloca "${_deployingUnit.tipo}" en hex verde`, 'working');
        _showUnitDetail(_deployingUnit);
    } else {
        // Despliegue completado
        _deployingUnit = null;
        HexMap.clearHighlights();

        // Si la IA aún no ha desplegado
        const aiLeft = GS.unidades.filter(u => u.lado === GS.aiSide && !u.coord);
        if (aiLeft.length > 0 && GS.deploys_first !== GS.aiSide) {
            log('▶ IA completando despliegue...');
            AI.aiDeploy(GS.aiSide, GS);
            log('  IA: despliegue completado.');
        }

        log('▶ DESPLIEGUE COMPLETADO — Iniciando Turno 1');
        _render();
        _updateUnitLists();
        _setStatus('▶ DESPLIEGUE completo — [INICIAR TURNO 1]', 'ok');
        _updatePhaseActions('deployment-done');
    }

    _render();
    _updateUnitLists();
}

function _selectUnit(unit) {
    // Units without coordinates need to enter from the edge first
    if (!unit.coord) {
        _selectedUnitId = unit.id;
        _pendingAction  = 'entrar';
        _movableHexes   = null;
        HexMap.clearHighlights();
        HexMap.clearLOS();
        _showUnitDetail(unit);
        const entryHexes = Engine.getDeploymentHexes(unit.lado, GS);
        const hlMap = {};
        for (const h of entryHexes) hlMap[h] = ['hl-deploy'];
        HexMap.setHighlights(hlMap);
        _setStatus(`▶ ENTRADA: Coloca "${unit.tipo}" en un hex de entrada (verde)`, 'working');
        _updatePhaseActions('unit-entering', unit);
        _render();
        return;
    }

    // Check ops cost before allowing activation
    if (GS.fase === 'operaciones') {
        const opsRange = GS.scenario.factions[GS.playerSide]?.ops_range || { min: 1, max: 2 };
        const cost = Engine.unitOpsCost(unit);
        const remaining = opsRange.max - GS.opsSeqEquiv;
        if (cost > remaining) {
            const label = cost === 3 ? 'vehículo/cañón (3 ops)' : `unidad (${cost} op)`;
            _setStatus(`⚠ "${unit.tipo}" es ${label} pero sólo quedan ${remaining} ops en esta secuencia`, 'warning');
            return;
        }
    }

    _selectedUnitId = unit.id;
    _pendingAction  = null;
    _movableHexes   = null;
    _mpsSpent       = 0;
    HexMap.clearHighlights();
    HexMap.clearLOS();
    _showUnitDetail(unit);
    _updatePhaseActions('unit-selected', unit);
    _render();
}

/** Handles placing a unit onto an entry hex (Turn 1 entry from edge). */
function _handleEntryAction(coord) {
    const unit = GS.unidades.find(u => u.id === _selectedUnitId);
    if (!unit) return;

    const validHexes = Engine.getDeploymentHexes(unit.lado, GS);
    if (!validHexes.includes(coord)) {
        _setStatus('⚠ Hex inválido para entrada', 'warning');
        return;
    }
    if (!Engine.canStack(coord, unit.lado, GS, unit)) {
        _setStatus('⚠ Límite de apilamiento alcanzado en ese hex', 'warning');
        return;
    }

    unit.coord = coord;
    Engine.applyInitialConceal(unit, GS);
    log(`▶ ${unit.tipo} entra al mapa en ${coord}${unit.oculto ? ' [OCULTO]' : ''}`);

    // Unit entered but is NOT yet marked 'usado' — it may still act this activation.
    // Transition to normal unit-selected state so the player can move/fire.
    _pendingAction = null;
    HexMap.clearHighlights();
    _render();
    _updateUnitLists();
    _showUnitDetail(unit);
    _updatePhaseActions('unit-selected', unit);
    _setStatus(`▶ ${unit.tipo} en ${coord} — elige acción`, 'ok');
}

function _handleMoveAction(coord) {
    if (!_selectedUnitId || !_movableHexes) return;
    if (!_movableHexes.has(coord)) {
        _setStatus('⚠ No puedes mover ahí', 'warning');
        return;
    }

    const unit = GS.unidades.find(u => u.id === _selectedUnitId);
    if (!unit) return;

    // Capturar costo antes de que _movableHexes se limpie en el callback
    const moveCost = _movableHexes.get(coord) ?? 1;

    // Comprobar Op Fire (el jugador tira los dados uno a uno)
    const opEvents = Engine.checkOpFire(unit, coord, GS);
    _processOpFireEvents([...opEvents], unit, () => {
        if (!unit.eliminado) {
            const oldCoord = unit.coord;
            Engine.moveUnit(unit, coord, GS);
            log(`▶ ${unit.tipo} (${oldCoord}) → MUEVE a ${coord}`);
            _checkAllConcealmentAfterMove();
        }

        _mpsSpent += moveCost;
        _movableHexes = null;
        HexMap.clearHighlights();

        if (unit.eliminado) {
            _selectedUnitId = null;
            _pendingAction  = null;
            _mpsSpent = 0;
            _clearUnitDetail();
            _updatePhaseActions('ops-waiting');
            if (!GS.victoria) _afterPlayerActivation(false, unit);
            return;
        }

        _pendingAction = 'post-move';
        _showUnitDetail(unit);
        _updatePhaseActions('post-move', unit);
        _render();

        const remainingMps = (unit.data.mps || 5) - _mpsSpent;
        const canAssaultFire = !['wt_mg', 'wt_mortar'].includes(unit.data.categoria);
        let statusMsg = `▶ ${unit.tipo} en ${coord} — `;
        if (remainingMps > 0) statusMsg += `SEGUIR MOV.(${remainingMps}MP) · `;
        if (canAssaultFire) statusMsg += 'FUEGO ASALTO · ';
        statusMsg += 'TERMINAR';
        _setStatus(statusMsg, 'ok');
    });
}

/**
 * Comprueba el ocultamiento de todas las unidades tras un movimiento.
 * Registra en el log las unidades que pierden el ocultamiento.
 */
function _checkAllConcealmentAfterMove() {
    const revealed = Engine.checkAllConcealment(GS);
    for (const u of revealed) {
        if (u.data.categoria === 'decoy') {
            log(`▶ SEÑUELO revelado y eliminado en ${u.coord}!`);
        } else {
            log(`▶ ${u.tipo} (${u.coord}) — OCULTAMIENTO PERDIDO`);
        }
    }
}

// ── Fuego combinado ────────────────────────────────────────────────────────

/** Activa el modo fuego combinado con la unidad seleccionada como líder. */
function _actionFuegoCombinado() {
    const unit = _getSelectedUnit();
    if (!unit) return;

    _combinedFireUnits = [unit.id];
    _pendingAction = 'fuego-combinado';
    _refreshCombinedFireHighlights();
    _updatePhaseActions('fuego-combinado', unit);
    _setStatus(`▶ FUEGO COMB.: ${unit.tipo} es líder — clic en aliadas (verde) para añadir · clic en enemigo (rojo) para disparar`, 'working');
}

/** Recalcula el resaltado visual en modo fuego combinado. */
function _refreshCombinedFireHighlights() {
    const hlMap = {};

    // Unidades en el grupo → amarillo (seleccionadas)
    for (const uid of _combinedFireUnits) {
        const u = GS.unidades.find(u => u.id === uid);
        if (u?.coord) hlMap[u.coord] = ['hl-selected'];
    }

    // Unidades aliadas disponibles para añadir → verde
    for (const u of GS.unidades) {
        if (u.lado !== GS.playerSide || u.eliminado || !u.coord) continue;
        if (u.marcadores.has('usado') || u.supresion === 2) continue;
        if (_combinedFireUnits.includes(u.id)) continue;
        if (!hlMap[u.coord]) hlMap[u.coord] = ['hl-move'];
    }

    // Objetivos enemigos alcanzables por al menos una unidad del grupo → rojo
    for (const t of GS.unidades) {
        if (t.lado === GS.playerSide || t.eliminado || !t.coord) continue;
        const canAny = _combinedFireUnits.some(uid => {
            const u = GS.unidades.find(u => u.id === uid);
            return u && Engine.canFire(u, t, GS).puede;
        });
        if (canAny && !hlMap[t.coord]) hlMap[t.coord] = ['hl-enemy'];
    }

    HexMap.setHighlights(hlMap);
}

/** Resuelve el disparo combinado contra un objetivo. */
function _handleCombinedFireAction(targetUnit) {
    const group = _combinedFireUnits
        .map(id => GS.unidades.find(u => u.id === id))
        .filter(Boolean);

    _processCombinedFireGroup([...group], targetUnit, [], 0);
}

function _processCombinedFireGroup(group, targetUnit, participants, totalFP) {
    if (group.length === 0) {
        _completeCombinedFire(targetUnit, participants, totalFP);
        return;
    }
    const u = group.shift();
    if (u.supresion === 1) {
        _enqueueDice(`CM — ${u.tipo} (fuego comb.) Moral:${u.morale_actual}`, (roll) => {
            const check = Engine.moralCheck(u, roll);
            log(`▶ ${u.tipo} — CM (fuego comb.): ${roll}≤${check.morale} → ${check.pasa ? 'PASA' : 'FALLA'}`);
            if (check.pasa) {
                const cf = Engine.canFire(u, targetUnit, GS);
                if (cf.puede) { participants.push({ unit: u, fp: cf.fp }); totalFP += cf.fp; }
                else log(`  ↳ ${u.tipo}: excluida (${cf.motivo})`);
            } else {
                log(`  ↳ ${u.tipo} no participa.`);
            }
            _processCombinedFireGroup(group, targetUnit, participants, totalFP);
        });
    } else {
        const check = Engine.canFire(u, targetUnit, GS);
        if (check.puede) { participants.push({ unit: u, fp: check.fp }); totalFP += check.fp; }
        else log(`  ↳ ${u.tipo}: excluida (${check.motivo})`);
        _processCombinedFireGroup(group, targetUnit, participants, totalFP);
    }
}

function _completeCombinedFire(targetUnit, participants, totalFP) {
    if (participants.length === 0) {
        _setStatus('⚠ Ninguna unidad del grupo puede disparar al objetivo', 'warning');
        return;
    }

    const totalFPWithCP = totalFP + _cpPendingBonus;
    if (_cpPendingBonus > 0) log(`▶ CP bonus: +${_cpPendingBonus} FP`);

    const breakdown = participants.map(p => `${p.unit.tipo.slice(0,8)}:${p.fp}`).join(' + ');
    log(`▶ FUEGO COMB. [${breakdown}]${_cpPendingBonus > 0 ? ` +${_cpPendingBonus}CP` : ''} = FP${totalFPWithCP} → ${targetUnit.tipo} (${targetUnit.coord})`);

    HexMap.drawLOS(participants[0].unit.coord, targetUnit.coord);
    _logFPBreakdown(participants[0].unit, targetUnit, totalFPWithCP, false);

    _pendingRoll = {
        attacker: participants[0].unit,
        target: targetUnit,
        fp: totalFPWithCP,
        combinedParticipants: participants,
    };
    _setStatus(`▶ FUEGO COMB.: FP=${totalFPWithCP} (${participants.length} unidades) | [TIRAR DADO]`, 'working');
    _updatePhaseActions('fire-roll', { fp: totalFPWithCP });
}

/** Genera y loguea el desglose de FP antes del dado de disparo. */
function _logFPBreakdown(attacker, target, fp, isOpFire = false) {
    const dist = HexMap.hexDistance(attacker.coord, target.coord);
    const los  = Engine.calcLOS(GS.mapa, attacker.coord, target.coord, GS.smoke || {});
    const isVeh = attacker.data.fp_vs_inf !== undefined;
    const hindrance = isVeh ? los.hindranceVehicle : los.hindrance;
    const breakdown = Engine.calcFPBreakdown(
        attacker, target, GS, dist, hindrance, isOpFire, los.smokeNDInPath, los.smokeInPath
    );
    log(`  ↳ ${breakdown}`);
}

function _handleFireAction(targetUnit) {
    const attacker = GS.unidades.find(u => u.id === _selectedUnitId);
    if (!attacker) return;

    const check = Engine.canFire(attacker, targetUnit, GS);
    if (!check.puede) {
        _setStatus(`⚠ No puedes disparar: ${check.motivo}`, 'warning');
        return;
    }

    HexMap.drawLOS(attacker.coord, targetUnit.coord);

    // Aplicar bonus de CP acumulado al FP
    const fp = check.fp + _cpPendingBonus;
    if (_cpPendingBonus > 0) {
        log(`▶ CP bonus: +${_cpPendingBonus} FP (base: ${check.fp} → total: ${fp})`);
    }

    const dist = HexMap.hexDistance(attacker.coord, targetUnit.coord);
    const los  = check.los || Engine.calcLOS(GS.mapa, attacker.coord, targetUnit.coord, GS.smoke || {});
    const isArmoredTarget = ['vehicle', 'gun'].includes(targetUnit.data.categoria);
    const isInfantry = attacker.data.fp_vs_inf === undefined;
    const hasSATW = !!(attacker.data.satw || (attacker.cara === 'reduced' && attacker.data.reducida?.satw));
    const isAssault = attacker.marcadores.has('movido');
    const hindrance = (attacker.data.fp_vs_inf !== undefined) ? los.hindranceVehicle : los.hindrance;

    // ── SATW: infantería con arma antitanque disparando a vehículo/cañón ──
    if (isInfantry && hasSATW && isArmoredTarget) {
        const satwMorale = Engine.satwCheckMorale(
            attacker, targetUnit, GS, dist, hindrance, false, isAssault, los.smokeNDInPath
        );
        _pendingSatwCheck = { attacker, target: targetUnit, fp, satwMorale };
        _setStatus(`▶ CHEQUEO SATW: Moral SATW = ${satwMorale} | [TIRAR DADO]`, 'working');
        _updatePhaseActions('satw-check', { satwMorale });
        return;
    }

    // ── Prof Check: vehículos/cañones ──
    if (!isInfantry) {
        const { needed, modProf } = Engine.needsProfCheck(
            attacker, targetUnit, GS, dist, hindrance, false, false
        );
        if (needed) {
            _pendingProfCheck = { attacker, target: targetUnit, fp, modProf };
            _setStatus(`▶ CHEQUEO EFICIENCIA: Ef = ${modProf} | [TIRAR DADO]`, 'working');
            _updatePhaseActions('prof-check', { modProf });
            return;
        }
    }

    // ── Disparo directo (infantería normal, o vehículo sin chequeo necesario) ──
    _logFPBreakdown(attacker, targetUnit, fp, isAssault);
    _pendingRoll = { attacker, target: targetUnit, fp };
    _setStatus(`▶ DISPARO: FP=${fp} | [TIRAR DADO]`, 'working');
    _updatePhaseActions('fire-roll', { fp });
}

function _confirmFire(roll) {
    if (!_pendingRoll) return;
    const { attacker, target, fp, combinedParticipants } = _pendingRoll;

    const result = Engine.resolveFire(attacker, target, roll, fp, GS, false);

    if (combinedParticipants) {
        // Fuego combinado: marcar todas las unidades participantes
        for (const { unit } of combinedParticipants) Engine.markUsed(unit);
    } else {
        Engine.markUsed(attacker);
        log(`▶ ${attacker.tipo} (${attacker.coord}) → DISPARA a ${target.tipo} (${target.coord})`);
    }
    log(`  FP: ${fp} | DADO: ${roll} → ${_effectText(result.effect)}`);

    _pendingRoll       = null;
    _pendingProfCheck  = null;
    _pendingSatwCheck  = null;
    _pendingAction     = null;
    _selectedUnitId    = null;
    _combinedFireUnits = [];
    _cpPendingBonus    = 0;
    _cpMPBonus         = 0;
    _mpsSpent          = 0;
    HexMap.clearLOS();
    HexMap.clearHighlights();
    _clearUnitDetail();
    _updatePhaseActions('ops-waiting');
    if (!GS.victoria) _afterPlayerActivation(false, attacker);
}

// ── CP: Re-tirar CM fallido ───────────────────────────────────────────────────

function _confirmMCReroll(roll) {
    if (!_pendingMCReroll) return;
    const { unit, action } = _pendingMCReroll;
    _pendingMCReroll = null;

    GS.cpRestantes[GS.playerSide]--;
    _updateHeader();

    const check = Engine.moralCheck(unit, roll);
    log(`▶ CP gastado — RE-TIRADA CM: ${roll}≤${check.morale} → ${check.pasa ? 'PASA' : 'FALLA'}`);

    if (check.pasa) {
        _setStatus(`▶ CM RE-TIRADA PASADA: ${unit.tipo} puede actuar`, 'ok');
        // Retomar la acción original (sin repetir el chequeo de CM)
        if (action === 'mover')    _doMover(unit);
        else if (action === 'disparar') _doDisparar(unit);
    } else {
        log(`▶ CM RE-TIRADA FALLADA: ${unit.tipo} — sin acción`);
        Engine.markUsed(unit);
        _pendingAction  = null;
        _selectedUnitId = null;
        HexMap.clearHighlights();
        _clearUnitDetail();
        _updatePhaseActions('ops-waiting');
        if (!GS.victoria) _afterPlayerActivation(false, unit);
        _render();
    }
}

function _declineMCReroll() {
    if (!_pendingMCReroll) return;
    const { unit } = _pendingMCReroll;
    _pendingMCReroll = null;
    Engine.markUsed(unit);
    log(`▶ CM fallido aceptado: ${unit.tipo} — sin acción`);
    _pendingAction  = null;
    _selectedUnitId = null;
    HexMap.clearHighlights();
    _clearUnitDetail();
    _updatePhaseActions('ops-waiting');
    if (!GS.victoria) _afterPlayerActivation(false, unit);
    _render();
}

/** Limpieza compartida tras check fallido (Prof Check, SATW). */
function _failedCheckCleanup(attacker) {
    Engine.markUsed(attacker);
    _cpPendingBonus = 0;
    _pendingAction  = null;
    _selectedUnitId = null;
    HexMap.clearLOS();
    HexMap.clearHighlights();
    _clearUnitDetail();
    _updatePhaseActions('ops-waiting');
    if (!GS.victoria) _afterPlayerActivation(false, attacker);
    _render();
}

// ── Chequeo de Eficiencia (Prof Check) para Vehículos/Cañones ───────────────

function _confirmProfCheck(roll) {
    if (!_pendingProfCheck) return;
    const { attacker, target, fp, modProf } = _pendingProfCheck;
    _pendingProfCheck = null;

    if (roll <= modProf) {
        log(`▶ Ef. PASADA (${roll}≤${modProf}): ${attacker.tipo} puede disparar`);
        _pendingRoll = { attacker, target, fp };
        _setStatus(`▶ DISPARO: FP=${fp} | [TIRAR DADO]`, 'working');
        _updatePhaseActions('fire-roll', { fp });
        _render();
    } else {
        log(`▶ Ef. FALLADA (${roll}>${modProf}): ${attacker.tipo} — FUEGO FALLIDO`);
        _failedCheckCleanup(attacker);
    }
}

// ── Chequeo SATW (morale check previo al uso de armas antitanque) ────────────

function _confirmSatwCheck(roll) {
    if (!_pendingSatwCheck) return;
    const { attacker, target, fp, satwMorale } = _pendingSatwCheck;
    _pendingSatwCheck = null;

    if (roll <= satwMorale) {
        log(`▶ SATW PASADO (${roll}≤${satwMorale}): ${attacker.tipo} dispara`);
        _pendingRoll = { attacker, target, fp };
        _setStatus(`▶ DISPARO SATW: FP=${fp} | [TIRAR DADO]`, 'working');
        _updatePhaseActions('fire-roll', { fp });
        _render();
    } else {
        log(`▶ SATW FALLADO (${roll}>${satwMorale}): ${attacker.tipo} — DISPARO CANCELADO`);
        _failedCheckCleanup(attacker);
    }
}

// ── Colocación de Humo ───────────────────────────────────────────────────────

function _actionTirarHumo() {
    const unit = _getSelectedUnit();
    if (!unit) return;
    if (!unit.data.es_mortar) {
        _setStatus('⚠ Solo los morteros pueden colocar humo', 'warning');
        return;
    }
    _pendingAction = 'humo';
    const maxRange = unit.data.alcance_max || 5;
    const hlMap = {};
    hlMap[unit.coord] = ['hl-selected'];
    // Resaltar todos los hexes dentro del alcance del mortero
    for (const coord of Object.keys(GS.mapa)) {
        if (coord === unit.coord) continue;
        const d = HexMap.hexDistance(unit.coord, coord);
        if (d >= (unit.data.alcance_min || 2) && d <= maxRange) {
            hlMap[coord] = ['hl-move'];
        }
    }
    HexMap.setHighlights(hlMap);
    _setStatus('▶ HUMO: Haz clic en el hex destino (verde)', 'working');
    _updatePhaseActions('smoke-target');
}

// ────────────────────────────────────────────────────────────────────────────
// Aeronave — Bombardeo
// ────────────────────────────────────────────────────────────────────────────

function _actionBomardeo() {
    const unit = _getSelectedUnit();
    if (!unit || unit.data.categoria !== 'aircraft') return;
    if (unit.marcadores.has('usado')) { _setStatus('⚠ Aeronave ya usada este turno', 'warning'); return; }

    _pendingAction = 'bombardeo';
    const hlMap = { [unit.coord]: ['hl-selected'] };
    // La aeronave puede atacar cualquier hex enemigo en el mapa (alcance ilimitado para Stuka)
    for (const coord of Object.keys(GS.mapa)) {
        const hasEnemy = GS.unidades.some(u => u.coord === coord && u.lado !== unit.lado && !u.eliminado);
        if (hasEnemy) hlMap[coord] = ['hl-fire'];
    }
    HexMap.setHighlights(hlMap);
    _setStatus(`▶ BOMBARDEO: Selecciona hex objetivo (rojo)`, 'working');
    _updatePhaseActions('bombardeo-target');
}

function _handleBombardeoAction(coord) {
    const unit = _getSelectedUnit();
    if (!unit || _pendingAction !== 'bombardeo') return;

    const targets = GS.unidades.filter(u => u.coord === coord && u.lado !== unit.lado && !u.eliminado);
    if (targets.length === 0) { _setStatus('⚠ No hay unidades enemigas en ese hex', 'warning'); return; }

    HexMap.clearHighlights();
    _pendingAction = null;

    log(`▶ BOMBARDEO: ${unit.tipo} ataca ${coord}`);
    const results = Engine.resolveAircraft(unit, coord, GS, () => AI.rnd());
    for (const line of results.logs) log(line);

    _render();
    _updateUnitLists();
    _checkVictory();
    if (!GS.victoria) {
        _selectedUnitId = null;
        _clearUnitDetail();
        _updatePhaseActions('ops-waiting');
        _afterPlayerActivation(false, unit);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Botones de acción del panel derecho
// ────────────────────────────────────────────────────────────────────────────

function _actionMover() {
    const unit = _getSelectedUnit();
    if (!unit) return;

    // CM requerido para unidades suprimidas, solo en el primer movimiento
    if (unit.supresion > 0 && _mpsSpent === 0) {
        _enqueueDice(`CM — ${unit.tipo} para mover (Moral:${unit.morale_actual})`, (roll) => {
            const check = Engine.moralCheck(unit, roll);
            log(`▶ ${unit.tipo} — CM para moverse: ${roll}≤${check.morale} → ${check.pasa ? 'PASA' : 'FALLA'}`);
            if (!check.pasa) {
                if (GS.cpRestantes[GS.playerSide] > 0) {
                    _pendingMCReroll = { unit, action: 'mover' };
                    _setStatus(`⚠ CM fallido (${roll}>${check.morale}) — ★ CP disponible: RE-TIRAR o ACEPTAR`, 'warning');
                    _updatePhaseActions('mc-reroll', { unit, check });
                    return;
                }
                _setStatus(`⚠ CM fallido (${roll}>${check.morale}): ${unit.tipo} no puede mover`, 'warning');
                _render();
                return;
            }
            _doMover(unit);
        });
        return;
    }

    _doMover(unit);
}

function _doMover(unit) {
    const isContinuing = _pendingAction === 'post-move' && _mpsSpent > 0;

    // CM -3 para salir del melé (solo al iniciar movimiento, no al continuar)
    if (!isContinuing) {
        const inMelee = GS.unidades.some(e =>
            e.coord === unit.coord && e.lado !== unit.lado && !e.eliminado
        );
        if (inMelee) {
            _enqueueDice(`CM MELÉ — ${unit.tipo} intenta salir (Moral:${unit.morale_actual}-3=${unit.morale_actual - 3})`, (roll) => {
                const check = Engine.moralCheck(unit, roll, -3);
                if (!check.pasa) {
                    log(`▶ CM fallido (${roll}>${check.morale}): ${unit.tipo} no puede salir del melé`);
                    Engine.markUsed(unit);
                    _selectedUnitId = null;
                    _pendingAction  = null;
                    _mpsSpent = 0;
                    _clearUnitDetail();
                    _updatePhaseActions('ops-waiting');
                    return;
                }
                log(`▶ CM pasado (${roll}≤${check.morale}): ${unit.tipo} puede salir del melé`);
                _doMoverContinue(unit);
            });
            return;
        }
    }

    _doMoverContinue(unit);
}

function _doMoverContinue(unit) {
    const isContinuing = _pendingAction === 'post-move' && _mpsSpent > 0;
    if (!isContinuing) { _mpsSpent = 0; _cpMPBonus = 0; }
    const remainingMps = (unit.data.mps || 5) - _mpsSpent + _cpMPBonus;

    _movableHexes = Engine.getMovableHexes(unit, GS, remainingMps);
    if (_movableHexes.size === 0) {
        _setStatus('⚠ No quedan MPs disponibles o no hay hexes accesibles', 'warning');
        return;
    }
    _pendingAction = 'mover';
    const hlMap = {};
    for (const [coord] of _movableHexes.entries()) {
        hlMap[coord] = ['hl-move'];
    }
    hlMap[unit.coord] = ['hl-selected'];
    HexMap.setHighlights(hlMap);
    const mpInfo = isContinuing ? ` (${remainingMps} MPs restantes)` : '';
    _setStatus(`▶ MOVER${mpInfo}: Haz clic en el hex destino (verde)`, 'working');
    _updatePhaseActions('moving');
}

function _actionDisparar() {
    const unit = _getSelectedUnit();
    if (!unit) return;

    // CM requerido para unidades suprimidas antes de disparar
    if (unit.supresion === 1) {
        _enqueueDice(`CM — ${unit.tipo} para disparar (Moral:${unit.morale_actual})`, (roll) => {
            const check = Engine.moralCheck(unit, roll);
            log(`▶ ${unit.tipo} — CM para disparar: ${roll}≤${check.morale} → ${check.pasa ? 'PASA' : 'FALLA'}`);
            if (!check.pasa) {
                if (GS.cpRestantes[GS.playerSide] > 0) {
                    _pendingMCReroll = { unit, action: 'disparar' };
                    _setStatus(`⚠ CM fallido (${roll}>${check.morale}) — ★ CP disponible: RE-TIRAR o ACEPTAR`, 'warning');
                    _updatePhaseActions('mc-reroll', { unit, check });
                    return;
                }
                _setStatus(`⚠ CM fallido (${roll}>${check.morale}): ${unit.tipo} no puede disparar`, 'warning');
                _render();
                return;
            }
            _doDisparar(unit);
        });
        return;
    }

    _doDisparar(unit);
}

function _doDisparar(unit) {
    _pendingAction = 'disparar';

    const targets = GS.unidades.filter(u =>
        u.lado !== GS.playerSide && !u.eliminado && u.coord
    );
    const hlMap = {};
    hlMap[unit.coord] = ['hl-selected'];
    for (const t of targets) {
        const check = Engine.canFire(unit, t, GS);
        if (check.puede) {
            hlMap[t.coord] = ['hl-enemy'];
        }
    }
    HexMap.setHighlights(hlMap);
    _setStatus('▶ DISPARAR: Haz clic en el objetivo (rojo)', 'working');
    _updatePhaseActions('firing');
}

function _actionOpFire() {
    const unit = _getSelectedUnit();
    if (!unit) return;

    // Vehículos/cañones solo pueden hacer Op Fire si usaron ≤1/3 de sus MPs
    const opFireCheck = Engine.canMarkOpFire(unit, _mpsSpent);
    if (!opFireCheck.puede) {
        _setStatus(`⚠ ${opFireCheck.motivo}`, 'warning');
        return;
    }

    unit.marcadores.add('op_fire');
    unit.marcadores.add('usado');
    log(`▶ ${unit.tipo} (${unit.coord}) — FUEGO DE OPORTUNIDAD (Op Fire)`);
    const activatedUnit = unit;
    _selectedUnitId = null;
    _pendingAction  = null;
    HexMap.clearHighlights();
    _clearUnitDetail();
    _updatePhaseActions('ops-waiting');
    _afterPlayerActivation(false, activatedUnit);
}

function _actionPasar() {
    // Si estamos en cola de dados (OP FIRE, CM IA, etc.) ignorar PASAR — el jugador debe tirar
    if (_diceWaiting) return;

    // Cancelar bombardeo
    if (_pendingAction === 'bombardeo') {
        _pendingAction  = null;
        _selectedUnitId = null;
        HexMap.clearHighlights();
        _clearUnitDetail();
        _updatePhaseActions('ops-waiting');
        _setStatus('▶ Bombardeo cancelado', 'ok');
        return;
    }

    // Cancelar colocación de humo
    if (_pendingAction === 'humo') {
        _pendingAction  = null;
        _selectedUnitId = null;
        HexMap.clearHighlights();
        _clearUnitDetail();
        _updatePhaseActions('ops-waiting');
        _setStatus('▶ Colocación de humo cancelada', 'ok');
        return;
    }

    // Rechazar CP re-roll de CM
    if (_pendingMCReroll) {
        _declineMCReroll();
        return;
    }

    // Tirar normal en HUIDA (sin declarar retirada)
    if (_pendingRoutDeclare) {
        _confirmDeclareRetreat(false);
        return;
    }

    // Declinar CP Final Op Fire durante turno IA
    if (_pendingCPFinalOpFire) {
        _declineCPFinalOpFire();
        return;
    }

    // Cancelar fuego combinado sin terminar la activación
    if (_pendingAction === 'fuego-combinado') {
        const leadId = _combinedFireUnits[0];
        _combinedFireUnits = [];
        _pendingAction = null;
        HexMap.clearHighlights();
        const leadUnit = leadId ? GS.unidades.find(u => u.id === leadId) : null;
        if (leadUnit) {
            _selectedUnitId = leadUnit.id;
            _showUnitDetail(leadUnit);
            _updatePhaseActions('unit-selected', leadUnit);
            _setStatus('▶ Fuego combinado cancelado', 'ok');
        } else {
            _selectedUnitId = null;
            _clearUnitDetail();
            _updatePhaseActions('ops-waiting');
        }
        return;
    }

    const unit = _getSelectedUnit();
    _selectedUnitId = null;
    _pendingAction  = null;
    HexMap.clearHighlights();
    _clearUnitDetail();

    if (unit && !unit.marcadores.has('usado')) {
        // Terminar activación: unidad movió (post-move) o pasa sin hacer nada
        Engine.markUsed(unit);
        _mpsSpent = 0;
        const moved = unit.marcadores.has('movido');
        log(`▶ ${unit.tipo} — ${moved ? 'TERMINA activación (movió, sin fuego)' : 'PASA (sin acción)'}`);
        const passedUnit = unit;
        _updatePhaseActions('ops-waiting');
        _afterPlayerActivation(false, passedUnit);
    } else {
        // Pass entire sequence (no unit selected or unit already used)
        log('▶ Jugador pasa secuencia completa.');
        _updatePhaseActions('ops-waiting');
        _afterPlayerActivation(true, null);
    }
}

/** End sequence voluntarily (only allowed when opsSeqEquiv >= opsRange.min). */
function _actionFinSequencia() {
    const opsRange = GS.scenario.factions[GS.playerSide]?.ops_range || { min: 1, max: 2 };
    if (GS.opsSeqEquiv < opsRange.min) {
        _setStatus(`⚠ Activa al menos ${opsRange.min} unidad(es) antes de finalizar la secuencia`, 'warning');
        return;
    }
    log(`▶ Jugador finaliza secuencia voluntariamente (${GS.opsSeqEquiv} activaciones).`);
    GS.consecutivePasses = 0;
    _selectedUnitId = null;
    _pendingAction  = null;
    HexMap.clearHighlights();
    _clearUnitDetail();
    _endCurrentSequence();
}

function _actionGastarCP() {
    const unit = _getSelectedUnit();
    if (!unit) return;
    const cp = GS.cpRestantes[GS.playerSide];
    if (cp <= 0) { _setStatus('⚠ Sin Puntos de Comando disponibles', 'warning'); return; }
    GS.cpRestantes[GS.playerSide]--;
    _updateHeader();

    // Contexto: si la unidad está en fase de movimiento, el CP añade +1 MP
    // En cualquier otro caso, añade +1 FP al siguiente disparo
    if (_pendingAction === 'mover' || _pendingAction === 'post-move') {
        _cpMPBonus++;
        log(`▶ CP gastado (${cp - 1} restantes): +${_cpMPBonus} MP acumulado`);
        _setStatus(`▶ CP: +${_cpMPBonus} MP extra disponible`, 'ok');
        // Recalcular hexes accesibles con el nuevo bonus de MP
        const remaining = (unit.data.mps || 5) - _mpsSpent + _cpMPBonus;
        _movableHexes = Engine.getMovableHexes(unit, GS, remaining);
        const hlMap = {};
        for (const [coord] of _movableHexes.entries()) hlMap[coord] = ['hl-move'];
        hlMap[unit.coord] = ['hl-selected'];
        HexMap.setHighlights(hlMap);
    } else {
        _cpPendingBonus++;
        log(`▶ CP gastado (${cp - 1} restantes): +${_cpPendingBonus} FP acumulado al siguiente disparo`);
        _setStatus(`▶ CP: +${_cpPendingBonus} FP aplicado al siguiente disparo`, 'ok');
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Dados
// ────────────────────────────────────────────────────────────────────────────

function _rollDice() {
    const diceEl = document.getElementById('dice-result');
    const rollBtn = document.getElementById('btn-roll-dice');
    if (rollBtn) rollBtn.disabled = true;

    let i = 0;
    const frames = 12;
    const interval = setInterval(() => {
        const r = Math.floor(Math.random() * 10);
        diceEl.textContent = r === 0 ? '10' : String(r);
        i++;
        if (i >= frames) {
            clearInterval(interval);
            const final = AI.rnd();
            diceEl.textContent = String(final);
            diceEl.classList.remove('dice-low', 'dice-high');
            if (final <= 3) diceEl.classList.add('dice-low');
            else if (final >= 8) diceEl.classList.add('dice-high');
            diceEl.classList.add('dice-flash');
            setTimeout(() => diceEl.classList.remove('dice-flash'), 600);
            // Cola de dados (op fire, CM de IA, etc.) — máxima prioridad
            if (_diceCallback) {
                const cb = _diceCallback;
                _diceCallback = null;
                const pendingLabelEl = document.getElementById('dice-pending-label');
                if (pendingLabelEl) pendingLabelEl.textContent = '';
                // Botón sigue disabled; _nextQueuedDice lo habilitará cuando haya otro dado
                setTimeout(() => { cb(final); _nextQueuedDice(); }, 400);
                return;
            }

            if (rollBtn) rollBtn.disabled = false;

            // Resolver el estado pendiente según prioridad
            if (_pendingMCReroll) {
                setTimeout(() => _confirmMCReroll(final), 400);
            } else if (_pendingSatwCheck) {
                setTimeout(() => _confirmSatwCheck(final), 400);
            } else if (_pendingProfCheck) {
                setTimeout(() => _confirmProfCheck(final), 400);
            } else if (_pendingCPFinalOpFire) {
                setTimeout(() => _doCPFinalOpFireRoll(final), 400);
            } else if (_pendingRoll) {
                setTimeout(() => _confirmFire(final), 400);
            }
        }
    }, 80);
}

// ────────────────────────────────────────────────────────────────────────────
// Actualización del UI
// ────────────────────────────────────────────────────────────────────────────

function _render() {
    if (!GS) return;
    HexMap.drawUnits(GS.unidades, _selectedUnitId, GS.playerSide);
    if (GS.smoke && Object.keys(GS.smoke).length > 0) HexMap.drawSmoke(GS.smoke);
    _updateHeader();
    _updateStatusBar();
}

function _updateHeader() {
    if (!GS) return;
    const t    = document.getElementById('hdr-turn');
    const p    = document.getElementById('hdr-phase');
    const ops  = document.getElementById('hdr-ops');
    const cpEl = document.getElementById('hdr-cp');
    const aiEl = document.getElementById('hdr-ai-indicator');
    if (t) t.textContent = `TURNO ${GS.turno}/${GS.maxTurnos}`;
    if (p) p.textContent = `▌ ${_phaseLabel(GS.fase)} ▐`;
    if (ops) {
        if (GS.fase === 'operaciones') {
            const opsRange = GS.scenario.factions[GS.jugadorActivo || GS.playerSide]?.ops_range;
            const maxOps   = opsRange ? opsRange.max : '?';
            const minOps   = opsRange ? opsRange.min : '?';
            const cur      = GS.opsSeqEquiv || 0;
            const activo   = GS.jugadorActivo === GS.playerSide ? 'TÚ' : 'IA';
            ops.textContent = `▌ OPS ${cur}/${minOps}-${maxOps} · ${activo} ▐`;
            ops.style.display = '';
        } else {
            ops.style.display = 'none';
        }
    }
    if (cpEl) {
        const cp    = GS.cpRestantes[GS.playerSide] || 0;
        const aiCp  = GS.cpRestantes[GS.aiSide] || 0;
        cpEl.textContent = `★ CP ${cp} / ${aiCp}`;
        cpEl.style.display = '';
    }
    if (aiEl) {
        if (_aiThinking) aiEl.classList.add('active');
        else             aiEl.classList.remove('active');
    }
}

const _PHASE_LABELS = {
    despliegue: 'DESPLIEGUE',
    operaciones: 'OPERACIONES',
    huida: 'HUIDA',
    melee: 'MELÉ',
    recuperacion: 'RECUPERACIÓN',
    fin: 'FIN DE PARTIDA',
};
function _phaseLabel(f) { return _PHASE_LABELS[f] || f.toUpperCase(); }

function _updateStatusBar() {
    if (!GS) return;
    const sb = document.getElementById('statusbar-info');
    if (!sb) return;
    const opsAli = GS.opsActivados?.aliados || 0;
    const opsEje = GS.opsActivados?.eje     || 0;
    const eliminAli = GS.unidades.filter(u => u.lado === 'aliados' && u.eliminado).length;
    const eliminEje = GS.unidades.filter(u => u.lado === 'eje'     && u.eliminado).length;
    sb.textContent = `Acts: ${opsAli}ali/${opsEje}eje | Bajas: ${eliminAli}ali/${eliminEje}eje`;
}

/** Actualiza las listas de unidades en el panel izquierdo. */
function _updateUnitLists() {
    if (!GS) return;
    _renderUnitList('unit-list-aliados', 'aliados');
    _renderUnitList('unit-list-eje', 'eje');
}

function _renderUnitList(elId, lado) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '';
    const units = GS.unidades.filter(u => u.lado === lado);
    for (const u of units) {
        const item = document.createElement('div');
        item.className = `unit-item ${u.eliminado ? 'unit-dead' : ''} ${u.id === _selectedUnitId ? 'unit-selected' : ''}`;

        // Colored status badge
        let badgeText, badgeClass;
        if (u.eliminado)                      { badgeText = '✖'; badgeClass = 'usb-dead'; }
        else if (u.supresion === 2)            { badgeText = '●●'; badgeClass = 'usb-sup2'; }
        else if (u.supresion === 1)            { badgeText = '●'; badgeClass = 'usb-sup1'; }
        else if (u.marcadores.has('op_fire')) { badgeText = 'OP'; badgeClass = 'usb-opfire'; }
        else if (u.marcadores.has('usado'))   { badgeText = '—'; badgeClass = 'usb-used'; }
        else                                   { badgeText = '○'; badgeClass = 'usb-ok'; }

        const badge = document.createElement('span');
        badge.className = `unit-status-badge ${badgeClass}`;
        badge.textContent = badgeText;
        item.appendChild(badge);

        const coordStr = u.coord || (u.eliminado ? '—' : '⊠');
        const isEnemy  = lado !== GS.playerSide;
        const showHidden = isEnemy && u.oculto;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'unit-name';
        if (showHidden) {
            nameSpan.textContent = `??? [${coordStr}]`;
            nameSpan.style.color = '#556655';
        } else {
            const reducedStr = u.cara === 'reduced' ? ' (R)' : '';
            const ocultaStr  = u.oculto ? ' ◉' : '';
            nameSpan.textContent = `${u.tipo.slice(0, 14)}${reducedStr}${ocultaStr} [${coordStr}]`;
        }
        item.appendChild(nameSpan);

        if (!u.eliminado && lado === GS.playerSide) {
            item.style.cursor = 'pointer';
            item.addEventListener('click', () => {
                if (GS.fase === 'operaciones' && GS.jugadorActivo === GS.playerSide) {
                    _selectUnit(u);
                }
            });
        }
        el.appendChild(item);
    }
}

/** Muestra detalles de la unidad seleccionada en el panel derecho. */
function _showUnitDetail(unit) {
    const d = unit.data;
    _setText('detail-name',   unit.tipo);
    _setText('detail-cat',    _catLabel(unit.data.categoria));
    _setText('detail-side',   unit.lado.toUpperCase());
    _setText('detail-fp',     `FP: ${unit.fp_actual} (base: ${d.fp_normal || '?'})`);
    _setText('detail-melee',  d.fp_melee ? `Melé FP: ${d.fp_melee}` : '');
    _setText('detail-range',  d.alcance_max ? `Alcance: ${d.alcance_min}-${d.alcance_max}` : '');
    _setText('detail-moral',  `Moral: ${unit.morale_actual} (base: ${d.moral || '?'})`);
    _setText('detail-mps',    `MPs: ${d.mps || '?'}`);
    _setText('detail-status', _supresionLabel(unit.supresion));
    _setText('detail-cara',   unit.cara === 'reduced' ? '[REDUCIDA]' : '[COMPLETA]');
    _setText('detail-oculto', unit.oculto ? '◉ OCULTA' : '');
    _setText('detail-coord',  unit.coord ? `Pos: ${unit.coord}` : 'Sin posición');
    const markers = [...unit.marcadores].join(', ');
    _setText('detail-markers', markers ? `Marcadores: ${markers}` : '');
}

function _clearUnitDetail() {
    ['detail-name','detail-cat','detail-side','detail-fp','detail-melee',
     'detail-range','detail-moral','detail-mps','detail-status','detail-cara',
     'detail-oculto','detail-coord','detail-markers'].forEach(id => _setText(id, ''));
    _setText('detail-name', '— Sin selección —');
}

/** Actualiza los botones de acción según el estado del juego. */
function _updatePhaseActions(state, data = null) {
    const btns = {
        mover:      document.getElementById('btn-mover'),
        disparar:   document.getElementById('btn-disparar'),
        fuegocomb:  document.getElementById('btn-fuego-comb'),
        opfire:     document.getElementById('btn-opfire'),
        finseq:     document.getElementById('btn-finseq'),
        pasar:      document.getElementById('btn-pasar'),
        cp:         document.getElementById('btn-cp'),
        humo:       document.getElementById('btn-humo'),
        bombardeo:  document.getElementById('btn-bombardeo'),
        continue:   document.getElementById('btn-continue'),
    };

    // Hide all action buttons; the dice button is always visible
    Object.values(btns).forEach(b => { if (b) b.style.display = 'none'; });
    const rollBtn = document.getElementById('btn-roll-dice');
    if (rollBtn) rollBtn.style.display = 'block';

    // Helper: show FIN SECUENCIA button if player has reached the min threshold
    const _maybeShowFinSeq = () => {
        const opsRange = GS?.scenario?.factions?.[GS.playerSide]?.ops_range;
        if (opsRange && GS.opsSeqEquiv >= opsRange.min && GS.opsSeqEquiv > 0) {
            if (btns.finseq) btns.finseq.style.display = 'block';
        }
    };

    switch(state) {
        case 'deployment':
            break;
        case 'deployment-enter':
            if (btns.continue) {
                btns.continue.style.display = 'block';
                btns.continue.textContent   = '▶ INICIAR TURNO 1';
                btns.continue.onclick       = _startOpsPhase;
            }
            break;
        case 'deployment-done':
        case 'start-new-turn':
            if (btns.continue) {
                btns.continue.style.display = 'block';
                btns.continue.textContent   = state === 'start-new-turn'
                    ? `▶ INICIAR TURNO ${GS.turno}`
                    : '▶ INICIAR TURNO 1';
                btns.continue.onclick = _startOpsPhase;
            }
            break;
        case 'ai-turn':
            // No action buttons during AI turn
            break;
        case 'ops-waiting':
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '⏸ PASAR SECUENCIA'; }
            _maybeShowFinSeq();
            break;
        case 'unit-entering': {
            // Unit is being placed on an entry hex
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ CANCELAR ENTRADA'; }
            break;
        }
        case 'post-move': {
            // Unidad ya movió: puede seguir moviendo (si quedan MPs), hacer Fuego de Asalto o terminar
            const pmUnit = data;
            const pmRemaining = pmUnit ? ((pmUnit.data.mps || 5) - _mpsSpent) : 0;
            const pmCanAssault = pmUnit && !['wt_mg', 'wt_mortar'].includes(pmUnit.data.categoria);
            if (pmRemaining > 0 && btns.mover) {
                btns.mover.style.display = 'block';
                btns.mover.textContent = `⇒ SEGUIR MOV.(${pmRemaining}MP)`;
            }
            if (pmCanAssault && btns.disparar) {
                btns.disparar.style.display = 'block';
                btns.disparar.textContent = '⚡ FUEGO ASALTO';
            }
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✔ TERMINAR'; }
            break;
        }
        case 'unit-selected': {
            const unit = data;
            if (!unit || unit.marcadores.has('usado')) {
                if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '⏸ PASAR'; }
                _maybeShowFinSeq();
                break;
            }
            // Decoys no pueden mover ni disparar
            if (unit.data.categoria === 'decoy') {
                if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '⏸ PASAR DECOY'; }
                _maybeShowFinSeq();
                break;
            }
            if (btns.mover)     { btns.mover.style.display = 'block'; btns.mover.textContent = '⇒ MOVER'; }
            if (btns.disparar)  { btns.disparar.style.display = 'block'; btns.disparar.textContent = '⚡ DISPARAR'; }
            if (btns.fuegocomb) btns.fuegocomb.style.display = 'block';
            if (btns.opfire)    btns.opfire.style.display    = 'block';
            if (btns.pasar)   { btns.pasar.style.display     = 'block'; btns.pasar.textContent = '⏸ PASAR UNIDAD'; }
            if (btns.cp && GS.cpRestantes[GS.playerSide] > 0) btns.cp.style.display = 'block';
            if (btns.humo && unit && unit.data.es_mortar) btns.humo.style.display = 'block';
            // Aeronave: mostrar botón de bombardeo
            if (unit && unit.data.categoria === 'aircraft') {
                const bombBtn = document.getElementById('btn-bombardeo');
                if (bombBtn) bombBtn.style.display = 'block';
            }
            _maybeShowFinSeq();
            break;
        }
        case 'fuego-combinado': {
            // Muestra el recuento del grupo y el botón cancelar
            const fcCount = _combinedFireUnits.length;
            const fcFP = _combinedFireUnits
                .map(id => GS.unidades.find(u => u.id === id))
                .filter(Boolean)
                .reduce((s, u) => s + (u.fp_actual || 0), 0);
            if (btns.fuegocomb) {
                btns.fuegocomb.style.display = 'block';
                btns.fuegocomb.textContent = `⚡⚡ GRUPO: ${fcCount} ud. FP≈${fcFP}`;
            }
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ CANCELAR'; }
            break;
        }
        case 'moving':
        case 'firing':
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ CANCELAR'; }
            break;
        case 'fire-roll': {
            const fp = data?.fp || 0;
            if (rollBtn) rollBtn.textContent = `⚀ TIRAR DADO (FP=${fp})`;
            break;
        }
        case 'prof-check': {
            const ef = data?.modProf ?? '?';
            if (rollBtn) rollBtn.textContent = `⚀ CHEQUEO EFICIENCIA (Ef=${ef})`;
            _setStatus(`▶ Tira el dado para el Chequeo de Eficiencia (≤${ef} = pasa)`, 'working');
            break;
        }
        case 'satw-check': {
            const sm = data?.satwMorale ?? '?';
            if (rollBtn) rollBtn.textContent = `⚀ CHEQUEO SATW (Moral=${sm})`;
            _setStatus(`▶ Tira el dado para el Chequeo SATW (≤${sm} = pasa)`, 'working');
            break;
        }
        case 'smoke-target':
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ CANCELAR HUMO'; }
            break;
        case 'bombardeo-target':
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ CANCELAR BOMBARDEO'; }
            if (rollBtn) rollBtn.style.display = 'none';
            break;
        case 'mc-reroll': {
            if (rollBtn) rollBtn.textContent = `⚀ RE-TIRAR CM`;
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ ACEPTAR FALLO'; }
            break;
        }
        case 'cp-final-opfire': {
            const cfUnit = data?.aiUnit;
            _setStatus(`★ CP FINAL OP FIRE: ${cfUnit?.tipo || '?'} se movió. Clic en unidad propia (verde) para disparar.`, 'working');
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ DECLINAR CP'; }
            if (rollBtn) rollBtn.style.display = 'none'; // ocultar dado hasta que seleccione unidad
            break;
        }
        case 'cp-final-opfire-roll': {
            const cfrUnit = data?.unit;
            if (rollBtn) {
                rollBtn.style.display = 'block';
                rollBtn.textContent = `⚀ TIRAR DADO (CP Final Op Fire)`;
            }
            if (btns.pasar) { btns.pasar.style.display = 'block'; btns.pasar.textContent = '✖ DECLINAR CP'; }
            break;
        }
        case 'rout-retreat-offer': {
            const rrUnit = data?.unit;
            const rrMorale = rrUnit ? rrUnit.morale_actual : '?';
            _setStatus(`FASE HUIDA: ${rrUnit?.tipo || '?'} — ¿DECLARAR RETIRADA? (+4 Moral para CM)`, 'working');
            if (btns.continue) {
                btns.continue.style.display = 'block';
                btns.continue.textContent   = `⇦ DECLARAR RETIRADA (Moral: ${rrMorale}+4=${parseInt(rrMorale)+4})`;
                btns.continue.onclick       = () => _confirmDeclareRetreat(true);
            }
            if (btns.pasar) {
                btns.pasar.style.display = 'block';
                btns.pasar.textContent   = `⚀ TIRAR NORMAL (Moral: ${rrMorale})`;
            }
            if (rollBtn) rollBtn.style.display = 'none';
            break;
        }
        case 'continue-to-melee':
            if (btns.continue) {
                btns.continue.style.display = 'block';
                btns.continue.textContent   = '▶ FASE DE MELÉ';
                btns.continue.onclick       = _startMeleePhase;
            }
            break;
        case 'continue-to-recovery':
            if (btns.continue) {
                btns.continue.style.display = 'block';
                btns.continue.textContent   = '▶ RECUPERACIÓN';
                btns.continue.onclick       = _startRecoveryPhase;
            }
            break;
        case 'game-over':
            if (btns.continue) {
                btns.continue.style.display = 'block';
                btns.continue.textContent   = '↺ NUEVA PARTIDA';
                btns.continue.onclick       = () => { location.reload(); };
            }
            break;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Log
// ────────────────────────────────────────────────────────────────────────────

function log(msg, cls = '') {
    const logEl = document.getElementById('ops-log');
    if (!logEl) return;
    // Auto-detect class from message content if not provided
    if (!cls) {
        if (msg.startsWith('══') || msg.match(/^▶ TURNO|^▶ FASE/)) cls = 'log-phase';
        else if (msg.startsWith('  [IA]') || msg.startsWith('[IA]')) cls = 'log-ai';
        else if (msg.includes('ELIMINADA') || msg.includes('BAJA')) cls = 'log-damage';
        else if (msg.includes('SUPRIMIDA') || msg.includes('REDUCIDA')) cls = 'log-effect';
        else if (msg.includes('PASA') && !msg.includes('PASAR')) cls = 'log-ok';
        else if (msg.includes('⚠') || msg.includes('FALLA') || msg.includes('FALLADO')) cls = 'log-warn';
        else if (msg.startsWith('▶') || msg.startsWith('  ▶')) cls = 'log-player';
    }
    const ts = new Date().toLocaleTimeString('es', { hour12: false });
    const line = document.createElement('div');
    line.className = `log-line${cls ? ' ' + cls : ''}`;
    line.textContent = `[${ts}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
}

function _setStatus(msg, level = 'ok') {
    const el = document.getElementById('statusbar-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = `status-${level}`;
    const dot = document.getElementById('status-dot');
    if (dot) {
        dot.className = `dot-${level}`;
        dot.textContent = level === 'ok' ? '●' : level === 'error' ? '✖' : level === 'working' ? '◌' : '▲';
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Reloj
// ────────────────────────────────────────────────────────────────────────────

function _startClock() {
    _updateClock();
    _clockInterval = setInterval(_updateClock, 1000);
}

function _updateClock() {
    const el = document.getElementById('hdr-clock');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString('es', { hour12: false });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function _show(id) { const el = document.getElementById(id); if (el) el.style.display = 'flex'; }
function _hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function _setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function _getSelectedUnit() {
    if (!_selectedUnitId || !GS) return null;
    return GS.unidades.find(u => u.id === _selectedUnitId) || null;
}

function _effectText(effect) {
    const m = { 'miss': 'FALLO', 'suppress': 'SUPRIMIDA', 'reduced': 'REDUCIDA', 'eliminated': 'ELIMINADA' };
    return m[effect] || effect;
}

function _catLabel(cat) {
    const m = { squad:'Escuadra', wt_mg:'EM-MG', wt_mortar:'EM-Mortero', vehicle:'Vehículo', gun:'Cañón', aircraft:'Aeronave', decoy:'Señuelo' };
    return m[cat] || cat;
}

function _supresionLabel(s) {
    return s === 2 ? '🔴 TOTALMENTE SUPRIMIDA' : s === 1 ? '🟡 PARCIALMENTE SUPRIMIDA' : '🟢 NORMAL';
}

/** Fallback de unidades básicas si SE_Units.csv no está disponible. */
function _buildFallbackUnits() {
    const m = new Map();
    const basicInf = (nombre, faccion, fp, prof, melee, cas_red, cas_elim, moral, mps) => ({
        nombre, faccion, categoria: 'squad', fichas: 10, mps,
        fp_normal: fp, fp_eficiente: prof, fp_melee: melee,
        alcance_min: 1, alcance_max: 5, satw: null,
        cas_red, cas_elim, moral, moral_sup: moral - 2, moral_full: moral - 4,
        es_mortar: false, tiene_reducida: true,
        reducida: { fp_normal: Math.ceil(fp/2), fp_eficiente: Math.ceil(prof/2), cas_elim: cas_elim, moral },
    });
    m.set('1st Line',         basicInf('1st Line',         'american', 6, 5, 4, 4, 7, 8, 5));
    m.set('Paratrooper MG',   { nombre: 'Paratrooper MG',  faccion: 'american', categoria: 'wt_mg',    fichas: 3, mps: 4, fp_normal: 8, fp_eficiente: 7, fp_melee: 2, alcance_min: 1, alcance_max: 6, satw: null, cas_red: 4, cas_elim: 7, moral: 8, moral_sup: 6, moral_full: 4, es_mortar: false, tiene_reducida: false, reducida: null });
    m.set('2nd Line',         basicInf('2nd Line',         'german',   5, 4, 3, 4, 7, 7, 5));
    m.set('1st Line MG WT',   { nombre: '1st Line MG WT',  faccion: 'german',   categoria: 'wt_mg',    fichas: 3, mps: 4, fp_normal: 8, fp_eficiente: 7, fp_melee: 2, alcance_min: 1, alcance_max: 6, satw: null, cas_red: 4, cas_elim: 7, moral: 7, moral_sup: 5, moral_full: 3, es_mortar: false, tiene_reducida: false, reducida: null });
    m.set('1st Line DECOY',   { nombre: '1st Line DECOY',  faccion: 'german',   categoria: 'decoy',    fichas: 8, mps: 5, fp_normal: 0, fp_eficiente: 0, fp_melee: 0, alcance_min: 0, alcance_max: 0, satw: null, cas_red: 0, cas_elim: 0, moral: 0, moral_sup: 0, moral_full: 0, es_mortar: false, tiene_reducida: false, reducida: null });
    return m;
}

// ────────────────────────────────────────────────────────────────────────────
// Herramienta de comprobación de LOS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Activa / cancela el modo de comprobación de LOS.
 * En modo LOS: el siguiente clic en el mapa selecciona el hex origen,
 * el siguiente fija el destino y muestra el resultado.
 */
function _actionLOSCheck() {
    if (_losCheckMode) {
        _cancelLOSCheck();
        _setStatus('▶ Comprobación de LOS cancelada.', 'ok');
        return;
    }
    _losCheckMode  = true;
    _losOriginHex  = null;
    HexMap.clearHighlights();
    HexMap.clearLOS();
    const btn = document.getElementById('btn-los-check');
    if (btn) btn.textContent = '✖ CANCELAR LOS';
    _setStatus('▶ COMPROBAR LOS: Haz clic en el hex ORIGEN', 'working');
}

/** Maneja los clics de mapa cuando _losCheckMode === true. */
function _handleLOSCheck(coord) {
    if (!coord) return;

    if (!_losOriginHex) {
        // Primer clic → origen
        _losOriginHex = coord;
        HexMap.setHighlights({ [coord]: ['hl-selected'] });
        _setStatus(`▶ COMPROBAR LOS: Origen = ${coord} — Haz clic en el hex DESTINO`, 'working');
        return;
    }

    // Segundo clic → calcular y mostrar LOS
    const from = _losOriginHex;
    const to   = coord;
    _cancelLOSCheck();   // reset mode & button label

    if (from === to) {
        _setStatus('▶ Origen y destino son el mismo hex.', 'ok');
        return;
    }

    const result = Engine.calcLOS(GS.mapa, from, to);

    // Resaltar hexes del trayecto
    const hlMap = {};
    hlMap[from] = ['hl-selected'];
    hlMap[to]   = ['hl-selected'];
    for (const h of result.hexes) {
        if (h !== from && h !== to) {
            hlMap[h] = [result.visible ? 'hl-los' : 'hl-enemy'];
        }
    }
    HexMap.setHighlights(hlMap);
    HexMap.drawLOS(from, to);

    const visStr  = result.visible ? '✅ LOS LIBRE' : '🔴 LOS BLOQUEADA';
    const hindStr = result.hindrance > 0 ? ` · obstáculos: −${result.hindrance} FP` : '';
    const msg     = `▶ LOS ${from}→${to}: ${visStr}${hindStr}`;
    log(msg);
    _setStatus(msg, result.visible ? 'ok' : 'warning');
}

/** Cancela el modo LOS y limpia el estado. */
function _cancelLOSCheck() {
    _losCheckMode = false;
    _losOriginHex = null;
    HexMap.clearLOS();
    HexMap.clearHighlights();
    const btn = document.getElementById('btn-los-check');
    if (btn) btn.textContent = '👁 COMPROBAR LOS';
}

// ────────────────────────────────────────────────────────────────────────────
// Exportar funciones accesibles desde el HTML
// ────────────────────────────────────────────────────────────────────────────

window.App = {
    startGame:       _startGame,
    selectFaction:   _selectFaction,
    rollDice:        _rollDice,
    actionMover:     _actionMover,
    actionDisparar:  _actionDisparar,
    actionFuegoComb: _actionFuegoCombinado,
    actionOpFire:    _actionOpFire,
    actionFinSeq:    _actionFinSequencia,
    actionPasar:     _actionPasar,
    actionCP:        _actionGastarCP,
    actionTirarHumo:    _actionTirarHumo,
    actionBomardeo:     _actionBomardeo,
    actionLOSCheck:     _actionLOSCheck,
    declineMCReroll:    _declineMCReroll,
    declineCPFinalOpFire: _declineCPFinalOpFire,
};
