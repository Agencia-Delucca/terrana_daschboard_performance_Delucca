/* ============================================================
   Terrana — Dashboards de Performance (Agência Delucca)
   SPA estática: TELA SELETORA + dois painéis (B2B Atacado / E-commerce).
   Roteamento 100% por hash: "" → seletor · "#b2b/<pág>" · "#ecom/<pág>".
   Dados: window.__SUMMARY__ (data/summary.js) → fetch data/summary.json.
   Sem login, sem Supabase — autenticação entra numa fase futura.

   Redesign guiado pela skill dataviz:
   - Séries usam SÓ a paleta categórica validada (mostarda/terracota/oliva),
     em ordem fixa por entidade; acentos vivos da marca ficam na UI.
   - Sem eixo duplo: combos viraram small multiples empilhados no mesmo X.
   - Nominal = 1 cor (terracota); ordinal = rampa âmbar monotônica.
   - Terracota (2,99:1 no fundo) sempre com relief: rótulo direto ou tabela.
   - Texto nunca na cor da série; tooltip em tudo; animação off;
     registry de charts destruído a cada navegação (anti-leak).
   ============================================================ */
'use strict';

/* ---------- Estado global ---------- */
let DATA = null;                       // summary.json inteiro
const CHARTS = {};                     // registry Chart.js (anti-leak)
const FILTER = { start: null, end: null, preset: 'all' };
let DATA_MIN = null, DATA_MAX = null;
let CURRENT_FRONT = null;              // 'b2b' | 'ecom' | null (seletor)
let LAST_ROUTE = null;                 // 'front/página' — p/ só rolar ao topo em troca de página
let ECOM_PUB_VIEW = 'ecommerce';       // toggle da página Público do e-commerce

/* ---------- Paleta ----------
   UI (tokens da marca — nav, gradientes, KPI de destaque): P.*
   SÉRIES de dados (validadas pelo validador da skill dataviz): S.*
   Ordinal: AMBER_RAMP (um matiz, claro→escuro, monotônico)
   Status (ACTIVE/PAUSED, ganho/perda, avisos): ST.* — nunca séries. */
const P = {
  bgCard: '#1A120A',
  border: '#332415',
  track: '#241910',
  accent: '#E0A526',                   // acento vivo — UI apenas
  accent2: '#C9622A',                  // acento vivo — UI apenas
  muted: '#A28D74',
  soft: '#DECFB8',
  text: '#F7F1E6',
  accentLight: '#F2CC7B',
  grid: 'rgba(255,255,255,.05)'
};
const S = {
  mostarda: '#BD8A0C',
  terracota: '#A64114',
  oliva: '#74A335'
};
/* 6 passos: o antigo extremo #453107 reprovava no validador ordinal
   (1,49:1 sobre a superfície #1A120A — piso 2:1). Terminar em #684A0A
   mantém a rampa monotônica e passa todos os checks (2,27:1). */
const AMBER_RAMP = ['#F6DC9C', '#EEC25B', '#E0A526', '#B78312', '#8E650E', '#684A0A'];
const ST = { green: '#10B981', red: '#EF4444', amber: '#F59E0B' };

/* ============================================================
   Formatação (100% pt-BR)
   ============================================================ */
const fmt = {
  num: v => Math.round(v || 0).toLocaleString('pt-BR'),
  dec: (v, d = 1) => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }),
  currency: v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  moneyShort: v => 'R$ ' + Math.round(v || 0).toLocaleString('pt-BR'),
  pct: (v, d = 1) => v == null ? '—' : fmt.dec(v, d) + '%',
  roas: v => v == null ? '—' : fmt.dec(v, 2) + '×',
  date: iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '—',
  dateFull: iso => iso ? iso.split('-').reverse().join('/') : '—',
  days: v => v == null ? '—' : fmt.dec(v, 1) + 'd',
  mins: m => {
    if (m == null) return '—';
    if (m < 60) return fmt.dec(m, 0) + ' min';
    if (m < 1440) return fmt.dec(m / 60, 1) + ' h';
    return fmt.dec(m / 1440, 1) + ' d';
  }
};
const MESES3 = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
function mesLabel(m) {                 // '2026-07' -> 'Jul/26'
  if (!m) return '—';
  const p = m.split('-');
  return MESES3[parseInt(p[1], 10) - 1] + '/' + p[0].slice(2);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/* Só renderiza link se o permalink for https:// — esc() impede escapar do
   atributo, mas não bloquearia um scheme javascript: vindo do JSON. */
function safeHttpUrl(u) {
  if (typeof u !== 'string') return null;
  const t = u.trim();
  return /^https:\/\//i.test(t) ? t : null;
}
/* Dicionário sem Object.prototype: chaves vindas de nomes de campanha/etapa
   ("__proto__", "constructor", …) viram propriedades normais. */
function dict(src) {
  return Object.assign(Object.create(null), src || {});
}

/* ============================================================
   Utilitários de dados
   ============================================================ */
function inPeriod(d) { return !!d && d >= FILTER.start && d <= FILTER.end; }
function fdays(list, key = 'dia') { return (list || []).filter(r => inPeriod(r[key])); }
function sum(list, k) { return (list || []).reduce((a, r) => a + (r[k] || 0), 0); }
function monthInPeriod(m) {
  return !!m && m >= (FILTER.start || '').slice(0, 7) && m <= (FILTER.end || '').slice(0, 7);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayRange(a, b) {
  const out = [];
  let d = a, guard = 0;
  while (d <= b && guard++ < 4000) { out.push(d); d = addDays(d, 1); }
  return out;
}
/* Série diária zero-preenchida dentro da janela coberta pelos dados */
function dailySeries(rows, fields, key = 'dia') {
  const rowsP = fdays(rows, key);
  if (!rowsP.length) return null;
  let min = rowsP[0][key], max = rowsP[0][key];
  const idx = {};
  rowsP.forEach(r => {
    if (r[key] < min) min = r[key];
    if (r[key] > max) max = r[key];
    if (!idx[r[key]]) idx[r[key]] = {};
    fields.forEach(f => { idx[r[key]][f] = (idx[r[key]][f] || 0) + (r[f] || 0); });
  });
  const days = dayRange(min, max);
  const data = {};
  fields.forEach(f => { data[f] = days.map(d => idx[d] ? (idx[d][f] || 0) : 0); });
  return { days, labels: days.map(fmt.date), data };
}
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
function aggBy(rows, keyFn, fields) {
  const m = Object.create(null);          // nomes de campanha são dados externos
  (rows || []).forEach(r => {
    const k = keyFn(r);
    if (!m[k]) { m[k] = { __row: r }; fields.forEach(f => { m[k][f] = 0; }); }
    fields.forEach(f => { m[k][f] += r[f] || 0; });
  });
  return m;
}

/* ============================================================
   Builders de UI
   ============================================================ */
function kpi(label, value, sub, opts) {
  opts = opts || {};
  const cls = 'kpi' + (opts.hero ? ' hero' : '');
  const v = (value == null)
    ? '<div class="kpi-dash" title="sem dado"></div>'
    : '<div class="kpi-value' + (opts.teal ? ' teal' : '') + '">' + value + '</div>';
  return '<div class="' + cls + '"><div class="kpi-label">' + label + '</div>' + v +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
}
function card(title, sub, body) {
  return '<div class="card">' +
    (title ? '<div class="card-head"><h3>' + title + '</h3>' +
      (sub ? '<div class="card-sub">' + sub + '</div>' : '') + '</div>' : '') +
    body + '</div>';
}
function chartBox(id, cls) {
  return '<div class="chart-box ' + (cls || '') + '"><canvas id="' + id + '"></canvas></div>';
}
function chartCard(title, sub, canvasId, boxCls, extra) {
  return card(title, sub, chartBox(canvasId, boxCls) + (extra || ''));
}
/* Small multiples: 2 gráficos empilhados no MESMO eixo X (substitui eixo duplo) */
function multiChartCard(title, sub, idTop, idBottom, extra) {
  return card(title, sub,
    '<div class="chart-box multi"><canvas id="' + idTop + '"></canvas></div>' +
    '<div class="chart-box multi"><canvas id="' + idBottom + '"></canvas></div>' +
    (extra || ''));
}
function banner(kind, html) {
  return '<div class="banner ' + kind + '">' +
    (kind === 'amber' ? '<span class="b-ic">⚠</span>' : '') +
    '<div>' + html + '</div></div>';
}
/* Os 2 primeiros alertas do ETL são os banners âmbar padrão das páginas B2B;
   a Visão Geral B2B mostra a lista completa. (Os alertas descrevem CRM/UTM —
   não se aplicam ao painel E-commerce.) */
function qualityBanners(all) {
  const alertas = (DATA.relatorio && DATA.relatorio.alertas) || [];
  const list = all ? alertas : alertas.slice(0, 2);
  if (!list.length) return '';
  return '<div class="banners">' + list.map(a => banner('amber', esc(a.texto))).join('') + '</div>';
}
function emptyDashed(l1, l2) {
  return '<div class="empty-dashed"><div class="l1">' + l1 + '</div>' +
    (l2 ? '<div class="l2">' + l2 + '</div>' : '') + '</div>';
}
function tableWrap(headCells, rowsHtml) {
  return '<div class="table-wrap"><table><thead><tr>' +
    headCells.map(h => '<th' + (h.r ? ' class="r"' : '') + '>' + h.t + '</th>').join('') +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
/* Relief de acessibilidade: tabela dobrável sob o gráfico (exigida pelo
   validador para séries terracota sem rótulo em todo ponto). */
function reliefTable(headCells, rowsHtml) {
  return '<details class="tbl-relief"><summary>Ver tabela</summary>' +
    tableWrap(headCells, rowsHtml) + '</details>';
}
function dailyRelief(series, cols) {
  const rows = series.days.map((d, i) =>
    '<tr><td>' + fmt.dateFull(d) + '</td>' +
    cols.map(c => '<td class="r">' + c.f(series.data[c.k][i]) + '</td>').join('') + '</tr>').join('');
  return reliefTable([{ t: 'Dia' }].concat(cols.map(c => ({ t: c.t, r: 1 }))), rows);
}
function statusBadge(st) {
  if (st === 'ACTIVE') return '<span class="badge green">Ativo</span>';
  if (st === 'PAUSED') return '<span class="badge red">Pausado</span>';
  if (st) return '<span class="badge gray">' + esc(st) + '</span>';
  return '<span class="muted" title="status indisponível na API — não inferimos">—</span>';
}
function qualityBadge(custoLead, leads) {
  const target = (DATA.config && DATA.config.cpl_target_meta) || 0;
  if (!target || custoLead == null || (leads || 0) < 3) {
    return '<span class="badge gray" title="meta de custo/lead não definida ou base pequena">Dados insuf.</span>';
  }
  if (custoLead <= target) return '<span class="badge green">Bom</span>';
  return '<span class="badge red">Ruim</span>';
}
function periodLabel() {
  return fmt.dateFull(FILTER.start) + ' a ' + fmt.dateFull(FILTER.end);
}

/* ---------- Funil (rampa ordinal âmbar + terminais de status) ---------- */
function amberStep(i, n) {
  if (n <= 1) return AMBER_RAMP[2];
  const idx = Math.round(i * (AMBER_RAMP.length - 1) / (n - 1));
  return AMBER_RAMP[Math.min(idx, AMBER_RAMP.length - 1)];
}
function amberFg(hex) {
  return AMBER_RAMP.indexOf(hex) >= 4 ? '#F7F1E6' : '#241203';
}
function stageKinds() {
  const kinds = Object.create(null);      // etapa vem do CRM (dado externo)
  ((DATA.crm || {}).deals_minimal || []).forEach(d => {
    if (d.ganho) kinds[d.etapa] = 'won';
    else if (d.perdido) kinds[d.etapa] = 'lost';
  });
  return kinds;
}
function funnelPeriodStages() {
  const kinds = stageKinds();
  const order = ((DATA.crm || {}).funnel || []).slice().sort((a, b) => a.sort - b.sort);
  const deals = ((DATA.crm || {}).deals_minimal || []).filter(d => inPeriod(d.criado_em));
  const cnt = Object.create(null);
  deals.forEach(d => { cnt[d.etapa] = (cnt[d.etapa] || 0) + 1; });
  return {
    total: deals.length,
    stages: order.map(s => ({ etapa: s.etapa, total: cnt[s.etapa] || 0, kind: kinds[s.etapa] || null }))
  };
}
function funnelHtml(fp) {
  if (!fp.stages.length) return emptyDashed('Sem etapas de funil no CRM.', 'Verifique o pipeline no Kommo.');
  const max = Math.max.apply(null, fp.stages.map(s => s.total).concat([1]));
  const nProg = fp.stages.filter(s => !s.kind).length;
  const html = fp.stages.map((s, k) => {
    const w = s.total / max * 100;
    let pct = '';
    if (k > 0) {
      const prevProg = (function () {
        for (let j = k - 1; j >= 0; j--) if (!fp.stages[j].kind) return fp.stages[j].total;
        return null;
      })();
      pct = (prevProg && prevProg > 0) ? fmt.dec(s.total / prevProg * 100, 0) + '% da<br>anterior' : '—';
    }
    let cls = '', style = 'width:' + w + '%';
    if (!s.kind) {
      const progIdx = fp.stages.slice(0, k).filter(x => !x.kind).length;
      const bg = amberStep(progIdx, nProg);
      style += ';background:' + bg + ';color:' + amberFg(bg);
    } else {
      cls = s.kind === 'won' ? ' won' : ' lost';
    }
    return '<div class="funnel-row">' +
      '<div class="f-label">' + esc(s.etapa) + '</div>' +
      '<div class="f-track"><div class="f-bar' + cls + '" style="' + style + '">' + fmt.num(s.total) + '</div></div>' +
      '<div class="f-pct">' + pct + '</div></div>';
  }).join('');
  return '<div class="funnel">' + html + '</div>';
}

/* ============================================================
   Chart.js — defaults, registry, plugin de rótulo direto
   ============================================================ */
function chartsReady() { return typeof Chart !== 'undefined'; }

/* Rótulos diretos seletivos, desenhados em creme/soft (texto nunca na cor
   da série). options.plugins.directLabels = { mode:'all'|'max', format, datasets } */
const directLabelsPlugin = {
  id: 'directLabels',
  // Sem opções "scriptable": o resolver do Chart.js chamaria format() com o
  // contexto como argumento — lemos a config CRUA para preservar a função.
  descriptors: { _scriptable: false, _indexable: false },
  afterDatasetsDraw(chart) {
    const o = ((chart.config.options || {}).plugins || {}).directLabels;
    if (!o || !o.mode) return;
    const ctx = chart.ctx;
    const horizontal = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.font = "600 10.5px 'Montserrat','Segoe UI',sans-serif";
    ctx.fillStyle = P.soft;
    chart.data.datasets.forEach((ds, di) => {
      if (o.datasets && o.datasets.indexOf(di) < 0) return;
      const meta = chart.getDatasetMeta(di);
      if (!meta || meta.hidden) return;
      let idxs = [];
      if (o.mode === 'all') {
        idxs = ds.data.map((v, i) => i).filter(i => ds.data[i] != null);
      } else { // 'max': só o extremo de cada série (rótulo seletivo)
        let best = -1, bv = -Infinity;
        ds.data.forEach((v, i) => { if (v != null && v > bv) { bv = v; best = i; } });
        if (best >= 0) idxs = [best];
      }
      idxs.forEach(i => {
        const el = meta.data[i];
        if (!el) return;
        const v = ds.data[i];
        const txt = o.format ? o.format(v) : fmt.num(v);
        if (horizontal) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, el.x + 6, el.y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(txt, el.x, el.y - 5);
        }
      });
    });
    ctx.restore();
  }
};

function setupChartDefaults() {
  if (!chartsReady()) return;
  Chart.register(directLabelsPlugin);
  Chart.defaults.color = P.muted;
  Chart.defaults.borderColor = P.grid;
  Chart.defaults.font.family = "'Montserrat','Segoe UI',system-ui,-apple-system,Roboto,sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.animation = false;
  Chart.defaults.locale = 'pt-BR';
  Chart.defaults.plugins.tooltip.backgroundColor = P.bgCard;
  Chart.defaults.plugins.tooltip.borderColor = P.border;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = P.text;
  Chart.defaults.plugins.tooltip.bodyColor = P.soft;
  Chart.defaults.plugins.tooltip.padding = 10;
}
function destroyAllCharts() {
  Object.keys(CHARTS).forEach(id => {
    try { CHARTS[id].destroy(); } catch (e) { /* noop */ }
    delete CHARTS[id];
  });
}
function makeChart(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!chartsReady()) {
    el.parentElement.innerHTML = emptyDashed('Chart.js não carregou.', 'Verifique a conexão com o CDN e recarregue.');
    return;
  }
  if (CHARTS[id]) { try { CHARTS[id].destroy(); } catch (e) { /* noop */ } delete CHARTS[id]; }
  CHARTS[id] = new Chart(el, config);
}
function legendTop() {
  return {
    display: true, position: 'top', align: 'center',
    labels: { boxWidth: 22, boxHeight: 12, color: P.soft, padding: 14, usePointStyle: false }
  };
}
function xDaily() {
  return {
    grid: { display: false },
    ticks: { color: P.muted, maxRotation: 45, minRotation: 45, autoSkip: true, maxTicksLimit: 26 }
  };
}
function xCat(extra) {
  // maxRotation/minRotation 0 desfazem a rotação de 45° herdada de xDaily()
  const o = { grid: { display: false }, ticks: { color: P.muted, maxRotation: 0, minRotation: 0 } };
  return deepMerge(o, extra || {});
}
function yCount(extra) {
  const o = {
    beginAtZero: true,
    grid: { color: P.grid, drawTicks: false },
    ticks: { color: P.muted }
  };
  return deepMerge(o, extra || {});
}
function yMoney(extra) {
  return yCount(deepMerge({ ticks: { callback: v => 'R$ ' + Number(v).toLocaleString('pt-BR') } }, extra || {}));
}
/* Nos small multiples, trava a largura do eixo Y para os dois gráficos
   ficarem alinhados no mesmo X mesmo com escalas diferentes. */
function lockYWidth(scaleOpts, w) {
  scaleOpts.afterFit = s => { s.width = w || 64; };
  return scaleOpts;
}
function moneyTooltip() {
  return {
    label: ctx => {
      // Barra horizontal (indexAxis 'y'): valor em parsed.x.
      const v = ctx.chart.options.indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y;
      return (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + fmt.currency(v);
    }
  };
}
function baseOpts(extra) {
  const o = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },   // área de hover > marca
    plugins: { legend: { display: false } },
    scales: { x: xDaily(), y: yCount() }
  };
  return deepMerge(o, extra || {});
}
function deepMerge(a, b) {
  Object.keys(b).forEach(k => {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
      deepMerge(a[k], b[k]);
    } else {
      a[k] = b[k];
    }
  });
  return a;
}
/* Datasets padrão (marcas finas: barra ≤24px, canto 4px só na ponta,
   linha 2px, marcador ≥8px de área de acerto) */
function barDs(label, data, color, extra) {
  return deepMerge({
    label, data, backgroundColor: color,
    borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 24
  }, extra || {});
}
function lineDs(label, data, color, extra) {
  return deepMerge({
    label, data, borderColor: color, backgroundColor: color + '1A', // wash ~10%
    borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: .3
  }, extra || {});
}

/* ============================================================
   Frentes, páginas e roteamento por hash
   "" → seletor · "#b2b/<pág>" · "#ecom/<pág>"
   ============================================================ */
const FRONTS = {
  b2b: {
    key: 'b2b',
    title: 'Terrana B2B Atacado',
    badge: 'B2B Atacado',
    badgeSub: 'leads e funil de vendas no atacado',
    pages: [
      { id: 'visao', label: 'Visão Geral', ic: '📊', render: renderVisaoB2B },
      { id: 'funil', label: 'Funil CRM', ic: '🎯', render: renderFunilCRM },
      { id: 'atendimento', label: 'Atendimento', ic: '💬', render: renderAtendimento },
      { id: 'meta', label: 'Meta Ads', ic: '📱', render: renderMetaB2B },
      { id: 'google', label: 'Google Ads', ic: '🔍', render: el => renderGoogleAds(el, 'b2b') },
      { id: 'publico', label: 'Público', ic: '👥', render: el => renderPublico(el, 'b2b') },
      { id: 'evolucao', label: 'Evolução Mensal', ic: '📈', render: renderEvolucaoB2B },
      { id: 'utm', label: 'Rastreamento (UTM)', ic: '🧭', render: renderUTM }
    ]
  },
  ecom: {
    key: 'ecom',
    title: 'Terrana E-commerce',
    badge: 'E-commerce',
    badgeSub: 'loja online e venda direta',
    pages: [
      { id: 'visao', label: 'Visão Geral', ic: '📊', render: renderVisaoEcom },
      { id: 'meta', label: 'Meta Ads', ic: '📱', render: renderMetaEcom },
      { id: 'google', label: 'Google Ads', ic: '🔍', render: el => renderGoogleAds(el, 'ecom') },
      { id: 'institucional', label: 'Institucional & Impulsionamento', ic: '📣', render: renderInstitucional },
      { id: 'publico', label: 'Público', ic: '👥', render: el => renderPublico(el, 'ecom') },
      { id: 'evolucao', label: 'Evolução Mensal', ic: '📈', render: renderEvolucaoEcom }
    ]
  }
};
function parseHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  if (!h) return { front: null, page: null };
  const seg = h.split('/');
  const f = FRONTS[seg[0]];
  if (!f) return { front: null, page: null };
  const page = f.pages.some(p => p.id === seg[1]) ? seg[1] : f.pages[0].id;
  return { front: seg[0], page };
}
function applyFront(frontKey) {
  CURRENT_FRONT = frontKey;
  const f = FRONTS[frontKey];
  document.getElementById('front-name').textContent = f.badge;
  document.getElementById('front-sub').textContent = f.badgeSub;
  document.getElementById('nav').innerHTML = f.pages.map(p =>
    '<a href="#' + f.key + '/' + p.id + '" data-page="' + p.id + '"><span class="ic">' + p.ic + '</span><span>' + p.label + '</span></a>').join('');
  document.getElementById('foot-front').textContent = f.title;
}
function route() {
  if (!DATA) return;
  destroyAllCharts();
  const r = parseHash();
  // Só rola ao topo quando a PÁGINA muda — re-render por filtro de período
  // ou toggle mantém a posição de leitura do usuário.
  const routeKey = r.front ? r.front + '/' + r.page : '';
  const pageChanged = routeKey !== LAST_ROUTE;
  LAST_ROUTE = routeKey;
  document.body.classList.toggle('mode-select', !r.front);
  if (!r.front) {
    CURRENT_FRONT = null;
    document.title = 'Terrana — Dashboards de Performance · Agência Delucca';
    renderSelector();
    if (pageChanged) window.scrollTo(0, 0);
    return;
  }
  if (r.front !== CURRENT_FRONT) applyFront(r.front);
  const f = FRONTS[r.front];
  const page = f.pages.find(p => p.id === r.page);
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page.id));
  document.getElementById('page-title').textContent = f.title + ' · ' + page.label;
  document.title = f.title + ' · ' + page.label + ' — Agência Delucca';
  page.render(document.getElementById('content'));
  if (pageChanged) window.scrollTo(0, 0);
}

/* ============================================================
   TELA SELETORA — página de entrada
   ============================================================ */
function renderSelector() {
  const el = document.getElementById('selector');
  const logo = document.querySelector('.brand-mark');
  const leadsCrm = (DATA.leads || {}).total || 0;
  const gastoB2B = (DATA.meta_b2b || {}).total_gasto || 0;
  const pagos = (DATA.leads || {}).pagos || 0;
  const cplCrm = (gastoB2B > 0 && pagos > 0) ? gastoB2B / pagos : null;
  const ecomM = (DATA.meta_ecom || {}).monthly || [];
  const compras = sum(ecomM, 'compras');
  const receita = sum(ecomM, 'valor_compras');
  const gastoEcom = (DATA.meta_ecom || {}).total_gasto || 0;
  const roas = gastoEcom > 0 ? receita / gastoEcom : null;

  el.innerHTML =
    '<div class="sel-inner">' +
    (logo ? '<img class="sel-logo" src="' + logo.src + '" alt="Terrana">' : '') +
    '<h1 class="sel-title">Terrana — Dashboards de Performance</h1>' +
    '<p class="sel-sub">Escolha a frente que você quer analisar</p>' +
    '<div class="sel-cards">' +

    '<a class="sel-card" href="#b2b/visao">' +
    '<div class="sel-kicker">Painel</div>' +
    '<h2>B2B Atacado</h2>' +
    '<p class="sel-desc">Leads e funil de vendas no atacado</p>' +
    '<div class="sel-stats">' +
    '<div class="sel-stat"><span class="v">' + fmt.num(leadsCrm) + '</span><span class="l">leads no CRM</span></div>' +
    '<div class="sel-stat"><span class="v">' + (cplCrm == null ? '—' : fmt.currency(cplCrm)) + '</span><span class="l">CPL (CRM)</span></div>' +
    '</div>' +
    '<div class="sel-go">Abrir painel →</div>' +
    '</a>' +

    '<a class="sel-card" href="#ecom/visao">' +
    '<div class="sel-kicker">Painel</div>' +
    '<h2>E-commerce</h2>' +
    '<p class="sel-desc">Loja online e venda direta</p>' +
    '<div class="sel-stats">' +
    '<div class="sel-stat"><span class="v">' + fmt.num(compras) + '</span><span class="l">compras</span></div>' +
    '<div class="sel-stat"><span class="v">' + (roas == null ? '—' : fmt.dec(roas, 2) + '×') + '</span><span class="l">ROAS</span></div>' +
    '</div>' +
    '<div class="sel-go">Abrir painel →</div>' +
    '</a>' +

    '</div>' +
    '<div class="sel-note">números de toda a série — esta tela não usa o filtro de período dos painéis</div>' +
    '<div class="sel-foot"><strong>Agência Delucca</strong> — dashboards de performance · atualizado em ' +
    esc(DATA.last_update || '—') + '</div>' +
    '</div>';
}

/* ============================================================
   Filtro de período global (De / Até / Todo período)
   ============================================================ */
function computeDataBounds() {
  const dates = [];
  const push = (list, key) => (list || []).forEach(r => { if (r[key]) dates.push(r[key]); });
  push(DATA.leads && DATA.leads.daily, 'dia');
  push(DATA.meta_b2b && DATA.meta_b2b.daily, 'dia');
  push(DATA.meta_ecom && DATA.meta_ecom.daily, 'dia');
  push(DATA.google_b2b && DATA.google_b2b.daily, 'dia');
  push(DATA.google_ecom && DATA.google_ecom.daily, 'dia');
  push(DATA.atendimento && DATA.atendimento.msgs_daily, 'dia');
  push(DATA.crm && DATA.crm.deals_minimal, 'criado_em');
  push(DATA.crm && DATA.crm.losses_daily, 'criado');
  push(DATA.crm && DATA.crm.losses_daily, 'data');
  dates.sort();
  DATA_MIN = dates[0] || '2026-01-01';
  DATA_MAX = dates[dates.length - 1] || DATA_MIN;
}
function setPreset(p, rerender) {
  FILTER.preset = p;
  if (p === 'all') {
    FILTER.start = DATA_MIN; FILTER.end = DATA_MAX;
  } else if (p !== 'custom') {
    const n = parseInt(p, 10);
    FILTER.end = DATA_MAX;
    FILTER.start = addDays(DATA_MAX, -(n - 1));
  }
  syncFilterUI();
  if (rerender !== false) route();
}
function syncFilterUI() {
  const s = document.getElementById('f-start'), e = document.getElementById('f-end');
  const sel = document.getElementById('f-preset');
  if (s) s.value = FILTER.start || '';
  if (e) e.value = FILTER.end || '';
  if (sel) sel.value = FILTER.preset;
}
function onDateInput() {
  const s = document.getElementById('f-start').value;
  const e = document.getElementById('f-end').value;
  // Campo apagado: restaura a UI para o filtro APLICADO — senão o input
  // ficaria vazio com os dados ainda filtrados pelo valor antigo.
  if (!s || !e) { syncFilterUI(); return; }
  FILTER.start = s <= e ? s : e;
  FILTER.end = s <= e ? e : s;
  FILTER.preset = 'custom';
  syncFilterUI();
  route();
}
function buildFilterUI() {
  document.getElementById('f-start').addEventListener('change', onDateInput);
  document.getElementById('f-end').addEventListener('change', onDateInput);
  document.getElementById('f-preset').addEventListener('change', ev => {
    if (ev.target.value !== 'custom') setPreset(ev.target.value);
  });
}

/* ============================================================
   B2B · VISÃO GERAL
   ============================================================ */
function renderVisaoB2B(el) {
  const L = fdays((DATA.leads || {}).daily);
  const leadsCRM = sum(L, 'total');
  const leadsPagos = sum(L, 'pagos');
  const mbDaily = fdays((DATA.meta_b2b || {}).daily);
  const invest = sum(mbDaily, 'gasto');
  const leadsPlat = sum(mbDaily, 'leads_plat');
  const deals = ((DATA.crm || {}).deals_minimal || []).filter(d => inPeriod(d.criado_em));
  const vendas = deals.filter(d => d.ganho).length;
  const perdidos = deals.filter(d => d.perdido).length;
  const cpl = (invest > 0 && leadsPagos > 0) ? invest / leadsPagos : null;
  const cobEf = (DATA.utm || {}).cobertura_efetiva || {};

  let html = qualityBanners(true);

  // KPI-herói: CPL (CRM). Demais KPIs menores.
  html += '<div class="kpis cols-hero-6">' +
    kpi('CPL (CRM)', cpl == null ? null : fmt.currency(cpl),
      cpl == null ? 'sem leads pagos no período*' : 'investimento ÷ leads pagos do CRM*', { teal: true, hero: true }) +
    kpi('Leads no CRM', fmt.num(leadsCRM), 'criados no período · pipeline B2B') +
    kpi('Investimento', fmt.currency(invest), 'Meta (frente B2B) · Google: sem campanhas B2B ainda') +
    kpi('Leads plataforma', fmt.num(leadsPlat), 'reportado pela plataforma (referência)') +
    kpi('Vendas', fmt.num(vendas), 'no período') +
    kpi('Perdidos', fmt.num(perdidos), 'no período') +
    '</div>';

  html += '<div class="note-blue">* <strong>CPL (CRM)</strong> = investimento nas campanhas de leads B2B (meta_b2b) ÷ leads do CRM ' +
    'atribuídos ao tráfego pago por <strong>origem efetiva</strong> (UTM ou planilha do formulário). ' +
    'Cobertura efetiva: <strong>' + fmt.pct(cobEf.pct, 0) + '</strong> dos leads têm atribuição — o CPL descreve essa fatia rastreada, não o total. ' +
    'E-commerce e impulsionamento ficam no painel E-commerce.</div>';

  const sL = dailySeries((DATA.leads || {}).daily, ['total']);
  const sI = dailySeries((DATA.meta_b2b || {}).daily, ['gasto']);

  // primeiro dia com dado da frente B2B (nada hardcoded: vem da própria série)
  const mbAll = (DATA.meta_b2b || {}).daily || [];
  const mbMin = mbAll.reduce((a, r) => (r.dia && (!a || r.dia < a)) ? r.dia : a, null);
  const semInvestMsg = mbMin
    ? 'A campanha de captação B2B começou em ' + fmt.dateFull(mbMin) + ' — amplie o período.'
    : 'Ainda não há investimento B2B registrado na série.';

  html += '<div class="grid-2">' +
    (sL
      ? chartCard('Leads por dia', 'entradas no pipeline (CRM)', 'ch-vg-leads', '',
        dailyRelief(sL, [{ k: 'total', t: 'Leads', f: fmt.num }]))
      : card('Leads por dia', 'entradas no pipeline (CRM)', emptyDashed('Sem leads no período selecionado.', 'Ajuste o filtro de período no topo.'))) +
    (sI
      ? chartCard('Investimento por dia', 'gasto Meta da frente B2B (campanhas de leads)', 'ch-vg-invest', '',
        dailyRelief(sI, [{ k: 'gasto', t: 'Gasto', f: fmt.currency }]))
      : card('Investimento por dia', 'gasto Meta da frente B2B (campanhas de leads)', emptyDashed('Sem investimento B2B no período.', semInvestMsg))) +
    '</div>';

  const fp = funnelPeriodStages();
  html += card('Funil B2B — visão do período',
    'leads criados no período, pela etapa ATUAL de cada um · etapas de ganho/perda são terminais',
    fp.total ? funnelHtml(fp) : emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));

  // ----- Leads por origem (efetiva) — vem pronto em leads.by_source -----
  const srcRows = ((DATA.leads || {}).by_source || []).map(r =>
    '<tr><td class="name">' + esc(r.fonte) + '</td>' +
    '<td class="r">' + fmt.num(r.leads) + '</td></tr>').join('');
  html += card('Leads por origem (efetiva)',
    'origem efetiva = UTM do lead <strong>ou</strong> casamento com a planilha do formulário · foto atual da base — não usa o filtro',
    srcRows
      ? tableWrap([{ t: 'Origem (efetiva)' }, { t: 'Leads', r: 1 }], srcRows) +
      '<div class="note">Cobertura efetiva: <strong>' + fmt.pct(cobEf.pct, 0) + '</strong> — ' +
      fmt.num(cobEf.com_atribuicao) + ' de ' + fmt.num(cobEf.total) + ' leads com atribuição ' +
      '(' + esc(cobEf.nota || 'UTM ou planilha do formulário') + '). Detalhe completo na página Rastreamento (UTM).</div>'
      : emptyDashed('Nenhuma origem efetiva registrada na base.'));

  // ----- Qualidade de atendimento por responsável -----
  const qual = DATA.qualidade_responsavel || [];
  const qualRows = qual.map(r =>
    '<tr><td class="name">' + esc(r.responsavel || 'sem responsável') + '</td>' +
    '<td class="r">' + fmt.num(r.leads) + '</td>' +
    '<td class="r">' + fmt.num(r.vendas) + '</td>' +
    '<td class="r">' + fmt.num(r.perdidos) + '</td>' +
    '<td class="r">' + fmt.pct(r.taxa_conv) + '</td>' +
    '<td class="r">' + fmt.pct(r.sem_1o_atend_pct) + '</td>' +
    '<td class="r">' + fmt.days(r.tempo_1o_atend_dias) + '</td>' +
    '<td class="r">' + fmt.days(r.parado_dias) + '</td></tr>').join('');
  html += card('Qualidade de atendimento por responsável',
    'foto atual do funil — <strong>não usa o filtro de período</strong> · "1º atendimento" = lead saiu da etapa de entrada · resolução diária',
    qualRows
      ? tableWrap([
        { t: 'Responsável' }, { t: 'Leads', r: 1 }, { t: 'Vendas', r: 1 }, { t: 'Perdidos', r: 1 },
        { t: 'Taxa conv.', r: 1 }, { t: 'Sem 1º atend.', r: 1 }, { t: 'Tempo 1º atend.', r: 1 }, { t: 'Parado (médio)', r: 1 }
      ], qualRows)
      : emptyDashed('Sem dados por responsável.'));

  el.innerHTML = html;

  if (sL) {
    makeChart('ch-vg-leads', {
      type: 'bar',
      data: { labels: sL.labels, datasets: [barDs('Leads', sL.data.total, S.mostarda)] },
      options: baseOpts({})
    });
  }
  if (sI) {
    // Terracota em série densa → linha 2px + relief "Ver tabela" (acima)
    makeChart('ch-vg-invest', {
      type: 'line',
      data: { labels: sI.labels, datasets: [lineDs('Gasto (R$)', sI.data.gasto, S.terracota, { fill: true })] },
      options: baseOpts({
        plugins: { tooltip: { callbacks: moneyTooltip() } },
        scales: { y: yMoney() }
      })
    });
  }
}

/* ============================================================
   B2B · FUNIL CRM
   ============================================================ */
function renderFunilCRM(el) {
  const crm = DATA.crm || {};
  const deals = (crm.deals_minimal || []).filter(d => inPeriod(d.criado_em));
  const vendas = deals.filter(d => d.ganho).length;
  const perdidos = deals.filter(d => d.perdido).length;
  const andamento = deals.length - vendas - perdidos;
  const taxa = deals.length > 0 ? vendas / deals.length * 100 : null;

  // perdas do período — eixo: data de criação do lead (mesmo eixo dos KPIs)
  const lossesP = (crm.losses_daily || []).filter(r => inPeriod(r.criado));
  const motivos = Object.create(null);   // motivo é texto livre do CRM
  lossesP.forEach(r => { const m = r.motivo || 'Não informado'; motivos[m] = (motivos[m] || 0) + 1; });
  const motivosArr = Object.entries(motivos).sort((a, b) => b[1] - a[1]);

  // tempo até perda: criado -> data da perda
  const diffs = lossesP
    .filter(r => r.data && r.criado)
    .map(r => (new Date(r.data + 'T12:00:00') - new Date(r.criado + 'T12:00:00')) / 864e5)
    .filter(v => v >= 0);
  const tPerda = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  const ciclo = crm.ciclo || {};

  let html = qualityBanners(false);

  html += '<div class="kpis cols-5">' +
    kpi('Leads no período', fmt.num(deals.length), 'pipeline de venda B2B') +
    kpi('Em andamento', fmt.num(andamento), 'leads vivos no funil') +
    kpi('Vendas', fmt.num(vendas), 'no período') +
    kpi('Perdidos', fmt.num(perdidos), 'no período') +
    kpi('Taxa de conversão', taxa == null ? null : fmt.pct(taxa), 'vendas ÷ leads', { teal: true }) +
    '</div>';

  const fp = funnelPeriodStages();
  html += card('Funil completo',
    'etapa atual dos leads criados no período — etapas de ganho/perda são terminais, não progresso',
    fp.total ? funnelHtml(fp) : emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));

  // ----- Motivos de perda (nominal → UMA cor, terracota, rótulo em toda barra)
  //       + Leads perdidos (tabela) -----
  const LOSS_CAP = 15;
  const lossRows = lossesP.slice().sort((a, b) => {
    const x = a.criado || '', y = b.criado || '';
    return x === y ? 0 : (y > x ? 1 : -1);          // desc, comparator consistente
  }).slice(0, LOSS_CAP).map(r =>
    '<tr><td>' + fmt.dateFull(r.criado) + '</td>' +
    (r.etapa ? '<td class="peri">' + esc(r.etapa) + '</td>' : '<td class="peri">—</td>') +
    (r.motivo ? '<td class="name">' + esc(r.motivo) + '</td>' : '<td class="dim">não informado</td>') +
    '<td class="peri">' + (r.origem
      ? esc(r.origem)
      : (r.utm_campaign
        ? '<span class="muted" title="lead sem origem efetiva — mostrando utm_campaign">' + esc(r.utm_campaign) + '</span>'
        : '<span class="muted">(sem origem)</span>')) + '</td></tr>').join('');
  const lossNote = (lossesP.length > LOSS_CAP ? 'Mostrando ' + LOSS_CAP + ' de ' + fmt.num(lossesP.length) + ' perdas do período. ' : '') +
    'Etapa = onde o lead estava no momento da perda · Origem = origem efetiva (UTM ou planilha do formulário); ' +
    'em cinza, o utm_campaign quando não há origem efetiva.';
  html += '<div class="grid-2">' +
    (motivosArr.length
      ? chartCard('Motivos de perda', 'leads perdidos no período (por data de criação do lead) · categoria nominal — uma cor só', 'ch-crm-motivos')
      : card('Motivos de perda', 'leads perdidos no período', emptyDashed('Nenhuma perda no período selecionado.'))) +
    card('Leads perdidos', 'detalhe (data de criação do lead) · etapa no momento da perda e origem efetiva',
      lossRows
        ? tableWrap([{ t: 'Criado' }, { t: 'Etapa' }, { t: 'Motivo' }, { t: 'Origem' }], lossRows) + '<div class="note">' + lossNote + '</div>'
        : emptyDashed('Nenhuma perda no período selecionado.')) +
    '</div>';

  // ----- 3 stat cards -----
  const tempoEtapa = (crm.tempo_etapa || []).slice().sort((a, b) => a.sort - b.sort);
  const maisLenta = tempoEtapa.length
    ? tempoEtapa.reduce((a, r) => (r.dias_mediana || 0) > (a.dias_mediana || 0) ? r : a)
    : null;
  html += '<div class="kpis cols-3">' +
    kpi('Tempo médio até venda', (ciclo.n || 0) > 0 ? fmt.days(ciclo.mediana_dias) : null,
      (ciclo.n || 0) > 0 ? 'mediana da criação ao fechamento · base: ' + fmt.num(ciclo.n) + ' vendas (toda a série)' : 'nenhuma venda registrada ainda') +
    kpi('Tempo médio até perda', tPerda == null ? null : fmt.days(tPerda),
      tPerda == null ? 'sem perdas no período' : 'da criação à perda · ' + fmt.num(diffs.length) + ' perdas do período') +
    kpi('Etapa mais lenta', maisLenta ? fmt.days(maisLenta.dias_mediana) : null,
      maisLenta
        ? esc(maisLenta.etapa) + ' · mediana entre ' + fmt.num(maisLenta.leads) + ' leads vivos · foto atual'
        : 'sem dados de tempo por etapa ainda') +
    '</div>';

  // ----- Tempo na etapa (crm.tempo_etapa) + leads parados (crm.leads_parados)
  const lp = crm.leads_parados || { disponivel: false };
  const lpRows = (lp.disponivel === true ? (lp.itens || []) : []).map(r =>
    '<tr><td class="name">' + esc(r.nome) + '</td>' +
    '<td>' + esc(r.telefone || '—') + '</td>' +
    '<td class="peri">' + esc(r.etapa || '—') + '</td>' +
    '<td class="r">' + fmt.num(r.dias) + '</td>' +
    '<td class="dim">' + esc(r.responsavel || '—') + '</td></tr>').join('');
  html += '<div class="grid-2">' +
    (tempoEtapa.length
      ? chartCard('Tempo médio na etapa atual', 'mediana de dias parado por etapa (leads vivos) · foto atual — não usa o filtro', 'ch-crm-tempo-etapa')
      : card('Tempo médio na etapa atual', 'dias parados por etapa (leads vivos)',
        emptyDashed('Sem dados de tempo por etapa.', 'O ETL ainda não exportou o tempo por etapa neste resumo.'))) +
    card('Leads parados há mais dias', 'quem precisa de atenção do atendimento',
      lpRows
        ? tableWrap([{ t: 'Nome' }, { t: 'Telefone' }, { t: 'Etapa' }, { t: 'Dias', r: 1 }, { t: 'Responsável' }], lpRows)
        : emptyDashed('Lista indisponível por enquanto.', esc(lp.motivo || 'Sem leads parados exportados neste resumo.'))) +
    '</div>';

  // ----- Valor em negociação + Perdas por mês -----
  const lossesAll = crm.losses_daily || [];
  const mesesPerda = Array.from(new Set(lossesAll.map(r => (r.criado || '').slice(0, 7)).filter(Boolean))).sort();
  html += '<div class="grid-2">' +
    card('Valor em negociação por etapa', 'campo "valor" dos leads vivos no CRM',
      emptyDashed('Nenhum lead vivo com valor preenchido no Kommo.',
        'Preencha o campo "Valor" dos negócios no Kommo para habilitar esta visão (e o ticket médio real).')) +
    (mesesPerda.length
      ? chartCard('Perdas por mês', 'toda a série · mês de criação do lead perdido — detalhe por motivo no gráfico "Motivos de perda"', 'ch-crm-perdas-mes')
      : card('Perdas por mês', 'toda a série', emptyDashed('Nenhuma perda registrada ainda.'))) +
    '</div>';

  el.innerHTML = html;

  if (motivosArr.length) {
    // Nominal → barra horizontal, UMA cor (terracota) + rótulo direto em toda
    // barra (relief exigida pelo contraste 2,99:1 da terracota).
    makeChart('ch-crm-motivos', {
      type: 'bar',
      data: {
        labels: motivosArr.map(m => m[0]),
        datasets: [barDs('Perdas', motivosArr.map(m => m[1]), S.terracota, { borderSkipped: 'left' })]
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: { directLabels: { mode: 'all', format: fmt.num } },
        scales: {
          x: yCount({ position: 'bottom', grace: '15%', ticks: { maxRotation: 0, minRotation: 0 } }),
          y: { grid: { display: false }, ticks: { color: P.soft } }
        }
      })
    });
  }
  if (tempoEtapa.length) {
    // Etapas do funil = ORDINAL → rampa âmbar monotônica (mesma escala do
    // funil) + rótulo direto em dias em toda barra.
    makeChart('ch-crm-tempo-etapa', {
      type: 'bar',
      data: {
        labels: tempoEtapa.map(r => r.etapa),
        datasets: [{
          label: 'Dias parado (mediana)',
          data: tempoEtapa.map(r => r.dias_mediana || 0),
          backgroundColor: tempoEtapa.map((r, i) => amberStep(i, tempoEtapa.length)),
          borderRadius: 4, borderSkipped: 'left', maxBarThickness: 24
        }]
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: {
          directLabels: { mode: 'all', format: fmt.days },
          tooltip: {
            callbacks: {
              label: ctx => 'mediana: ' + fmt.days(ctx.parsed.x) + ' · ' +
                fmt.num((tempoEtapa[ctx.dataIndex] || {}).leads) + ' leads vivos'
            }
          }
        },
        scales: {
          x: yCount({ position: 'bottom', grace: '15%', ticks: { maxRotation: 0, minRotation: 0, callback: v => fmt.dec(v, 0) + 'd' } }),
          y: { grid: { display: false }, ticks: { color: P.soft } }
        }
      })
    });
  }
  if (mesesPerda.length) {
    const byMes = {};
    lossesAll.forEach(r => {
      const m = (r.criado || '').slice(0, 7);
      if (m) byMes[m] = (byMes[m] || 0) + 1;
    });
    makeChart('ch-crm-perdas-mes', {
      type: 'bar',
      data: {
        labels: mesesPerda.map(mesLabel),
        datasets: [barDs('Perdas', mesesPerda.map(m => byMes[m] || 0), S.terracota)]
      },
      options: baseOpts({
        plugins: { directLabels: { mode: 'all', format: fmt.num } },
        scales: { x: xCat(), y: yCount({ grace: '15%' }) }
      })
    });
  }
}

/* ============================================================
   B2B · ATENDIMENTO
   ============================================================ */
function renderAtendimento(el) {
  const at = DATA.atendimento || {};
  const msgs = dailySeries(at.msgs_daily, ['recebidas', 'enviadas']);
  const msgsP = fdays(at.msgs_daily);
  const recebidas = sum(msgsP, 'recebidas');
  const enviadas = sum(msgsP, 'enviadas');

  const respP = fdays(at.respostas);
  const humanas = respP.filter(r => r.minutos >= 0.5).map(r => r.minutos).sort((a, b) => a - b);
  const med = quantile(humanas, .5);

  const buckets = [
    { label: 'até 5 min', max: 5 },
    { label: '5–30 min', max: 30 },
    { label: '30 min – 2 h', max: 120 },
    { label: '2–24 h', max: 1440 },
    { label: '+24 h', max: Infinity }
  ];
  const bucketCounts = buckets.map(() => 0);
  humanas.forEach(m => {
    for (let i = 0; i < buckets.length; i++) {
      if (m <= buckets[i].max) { bucketCounts[i]++; break; }
    }
  });

  let html = qualityBanners(false);
  html += banner('blue', 'Os tempos de resposta medem a espera por uma <strong>pessoa</strong> — o robô (resposta em &lt; 0,5 min) é contado à parte e excluído das medianas.');

  html += '<div class="kpis cols-6">' +
    kpi('Conversas', fmt.num(at.conversas_total), 'foto 180 dias — não usa o filtro') +
    kpi('Em aberto', fmt.num(at.em_aberto), 'foto atual — não usa o filtro') +
    kpi('Não lidas', fmt.num(at.nao_lidas), 'foto atual — não usa o filtro') +
    kpi('Msgs recebidas', fmt.num(recebidas), 'no período') +
    kpi('Msgs enviadas', fmt.num(enviadas), 'no período') +
    kpi('Resposta humana (mediana)', humanas.length ? fmt.mins(med) : null,
      humanas.length ? 'exclui robô (&lt; 0,5 min)' : 'sem respostas humanas no período', { teal: true }) +
    '</div>';

  html += '<div class="kpis cols-3">' +
    kpi('Respostas humanas', fmt.num(humanas.length), 'base dos tempos acima, no período · robô (&lt; 0,5 min) fica de fora') +
    '</div>';

  html += '<div class="grid-2">' +
    (msgs
      ? chartCard('Mensagens por dia', 'recebidas × enviadas no WhatsApp (Kommo)', 'ch-at-msgs', '',
        dailyRelief(msgs, [{ k: 'recebidas', t: 'Recebidas', f: fmt.num }, { k: 'enviadas', t: 'Enviadas', f: fmt.num }]))
      : card('Mensagens por dia', 'recebidas × enviadas', emptyDashed('Sem mensagens no período selecionado.'))) +
    (humanas.length
      ? chartCard('Tempo de resposta humana — distribuição', 'faixas ordinais (rampa âmbar claro→escuro) · somente respostas de pessoas (≥ 0,5 min) no período', 'ch-at-buckets')
      : card('Tempo de resposta humana — distribuição', 'somente respostas de pessoas', emptyDashed('Sem respostas humanas no período.'))) +
    '</div>';

  html += (at.msgs_hora && at.msgs_hora.length
    ? chartCard('Mensagens recebidas por hora do dia', 'foto 180 dias — não usa o filtro · ajuda a posicionar a equipe nos horários de pico', 'ch-at-hora', 'short')
    : card('Mensagens recebidas por hora do dia', 'foto 180 dias', emptyDashed('Sem dados de mensagens por hora.')));

  el.innerHTML = html;

  if (msgs) {
    makeChart('ch-at-msgs', {
      type: 'line',
      data: {
        labels: msgs.labels,
        datasets: [
          lineDs('Recebidas', msgs.data.recebidas, S.mostarda),
          lineDs('Enviadas', msgs.data.enviadas, S.terracota)
        ]
      },
      options: baseOpts({
        plugins: {
          legend: legendTop(),
          directLabels: { mode: 'max', format: fmt.num }   // rótulo direto seletivo (pico)
        }
      })
    });
  }
  if (humanas.length) {
    // Ordinal (faixas de tempo) → rampa de UM matiz, valor rotulado em cada barra
    makeChart('ch-at-buckets', {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [{
          label: 'Respostas humanas',
          data: bucketCounts,
          backgroundColor: buckets.map((b, i) => amberStep(i, buckets.length)),
          borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 42
        }]
      },
      options: baseOpts({
        plugins: { directLabels: { mode: 'all', format: fmt.num } },
        scales: { x: xCat(), y: yCount({ grace: '15%' }) }
      })
    });
  }
  if (at.msgs_hora && at.msgs_hora.length) {
    const horas = at.msgs_hora.slice().sort((a, b) => a.hora - b.hora);
    makeChart('ch-at-hora', {
      type: 'bar',
      data: {
        labels: horas.map(h => String(h.hora).padStart(2, '0') + 'h'),
        datasets: [barDs('Mensagens', horas.map(h => h.mensagens), S.mostarda)]
      },
      options: baseOpts({ scales: { x: xCat({ ticks: { maxTicksLimit: 24 } }) } })
    });
  }
}

/* ============================================================
   B2B · META ADS — SÓ meta_b2b (campanhas de leads B2B)
   ============================================================ */
function renderMetaB2B(el) {
  const meta = DATA.meta_b2b || {};
  const campDailyP = fdays(meta.campaign_daily);

  const gasto = sum(campDailyP, 'gasto');
  const imp = sum(campDailyP, 'impressoes');
  const cli = sum(campDailyP, 'cliques_link');
  const ctr = imp > 0 ? cli / imp * 100 : null;
  const cpc = cli > 0 ? gasto / cli : null;
  const leadsPlat = sum(campDailyP, 'leads_plat');
  const custoLeadPlat = leadsPlat > 0 ? gasto / leadsPlat : null;
  const target = (DATA.config && DATA.config.cpl_target_meta) || 0;

  let html = qualityBanners(false);
  html += banner('blue', 'Esta página cobre <strong>somente as campanhas de leads B2B</strong> (frente meta_b2b). ' +
    'As campanhas de e-commerce estão no painel E-commerce, e o impulsionamento na página Institucional &amp; Impulsionamento (painel E-commerce). ' +
    'Cliques, CTR e CPC usam <strong>cliques no link</strong> (link clicks) — não o total de cliques do anúncio.');

  // Banner de matching lead ↔ anúncio (planilha do formulário + UTM)
  const mt = meta.matching || null;
  if (mt && mt.leads_pagos_meta != null) {
    html += banner('blue', 'Casamento lead ↔ anúncio no nível <strong>' + esc(mt.nivel || 'campanha + criativo') + '</strong>: ' +
      '<strong>' + fmt.num(mt.leads_pagos_meta) + '</strong> leads pagos identificados no CRM — ' +
      '<strong>' + fmt.num(mt.via_formulario) + '</strong> via planilha do formulário e ' +
      '<strong>' + fmt.num(mt.via_utm) + '</strong> via UTM · cobertura de ' +
      '<strong>' + fmt.pct(mt.cobertura_pct, 0) + '</strong> dos leads pagos.');
  }

  html += '<div class="kpis cols-6">' +
    kpi('Gasto', fmt.currency(gasto), 'no período') +
    kpi('Impressões', fmt.num(imp), 'no período') +
    kpi('Cliques no link', fmt.num(cli), ctr == null ? 'no período' : 'CTR ' + fmt.pct(ctr, 1)) +
    kpi('CPC', cpc == null ? null : fmt.currency(cpc), 'gasto ÷ cliques no link') +
    kpi('Leads plataforma', fmt.num(leadsPlat), 'plataforma (referência)') +
    kpi('Custo/lead plat.', custoLeadPlat == null ? null : fmt.currency(custoLeadPlat),
      (custoLeadPlat == null ? 'sem leads de plataforma no período · ' : 'gasto ÷ leads plat. · ') +
      (target ? 'meta: até ' + fmt.currency(target) : 'meta de CPL não definida'), { teal: true }) +
    '</div>';

  // ----- Tabela CAMPANHAS (Leads CRM do PERÍODO: soma do campo "leads" do
  //       campaign_daily nos dias do filtro — lado a lado com a plataforma)
  const statusDict = dict(meta.campaign_status);
  const byCamp = aggBy(campDailyP, r => r.campanha, ['gasto', 'impressoes', 'cliques_link', 'leads_plat', 'leads']);
  const campRows = Object.keys(byCamp)
    .map(k => ({ nome: k, v: byCamp[k] }))
    .filter(r => r.v.gasto > 0 || r.v.leads_plat > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const campBody = campRows.map(r => {
    const v = r.v;
    const rctr = v.impressoes > 0 ? v.cliques_link / v.impressoes * 100 : null;
    const rcpc = v.cliques_link > 0 ? v.gasto / v.cliques_link : null;
    const rcl = v.leads_plat > 0 ? v.gasto / v.leads_plat : null;
    return '<tr><td>' + statusBadge(statusDict[r.nome]) + '</td>' +
      '<td class="name">' + esc(r.nome) + '</td>' +
      '<td class="r">' + fmt.currency(v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(v.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(v.cliques_link) + '</td>' +
      '<td class="r">' + fmt.pct(rctr, 1) + '</td>' +
      '<td class="r">' + (rcpc == null ? '—' : fmt.currency(rcpc)) + '</td>' +
      '<td class="r">' + fmt.num(v.leads_plat) + '</td>' +
      '<td class="r">' + (rcl == null ? '—' : fmt.currency(rcl)) + '</td>' +
      '<td class="r">' + fmt.num(v.leads) + '</td></tr>';
  }).join('');
  html += card('Campanhas', 'status real via API · métricas do período filtrado · Leads CRM = leads reais do CRM casados à campanha ' +
    '(formulário + UTM) nos dias do filtro — compare com "Leads plataforma" ao lado',
    campBody
      ? tableWrap([
        { t: 'Status' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 }, { t: 'Cliques no link', r: 1 },
        { t: 'CTR', r: 1 }, { t: 'CPC', r: 1 }, { t: 'Leads plataforma', r: 1 }, { t: 'Custo/lead plat.', r: 1 }, { t: 'Leads CRM', r: 1 }
      ], campBody)
      : emptyDashed('Nenhuma campanha de leads B2B com gasto no período.', 'Ajuste o filtro de período no topo.'));

  // ----- Tabela CONJUNTOS -----
  const adsetP = fdays(meta.adset_daily);
  const byAdset = aggBy(adsetP, r => r.campanha + '|||' + r.conjunto, ['gasto', 'cliques_link', 'leads_plat']);
  const adsetRows = Object.keys(byAdset)
    .map(k => ({ campanha: byAdset[k].__row.campanha, conjunto: byAdset[k].__row.conjunto, v: byAdset[k] }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const adsetBody = adsetRows.map(r => {
    const rcl = r.v.leads_plat > 0 ? r.v.gasto / r.v.leads_plat : null;
    return '<tr><td class="name">' + esc(r.conjunto) + '</td>' +
      '<td class="dim">' + esc(r.campanha) + '</td>' +
      '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(r.v.cliques_link) + '</td>' +
      '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' +
      '<td class="r">' + (rcl == null ? '—' : fmt.currency(rcl)) + '</td>' +
      '<td>' + qualityBadge(rcl, r.v.leads_plat) + '</td></tr>';
  }).join('');
  html += card('Conjuntos de anúncios', 'agrupado por campanha + conjunto (dimensão real da linha da API)',
    adsetBody
      ? tableWrap([
        { t: 'Conjunto' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Cliques no link', r: 1 },
        { t: 'Leads plataforma', r: 1 }, { t: 'Custo/lead plat.', r: 1 }, { t: 'Qualidade' }
      ], adsetBody) +
      '<div class="note">Impressões por conjunto ainda não são exportadas pelo ETL. ' +
      'A régua Bom/Ruim é habilitada quando a meta de custo/lead for definida na configuração.</div>'
      : emptyDashed('Nenhum conjunto com gasto no período.'));

  // ----- Tabela ANÚNCIOS -----
  const metaCreat = Object.create(null);
  (meta.creatives || []).forEach(c => { metaCreat[c.anuncio + '|||' + c.campanha] = c; });
  const creatP = fdays(meta.creatives_daily);
  const byCreat = aggBy(creatP, r => r.anuncio + '|||' + r.campanha, ['gasto', 'cliques_link', 'leads_plat']);
  const ADS_CAP = 25;
  const creatRows = Object.keys(byCreat)
    .map(k => ({ k, v: byCreat[k], agg: metaCreat[k] || {} }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const creatBody = creatRows.slice(0, ADS_CAP).map(r => {
    const a = r.agg;
    const anuncio = r.v.__row.anuncio;
    const rcl = r.v.leads_plat > 0 ? r.v.gasto / r.v.leads_plat : null;
    const thumb = a.thumbnail
      ? '<img class="thumb" src="' + esc(a.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
      'onerror="this.style.display=&#39;none&#39;;this.nextElementSibling.style.display=&#39;flex&#39;"><div class="thumb-fb">▦</div>'
      : '<div class="thumb-fb" style="display:flex">▦</div>';
    const plink = safeHttpUrl(a.permalink);
    const nome = plink
      ? '<a href="' + esc(plink) + '" target="_blank" rel="noopener">' + esc(anuncio) + ' 🔗</a>'
      : '<span class="name">' + esc(anuncio || '(sem nome)') + '</span>';
    return '<tr><td><div class="cell-creative">' + thumb + nome + '</div></td>' +
      '<td class="dim">' + esc(a.conjunto || '—') + '</td>' +
      '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(r.v.cliques_link) + '</td>' +
      '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' +
      '<td class="r">' + (a.leads_form == null ? '—' : fmt.num(a.leads_form)) + '</td>' +
      '<td class="r">' + (rcl == null ? '—' : fmt.currency(rcl)) + '</td>' +
      '<td>' + qualityBadge(rcl, r.v.leads_plat) + '</td></tr>';
  }).join('');
  html += card('Anúncios', 'criativo × campanha · clique no nome para ver o anúncio',
    creatBody
      ? tableWrap([
        { t: 'Anúncio' }, { t: 'Conjunto principal' }, { t: 'Gasto', r: 1 }, { t: 'Cliques no link', r: 1 },
        { t: 'Leads plataforma', r: 1 }, { t: 'Leads (formulário)', r: 1 }, { t: 'Custo/lead plat.', r: 1 }, { t: 'Qualidade' }
      ], creatBody) +
      '<div class="note">Um anúncio pode rodar em mais de um conjunto — a coluna mostra o conjunto principal ' +
      'do anúncio na série (o ETL ainda não exporta o conjunto no diário por criativo). ' +
      'O gasto por conjunto correto está na tabela Conjuntos acima.</div>' +
      '<div class="note"><strong>Leads (formulário)</strong> = leads reais do CRM casados ao criativo pela planilha ' +
      'do formulário — fonte de verdade por anúncio, total da série (não usa o filtro de período). ' +
      '"—" = nenhum lead do formulário casado a esse criativo.</div>' +
      (creatRows.length > ADS_CAP
        ? '<div class="note">Mostrando os ' + ADS_CAP + ' anúncios com maior gasto de ' + fmt.num(creatRows.length) + ' no período.</div>'
        : '')
      : emptyDashed('Nenhum anúncio com gasto no período.'));

  // ----- Mensal: Investimento e Leads CRM — PAR DE LINHAS (sem eixo duplo)
  const gastoMes = {};
  (meta.monthly || []).forEach(r => { gastoMes[r.mes] = r.gasto || 0; });
  const leadsMes = {};
  ((DATA.leads || {}).monthly || []).forEach(r => { leadsMes[r.mes] = r.total; });
  const mesesCombo = Array.from(new Set(Object.keys(gastoMes).concat(Object.keys(leadsMes)))).sort();
  const comboRelief = reliefTable(
    [{ t: 'Mês' }, { t: 'Gasto', r: 1 }, { t: 'Leads CRM', r: 1 }],
    mesesCombo.map(m => '<tr><td>' + mesLabel(m) + '</td>' +
      '<td class="r">' + fmt.currency(gastoMes[m] || 0) + '</td>' +
      '<td class="r">' + fmt.num(leadsMes[m] || 0) + '</td></tr>').join(''));
  html += (mesesCombo.length
    ? multiChartCard('Investimento × Leads CRM (mensal)',
      'par de gráficos de linha no mesmo eixo X (sem eixo duplo) · acima: gasto Meta B2B · abaixo: leads do pipeline no CRM · série mensal completa — não usa o filtro',
      'ch-meta-mensal-gasto', 'ch-meta-mensal-leads', comboRelief)
    : card('Investimento × Leads CRM (mensal)', 'série mensal completa', emptyDashed('Sem série mensal ainda.')));

  el.innerHTML = html;

  if (mesesCombo.length) {
    const labels = mesesCombo.map(mesLabel);
    makeChart('ch-meta-mensal-gasto', {
      type: 'line',
      data: { labels, datasets: [lineDs('Gasto (R$)', mesesCombo.map(m => gastoMes[m] || 0), S.terracota, { pointRadius: 4 })] },
      options: baseOpts({
        plugins: {
          tooltip: { callbacks: moneyTooltip() },
          directLabels: { mode: 'max', format: fmt.moneyShort }   // rótulo no pico; relief na tabela
        },
        scales: {
          x: xCat({ ticks: { display: false } }),
          y: lockYWidth(yMoney({ grace: '20%' }), 68)
        }
      })
    });
    makeChart('ch-meta-mensal-leads', {
      type: 'line',
      data: { labels, datasets: [lineDs('Leads CRM', mesesCombo.map(m => leadsMes[m] || 0), S.mostarda, { pointRadius: 4 })] },
      options: baseOpts({
        plugins: { directLabels: { mode: 'max', format: fmt.num } },
        scales: {
          x: xCat(),
          y: lockYWidth(yCount({ grace: '20%' }), 68)
        }
      })
    });
  }
}

/* ============================================================
   GOOGLE ADS (compartilhada) — lê google_b2b / google_ecom pela frente.
   Conversões e valor são MÉTRICA DE PLATAFORMA → sempre rotuladas
   "atribuição do Google" (regra 1 da agência).
   ============================================================ */
/* Status do Google Ads (ENABLED/PAUSED/REMOVED) — escala própria, distinta
   do statusBadge da Meta (ACTIVE/PAUSED). Ausente = "—", nunca inferido. */
function googleStatusBadge(st) {
  if (st === 'ENABLED') return '<span class="badge green">Ativo</span>';
  if (st === 'PAUSED') return '<span class="badge gray">Pausada</span>';
  if (st === 'REMOVED') return '<span class="badge gray">Removida</span>';
  if (st) return '<span class="badge gray">' + esc(st) + '</span>';
  return '<span class="muted" title="status indisponível na API — não inferimos">—</span>';
}
function renderGoogleAds(el, frente) {
  const g = (frente === 'b2b' ? DATA.google_b2b : DATA.google_ecom) || {};
  // Banners de qualidade descrevem CRM/UTM — só fazem sentido no painel B2B.
  let html = frente === 'b2b' ? qualityBanners(false) : '';

  // ----- Indisponível → estado vazio tracejado com o motivo do JSON -----
  if (g.disponivel !== true || !g.daily) {
    html += '<div class="kpis cols-6">' +
      kpi('Investimento', null, 'no período') +
      kpi('Conversões', null, 'atribuição do Google') +
      kpi('Valor conv.', null, 'atribuição do Google') +
      kpi('ROAS', null, 'valor conv. ÷ gasto', { teal: true }) +
      kpi('CPA', null, 'gasto ÷ conversões') +
      kpi('Cliques', null, 'no período') +
      '</div>';
    html += card('Google Ads', 'status da frente ' + (frente === 'b2b' ? 'B2B' : 'E-commerce'),
      emptyDashed('Google Ads sem dados para esta frente.',
        esc(g.motivo || 'Aguardando dados do Google Ads no ETL.')));
    el.innerHTML = html;
    return;
  }

  // ----- Disponível: KPIs do período (daily) -----
  const dP = fdays(g.daily);
  const gasto = sum(dP, 'gasto');
  const imp = sum(dP, 'impressoes');
  const cli = sum(dP, 'cliques');
  const ctr = imp > 0 ? cli / imp * 100 : null;
  const conv = sum(dP, 'conversoes');
  const valor = sum(dP, 'valor_conversoes');
  const roas = gasto > 0 ? valor / gasto : null;
  const cpa = conv > 0 ? gasto / conv : null;

  html += banner('blue', 'Conversões e valor de conversão são reportados pelo <strong>Google</strong> ' +
    '(atribuição da plataforma — referência), não vendas confirmadas. ' +
    (frente === 'ecom'
      ? 'Campanhas de <strong>Shopping</strong> da frente e-commerce — as compras do pixel da Meta ficam no Meta Ads e na Visão Geral.'
      : 'Somente as campanhas de leads da frente B2B.'));

  html += '<div class="kpis cols-6">' +
    kpi('Investimento', fmt.currency(gasto), 'no período') +
    kpi('Conversões', fmt.num(conv), 'atribuição do Google') +
    kpi('Valor conv.', fmt.currency(valor), 'atribuição do Google') +
    kpi('ROAS', roas == null ? null : fmt.dec(roas, 2) + '×',
      (roas == null ? 'sem gasto no período · ' : 'valor conv. ÷ gasto · ') + 'atribuição do Google', { teal: true }) +
    kpi('CPA', cpa == null ? null : fmt.currency(cpa),
      cpa == null ? 'sem conversões no período' : 'gasto ÷ conversões · atribuição do Google') +
    kpi('Cliques', fmt.num(cli), ctr == null ? 'no período' : 'CTR ' + fmt.pct(ctr, 1)) +
    '</div>';

  // ----- Gasto × Conversões por dia — small multiples no MESMO X (sem eixo
  //       duplo) · terracota densa → relief "Ver tabela" + rótulo no pico -----
  const sDay = dailySeries(g.daily, ['gasto', 'conversoes']);
  html += (sDay
    ? multiChartCard('Gasto × Conversões por dia',
      'par de gráficos de linha no mesmo eixo X (sem eixo duplo) · acima: gasto · abaixo: conversões (atribuição do Google)',
      'ch-g-gasto-dia', 'ch-g-conv-dia',
      dailyRelief(sDay, [
        { k: 'gasto', t: 'Gasto', f: fmt.currency },
        { k: 'conversoes', t: 'Conversões', f: fmt.num }
      ]))
    : card('Gasto × Conversões por dia', 'gasto e conversões diárias',
      emptyDashed('Sem dados do Google Ads no período selecionado.', 'Ajuste o filtro de período no topo.')));

  // ----- Tabela CAMPANHAS — agregada do campaign_daily no período -----
  const statusDict = dict(g.campaign_status);
  const campDailyP = fdays(g.campaign_daily);
  const byCamp = aggBy(campDailyP, r => r.campanha, ['gasto', 'impressoes', 'cliques', 'conversoes', 'valor_conversoes']);
  const campRows = Object.keys(byCamp)
    .map(k => ({ nome: k, v: byCamp[k] }))
    .filter(r => r.v.gasto > 0 || r.v.conversoes > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const campBody = campRows.map(r => {
    const v = r.v;
    const rctr = v.impressoes > 0 ? v.cliques / v.impressoes * 100 : null;
    const rroas = v.gasto > 0 ? v.valor_conversoes / v.gasto : null;
    const rcpa = v.conversoes > 0 ? v.gasto / v.conversoes : null;
    return '<tr><td>' + googleStatusBadge(statusDict[r.nome]) + '</td>' +
      '<td class="name">' + esc(r.nome) + '</td>' +
      '<td class="r">' + fmt.currency(v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(v.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(v.cliques) + '</td>' +
      '<td class="r">' + fmt.pct(rctr, 1) + '</td>' +
      '<td class="r">' + fmt.num(v.conversoes) + '</td>' +
      '<td class="r">' + fmt.currency(v.valor_conversoes) + '</td>' +
      '<td class="r">' + (rroas == null ? '—' : fmt.dec(rroas, 2) + '×') + '</td>' +
      '<td class="r">' + (rcpa == null ? '—' : fmt.currency(rcpa)) + '</td></tr>';
  }).join('');
  html += card('Campanhas', 'status real via API · métricas do período filtrado · conversões e valor: atribuição do Google',
    campBody
      ? tableWrap([
        { t: 'Status' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 }, { t: 'Cliques', r: 1 },
        { t: 'CTR', r: 1 }, { t: 'Conversões', r: 1 }, { t: 'Valor conv.', r: 1 }, { t: 'ROAS', r: 1 }, { t: 'CPA', r: 1 }
      ], campBody)
      : emptyDashed('Nenhuma campanha do Google com gasto no período.', 'Ajuste o filtro de período no topo.'));

  el.innerHTML = html;

  if (sDay) {
    makeChart('ch-g-gasto-dia', {
      type: 'line',
      data: { labels: sDay.labels, datasets: [lineDs('Gasto (R$)', sDay.data.gasto, S.terracota, { pointRadius: 3 })] },
      options: baseOpts({
        plugins: {
          tooltip: { callbacks: moneyTooltip() },
          directLabels: { mode: 'max', format: fmt.moneyShort }   // pico rotulado; relief na tabela
        },
        scales: {
          x: deepMerge(xDaily(), { ticks: { display: false } }),
          y: lockYWidth(yMoney({ grace: '18%' }), 68)
        }
      })
    });
    makeChart('ch-g-conv-dia', {
      type: 'line',
      data: { labels: sDay.labels, datasets: [lineDs('Conversões', sDay.data.conversoes, S.oliva, { pointRadius: 3 })] },
      options: baseOpts({
        plugins: { directLabels: { mode: 'max', format: fmt.num } },
        scales: {
          x: xDaily(),
          y: lockYWidth(yCount({ grace: '18%' }), 68)
        }
      })
    });
  }
}

/* ============================================================
   B2B · EVOLUÇÃO MENSAL
   ============================================================ */
function renderEvolucaoB2B(el) {
  const leadsM = (DATA.leads || {}).monthly || [];
  const metaM = (DATA.meta_b2b || {}).monthly || [];
  const wonM = {};
  ((DATA.crm || {}).monthly_won || []).forEach(r => { wonM[r.mes] = r.ganhos; });
  const lostM = {};
  ((DATA.crm || {}).deals_minimal || []).forEach(d => {
    if (!d.perdido) return;
    const m = (d.criado_em || '').slice(0, 7);
    if (m) lostM[m] = (lostM[m] || 0) + 1;
  });
  const mesesVP = Array.from(new Set(Object.keys(wonM).concat(Object.keys(lostM)))).sort();
  const cplM = metaM.map(r => (r.leads_plat > 0 && r.gasto) ? r.gasto / r.leads_plat : null);

  let html = qualityBanners(false);
  html += '<div class="note-blue">Visão mensal completa da frente B2B — <strong>não usa o filtro de período do topo</strong>. ' +
    'Vendas contadas pelo mês de fechamento (agregado do CRM); perdas pelo mês de criação do lead — ' +
    'eixos diferentes até o ETL exportar a data de ganho por lead.</div>';

  html += '<div class="grid-2">' +
    (leadsM.length
      ? chartCard('Leads por mês (CRM)', 'entradas no pipeline de venda B2B', 'ch-ev-leads')
      : card('Leads por mês (CRM)', 'entradas no pipeline', emptyDashed('Sem série mensal de leads ainda.'))) +
    (metaM.length
      ? chartCard('Investimento por mês (Meta B2B)', 'gasto das campanhas de leads B2B (meta_b2b)', 'ch-ev-invest')
      : card('Investimento por mês (Meta B2B)', 'gasto da frente', emptyDashed('Sem série mensal de investimento ainda.'))) +
    '</div>';

  html += '<div class="grid-2">' +
    (mesesVP.length
      ? chartCard('Vendas × Perdas por mês', 'vendas pelo mês de fechamento · perdas pelo mês de criação do lead (CRM — fonte de verdade) · verde/vermelho = status de ganho/perda', 'ch-ev-vp')
      : card('Vendas × Perdas por mês', 'CRM — fonte de verdade', emptyDashed('Nenhuma venda ou perda registrada ainda.'))) +
    (metaM.length
      ? chartCard('Custo/Lead Plat. por mês', 'gasto B2B ÷ leads reportados pela plataforma (referência)', 'ch-ev-cpl')
      : card('Custo/Lead Plat. por mês', 'referência da plataforma', emptyDashed('Sem série mensal ainda.'))) +
    '</div>';

  el.innerHTML = html;

  if (leadsM.length) {
    makeChart('ch-ev-leads', {
      type: 'bar',
      data: {
        labels: leadsM.map(r => mesLabel(r.mes)),
        datasets: [barDs('Leads', leadsM.map(r => r.total || 0), S.mostarda)]
      },
      options: baseOpts({
        plugins: { directLabels: { mode: 'all', format: fmt.num } },
        scales: { x: xCat(), y: yCount({ grace: '15%' }) }
      })
    });
  }
  if (metaM.length) {
    makeChart('ch-ev-invest', {
      type: 'bar',
      data: {
        labels: metaM.map(r => mesLabel(r.mes)),
        datasets: [barDs('Gasto (R$)', metaM.map(r => r.gasto || 0), S.terracota)]
      },
      options: baseOpts({
        plugins: {
          tooltip: { callbacks: moneyTooltip() },
          directLabels: { mode: 'all', format: fmt.moneyShort }
        },
        scales: { x: xCat(), y: yMoney({ grace: '20%' }) }
      })
    });
  }
  if (mesesVP.length) {
    makeChart('ch-ev-vp', {
      type: 'bar',
      data: {
        labels: mesesVP.map(mesLabel),
        datasets: [
          barDs('Vendas', mesesVP.map(m => wonM[m] || 0), ST.green),
          barDs('Perdas', mesesVP.map(m => lostM[m] || 0), ST.red)
        ]
      },
      options: baseOpts({
        plugins: {
          legend: legendTop(),
          directLabels: { mode: 'all', format: fmt.num }
        },
        scales: { x: xCat(), y: yCount({ grace: '15%' }) }
      })
    });
  }
  if (metaM.length) {
    makeChart('ch-ev-cpl', {
      type: 'line',
      data: {
        labels: metaM.map(r => mesLabel(r.mes)),
        datasets: [lineDs('Custo/lead plat.', cplM, S.oliva, { pointRadius: 4, spanGaps: false })]
      },
      options: baseOpts({
        plugins: {
          tooltip: {
            callbacks: { label: ctx => ctx.parsed.y == null ? 'sem leads de plataforma no mês' : 'Custo/lead plat.: ' + fmt.currency(ctx.parsed.y) }
          },
          directLabels: { mode: 'all', format: fmt.currency }
        },
        scales: { x: xCat(), y: yMoney({ grace: '20%' }) }
      })
    });
  }
}

/* ============================================================
   B2B · RASTREAMENTO (UTM)
   ============================================================ */
function renderUTM(el) {
  const utm = DATA.utm || {};
  const cob = utm.cobertura || { total: 0, com_utm: 0, pct: 0 };
  const cobEf = utm.cobertura_efetiva || null;

  const listTable = (rows, colName) => rows && rows.length
    ? tableWrap([{ t: colName }, { t: 'Leads', r: 1 }],
      rows.map(r => '<tr><td class="name">' + esc(r.valor) + '</td><td class="r">' + fmt.num(r.leads) + '</td></tr>').join(''))
    : emptyDashed('Sem valores registrados.');

  let html = qualityBanners(false);
  html += banner('blue', 'Cobertura de parametrização dos leads do CRM. Esta página retrata a <strong>foto atual da base</strong> e <strong>não usa o filtro de período</strong>.');

  html += card('Cobertura de UTM', 'quantos leads chegam identificados ao CRM',
    '<div class="coverage">' +
    '<div class="coverage-num">' + fmt.pct(cob.pct, 1) + '</div>' +
    '<div class="coverage-meta">' +
    '<div><strong>' + fmt.num(cob.com_utm) + '</strong> de <strong>' + fmt.num(cob.total) + '</strong> leads chegam com UTM</div>' +
    '<div class="coverage-bar"><span style="width:' + Math.max(0, Math.min(100, cob.pct)) + '%"></span></div>' +
    (cobEf
      ? '<div><strong>Cobertura efetiva: ' + fmt.pct(cobEf.pct, 1) + '</strong> — ' + fmt.num(cobEf.com_atribuicao) +
      ' de ' + fmt.num(cobEf.total) + ' leads com atribuição (' + esc(cobEf.nota || 'UTM ou planilha do formulário') + ').</div>'
      : '') +
    '<div class="note" style="margin-top:0">Todo lead sem UTM nem casamento com a planilha vira "origem desconhecida" — o CPL por CRM descreve só a fatia rastreada.</div>' +
    '</div></div>');

  html += '<div class="grid-2">' +
    card('utm_source', 'origem gravada no lead · foto atual', listTable(utm.sources, 'Source')) +
    card('utm_campaign', 'campanha gravada no lead · foto atual', listTable(utm.campaigns, 'Campanha')) +
    '</div>';

  html += '<div class="grid-2">' +
    card('utm_content', 'conteúdo gravado no lead · foto atual', listTable(utm.contents, 'Content')) +
    card('Performance por campanha (CRM)', 'leads, vendas e perdas por utm_campaign · foto atual',
      utm.campaigns_perf && utm.campaigns_perf.length
        ? tableWrap([
          { t: 'Campanha' }, { t: 'Leads', r: 1 }, { t: 'Vendas', r: 1 }, { t: 'Perdidos', r: 1 }, { t: 'Conversão', r: 1 }
        ], utm.campaigns_perf.map(r =>
          '<tr><td class="name">' + esc(r.campanha) + '</td>' +
          '<td class="r">' + fmt.num(r.leads) + '</td>' +
          '<td class="r">' + fmt.num(r.ganhos) + '</td>' +
          '<td class="r">' + fmt.num(r.perdidos) + '</td>' +
          '<td class="r">' + fmt.pct(r.conversao_pct) + '</td></tr>').join(''))
        : emptyDashed('Sem campanhas rastreadas.')) +
    '</div>';

  html += card('Por que parametrizar 100% dos links?', 'plano de correção do rastreamento',
    '<p style="font-size:13px;margin-bottom:8px">Hoje só ' + fmt.pct(cob.pct, 0) + ' dos leads chegam identificados. Sem UTM, o lead entra no CRM como "origem desconhecida" — impossível saber qual anúncio pagou por ele, e o CPL real fica invisível.</p>' +
    '<p style="font-size:13px;margin-bottom:8px"><strong>1.</strong> Todo link de anúncio, bio e formulário deve carregar utm_source, utm_medium e utm_campaign.</p>' +
    '<p style="font-size:13px;margin-bottom:8px"><strong>2.</strong> No Meta, usar <code>utm_content={{ad.name}}</code> — hoje o utm_content chega com o nome padrão do conjunto, o que impede atribuir lead a criativo. Com o parâmetro dinâmico, o funil por anúncio passa a existir.</p>' +
    '<p style="font-size:13px">Resultado: CPL por campanha, conjunto e criativo calculados com leads reais do CRM — decisões de verba com base no que converte, não no que a plataforma reporta.</p>');

  el.innerHTML = html;
}

/* ============================================================
   E-COMMERCE · VISÃO GERAL
   ============================================================ */
function renderVisaoEcom(el) {
  const me = DATA.meta_ecom || {};
  const dP = fdays(me.daily);
  const gasto = sum(dP, 'gasto');
  const cli = sum(dP, 'cliques_link');
  const imp = sum(dP, 'impressoes');
  const ctr = imp > 0 ? cli / imp * 100 : null;
  const compras = sum(dP, 'compras');
  const receita = sum(dP, 'valor_compras');
  const roas = gasto > 0 ? receita / gasto : null;
  const cpa = compras > 0 ? gasto / compras : null;

  // Google Ads da frente (Shopping) — só o INVESTIMENTO soma com a Meta;
  // conversões/valor do Google são atribuição da plataforma e ficam em
  // bloco próprio, nunca misturadas com compras/receita do pixel.
  const ge = DATA.google_ecom || {};
  const gOk = ge.disponivel === true && !!ge.daily;
  const gdP = gOk ? fdays(ge.daily) : [];
  const gGasto = sum(gdP, 'gasto');
  const gConv = sum(gdP, 'conversoes');
  const gValor = sum(gdP, 'valor_conversoes');
  const gRoas = gGasto > 0 ? gValor / gGasto : null;
  const investTotal = gasto + gGasto;

  let html = banner('blue', 'Compras e receita vêm do <strong>pixel da Meta</strong> (atribuição da plataforma) — ' +
    'a loja ainda não envia venda confirmada para cá. Sem CRM nesta frente: a loja não usa o Kommo. ' +
    'O <strong>Google Ads</strong> fica no bloco próprio abaixo — só o <strong>Investimento total</strong> soma as duas plataformas.');

  // KPI-herói: ROAS (só Meta — receita e gasto da mesma plataforma)
  html += '<div class="kpis cols-hero-6">' +
    kpi('ROAS', roas == null ? null : fmt.dec(roas, 2) + '×',
      roas == null ? 'sem gasto no período' : 'receita ÷ gasto · pixel da Meta (só Meta)', { teal: true, hero: true }) +
    kpi('Investimento (Meta)', fmt.currency(gasto), 'campanhas [ECOMMERCE] no período') +
    kpi('Compras', fmt.num(compras), 'pixel da Meta (só Meta) · no período') +
    kpi('Receita', fmt.currency(receita), 'pixel da Meta (só Meta) · no período') +
    kpi('CPA', cpa == null ? null : fmt.currency(cpa), 'gasto ÷ compras · só Meta') +
    kpi('Cliques no link', fmt.num(cli), ctr == null ? 'no período' : 'CTR ' + fmt.pct(ctr, 1)) +
    '</div>';

  // ----- Investimento total + KPIs Google (atribuição do Google) -----
  html += card('Google Ads (Shopping) · atribuição do Google',
    gOk
      ? 'contexto da frente · o <strong>Investimento total</strong> soma Meta + Google no período; conversões e valor são reportados pelo Google e <strong>não somam</strong> com as compras/receita do pixel acima · detalhe na página Google Ads'
      : esc(ge.motivo || 'Google Ads sem dados para esta frente.'),
    '<div class="kpis cols-4 in-card">' +
    kpi('Investimento total', fmt.currency(investTotal),
      gOk ? 'Meta + Google Ads da frente · no período' : 'só Meta no período — Google sem dados') +
    kpi('Investimento Google', gOk ? fmt.currency(gGasto) : null, gOk ? 'Shopping · no período' : 'sem dados') +
    kpi('Conversões Google', gOk ? fmt.num(gConv) : null, 'atribuição do Google') +
    kpi('ROAS Google', (gOk && gRoas != null) ? fmt.dec(gRoas, 2) + '×' : null,
      'valor conv. ÷ gasto · atribuição do Google') +
    '</div>');

  const sG = dailySeries(me.daily, ['gasto']);
  const sC = dailySeries(me.daily, ['compras', 'valor_compras']);

  html += '<div class="grid-2">' +
    (sG
      ? chartCard('Gasto por dia', 'campanhas de e-commerce (Meta)', 'ch-ec-gasto', '',
        dailyRelief(sG, [{ k: 'gasto', t: 'Gasto', f: fmt.currency }]))
      : card('Gasto por dia', 'campanhas de e-commerce (Meta)', emptyDashed('Sem gasto no período selecionado.', 'Ajuste o filtro de período no topo.'))) +
    (sC
      ? chartCard('Compras por dia', 'pixel da Meta', 'ch-ec-compras', '',
        dailyRelief(sC, [{ k: 'compras', t: 'Compras', f: fmt.num }, { k: 'valor_compras', t: 'Receita', f: fmt.currency }]))
      : card('Compras por dia', 'pixel da Meta', emptyDashed('Sem compras no período selecionado.'))) +
    '</div>';

  el.innerHTML = html;

  if (sG) {
    // Terracota em série densa → linha 2px + relief "Ver tabela"
    makeChart('ch-ec-gasto', {
      type: 'line',
      data: { labels: sG.labels, datasets: [lineDs('Gasto (R$)', sG.data.gasto, S.terracota, { fill: true })] },
      options: baseOpts({
        plugins: { tooltip: { callbacks: moneyTooltip() } },
        scales: { y: yMoney() }
      })
    });
  }
  if (sC) {
    makeChart('ch-ec-compras', {
      type: 'bar',
      data: { labels: sC.labels, datasets: [barDs('Compras', sC.data.compras, S.oliva)] },
      options: baseOpts({})
    });
  }
}

/* ============================================================
   E-COMMERCE · META ADS — campanhas [ECOMMERCE], compras/receita do pixel
   ============================================================ */
function renderMetaEcom(el) {
  const meta = DATA.meta_ecom || {};
  const campDailyP = fdays(meta.campaign_daily);

  const gasto = sum(campDailyP, 'gasto');
  const imp = sum(campDailyP, 'impressoes');
  const cli = sum(campDailyP, 'cliques_link');
  const ctr = imp > 0 ? cli / imp * 100 : null;
  const compras = sum(campDailyP, 'compras');
  const receita = sum(campDailyP, 'valor_compras');
  const roas = gasto > 0 ? receita / gasto : null;
  const cpa = compras > 0 ? gasto / compras : null;

  let html = banner('blue', 'Campanhas <strong>[ECOMMERCE]</strong> — compras e receita reportadas pelo <strong>pixel da Meta</strong>. ' +
    'O impulsionamento da conta está na página Institucional &amp; Impulsionamento. ' +
    'Cliques, CTR e CPC usam <strong>cliques no link</strong> (link clicks) — não o total de cliques do anúncio.');

  html += '<div class="kpis cols-6">' +
    kpi('Gasto', fmt.currency(gasto), 'no período') +
    kpi('Impressões', fmt.num(imp), 'no período') +
    kpi('Cliques no link', fmt.num(cli), ctr == null ? 'no período' : 'CTR ' + fmt.pct(ctr, 1)) +
    kpi('Compras', fmt.num(compras), 'pixel da Meta') +
    kpi('Receita', fmt.currency(receita), 'pixel da Meta') +
    kpi('ROAS', roas == null ? null : fmt.dec(roas, 2) + '×',
      cpa == null ? 'receita ÷ gasto' : 'receita ÷ gasto · CPA ' + fmt.currency(cpa), { teal: true }) +
    '</div>';

  // ----- Gasto × Compras por dia — PAR DE LINHAS no mesmo X (sem eixo duplo)
  const sDay = dailySeries(meta.daily, ['gasto', 'compras']);
  html += (sDay
    ? multiChartCard('Gasto × Compras por dia',
      'par de gráficos de linha no mesmo eixo X (sem eixo duplo) · acima: gasto · abaixo: compras (pixel da Meta) · respeita o filtro de período',
      'ch-me-gasto-dia', 'ch-me-compras-dia',
      dailyRelief(sDay, [
        { k: 'gasto', t: 'Gasto', f: fmt.currency },
        { k: 'compras', t: 'Compras', f: fmt.num }
      ]))
    : card('Gasto × Compras por dia', 'gasto e compras diárias',
      emptyDashed('Sem dados no período selecionado.', 'Ajuste o filtro de período no topo.')));

  // ----- CAMPANHAS -----
  const statusDict = dict(meta.campaign_status);
  const byCamp = aggBy(campDailyP, r => r.campanha, ['gasto', 'impressoes', 'cliques_link', 'compras', 'valor_compras']);
  const campRows = Object.keys(byCamp)
    .map(k => ({ nome: k, v: byCamp[k] }))
    .filter(r => r.v.gasto > 0 || r.v.compras > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const campBody = campRows.map(r => {
    const v = r.v;
    const rctr = v.impressoes > 0 ? v.cliques_link / v.impressoes * 100 : null;
    const rroas = v.gasto > 0 ? v.valor_compras / v.gasto : null;
    const rcpa = v.compras > 0 ? v.gasto / v.compras : null;
    return '<tr><td>' + statusBadge(statusDict[r.nome]) + '</td>' +
      '<td class="name">' + esc(r.nome) + '</td>' +
      '<td class="r">' + fmt.currency(v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(v.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(v.cliques_link) + '</td>' +
      '<td class="r">' + fmt.pct(rctr, 1) + '</td>' +
      '<td class="r">' + fmt.num(v.compras) + '</td>' +
      '<td class="r">' + fmt.currency(v.valor_compras) + '</td>' +
      '<td class="r">' + (rroas == null ? '—' : fmt.dec(rroas, 2) + '×') + '</td>' +
      '<td class="r">' + (rcpa == null ? '—' : fmt.currency(rcpa)) + '</td></tr>';
  }).join('');
  html += card('Campanhas', 'status real via API · métricas do período filtrado · compras e receita do pixel da Meta',
    campBody
      ? tableWrap([
        { t: 'Status' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 }, { t: 'Cliques no link', r: 1 },
        { t: 'CTR', r: 1 }, { t: 'Compras', r: 1 }, { t: 'Receita', r: 1 }, { t: 'ROAS', r: 1 }, { t: 'CPA', r: 1 }
      ], campBody)
      : emptyDashed('Nenhuma campanha de e-commerce com gasto no período.', 'Ajuste o filtro de período no topo.'));

  // ----- CONJUNTOS -----
  const adsetP = fdays(meta.adset_daily);
  const byAdset = aggBy(adsetP, r => r.campanha + '|||' + r.conjunto, ['gasto', 'cliques_link', 'compras', 'valor_compras']);
  const adsetRows = Object.keys(byAdset)
    .map(k => ({ campanha: byAdset[k].__row.campanha, conjunto: byAdset[k].__row.conjunto, v: byAdset[k] }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const adsetBody = adsetRows.map(r => {
    const v = r.v;
    const rroas = v.gasto > 0 ? v.valor_compras / v.gasto : null;
    const rcpa = v.compras > 0 ? v.gasto / v.compras : null;
    return '<tr><td class="name">' + esc(r.conjunto) + '</td>' +
      '<td class="dim">' + esc(r.campanha) + '</td>' +
      '<td class="r">' + fmt.currency(v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(v.cliques_link) + '</td>' +
      '<td class="r">' + fmt.num(v.compras) + '</td>' +
      '<td class="r">' + fmt.currency(v.valor_compras) + '</td>' +
      '<td class="r">' + (rroas == null ? '—' : fmt.dec(rroas, 2) + '×') + '</td>' +
      '<td class="r">' + (rcpa == null ? '—' : fmt.currency(rcpa)) + '</td></tr>';
  }).join('');
  html += card('Conjuntos de anúncios', 'agrupado por campanha + conjunto · compras e receita do pixel da Meta',
    adsetBody
      ? tableWrap([
        { t: 'Conjunto' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Cliques no link', r: 1 },
        { t: 'Compras', r: 1 }, { t: 'Receita', r: 1 }, { t: 'ROAS', r: 1 }, { t: 'CPA', r: 1 }
      ], adsetBody) +
      '<div class="note">Impressões por conjunto ainda não são exportadas pelo ETL.</div>'
      : emptyDashed('Nenhum conjunto com gasto no período.'));

  // ----- ANÚNCIOS -----
  const metaCreat = Object.create(null);
  (meta.creatives || []).forEach(c => { metaCreat[c.anuncio + '|||' + c.campanha] = c; });
  const creatP = fdays(meta.creatives_daily);
  const byCreat = aggBy(creatP, r => r.anuncio + '|||' + r.campanha, ['gasto', 'cliques_link', 'compras', 'valor_compras']);
  const ADS_CAP = 25;
  const creatRows = Object.keys(byCreat)
    .map(k => ({ k, v: byCreat[k], agg: metaCreat[k] || {} }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const creatBody = creatRows.slice(0, ADS_CAP).map(r => {
    const a = r.agg;
    const anuncio = r.v.__row.anuncio;
    const v = r.v;
    const rroas = v.gasto > 0 ? v.valor_compras / v.gasto : null;
    const rcpa = v.compras > 0 ? v.gasto / v.compras : null;
    const thumb = a.thumbnail
      ? '<img class="thumb" src="' + esc(a.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
      'onerror="this.style.display=&#39;none&#39;;this.nextElementSibling.style.display=&#39;flex&#39;"><div class="thumb-fb">▦</div>'
      : '<div class="thumb-fb" style="display:flex">▦</div>';
    const plink = safeHttpUrl(a.permalink);
    const nome = plink
      ? '<a href="' + esc(plink) + '" target="_blank" rel="noopener">' + esc(anuncio) + ' 🔗</a>'
      : '<span class="name">' + esc(anuncio || '(sem nome)') + '</span>';
    return '<tr><td><div class="cell-creative">' + thumb + nome + '</div></td>' +
      '<td class="dim">' + esc(a.conjunto || '—') + '</td>' +
      '<td class="r">' + fmt.currency(v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(v.cliques_link) + '</td>' +
      '<td class="r">' + fmt.num(v.compras) + '</td>' +
      '<td class="r">' + fmt.currency(v.valor_compras) + '</td>' +
      '<td class="r">' + (rroas == null ? '—' : fmt.dec(rroas, 2) + '×') + '</td>' +
      '<td class="r">' + (rcpa == null ? '—' : fmt.currency(rcpa)) + '</td></tr>';
  }).join('');
  html += card('Anúncios', 'criativo × campanha · clique no nome para ver o anúncio',
    creatBody
      ? tableWrap([
        { t: 'Anúncio' }, { t: 'Conjunto principal' }, { t: 'Gasto', r: 1 }, { t: 'Cliques no link', r: 1 },
        { t: 'Compras', r: 1 }, { t: 'Receita', r: 1 }, { t: 'ROAS', r: 1 }, { t: 'CPA', r: 1 }
      ], creatBody) +
      '<div class="note">Um anúncio pode rodar em mais de um conjunto — a coluna mostra o conjunto principal ' +
      'do anúncio na série (o ETL ainda não exporta o conjunto no diário por criativo). ' +
      'O gasto por conjunto correto está na tabela Conjuntos acima.</div>' +
      (creatRows.length > ADS_CAP
        ? '<div class="note">Mostrando os ' + ADS_CAP + ' anúncios com maior gasto de ' + fmt.num(creatRows.length) + ' no período.</div>'
        : '')
      : emptyDashed('Nenhum anúncio com gasto no período.'));

  el.innerHTML = html;

  if (sDay) {
    makeChart('ch-me-gasto-dia', {
      type: 'line',
      data: { labels: sDay.labels, datasets: [lineDs('Gasto (R$)', sDay.data.gasto, S.terracota, { pointRadius: 3 })] },
      options: baseOpts({
        plugins: {
          tooltip: { callbacks: moneyTooltip() },
          directLabels: { mode: 'max', format: fmt.moneyShort }   // pico rotulado; relief na tabela
        },
        scales: {
          x: deepMerge(xDaily(), { ticks: { display: false } }),
          y: lockYWidth(yMoney({ grace: '18%' }), 68)
        }
      })
    });
    makeChart('ch-me-compras-dia', {
      type: 'line',
      data: { labels: sDay.labels, datasets: [lineDs('Compras', sDay.data.compras, S.oliva, { pointRadius: 3 })] },
      options: baseOpts({
        plugins: { directLabels: { mode: 'max', format: fmt.num } },
        scales: {
          x: xDaily(),
          y: lockYWidth(yCount({ grace: '18%' }), 68)
        }
      })
    });
  }
}

/* ============================================================
   E-COMMERCE · INSTITUCIONAL & IMPULSIONAMENTO (conta inteira)
   ============================================================ */
function renderInstitucional(el) {
  const inst = DATA.institucional || {};
  const IM = (inst.monthly || []).filter(r => monthInPeriod(r.mes));
  const gasto = sum(IM, 'gasto');
  const imp = sum(IM, 'impressoes');
  const eng = sum(IM, 'engajamento');
  const views = sum(IM, 'video_views');
  const segs = sum(IM, 'seguidores');
  const cpm = imp > 0 ? gasto / imp * 1000 : null;
  const cpe = eng > 0 ? gasto / eng : null;
  const hasPeriod = IM.length > 0;

  let html = '<div class="scope-badge">⚠ conta inteira — não é específico desta frente</div>';
  html += banner('blue', 'As campanhas de impulsionamento são da <strong>conta inteira</strong> do Instagram/Facebook — não são específicas do e-commerce. ' +
    'Dados com granularidade <strong>mensal</strong>: o filtro de período considera os meses selecionados inteiros. ' +
    'Sem métrica de alcance de propósito: <strong>alcance não é aditivo</strong> (somar alcances diários infla o número) — usamos impressões.');

  html += '<div class="kpis cols-6">' +
    kpi('Investimento', hasPeriod ? fmt.currency(gasto) : null, 'impulsionamento nos meses do período') +
    kpi('Impressões', hasPeriod ? fmt.num(imp) : null, 'soma dos meses do período') +
    kpi('Engajamento', hasPeriod ? fmt.num(eng) : null, 'interações com posts') +
    kpi('Views de vídeo', hasPeriod ? fmt.num(views) : null, 'nos meses do período') +
    kpi('Novos seguidores', hasPeriod ? fmt.num(segs) : null, 'nos meses do período') +
    kpi('Custo / engajamento', cpe == null ? null : fmt.currency(cpe),
      cpm == null ? 'gasto ÷ interações' : 'gasto ÷ interações · CPM ' + fmt.currency(cpm), { teal: true }) +
    '</div>';

  // split de gasto por frente (toda a série) — novo schema {b2b, ecommerce, inst}
  // Barras horizontais rotuladas, NÃO donut: com 3 fatias todos os pares se
  // tocam e o par mostarda↔oliva reprova no validador sob deuteranopia
  // (ΔE 3,0 < piso 6). Nominal → uma cor só + rótulo em toda barra (relief).
  const split = inst.split_gasto || {};
  const splitPairs = [
    ['B2B Atacado (leads)', split.b2b || 0],
    ['E-commerce', split.ecommerce || 0],
    ['Institucional (impulsionamento)', split.inst || 0]
  ];
  const splitShort = ['B2B Atacado', 'E-commerce', 'Institucional'];
  const splitTotal = splitPairs.reduce((a, p2) => a + p2[1], 0);
  const splitLegend = '<div class="split-legend">' + splitPairs.map(p2 =>
    '<div class="split-row">' +
    '<span class="lb">' + esc(p2[0]) + '</span>' +
    '<span class="vl">' + fmt.currency(p2[1]) + (splitTotal > 0 ? ' · ' + fmt.pct(p2[1] / splitTotal * 100, 0) : '') + '</span></div>').join('') + '</div>';

  const instRelief = reliefTable(
    [{ t: 'Mês' }, { t: 'Gasto', r: 1 }, { t: 'Engajamento', r: 1 }],
    IM.map(r => '<tr><td>' + mesLabel(r.mes) + '</td>' +
      '<td class="r">' + fmt.currency(r.gasto || 0) + '</td>' +
      '<td class="r">' + fmt.num(r.engajamento || 0) + '</td></tr>').join(''));
  html += '<div class="grid-2">' +
    card('Divisão do investimento Meta por frente', 'conta inteira, classificada pelo nome da campanha · categoria nominal — uma cor só · toda a série — não usa o filtro',
      chartBox('ch-inst-split') + splitLegend) +
    (IM.length
      ? multiChartCard('Investimento × Engajamento (mensal)',
        'par de gráficos de linha no mesmo eixo X (sem eixo duplo) · acima: gasto · abaixo: engajamento',
        'ch-inst-mensal-gasto', 'ch-inst-mensal-eng', instRelief)
      : card('Investimento × Engajamento (mensal)', 'gasto e interações por mês', emptyDashed('Sem meses de impulsionamento no período selecionado.', 'Amplie o período no topo.'))) +
    '</div>';

  // tabela campanhas institucionais (totais da série — sem fonte diária)
  // thumbnail: do anúncio de maior gasto da campanha · clique → post no Instagram
  const rows = (inst.campaigns || []).slice().sort((a, b) => (b.gasto || 0) - (a.gasto || 0)).map(c => {
    const rcpe = (c.engajamento || 0) > 0 ? (c.gasto || 0) / c.engajamento : null;
    const inicial = esc(String(c.campanha || '?').trim().charAt(0).toUpperCase() || '?');
    const thumb = c.thumbnail
      ? '<img class="thumb sm" src="' + esc(c.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
      'onerror="this.style.display=&#39;none&#39;;this.nextElementSibling.style.display=&#39;flex&#39;"><div class="thumb-fb sm">' + inicial + '</div>'
      : '<div class="thumb-fb sm" style="display:flex">' + inicial + '</div>';
    const plink = safeHttpUrl(c.permalink);
    const cell = plink
      ? '<a class="camp-link" href="' + esc(plink) + '" target="_blank" rel="noopener" title="ver o post no Instagram/Facebook">' + thumb + '<span>' + esc(c.campanha) + ' 🔗</span></a>'
      : thumb + '<span class="name">' + esc(c.campanha) + '</span>';
    return '<tr><td>' + statusBadge(c.status) + '</td>' +
      '<td><div class="cell-creative">' + cell + '</div></td>' +
      '<td class="r">' + fmt.currency(c.gasto) + '</td>' +
      '<td class="r">' + fmt.num(c.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(c.engajamento) + '</td>' +
      '<td class="r">' + fmt.num(c.video_views) + '</td>' +
      '<td class="r">' + (rcpe == null ? '—' : fmt.currency(rcpe)) + '</td></tr>';
  }).join('');
  html += card('Campanhas institucionais',
    'status real via API · miniatura = anúncio de maior gasto da campanha — clique para abrir o post · totais de toda a série — <strong>não usa o filtro de período</strong>',
    rows
      ? tableWrap([
        { t: 'Status' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 },
        { t: 'Engajamento', r: 1 }, { t: 'Views', r: 1 }, { t: 'Custo/engaj.', r: 1 }
      ], rows)
      : emptyDashed('Nenhuma campanha de impulsionamento registrada.'));

  el.innerHTML = html;

  // Nominal → barra horizontal, UMA cor (terracota = gasto) + rótulo direto
  // em toda barra (relief exigido pelos 2,99:1 da terracota) + legenda com
  // valores e % abaixo.
  makeChart('ch-inst-split', {
    type: 'bar',
    data: {
      labels: splitShort,
      datasets: [barDs('Gasto (R$)', splitPairs.map(p2 => p2[1]), S.terracota, { borderSkipped: 'left' })]
    },
    options: baseOpts({
      indexAxis: 'y',
      plugins: {
        tooltip: { callbacks: moneyTooltip() },
        directLabels: { mode: 'all', format: fmt.moneyShort }
      },
      scales: {
        x: yCount({
          position: 'bottom', grace: '18%',
          ticks: { maxRotation: 0, minRotation: 0, callback: v => 'R$ ' + Number(v).toLocaleString('pt-BR') }
        }),
        y: { grid: { display: false }, ticks: { color: P.soft } }
      }
    })
  });

  if (IM.length) {
    const labels = IM.map(r => mesLabel(r.mes));
    makeChart('ch-inst-mensal-gasto', {
      type: 'line',
      data: { labels, datasets: [lineDs('Gasto (R$)', IM.map(r => r.gasto || 0), S.terracota, { pointRadius: 4 })] },
      options: baseOpts({
        plugins: {
          tooltip: { callbacks: moneyTooltip() },
          directLabels: { mode: 'max', format: fmt.moneyShort }   // rótulo no pico; relief na tabela
        },
        scales: {
          x: xCat({ ticks: { display: false } }),
          y: lockYWidth(yMoney({ grace: '20%' }), 68)
        }
      })
    });
    makeChart('ch-inst-mensal-eng', {
      type: 'line',
      data: { labels, datasets: [lineDs('Engajamento', IM.map(r => r.engajamento || 0), S.oliva, { pointRadius: 4 })] },
      options: baseOpts({
        plugins: { directLabels: { mode: 'max', format: fmt.num } },
        scales: {
          x: xCat(),
          y: lockYWidth(yCount({ grace: '20%', ticks: { callback: v => Number(v).toLocaleString('pt-BR') } }), 68)
        }
      })
    });
  }
}

/* ============================================================
   PÚBLICO (compartilhada) — breakdowns mensais da Meta, campo "frente"
   B2B: linhas frente = b2b · E-commerce: toggle ecommerce / inst / ambas
   ============================================================ */
function pubFrentes(front) {
  if (front === 'b2b') return ['b2b'];
  if (ECOM_PUB_VIEW === 'ambas') return ['ecommerce', 'inst'];
  return [ECOM_PUB_VIEW];
}
/* Ordem preferida dos buckets da Meta; faixas NOVAS que o ETL passar a emitir
   (ex.: '13-17') entram no fim da lista conhecida em vez de sumirem do
   gráfico enquanto seguem somadas no total. */
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'Unknown'];
function stackByAgeGender(rows, field, frentes) {
  // Faixas derivadas dos DADOS (todas as linhas, sem filtro — categorias
  // estáveis ao trocar período/toggle), ordenadas pela ordem conhecida.
  const ord = a => { const i = AGE_ORDER.indexOf(a); return i < 0 ? AGE_ORDER.length : i; };
  const ages = Array.from(new Set((rows || []).map(r => r.idade).filter(a => a != null)))
    .sort((a, b) => (ord(a) - ord(b)) || String(a).localeCompare(String(b), 'pt-BR'));
  const g = { female: Object.create(null), male: Object.create(null), unknown: Object.create(null) };
  let total = 0;
  (rows || []).forEach(r => {
    if (!monthInPeriod(r.mes)) return;
    if (frentes.indexOf(r.frente) < 0) return;
    const gg = Object.prototype.hasOwnProperty.call(g, r.genero) ? g[r.genero] : g.unknown;
    gg[r.idade] = (gg[r.idade] || 0) + (r[field] || 0);
    total += r[field] || 0;
  });
  return {
    ages, total,
    fem: ages.map(a => g.female[a] || 0),
    mas: ages.map(a => g.male[a] || 0),
    unk: ages.map(a => g.unknown[a] || 0)
  };
}
function renderPublico(el, front) {
  const pub = DATA.publico || {};
  const frentes = pubFrentes(front);
  const isB2B = front === 'b2b';

  let html = '';
  if (isB2B) {
    html += qualityBanners(false);
    html += banner('blue', 'Dados da Meta com granularidade <strong>mensal</strong> — o filtro considera os <strong>meses selecionados inteiros</strong>. ' +
      'Somente as campanhas da frente <strong>B2B</strong> (campo frente = b2b).');
  } else {
    html += banner('blue', 'Dados da Meta com granularidade <strong>mensal</strong> — o filtro considera os <strong>meses selecionados inteiros</strong>. ' +
      'O institucional é da <strong>conta inteira</strong> — não é específico desta frente.');
    const opts = [['ecommerce', 'E-commerce'], ['inst', 'Institucional'], ['ambas', 'Ambas']];
    html += '<div class="seg-toggle" id="pub-toggle">' + opts.map(o =>
      '<button type="button" data-v="' + o[0] + '" class="' + (ECOM_PUB_VIEW === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</div>';
  }

  // segunda métrica: B2B tem leads_plat; e-commerce não reporta leads → cliques.
  // Os breakdowns de público da Meta NÃO exportam cliques no link — aqui vale
  // o total de cliques do anúncio, com nota explícita (única exceção do painel).
  const metric2 = isB2B ? 'leads_plat' : 'cliques';
  const metric2Title = isB2B ? 'Leads Plataforma por idade e gênero' : 'Cliques (totais) por idade e gênero';
  const metric2Sub = isB2B
    ? 'quem responde aos anúncios (número da plataforma — referência)'
    : 'quem clica nos anúncios da(s) frente(s) selecionada(s) · total de cliques do anúncio — o breakdown da Meta não exporta cliques no link';
  const cliquesNote = '<div class="note"><strong>Cliques (totais)</strong> e CTR desta página usam o total de cliques do anúncio — ' +
    'o export de público da Meta não traz "cliques no link". Os KPIs das páginas Meta Ads usam cliques no link.</div>';

  const inv = stackByAgeGender(pub.age_gender, 'gasto', frentes);
  const m2 = stackByAgeGender(pub.age_gender, metric2, frentes);

  // posicionamentos
  const placM = (pub.placement || []).filter(r => monthInPeriod(r.mes) && frentes.indexOf(r.frente) >= 0);
  const byPlace = aggBy(placM, r => (r.plataforma || '?') + ' · ' + (r.posicao || '?'), ['gasto', 'impressoes', 'cliques', 'leads_plat']);
  const placeRows = Object.keys(byPlace)
    .map(k => ({ k, v: byPlace[k] }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto)
    .map(r => {
      const rctr = r.v.impressoes > 0 ? r.v.cliques / r.v.impressoes * 100 : null;
      return '<tr><td class="name" style="text-transform:lowercase">' + esc(r.k) + '</td>' +
        '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
        '<td class="r">' + fmt.num(r.v.impressoes) + '</td>' +
        '<td class="r">' + fmt.num(r.v.cliques) + '</td>' +
        '<td class="r">' + fmt.pct(rctr, 1) + '</td>' +
        (isB2B ? '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' : '') + '</tr>';
    }).join('');

  // regiões
  const regM = (pub.region || []).filter(r => monthInPeriod(r.mes) && frentes.indexOf(r.frente) >= 0);
  const byReg = aggBy(regM, r => (r.regiao || '(sem região)').replace(' (state)', ''), ['gasto']);
  const topReg = Object.keys(byReg)
    .map(k => ({ k, gasto: byReg[k].gasto }))
    .sort((a, b) => b.gasto - a.gasto)
    .slice(0, 12);

  const genderReliefRows = d => d.ages.map((a, i) =>
    '<tr><td>' + esc(a) + '</td><td class="r">' + fmt.num(d.fem[i]) + '</td>' +
    '<td class="r">' + fmt.num(d.mas[i]) + '</td><td class="r">' + fmt.num(d.unk[i]) + '</td></tr>').join('');
  const genderReliefRowsMoney = d => d.ages.map((a, i) =>
    '<tr><td>' + esc(a) + '</td><td class="r">' + fmt.currency(d.fem[i]) + '</td>' +
    '<td class="r">' + fmt.currency(d.mas[i]) + '</td><td class="r">' + fmt.currency(d.unk[i]) + '</td></tr>').join('');
  const gHead = [{ t: 'Idade' }, { t: 'Feminino', r: 1 }, { t: 'Masculino', r: 1 }, { t: 'Não informado', r: 1 }];

  html += '<div class="grid-2">' +
    (inv.total > 0
      ? chartCard('Investimento por idade e gênero', 'onde o orçamento está sendo gasto', 'ch-pub-inv', '',
        reliefTable(gHead, genderReliefRowsMoney(inv)))
      : card('Investimento por idade e gênero', 'onde o orçamento está sendo gasto', emptyDashed('Sem dados de público nos meses do período.', 'Amplie o período no topo.'))) +
    (m2.total > 0
      ? chartCard(metric2Title, metric2Sub, 'ch-pub-m2', '', reliefTable(gHead, genderReliefRows(m2)))
      : card(metric2Title, metric2Sub, emptyDashed(isB2B
        ? 'Sem leads de plataforma nos meses do período.'
        : 'Sem cliques nos meses do período.', 'Amplie o período no topo.'))) +
    '</div>';

  html += '<div class="grid-2">' +
    card('Posicionamentos', 'feed, stories, reels — onde os anúncios rodam',
      placeRows
        ? tableWrap([
          { t: 'Posicionamento' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 },
          { t: 'Cliques (totais)', r: 1 }, { t: 'CTR', r: 1 }
        ].concat(isB2B ? [{ t: 'Leads plataforma', r: 1 }] : []), placeRows) + cliquesNote
        : emptyDashed('Sem dados de posicionamento nos meses do período.')) +
    (topReg.length
      ? chartCard('Regiões', 'top 12 por investimento · categoria nominal — uma cor só', 'ch-pub-reg', 'tall')
      : card('Regiões', 'top 12 por investimento', emptyDashed('Sem dados de região nos meses do período.'))) +
    '</div>';

  el.innerHTML = html;

  // toggle do e-commerce (re-render da página)
  if (!isB2B) {
    const tg = document.getElementById('pub-toggle');
    if (tg) tg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        if (ECOM_PUB_VIEW !== b.dataset.v) { ECOM_PUB_VIEW = b.dataset.v; route(); }
      });
    });
  }

  // Stacked: Feminino=mostarda, Masculino=terracota, Não informado=cinza neutro.
  // Gap de 2px entre segmentos via borda na cor da superfície; relief "Ver tabela".
  const milharTick = v => Number(v).toLocaleString('pt-BR');
  const stackedOpts = moneyAxis => baseOpts({
    plugins: deepMerge({ legend: legendTop() }, moneyAxis ? { tooltip: { callbacks: moneyTooltip() } } : {}),
    scales: {
      x: xCat({ stacked: true }),
      y: moneyAxis ? yCount({ stacked: true, ticks: { callback: milharTick } }) : yCount({ stacked: true })
    }
  });
  const segExtra = { stack: 'g', borderColor: P.bgCard, borderWidth: 2, borderRadius: 3, maxBarThickness: 42 };
  const genderSets = d => [
    barDs('Feminino', d.fem, S.mostarda, segExtra),
    barDs('Masculino', d.mas, S.terracota, segExtra),
    barDs('Não informado', d.unk, P.muted, segExtra)
  ];
  if (inv.total > 0) {
    makeChart('ch-pub-inv', { type: 'bar', data: { labels: inv.ages, datasets: genderSets(inv) }, options: stackedOpts(true) });
  }
  if (m2.total > 0) {
    makeChart('ch-pub-m2', { type: 'bar', data: { labels: m2.ages, datasets: genderSets(m2) }, options: stackedOpts(false) });
  }
  if (topReg.length) {
    // Nominal → UMA cor (terracota) + rótulo direto em toda barra (relief)
    makeChart('ch-pub-reg', {
      type: 'bar',
      data: {
        labels: topReg.map(r => r.k),
        datasets: [barDs('Gasto (R$)', topReg.map(r => r.gasto), S.terracota, { borderSkipped: 'left' })]
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: {
          tooltip: { callbacks: moneyTooltip() },
          directLabels: { mode: 'all', format: fmt.moneyShort }
        },
        scales: {
          x: yCount({ position: 'bottom', grace: '18%', ticks: { maxRotation: 0, minRotation: 0, callback: milharTick } }),
          y: { grid: { display: false }, ticks: { color: P.soft } }
        }
      })
    });
  }
}

/* ============================================================
   E-COMMERCE · EVOLUÇÃO MENSAL
   ============================================================ */
function renderEvolucaoEcom(el) {
  const metaM = (DATA.meta_ecom || {}).monthly || [];
  const roasM = metaM.map(r => (r.gasto > 0 && r.valor_compras != null) ? r.valor_compras / r.gasto : null);

  let html = '<div class="note-blue">Visão mensal completa da frente E-commerce — <strong>não usa o filtro de período do topo</strong>. ' +
    'Compras e receita reportadas pelo pixel da Meta.</div>';

  if (!metaM.length) {
    html += card('Evolução mensal', 'série mensal da frente', emptyDashed('Sem série mensal ainda.'));
    el.innerHTML = html;
    return;
  }

  html += '<div class="grid-2">' +
    chartCard('Investimento por mês', 'gasto das campanhas [ECOMMERCE]', 'ch-eve-gasto') +
    chartCard('Compras por mês', 'pixel da Meta', 'ch-eve-compras') +
    '</div>';
  html += '<div class="grid-2">' +
    chartCard('Receita por mês', 'pixel da Meta', 'ch-eve-receita') +
    chartCard('ROAS por mês', 'receita ÷ gasto', 'ch-eve-roas') +
    '</div>';

  el.innerHTML = html;

  const labels = metaM.map(r => mesLabel(r.mes));
  makeChart('ch-eve-gasto', {
    type: 'bar',
    data: { labels, datasets: [barDs('Gasto (R$)', metaM.map(r => r.gasto || 0), S.terracota)] },
    options: baseOpts({
      plugins: {
        tooltip: { callbacks: moneyTooltip() },
        directLabels: { mode: 'all', format: fmt.moneyShort }
      },
      scales: { x: xCat(), y: yMoney({ grace: '20%' }) }
    })
  });
  makeChart('ch-eve-compras', {
    type: 'bar',
    data: { labels, datasets: [barDs('Compras', metaM.map(r => r.compras || 0), S.oliva)] },
    options: baseOpts({
      plugins: { directLabels: { mode: 'all', format: fmt.num } },
      scales: { x: xCat(), y: yCount({ grace: '15%' }) }
    })
  });
  makeChart('ch-eve-receita', {
    type: 'bar',
    data: { labels, datasets: [barDs('Receita (R$)', metaM.map(r => r.valor_compras || 0), S.mostarda)] },
    options: baseOpts({
      plugins: {
        tooltip: { callbacks: moneyTooltip() },
        directLabels: { mode: 'all', format: fmt.moneyShort }
      },
      scales: { x: xCat(), y: yMoney({ grace: '20%' }) }
    })
  });
  makeChart('ch-eve-roas', {
    type: 'line',
    data: { labels, datasets: [lineDs('ROAS', roasM, S.terracota, { pointRadius: 4, spanGaps: false })] },
    options: baseOpts({
      plugins: {
        tooltip: { callbacks: { label: ctx => ctx.parsed.y == null ? 'sem gasto no mês' : 'ROAS: ' + fmt.dec(ctx.parsed.y, 2) + '×' } },
        directLabels: { mode: 'all', format: v => fmt.dec(v, 2) + '×' }
      },
      scales: { x: xCat(), y: yCount({ grace: '25%', ticks: { callback: v => fmt.dec(v, 1) + '×' } }) }
    })
  });
}

/* ============================================================
   Carga de dados — dev (embutido/fetch) × produção (Supabase Auth)
   ============================================================ */
/* Produção: preencher ao criar o projeto Supabase exclusivo da Terrana.
   A anon key é pública por design; o e-mail é o usuário fixo do painel
   (blueprint da agência: a tela de login pede só a senha). */
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';
const DASH_EMAIL = 'dashboard@terrana.com.br';
const SUPABASE_BUCKET = 'dashboard-data';
let sbClient = null;

function showFatal(msg) {
  document.getElementById('loading').hidden = false;
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-msg').classList.add('fatal');
  const sp = document.querySelector('#loading .spin');
  if (sp) sp.style.display = 'none';
}

async function loadData() {
  // 1) Dados embutidos (data/summary.js) — cobre abrir com duplo clique.
  //    Em produção autenticada o arquivo não é publicado, então este passo
  //    e o seguinte simplesmente não acontecem lá.
  if (window.__SUMMARY__) {
    DATA = window.__SUMMARY__;
    startDashboard();
    return;
  }
  // 2) Fallback dev: fetch do JSON servido junto do front.
  try {
    const res = await fetch('data/summary.json', { cache: 'no-store' });
    if (res.ok) {
      DATA = await res.json();
      startDashboard();
      return;
    }
  } catch (e) { /* segue */ }
  // 3) Produção com Supabase configurado → login (só senha; e-mail fixo).
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    showLogin();
    return;
  }
  // 4) Nada disponível: explicar o que fazer.
  showFatal('Os dados ainda não chegaram até aqui. Se você abriu o arquivo pelo OneDrive, aguarde a ' +
    'sincronização da pasta terminar (botão direito → "Sempre manter neste dispositivo") e recarregue. ' +
    'Se estiver rodando local, suba um servidor na pasta dashboard (ex.: python -m http.server) e abra por ele.');
}

/* --- produção: Supabase Auth + bucket privado --- */
function loadSupabaseLib() {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Falha ao carregar supabase-js do CDN.'));
    document.head.appendChild(s);
  });
}

async function baixarSummary() {
  const { data, error } = await sbClient.storage
    .from(SUPABASE_BUCKET).download('summary.json');
  if (error) throw error;
  DATA = JSON.parse(await data.text());
}

function entrar() {
  document.getElementById('login-screen').hidden = true;
  startDashboard();
}

async function showLogin() {
  document.getElementById('loading').hidden = true;
  const tela = document.getElementById('login-screen');
  tela.hidden = false;
  // a marca do seletor serve de logo aqui também
  const marca = document.querySelector('.brand-mark');
  const alvo = tela.querySelector('.login-brand');
  if (marca && alvo && !alvo.firstChild) alvo.appendChild(marca.cloneNode(true));

  const err = document.getElementById('login-err');
  const btn = document.getElementById('login-btn');
  try {
    await loadSupabaseLib();
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // sessão guardada → pula o login; se o download falhar (sessão
    // expirada), sai da sessão e volta pro login com aviso.
    const { data } = await sbClient.auth.getSession();
    if (data && data.session) {
      try {
        await baixarSummary();
        entrar();
        return;
      } catch (e) {
        try { await sbClient.auth.signOut(); } catch (_) { /* noop */ }
        err.textContent = 'Sessão expirada — entre de novo.';
      }
    }
  } catch (e) {
    err.textContent = e.message || 'Erro ao preparar o login.';
  }

  document.getElementById('login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      if (!sbClient) {
        await loadSupabaseLib();
        sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      }
      const password = document.getElementById('login-pass').value;
      const { error } = await sbClient.auth.signInWithPassword(
        { email: DASH_EMAIL, password });
      if (error) throw new Error('Senha incorreta.');
      await baixarSummary();
      entrar();
    } catch (e) {
      err.textContent = e.message || 'Erro ao entrar.';
      try { if (sbClient) await sbClient.auth.signOut(); } catch (_) { /* noop */ }
    } finally {
      btn.disabled = false;
    }
  });
}

/* ============================================================
   Boot
   ============================================================ */
function startDashboard() {
  setupChartDefaults();
  computeDataBounds();

  document.getElementById('stamp').textContent = 'atualizado em ' + (DATA.last_update || '—');

  buildFilterUI();
  setPreset('all', false);

  document.getElementById('loading').hidden = true;

  window.addEventListener('hashchange', route);
  route();
}

document.addEventListener('DOMContentLoaded', loadData);
