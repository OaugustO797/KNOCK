/**
 * KNOCK — Módulo Supabase Client
 * supabase-client.js
 *
 * Gerencia conexão, autenticação e sincronização de dados.
 * Padrão IIFE — não interfere nos outros módulos.
 * Fallback automático para localStorage se offline.
 */

const KNOCK_DB = (() => {

  // ─────────────────────────────────────────
  // CONFIGURAÇÃO
  // ─────────────────────────────────────────
  const SUPABASE_URL = 'https://bqlnlddguptlggngdtcl.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxbG5sZGRndXB0bGdnbmdkdGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3NTgxNTQsImV4cCI6MjA5NTMzNDE1NH0.dqHnbasOwfPTJXK7RbK7gih4q0iySWAMX5zNNIr6dW4';

  let _client  = null;
  let _session = null;
  let _online  = false;

  // ─────────────────────────────────────────
  // INICIALIZAR CLIENTE SUPABASE
  // ─────────────────────────────────────────
  async function init() {
    // Carrega o SDK do Supabase (CDN)
    if (!window.supabase) {
      await loadSDK();
    }
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession:    true,
        autoRefreshToken:  true,
        detectSessionInUrl: true,
        storageKey: 'knock_auth_token',
      }
    });

    // Verifica sessão existente
    const { data: { session } } = await _client.auth.getSession();
    _session = session;
    _online  = !!session;

    // Listener de mudanças de auth
    _client.auth.onAuthStateChange((event, session) => {
      _session = session;
      _online  = !!session;
      if (event === 'SIGNED_IN')  window.dispatchEvent(new CustomEvent('knock:signed_in',  { detail: session }));
      if (event === 'SIGNED_OUT') window.dispatchEvent(new CustomEvent('knock:signed_out'));
    });

    return _online;
  }

  function loadSDK() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ─────────────────────────────────────────
  // AUTH — LOGIN / LOGOUT
  // ─────────────────────────────────────────
  async function signIn(email, password) {
    if (!_client) await init();
    const { data, error } = await _client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    _session = data.session;
    _online  = true;
    return data.user;
  }

  async function signOut() {
    if (!_client) return;
    await _client.auth.signOut();
    _session = null;
    _online  = false;
  }

  async function getUser() {
    if (!_client) return null;
    const { data: { user } } = await _client.auth.getUser();
    return user;
  }

  // Verifica se o usuário está na lista de aprovados
  async function isApproved(email) {
    if (!_client || !_session) return false;
    const { data, error } = await _client
      .from('approved_users')
      .select('id, name, role, active')
      .eq('email', email)
      .eq('active', true)
      .single();
    if (error || !data) return false;
    return data;
  }

  // ─────────────────────────────────────────
  // HELPERS DE API
  // ─────────────────────────────────────────
  function headers() {
    const h = {
      'apikey':       SUPABASE_KEY,
      'Content-Type': 'application/json',
    };
    if (_session?.access_token) {
      h['Authorization'] = `Bearer ${_session.access_token}`;
    }
    return h;
  }

  async function apiFetch(path, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Erro ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ─────────────────────────────────────────
  // INCIDENTES
  // ─────────────────────────────────────────
  const incidents = {
    async list() {
      return apiFetch('incidents?order=datahora.desc&limit=500');
    },
    async upsert(incident) {
      const user = await getUser();
      // Normaliza camelCase → snake_case e remove campos desconhecidos pelo banco
      const payload = {
        id:         incident.id,
        problema:   incident.problema,
        sintoma:    incident.sintoma,
        causa:      incident.causa,
        acao:       incident.acao,
        status:     incident.status || 'em andamento',
        ferramenta: incident.ferramenta || null,
        tags:       JSON.stringify(incident.tags || []),
        datahora:   incident.datahora || new Date().toISOString(),
        created_by: incident.created_by || user?.email || 'sistema',
      };
      return apiFetch('incidents', {
        method:  'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body:    JSON.stringify(payload),
      });
    },
    async remove(id) {
      return apiFetch(`incidents?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    // Sincroniza o localStorage com o Supabase
    async syncFromLocal() {
      try {
        const local = JSON.parse(localStorage.getItem('noc_incidents') || '[]');
        if (!local.length) return;
        for (const inc of local) {
          await incidents.upsert(inc);
        }
        console.log(`[KNOCK] ${local.length} incidentes sincronizados`);
      } catch(e) {
        console.warn('[KNOCK] Falha na sincronização de incidentes:', e.message);
      }
    }
  };

  // ─────────────────────────────────────────
  // AVISOS
  // ─────────────────────────────────────────
  const alerts = {
    async list() {
      return apiFetch('alerts?order=datahora.desc&limit=200');
    },
    async upsert(alert) {
      const user = await getUser();
      const payload = {
        id:          alert.id,
        titulo:      alert.titulo,
        descricao:   alert.descricao   || null,
        tipo:        alert.tipo        || 'geral',
        severidade:  alert.severidade  || 'info',
        turno:       alert.turno       || null,
        responsavel: alert.responsavel || null,
        tags:        JSON.stringify(alert.tags || []),
        acks:        JSON.stringify(alert.acks || []),
        aberto:      alert.aberto !== undefined ? alert.aberto : true,
        datahora:    alert.datahora || new Date().toISOString(),
        created_by:  alert.created_by || user?.email || 'sistema',
      };
      return apiFetch('alerts', {
        method:  'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body:    JSON.stringify(payload),
      });
    },
    async remove(id) {
      return apiFetch(`alerts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async syncFromLocal() {
      try {
        const local = JSON.parse(localStorage.getItem('noc_alerts') || '[]');
        if (!local.length) return;
        for (const a of local) { await alerts.upsert(a); }
        console.log(`[KNOCK] ${local.length} avisos sincronizados`);
      } catch(e) {
        console.warn('[KNOCK] Falha na sincronização de avisos:', e.message);
      }
    }
  };

  // ─────────────────────────────────────────
  // ALERTAS CONHECIDOS
  // ─────────────────────────────────────────
  const knownAlerts = {
    async list() {
      return apiFetch('known_alerts?order=created_at.desc&limit=500');
    },
    async upsert(ka) {
      const user = await getUser();
      // Remove campos camelCase que não existem no banco
      // O banco usa created_at e updated_at (gerenciados automaticamente)
      const payload = {
        id:         ka.id,
        nome:       ka.nome,
        descricao:  ka.descricao  || null,
        causa:      ka.causa,
        acao:       ka.acao,
        escalar:    ka.escalar    || null,
        severidade: ka.severidade || 'aviso',
        categoria:  ka.categoria  || null,
        ferramenta: ka.ferramenta || null,
        tags:       JSON.stringify(ka.tags  || []),
        image:      ka.image ? JSON.stringify(ka.image) : null,
        created_by: ka.created_by || user?.email || 'sistema',
        // Preserva created_at se vier do banco, senão deixa o banco gerar
        ...(ka.created_at  ? { created_at:  ka.created_at  } : {}),
        ...(ka.updated_at  ? { updated_at:  ka.updated_at  } : {}),
        // Ignora createdAt / updatedAt (camelCase do localStorage)
      };
      return apiFetch('known_alerts', {
        method:  'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body:    JSON.stringify(payload),
      });
    },
    async remove(id) {
      return apiFetch(`known_alerts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async syncFromLocal() {
      try {
        const local = JSON.parse(localStorage.getItem('noc_known_alerts') || '[]');
        if (!local.length) return;
        for (const ka of local) { await knownAlerts.upsert(ka); }
        console.log(`[KNOCK] ${local.length} alertas conhecidos sincronizados`);
      } catch(e) {
        console.warn('[KNOCK] Falha na sincronização de alertas conhecidos:', e.message);
      }
    }
  };

  // ─────────────────────────────────────────
  // SINCRONIZAÇÃO COMPLETA
  // Carrega dados do Supabase e atualiza localStorage
  // ─────────────────────────────────────────
  async function syncAll() {
    if (!_online) return false;
    try {
      const [inc, alts, kas] = await Promise.all([
        incidents.list(),
        alerts.list(),
        knownAlerts.list(),
      ]);

      // Normaliza tags/acks que vêm como string do Postgres
      const parseJson = (arr, fields) => (arr || []).map(item => {
        const out = { ...item };
        fields.forEach(f => {
          if (typeof out[f] === 'string') {
            try { out[f] = JSON.parse(out[f]); } catch(e) { out[f] = []; }
          }
        });
        return out;
      });

      const incNorm  = parseJson(inc,  ['tags']);
      const altsNorm = parseJson(alts, ['tags', 'acks']);
      const kasNorm  = parseJson(kas,  ['tags', 'image']);

      // Salva no localStorage (usado pelos módulos existentes)
      localStorage.setItem('noc_incidents',   JSON.stringify(incNorm));
      localStorage.setItem('noc_alerts',      JSON.stringify(altsNorm));
      localStorage.setItem('noc_known_alerts',JSON.stringify(kasNorm));

      console.log(`[KNOCK] Sync OK — ${incNorm.length} inc / ${altsNorm.length} avisos / ${kasNorm.length} alertas`);
      return { incidents: incNorm, alerts: altsNorm, knownAlerts: kasNorm };
    } catch(e) {
      console.warn('[KNOCK] Sync falhou, usando localStorage:', e.message);
      return false;
    }
  }

  // ─────────────────────────────────────────
  // STATUS
  // ─────────────────────────────────────────
  function isOnline()  { return _online; }
  function getSession(){ return _session; }

  // ─────────────────────────────────────────
  // API PÚBLICA
  // ─────────────────────────────────────────
  return {
    init,
    signIn,
    signOut,
    getUser,
    isApproved,
    isOnline,
    getSession,
    syncAll,
    incidents,
    alerts,
    knownAlerts,
  };

})();
