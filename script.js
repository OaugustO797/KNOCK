/**
 * KNOCK — Knowledge Network Operations Center Kernel + Dashboard de Avisos
 * script.js — lógica completa
 */

// =============================================
// ESTADO GLOBAL — INCIDENTES
// =============================================
let incidents = [];
let currentTags = [];
let activeFilterStatus = 'all';
let activeFilterTool   = 'all';
let activeFilterField  = 'all';
let lastSearchQuery    = '';
let editingId          = null;

// =============================================
// ESTADO GLOBAL — AVISOS
// =============================================
let alerts = [];
let alertCurrentTags   = [];
let alertEditingId     = null;
let ackPendingAlertId  = null;

// Filtros de avisos
let alertFilterType = 'all';
let alertFilterAck  = 'all';
let alertFilterSev  = 'all';

// =============================================
// FERRAMENTAS
// =============================================
const TOOLS = [
  'Zabbix','Grafana','Nagios','Datadog','SolarWinds',
  'PRTG','Veeam','Prometheus','Splunk','ELK',
  'Dynatrace','New Relic','Oracle','PagerDuty','OpsGenie','Outro'
];

// =============================================
// BASE DE CONHECIMENTO — SUGESTÕES
// =============================================
const KNOWLEDGE_BASE = [
  { keywords: ['latência','lento','lentidão','ping','delay','timeout','devagar'], suggestion: 'Casos similares sugerem: verificar saturação de link (uso ≥ 90%), checar tabelas de roteamento, analisar QoS ativo e possíveis loops de rede (STP). Confirmar se o problema é pontual ou afeta múltiplos segmentos.', relatedActions: ['BGP tuning','QoS reconfiguração','Verificar BPDU Guard'] },
  { keywords: ['queda','offline','down','inacessível','indisponível','fora do ar'], suggestion: 'Histórico indica: confirmar alimentação física do equipamento, verificar interfaces no switch upstream, checar logs de syslog por erros recentes.', relatedActions: ['Failover manual','Rota alternativa','Reinicialização controlada'] },
  { keywords: ['cpu','processamento','carga','load','sobrecarregado'], suggestion: 'Padrões anteriores apontam: identificar processo top consumer (top/htop), verificar se há queries SQL sem índice, checar cron jobs conflitantes.', relatedActions: ['Kill de processo','Otimização de query SQL','Escalonamento de recursos'] },
  { keywords: ['memória','ram','oom','swap','memory','heap'], suggestion: 'Incidentes similares indicam: verificar OOM Killer nos logs (/var/log/messages), ajustar parâmetros vm.swappiness, revisar configurações de heap.', relatedActions: ['Ajuste vm.swappiness','Restart de serviço','Expansão de memória'] },
  { keywords: ['disco','storage','espaço','disk','cheio','100%','full'], suggestion: 'Registros históricos indicam: executar df -h e du -sh /* para localizar consumo, verificar logs rotativos, checar /tmp e /var/log.', relatedActions: ['Limpeza de logs','Purge de backups antigos','Expansão de volume'] },
  { keywords: ['banco','database','sql','postgres','mysql','oracle','connection'], suggestion: 'Análise de casos anteriores: verificar conexões ativas vs max_connections, checar long running queries, analisar lock de tabelas.', relatedActions: ['Kill de sessões bloqueadas','Ajuste de max_connections','Restart controlado do BD'] },
  { keywords: ['certificado','ssl','tls','https','expirado','expired'], suggestion: 'Padrão identificado: validar expiração com openssl s_client, checar renovação automática via certbot/ACME.', relatedActions: ['Renovação via certbot','Atualização manual do cert','Teste com openssl'] },
  { keywords: ['firewall','acl','bloqueado','regra','policy','iptables'], suggestion: 'Histórico aponta: verificar logs do firewall para regra de negação, checar se houve atualização de firmware recente.', relatedActions: ['Review de ACL','Rollback de firmware','Restauração de backup de config'] },
  { keywords: ['vpn','tunnel','ipsec','openvpn','autenticação','remoto'], suggestion: 'Casos similares: verificar validade de certificados VPN, checar logs de autenticação (auth.log), confirmar servidor RADIUS acessível.', relatedActions: ['Renovação de cert VPN','Restart do daemon VPN','Verificação do RADIUS'] },
  { keywords: ['backup','veeam','job','falha','agendamento','snapshot'], suggestion: 'Registros indicam: verificar espaço no storage de destino, checar permissões da conta de serviço, analisar logs do job.', relatedActions: ['Limpeza do storage','Ajuste de permissões','Backup manual de emergência'] },
  { keywords: ['switch','stp','spanning','loop','flap','broadcast','storm'], suggestion: 'Padrão clássico: ativar captura PCAP para identificar storm, verificar port statistics, isolar segmento suspeito.', relatedActions: ['Isolamento de porta','Habilitar BPDU Guard','Verificar port-statistics'] },
  { keywords: ['email','e-mail','smtp','exchange','correio','fila'], suggestion: 'Análise histórica: verificar fila de mensagens (mailq), checar espaço em disco, confirmar que relays não estão em blacklist.', relatedActions: ['Flush de fila','Verificação de blacklist','Teste SMTP via telnet'] }
];

// =============================================
// INICIALIZAÇÃO
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  initHomePage();
  initTabs();
  initForm();
  initSearchPanel();
  initClock();
  initDashboard();
});

// =============================================
// PERSISTÊNCIA
// =============================================
async function loadData() {
  // Incidentes
  const storedInc = localStorage.getItem('noc_incidents');
  if (storedInc) { try { incidents = JSON.parse(storedInc); } catch(e) { incidents = []; } }
  if (incidents.length === 0) {
    try {
      const r = await fetch('data.json');
      if (r.ok) { incidents = await r.json(); saveIncidents(); }
    } catch(e) { incidents = []; }
  }

  // Avisos
  const storedAlerts = localStorage.getItem('noc_alerts');
  if (storedAlerts) {
    try { alerts = JSON.parse(storedAlerts); } catch(e) { alerts = []; }
  }

  // Se o Supabase estiver disponível, aguarda o sync antes de renderizar
  // Isso evita mostrar dados vazios enquanto o banco ainda não respondeu
  if (typeof KNOCK_DB !== 'undefined' && KNOCK_DB.isOnline()) {
    // Supabase já logado — o auth.js vai chamar refreshAll após o sync
    return;
  }

  // Sem Supabase (offline ou antes do login) — renderiza com dados locais
  refreshAll();
}

function saveIncidents() { localStorage.setItem('noc_incidents', JSON.stringify(incidents)); }
function saveAlerts()    { localStorage.setItem('noc_alerts', JSON.stringify(alerts)); }

function refreshAll() {
  updateFooterCount();
  updateStats();
  populateToolFilters();
  updateAlertBadges();
  document.getElementById('tab-count').textContent = incidents.length;
  renderIncidentsList();
  renderAlertsList();
}


// =============================================
// RELÓGIO
// =============================================
function initClock() {
  function update() {
    const now = new Date();
    const str = now.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const el1 = document.getElementById('home-clock');
    const el2 = document.getElementById('live-clock');
    if (el1) el1.textContent = str;
    if (el2) el2.textContent = str.split(' ')[1];
  }
  update(); setInterval(update, 1000);
}

// =============================================
// HOME
// =============================================
function initHomePage() {
  const input    = document.getElementById('home-input');
  const clearBtn = document.getElementById('home-clear-btn');
  const ac       = document.getElementById('home-autocomplete');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      q ? launchSearch(q, 'busca') : showAllResults();
    }
  });
  document.getElementById('btn-home-search').addEventListener('click', () => {
    const q = input.value.trim();
    q ? launchSearch(q, 'busca') : showAllResults();
  });
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.style.display = q ? 'flex' : 'none';
    renderAutocomplete(q);
  });
  clearBtn.addEventListener('click', () => { input.value=''; clearBtn.style.display='none'; hideAutocomplete(); input.focus(); });
  document.querySelectorAll('.quick-tag').forEach(btn => btn.addEventListener('click', () => launchSearch(btn.dataset.q, 'busca')));
  document.addEventListener('click', (e) => { if (!e.target.closest('.home-search-wrap')) hideAutocomplete(); });
}

function renderAutocomplete(query) {
  const ac = document.getElementById('home-autocomplete');
  if (!query || query.length < 2) { hideAutocomplete(); return; }
  const q = query.toLowerCase();

  // Coleta resultados de INCIDENTES
  const incMatches = [];
  incidents.forEach(inc => {
    const fields = [inc.problema, inc.causa, inc.sintoma];
    const hit = fields.some(f => f && f.toLowerCase().includes(q)) ||
                (inc.tags||[]).some(t => t.toLowerCase().includes(q));
    if (hit && incMatches.length < 3) {
      incMatches.push({ label: inc.problema, type: 'inc', dest: 'busca', q: inc.problema });
    }
  });

  // Coleta resultados de ALERTAS CONHECIDOS
  const kaMatches = [];
  const kaData = (typeof NOC_KA !== 'undefined') ? NOC_KA.getData() : [];
  kaData.forEach(ka => {
    const fields = [ka.nome, ka.causa, ka.descricao];
    const hit = fields.some(f => f && f.toLowerCase().includes(q)) ||
                (ka.tags||[]).some(t => t.toLowerCase().includes(q));
    if (hit && kaMatches.length < 3) {
      kaMatches.push({ label: ka.nome, type: 'ka', dest: 'alertas-conhecidos', q: ka.nome });
    }
  });

  const allMatches = [...incMatches, ...kaMatches];
  if (!allMatches.length) { hideAutocomplete(); return; }

  const typeIcon  = { inc: '📋', ka: '⚡' };
  const typeLabel = { inc: 'Incidente', ka: 'Alerta conhecido' };

  ac.innerHTML = allMatches.map(item => `
    <div class="autocomplete-item" data-q="${escapeHtml(item.q)}" data-dest="${item.dest}">
      <span class="autocomplete-icon">${typeIcon[item.type]}</span>
      <span class="autocomplete-text">${highlight(escapeHtml(item.label), query)}</span>
      <span class="autocomplete-type autocomplete-type-${item.type}">${typeLabel[item.type]}</span>
    </div>`).join('');

  ac.querySelectorAll('.autocomplete-item').forEach(el => {
    el.addEventListener('click', () => launchSearch(el.dataset.q, el.dataset.dest));
  });

  ac.classList.add('visible');
}

function hideAutocomplete() {
  const ac = document.getElementById('home-autocomplete');
  if (ac) ac.classList.remove('visible');
}

function launchSearch(query, dest) {
  hideAutocomplete();
  lastSearchQuery = query;

  // Se veio de alerta conhecido, vai direto para a aba de alertas com busca ativa
  if (dest === 'alertas-conhecidos') {
    document.getElementById('search-input').value = '';
    showAppScreen('alertas-conhecidos');
    // Dispara busca no módulo KA
    const kaInput = document.getElementById('ka-search-input');
    if (kaInput) {
      kaInput.value = query;
      kaInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  // Padrão: vai para aba de incidentes
  document.getElementById('search-input').value = query;
  showAppScreen('busca');
  performSearch();
}

function showAllResults() {
  lastSearchQuery = '';
  document.getElementById('search-input').value = '';
  showAppScreen('busca');
  renderIncidentsList();
}
function goToRegister()  { showAppScreen('cadastro'); }
function goToDashboard() { showAppScreen('dashboard'); }

function goHome() {
  document.getElementById('screen-app').style.display = 'none';
  document.getElementById('screen-home').style.display = 'flex';
  document.getElementById('screen-home').style.flexDirection = 'column';
  updateFooterCount();
  updateAlertBadges();
}

function showAppScreen(tab) {
  document.getElementById('screen-home').style.display = 'none';
  document.getElementById('screen-app').style.display = 'block';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const tabBtn = document.querySelector(`[data-tab="${tab}"]`);
  const panel  = document.getElementById(`panel-${tab}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (panel)  panel.classList.add('active');
  if (tab === 'dashboard') renderAlertsList();
}

function updateFooterCount() {
  const el = document.getElementById('home-footer-count');
  if (el) el.textContent = `${incidents.length} incidente(s) registrado(s)`;
  const ea = document.getElementById('home-footer-alerts');
  const unacked = alerts.filter(a => a.aberto && a.acks.length === 0).length;
  if (ea) ea.textContent = `${alerts.filter(a=>a.aberto).length} aviso(s) ativo(s)`;
}

// =============================================
// TABS
// =============================================
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const id = 'panel-' + btn.dataset.tab;
      document.getElementById(id).classList.add('active');
      if (btn.dataset.tab === 'dashboard') renderAlertsList();
    });
  });
}

// =============================================
// FORMULÁRIO INCIDENTES
// =============================================
function initForm() {
  const toolSelect = document.getElementById('ferramenta');
  TOOLS.forEach(t => { const o = document.createElement('option'); o.value=t; o.textContent=t; toolSelect.appendChild(o); });

  const tagInput    = document.getElementById('tag-input');
  const tagsWrapper = document.getElementById('tags-wrapper');
  tagInput.addEventListener('keydown', (e) => {
    if (['Enter',',',' '].includes(e.key)) {
      e.preventDefault();
      const val = tagInput.value.trim().replace(/,/g,'');
      if (val && !currentTags.includes(val)) { currentTags.push(val); renderTagChips('tags-wrapper', currentTags, 'inc'); }
      tagInput.value = '';
    } else if (e.key==='Backspace' && tagInput.value==='' && currentTags.length>0) {
      currentTags.pop(); renderTagChips('tags-wrapper', currentTags, 'inc');
    }
  });
  tagsWrapper.addEventListener('click', () => tagInput.focus());

  document.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('selected-resolved','selected-ongoing'));
      btn.classList.add(btn.dataset.value==='resolvido'?'selected-resolved':'selected-ongoing');
      document.getElementById('status-hidden').value = btn.dataset.value;
    });
  });

  document.getElementById('form-incident').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-clear').addEventListener('click', clearForm);
}

// Renderizador genérico de tag chips
function renderTagChips(wrapperId, tagsArr, prefix) {
  const wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  wrapper.querySelectorAll('.tag-chip').forEach(c => c.remove());
  tagsArr.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `${escapeHtml(tag)}<span class="remove-tag" data-index="${i}" data-prefix="${prefix}">&times;</span>`;
    chip.querySelector('.remove-tag').addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(e.target.dataset.index);
      const p   = e.target.dataset.prefix;
      if (p === 'inc')   { currentTags.splice(idx,1); renderTagChips('tags-wrapper', currentTags, 'inc'); }
      if (p === 'alert') { alertCurrentTags.splice(idx,1); renderTagChips('alert-tags-wrapper', alertCurrentTags, 'alert'); }
    });
    const field = wrapper.querySelector('.tags-input-field');
    if (field) wrapper.insertBefore(chip, field); else wrapper.appendChild(chip);
  });
}

// =============================================
// SUBMIT INCIDENTE
// =============================================
function handleFormSubmit(e) {
  e.preventDefault();
  const problema   = document.getElementById('problema').value.trim();
  const sintoma    = document.getElementById('sintoma').value.trim();
  const causa      = document.getElementById('causa').value.trim();
  const acao       = document.getElementById('acao').value.trim();
  const status     = document.getElementById('status-hidden').value;
  const ferramenta = document.getElementById('ferramenta').value;
  if (!problema||!sintoma||!causa||!acao) { showToast('Preencha todos os campos obrigatórios.','error'); return; }

  if (editingId) {
    const idx = incidents.findIndex(i => i.id===editingId);
    if (idx>=0) incidents[idx] = {...incidents[idx], problema, sintoma, causa, acao, status, ferramenta, tags:[...currentTags]};
    showToast(`Incidente ${editingId} atualizado!`,'info');
    // Se foi marcado como resolvido, encerra o timer automaticamente
    if (status === 'resolvido' && typeof NOC_TIMER !== 'undefined') {
      NOC_TIMER.encerrarIncidente(editingId);
    }
    editingId = null;
    document.getElementById('form-title').textContent = 'Registrar novo incidente';
    document.getElementById('btn-submit').textContent = 'Registrar incidente';
  } else {
    const id = generateIncId();
    incidents.unshift({ id, problema, sintoma, causa, acao, status, ferramenta, tags:[...currentTags], datahora: new Date().toISOString() });
    showToast(`Incidente ${id} registrado!`,'success');
  }
  saveIncidents(); clearForm(); updateStats(); populateToolFilters(); updateFooterCount();
  document.getElementById('tab-count').textContent = incidents.length;
}

function generateIncId() {
  return `INC-${String(incidents.length+1).padStart(3,'0')}-${Date.now().toString(36).toUpperCase().slice(-3)}`;
}

function clearForm() {
  document.getElementById('form-incident').reset();
  currentTags = []; renderTagChips('tags-wrapper', currentTags, 'inc');
  editingId = null;
  document.getElementById('status-hidden').value = 'resolvido';
  document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('selected-resolved','selected-ongoing'));
  document.querySelector('.status-btn[data-value="resolvido"]').classList.add('selected-resolved');
  document.getElementById('form-title').textContent = 'Registrar novo incidente';
  document.getElementById('btn-submit').textContent = 'Registrar incidente';
}

// =============================================
// BUSCA DE INCIDENTES
// =============================================
function initSearchPanel() {
  const si = document.getElementById('search-input');
  si.addEventListener('input', debounce(() => { lastSearchQuery=si.value.trim(); performSearch(); }, 250));
  si.addEventListener('keydown', (e) => { if (e.key==='Enter') { lastSearchQuery=si.value.trim(); performSearch(); } });

  document.getElementById('btn-clear-search').addEventListener('click', () => {
    si.value=''; lastSearchQuery=''; activeFilterStatus=activeFilterTool=activeFilterField='all';
    document.querySelectorAll('.filter-chip[data-status]').forEach(c=>c.classList.remove('active'));
    document.querySelectorAll('.filter-chip[data-field]').forEach(c=>c.classList.remove('active'));
    document.querySelector('.filter-chip[data-status="all"]').classList.add('active');
    document.querySelector('.filter-chip[data-field="all"]').classList.add('active');
    document.getElementById('filter-tool').value='all';
    hideSuggestion(); renderIncidentsList();
  });

  document.querySelectorAll('.filter-chip[data-status]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip[data-status]').forEach(x=>x.classList.remove('active'));
    c.classList.add('active'); activeFilterStatus=c.dataset.status; performSearch();
  }));
  document.querySelectorAll('.filter-chip[data-field]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip[data-field]').forEach(x=>x.classList.remove('active'));
    c.classList.add('active'); activeFilterField=c.dataset.field; performSearch();
  }));
  document.getElementById('filter-tool').addEventListener('change', (e) => { activeFilterTool=e.target.value; performSearch(); });

  renderIncidentsList();
}

function performSearch() {
  const query = lastSearchQuery.toLowerCase();
  let results = [...incidents];
  if (activeFilterStatus!=='all') results = results.filter(i=>i.status===activeFilterStatus);
  if (activeFilterTool!=='all')   results = results.filter(i=>i.ferramenta===activeFilterTool);
  if (query) {
    results = results.map(inc => {
      let score = 0;
      const fields = { problema: inc.problema||'', sintoma: inc.sintoma||'', causa: inc.causa||'', acao: inc.acao||'' };
      for (const [f,t] of Object.entries(fields)) {
        if (activeFilterField!=='all' && f!==activeFilterField) continue;
        if (t.toLowerCase().includes(query)) score += f==='problema'?3:f==='causa'?2:1;
      }
      if ((inc.tags||[]).some(t=>t.toLowerCase().includes(query))) score+=2;
      return {...inc, _score: score};
    }).filter(i=>i._score>0).sort((a,b)=>b._score-a._score);
    showSuggestion(query, results);
  } else {
    hideSuggestion();
    results.sort((a,b)=>new Date(b.datahora)-new Date(a.datahora));
  }
  renderIncidentsList(results, query);
}

function showSuggestion(query, results) {
  const box=document.getElementById('suggestion-box'), textEl=document.getElementById('suggestion-text'), keywEl=document.getElementById('suggestion-keywords');
  let matched = null;
  for (const kb of KNOWLEDGE_BASE) { if (kb.keywords.some(kw=>query.includes(kw))) { matched=kb; break; } }
  if (!matched && results.length>0) {
    const best = results[0];
    textEl.textContent=`Com base em ${results.length} incidente(s) similar(es), a ação mais recorrente foi: "${best.acao}". Causa: "${best.causa}".`;
    keywEl.innerHTML=''; box.classList.add('visible'); return;
  }
  if (!matched) { hideSuggestion(); return; }
  textEl.textContent=matched.suggestion;
  keywEl.innerHTML=matched.relatedActions.map(a=>`<span class="keyword-tag">${escapeHtml(a)}</span>`).join('');
  box.classList.add('visible');
}
function hideSuggestion() { document.getElementById('suggestion-box').classList.remove('visible'); }

function renderIncidentsList(data, query) {
  const list=document.getElementById('incidents-list'), meta=document.getElementById('results-meta');
  const src=data!==undefined?data:[...incidents].sort((a,b)=>new Date(b.datahora)-new Date(a.datahora));
  meta.innerHTML=query?`${src.length} resultado(s) para <strong style="color:var(--accent)">"${escapeHtml(query)}"</strong> — de ${incidents.length} incidente(s)`:`${src.length} incidente(s) — ordenado por data`;
  if (!src.length) { list.innerHTML=`<div class="no-results"><div class="no-results-icon">⊘</div><div class="no-results-text">Nenhum incidente encontrado</div></div>`; return; }
  list.innerHTML=src.map(inc=>renderIncCard(inc,query)).join('');
  list.querySelectorAll('.incident-card').forEach(card=>{
    card.addEventListener('click',(e)=>{ if(e.target.closest('.card-actions')) return; card.classList.toggle('expanded'); });
  });
  list.querySelectorAll('.btn-edit').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();loadIncForEdit(btn.dataset.id);}));
  list.querySelectorAll('.btn-delete').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();deleteIncident(btn.dataset.id);}));
  // TIMER PATCH — liga eventos dos widgets de comunicado
  if (typeof NOC_TIMER !== 'undefined') NOC_TIMER.bindWidgetEvents();
}

function renderIncCard(inc,query) {
  const sc=inc.status==='resolvido'?'status-resolvido':'status-andamento';
  const bc=inc.status==='resolvido'?'badge-resolved':'badge-ongoing';
  const bl=inc.status==='resolvido'?'✓ Resolvido':'⚠ Em andamento';
  const tags=(inc.tags||[]).map(t=>`<span class="card-tag">${highlight(escapeHtml(t),query)}</span>`).join('');
  const bar=(query&&inc._score)?`<div class="relevance-bar"><div class="relevance-fill" style="width:${Math.min(100,inc._score*20)}%"></div></div>`:'';
  return `<div class="incident-card ${sc}">
    <div class="card-header">
      <div style="flex:1;min-width:0"><div class="card-id">${escapeHtml(inc.id)}</div><div class="card-problema">${highlight(escapeHtml(inc.problema),query)}</div></div>
      <div class="card-badges"><span class="badge ${bc}">${bl}</span>${inc.ferramenta?`<span class="badge badge-tool">${escapeHtml(inc.ferramenta)}</span>`:''}</div>
    </div>
    <div class="card-summary">
      <div class="card-field"><span class="card-field-label">Causa</span><span class="card-field-value">${highlight(escapeHtml(inc.causa),query)}</span></div>
      <div class="card-field"><span class="card-field-label">Ação tomada</span><span class="card-field-value">${highlight(escapeHtml(inc.acao),query)}</span></div>
    </div>
    ${bar}
    <div class="card-details">
      <div class="detail-grid">
        <div class="detail-field"><span class="detail-label">Sintoma</span><span class="detail-value">${highlight(escapeHtml(inc.sintoma),query)}</span></div>
        <div class="detail-field"><span class="detail-label">Ação completa</span><span class="detail-value">${highlight(escapeHtml(inc.acao),query)}</span></div>
        <div class="detail-field"><span class="detail-label">Causa raiz</span><span class="detail-value">${highlight(escapeHtml(inc.causa),query)}</span></div>
        <div class="detail-field"><span class="detail-label">Ferramenta</span><span class="detail-value">${escapeHtml(inc.ferramenta||'—')}</span></div>
      </div>
      ${tags?`<div class="card-tags">${tags}</div>`:''}
      ${(typeof NOC_TIMER !== 'undefined') ? NOC_TIMER.buildWidgetHTML(inc.id) : ''}
      <div class="card-footer">
        <span class="card-datetime">🕒 ${formatDate(inc.datahora)}</span>
        <div class="card-actions">
          <button class="btn btn-ghost btn-sm btn-edit" data-id="${inc.id}">✎ Editar</button>
          <button class="btn btn-danger btn-delete" data-id="${inc.id}">✕ Excluir</button>
        </div>
      </div>
    </div>
  </div>`;
}

function loadIncForEdit(id) {
  const inc=incidents.find(i=>i.id===id); if(!inc) return;
  showAppScreen('cadastro');
  document.getElementById('problema').value=inc.problema;
  document.getElementById('sintoma').value=inc.sintoma;
  document.getElementById('causa').value=inc.causa;
  document.getElementById('acao').value=inc.acao;
  document.getElementById('ferramenta').value=inc.ferramenta||'';
  document.querySelectorAll('.status-btn').forEach(b=>b.classList.remove('selected-resolved','selected-ongoing'));
  const sb=document.querySelector(`.status-btn[data-value="${inc.status}"]`);
  if(sb) sb.classList.add(inc.status==='resolvido'?'selected-resolved':'selected-ongoing');
  document.getElementById('status-hidden').value=inc.status;
  currentTags=[...(inc.tags||[])]; renderTagChips('tags-wrapper',currentTags,'inc');
  editingId=id;
  document.getElementById('form-title').textContent=`Editando ${id}`;
  document.getElementById('btn-submit').textContent='Salvar alterações';
  window.scrollTo({top:0,behavior:'smooth'});
}

function deleteIncident(id) {
  if(!confirm(`Confirma exclusão do incidente ${id}?`)) return;
  incidents=incidents.filter(i=>i.id!==id); saveIncidents(); performSearch(); updateStats(); populateToolFilters(); updateFooterCount();
  document.getElementById('tab-count').textContent=incidents.length;
  // Encerra timer associado ao incidente deletado
  if (typeof NOC_TIMER !== 'undefined') NOC_TIMER.encerrarIncidente(id);
  showToast(`Incidente ${id} removido.`,'info');
}

function updateStats() {
  document.getElementById('stat-total').textContent    = incidents.length;
  document.getElementById('stat-resolved').textContent = incidents.filter(i=>i.status==='resolvido').length;
  document.getElementById('stat-ongoing').textContent  = incidents.filter(i=>i.status==='em andamento').length;
  // Base de conhecimento: dinâmico, não hardcoded
  const kbEl = document.getElementById('stat-kb');
  if (kbEl) kbEl.textContent = KNOWLEDGE_BASE.length;
}

function populateToolFilters() {
  const sel=document.getElementById('filter-tool');
  const cur=sel.value;
  const tools=[...new Set(incidents.map(i=>i.ferramenta).filter(Boolean))].sort();
  sel.innerHTML='<option value="all">Todas as ferramentas</option>';
  tools.forEach(t=>{const o=document.createElement('option');o.value=t;o.textContent=t;sel.appendChild(o);});
  if(cur) sel.value=cur;
}


// =============================================
// DASHBOARD DE AVISOS
// =============================================
function initDashboard() {
  // Botão novo aviso
  document.getElementById('btn-new-alert').addEventListener('click', () => openAlertModal());

  // Filtros
  document.querySelectorAll('.filter-chip[data-atype]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip[data-atype]').forEach(x=>x.classList.remove('active'));
    c.classList.add('active'); alertFilterType=c.dataset.atype; renderAlertsList();
  }));
  document.querySelectorAll('.filter-chip[data-aack]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip[data-aack]').forEach(x=>x.classList.remove('active'));
    c.classList.add('active'); alertFilterAck=c.dataset.aack; renderAlertsList();
  }));
  document.querySelectorAll('.filter-chip[data-asev]').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip[data-asev]').forEach(x=>x.classList.remove('active'));
    c.classList.add('active'); alertFilterSev=c.dataset.asev; renderAlertsList();
  }));

  document.getElementById('btn-clear-alert-filters').addEventListener('click', () => {
    alertFilterType=alertFilterAck=alertFilterSev='all';
    document.querySelectorAll('.filter-chip[data-atype]').forEach(c=>c.classList.remove('active'));
    document.querySelectorAll('.filter-chip[data-aack]').forEach(c=>c.classList.remove('active'));
    document.querySelectorAll('.filter-chip[data-asev]').forEach(c=>c.classList.remove('active'));
    document.querySelector('.filter-chip[data-atype="all"]').classList.add('active');
    document.querySelector('.filter-chip[data-aack="all"]').classList.add('active');
    document.querySelector('.filter-chip[data-asev="all"]').classList.add('active');
    renderAlertsList();
  });

  // Modal aviso
  document.getElementById('modal-close').addEventListener('click', closeAlertModal);
  document.getElementById('btn-cancel-alert').addEventListener('click', closeAlertModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => { if(e.target===e.currentTarget) closeAlertModal(); });
  document.getElementById('form-alert').addEventListener('submit', handleAlertSubmit);

  // Toggle tipo
  document.querySelectorAll('.type-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('selected-geral','selected-turno'));
    btn.classList.add(btn.dataset.avalue==='geral'?'selected-geral':'selected-turno');
    document.getElementById('alert-tipo').value=btn.dataset.avalue;
    document.getElementById('turno-field').style.display=btn.dataset.avalue==='turno'?'flex':'none';
  }));

  // Toggle severidade
  document.querySelectorAll('.sev-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.sev-btn').forEach(b=>b.classList.remove('selected-info','selected-atencao','selected-critico'));
    const cls={'info':'selected-info','atencao':'selected-atencao','critico':'selected-critico'};
    btn.classList.add(cls[btn.dataset.sev]);
    document.getElementById('alert-severidade').value=btn.dataset.sev;
  }));

  // Tags do aviso
  const alertTagInput   = document.getElementById('alert-tag-input');
  const alertTagsWrapper= document.getElementById('alert-tags-wrapper');
  alertTagInput.addEventListener('keydown', (e) => {
    if (['Enter',',',' '].includes(e.key)) {
      e.preventDefault();
      const val=alertTagInput.value.trim().replace(/,/g,'');
      if(val && !alertCurrentTags.includes(val)) { alertCurrentTags.push(val); renderTagChips('alert-tags-wrapper',alertCurrentTags,'alert'); }
      alertTagInput.value='';
    } else if(e.key==='Backspace' && alertTagInput.value==='' && alertCurrentTags.length>0) {
      alertCurrentTags.pop(); renderTagChips('alert-tags-wrapper',alertCurrentTags,'alert');
    }
  });
  alertTagsWrapper.addEventListener('click', ()=>alertTagInput.focus());

  // Modal Acknowledge
  document.getElementById('ack-modal-close').addEventListener('click', closeAckModal);
  document.getElementById('btn-cancel-ack').addEventListener('click', closeAckModal);
  document.getElementById('ack-modal-overlay').addEventListener('click', (e)=>{ if(e.target===e.currentTarget) closeAckModal(); });
  document.getElementById('btn-confirm-ack').addEventListener('click', confirmAck);
}

// ===== MODAL AVISO =====
function openAlertModal(editId) {
  alertEditingId = editId || null;
  alertCurrentTags = [];

  if (editId) {
    const al = alerts.find(a=>a.id===editId);
    if (!al) return;
    document.getElementById('modal-title').textContent = `Editando ${editId}`;
    document.getElementById('btn-submit-alert').textContent = 'Salvar alterações';
    document.getElementById('alert-titulo').value    = al.titulo;
    document.getElementById('alert-descricao').value = al.descricao||'';
    document.getElementById('alert-responsavel').value= al.responsavel||'';
    document.getElementById('alert-tipo').value      = al.tipo;
    document.getElementById('alert-severidade').value= al.severidade;
    document.getElementById('alert-turno').value     = al.turno||'';
    alertCurrentTags = [...(al.tags||[])];

    // Ajusta toggles visuais
    document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('selected-geral','selected-turno'));
    document.querySelector(`.type-btn[data-avalue="${al.tipo}"]`).classList.add(al.tipo==='geral'?'selected-geral':'selected-turno');
    document.getElementById('turno-field').style.display = al.tipo==='turno'?'flex':'none';

    document.querySelectorAll('.sev-btn').forEach(b=>b.classList.remove('selected-info','selected-atencao','selected-critico'));
    const cls={'info':'selected-info','atencao':'selected-atencao','critico':'selected-critico'};
    document.querySelector(`.sev-btn[data-sev="${al.severidade}"]`).classList.add(cls[al.severidade]);
  } else {
    document.getElementById('modal-title').textContent = 'Novo aviso';
    document.getElementById('btn-submit-alert').textContent = 'Criar aviso';
    document.getElementById('form-alert').reset();
    document.getElementById('alert-tipo').value = 'geral';
    document.getElementById('alert-severidade').value = 'info';
    document.getElementById('turno-field').style.display = 'none';
    document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('selected-geral','selected-turno'));
    document.querySelector('.type-btn[data-avalue="geral"]').classList.add('selected-geral');
    document.querySelectorAll('.sev-btn').forEach(b=>b.classList.remove('selected-info','selected-atencao','selected-critico'));
    document.querySelector('.sev-btn[data-sev="info"]').classList.add('selected-info');
  }

  renderTagChips('alert-tags-wrapper', alertCurrentTags, 'alert');
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('alert-titulo').focus();
}

function closeAlertModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  alertEditingId = null;
}

function handleAlertSubmit(e) {
  e.preventDefault();
  const titulo      = document.getElementById('alert-titulo').value.trim();
  const descricao   = document.getElementById('alert-descricao').value.trim();
  const tipo        = document.getElementById('alert-tipo').value;
  const severidade  = document.getElementById('alert-severidade').value;
  const turno       = document.getElementById('alert-turno').value;
  const responsavel = document.getElementById('alert-responsavel').value.trim();

  if (!titulo) { showToast('Preencha o título do aviso.','error'); return; }

  if (alertEditingId) {
    const idx = alerts.findIndex(a=>a.id===alertEditingId);
    if (idx>=0) alerts[idx] = {...alerts[idx], titulo, descricao, tipo, severidade, turno, responsavel, tags:[...alertCurrentTags]};
    showToast(`Aviso ${alertEditingId} atualizado!`,'info');
  } else {
    const id = generateAlertId();
    alerts.unshift({ id, titulo, descricao, tipo, severidade, turno, responsavel, tags:[...alertCurrentTags], datahora: new Date().toISOString(), acks: [], aberto: true });
    showToast(`Aviso ${id} criado!`,'success');
  }

  saveAlerts(); closeAlertModal(); renderAlertsList(); updateAlertBadges(); updateFooterCount();
}

function generateAlertId() {
  return `AVS-${String(alerts.length+1).padStart(3,'0')}`;
}

// ===== RENDERIZAR LISTA DE AVISOS =====
function renderAlertsList() {
  const list = document.getElementById('alerts-list');
  if (!list) return;

  let filtered = [...alerts];
  if (alertFilterType !== 'all') filtered = filtered.filter(a=>a.tipo===alertFilterType);
  if (alertFilterAck  === 'pending') filtered = filtered.filter(a=>a.acks.length===0);
  if (alertFilterAck  === 'acked')   filtered = filtered.filter(a=>a.acks.length>0);
  if (alertFilterSev  !== 'all') filtered = filtered.filter(a=>a.severidade===alertFilterSev);

  // Ordenação: críticos primeiro, depois por data
  filtered.sort((a,b)=>{
    const sevOrder = {critico:0, atencao:1, info:2};
    const so = (sevOrder[a.severidade]||2) - (sevOrder[b.severidade]||2);
    if (so!==0) return so;
    return new Date(b.datahora)-new Date(a.datahora);
  });

  // Atualizar stats
  const total   = alerts.length;
  const unacked = alerts.filter(a=>a.acks.length===0 && a.aberto).length;
  const open    = alerts.filter(a=>a.aberto).length;
  const acked   = alerts.filter(a=>a.acks.length>0).length;
  document.getElementById('astat-total').textContent   = total;
  document.getElementById('astat-unacked').textContent = unacked;
  document.getElementById('astat-open').textContent    = open;
  document.getElementById('astat-acked').textContent   = acked;

  if (!filtered.length) {
    list.innerHTML=`<div class="no-results"><div class="no-results-icon">⚑</div><div class="no-results-text">Nenhum aviso encontrado com os filtros selecionados</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(al => renderAlertCard(al)).join('');

  // Eventos
  list.querySelectorAll('.btn-do-ack').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();openAckModal(btn.dataset.id);}));
  list.querySelectorAll('.btn-edit-alert').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();openAlertModal(btn.dataset.id);}));
  list.querySelectorAll('.btn-delete-alert').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();deleteAlert(btn.dataset.id);}));
  list.querySelectorAll('.btn-close-alert').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();toggleAlertOpen(btn.dataset.id);}));
}

function renderAlertCard(al) {
  const isAcked   = al.acks.length > 0;
  const ackedClass= isAcked ? 'is-acked' : '';
  const sevLabels = { critico:'🔴 Crítico', atencao:'🟡 Atenção', info:'🔵 Info' };
  const sevBadge  = `badge-sev-${al.severidade}`;
  const tipoBadge = al.tipo==='geral' ? 'badge-tipo-geral' : 'badge-tipo-turno';
  const tipoLabel = al.tipo==='geral' ? '🌐 Geral' : '🔄 Turno';
  const ackBadge  = isAcked
    ? `<span class="badge badge-acked">✓ ${al.acks.length} acknowledge${al.acks.length>1?'s':''}</span>`
    : `<span class="badge badge-pending">⚠ Aguardando ack</span>`;
  const openBadge = al.aberto
    ? `<span class="badge" style="background:rgba(240,165,0,0.08);color:var(--yellow);border:1px solid rgba(240,165,0,0.2)">Em aberto</span>`
    : `<span class="badge" style="background:rgba(76,175,80,0.08);color:var(--green-bright);border:1px solid rgba(76,175,80,0.2)">Encerrado</span>`;

  const tags = (al.tags||[]).map(t=>`<span class="alert-tag">${escapeHtml(t)}</span>`).join('');
  const turnoChip = (al.tipo==='turno' && al.turno) ? `<span class="alert-turno-badge">🔄 ${escapeHtml(al.turno)}</span>` : '';

  // Histórico de acks
  let ackHistory = '';
  if (al.acks.length > 0) {
    const items = al.acks.map(ack => `
      <div class="ack-history-item">
        <span class="ack-history-icon">✓</span>
        <div class="ack-history-info">
          <div class="ack-name">${escapeHtml(ack.nome)}</div>
          ${ack.comentario ? `<div class="ack-comment">"${escapeHtml(ack.comentario)}"</div>` : ''}
        </div>
        <span class="ack-time">${formatDate(ack.datahora)}</span>
      </div>`).join('');
    ackHistory = `<div class="ack-history"><div class="ack-history-title">Histórico de acknowledges</div>${items}</div>`;
  }

  const ackBtnDisabled = !al.aberto ? 'style="display:none"' : '';

  return `
  <div class="alert-card sev-${al.severidade} ${ackedClass}">
    <div class="alert-card-header">
      <div class="alert-card-left">
        <div class="alert-card-meta">
          <span class="alert-id">${escapeHtml(al.id)}</span>
          <span class="${sevBadge}">${sevLabels[al.severidade]}</span>
          <span class="${tipoBadge}">${tipoLabel}</span>
          ${turnoChip}
          ${ackBadge}
          ${openBadge}
        </div>
        <div class="alert-titulo">${escapeHtml(al.titulo)}</div>
        ${al.descricao ? `<div class="alert-descricao">${escapeHtml(al.descricao)}</div>` : ''}
        ${tags ? `<div class="alert-tags">${tags}</div>` : ''}
      </div>
      <div class="alert-card-right">
        <button class="btn-ack-card btn-do-ack ${isAcked?'':'animate-ack'}" data-id="${al.id}" ${!al.aberto?'disabled':''} title="${al.aberto?'Registrar acknowledge':'Aviso encerrado'}">
          ${isAcked ? '✓ Acked' : '⚡ Acknowledge'}
        </button>
        <div class="alert-card-actions">
          <button class="btn btn-ghost btn-sm btn-edit-alert" data-id="${al.id}" title="Editar aviso">✎</button>
          <button class="btn btn-ghost btn-sm btn-close-alert" data-id="${al.id}" title="${al.aberto?'Encerrar aviso':'Reabrir aviso'}">${al.aberto?'⊠ Encerrar':'↺ Reabrir'}</button>
          <button class="btn btn-danger btn-sm btn-delete-alert" data-id="${al.id}" title="Excluir aviso">✕</button>
        </div>
      </div>
    </div>
    ${ackHistory}
    <div class="alert-card-footer">
      <div class="alert-footer-left">
        ${al.responsavel ? `<span class="alert-meta-item">👤 ${escapeHtml(al.responsavel)}</span>` : ''}
        <span class="alert-meta-item">🕒 ${formatDate(al.datahora)}</span>
      </div>
    </div>
  </div>`;
}

// ===== MODAL ACKNOWLEDGE =====
function openAckModal(alertId) {
  const al = alerts.find(a=>a.id===alertId);
  if (!al) return;
  ackPendingAlertId = alertId;
  document.getElementById('ack-aviso-preview').innerHTML = `<strong>${escapeHtml(al.titulo)}</strong><br><span style="font-size:12px;color:var(--text-dim)">${escapeHtml(al.id)} · ${al.tipo==='geral'?'🌐 Geral':'🔄 Turno'}</span>`;
  document.getElementById('ack-nome').value = '';
  document.getElementById('ack-comentario').value = '';
  document.getElementById('ack-modal-overlay').style.display = 'flex';
  setTimeout(()=>document.getElementById('ack-nome').focus(), 100);
}

function closeAckModal() {
  document.getElementById('ack-modal-overlay').style.display = 'none';
  ackPendingAlertId = null;
}

function confirmAck() {
  const nome = document.getElementById('ack-nome').value.trim();
  if (!nome) { showToast('Digite seu nome para registrar o acknowledge.','error'); document.getElementById('ack-nome').focus(); return; }
  const comentario = document.getElementById('ack-comentario').value.trim();
  const idx = alerts.findIndex(a=>a.id===ackPendingAlertId);
  if (idx<0) return;
  alerts[idx].acks.push({ nome, comentario, datahora: new Date().toISOString() });
  saveAlerts(); closeAckModal(); renderAlertsList(); updateAlertBadges(); updateFooterCount();
  showToast(`Acknowledge registrado por ${nome}!`,'success');
}

// ===== AÇÕES EXTRAS =====
function toggleAlertOpen(id) {
  const idx = alerts.findIndex(a=>a.id===id);
  if (idx<0) return;
  alerts[idx].aberto = !alerts[idx].aberto;
  saveAlerts(); renderAlertsList(); updateAlertBadges(); updateFooterCount();
  showToast(`Aviso ${id} ${alerts[idx].aberto?'reaberto':'encerrado'}.`,'info');
}

function deleteAlert(id) {
  if (!confirm(`Confirma exclusão do aviso ${id}?`)) return;
  alerts = alerts.filter(a=>a.id!==id);
  saveAlerts(); renderAlertsList(); updateAlertBadges(); updateFooterCount();
  showToast(`Aviso ${id} removido.`,'info');
}

function updateAlertBadges() {
  const unacked = alerts.filter(a=>a.acks.length===0 && a.aberto).length;
  const tabBadge = document.getElementById('tab-alert-count');
  if (tabBadge) tabBadge.textContent = unacked;

  const topBtn   = document.getElementById('topbar-alert-btn');
  const topBadge = document.getElementById('topbar-alert-badge');
  if (topBtn && topBadge) {
    topBtn.style.display   = unacked>0 ? 'flex' : 'none';
    topBadge.textContent   = unacked;
  }

  const homeBadge = document.getElementById('home-link-badge');
  const homeBanner= document.getElementById('home-alert-banner');
  const homeText  = document.getElementById('home-alert-text');
  if (homeBadge) { homeBadge.style.display = unacked>0?'inline':'none'; homeBadge.textContent = unacked; }
  if (homeBanner && homeText) {
    if (unacked>0) {
      homeBanner.style.display = 'flex';
      homeText.textContent = `${unacked} aviso(s) pendente(s) de confirmação (acknowledge)`;
    } else {
      homeBanner.style.display = 'none';
    }
  }
}


// =============================================
// TOAST
// =============================================
function showToast(msg, type='info') {
  const icons={success:'✓',error:'✕',info:'ℹ'};
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className=`toast toast-${type}`;
  t.innerHTML=`<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${escapeHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateX(16px)'; t.style.transition='all 0.25s'; setTimeout(()=>t.remove(),250); },3200);
}


// =============================================
// UTILITÁRIOS
// =============================================
function highlight(text, query) {
  if (!query) return text;
  return text.replace(new RegExp(`(${escapeRegex(query)})`,'gi'),'<mark class="highlight">$1</mark>');
}
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function debounce(fn,delay) { let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),delay); }; }
