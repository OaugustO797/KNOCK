/**
 * KNOCK — Módulo de Alertas Conhecidos
 * alertas-conhecidos.js
 *
 * INTEGRAÇÃO:
 * - Arquivo separado, carregado após script.js, timer.js e sync.js
 * - Persiste via localStorage ('noc_known_alerts')
 * - Não modifica nenhuma variável global existente
 * - API pública: NOC_KA.init()
 */

const NOC_KA = (() => {

  // ─────────────────────────────────────────
  // ESTADO
  // ─────────────────────────────────────────
  let knownAlerts   = [];
  let kaEditingId    = null;
  let kaCurrentTags  = [];
  let kaCurrentImage = null;  // { data: base64string, name: filename }
  let kaFilterSev    = 'all';
  let kaFilterCat    = 'all';
  let kaSearchQuery  = '';

  const LS_KEY      = 'noc_known_alerts';
  const LS_SEED_KEY = 'noc_known_alerts_initialized';

  // ─────────────────────────────────────────
  // SEVERIDADES — mapa visual
  // ─────────────────────────────────────────
  const SEV = {
    aviso:    { label: '🟡 Aviso',    badge: 'badge-ka-aviso',    cls: 'sev-aviso',    selCls: 'selected-aviso' },
    medio:    { label: '🟠 Médio',    badge: 'badge-ka-medio',    cls: 'sev-medio',    selCls: 'selected-medio' },
    alto:     { label: '🔴 Alto',     badge: 'badge-ka-alto',     cls: 'sev-alto',     selCls: 'selected-alto' },
    desastre: { label: '🟥 Desastre', badge: 'badge-ka-desastre', cls: 'sev-desastre', selCls: 'selected-desastre' },
  };

  const CAT_LABEL = {
    'ad':           'AD',
    'adms':         'ADMS',
    'aplicacao':    'Aplicação',
    'backup':       'Backup',
    'banco-de-dados':'Banco de Dados',
    'bi':           'BI',
    'call-center':  'Call Center',
    'citrix':       'Citrix',
    'data-center':  'Data Center',
    'fornecedor':   'Fornecedor',
    'gat':          'GAT',
    'infra':        'Infra',
    'mobile':       'Mobile',
    'pb':           'PB',
    'redeot':       'RedeOT',
    'redes':        'Redes',
    'scada':        'SCADA',
    'seguranca':    'Segurança',
    'sustentacao':  'Sustentação',
    'telefonia':    'Telefonia',
    'terceiros':    'Terceiros',
    'ti':           'TI',
    'web':          'Web',
  };

  // ─────────────────────────────────────────
  // PERSISTÊNCIA
  // ─────────────────────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      knownAlerts = raw ? JSON.parse(raw) : [];
    } catch(e) { knownAlerts = []; }

    // Seed só na primeira abertura
    if (!localStorage.getItem(LS_SEED_KEY)) {
      if (knownAlerts.length === 0) {
        knownAlerts = getSeedAlerts();
        save();
      }
      localStorage.setItem(LS_SEED_KEY, '1');
    }
  }

  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(knownAlerts));
  }

  // ─────────────────────────────────────────
  // INICIALIZAÇÃO
  // ─────────────────────────────────────────
  function init() {
    load();
    bindTabEvent();
    bindModalEvents();
    bindFilterEvents();
    updateKaBadge();

    // Recarrega quando o Supabase terminar de sincronizar
    window.addEventListener('knock:synced', () => {
      load();
      renderList();
      updateStats();
      updateKaBadge();
    });
  }

  function bindTabEvent() {
    // Renderiza ao entrar na aba
    const tabBtn = document.querySelector('[data-tab="alertas-conhecidos"]');
    if (tabBtn) {
      tabBtn.addEventListener('click', () => {
        renderList();
        updateStats();
      });
    }
  }

  // ─────────────────────────────────────────
  // FILTROS
  // ─────────────────────────────────────────
  function bindFilterEvents() {
    // Chips de severidade
    document.querySelectorAll('[data-kasev]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('[data-kasev]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        kaFilterSev = chip.dataset.kasev;
        renderList();
      });
    });

    // Chips de categoria
    document.querySelectorAll('[data-kacat]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('[data-kacat]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        kaFilterCat = chip.dataset.kacat;
        renderList();
      });
    });

    // Busca inline
    const searchInput = document.getElementById('ka-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', debounce(() => {
        kaSearchQuery = searchInput.value.trim();
        renderList();
      }, 250));
    }

    // Limpar filtros
    const btnClear = document.getElementById('btn-clear-ka-filters');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        kaFilterSev = kaFilterCat = 'all';
        kaSearchQuery = '';
        if (searchInput) searchInput.value = '';
        document.querySelectorAll('[data-kasev]').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('[data-kacat]').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-kasev="all"]').classList.add('active');
        document.querySelector('[data-kacat="all"]').classList.add('active');
        renderList();
      });
    }
  }

  // ─────────────────────────────────────────
  // MODAL — abrir / fechar
  // ─────────────────────────────────────────
  function openModal(editId) {
    kaEditingId    = editId || null;
    kaCurrentTags  = [];
    kaCurrentImage = null;

    const overlay  = document.getElementById('ka-modal-overlay');
    const title    = document.getElementById('ka-modal-title');
    const submitBtn= document.getElementById('btn-submit-ka');

    // Reset área de imagem
    resetImageArea();

    if (editId) {
      const ka = knownAlerts.find(a => a.id === editId);
      if (!ka) return;
      title.textContent     = `Editando alerta — ${editId}`;
      submitBtn.textContent = 'Salvar alterações';

      document.getElementById('ka-nome').value       = ka.nome;
      document.getElementById('ka-descricao').value  = ka.descricao  || '';
      document.getElementById('ka-causa').value      = ka.causa      || '';
      document.getElementById('ka-acao').value       = ka.acao       || '';
      document.getElementById('ka-escalar').value    = ka.escalar    || '';
      document.getElementById('ka-categoria').value  = ka.categoria  || 'outro';
      document.getElementById('ka-ferramenta').value = ka.ferramenta || '';
      document.getElementById('ka-severidade').value = ka.severidade;
      kaCurrentTags = [...(ka.tags || [])];

      // Carrega imagem existente se houver
      if (ka.image && ka.image.data) {
        kaCurrentImage = { data: ka.image.data, name: ka.image.name || 'imagem' };
        showImagePreview(ka.image.data, ka.image.name || 'imagem');
      }

      // Ajusta toggle de severidade
      setSevToggle(ka.severidade);
    } else {
      title.textContent     = 'Novo alerta conhecido';
      submitBtn.textContent = 'Salvar alerta';
      document.getElementById('form-ka').reset();
      document.getElementById('ka-severidade').value = 'aviso';
      setSevToggle('aviso');
    }

    renderKaTagChips();
    overlay.style.display = 'flex';
    setTimeout(() => document.getElementById('ka-nome').focus(), 80);
  }

  function closeModal() {
    document.getElementById('ka-modal-overlay').style.display = 'none';
    kaEditingId    = null;
    kaCurrentTags  = [];
    kaCurrentImage = null;
    resetImageArea();
  }

  function setSevToggle(sev) {
    document.querySelectorAll('.ka-sev-btn').forEach(b => {
      b.className = b.className.replace(/selected-\w+/g, '').trim();
    });
    const btn = document.querySelector(`.ka-sev-btn[data-kasev="${sev}"]`);
    if (btn && SEV[sev]) btn.classList.add(SEV[sev].selCls);
  }

  // ─────────────────────────────────────────
  // MODAL — eventos
  // ─────────────────────────────────────────
  function bindModalEvents() {
    // Botão novo alerta
    const btnNew = document.getElementById('btn-new-ka');
    if (btnNew) btnNew.addEventListener('click', () => openModal());

    // Fechar
    document.getElementById('ka-modal-close').addEventListener('click', closeModal);
    document.getElementById('btn-cancel-ka').addEventListener('click', closeModal);
    document.getElementById('ka-modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    // Submit
    document.getElementById('form-ka').addEventListener('submit', handleSubmit);

    // Toggle severidade
    document.querySelectorAll('.ka-sev-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('ka-severidade').value = btn.dataset.kasev;
        setSevToggle(btn.dataset.kasev);
      });
    });

    // Tags
    const tagInput   = document.getElementById('ka-tag-input');
    const tagsWrapper= document.getElementById('ka-tags-wrapper');
    if (tagInput) {
      tagInput.addEventListener('keydown', (e) => {
        if (['Enter', ',', ' '].includes(e.key)) {
          e.preventDefault();
          const val = tagInput.value.trim().replace(/,/g, '');
          if (val && !kaCurrentTags.includes(val)) {
            kaCurrentTags.push(val);
            renderKaTagChips();
          }
          tagInput.value = '';
        } else if (e.key === 'Backspace' && tagInput.value === '' && kaCurrentTags.length > 0) {
          kaCurrentTags.pop();
          renderKaTagChips();
        }
      });
    }
    if (tagsWrapper) tagsWrapper.addEventListener('click', () => tagInput && tagInput.focus());

    // ── Imagem ──────────────────────────────────────────
    const imgInput    = document.getElementById('ka-image-input');
    const imgDropzone = document.getElementById('ka-image-dropzone');
    const imgRemove   = document.getElementById('ka-image-remove');

    // Clique na dropzone abre o seletor
    if (imgDropzone) {
      imgDropzone.addEventListener('click', () => imgInput && imgInput.click());

      // Drag & drop
      imgDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        imgDropzone.classList.add('drag-over');
      });
      imgDropzone.addEventListener('dragleave', () => imgDropzone.classList.remove('drag-over'));
      imgDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        imgDropzone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) processImageFile(file);
      });
    }

    // Seleção via input file
    if (imgInput) {
      imgInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) processImageFile(file);
        imgInput.value = ''; // reset para permitir selecionar o mesmo arquivo novamente
      });
    }

    // Remover imagem
    if (imgRemove) {
      imgRemove.addEventListener('click', () => clearImagePreview());
    }
  }

  // ─────────────────────────────────────────
  // IMAGEM — processar, comprimir, preview
  // ─────────────────────────────────────────

  function processImageFile(file) {
    const MAX_WIDTH  = 1200;
    const MAX_HEIGHT = 900;
    const QUALITY    = 0.82;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Calcula dimensões respeitando proporção
        let w = img.width, h = img.height;
        if (w > MAX_WIDTH)  { h = Math.round(h * MAX_WIDTH / w);  w = MAX_WIDTH; }
        if (h > MAX_HEIGHT) { w = Math.round(w * MAX_HEIGHT / h); h = MAX_HEIGHT; }

        // Comprime via Canvas
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        const compressed = canvas.toDataURL('image/jpeg', QUALITY);
        kaCurrentImage = { data: compressed, name: file.name };
        showImagePreview(compressed, file.name);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function showImagePreview(dataUrl, filename) {
    const dropzone   = document.getElementById('ka-image-dropzone');
    const previewWrap= document.getElementById('ka-image-preview-wrap');
    const previewImg = document.getElementById('ka-image-preview');
    const nameEl     = document.getElementById('ka-image-name');
    if (!previewWrap) return;
    previewImg.src   = dataUrl;
    nameEl.textContent = filename || 'imagem';
    dropzone.style.display    = 'none';
    previewWrap.style.display = 'flex';
    // Clique na preview abre lightbox
    previewImg.onclick = () => openLightbox(dataUrl);
  }

  function clearImagePreview() {
    kaCurrentImage = null;
    const dropzone   = document.getElementById('ka-image-dropzone');
    const previewWrap= document.getElementById('ka-image-preview-wrap');
    const previewImg = document.getElementById('ka-image-preview');
    if (!dropzone) return;
    previewImg.src            = '';
    previewImg.onclick        = null;
    dropzone.style.display    = 'flex';
    previewWrap.style.display = 'none';
  }

  function resetImageArea() {
    kaCurrentImage = null;
    clearImagePreview();
  }

  // ─────────────────────────────────────────
  // LIGHTBOX
  // ─────────────────────────────────────────
  function openLightbox(dataUrl) {
    // Remove lightbox anterior se existir
    const existing = document.getElementById('ka-lightbox');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'ka-lightbox';
    overlay.className = 'ka-lightbox-overlay';
    overlay.innerHTML = `
      <button class="ka-lightbox-close" id="ka-lightbox-close">✕</button>
      <img class="ka-lightbox-img" src="${dataUrl}" alt="Imagem do alerta">`;

    document.body.appendChild(overlay);

    // Fechar
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.getElementById('ka-lightbox-close').addEventListener('click', () => overlay.remove());

    // ESC fecha
    const escHandler = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
  }

  function renderKaTagChips() {
    const wrapper = document.getElementById('ka-tags-wrapper');
    if (!wrapper) return;
    wrapper.querySelectorAll('.tag-chip').forEach(c => c.remove());
    kaCurrentTags.forEach((tag, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `${escHtml(tag)}<span class="remove-tag" data-i="${i}">&times;</span>`;
      chip.querySelector('.remove-tag').addEventListener('click', (e) => {
        e.stopPropagation();
        kaCurrentTags.splice(parseInt(e.target.dataset.i), 1);
        renderKaTagChips();
      });
      const field = wrapper.querySelector('.tags-input-field');
      if (field) wrapper.insertBefore(chip, field); else wrapper.appendChild(chip);
    });
  }

  // ─────────────────────────────────────────
  // SUBMIT
  // ─────────────────────────────────────────
  function handleSubmit(e) {
    e.preventDefault();
    const nome      = document.getElementById('ka-nome').value.trim();
    const descricao = document.getElementById('ka-descricao').value.trim();
    const causa     = document.getElementById('ka-causa').value.trim();
    const acao      = document.getElementById('ka-acao').value.trim();
    const escalar   = document.getElementById('ka-escalar').value.trim();
    const severidade= document.getElementById('ka-severidade').value;
    const categoria = document.getElementById('ka-categoria').value;
    const ferramenta= document.getElementById('ka-ferramenta').value;

    if (!nome || !causa || !acao) {
      showToastKa('Preencha nome, causa e ação recomendada.', 'error');
      return;
    }

    // Imagem: usa a nova se selecionada, mantém a existente se editando sem trocar
    let imageToSave = kaCurrentImage || null;
    if (kaEditingId && !kaCurrentImage) {
      const existing = knownAlerts.find(a => a.id === kaEditingId);
      imageToSave = (existing && existing.image) ? existing.image : null;
    }

    if (kaEditingId) {
      const idx = knownAlerts.findIndex(a => a.id === kaEditingId);
      if (idx >= 0) {
        knownAlerts[idx] = {
          ...knownAlerts[idx],
          nome, descricao, causa, acao, escalar,
          severidade, categoria, ferramenta,
          tags:  [...kaCurrentTags],
          image: imageToSave,
          updatedAt: new Date().toISOString()
        };
      }
      showToastKa(`Alerta ${kaEditingId} atualizado!`, 'info');
    } else {
      const id = generateId();
      knownAlerts.unshift({
        id, nome, descricao, causa, acao, escalar,
        severidade, categoria, ferramenta,
        tags:  [...kaCurrentTags],
        image: imageToSave,
        createdAt: new Date().toISOString()
      });
      showToastKa(`Alerta ${id} cadastrado!`, 'success');
    }

    save();
    closeModal();
    renderList();
    updateStats();
    updateKaBadge();
  }

  function generateId() {
    return `KA-${String(knownAlerts.length + 1).padStart(3, '0')}`;
  }

  // ─────────────────────────────────────────
  // RENDERIZAR LISTA
  // ─────────────────────────────────────────
  function renderList() {
    const list    = document.getElementById('ka-list');
    const metaEl  = document.getElementById('ka-results-meta');
    if (!list) return;

    const q = kaSearchQuery.toLowerCase();

    let filtered = [...knownAlerts];

    if (kaFilterSev !== 'all') filtered = filtered.filter(a => a.severidade === kaFilterSev);
    if (kaFilterCat !== 'all') filtered = filtered.filter(a => a.categoria  === kaFilterCat);

    if (q) {
      filtered = filtered.filter(a =>
        (a.nome      || '').toLowerCase().includes(q) ||
        (a.descricao || '').toLowerCase().includes(q) ||
        (a.causa     || '').toLowerCase().includes(q) ||
        (a.acao      || '').toLowerCase().includes(q) ||
        (a.tags      || []).some(t => t.toLowerCase().includes(q))
      );
      // Ordena por relevância (match no nome vale mais)
      filtered.sort((a, b) => {
        const aName = (a.nome || '').toLowerCase().includes(q) ? 1 : 0;
        const bName = (b.nome || '').toLowerCase().includes(q) ? 1 : 0;
        return bName - aName;
      });
    }

    // Ordena por severidade quando sem busca
    if (!q) {
      const order = { desastre: 0, alto: 1, medio: 2, aviso: 3 };
      filtered.sort((a, b) => (order[a.severidade] ?? 4) - (order[b.severidade] ?? 4));
    }

    if (metaEl) {
      metaEl.innerHTML = q
        ? `${filtered.length} resultado(s) para <strong style="color:var(--ka-medio)">"${escHtml(q)}"</strong> — de ${knownAlerts.length} alerta(s) na base`
        : `${filtered.length} alerta(s) cadastrado(s)`;
    }

    if (!filtered.length) {
      list.innerHTML = `
        <div class="ka-no-results">
          <div class="ka-no-results-icon">⚡</div>
          <div class="ka-no-results-text">Nenhum alerta encontrado</div>
          <div style="margin-top:6px;font-size:12px;color:var(--text-dim)">Ajuste os filtros ou cadastre um novo alerta</div>
        </div>`;
      return;
    }

    list.innerHTML = filtered.map(ka => renderCard(ka, q)).join('');

    // Eventos dos cards
    list.querySelectorAll('.ka-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ka-card-actions')) return;
        card.classList.toggle('expanded');
      });
    });

    list.querySelectorAll('.btn-ka-edit').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openModal(btn.dataset.id); });
    });

    list.querySelectorAll('.btn-ka-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Confirma exclusão do alerta ${btn.dataset.id}?`)) return;
        knownAlerts = knownAlerts.filter(a => a.id !== btn.dataset.id);
        save(); renderList(); updateStats(); updateKaBadge();
        showToastKa(`Alerta ${btn.dataset.id} removido.`, 'info');
      });
    });

    // Lightbox — badge 📷 e thumbnail
    list.querySelectorAll('.btn-ka-lightbox').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const ka = knownAlerts.find(a => a.id === el.dataset.id);
        if (ka && ka.image && ka.image.data) openLightbox(ka.image.data);
      });
    });
  }

  function renderCard(ka, query) {
    const sev      = SEV[ka.severidade] || SEV.aviso;
    const catLabel = CAT_LABEL[ka.categoria] || ka.categoria || '—';
    const dt       = ka.updatedAt || ka.createdAt;

    const hl = (str) => str ? hlText(escHtml(str), query) : '';

    const tags = (ka.tags || []).map(t =>
      `<span class="ka-card-tag">${hlText(escHtml(t), query)}</span>`
    ).join('');

    const escalarBlock = ka.escalar ? `
      <div class="ka-escalar-block">
        <div class="ka-escalar-label">⚠ Quando escalar / acionar sobreaviso</div>
        <div class="ka-escalar-text">${hl(ka.escalar)}</div>
      </div>` : '';

    // Badge de imagem (visível no card fechado)
    const imageBadge = (ka.image && ka.image.data)
      ? `<span class="badge-ka-image btn-ka-lightbox" data-id="${ka.id}" title="Ver imagem de referência">📷 Imagem</span>`
      : '';

    // Bloco de imagem nos detalhes
    const imageBlock = (ka.image && ka.image.data) ? `
      <div class="ka-image-block">
        <div class="ka-image-block-label">📷 Imagem de referência</div>
        <img class="ka-image-thumb btn-ka-lightbox"
             src="${ka.image.data}"
             data-id="${ka.id}"
             alt="Imagem de referência do alerta"
             title="Clique para ampliar">
      </div>` : '';

    return `
    <div class="ka-card ${sev.cls}">
      <div class="ka-card-header">
        <div class="ka-card-left">
          <div class="ka-card-meta">
            <span class="${sev.badge}">${sev.label}</span>
            <span class="badge-ka-cat">${escHtml(catLabel)}</span>
            ${ka.ferramenta ? `<span class="badge-ka-tool">${escHtml(ka.ferramenta)}</span>` : ''}
            <span style="font-size:11px;color:var(--text-dim)">${escHtml(ka.id)}</span>
            ${imageBadge}
          </div>
          <div class="ka-card-nome">${hl(ka.nome)}</div>
          ${ka.descricao ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px;line-height:1.5">${hl(ka.descricao)}</div>` : ''}
        </div>
        <div class="ka-card-right">
          <div class="ka-expand-hint">detalhes</div>
          <div class="ka-card-actions">
            <button class="btn btn-ghost btn-sm btn-ka-edit"   data-id="${ka.id}" title="Editar">✎</button>
            <button class="btn btn-danger btn-sm btn-ka-delete" data-id="${ka.id}" title="Excluir">✕</button>
          </div>
        </div>
      </div>

      <div class="ka-card-summary">
        <div class="ka-card-field">
          <span class="ka-card-field-label">Causa provável</span>
          <span class="ka-card-field-value" title="${escHtml(ka.causa)}">${hl(ka.causa)}</span>
        </div>
        <div class="ka-card-field">
          <span class="ka-card-field-label">Ação recomendada</span>
          <span class="ka-card-field-value" title="${escHtml(ka.acao)}">${hl(ka.acao)}</span>
        </div>
      </div>

      <div class="ka-card-details">
        ${imageBlock}
        <div class="ka-acao-block">
          <div class="ka-acao-label">Ação recomendada completa</div>
          <div class="ka-acao-text">${hl(ka.acao)}</div>
        </div>

        <div class="ka-detail-grid">
          <div class="ka-detail-field">
            <span class="ka-detail-label">Causa provável</span>
            <span class="ka-detail-value">${hl(ka.causa)}</span>
          </div>
          <div class="ka-detail-field">
            <span class="ka-detail-label">Categoria</span>
            <span class="ka-detail-value">${escHtml(catLabel)}</span>
          </div>
          ${ka.descricao ? `
          <div class="ka-detail-field" style="grid-column:span 2">
            <span class="ka-detail-label">Contexto / descrição</span>
            <span class="ka-detail-value">${hl(ka.descricao)}</span>
          </div>` : ''}
        </div>

        ${escalarBlock}
        ${tags ? `<div class="ka-card-tags">${tags}</div>` : ''}

        <div class="ka-card-footer">
          <span class="ka-card-datetime">🕒 ${formatDt(dt)}</span>
        </div>
      </div>
    </div>`;
  }

  // ─────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────
  function updateStats() {
    const counts = { aviso:0, medio:0, alto:0, desastre:0 };
    knownAlerts.forEach(a => { if (counts[a.severidade] !== undefined) counts[a.severidade]++; });
    const el = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    el('kastat-aviso',    counts.aviso);
    el('kastat-medio',    counts.medio);
    el('kastat-alto',     counts.alto);
    el('kastat-desastre', counts.desastre);
  }

  function updateKaBadge() {
    const badge = document.getElementById('tab-kb-count');
    if (badge) badge.textContent = knownAlerts.length;
  }

  // ─────────────────────────────────────────
  // SEED — exemplos iniciais
  // ─────────────────────────────────────────
  function getSeedAlerts() {
    const now = new Date().toISOString();
    return [
      {
        id: 'KA-001', nome: 'CPU acima de 90% em servidor de aplicação',
        descricao: 'Alerta disparado quando uso de CPU ultrapassa 90% por mais de 5 minutos consecutivos.',
        causa: 'Query SQL sem índice causando full table scan; processo descontrolado; pico de acessos simultâneos; cron job conflitante.',
        acao: '1. Identifique o processo top consumer: top -c ou htop\n2. Verifique queries longas: SELECT * FROM pg_stat_activity WHERE state = \'active\'\n3. Faça kill do processo/query se necessário\n4. Notifique o time de desenvolvimento se for query recorrente\n5. Monitore por 15 min após intervenção',
        escalar: 'Se CPU permanecer acima de 95% por mais de 10 min após intervenção, ou se houver impacto direto ao usuário final.',
        severidade: 'alto', categoria: 'ti', ferramenta: 'Zabbix',
        tags: ['CPU','performance','servidor'], createdAt: now
      },
      {
        id: 'KA-002', nome: 'Disco com ocupação acima de 85%',
        descricao: 'Monitoramento de ocupação de disco. Alerta em 85%, crítico em 95%.',
        causa: 'Logs rotativos não configurados; crescimento de base de dados; backups antigos acumulados; core dumps não removidos.',
        acao: '1. Identifique o maior consumidor: du -sh /* | sort -rh | head -20\n2. Limpe logs antigos: find /var/log -name "*.log" -mtime +30 -delete\n3. Remova core dumps: find / -name "core" -delete\n4. Verifique e purge backups antigos\n5. Configure logrotate se necessário',
        escalar: 'Se disco ultrapassar 95% ou se houver risco de parada de serviço por falta de espaço.',
        severidade: 'medio', categoria: 'sustentacao', ferramenta: 'Grafana',
        tags: ['disco','storage','logs'], createdAt: now
      },
      {
        id: 'KA-003', nome: 'Host inacessível (ICMP timeout)',
        descricao: 'Servidor não responde a ping por mais de 3 minutos consecutivos.',
        causa: 'Servidor desligado ou travado; falha de rede no segmento; firewall bloqueando ICMP; sobrecarga extrema de CPU/memória.',
        acao: '1. Tente acesso via SSH para confirmar\n2. Verifique conectividade de outros hosts no mesmo segmento\n3. Confirme status físico do equipamento com a equipe de infra\n4. Verifique logs do switch de acesso\n5. Se necessário, acione reinicialização via IPMI/iDRAC',
        escalar: 'Acionar sobreaviso imediatamente se for servidor de produção crítico ou se múltiplos hosts do mesmo segmento estiverem inacessíveis.',
        severidade: 'desastre', categoria: 'redes', ferramenta: 'Zabbix',
        tags: ['host','ping','rede','inacessível'], createdAt: now
      },
      {
        id: 'KA-004', nome: 'Certificado SSL expirando em menos de 30 dias',
        descricao: 'Alerta preventivo de expiração de certificado SSL/TLS.',
        causa: 'Processo de renovação automática falhou; certificado não configurado para renovação automática; mudança de provedor.',
        acao: '1. Verifique a data exata: openssl s_client -connect host:443 | openssl x509 -noout -dates\n2. Renove via certbot: certbot renew --force-renewal\n3. Ou renove manualmente junto ao provedor de certificados\n4. Reinicie o serviço web após renovação\n5. Confirme renovação e configure alertas com antecedência maior',
        escalar: 'Se certificado expirar em menos de 7 dias e renovação automática não estiver funcionando.',
        severidade: 'aviso', categoria: 'seguranca', ferramenta: 'PRTG',
        tags: ['SSL','certificado','segurança','HTTPS'], createdAt: now
      },
      {
        id: 'KA-005', nome: 'Latência de banco de dados acima de 500ms',
        descricao: 'Tempo de resposta de queries ultrapassando o threshold aceitável.',
        causa: 'Lock de tabelas; query sem índice; conexões esgotadas; I/O de disco saturado; estatísticas desatualizadas.',
        acao: '1. Verifique queries lentas: SELECT * FROM pg_stat_activity WHERE state = \'active\' ORDER BY duration\n2. Identifique locks: SELECT * FROM pg_locks JOIN pg_stat_activity USING (pid)\n3. Faça EXPLAIN ANALYZE na query problemática\n4. Verifique conexões ativas vs max_connections\n5. Se necessário, mate a query: SELECT pg_terminate_backend(pid)',
        escalar: 'Se latência ultrapassar 2 segundos ou se houver erro de conexão recusada para os sistemas.',
        severidade: 'alto', categoria: 'banco-de-dados', ferramenta: 'Datadog',
        tags: ['banco','latência','query','PostgreSQL'], createdAt: now
      }
    ];
  }

  // ─────────────────────────────────────────
  // UTILITÁRIOS
  // ─────────────────────────────────────────
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function hlText(text, query) {
    if (!query) return text;
    return text.replace(
      new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
      '<mark class="ka-highlight">$1</mark>'
    );
  }

  function formatDt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', {
      day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
    });
  }

  function showToastKa(msg, type) {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    console.log(`[KA] ${type}: ${msg}`);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // Exporta knownAlerts para o sync.js poder incluir no backup
  function getData()    { return knownAlerts; }
  function setData(arr) { knownAlerts = arr; save(); renderList(); updateStats(); updateKaBadge(); }

  // ─────────────────────────────────────────
  // API PÚBLICA
  // ─────────────────────────────────────────
  return { init, getData, setData, updateKaBadge };

})();

// Inicia quando DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => NOC_KA.init());
} else {
  NOC_KA.init();
}
