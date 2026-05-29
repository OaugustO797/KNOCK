/**
 * KNOCK — Módulo de Autenticação
 * auth.js
 *
 * Gerencia tela de login, verificação de usuário aprovado,
 * indicador de status de conexão e logout.
 * Carregado após supabase-client.js e script.js.
 */

const KNOCK_AUTH = (() => {

  let _userInfo = null; // { email, name, role }

  // ─────────────────────────────────────────
  // INICIALIZAÇÃO
  // ─────────────────────────────────────────
  async function init() {
    await KNOCK_DB.init();

    const user = await KNOCK_DB.getUser();

    if (user) {
      // Sessão ativa — verifica aprovação
      await handleLoggedIn(user);
    } else {
      // Sem sessão — mostra tela de login
      showLoginScreen();
    }

    // Escuta eventos de auth
    window.addEventListener('knock:signed_in',  (e) => handleLoggedIn(e.detail?.user));
    window.addEventListener('knock:signed_out', ()  => showLoginScreen());
  }

  // ─────────────────────────────────────────
  // PÓS-LOGIN — verifica aprovação e carrega app
  // ─────────────────────────────────────────
  async function handleLoggedIn(user) {
    if (!user?.email) { showLoginScreen(); return; }

    // Verifica se está na lista de aprovados
    const approved = await KNOCK_DB.isApproved(user.email);
    if (!approved) {
      await KNOCK_DB.signOut();
      showLoginScreen('Acesso não autorizado. Solicite ao administrador.');
      return;
    }

    _userInfo = { email: user.email, name: approved.name || user.email, role: approved.role };

    // Esconde login, mostra app
    hideLoginScreen();
    injectUserUI();

    // Sincroniza dados do Supabase → localStorage
    const syncResult = await KNOCK_DB.syncAll();
    if (syncResult) {
      // Atualiza variáveis globais do script.js diretamente
      if (typeof incidents !== 'undefined' && Array.isArray(syncResult.incidents)) {
        incidents.length = 0;
        syncResult.incidents.forEach(i => incidents.push(i));
      }
      if (typeof alerts !== 'undefined' && Array.isArray(syncResult.alerts)) {
        alerts.length = 0;
        syncResult.alerts.forEach(a => alerts.push(a));
      }
      // Recarrega a UI com os dados atualizados
      if (typeof refreshAll === 'function') refreshAll();
      // Notifica módulos independentes (alertas-conhecidos.js)
      window.dispatchEvent(new CustomEvent('knock:synced', { detail: syncResult }));
      showSyncBadge('online');
    } else {
      showSyncBadge('offline');
    }

    // Configura auto-save: intercepta saves do script.js
    setupAutoSave();
  }

  // ─────────────────────────────────────────
  // TELA DE LOGIN
  // ─────────────────────────────────────────
  function showLoginScreen(errorMsg) {
    // Remove app se estiver visível
    const app = document.getElementById('screen-app');
    const home = document.getElementById('screen-home');
    if (app)  app.style.display  = 'none';
    if (home) home.style.display = 'none';

    // Cria/atualiza overlay de login
    let overlay = document.getElementById('knock-login-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'knock-login-overlay';
      document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
      <div class="knock-login-bg"></div>
      <div class="knock-login-box">

        <div class="knock-login-logo">
          <span class="logo-k">K</span><span class="logo-n">N</span><span class="logo-o">O</span><span class="logo-c">C</span><span class="logo-k2">K</span>
        </div>
        <div class="knock-login-title">Knowledge Network Operations Center Kernel</div>
        <div class="knock-login-sub">Faça login para acessar o sistema</div>

        ${errorMsg ? `<div class="knock-login-error">${escHtml(errorMsg)}</div>` : ''}

        <form id="knock-login-form" class="knock-login-form" autocomplete="off">
          <div class="knock-field-group">
            <label class="knock-label">E-mail corporativo</label>
            <input type="email" id="knock-email" class="knock-input"
              placeholder="seu@empresa.com" required autocomplete="email">
          </div>
          <div class="knock-field-group">
            <label class="knock-label">Senha</label>
            <div class="knock-pw-wrap">
              <input type="password" id="knock-password" class="knock-input"
                placeholder="••••••••" required autocomplete="current-password">
              <button type="button" class="knock-pw-toggle" id="knock-pw-toggle" title="Mostrar senha">👁</button>
            </div>
          </div>
          <button type="submit" class="knock-btn-login" id="knock-btn-login">
            Entrar no KNOCK
          </button>
          <div class="knock-login-footer-msg">
            Acesso restrito. Solicite ao administrador se precisar de acesso.
          </div>
        </form>

        <div class="knock-login-status" id="knock-login-status"></div>
      </div>`;

    overlay.style.display = 'flex';

    // Eventos do form
    document.getElementById('knock-login-form').addEventListener('submit', handleLogin);
    document.getElementById('knock-pw-toggle').addEventListener('click', () => {
      const pw = document.getElementById('knock-password');
      pw.type = pw.type === 'password' ? 'text' : 'password';
    });

    // Foco no email
    setTimeout(() => document.getElementById('knock-email')?.focus(), 100);
  }

  function hideLoginScreen() {
    const overlay = document.getElementById('knock-login-overlay');
    if (overlay) overlay.style.display = 'none';

    // Mostra home
    const home = document.getElementById('screen-home');
    if (home) {
      home.style.display = 'flex';
      home.style.flexDirection = 'column';
    }
  }

  // ─────────────────────────────────────────
  // HANDLER DE LOGIN
  // ─────────────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault();
    const email    = document.getElementById('knock-email').value.trim();
    const password = document.getElementById('knock-password').value;
    const btn      = document.getElementById('knock-btn-login');
    const status   = document.getElementById('knock-login-status');

    btn.textContent = 'Entrando...';
    btn.disabled    = true;
    status.textContent = '';

    try {
      const user = await KNOCK_DB.signIn(email, password);
      await handleLoggedIn(user);
    } catch(err) {
      let msg = 'Erro ao entrar. Tente novamente.';
      if (err.message?.includes('Invalid login'))    msg = 'E-mail ou senha incorretos.';
      if (err.message?.includes('Email not confirmed')) msg = 'Confirme seu e-mail antes de entrar.';
      status.textContent = msg;
      status.style.color = 'var(--red)';
      btn.textContent    = 'Entrar no KNOCK';
      btn.disabled       = false;
    }
  }

  // ─────────────────────────────────────────
  // UI DO USUÁRIO NO TOPBAR
  // ─────────────────────────────────────────
  function injectUserUI() {
    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight) return;

    // Remove se já existir
    document.getElementById('knock-user-chip')?.remove();

    const chip = document.createElement('div');
    chip.id        = 'knock-user-chip';
    chip.className = 'knock-user-chip';
    chip.innerHTML = `
      <span class="knock-user-avatar">${(_userInfo.name || 'U')[0].toUpperCase()}</span>
      <span class="knock-user-name">${escHtml(_userInfo.name.split('@')[0])}</span>
      <button class="knock-logout-btn" id="knock-logout-btn" title="Sair">⏻</button>`;

    // Insere antes do botão de registrar
    const registerBtn = topbarRight.querySelector('.btn-primary');
    if (registerBtn) topbarRight.insertBefore(chip, registerBtn);
    else topbarRight.appendChild(chip);

    document.getElementById('knock-logout-btn').addEventListener('click', async () => {
      if (!confirm('Confirma saída do KNOCK?')) return;
      await KNOCK_DB.signOut();
    });
  }

  // ─────────────────────────────────────────
  // BADGE DE STATUS DE CONEXÃO
  // ─────────────────────────────────────────
  function showSyncBadge(mode) {
    const dot = document.querySelector('.status-dot');
    if (!dot) return;

    const syncEl = document.getElementById('knock-sync-badge') || (() => {
      const el = document.createElement('span');
      el.id = 'knock-sync-badge';
      dot.parentNode.insertBefore(el, dot.nextSibling);
      return el;
    })();

    if (mode === 'online') {
      syncEl.textContent  = '☁ Sincronizado';
      syncEl.style.color  = 'var(--green)';
      syncEl.style.fontSize = '11px';
      // Some após 4s
      setTimeout(() => { syncEl.textContent = ''; }, 4000);
    } else {
      syncEl.textContent  = '⚠ Offline — dados locais';
      syncEl.style.color  = 'var(--yellow)';
      syncEl.style.fontSize = '11px';
    }
  }

  // ─────────────────────────────────────────
  // AUTO-SAVE — intercepta saves dos módulos
  // Após cada operação local, replica no Supabase
  // ─────────────────────────────────────────
  function setupAutoSave() {
    // Monitora mudanças no localStorage e sincroniza com Supabase
    const originalSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(key, value) {
      originalSetItem(key, value);
      // Sincroniza de forma assíncrona sem bloquear a UI
      if (key === 'noc_incidents')    syncKey('incidents',   value);
      if (key === 'noc_alerts')       syncKey('alerts',      value);
      if (key === 'noc_known_alerts') syncKey('knownAlerts', value);
    };
  }

  // Debounce por chave para não disparar uma req por keystroke
  const syncDebounces = {};
  function syncKey(type, jsonValue) {
    if (!KNOCK_DB.isOnline()) return;
    clearTimeout(syncDebounces[type]);
    syncDebounces[type] = setTimeout(async () => {
      try {
        const items = JSON.parse(jsonValue || '[]');
        if (!items.length) return;
        const module = KNOCK_DB[type === 'knownAlerts' ? 'knownAlerts' : type];
        if (!module) return;
        // Upsert de todos os itens modificados
        for (const item of items) {
          await module.upsert(item);
        }
      } catch(e) {
        console.warn(`[KNOCK] Auto-save ${type} falhou:`, e.message);
      }
    }, 1500); // aguarda 1.5s após a última mudança
  }

  // ─────────────────────────────────────────
  // UTILITÁRIOS
  // ─────────────────────────────────────────
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getUser()  { return _userInfo; }
  function isAdmin()  { return _userInfo?.role === 'admin'; }

  // ─────────────────────────────────────────
  // API PÚBLICA
  // ─────────────────────────────────────────
  return { init, getUser, isAdmin };

})();

// Inicia quando DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => KNOCK_AUTH.init());
} else {
  KNOCK_AUTH.init();
}
