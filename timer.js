/**
 * KNOCK — Módulo de Controle de Tempo de Comunicados
 * timer.js — integrado ao sistema existente sem alterar a base
 *
 * ARQUITETURA DE INTEGRAÇÃO:
 * - Arquivo separado, carregado após script.js no index.html
 * - Não modifica nenhuma variável global existente
 * - Hook points: NOC_TIMER.onIncidentCreated(), NOC_TIMER.onIncidentResolved()
 *   são chamados pelos patches em script.js (2 linhas adicionadas)
 * - Persiste estado via localStorage (chave: 'noc_timers')
 * - Usa Date.now() para precisão mesmo com aba em background (Page Visibility API)
 * - AudioContext gerado sob demanda (evita bloqueio de autoplay)
 */

const NOC_TIMER = (() => {

  // ─────────────────────────────────────────
  // CONFIGURAÇÃO (editável futuramente)
  // ─────────────────────────────────────────
  const CONFIG = {
    // Horário comercial: 08h–18h segunda a sexta
    comercial: { inicio: 8, fim: 18, diasUteis: [1,2,3,4,5] },
    // Tempo (ms) para primeiro comunicado
    primeiroComunicado: {
      comercial:     15 * 60 * 1000,   // 15 min
      foraCom:       30 * 60 * 1000,   // 30 min
    },
    // Tempo (ms) para atualizações subsequentes
    cicloAtualizacao:   60 * 60 * 1000, // 60 min
    // Alertas antecipados
    alertaAmarelo:       5 * 60 * 1000,  // 5 min restantes → visual amarelo
    alertaVermelho:      1 * 60 * 1000,  // 1 min restante  → som
    // Tick do intervalo interno
    tickMs: 1000,
  };

  // ─────────────────────────────────────────
  // ESTADO INTERNO
  // ─────────────────────────────────────────
  let timers        = {};   // { [incidentId]: TimerState }
  let tickInterval  = null;
  let audioCtx      = null;
  let modalAtivo    = null; // id do incidente com modal aberto

  // TimerState = {
  //   incidentId,        // string
  //   titulo,            // string  — problema do incidente
  //   fase,              // 'primeiro' | 'atualizacao'
  //   deadline,          // Date.now() ms — quando o timer zera
  //   ciclo,             // número do ciclo atual (0 = primeiro comunicado)
  //   historico,         // [{ acao, datahora }]
  //   encerrado,         // boolean
  //   soado1min,         // boolean — evita disparar o som múltiplas vezes
  //   modalShown,        // boolean — modal já aberto para este vencimento
  // }

  // ─────────────────────────────────────────
  // PERSISTÊNCIA
  // ─────────────────────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem('noc_timers');
      timers = raw ? JSON.parse(raw) : {};

      // Purga timers órfãos: incidente foi deletado mas timer persiste
      const storedInc = localStorage.getItem('noc_incidents');
      const existingIds  = new Set();
      const resolvedIds  = new Set();
      if (storedInc) {
        try {
          JSON.parse(storedInc).forEach(i => {
            existingIds.add(i.id);
            if (i.status === 'resolvido') resolvedIds.add(i.id);
          });
        } catch(e) {}
      }

      let dirty = false;
      Object.keys(timers).forEach(id => {
        // Remove se incidente não existe mais no localStorage
        if (existingIds.size > 0 && !existingIds.has(id)) {
          delete timers[id];
          dirty = true;
          return;
        }
        // Encerra automaticamente timers de incidentes já resolvidos
        if (resolvedIds.has(id) && timers[id] && !timers[id].encerrado) {
          timers[id].encerrado = true;
          dirty = true;
        }
      });

      if (dirty) save();
    } catch(e) { timers = {}; }
  }

  function save() {
    localStorage.setItem('noc_timers', JSON.stringify(timers));
  }

  // ─────────────────────────────────────────
  // LÓGICA DE HORÁRIO COMERCIAL
  // ─────────────────────────────────────────
  function isHorarioComercial(date) {
    const d   = date || new Date();
    const dia = d.getDay();   // 0=dom, 6=sab
    const h   = d.getHours();
    return CONFIG.comercial.diasUteis.includes(dia)
      && h >= CONFIG.comercial.inicio
      && h <  CONFIG.comercial.fim;
  }

  function getPrimeiroComunicadoMs() {
    return isHorarioComercial()
      ? CONFIG.primeiroComunicado.comercial
      : CONFIG.primeiroComunicado.foraCom;
  }

  // ─────────────────────────────────────────
  // CRIAR / INICIAR TIMER
  // ─────────────────────────────────────────
  function startTimer(incidentId, titulo) {
    if (timers[incidentId] && !timers[incidentId].encerrado) return; // já existe

    const duracao = getPrimeiroComunicadoMs();
    timers[incidentId] = {
      incidentId,
      titulo: titulo || incidentId,
      fase:     'primeiro',
      deadline: Date.now() + duracao,
      ciclo:    0,
      historico: [{ acao: 'Incidente iniciado', datahora: new Date().toISOString() }],
      encerrado:  false,
      soado1min:  false,
      modalShown: false,
    };
    save();
    ensureTick();
    renderTimerBadge(incidentId);
  }

  // ─────────────────────────────────────────
  // COMUNICADO REALIZADO
  // ─────────────────────────────────────────
  function comunicadoRealizado(incidentId) {
    const t = timers[incidentId];
    if (!t || t.encerrado) return;

    t.fase      = 'atualizacao';
    t.ciclo    += 1;
    t.deadline  = Date.now() + CONFIG.cicloAtualizacao;
    t.soado1min = false;
    t.modalShown= false;
    t.historico.push({ acao: `Comunicado #${t.ciclo} realizado`, datahora: new Date().toISOString() });

    save();
    closeUrgentModal(incidentId);
    renderTimerBadge(incidentId);
    showToast(`⏱ Timer reiniciado — próxima atualização em 60 min`, 'success');
  }

  // ─────────────────────────────────────────
  // ENCERRAR INCIDENTE
  // ─────────────────────────────────────────
  function encerrarIncidente(incidentId) {
    const t = timers[incidentId];
    if (!t) return;

    t.encerrado = true;
    t.historico.push({ acao: 'Incidente encerrado', datahora: new Date().toISOString() });
    save();
    closeUrgentModal(incidentId);
    removeTimerBadge(incidentId);

    // Para o tick se não há mais timers ativos
    const ativos = Object.values(timers).filter(x => !x.encerrado);
    if (!ativos.length) stopTick();
  }

  // ─────────────────────────────────────────
  // TICK — coração do módulo
  // ─────────────────────────────────────────
  function ensureTick() {
    if (tickInterval) return;
    tickInterval = setInterval(tick, CONFIG.tickMs);
  }

  function stopTick() {
    clearInterval(tickInterval);
    tickInterval = null;
  }

  function tick() {
    const now     = Date.now();
    let hasActive = false;

    Object.values(timers).forEach(t => {
      if (t.encerrado) return;
      hasActive = true;

      const restante = t.deadline - now;

      // Alerta sonoro: 1 min restante (dispara 1x por ciclo)
      if (restante <= CONFIG.alertaVermelho && restante > 0 && !t.soado1min) {
        t.soado1min = true;
        save();
        playBeep();
      }

      // Modal de urgência: timer zerou
      if (restante <= 0 && !t.modalShown) {
        t.modalShown = true;
        save();
        showUrgentModal(t);
      }

      // Atualiza o badge visual no card
      renderTimerBadge(t.incidentId);
    });

    if (!hasActive) stopTick();
  }

  // ─────────────────────────────────────────
  // ESTADO VISUAL DO TIMER
  // ─────────────────────────────────────────
  function getTimerState(t) {
    if (t.encerrado) return { label: 'Encerrado', cls: 'timer-encerrado', restante: 0 };
    const restante = t.deadline - Date.now();
    if (restante <= 0) {
      const labelBase = t.fase === 'primeiro' ? 'Comunicado atrasado' : 'Atualização atrasada';
      return { label: labelBase, cls: 'timer-atrasado', restante };
    }
    if (restante <= CONFIG.alertaVermelho) {
      return { label: 'Comunicado urgente!', cls: 'timer-critico', restante };
    }
    if (restante <= CONFIG.alertaAmarelo) {
      const labelBase = t.fase === 'primeiro' ? 'Subir comunicado' : 'Atualização necessária';
      return { label: labelBase, cls: 'timer-alerta', restante };
    }
    const labelBase = t.fase === 'primeiro' ? 'Aguardando comunicado' : 'Atualização necessária';
    return { label: labelBase, cls: 'timer-normal', restante };
  }

  function formatRestante(ms) {
    if (ms <= 0) {
      const abs = Math.abs(ms);
      const mm  = Math.floor(abs / 60000);
      const ss  = Math.floor((abs % 60000) / 1000);
      return `+${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    }
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    return `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  }

  // ─────────────────────────────────────────
  // RENDERIZAR BADGE NO CARD
  // ─────────────────────────────────────────
  function renderTimerBadge(incidentId) {
    const t = timers[incidentId];
    if (!t) return;

    // Encontra todos os elementos timer-widget com esse id (pode haver múltiplos no DOM)
    document.querySelectorAll(`.timer-widget[data-inc="${incidentId}"]`).forEach(widget => {
      const state = getTimerState(t);
      widget.className = `timer-widget ${state.cls}`;
      widget.querySelector('.timer-label').textContent  = state.label;
      widget.querySelector('.timer-count').textContent  = t.encerrado ? '—' : formatRestante(state.restante);
      widget.querySelector('.timer-cicle').textContent  =
        t.encerrado ? '' : (t.ciclo > 0 ? `Ciclo ${t.ciclo}` : isHorarioComercial() ? '⏱ Comercial' : '⏱ Fora comercial');
    });
  }

  function removeTimerBadge(incidentId) {
    document.querySelectorAll(`.timer-widget[data-inc="${incidentId}"]`).forEach(w => {
      w.className = 'timer-widget timer-encerrado';
      w.querySelector('.timer-label').textContent = 'Encerrado';
      w.querySelector('.timer-count').textContent = '—';
      w.querySelector('.timer-cicle').textContent = '';
    });
  }

  // ─────────────────────────────────────────
  // GERAR HTML DO WIDGET (chamado em renderIncCard)
  // ─────────────────────────────────────────
  function buildWidgetHTML(incidentId) {
    const t = timers[incidentId];

    // Incidente resolvido — sem timer
    const inc = (typeof incidents !== 'undefined') && incidents.find(i => i.id === incidentId);
    if (inc && inc.status === 'resolvido') {
      // Se havia timer ativo, encerra silenciosamente
      if (t && !t.encerrado) {
        t.encerrado = true;
        save();
      }
      return ''; // sem widget para incidentes resolvidos
    }

    if (!t || t.encerrado) {
      // Incidente em andamento mas sem timer — oferece botão para iniciar
      return `
        <div class="timer-widget timer-inativo" data-inc="${incidentId}">
          <div class="timer-body">
            <div class="timer-info">
              <span class="timer-label">Timer não iniciado</span>
              <span class="timer-cicle"></span>
            </div>
            <span class="timer-count">--:--</span>
          </div>
          <div class="timer-actions">
            <button class="btn-timer-start" data-id="${incidentId}" title="Iniciar controle de comunicado">▶ Iniciar timer</button>
          </div>
        </div>`;
    }

    const state = getTimerState(t);
    return `
      <div class="timer-widget ${state.cls}" data-inc="${incidentId}">
        <div class="timer-body">
          <div class="timer-info">
            <span class="timer-label">${state.label}</span>
            <span class="timer-cicle">${t.ciclo > 0 ? `Ciclo ${t.ciclo}` : isHorarioComercial() ? '⏱ Comercial' : '⏱ Fora comercial'}</span>
          </div>
          <span class="timer-count">${formatRestante(state.restante)}</span>
        </div>
        <div class="timer-actions">
          <button class="btn-timer-com" data-id="${incidentId}" title="Registrar comunicado realizado">✓ Comunicado</button>
          <button class="btn-timer-end" data-id="${incidentId}" title="Encerrar incidente">⊠ Encerrar</button>
          <button class="btn-timer-hist" data-id="${incidentId}" title="Ver histórico">📋</button>
        </div>
      </div>`;
  }

  // ─────────────────────────────────────────
  // LIGAR EVENTOS DOS WIDGETS (chamado após renderIncidentsList)
  // ─────────────────────────────────────────
  function bindWidgetEvents() {
    document.querySelectorAll('.btn-timer-start').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id  = btn.dataset.id;
        const inc = (typeof incidents !== 'undefined') && incidents.find(i => i.id === id);
        startTimer(id, inc ? inc.problema : id);
        // Re-render apenas o widget sem quebrar o card
        const widget = btn.closest('.timer-widget');
        if (widget) {
          widget.outerHTML = buildWidgetHTML(id);
          // Rebind (o widget foi substituído)
          bindWidgetEvents();
        }
      });
    });

    document.querySelectorAll('.btn-timer-com').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); comunicadoRealizado(btn.dataset.id); });
    });

    document.querySelectorAll('.btn-timer-end').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Confirma encerramento do controle de comunicado para este incidente?')) {
          encerrarIncidente(btn.dataset.id);
        }
      });
    });

    document.querySelectorAll('.btn-timer-hist').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); showHistorico(btn.dataset.id); });
    });
  }

  // ─────────────────────────────────────────
  // MODAL URGENTE (timer zerou)
  // ─────────────────────────────────────────
  function showUrgentModal(t) {
    if (modalAtivo === t.incidentId) return;
    modalAtivo = t.incidentId;

    // Remove modal anterior se existir
    const existing = document.getElementById('timer-urgent-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'timer-urgent-modal';
    overlay.className = 'modal-overlay timer-urgent-overlay';
    overlay.innerHTML = `
      <div class="modal-box modal-box-sm timer-urgent-box">
        <div class="timer-urgent-icon">📡</div>
        <div class="timer-urgent-title">Subir comunicado agora</div>
        <div class="timer-urgent-sub">${escapeHtmlLocal(t.titulo)}</div>
        <div class="timer-urgent-meta">
          ${t.fase === 'primeiro' ? 'Primeiro comunicado' : `Atualização — Ciclo ${t.ciclo + 1}`} · ${isHorarioComercial() ? 'Horário comercial' : 'Fora do horário comercial'}
        </div>
        <div class="timer-urgent-actions">
          <button class="btn btn-ack timer-urgent-btn-com" id="timer-urgent-com">✓ Comunicado realizado</button>
          <button class="btn btn-ghost timer-urgent-btn-snooze" id="timer-urgent-snooze">⏸ Adiar 5 min</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Pulsar até interação
    playBeep();
    const pulseInterval = setInterval(playBeep, 8000);

    document.getElementById('timer-urgent-com').addEventListener('click', () => {
      clearInterval(pulseInterval);
      comunicadoRealizado(t.incidentId);
    });

    document.getElementById('timer-urgent-snooze').addEventListener('click', () => {
      clearInterval(pulseInterval);
      snoozeTimer(t.incidentId, 5 * 60 * 1000);
      closeUrgentModal(t.incidentId);
      showToast('Timer adiado por 5 minutos.', 'info');
    });
  }

  function closeUrgentModal(incidentId) {
    const modal = document.getElementById('timer-urgent-modal');
    if (modal) { modal.style.opacity='0'; modal.style.transition='opacity 0.25s'; setTimeout(()=>modal.remove(), 250); }
    if (modalAtivo === incidentId) modalAtivo = null;
  }

  // Snooze: empurra o deadline em X ms
  function snoozeTimer(incidentId, ms) {
    const t = timers[incidentId];
    if (!t || t.encerrado) return;
    t.deadline   = Date.now() + ms;
    t.soado1min  = false;
    t.modalShown = false;
    t.historico.push({ acao: `Timer adiado 5 min`, datahora: new Date().toISOString() });
    save();
  }

  // ─────────────────────────────────────────
  // MODAL HISTÓRICO
  // ─────────────────────────────────────────
  function showHistorico(incidentId) {
    const t = timers[incidentId];
    if (!t) return;

    const existing = document.getElementById('timer-hist-modal');
    if (existing) existing.remove();

    const items = (t.historico || []).slice().reverse().map(h => `
      <div class="ack-history-item">
        <span class="ack-history-icon">·</span>
        <div class="ack-history-info">
          <span class="ack-name">${escapeHtmlLocal(h.acao)}</span>
        </div>
        <span class="ack-time">${formatDateLocal(h.datahora)}</span>
      </div>`).join('');

    const overlay = document.createElement('div');
    overlay.id        = 'timer-hist-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box modal-box-sm">
        <div class="modal-header">
          <div class="modal-title">📋 Histórico do timer — ${escapeHtmlLocal(t.incidentId)}</div>
          <button class="modal-close" id="timer-hist-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="ack-history" style="max-height:320px;overflow-y:auto">${items || '<span style="color:var(--text-dim)">Sem registros</span>'}</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="timer-hist-ok">Fechar</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    document.getElementById('timer-hist-close').addEventListener('click', () => overlay.remove());
    document.getElementById('timer-hist-ok').addEventListener('click',    () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ─────────────────────────────────────────
  // ÁUDIO — beep sintético via Web Audio API
  // ─────────────────────────────────────────
  function getAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    }
    return audioCtx;
  }

  function playBeep() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;

      // Sequência de 3 beeps curtos
      [0, 0.18, 0.36].forEach(offset => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type      = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0, ctx.currentTime + offset);
        gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + offset + 0.02);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + offset + 0.14);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.16);
      });
    } catch(e) { /* AudioContext pode ser bloqueado antes de gesto do usuário */ }
  }

  // ─────────────────────────────────────────
  // UTILITÁRIOS LOCAIS (não dependem do escopo global)
  // ─────────────────────────────────────────
  function escapeHtmlLocal(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDateLocal(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }

  // ─────────────────────────────────────────
  // INICIALIZAÇÃO DO MÓDULO
  // ─────────────────────────────────────────
  function init() {
    load();

    // Retoma ticks para timers ativos que sobreviveram ao reload
    const ativos = Object.values(timers).filter(t => !t.encerrado);
    if (ativos.length) ensureTick();

    // Page Visibility API — pausa visual quando aba fica invisível
    // O deadline continua correndo via Date.now(); ao voltar, tick dispara imediatamente
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // Força checagem imediata ao retornar à aba
        tick();
      }
    });

    // Expõe referência para debug no console
    window.__NOC_TIMER_STATE__ = () => timers;
  }

  // ─────────────────────────────────────────
  // API PÚBLICA
  // ─────────────────────────────────────────
  return {
    init,
    startTimer,
    comunicadoRealizado,
    encerrarIncidente,
    buildWidgetHTML,
    bindWidgetEvents,
    isHorarioComercial,
    getConfig: () => ({ ...CONFIG }),
    // Futuro: setConfig(partial) para customização de tempos via UI
  };

})();

// Inicia o módulo quando o DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => NOC_TIMER.init());
} else {
  NOC_TIMER.init();
}
