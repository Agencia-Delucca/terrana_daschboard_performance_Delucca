/* ============================================================
   Terrana B2B — Dashboard de Performance (Agência Delucca)
   SPA estática no padrão visual da agência (SPEC_VISUAL_REFERENCIA.md).
   Dados: window.__SUMMARY__ (data/summary.js) → fetch data/summary.json.
   Sem login, sem Supabase — autenticação entra numa fase futura.
   ============================================================ */
'use strict';

/* ---------- Estado global ---------- */
let DATA = null;                       // summary.json inteiro
const CHARTS = {};                     // registry Chart.js (anti-leak)
const FILTER = { start: null, end: null, preset: 'all' };
let DATA_MIN = null, DATA_MAX = null;

/* ---------- Paleta (tokens da spec) ---------- */
const P = {
  bgCard: '#1A120A',
  border: '#332415',
  track: '#241910',
  blue: '#E0A526',
  teal: '#D4692E',
  green: '#10B981',
  red: '#EF4444',
  amber: '#F59E0B',
  muted: '#A28D74',
  soft: '#DECFB8',
  text: '#F7F1E6',
  blueLight: '#F2CC7B',
  grid: 'rgba(255,255,255,.05)',
  redShades: ['#EF4444', '#B91C1C', '#F87171', '#7F1D1D', '#FCA5A5', '#DC2626']
};

/* ============================================================
   Formatação (100% pt-BR)
   ============================================================ */
const fmt = {
  num: v => Math.round(v || 0).toLocaleString('pt-BR'),
  dec: (v, d = 1) => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }),
  currency: v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (v, d = 1) => v == null ? '—' : fmt.dec(v, d) + '%',
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
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
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
/* Classificação de campanha Meta pelo nome — espelho de tipo_campanha()
   do ETL (scripts/generate_dashboard_data.py). */
function tipoCampanha(nome) {
  const n = (nome || '').toLowerCase();
  if (n.indexOf('formulário') >= 0 || n.indexOf('formulario') >= 0 || n.indexOf('leads') >= 0) return 'captacao';
  if (n.indexOf('impulsionamento') === 0 || n.indexOf('instagram post') >= 0) return 'impulsionamento';
  if (n.indexOf('ecommerce') >= 0 || n.indexOf('[venda]') >= 0 || n.indexOf('[compra]') >= 0) return 'ecommerce';
  return 'outras';
}
function aggBy(rows, keyFn, fields) {
  const m = {};
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
  const v = (value == null)
    ? '<div class="kpi-dash" title="sem dado"></div>'
    : '<div class="kpi-value' + (opts.teal ? ' teal' : '') + '">' + value + '</div>';
  return '<div class="kpi"><div class="kpi-label">' + label + '</div>' + v +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
}
function card(title, sub, body) {
  return '<div class="card">' +
    (title ? '<div class="card-head"><h3>' + title + '</h3>' +
      (sub ? '<div class="card-sub">' + sub + '</div>' : '') + '</div>' : '') +
    body + '</div>';
}
function chartCard(title, sub, canvasId, boxCls, note) {
  return card(title, sub,
    '<div class="chart-box ' + (boxCls || '') + '"><canvas id="' + canvasId + '"></canvas></div>' +
    (note ? '<div class="note">' + note + '</div>' : ''));
}
function banner(kind, html) {
  return '<div class="banner ' + kind + '">' +
    (kind === 'amber' ? '<span class="b-ic">⚠</span>' : '') +
    '<div>' + html + '</div></div>';
}
/* Os 2 primeiros alertas do ETL são os banners âmbar padrão de todas as
   páginas; a Visão Geral mostra a lista completa. */
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

/* ---------- Funil (componente da spec) ---------- */
function stageKinds() {
  const kinds = {};
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
  const cnt = {};
  deals.forEach(d => { cnt[d.etapa] = (cnt[d.etapa] || 0) + 1; });
  return {
    total: deals.length,
    stages: order.map(s => ({ etapa: s.etapa, total: cnt[s.etapa] || 0, kind: kinds[s.etapa] || null }))
  };
}
function funnelHtml(fp) {
  if (!fp.stages.length) return emptyDashed('Sem etapas de funil no CRM.', 'Verifique o pipeline no Kommo.');
  const max = Math.max.apply(null, fp.stages.map(s => s.total).concat([1]));
  let prev = null, first = true;
  const rows = fp.stages.map(s => {
    const w = s.total / max * 100;
    let pct = '';
    if (!first) {
      // Spec (componente 7): a partir da 2ª etapa, sempre "% da anterior".
      // Para as terminais (ganho/perda), "anterior" = última etapa de progresso.
      pct = (prev && prev > 0) ? fmt.dec(s.total / prev * 100, 0) + '% da<br>anterior' : '—';
    }
    if (!s.kind) { prev = s.total; first = false; }
    const cls = s.kind === 'won' ? ' won' : (s.kind === 'lost' ? ' lost' : '');
    return '<div class="funnel-row">' +
      '<div class="f-label">' + esc(s.etapa) + '</div>' +
      '<div class="f-track"><div class="f-bar' + cls + '" style="width:' + w + '%">' + fmt.num(s.total) + '</div></div>' +
      '<div class="f-pct">' + pct + '</div></div>';
  }).join('');
  return '<div class="funnel">' + rows + '</div>';
}

/* ============================================================
   Chart.js — defaults, registry, helpers
   ============================================================ */
function chartsReady() { return typeof Chart !== 'undefined'; }
function setupChartDefaults() {
  if (!chartsReady()) return;
  Chart.defaults.color = P.muted;
  Chart.defaults.borderColor = P.grid;
  Chart.defaults.font.family = "'Inter','Segoe UI',system-ui,-apple-system,Roboto,sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.animation = false;
  Chart.defaults.locale = 'pt-BR';
  Chart.defaults.plugins.tooltip.backgroundColor = '#1A120A';
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
    labels: { boxWidth: 28, boxHeight: 14, color: P.soft, padding: 14, usePointStyle: false }
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
  // via deepMerge em baseOpts — eixo categórico tem rótulo reto.
  const o = { grid: { display: false }, ticks: { color: P.muted, maxRotation: 0, minRotation: 0 } };
  return deepMerge(o, extra || {});
}
function yCount(extra) {
  const o = {
    beginAtZero: true,
    grid: { color: P.grid, drawTicks: false },
    // Sem precision:0 — a spec mostra ticks fracionários (0,5 · 1,0 …) nos
    // gráficos de contagem baixa; locale pt-BR garante a vírgula decimal.
    ticks: { color: P.muted }
  };
  return deepMerge(o, extra || {});
}
function yMoney(extra) {
  return yCount(deepMerge({ ticks: { callback: v => 'R$ ' + v } }, extra || {}));
}
function moneyTooltip() {
  return {
    label: ctx => {
      // Em barra horizontal (indexAxis 'y'), o valor está em parsed.x e
      // parsed.y é o ÍNDICE da categoria — nunca null (Chart.js 4).
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
    interaction: { mode: 'index', intersect: false },
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

/* ============================================================
   Roteamento (SPA por hash) + sidebar
   ============================================================ */
const PAGES = [
  { id: 'visao', label: 'Visão Geral', ic: '📊', render: renderVisaoGeral },
  { id: 'funil', label: 'Funil CRM', ic: '🎯', render: renderFunilCRM },
  { id: 'atendimento', label: 'Atendimento', ic: '💬', render: renderAtendimento },
  { id: 'meta', label: 'Meta Ads', ic: '📱', render: renderMetaAds },
  { id: 'google', label: 'Google Ads', ic: '🔍', render: renderGoogleAds },
  { id: 'institucional', label: 'Institucional & Impulsionamento', ic: '📣', render: renderInstitucional },
  { id: 'publico', label: 'Público', ic: '👥', render: renderPublico },
  { id: 'evolucao', label: 'Evolução Mensal', ic: '📈', render: renderEvolucao },
  { id: 'utm', label: 'Rastreamento (UTM)', ic: '🧭', render: renderUTM }
];
function currentPageId() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return PAGES.some(p => p.id === h) ? h : 'visao';
}
function route() {
  if (!DATA) return;
  const id = currentPageId();
  destroyAllCharts();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === id));
  const page = PAGES.find(p => p.id === id);
  document.getElementById('page-title').textContent = 'Terrana B2B · ' + page.label;
  page.render(document.getElementById('content'));
  window.scrollTo(0, 0);
}

/* ============================================================
   Filtro de período global (De / Até / Todo período)
   ============================================================ */
function computeDataBounds() {
  const dates = [];
  const push = (list, key) => (list || []).forEach(r => { if (r[key]) dates.push(r[key]); });
  push(DATA.leads && DATA.leads.daily, 'dia');
  push(DATA.meta_ads && DATA.meta_ads.daily, 'dia');
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
  if (!s || !e) return;
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
   P1 · VISÃO GERAL
   ============================================================ */
function renderVisaoGeral(el) {
  const L = fdays((DATA.leads || {}).daily);
  const leadsCRM = sum(L, 'total');
  const leadsPagos = sum(L, 'pagos');
  const campDaily = (DATA.meta_ads || {}).campaign_daily || [];
  const captP = fdays(campDaily).filter(r => tipoCampanha(r.campanha) === 'captacao');
  const investCapt = sum(captP, 'gasto');
  const leadsPlat = sum(fdays((DATA.meta_ads || {}).daily), 'leads_plat');
  const deals = ((DATA.crm || {}).deals_minimal || []).filter(d => inPeriod(d.criado_em));
  const vendas = deals.filter(d => d.ganho).length;
  const perdidos = deals.filter(d => d.perdido).length;
  const cpl = (investCapt > 0 && leadsPagos > 0) ? investCapt / leadsPagos : null;
  const cobPct = ((DATA.utm || {}).cobertura || {}).pct;

  let html = qualityBanners(true);

  html += '<div class="kpis cols-6">' +
    kpi('Leads no CRM', fmt.num(leadsCRM), 'criados no período · Pipeline de venda B2B') +
    kpi('Investimento', fmt.currency(investCapt), 'Meta (captação B2B) · Google: sem integração') +
    kpi('CPL (CRM)', cpl == null ? null : fmt.currency(cpl),
      cpl == null ? 'sem leads pagos no período*' : 'investimento ÷ leads pagos do CRM*', { teal: true }) +
    kpi('Leads plataforma', fmt.num(leadsPlat), 'reportado pela plataforma (referência)') +
    kpi('Vendas', fmt.num(vendas), 'no período') +
    kpi('Perdidos', fmt.num(perdidos), 'no período') +
    '</div>';

  html += '<div class="note-blue">* <strong>CPL (CRM)</strong> = investimento nas campanhas de captação (formulário de leads) ÷ leads do CRM ' +
    'atribuídos ao tráfego pago via UTM. Só <strong>' + fmt.pct(cobPct, 0) + '</strong> dos leads chegam com UTM — o CPL descreve essa fatia rastreada, não o total. ' +
    'E-commerce e impulsionamento ficam fora da conta (ver página Institucional & Impulsionamento).</div>';

  const sL = dailySeries((DATA.leads || {}).daily, ['total']);
  const sI = dailySeries(captP, ['gasto']);

  html += '<div class="grid-2">' +
    (sL
      ? chartCard('Leads por dia', 'entradas no pipeline (CRM)', 'ch-vg-leads')
      : card('Leads por dia', 'entradas no pipeline (CRM)', emptyDashed('Sem leads no período selecionado.', 'Ajuste o filtro de período no topo.'))) +
    (sI
      ? chartCard('Investimento por dia', 'gasto Meta Ads da frente (campanhas de captação)', 'ch-vg-invest')
      : card('Investimento por dia', 'gasto Meta Ads da frente (campanhas de captação)', emptyDashed('Sem investimento de captação no período.', 'A campanha de captação B2B começou em 26/06 — amplie o período.'))) +
    '</div>';

  const fp = funnelPeriodStages();
  html += card('Funil B2B — visão do período',
    'leads criados no período, pela etapa ATUAL de cada um · etapas de ganho/perda são terminais',
    fp.total ? funnelHtml(fp) : emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));

  // ----- Leads por origem (utm_source) -----
  // Atenção: parte dos leads rastreados chega com utm_campaign mas SEM
  // utm_source — por isso o fallback é "(sem utm_source)", não "(sem UTM)":
  // a cobertura de UTM (nota azul acima) conta qualquer parâmetro presente.
  const bySrc = {};
  deals.forEach(d => {
    const s = d.utm_source || '(sem utm_source)';
    if (!bySrc[s]) bySrc[s] = { leads: 0, vendas: 0, perdidos: 0 };
    bySrc[s].leads++;
    if (d.ganho) bySrc[s].vendas++;
    if (d.perdido) bySrc[s].perdidos++;
  });
  const srcRows = Object.entries(bySrc).sort((a, b) => b[1].leads - a[1].leads).map(([src, v]) =>
    '<tr><td class="name">' + esc(src) + '</td>' +
    '<td class="r">' + fmt.num(v.leads) + '</td>' +
    '<td class="r">' + fmt.num(v.vendas) + '</td>' +
    '<td class="r">' + fmt.num(v.perdidos) + '</td></tr>').join('');
  html += card('Leads por origem (utm_source)',
    'origem gravada no lead ao entrar no CRM · sem utm_source = "(sem utm_source)"',
    srcRows
      ? tableWrap([{ t: 'utm_source' }, { t: 'Leads', r: 1 }, { t: 'Vendas', r: 1 }, { t: 'Perdidos', r: 1 }], srcRows) +
      '<div class="note">Parte dos leads rastreados chega com utm_campaign mas sem utm_source — a cobertura de UTM ' +
      'citada acima conta qualquer parâmetro presente, por isso é maior que a soma das origens nomeadas nesta tabela. ' +
      'Detalhe completo na página Rastreamento (UTM).</div>'
      : emptyDashed('Nenhum lead no período selecionado.'));

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
    'estado atual do funil — <strong>não usa o filtro de período</strong> · "1º atendimento" = lead saiu da etapa de entrada · resolução diária',
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
      data: {
        labels: sL.labels,
        datasets: [{ label: 'Leads', data: sL.data.total, backgroundColor: P.blue, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({})
    });
  }
  if (sI) {
    makeChart('ch-vg-invest', {
      type: 'bar',
      data: {
        labels: sI.labels,
        datasets: [{ label: 'Gasto (R$)', data: sI.data.gasto, backgroundColor: P.teal, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({
        plugins: { tooltip: { callbacks: moneyTooltip() } },
        scales: { y: yMoney() }
      })
    });
  }
}

/* ============================================================
   P2 · FUNIL CRM
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
  const motivos = {};
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
    kpi('Leads no período', fmt.num(deals.length), 'Pipeline de venda B2B') +
    kpi('Em andamento', fmt.num(andamento), 'leads vivos no funil') +
    kpi('Vendas', fmt.num(vendas), 'no período') +
    kpi('Perdidos', fmt.num(perdidos), 'no período') +
    kpi('Taxa de conversão', taxa == null ? null : fmt.pct(taxa), 'vendas ÷ leads', { teal: true }) +
    '</div>';

  const fp = funnelPeriodStages();
  html += card('Funil completo',
    'etapa atual dos leads criados no período — etapas de ganho/perda são terminais, não progresso',
    fp.total ? funnelHtml(fp) : emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));

  // ----- Motivos de perda (donut) + Leads perdidos (tabela) -----
  const LOSS_CAP = 15;
  const lossRows = lossesP.slice().sort((a, b) => {
    const x = a.criado || '', y = b.criado || '';
    return x === y ? 0 : (y > x ? 1 : -1);          // desc, comparator consistente
  }).slice(0, LOSS_CAP).map(r =>
    '<tr><td>' + fmt.dateFull(r.criado) + '</td>' +
    '<td class="peri">—</td>' +
    (r.motivo ? '<td class="name">' + esc(r.motivo) + '</td>' : '<td class="dim">não informado</td>') +
    '<td class="peri">' + (r.utm_source
      ? esc(r.utm_source)
      : (r.utm_campaign
        ? '<span class="muted" title="lead sem utm_source — mostrando utm_campaign">' + esc(r.utm_campaign) + '</span>'
        : '<span class="muted">(sem UTM)</span>')) + '</td></tr>').join('');
  const lossNote = (lossesP.length > LOSS_CAP ? 'Mostrando ' + LOSS_CAP + ' de ' + fmt.num(lossesP.length) + ' perdas do período. ' : '') +
    'A etapa em que o lead estava ao ser perdido ainda não é exportada pelo ETL — coluna fica "—" até o histórico de etapas ser acumulado.';
  html += '<div class="grid-2">' +
    (motivosArr.length
      ? chartCard('Motivos de perda', 'leads perdidos no período (por data de criação do lead)', 'ch-crm-motivos')
      : card('Motivos de perda', 'leads perdidos no período', emptyDashed('Nenhuma perda no período selecionado.'))) +
    card('Leads perdidos', 'detalhe (data de criação do lead)',
      lossRows
        ? tableWrap([{ t: 'Criado' }, { t: 'Etapa' }, { t: 'Motivo' }, { t: 'Origem' }], lossRows) + '<div class="note">' + lossNote + '</div>'
        : emptyDashed('Nenhuma perda no período selecionado.')) +
    '</div>';

  // ----- 3 stat cards -----
  html += '<div class="kpis cols-3">' +
    kpi('Tempo médio até venda', (ciclo.n || 0) > 0 ? fmt.days(ciclo.mediana_dias) : null,
      (ciclo.n || 0) > 0 ? 'mediana da criação ao fechamento · base: ' + fmt.num(ciclo.n) + ' vendas (toda a série)' : 'nenhuma venda registrada ainda') +
    kpi('Tempo médio até perda', tPerda == null ? null : fmt.days(tPerda),
      tPerda == null ? 'sem perdas no período' : 'da criação à perda · ' + fmt.num(diffs.length) + ' perdas do período') +
    kpi('Histórico de etapas', null, 'o ETL ainda não acumula histórico diário de etapas — a precisão do tempo em etapa cresce com o histórico') +
    '</div>';

  // ----- Tempo na etapa + leads parados (sem dado no resumo atual) -----
  html += '<div class="grid-2">' +
    card('Tempo médio na etapa atual', 'dias parados por etapa (leads vivos)',
      emptyDashed('Sem histórico diário de etapas acumulado.',
        'Quando o ETL passar a registrar o histórico de etapas por lead, esta visão é habilitada automaticamente.')) +
    card('Leads parados há mais dias', 'quem precisa de atenção do atendimento',
      emptyDashed('O resumo atual não exporta leads individuais com dias de parada.',
        'Habilite a exportação de "leads parados" no ETL para ativar esta visão. Média atual da base: ' +
        fmt.days(((DATA.qualidade_responsavel || [])[0] || {}).parado_dias) + ' parado por lead.')) +
    '</div>';

  // ----- Valor em negociação + Perdas por mês × motivo -----
  const lossesAll = crm.losses_daily || [];
  const mesesPerda = Array.from(new Set(lossesAll.map(r => (r.criado || '').slice(0, 7)).filter(Boolean))).sort();
  const motivosAll = Array.from(new Set(lossesAll.map(r => r.motivo || 'Não informado')));
  html += '<div class="grid-2">' +
    card('Valor em negociação por etapa', 'campo "valor" dos leads vivos no CRM',
      emptyDashed('Nenhum lead vivo com valor preenchido no Kommo.',
        'Preencha o campo "Valor" dos negócios no Kommo para habilitar esta visão (e o ticket médio real).')) +
    (mesesPerda.length
      ? chartCard('Perdas por mês × motivo', 'toda a série · mês de criação do lead perdido', 'ch-crm-perdas-mes')
      : card('Perdas por mês × motivo', 'toda a série', emptyDashed('Nenhuma perda registrada ainda.'))) +
    '</div>';

  el.innerHTML = html;

  if (motivosArr.length) {
    makeChart('ch-crm-motivos', {
      type: 'doughnut',
      data: {
        labels: motivosArr.map(m => m[0]),
        datasets: [{
          data: motivosArr.map(m => m[1]),
          backgroundColor: motivosArr.map((m, i) => P.redShades[i % P.redShades.length]),
          borderColor: '#1A120A',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        cutout: '62%',
        plugins: {
          legend: { display: true, position: 'right', labels: { boxWidth: 14, boxHeight: 14, color: P.soft, padding: 10 } }
        }
      }
    });
  }
  if (mesesPerda.length) {
    const byMes = {};
    lossesAll.forEach(r => {
      const m = (r.criado || '').slice(0, 7);
      if (!m) return;
      const mo = r.motivo || 'Não informado';
      if (!byMes[m]) byMes[m] = {};
      byMes[m][mo] = (byMes[m][mo] || 0) + 1;
    });
    makeChart('ch-crm-perdas-mes', {
      type: 'bar',
      data: {
        labels: mesesPerda.map(mesLabel),
        datasets: motivosAll.map((mo, i) => ({
          label: mo,
          data: mesesPerda.map(m => (byMes[m] || {})[mo] || 0),
          backgroundColor: P.redShades[i % P.redShades.length],
          borderRadius: 3,
          borderSkipped: 'bottom',
          stack: 'perdas'
        }))
      },
      options: baseOpts({
        plugins: { legend: legendTop() },
        scales: { x: xCat({ stacked: true }), y: yCount({ stacked: true }) }
      })
    });
  }
}

/* ============================================================
   P3 · ATENDIMENTO (página extra da Terrana)
   ============================================================ */
function renderAtendimento(el) {
  const at = DATA.atendimento || {};
  const msgs = dailySeries(at.msgs_daily, ['recebidas', 'enviadas']);
  const msgsP = fdays(at.msgs_daily);
  const recebidas = sum(msgsP, 'recebidas');
  const enviadas = sum(msgsP, 'enviadas');

  const respP = fdays(at.respostas);
  const humanas = respP.filter(r => r.minutos >= 0.5).map(r => r.minutos).sort((a, b) => a - b);
  const nAuto = respP.length - humanas.length;
  const autoPct = respP.length ? nAuto / respP.length * 100 : null;
  const med = quantile(humanas, .5);
  const p90 = quantile(humanas, .9);

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
    kpi('Resposta humana (p90)', humanas.length ? fmt.mins(p90) : null, '90% das respostas humanas até aqui') +
    kpi('Respostas automáticas', autoPct == null ? null : fmt.pct(autoPct, 0), 'robô responde em &lt; 30 s — excluído dos tempos acima') +
    kpi('Respostas humanas', fmt.num(humanas.length), 'base dos tempos acima, no período') +
    '</div>';

  html += '<div class="grid-2">' +
    (msgs
      ? chartCard('Mensagens por dia', 'recebidas × enviadas no WhatsApp (Kommo)', 'ch-at-msgs')
      : card('Mensagens por dia', 'recebidas × enviadas', emptyDashed('Sem mensagens no período selecionado.'))) +
    (humanas.length
      ? chartCard('Tempo de resposta humana — distribuição', 'somente respostas de pessoas (≥ 0,5 min) dentro do período', 'ch-at-buckets')
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
          { label: 'Recebidas', data: msgs.data.recebidas, borderColor: P.teal, backgroundColor: 'rgba(49,205,207,.15)', borderWidth: 2, pointRadius: 2, tension: .3 },
          { label: 'Enviadas', data: msgs.data.enviadas, borderColor: P.blue, backgroundColor: 'rgba(40,116,252,.15)', borderWidth: 2, pointRadius: 2, tension: .3 }
        ]
      },
      options: baseOpts({ plugins: { legend: legendTop() } })
    });
  }
  if (humanas.length) {
    makeChart('ch-at-buckets', {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [{ label: 'Respostas humanas', data: bucketCounts, backgroundColor: P.amber, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({ scales: { x: xCat() } })
    });
  }
  if (at.msgs_hora && at.msgs_hora.length) {
    const horas = at.msgs_hora.slice().sort((a, b) => a.hora - b.hora);
    makeChart('ch-at-hora', {
      type: 'bar',
      data: {
        labels: horas.map(h => String(h.hora).padStart(2, '0') + 'h'),
        datasets: [{ label: 'Mensagens', data: horas.map(h => h.mensagens), backgroundColor: P.blue, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({ scales: { x: xCat({ ticks: { maxTicksLimit: 24 } }) } })
    });
  }
}

/* ============================================================
   P4 · META ADS
   Escopo: campanhas de tráfego (captação + e-commerce). O
   impulsionamento tem página própria (Institucional).
   ============================================================ */
function renderMetaAds(el) {
  const meta = DATA.meta_ads || {};
  const campDailyP = fdays(meta.campaign_daily).filter(r => tipoCampanha(r.campanha) !== 'impulsionamento');
  const captP = campDailyP.filter(r => tipoCampanha(r.campanha) === 'captacao');

  const gasto = sum(campDailyP, 'gasto');
  const imp = sum(campDailyP, 'impressoes');
  const cli = sum(campDailyP, 'cliques');
  const ctr = imp > 0 ? cli / imp * 100 : null;
  const cpc = cli > 0 ? gasto / cli : null;
  const leadsPlat = sum(campDailyP, 'leads_plat');
  const gastoCapt = sum(captP, 'gasto');
  // Numerador e denominador na MESMA frente: gasto de captação ÷ leads_plat
  // das campanhas de captação (se o e-commerce um dia reportar leads_plat,
  // ele não pode diluir o custo/lead da captação).
  const leadsPlatCapt = sum(captP, 'leads_plat');
  const custoLeadPlat = leadsPlatCapt > 0 ? gastoCapt / leadsPlatCapt : null;
  const target = (DATA.config && DATA.config.cpl_target_meta) || 0;

  // split do período (todas as campanhas, para o banner azul)
  const splitP = { captacao: 0, ecommerce: 0, impulsionamento: 0, outras: 0 };
  fdays(meta.campaign_daily).forEach(r => { splitP[tipoCampanha(r.campanha)] += r.gasto || 0; });

  let html = qualityBanners(false);
  html += banner('blue', 'Esta página cobre as campanhas de <strong>tráfego</strong> (captação de leads + e-commerce). ' +
    'No período: captação <strong>' + fmt.currency(splitP.captacao) + '</strong> · e-commerce <strong>' + fmt.currency(splitP.ecommerce) + '</strong>. ' +
    'O impulsionamento (' + fmt.currency(splitP.impulsionamento) + ') tem página própria — Institucional &amp; Impulsionamento.');

  html += '<div class="kpis cols-6">' +
    kpi('Gasto', fmt.currency(gasto), 'no período') +
    kpi('Impressões', fmt.num(imp), 'no período') +
    kpi('Cliques', fmt.num(cli), ctr == null ? 'no período' : 'CTR ' + fmt.pct(ctr, 1)) +
    kpi('CPC', cpc == null ? null : fmt.currency(cpc), 'gasto ÷ cliques') +
    kpi('Leads plataforma', fmt.num(leadsPlat), 'plataforma (referência)') +
    kpi('Custo/lead plat.', custoLeadPlat == null ? null : fmt.currency(custoLeadPlat),
      (custoLeadPlat == null ? 'sem leads de plataforma na captação no período · ' : 'gasto de captação ÷ leads plat. da captação · ') +
      (target ? 'meta: até ' + fmt.currency(target) : 'meta de CPL não definida'), { teal: true }) +
    '</div>';

  // ----- Tabela CAMPANHAS -----
  const statusDict = meta.campaign_status || {};
  const byCamp = aggBy(campDailyP, r => r.campanha, ['gasto', 'impressoes', 'cliques', 'leads_plat']);
  const campRows = Object.keys(byCamp)
    .map(k => ({ nome: k, v: byCamp[k] }))
    .filter(r => r.v.gasto > 0 || r.v.leads_plat > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const campBody = campRows.map(r => {
    const v = r.v;
    const rctr = v.impressoes > 0 ? v.cliques / v.impressoes * 100 : null;
    const rcpc = v.cliques > 0 ? v.gasto / v.cliques : null;
    const rcl = v.leads_plat > 0 ? v.gasto / v.leads_plat : null;
    return '<tr><td>' + statusBadge(statusDict[r.nome]) + '</td>' +
      '<td class="name">' + esc(r.nome) + '</td>' +
      '<td class="r">' + fmt.currency(v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(v.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(v.cliques) + '</td>' +
      '<td class="r">' + fmt.pct(rctr, 1) + '</td>' +
      '<td class="r">' + (rcpc == null ? '—' : fmt.currency(rcpc)) + '</td>' +
      '<td class="r">' + fmt.num(v.leads_plat) + '</td>' +
      '<td class="r">' + (rcl == null ? '—' : fmt.currency(rcl)) + '</td></tr>';
  }).join('');
  html += card('Campanhas', 'status real via API · métricas do período filtrado',
    campBody
      ? tableWrap([
        { t: 'Status' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 }, { t: 'Cliques', r: 1 },
        { t: 'CTR', r: 1 }, { t: 'CPC', r: 1 }, { t: 'Leads plataforma', r: 1 }, { t: 'Custo/lead plat.', r: 1 }
      ], campBody)
      : emptyDashed('Nenhuma campanha de tráfego com gasto no período.', 'Ajuste o filtro de período no topo.'));

  // ----- Tabela CONJUNTOS -----
  const adsetP = fdays(meta.adset_daily).filter(r => tipoCampanha(r.campanha) !== 'impulsionamento');
  const byAdset = aggBy(adsetP, r => r.campanha + '|||' + r.conjunto, ['gasto', 'cliques', 'leads_plat']);
  const adsetRows = Object.keys(byAdset)
    .map(k => ({ campanha: byAdset[k].__row.campanha, conjunto: byAdset[k].__row.conjunto, v: byAdset[k] }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);
  const adsetBody = adsetRows.map(r => {
    const rcl = r.v.leads_plat > 0 ? r.v.gasto / r.v.leads_plat : null;
    return '<tr><td class="name">' + esc(r.conjunto) + '</td>' +
      '<td class="dim">' + esc(r.campanha) + '</td>' +
      '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
      '<td class="r">—</td>' +
      '<td class="r">' + fmt.num(r.v.cliques) + '</td>' +
      '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' +
      '<td class="r">' + (rcl == null ? '—' : fmt.currency(rcl)) + '</td>' +
      '<td>' + qualityBadge(rcl, r.v.leads_plat) + '</td></tr>';
  }).join('');
  html += card('Conjuntos de anúncios', 'agrupado por campanha + conjunto (dimensão real da linha da API)',
    adsetBody
      ? tableWrap([
        { t: 'Conjunto' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 }, { t: 'Cliques', r: 1 },
        { t: 'Leads plataforma', r: 1 }, { t: 'Custo/lead plat.', r: 1 }, { t: 'Qualidade' }
      ], adsetBody) +
      '<div class="note">Impressões por conjunto ainda não são exportadas pelo ETL — coluna fica "—". ' +
      'A régua Bom/Ruim é habilitada quando a meta de custo/lead for definida na configuração.</div>'
      : emptyDashed('Nenhum conjunto com gasto no período.'));

  // ----- Tabela ANÚNCIOS -----
  const metaCreat = {};
  (meta.creatives || []).forEach(c => { metaCreat[c.anuncio + '|||' + c.campanha] = c; });
  const creatP = fdays(meta.creatives_daily).filter(r => tipoCampanha(r.campanha) !== 'impulsionamento');
  const byCreat = aggBy(creatP, r => r.anuncio + '|||' + r.campanha, ['gasto', 'cliques', 'leads_plat']);
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
    const nome = a.permalink
      ? '<a href="' + esc(a.permalink) + '" target="_blank" rel="noopener">' + esc(anuncio) + ' 🔗</a>'
      : '<span class="name">' + esc(anuncio || '(sem nome)') + '</span>';
    return '<tr><td><div class="cell-creative">' + thumb + nome + '</div></td>' +
      '<td class="dim">' + esc(a.conjunto || '—') + '</td>' +
      '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(r.v.cliques) + '</td>' +
      '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' +
      '<td class="r">' + (rcl == null ? '—' : fmt.currency(rcl)) + '</td>' +
      '<td>' + qualityBadge(rcl, r.v.leads_plat) + '</td></tr>';
  }).join('');
  html += card('Anúncios', 'criativo × campanha × conjunto · clique no nome para ver o anúncio',
    creatBody
      ? tableWrap([
        { t: 'Anúncio' }, { t: 'Conjunto' }, { t: 'Gasto', r: 1 }, { t: 'Cliques', r: 1 },
        { t: 'Leads plataforma', r: 1 }, { t: 'Custo/lead plat.', r: 1 }, { t: 'Qualidade' }
      ], creatBody) +
      (creatRows.length > ADS_CAP
        ? '<div class="note">Mostrando os ' + ADS_CAP + ' anúncios com maior gasto de ' + fmt.num(creatRows.length) + ' no período.</div>'
        : '')
      : emptyDashed('Nenhum anúncio com gasto no período.'));

  // ----- Combo mensal: Investimento × Leads CRM -----
  const trafDaily = (meta.campaign_daily || []).filter(r => tipoCampanha(r.campanha) !== 'impulsionamento');
  const gastoMes = {};
  trafDaily.forEach(r => { const m = (r.dia || '').slice(0, 7); if (m) gastoMes[m] = (gastoMes[m] || 0) + (r.gasto || 0); });
  const leadsMes = {};
  ((DATA.leads || {}).monthly || []).forEach(r => { leadsMes[r.mes] = r.total; });
  const mesesCombo = Array.from(new Set(Object.keys(gastoMes).concat(Object.keys(leadsMes)))).sort();
  html += (mesesCombo.length
    ? chartCard('Investimento × Leads CRM (mensal)',
      'barras = gasto Meta (tráfego, sem impulsionamento) · linha = leads do pipeline no CRM · série mensal completa — não usa o filtro',
      'ch-meta-mensal', 'tall')
    : card('Investimento × Leads CRM (mensal)', '', emptyDashed('Sem série mensal ainda.')));

  el.innerHTML = html;

  if (mesesCombo.length) {
    makeChart('ch-meta-mensal', {
      type: 'bar',
      data: {
        labels: mesesCombo.map(mesLabel),
        datasets: [
          { type: 'bar', label: 'Gasto (R$)', data: mesesCombo.map(m => gastoMes[m] || 0), backgroundColor: P.blue, borderRadius: 4, borderSkipped: 'bottom', yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Leads CRM', data: mesesCombo.map(m => leadsMes[m] != null ? leadsMes[m] : null), borderColor: P.teal, backgroundColor: P.teal, borderWidth: 2, pointRadius: 4, tension: .3, spanGaps: false, yAxisID: 'y1', order: 1 }
        ]
      },
      options: baseOpts({
        plugins: {
          legend: legendTop(),
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.yAxisID === 'y'
                ? ctx.dataset.label + ': ' + fmt.currency(ctx.parsed.y)
                : ctx.dataset.label + ': ' + (ctx.parsed.y == null ? 'sem cobertura CRM' : fmt.num(ctx.parsed.y))
            }
          }
        },
        scales: {
          x: xCat(),
          y: yMoney({ position: 'left' }),
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: P.teal, precision: 0 } }
        }
      })
    });
  }
}

/* ============================================================
   P5 · GOOGLE ADS (integração pendente — estado vazio da spec)
   ============================================================ */
function renderGoogleAds(el) {
  const g = DATA.google_ads || {};
  let html = qualityBanners(false);

  if (g.disponivel === false || !g.daily) {
    html += '<div class="kpis cols-6">' +
      kpi('Gasto', null, 'no período') +
      kpi('Impressões', null, '') +
      kpi('Cliques', null, '') +
      kpi('CPC', null, '') +
      kpi('Conversões', null, 'plataforma (referência)') +
      kpi('Custo/conversão', null, '', { teal: true }) +
      '</div>';
    html += card('Google Ads', 'status real via API',
      emptyDashed('Integração Google Ads ainda não conectada.',
        esc(g.motivo || 'Aguardando credenciais do Google Ads.') +
        ' Quando o ETL passar a publicar os dados, esta página espelha o layout do Meta Ads automaticamente.'));
  } else {
    html += banner('amber', '<strong>Dados do Google Ads recebidos, mas esta página ainda não foi construída.</strong> O layout espelha o Meta Ads — pendência de implementação no front.');
  }
  el.innerHTML = html;
}

/* ============================================================
   P6 · INSTITUCIONAL & IMPULSIONAMENTO
   ============================================================ */
function renderInstitucional(el) {
  const inst = DATA.institucional || {};
  const IM = (inst.monthly || []).filter(r => monthInPeriod(r.mes));
  const gasto = sum(IM, 'gasto');
  const imp = sum(IM, 'impressoes');
  const eng = sum(IM, 'engajamento');
  const views = sum(IM, 'video_views');
  const cpm = imp > 0 ? gasto / imp * 1000 : null;
  const cpe = eng > 0 ? gasto / eng : null;
  const hasPeriod = IM.length > 0;

  let html = qualityBanners(false);
  html += banner('blue', 'As campanhas de impulsionamento são da <strong>conta inteira</strong> do Instagram/Facebook — não são específicas da frente B2B. ' +
    'Dados com granularidade <strong>mensal</strong>: o filtro de período considera os meses selecionados inteiros. ' +
    'Sem métrica de alcance de propósito: <strong>alcance não é aditivo</strong> (somar alcances diários infla o número) — usamos impressões.');

  html += '<div class="kpis cols-6">' +
    kpi('Investimento', hasPeriod ? fmt.currency(gasto) : null, 'impulsionamento nos meses do período') +
    kpi('Impressões', hasPeriod ? fmt.num(imp) : null, 'soma dos meses do período') +
    kpi('Engajamento', hasPeriod ? fmt.num(eng) : null, 'interações com posts') +
    kpi('Views de vídeo', hasPeriod ? fmt.num(views) : null, 'nos meses do período') +
    kpi('Custo / 1.000 impressões', cpm == null ? null : fmt.currency(cpm), 'no lugar de custo/alcance (alcance não é aditivo)', { teal: true }) +
    kpi('Custo / engajamento', cpe == null ? null : fmt.currency(cpe), 'gasto ÷ interações', { teal: true }) +
    '</div>';

  // split de gasto (toda a série)
  const split = inst.split_gasto || {};
  const splitPairs = [
    ['Captação (leads B2B)', split.captacao || 0, P.teal],
    ['E-commerce', split.ecommerce || 0, P.blue],
    ['Impulsionamento', split.impulsionamento || 0, P.amber]
  ].concat(split.outras ? [['Outras', split.outras, P.muted]] : []);

  html += '<div class="grid-2">' +
    chartCard('Divisão do investimento Meta', 'conta inteira, classificada pelo nome da campanha · toda a série — não usa o filtro', 'ch-inst-split') +
    (IM.length
      ? chartCard('Investimento × Engajamento (mensal)', 'barras = gasto impulsionamento · linha = engajamento', 'ch-inst-mensal')
      : card('Investimento × Engajamento (mensal)', '', emptyDashed('Sem meses de impulsionamento no período selecionado.', 'Amplie o período no topo.'))) +
    '</div>';

  // tabela campanhas institucionais (totais da série — sem fonte diária)
  const rows = (inst.campaigns || []).slice().sort((a, b) => (b.gasto || 0) - (a.gasto || 0)).map(c => {
    const rcpe = (c.engajamento || 0) > 0 ? (c.gasto || 0) / c.engajamento : null;
    return '<tr><td>' + statusBadge(c.status) + '</td>' +
      '<td class="name">' + esc(c.campanha) + '</td>' +
      '<td class="r">' + fmt.currency(c.gasto) + '</td>' +
      '<td class="r">' + fmt.num(c.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(c.engajamento) + '</td>' +
      '<td class="r">' + fmt.num(c.video_views) + '</td>' +
      '<td class="r">' + (rcpe == null ? '—' : fmt.currency(rcpe)) + '</td></tr>';
  }).join('');
  html += card('Campanhas institucionais',
    'status real via API · totais de toda a série (a API não expõe o diário por campanha de impulsionamento no resumo atual) — <strong>não usa o filtro de período</strong>',
    rows
      ? tableWrap([
        { t: 'Status' }, { t: 'Campanha' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 },
        { t: 'Engajamento', r: 1 }, { t: 'Views', r: 1 }, { t: 'Custo/engaj.', r: 1 }
      ], rows)
      : emptyDashed('Nenhuma campanha de impulsionamento registrada.'));

  el.innerHTML = html;

  makeChart('ch-inst-split', {
    type: 'doughnut',
    data: {
      labels: splitPairs.map(p2 => p2[0]),
      datasets: [{
        data: splitPairs.map(p2 => p2[1]),
        backgroundColor: splitPairs.map(p2 => p2[2]),
        borderColor: '#1A120A',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      cutout: '62%',
      plugins: {
        legend: { display: true, position: 'right', labels: { boxWidth: 14, boxHeight: 14, color: P.soft, padding: 10 } },
        tooltip: { callbacks: { label: ctx => ctx.label + ': ' + fmt.currency(ctx.parsed) } }
      }
    }
  });

  if (IM.length) {
    makeChart('ch-inst-mensal', {
      type: 'bar',
      data: {
        labels: IM.map(r => mesLabel(r.mes)),
        datasets: [
          { type: 'bar', label: 'Gasto (R$)', data: IM.map(r => r.gasto || 0), backgroundColor: P.blue, borderRadius: 4, borderSkipped: 'bottom', yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Engajamento', data: IM.map(r => r.engajamento || 0), borderColor: P.teal, backgroundColor: P.teal, borderWidth: 2, pointRadius: 4, tension: .3, yAxisID: 'y1', order: 1 }
        ]
      },
      options: baseOpts({
        plugins: {
          legend: legendTop(),
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.yAxisID === 'y'
                ? ctx.dataset.label + ': ' + fmt.currency(ctx.parsed.y)
                : ctx.dataset.label + ': ' + fmt.num(ctx.parsed.y)
            }
          }
        },
        scales: {
          x: xCat(),
          y: yMoney({ position: 'left' }),
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: P.teal, callback: v => Number(v).toLocaleString('pt-BR') } }
        }
      })
    });
  }
}

/* ============================================================
   P7 · PÚBLICO (breakdowns mensais da Meta)
   ============================================================ */
function stackByAgeGender(rows, field) {
  const ages = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'Unknown'];
  const g = { female: {}, male: {}, unknown: {} };
  let total = 0;
  (rows || []).forEach(r => {
    if (!monthInPeriod(r.mes)) return;
    const gg = g[r.genero] || g.unknown;
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
function renderPublico(el) {
  const pub = DATA.publico || {};
  let html = qualityBanners(false);
  html += banner('blue', 'Dados da Meta com granularidade <strong>mensal</strong> — o filtro de período considera os <strong>meses selecionados inteiros</strong>. Conta inteira (todas as campanhas Meta).');

  const inv = stackByAgeGender(pub.age_gender, 'gasto');
  const lds = stackByAgeGender(pub.age_gender, 'leads_plat');

  // posicionamentos
  const placM = (pub.placement || []).filter(r => monthInPeriod(r.mes));
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
        '<td class="r">' + fmt.num(r.v.leads_plat) + '</td></tr>';
    }).join('');

  // regiões
  const regM = (pub.region || []).filter(r => monthInPeriod(r.mes));
  const byReg = aggBy(regM, r => (r.regiao || '(sem região)').replace(' (state)', ''), ['gasto']);
  const topReg = Object.keys(byReg)
    .map(k => ({ k, gasto: byReg[k].gasto }))
    .sort((a, b) => b.gasto - a.gasto)
    .slice(0, 12);

  html += '<div class="grid-2">' +
    (inv.total > 0
      ? chartCard('Investimento por idade e gênero', 'onde o orçamento está sendo gasto', 'ch-pub-inv')
      : card('Investimento por idade e gênero', 'onde o orçamento está sendo gasto', emptyDashed('Sem dados de público nos meses do período.', 'Amplie o período no topo.'))) +
    (lds.total > 0
      ? chartCard('Leads Plataforma por idade e gênero', 'quem responde aos anúncios (número da plataforma — referência)', 'ch-pub-leads')
      : card('Leads Plataforma por idade e gênero', 'quem responde aos anúncios', emptyDashed('Sem leads de plataforma nos meses do período.', 'A campanha de captação começou em 26/06 — amplie o período.'))) +
    '</div>';

  html += '<div class="grid-2">' +
    card('Posicionamentos', 'feed, stories, reels — onde os anúncios rodam',
      placeRows
        ? tableWrap([
          { t: 'Posicionamento' }, { t: 'Gasto', r: 1 }, { t: 'Impressões', r: 1 },
          { t: 'Cliques', r: 1 }, { t: 'CTR', r: 1 }, { t: 'Leads plataforma', r: 1 }
        ], placeRows)
        : emptyDashed('Sem dados de posicionamento nos meses do período.')) +
    (topReg.length
      ? chartCard('Regiões', 'top 12 por investimento', 'ch-pub-reg', 'tall')
      : card('Regiões', 'top 12 por investimento', emptyDashed('Sem dados de região nos meses do período.'))) +
    '</div>';

  el.innerHTML = html;

  // Spec P7: eixo monetário com milhar pt-BR ("1.200"), sem prefixo R$ —
  // formato específico desta página (o tooltip continua em R$).
  const milharTick = v => Number(v).toLocaleString('pt-BR');
  const stackedOpts = moneyAxis => baseOpts({
    plugins: deepMerge({ legend: legendTop() }, moneyAxis ? { tooltip: { callbacks: moneyTooltip() } } : {}),
    scales: {
      x: xCat({ stacked: true, grid: { color: P.grid, display: true, drawTicks: false } }),
      y: moneyAxis ? yCount({ stacked: true, ticks: { callback: milharTick } }) : yCount({ stacked: true })
    }
  });
  const genderSets = d => [
    { label: 'Feminino', data: d.fem, backgroundColor: P.teal, borderRadius: 3, borderSkipped: 'bottom', stack: 'g' },
    { label: 'Masculino', data: d.mas, backgroundColor: P.blue, borderRadius: 3, borderSkipped: 'bottom', stack: 'g' },
    { label: 'Não informado', data: d.unk, backgroundColor: P.muted, borderRadius: 3, borderSkipped: 'bottom', stack: 'g' }
  ];
  if (inv.total > 0) {
    makeChart('ch-pub-inv', { type: 'bar', data: { labels: inv.ages, datasets: genderSets(inv) }, options: stackedOpts(true) });
  }
  if (lds.total > 0) {
    makeChart('ch-pub-leads', { type: 'bar', data: { labels: lds.ages, datasets: genderSets(lds) }, options: stackedOpts(false) });
  }
  if (topReg.length) {
    makeChart('ch-pub-reg', {
      type: 'bar',
      data: {
        labels: topReg.map(r => r.k),
        datasets: [{ label: 'Gasto (R$)', data: topReg.map(r => r.gasto), backgroundColor: P.blue, borderRadius: 4, borderSkipped: 'left' }]
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: { tooltip: { callbacks: moneyTooltip() } },
        scales: {
          x: yCount({ position: 'bottom', ticks: { maxRotation: 0, minRotation: 0, callback: milharTick } }),
          y: { grid: { display: false }, ticks: { color: P.soft } }
        }
      })
    });
  }
}

/* ============================================================
   P8 · EVOLUÇÃO MENSAL
   ============================================================ */
function renderEvolucao(el) {
  const leadsM = (DATA.leads || {}).monthly || [];
  const metaM = (DATA.meta_ads || {}).monthly || [];
  const wonM = {};
  ((DATA.crm || {}).monthly_won || []).forEach(r => { wonM[r.mes] = r.ganhos; });
  const lostM = {};
  ((DATA.crm || {}).deals_minimal || []).forEach(d => {
    if (!d.perdido) return;
    const m = (d.criado_em || '').slice(0, 7);
    if (m) lostM[m] = (lostM[m] || 0) + 1;
  });
  const mesesVP = Array.from(new Set(Object.keys(wonM).concat(Object.keys(lostM)))).sort();

  // custo/lead plataforma por mês: gasto de captação ÷ leads_plat DA CAPTAÇÃO
  // no mês (o mensal da conta inteira não pode diluir o denominador)
  const captMes = {}, leadsPlatCaptMes = {};
  ((DATA.meta_ads || {}).campaign_daily || []).forEach(r => {
    if (tipoCampanha(r.campanha) !== 'captacao') return;
    const m = (r.dia || '').slice(0, 7);
    if (!m) return;
    captMes[m] = (captMes[m] || 0) + (r.gasto || 0);
    leadsPlatCaptMes[m] = (leadsPlatCaptMes[m] || 0) + (r.leads_plat || 0);
  });
  const cplM = metaM.map(r => (leadsPlatCaptMes[r.mes] > 0 && captMes[r.mes]) ? captMes[r.mes] / leadsPlatCaptMes[r.mes] : null);

  let html = qualityBanners(false);
  html += '<div class="note-blue">Visão mensal completa — <strong>não usa o filtro de período do topo</strong>. Vendas e perdas contadas pelo mês de criação do lead.</div>';

  html += '<div class="grid-2">' +
    (leadsM.length
      ? chartCard('Leads por mês (CRM)', 'entradas no pipeline de venda B2B', 'ch-ev-leads')
      : card('Leads por mês (CRM)', '', emptyDashed('Sem série mensal de leads ainda.'))) +
    (metaM.length
      ? chartCard('Investimento por mês (Meta)', 'conta Meta inteira (captação + e-commerce + impulsionamento)', 'ch-ev-invest')
      : card('Investimento por mês (Meta)', '', emptyDashed('Sem série mensal de investimento ainda.'))) +
    '</div>';

  html += '<div class="grid-2">' +
    (mesesVP.length
      ? chartCard('Vendas × Perdas por mês', 'pelo mês de criação do lead (CRM — fonte de verdade)', 'ch-ev-vp')
      : card('Vendas × Perdas por mês', '', emptyDashed('Nenhuma venda ou perda registrada ainda.'))) +
    (metaM.length
      ? chartCard('Custo/Lead Plat. por mês', 'gasto de captação ÷ leads reportados pela plataforma (referência)', 'ch-ev-cpl')
      : card('Custo/Lead Plat. por mês', '', emptyDashed('Sem série mensal ainda.'))) +
    '</div>';

  el.innerHTML = html;

  if (leadsM.length) {
    makeChart('ch-ev-leads', {
      type: 'bar',
      data: {
        labels: leadsM.map(r => mesLabel(r.mes)),
        datasets: [{ label: 'Leads', data: leadsM.map(r => r.total || 0), backgroundColor: P.blue, borderRadius: 4, borderSkipped: 'bottom', barPercentage: .65 }]
      },
      options: baseOpts({ scales: { x: xCat() } })
    });
  }
  if (metaM.length) {
    makeChart('ch-ev-invest', {
      type: 'bar',
      data: {
        labels: metaM.map(r => mesLabel(r.mes)),
        datasets: [{ label: 'Gasto (R$)', data: metaM.map(r => r.gasto || 0), backgroundColor: P.teal, borderRadius: 4, borderSkipped: 'bottom', barPercentage: .65 }]
      },
      options: baseOpts({
        plugins: { tooltip: { callbacks: moneyTooltip() } },
        scales: { x: xCat(), y: yMoney() }
      })
    });
  }
  if (mesesVP.length) {
    makeChart('ch-ev-vp', {
      type: 'bar',
      data: {
        labels: mesesVP.map(mesLabel),
        datasets: [
          { label: 'Vendas', data: mesesVP.map(m => wonM[m] || 0), backgroundColor: P.green, borderRadius: 4, borderSkipped: 'bottom' },
          { label: 'Perdas', data: mesesVP.map(m => lostM[m] || 0), backgroundColor: P.red, borderRadius: 4, borderSkipped: 'bottom' }
        ]
      },
      options: baseOpts({
        plugins: { legend: legendTop() },
        scales: { x: xCat() }
      })
    });
  }
  if (metaM.length) {
    makeChart('ch-ev-cpl', {
      type: 'line',
      data: {
        labels: metaM.map(r => mesLabel(r.mes)),
        datasets: [{
          label: 'Custo/lead plat.', data: cplM,
          borderColor: P.amber, backgroundColor: P.amber,
          borderWidth: 2, pointRadius: 5, tension: .3, spanGaps: false
        }]
      },
      options: baseOpts({
        plugins: {
          tooltip: {
            callbacks: { label: ctx => ctx.parsed.y == null ? 'sem leads de plataforma no mês' : 'Custo/lead plat.: ' + fmt.currency(ctx.parsed.y) }
          }
        },
        scales: { x: xCat(), y: yMoney() }
      })
    });
  }
}

/* ============================================================
   P9 · RASTREAMENTO (UTM) — página extra da Terrana
   ============================================================ */
function renderUTM(el) {
  const utm = DATA.utm || {};
  const cob = utm.cobertura || { total: 0, com_utm: 0, pct: 0 };

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
    '<div class="note" style="margin-top:0">Todo lead sem UTM vira "origem desconhecida" — o CPL por CRM descreve só a fatia rastreada.</div>' +
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
   Carga de dados (sem login — autenticação em fase futura)
   ============================================================ */
function showFatal(msg) {
  document.getElementById('loading').hidden = false;
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-msg').classList.add('fatal');
  const sp = document.querySelector('#loading .spin');
  if (sp) sp.style.display = 'none';
}
async function loadData() {
  // 1) Dados embutidos (data/summary.js) — cobre abrir com duplo clique.
  if (window.__SUMMARY__) {
    DATA = window.__SUMMARY__;
    startDashboard();
    return;
  }
  // 2) Fallback: fetch do JSON servido junto do front.
  try {
    const res = await fetch('data/summary.json', { cache: 'no-store' });
    if (res.ok) {
      DATA = await res.json();
      startDashboard();
      return;
    }
  } catch (e) { /* segue para a mensagem de erro */ }
  // 3) Nada disponível: explicar o que fazer.
  showFatal('Os dados ainda não chegaram até aqui. Se você abriu o arquivo pelo OneDrive, aguarde a ' +
    'sincronização da pasta terminar (botão direito → "Sempre manter neste dispositivo") e recarregue. ' +
    'Se estiver rodando local, suba um servidor na pasta dashboard (ex.: python -m http.server) e abra por ele.');
}

/* ============================================================
   Boot
   ============================================================ */
function startDashboard() {
  setupChartDefaults();
  computeDataBounds();

  document.getElementById('stamp').textContent = 'atualizado em ' + (DATA.last_update || '—');

  document.getElementById('nav').innerHTML = PAGES.map(p =>
    '<a href="#/' + p.id + '" data-page="' + p.id + '"><span class="ic">' + p.ic + '</span><span>' + p.label + '</span></a>').join('');

  buildFilterUI();
  setPreset('all', false);

  document.getElementById('loading').hidden = true;

  window.addEventListener('hashchange', route);
  route();
}

document.addEventListener('DOMContentLoaded', loadData);
