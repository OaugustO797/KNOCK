/**
 * KNOCK — Módulo de Backup & Restauração (OneDrive)
 * sync.js — exportação/importação de dados via arquivos JSON
 *
 * INTEGRAÇÃO:
 * - Arquivo separado, carregado após script.js e timer.js
 * - Lê dados via variáveis globais: incidents, alerts (de script.js)
 *   e localStorage 'noc_timers' (de timer.js)
 * - Não modifica nenhuma lógica existente
 * - API pública: NOC_SYNC.openPanel()
 */

const NOC_SYNC = (() => {

  // ─────────────────────────────────────────
  // ESTADO
  // ─────────────────────────────────────────
  let importPayload  = null;   // dados parseados do arquivo selecionado
  let mergeMode      = 'merge'; // 'merge' | 'replace'
  let lastBackupMeta = null;   // { date, mode, counts } — persiste em localStorage

  const LS_BACKUP_META  = 'noc_last_backup';
  const LS_AUTO_EXPORT  = 'noc_auto_export';

  // ─────────────────────────────────────────
  // INICIALIZAÇÃO
  // ─────────────────────────────────────────
  function init() {
    loadMeta();
    bindEvents();
    handleBeforeUnload();
  }

  function loadMeta() {
    try {
      const raw = localStorage.getItem(LS_BACKUP_META);
      lastBackupMeta = raw ? JSON.parse(raw) : null;
    } catch(e) { lastBackupMeta = null; }
  }

  function saveMeta(meta) {
    lastBackupMeta = meta;
    localStorage.setItem(LS_BACKUP_META, JSON.stringify(meta));
  }

  // ─────────────────────────────────────────
  // ABRIR / FECHAR PAINEL
  // ─────────────────────────────────────────
  function openPanel() {
    resetImportArea();
    refreshSummary();
    refreshStatus();
    document.getElementById('sync-modal-overlay').style.display = 'flex';
    document.getElementById('sync-auto-export').checked =
      localStorage.getItem(LS_AUTO_EXPORT) === '1';
  }

  function closePanel() {
    document.getElementById('sync-modal-overlay').style.display = 'none';
    importPayload = null;
  }

  // ─────────────────────────────────────────
  // RESUMO DOS DADOS ATUAIS
  // ─────────────────────────────────────────
  function refreshSummary() {
    const inc     = getIncidents();
    const alts    = getAlerts();
    const timers  = getTimers();
    const ativos  = Object.values(timers).filter(t => !t.encerrado).length;

    document.getElementById('sync-count-inc').textContent    = inc.length;
    document.getElementById('sync-count-alerts').textContent = alts.length;
    document.getElementById('sync-count-timers').textContent = ativos;
    document.getElementById('sync-last-date').textContent    =
      lastBackupMeta ? formatDate(lastBackupMeta.date) : '—';
  }

  function refreshStatus() {
    const icon  = document.getElementById('sync-status-icon');
    const label = document.getElementById('sync-status-label');
    const sub   = document.getElementById('sync-status-sub');

    if (!lastBackupMeta) {
      icon.textContent  = '💾';
      label.textContent = 'Nenhum backup realizado nesta sessão';
      sub.textContent   = 'Exporte os dados para salvar no OneDrive';
      document.getElementById('sync-status-bar').className = 'sync-status-bar';
      return;
    }

    const dt = new Date(lastBackupMeta.date);
    const agoMs = Date.now() - dt.getTime();
    const agoMin = Math.floor(agoMs / 60000);
    const agoStr = agoMin < 1 ? 'agora mesmo'
                 : agoMin < 60 ? `há ${agoMin} min`
                 : `às ${dt.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}`;

    icon.textContent  = '✅';
    label.textContent = `Último backup: ${lastBackupMeta.modeLabel} — ${agoStr}`;
    sub.textContent   = `${lastBackupMeta.counts.inc} incidentes · ${lastBackupMeta.counts.alerts} avisos · arquivo: ${lastBackupMeta.filename}`;
    document.getElementById('sync-status-bar').className = 'sync-status-bar sync-status-ok';
  }

  // ─────────────────────────────────────────
  // ACESSO AOS DADOS GLOBAIS
  // ─────────────────────────────────────────
  function getIncidents() {
    // Lê do localStorage (fonte canônica — mantido por script.js)
    try { return JSON.parse(localStorage.getItem('noc_incidents') || '[]'); } catch(e) { return []; }
  }

  function getAlerts() {
    try { return JSON.parse(localStorage.getItem('noc_alerts') || '[]'); } catch(e) { return []; }
  }

  function getTimers() {
    try { return JSON.parse(localStorage.getItem('noc_timers') || '{}'); } catch(e) { return {}; }
  }

  // ─────────────────────────────────────────
  // EXPORTAÇÃO
  // ─────────────────────────────────────────
  function exportData(mode) {
    const inc    = getIncidents();
    const alts   = getAlerts();
    const timers = getTimers();
    const now    = new Date();
    const dateStr = now.toISOString().slice(0,10); // YYYY-MM-DD
    const tsStr   = now.toISOString().replace(/[:.]/g,'-').slice(0,19);

    let payload, filename, modeLabel;

    switch (mode) {
      case 'incidents':
        payload   = buildPayload({ incidents: inc });
        filename  = `knock_incidents_${dateStr}.json`;
        modeLabel = 'Somente incidentes';
        break;
      case 'alerts':
        payload   = buildPayload({ alerts: alts });
        filename  = `knock_alerts_${dateStr}.json`;
        modeLabel = 'Somente avisos';
        break;
      case 'full':
      default:
        payload   = buildPayload({ incidents: inc, alerts: alts, timers,
                                   known_alerts: (typeof NOC_KA !== 'undefined') ? NOC_KA.getData() : [] });
        filename  = `knock_backup_${dateStr}_${tsStr.slice(11)}.json`;
        modeLabel = 'Backup completo';
        break;
    }

    downloadJSON(payload, filename);

    // Atualiza meta de último backup
    saveMeta({
      date:      now.toISOString(),
      mode,
      modeLabel,
      filename,
      counts: {
        inc:    mode === 'alerts'    ? 0 : inc.length,
        alerts: mode === 'incidents' ? 0 : alts.length,
      }
    });

    refreshStatus();
    refreshSummary();

    showToastGlobal(`✅ ${modeLabel} exportado — salve na pasta KNOCK do OneDrive`, 'success');
  }

  function buildPayload(data) {
    return {
      _knock_backup: true,
      _version:    '1.0',
      _exported:   new Date().toISOString(),
      _app:        'KNOCK — Knowledge Network Operations Center Kernel',
      ...data
    };
  }

  function downloadJSON(payload, filename) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ─────────────────────────────────────────
  // IMPORTAÇÃO — seleção de arquivo
  // ─────────────────────────────────────────
  function handleFileSelect(file) {
    if (!file || !file.name.endsWith('.json')) {
      showToastGlobal('Selecione um arquivo .json válido.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        validateAndPreview(data, file.name);
      } catch(err) {
        showToastGlobal('Arquivo inválido — não é um JSON válido.', 'error');
        resetImportArea();
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  function validateAndPreview(data, filename) {
    // Valida estrutura básica
    if (!data._noc_backup) {
      showToastGlobal('Arquivo não reconhecido — use apenas arquivos exportados pelo KNOCK.', 'error');
      return;
    }

    importPayload = data;

    // Monta preview
    const counts = [];
    if (data.incidents) counts.push(`<span class="sync-prev-count"><strong>${data.incidents.length}</strong> incidentes</span>`);
    if (data.alerts)    counts.push(`<span class="sync-prev-count"><strong>${data.alerts.length}</strong> avisos</span>`);
    if (data.timers)    counts.push(`<span class="sync-prev-count"><strong>${Object.keys(data.timers).length}</strong> timers</span>`);

    const exportedDate = data._exported
      ? new Date(data._exported).toLocaleString('pt-BR')
      : 'data desconhecida';

    document.getElementById('sync-preview-name').textContent = filename;
    document.getElementById('sync-preview-meta').textContent = `Exportado em ${exportedDate} · v${data._version || '?'}`;
    document.getElementById('sync-preview-counts').innerHTML = counts.join('');

    // Mostra preview, esconde dropzone
    document.getElementById('sync-import-area').style.display    = 'none';
    document.getElementById('sync-import-preview').style.display = 'block';
  }

  function resetImportArea() {
    importPayload = null;
    document.getElementById('sync-import-area').style.display    = 'block';
    document.getElementById('sync-import-preview').style.display = 'none';
    document.getElementById('sync-file-input').value = '';

    // Reset merge mode
    mergeMode = 'merge';
    document.querySelectorAll('.sync-merge-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('sync-merge-merge').classList.add('active');
  }

  // ─────────────────────────────────────────
  // IMPORTAÇÃO — executar
  // ─────────────────────────────────────────
  function doImport() {
    if (!importPayload) { showToastGlobal('Nenhum arquivo selecionado.', 'error'); return; }

    const data    = importPayload;
    const replace = mergeMode === 'replace';

    let msgs = [];

    // Importar incidentes
    if (data.incidents && Array.isArray(data.incidents)) {
      const current = replace ? [] : getIncidents();
      const merged  = mergeById(current, data.incidents);
      localStorage.setItem('noc_incidents', JSON.stringify(merged));
      msgs.push(`${data.incidents.length} incidentes`);

      if (typeof incidents !== 'undefined') {
        incidents.length = 0;
        merged.forEach(i => incidents.push(i));
      }
    }

    // Importar avisos
    if (data.alerts && Array.isArray(data.alerts)) {
      const current = replace ? [] : getAlerts();
      const merged  = mergeById(current, data.alerts);
      localStorage.setItem('noc_alerts', JSON.stringify(merged));
      msgs.push(`${data.alerts.length} avisos`);

      if (typeof alerts !== 'undefined') {
        alerts.length = 0;
        merged.forEach(a => alerts.push(a));
      }
    }

    // Importar timers
    if (data.timers && typeof data.timers === 'object') {
      const current = replace ? {} : getTimers();
      const merged  = { ...current, ...data.timers };
      localStorage.setItem('noc_timers', JSON.stringify(merged));
      msgs.push(`${Object.keys(data.timers).length} timers`);
    }

    // Importar alertas conhecidos
    if (data.known_alerts && Array.isArray(data.known_alerts)) {
      if (typeof NOC_KA !== 'undefined') {
        const current = replace ? [] : NOC_KA.getData();
        const merged  = mergeById(current, data.known_alerts);
        NOC_KA.setData(merged);
        msgs.push(`${data.known_alerts.length} alertas conhecidos`);
      }
    }

    // Atualiza a UI global
    if (typeof refreshAll === 'function') refreshAll();
    else if (typeof updateStats === 'function') { updateStats(); renderIncidentsList && renderIncidentsList(); }

    closePanel();
    showToastGlobal(`✅ Importado: ${msgs.join(', ')} — sincronizando com banco...`, 'success');

    // ── SINCRONIZAÇÃO DIRETA COM SUPABASE ──────────────────
    // Envia os dados importados para o Supabase imediatamente,
    // sem depender do interceptor do auth.js
    if (typeof KNOCK_DB !== 'undefined' && KNOCK_DB.isOnline()) {
      syncImportToSupabase(data, replace).then(ok => {
        if (ok) {
          showToastGlobal('☁ Dados salvos no banco com sucesso!', 'success');
        } else {
          showToastGlobal('⚠ Dados locais OK — falha ao salvar no banco. Tente sincronizar mais tarde.', 'info');
        }
      });
    }

    // Atualiza meta
    saveMeta({
      date:      new Date().toISOString(),
      mode:      'import',
      modeLabel: 'Restauração',
      filename:  document.getElementById('sync-preview-name').textContent,
      counts:    { inc: data.incidents?.length || 0, alerts: data.alerts?.length || 0 }
    });
  }

  // Sincroniza os dados importados direto no Supabase
  async function syncImportToSupabase(data, replace) {
    try {
      const promises = [];

      // Incidentes
      if (data.incidents?.length) {
        for (const inc of data.incidents) {
          promises.push(KNOCK_DB.incidents.upsert(inc));
        }
      }

      // Avisos
      if (data.alerts?.length) {
        for (const al of data.alerts) {
          promises.push(KNOCK_DB.alerts.upsert(al));
        }
      }

      // Alertas conhecidos
      if (data.known_alerts?.length) {
        for (const ka of data.known_alerts) {
          promises.push(KNOCK_DB.knownAlerts.upsert(ka));
        }
      }

      // Executa todos em paralelo
      await Promise.all(promises);
      console.log('[KNOCK] Import → Supabase OK');
      return true;
    } catch(e) {
      console.warn('[KNOCK] Import → Supabase falhou:', e.message);
      return false;
    }
  }

  // Mescla dois arrays pelo campo 'id' — sem duplicatas
  function mergeById(existing, incoming) {
    const map = {};
    existing.forEach(item => { if (item.id) map[item.id] = item; });
    incoming.forEach(item => {
      if (item.id) {
        // Mantém o mais recente pelo campo datahora se houver conflito
        if (!map[item.id]) {
          map[item.id] = item;
        } else {
          const existDate = new Date(map[item.id].datahora || 0);
          const newDate   = new Date(item.datahora || 0);
          if (newDate > existDate) map[item.id] = item;
        }
      }
    });
    return Object.values(map);
  }

  // ─────────────────────────────────────────
  // AVISO AO SAIR DA PÁGINA (beforeunload)
  // ─────────────────────────────────────────
  function handleBeforeUnload() {
    window.addEventListener('beforeunload', (e) => {
      const autoExport = localStorage.getItem(LS_AUTO_EXPORT) === '1';
      if (!autoExport) return;

      // Faz export silencioso ao sair (dispara download)
      const inc   = getIncidents();
      const alts  = getAlerts();
      const timers= getTimers();
      const now   = new Date();
      const payload = buildPayload({ incidents: inc, alerts: alts, timers });
      const filename = `noc_backup_autosave_${now.toISOString().slice(0,10)}.json`;
      downloadJSON(payload, filename);
    });
  }

  // ─────────────────────────────────────────
  // BIND EVENTOS DO MODAL
  // ─────────────────────────────────────────
  function bindEvents() {
    // Fechar modal
    document.getElementById('sync-modal-close').addEventListener('click', closePanel);
    document.getElementById('sync-btn-close').addEventListener('click',   closePanel);
    document.getElementById('sync-modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closePanel();
    });

    // Botões de exportar
    document.querySelectorAll('.sync-btn-export').forEach(btn => {
      btn.addEventListener('click', () => exportData(btn.dataset.mode));
    });

    // Input de arquivo
    const fileInput = document.getElementById('sync-file-input');
    document.getElementById('sync-drop-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) handleFileSelect(e.target.files[0]);
    });

    // Drag and drop
    const dropzone = document.getElementById('sync-dropzone');
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    });

    // Limpar preview
    document.getElementById('sync-preview-clear').addEventListener('click', resetImportArea);

    // Modos de merge
    document.querySelectorAll('.sync-merge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        mergeMode = btn.dataset.merge;
        document.querySelectorAll('.sync-merge-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Executar importação
    document.getElementById('sync-btn-do-import').addEventListener('click', doImport);

    // Auto-export toggle
    document.getElementById('sync-auto-export').addEventListener('change', (e) => {
      localStorage.setItem(LS_AUTO_EXPORT, e.target.checked ? '1' : '0');
    });
  }

  // ─────────────────────────────────────────
  // UTILITÁRIO — toast global
  // ─────────────────────────────────────────
  function showToastGlobal(msg, type) {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    // Fallback se showToast não estiver disponível
    const c = document.getElementById('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span class="toast-msg">${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', {
      day:'2-digit', month:'2-digit', year:'numeric',
      hour:'2-digit', minute:'2-digit'
    });
  }

  // ─────────────────────────────────────────
  // API PÚBLICA
  // ─────────────────────────────────────────
  return { init, openPanel, exportData };

})();

// Inicializa quando DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => NOC_SYNC.init());
} else {
  NOC_SYNC.init();
}
