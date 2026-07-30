/* ============================================================
   Terrana B2B — Dashboard de Performance (Agência Delucca)
   SPA estática, sem build. Dados: data/summary.json (dev) ou
   Supabase Storage (produção, após login).
   ============================================================ */
'use strict';

/* ---------- Configuração Supabase (produção) ----------
   Preencher quando o projeto Supabase da Terrana for criado.
   Vazio = a tela de login avisa "produção ainda não configurada". */
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';
const SUPABASE_BUCKET = 'dashboard-data';
const SUPABASE_FILE = 'summary.json';

/* ---------- Estado global ---------- */
let DATA = null;                 // summary.json inteiro
const CHARTS = {};               // registry de instâncias Chart.js (anti-leak)
const FILTER = { start: null, end: null, preset: '30' };
let DATA_MIN = null, DATA_MAX = null;
let LOSS_AXIS = 'criado';        // eixo do gráfico de perdas: 'criado' | 'data'
let sbClient = null;             // cliente supabase (produção)

/* ---------- Cores (paleta validada p/ fundo #161b22) ---------- */
const C = {
  green: '#34a06b',
  greenStrong: '#4cc287',
  greenSoft: 'rgba(52,160,107,.22)',
  blue: '#3f8ee8',
  blueSoft: 'rgba(63,142,232,.20)',
  amber: '#d9a13f',
  amberSoft: 'rgba(217,161,63,.25)',
  red: '#e0655f',
  redSoft: 'rgba(224,101,95,.25)',
  grid: '#232a33',
  muted: '#8b949e',
  text: '#e6e8eb'
};

/* ============================================================
   Utilitários de formatação (pt-BR em tudo)
   ============================================================ */
const fmt = {
  num: v => Math.round(v || 0).toLocaleString('pt-BR'),
  dec: (v, d = 1) => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }),
  currency: v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (v, d = 1) => v == null ? '—' : fmt.dec(v, d) + '%',
  date: iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '—',
  dateFull: iso => iso ? iso.split('-').reverse().join('/') : '—',
  mins: m => {
    if (m == null) return '—';
    if (m < 60) return fmt.dec(m, 0) + ' min';
    if (m < 1440) return fmt.dec(m / 60, 1) + ' h';
    return fmt.dec(m / 1440, 1) + ' d';
  }
};

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
function mesNome(m) {            // '2026-07' -> 'Julho de 2026'
  if (!m) return '—';
  const [y, mo] = m.split('-');
  return MESES[parseInt(mo, 10) - 1] + ' de ' + y;
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

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayRange(a, b) {
  const out = [];
  let d = a;
  let guard = 0;
  while (d <= b && guard++ < 4000) { out.push(d); d = addDays(d, 1); }
  return out;
}
/* Série diária zero-preenchida DENTRO da janela coberta pelos dados
   (fora da cobertura = null → buraco no gráfico, não zero falso). */
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

/* ============================================================
   Builders de UI
   ============================================================ */
function kpi(label, value, sub, cls) {
  return '<div class="kpi ' + (cls || '') + '"><div class="kpi-label">' + label +
    '</div><div class="kpi-value">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
}
function card(title, body, tagHtml) {
  return '<div class="card">' +
    (title ? '<div class="card-head"><h3>' + title + '</h3>' + (tagHtml || '') + '</div>' : '') +
    body + '</div>';
}
function chartCard(title, canvasId, tagHtml, extraNote, boxCls) {
  return card(title,
    '<div class="chart-box ' + (boxCls || '') + '"><canvas id="' + canvasId + '"></canvas></div>' +
    (extraNote ? '<div class="note">' + extraNote + '</div>' : ''),
    tagHtml);
}
function emptyBox(msg) {
  return '<div class="empty">' + (msg || 'Sem dados no período selecionado') + '</div>';
}
const TAG_SNAPSHOT = '<span class="tag snapshot">foto atual — não filtra por período</span>';
const TAG_SNAP180 = '<span class="tag snapshot">foto 180 dias — não filtra por período</span>';
const TAG_TRUTH = '<span class="tag truth">CRM — fonte de verdade</span>';
const TAG_REF = '<span class="tag ref">plataforma — referência</span>';

/* ============================================================
   Chart.js — registry e defaults
   ============================================================ */
function chartsReady() { return typeof Chart !== 'undefined'; }
function setupChartDefaults() {
  if (!chartsReady()) return;
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 11.5;
  Chart.defaults.animation = false;
  Chart.defaults.locale = 'pt-BR';
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1b2129';
  Chart.defaults.plugins.tooltip.borderColor = C.grid;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = C.text;
  Chart.defaults.plugins.tooltip.bodyColor = C.text;
}
function destroyAllCharts() {
  Object.keys(CHARTS).forEach(id => { try { CHARTS[id].destroy(); } catch (e) { /* noop */ } delete CHARTS[id]; });
}
function makeChart(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!chartsReady()) {
    el.parentElement.innerHTML = emptyBox('Chart.js não carregou (verifique a conexão com o CDN).');
    return;
  }
  if (CHARTS[id]) { try { CHARTS[id].destroy(); } catch (e) { /* noop */ } delete CHARTS[id]; }
  CHARTS[id] = new Chart(el, config);
}
function moneyTicks() {
  return { callback: v => 'R$ ' + Number(v).toLocaleString('pt-BR') };
}
function moneyTooltip() {
  return { label: ctx => (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + fmt.currency(ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed.x) };
}
function baseOpts(extra) {
  const o = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: C.grid, drawTicks: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
      y: { grid: { color: C.grid, drawTicks: false }, beginAtZero: true, ticks: { precision: 0 } }
    }
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
   Roteamento (SPA por hash)
   ============================================================ */
const PAGES = [
  { id: 'executivo', label: 'Visão Executiva', render: renderExecutivo },
  { id: 'crm', label: 'Funil CRM', render: renderCRM },
  { id: 'atendimento', label: 'Atendimento', render: renderAtendimento },
  { id: 'meta', label: 'Meta Ads', render: renderMeta },
  { id: 'google', label: 'Google Ads', render: renderGoogle },
  { id: 'utm', label: 'Rastreamento (UTM)', render: renderUTM },
  { id: 'relatorio', label: 'Relatório', render: renderRelatorio }
];
function currentPageId() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return PAGES.some(p => p.id === h) ? h : 'executivo';
}
function route() {
  if (!DATA) return;
  const id = currentPageId();
  destroyAllCharts();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === id));
  document.body.classList.toggle('hide-filter', id === 'relatorio' || id === 'google');
  const page = PAGES.find(p => p.id === id);
  page.render(document.getElementById('content'));
  window.scrollTo(0, 0);
}

/* ============================================================
   Filtro de período global
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
  } else {
    const n = parseInt(p, 10);
    FILTER.end = DATA_MAX;
    FILTER.start = addDays(DATA_MAX, -(n - 1));
  }
  syncFilterUI();
  if (rerender !== false) route();
}
function syncFilterUI() {
  document.querySelectorAll('#presets .preset').forEach(b =>
    b.classList.toggle('active', b.dataset.preset === FILTER.preset));
  const s = document.getElementById('f-start'), e = document.getElementById('f-end');
  if (s) s.value = FILTER.start;
  if (e) e.value = FILTER.end;
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
  const presets = [
    { p: '7', label: '7 dias' },
    { p: '30', label: '30 dias' },
    { p: '90', label: '90 dias' },
    { p: 'all', label: 'Tudo' }
  ];
  document.getElementById('presets').innerHTML = presets.map(x =>
    '<button class="preset" data-preset="' + x.p + '">' + x.label + '</button>').join('');
  document.querySelectorAll('#presets .preset').forEach(b =>
    b.addEventListener('click', () => setPreset(b.dataset.preset)));
  document.getElementById('f-start').addEventListener('change', onDateInput);
  document.getElementById('f-end').addEventListener('change', onDateInput);
}
function periodLabel() {
  return fmt.dateFull(FILTER.start) + ' a ' + fmt.dateFull(FILTER.end);
}

/* ============================================================
   PÁGINA 1 — Visão Executiva
   ============================================================ */
function renderExecutivo(el) {
  const L = fdays(DATA.leads.daily);
  const M = fdays(DATA.meta_ads.daily);
  const leads = sum(L, 'total');
  const pagos = sum(L, 'pagos');
  const gasto = sum(M, 'gasto');
  const deals = (DATA.crm.deals_minimal || []).filter(d => inPeriod(d.criado_em));
  const ganhos = deals.filter(d => d.ganho).length;
  const perdidos = deals.filter(d => d.perdido).length;
  const conv = leads > 0 ? ganhos / leads * 100 : null;
  const cpl = pagos > 0 ? gasto / pagos : null;
  const cplTargetMsg = (DATA.config && DATA.config.cpl_target_meta === 0)
    ? 'meta de CPL não definida' : null;
  const alertas = (DATA.relatorio && DATA.relatorio.alertas) || [];

  let html = '<h2 class="page-title">Visão Executiva</h2>' +
    '<p class="page-sub">Período: ' + periodLabel() + ' · Leads e conversões sempre do CRM (fonte de verdade).</p>';

  html += '<div class="kpis">' +
    kpi('Leads (CRM)', fmt.num(leads), 'criados no período') +
    kpi('Leads pagos (CRM)', fmt.num(pagos), 'com UTM de tráfego pago') +
    kpi('Investimento Meta', fmt.currency(gasto), 'gasto no período') +
    kpi('CPL CRM pago', cpl == null ? '—' : fmt.currency(cpl),
      cpl == null ? 'sem leads pagos no período' : (cplTargetMsg || 'gasto Meta ÷ leads pagos CRM')) +
    kpi('Ganhos', fmt.num(ganhos), 'por data de criação do lead', ganhos > 0 ? 'good' : '') +
    kpi('Perdidos', fmt.num(perdidos), 'por data de criação do lead', perdidos > 0 ? 'bad' : '') +
    kpi('Taxa de conversão', conv == null ? '—' : fmt.pct(conv), 'ganhos ÷ leads do período') +
    '</div>';

  const sL = dailySeries(DATA.leads.daily, ['total', 'pagos']);
  const sM = dailySeries(DATA.meta_ads.daily, ['gasto']);

  html += '<div class="grid-2">' +
    (sL
      ? chartCard('Leads por dia — total × pagos (CRM)', 'ch-exec-leads')
      : card('Leads por dia — total × pagos (CRM)', emptyBox())) +
    (sM
      ? chartCard('Investimento Meta por dia', 'ch-exec-gasto')
      : card('Investimento Meta por dia', emptyBox())) +
    '</div>';

  html += card('Alertas de qualidade de dado',
    alertas.length
      ? '<ul class="alert-list">' + alertas.map(a =>
        '<li><span class="alert-tipo">' + esc(a.tipo) + '</span><br>' + esc(a.texto) + '</li>').join('') + '</ul>'
      : emptyBox('Nenhum alerta no momento.'),
    '<span class="tag ref">avisos honestos do ETL</span>');

  el.innerHTML = html;

  if (sL) {
    makeChart('ch-exec-leads', {
      type: 'line',
      data: {
        labels: sL.labels,
        datasets: [
          { label: 'Leads (total)', data: sL.data.total, borderColor: C.green, backgroundColor: C.greenSoft, borderWidth: 2, pointRadius: 2, tension: .3, fill: true },
          { label: 'Leads pagos', data: sL.data.pagos, borderColor: C.blue, backgroundColor: C.blueSoft, borderWidth: 2, pointRadius: 2, tension: .3, fill: false }
        ]
      },
      options: baseOpts({ plugins: { legend: { display: true, position: 'bottom' } } })
    });
  }
  if (sM) {
    makeChart('ch-exec-gasto', {
      type: 'bar',
      data: {
        labels: sM.labels,
        datasets: [{ label: 'Gasto (R$)', data: sM.data.gasto, backgroundColor: C.green, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({
        plugins: { tooltip: { callbacks: moneyTooltip() } },
        scales: { y: { ticks: moneyTicks() } }
      })
    });
  }
}

/* ============================================================
   PÁGINA 2 — Funil CRM
   ============================================================ */
function renderCRM(el) {
  const crm = DATA.crm;
  const funnel = (crm.funnel || []).slice().sort((a, b) => a.sort - b.sort);
  const active = (crm.active_funnel || []).slice().sort((a, b) => a.sort - b.sort);

  // perdas do período (eixo padrão = data de criação do lead — regra de ouro nº 8)
  const lossesP = (crm.losses_daily || []).filter(r => inPeriod(r[LOSS_AXIS]));
  const motivos = {};
  lossesP.forEach(r => { const m = r.motivo || 'Não informado'; motivos[m] = (motivos[m] || 0) + 1; });
  const motivosArr = Object.entries(motivos).sort((a, b) => b[1] - a[1]);

  const byDay = {};
  lossesP.forEach(r => { const d = r[LOSS_AXIS]; byDay[d] = (byDay[d] || 0) + 1; });
  const lossDays = Object.keys(byDay).sort();
  let lossSeries = null;
  if (lossDays.length) {
    const days = dayRange(lossDays[0], lossDays[lossDays.length - 1]);
    lossSeries = { labels: days.map(fmt.date), data: days.map(d => byDay[d] || 0) };
  }

  const ciclo = crm.ciclo || {};
  const resp = crm.by_responsavel || [];

  let html = '<h2 class="page-title">Funil CRM</h2>' +
    '<p class="page-sub">Período: ' + periodLabel() + ' · Funis por etapa são a foto atual do CRM; perdas respeitam o filtro.</p>';

  html += '<div class="kpis">' +
    kpi('Negócios (total)', fmt.num(crm.total_deals), 'foto atual') +
    kpi('Ganhos', fmt.num(crm.total_won), 'foto atual', 'good') +
    kpi('Perdidos', fmt.num(crm.total_lost), 'foto atual', 'bad') +
    kpi('Em aberto', fmt.num(crm.total_open), 'foto atual') +
    kpi('Taxa de fechamento', fmt.pct(crm.taxa_fechamento), 'ganhos ÷ todos os negócios') +
    kpi('Fechamento (decididos)', fmt.pct(crm.taxa_fechamento_decididos), 'ganhos ÷ (ganhos + perdidos)') +
    '</div>';

  html += '<div class="grid-2">' +
    (funnel.length
      ? chartCard('Funil por etapa atual', 'ch-crm-funnel', TAG_SNAPSHOT,
        'Cada negócio contado na etapa em que está hoje — não é fluxo acumulado.')
      : card('Funil por etapa atual', emptyBox('Sem dados de funil.'), TAG_SNAPSHOT)) +
    (active.length
      ? chartCard('Funil ativo (sem ganhos/perdidos)', 'ch-crm-active', TAG_SNAPSHOT)
      : card('Funil ativo', emptyBox('Sem negócios em aberto.'), TAG_SNAPSHOT)) +
    '</div>';

  const axisToggle =
    '<span class="spacer"></span><div class="toggle-group" title="criado = data de criação do lead (mesmo eixo dos KPIs de leads — a perda é subconjunto do período); data = dia em que a perda foi registrada no CRM.">' +
    '<button class="' + (LOSS_AXIS === 'criado' ? 'active' : '') + '" onclick="setLossAxis(\'criado\')">por criação do lead</button>' +
    '<button class="' + (LOSS_AXIS === 'data' ? 'active' : '') + '" onclick="setLossAxis(\'data\')">por data da perda</button>' +
    '</div>';

  html += '<div class="grid-2">' +
    (motivosArr.length
      ? chartCard('Motivos de perda no período', 'ch-crm-losses')
      : card('Motivos de perda no período', emptyBox())) +
    (lossSeries
      ? card('Perdas ao longo do tempo',
        '<div class="chart-box"><canvas id="ch-crm-losses-daily"></canvas></div>' +
        '<div class="note">Eixo atual: <strong>' + (LOSS_AXIS === 'criado' ? 'data de criação do lead' : 'data em que a perda foi registrada') +
        '</strong>. Por criação, a perda entra no mesmo período do lead (percentuais consistentes); por data da perda, mostra quando o time marcou a perda.</div>',
        axisToggle)
      : card('Perdas ao longo do tempo', emptyBox(), axisToggle)) +
    '</div>';

  const respRows = resp.map(r => {
    const tx = r.total > 0 ? r.ganhos / r.total * 100 : null;
    return '<tr><td class="name">' + esc(r.responsavel) + '</td>' +
      '<td class="r">' + fmt.num(r.total) + '</td>' +
      '<td class="r">' + fmt.num(r.ganhos) + '</td>' +
      '<td class="r">' + (tx == null ? '—' : fmt.pct(tx)) + '</td></tr>';
  }).join('');

  html += '<div class="grid-2">' +
    card('Por responsável',
      resp.length
        ? '<div class="table-wrap"><table><thead><tr><th>Responsável</th><th class="r">Negócios</th><th class="r">Ganhos</th><th class="r">Taxa</th></tr></thead><tbody>' +
        respRows + '</tbody></table></div>'
        : emptyBox('Sem dados por responsável.'),
      TAG_SNAPSHOT) +
    card('Ciclo de venda (criação → ganho)',
      (ciclo.n || 0) > 0
        ? '<div class="kpis" style="margin-bottom:0">' +
        kpi('Mediana', fmt.dec(ciclo.mediana_dias, 1) + ' dias') +
        kpi('Mínimo', fmt.dec(ciclo.min_dias, 1) + ' dias') +
        kpi('Máximo', fmt.dec(ciclo.max_dias, 1) + ' dias') +
        '</div><div class="note">Base: ' + fmt.num(ciclo.n) + ' negócios ganhos (todos os fechamentos registrados).</div>'
        : emptyBox('Nenhum negócio ganho ainda — sem ciclo para medir.'),
      TAG_SNAPSHOT) +
    '</div>';

  el.innerHTML = html;

  if (funnel.length) {
    makeChart('ch-crm-funnel', {
      type: 'bar',
      data: {
        labels: funnel.map(f => f.etapa),
        datasets: [{
          label: 'Negócios', data: funnel.map(f => f.total), borderRadius: 4, borderSkipped: 'left',
          backgroundColor: funnel.map(f =>
            f.etapa === 'Fechado - perdido' ? C.red : (f.etapa === 'Fechado - ganho' ? C.greenStrong : C.green))
        }]
      },
      options: baseOpts({
        indexAxis: 'y',
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }
      })
    });
  }
  if (active.length) {
    makeChart('ch-crm-active', {
      type: 'bar',
      data: {
        labels: active.map(f => f.etapa),
        datasets: [{ label: 'Em aberto', data: active.map(f => f.total), backgroundColor: C.blue, borderRadius: 4, borderSkipped: 'left' }]
      },
      options: baseOpts({
        indexAxis: 'y',
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }
      })
    });
  }
  if (motivosArr.length) {
    makeChart('ch-crm-losses', {
      type: 'bar',
      data: {
        labels: motivosArr.map(m => m[0]),
        datasets: [{ label: 'Perdas', data: motivosArr.map(m => m[1]), backgroundColor: C.red, borderRadius: 4, borderSkipped: 'left' }]
      },
      options: baseOpts({
        indexAxis: 'y',
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }
      })
    });
  }
  if (lossSeries) {
    makeChart('ch-crm-losses-daily', {
      type: 'bar',
      data: {
        labels: lossSeries.labels,
        datasets: [{ label: 'Perdas', data: lossSeries.data, backgroundColor: C.red, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({})
    });
  }
}
function setLossAxis(a) { LOSS_AXIS = a; route(); }
window.setLossAxis = setLossAxis;

/* ============================================================
   PÁGINA 3 — Atendimento
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

  let html = '<h2 class="page-title">Atendimento</h2>' +
    '<p class="page-sub">Período: ' + periodLabel() + ' · Tempos de resposta medem a espera por uma <strong>pessoa</strong> — o robô (&lt; 30 s) é contado à parte.</p>';

  html += '<div class="kpis">' +
    kpi('Conversas', fmt.num(at.conversas_total), 'foto 180 dias — não filtra') +
    kpi('Em aberto', fmt.num(at.em_aberto), 'foto atual — não filtra') +
    kpi('Não lidas', fmt.num(at.nao_lidas), 'foto atual — não filtra') +
    kpi('Msgs recebidas', fmt.num(recebidas), 'no período') +
    kpi('Msgs enviadas', fmt.num(enviadas), 'no período') +
    kpi('Resposta humana (mediana)', fmt.mins(med), humanas.length ? humanas.length + ' respostas humanas' : 'sem respostas humanas no período') +
    kpi('Resposta humana (p90)', fmt.mins(p90), '90% respondidas até aqui') +
    kpi('Respostas automáticas', autoPct == null ? '—' : fmt.pct(autoPct, 0),
      'robô responde em <30 s; excluído dos tempos acima') +
    '</div>';

  html += '<div class="grid-2">' +
    (msgs
      ? chartCard('Mensagens por dia — recebidas × enviadas', 'ch-at-msgs')
      : card('Mensagens por dia', emptyBox())) +
    (humanas.length
      ? chartCard('Tempo de resposta humana — distribuição', 'ch-at-buckets', null,
        'Somente respostas de pessoas (≥ 0,5 min) dentro do período. As automáticas (' + fmt.num(nAuto) + ') ficam de fora para não maquiar o tempo real de espera.')
      : card('Tempo de resposta humana — distribuição', emptyBox())) +
    '</div>';

  html += (at.msgs_hora && at.msgs_hora.length
    ? chartCard('Mensagens recebidas por hora do dia', 'ch-at-hora', TAG_SNAP180,
      'Ajuda a posicionar a equipe nos horários de pico.')
    : card('Mensagens recebidas por hora do dia', emptyBox(), TAG_SNAP180));

  el.innerHTML = html;

  if (msgs) {
    makeChart('ch-at-msgs', {
      type: 'line',
      data: {
        labels: msgs.labels,
        datasets: [
          { label: 'Recebidas', data: msgs.data.recebidas, borderColor: C.green, backgroundColor: C.greenSoft, borderWidth: 2, pointRadius: 2, tension: .3 },
          { label: 'Enviadas', data: msgs.data.enviadas, borderColor: C.blue, backgroundColor: C.blueSoft, borderWidth: 2, pointRadius: 2, tension: .3 }
        ]
      },
      options: baseOpts({ plugins: { legend: { display: true, position: 'bottom' } } })
    });
  }
  if (humanas.length) {
    makeChart('ch-at-buckets', {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [{ label: 'Respostas humanas', data: bucketCounts, backgroundColor: C.green, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({})
    });
  }
  if (at.msgs_hora && at.msgs_hora.length) {
    const horas = at.msgs_hora.slice().sort((a, b) => a.hora - b.hora);
    makeChart('ch-at-hora', {
      type: 'bar',
      data: {
        labels: horas.map(h => String(h.hora).padStart(2, '0') + 'h'),
        datasets: [{ label: 'Mensagens', data: horas.map(h => h.mensagens), backgroundColor: C.blue, borderRadius: 4, borderSkipped: 'bottom' }]
      },
      options: baseOpts({ scales: { x: { ticks: { maxTicksLimit: 24 } } } })
    });
  }
}

/* ============================================================
   PÁGINA 4 — Meta Ads
   ============================================================ */
/* Leads CRM por campanha no período: o ETL já atribui cada lead casado à
   campanha real no campaign_daily (campo `leads`) — o front só agrega.
   Regra de ouro 9: número vem do ETL, o front não re-deriva. */
function crmLeadsByCampaign() {
  const map = {};
  let matched = 0;
  fdays((DATA.meta_ads || {}).campaign_daily).forEach(r => {
    if (r.leads) {
      map[r.campanha] = (map[r.campanha] || 0) + r.leads;
      matched += r.leads;
    }
  });
  const pagos = sum(fdays(DATA.leads.daily), 'pagos');
  return { map, unmatched: Math.max(0, pagos - matched) };
}

function renderMeta(el) {
  const meta = DATA.meta_ads || {};
  const M = fdays(meta.daily);
  const gasto = sum(M, 'gasto');
  const imp = sum(M, 'impressoes');
  const cli = sum(M, 'cliques');
  const ctr = imp > 0 ? cli / imp * 100 : null;
  const conversas = sum(M, 'conversas');
  const leadsPlat = sum(M, 'leads_plat');
  const leadsCRM = sum(fdays(DATA.leads.daily), 'pagos');
  const cplCRM = leadsCRM > 0 ? gasto / leadsCRM : null;
  const matching = meta.matching || {};
  const cplTargetMsg = (DATA.config && DATA.config.cpl_target_meta === 0) ? 'meta de CPL não definida' : 'gasto ÷ leads CRM';

  let html = '<h2 class="page-title">Meta Ads</h2>' +
    '<p class="page-sub">Período: ' + periodLabel() + ' · CPL sempre com leads do CRM — números da plataforma são referência.</p>';

  html += '<div class="kpis">' +
    kpi('Investimento', fmt.currency(gasto), 'no período') +
    kpi('Impressões', fmt.num(imp)) +
    kpi('Cliques', fmt.num(cli)) +
    kpi('CTR', ctr == null ? '—' : fmt.pct(ctr, 2)) +
    kpi('Conversas iniciadas', fmt.num(conversas), 'plataforma') +
    kpi('Leads plataforma', fmt.num(leadsPlat), 'referência — não é CRM') +
    kpi('Leads CRM', fmt.num(leadsCRM), 'fonte de verdade', 'good') +
    kpi('CPL CRM', cplCRM == null ? '—' : fmt.currency(cplCRM),
      cplCRM == null ? 'sem leads CRM no período' : cplTargetMsg) +
    '</div>';

  if (matching.nivel) {
    html += '<div class="banner warn"><strong>Matching anúncio ↔ CRM no nível de ' + esc(matching.nivel) + '.</strong> ' +
      'O utm_content chega com o nome padrão do conjunto, então o lead do CRM só é atribuível à campanha — não a conjunto ou criativo. ' +
      'Cobertura do matching: <strong>' + fmt.pct(matching.cobertura_pct, 0) + '</strong> (' +
      fmt.num(matching.matched) + ' de ' + fmt.num(matching.leads_pagos_meta) + ' leads pagos casados via utm_campaign).</div>';
  }

  // gráfico gasto/dia × leads CRM/dia
  const sGasto = dailySeries(meta.daily, ['gasto']);
  const sLeads = dailySeries(DATA.leads.daily, ['pagos']);
  html += (sGasto
    ? chartCard('Investimento por dia × Leads CRM por dia', 'ch-meta-daily', TAG_TRUTH,
      'Barras = gasto (eixo esquerdo, R$); linha = leads pagos do CRM (eixo direito). Dias fora da cobertura do CRM ficam sem linha (não é zero).')
    : card('Investimento por dia × Leads CRM por dia', emptyBox()));

  // ----- tabela CAMPANHAS (campaign_daily agregado no período) -----
  const statusDict = meta.campaign_status || {};
  const byCamp = {};
  fdays(meta.campaign_daily).forEach(r => {
    const k = r.campanha;
    if (!byCamp[k]) byCamp[k] = { gasto: 0, impressoes: 0, cliques: 0, conversas: 0, leads_plat: 0 };
    byCamp[k].gasto += r.gasto || 0;
    byCamp[k].impressoes += r.impressoes || 0;
    byCamp[k].cliques += r.cliques || 0;
    byCamp[k].conversas += r.conversas || 0;
    byCamp[k].leads_plat += r.leads_plat || 0;
  });
  const crmMatch = crmLeadsByCampaign();
  Object.keys(crmMatch.map).forEach(c => {
    if (!byCamp[c]) byCamp[c] = { gasto: 0, impressoes: 0, cliques: 0, conversas: 0, leads_plat: 0 };
  });
  let anyStatusMissing = false;
  const campRows = Object.entries(byCamp)
    .map(([nome, v]) => {
      const lcrm = crmMatch.map[nome] || 0;
      return { nome, v, lcrm, cpl: lcrm > 0 ? v.gasto / lcrm : null };
    })
    .filter(r => r.v.gasto > 0 || r.lcrm > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);

  const campBody = campRows.map(r => {
    const st = statusDict[r.nome];
    let stHtml;
    if (st === 'ACTIVE') stHtml = '<span class="badge active">ACTIVE</span>';
    else if (st === 'PAUSED') stHtml = '<span class="badge paused">PAUSED</span>';
    else if (st) stHtml = '<span class="badge paused">' + esc(st) + '</span>';
    else { anyStatusMissing = true; stHtml = '<span class="badge unknown" title="status indisponível — não inferimos">—</span>'; }
    const ictr = r.v.impressoes > 0 ? r.v.cliques / r.v.impressoes * 100 : null;
    return '<tr><td>' + stHtml + '</td><td class="name">' + esc(r.nome) + '</td>' +
      '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(r.v.impressoes) + '</td>' +
      '<td class="r">' + fmt.num(r.v.cliques) + '</td>' +
      '<td class="r">' + (ictr == null ? '—' : fmt.pct(ictr, 2)) + '</td>' +
      '<td class="r">' + fmt.num(r.v.conversas) + '</td>' +
      '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' +
      '<td class="r">' + (r.lcrm > 0 ? fmt.num(r.lcrm) : '—') + '</td>' +
      '<td class="r">' + (r.cpl == null ? '—' : fmt.currency(r.cpl)) + '</td></tr>';
  }).join('');

  let campNotes = '<div class="note">Leads CRM atribuídos no nível de campanha via utm_campaign (ver banner acima). "—" = nenhum lead do CRM casado com a campanha no período.</div>';
  if (anyStatusMissing) campNotes += '<div class="note">Campanhas com status "—": status indisponível na API — o painel não infere se está ativa.</div>';
  if (crmMatch.unmatched > 0) campNotes += '<div class="note">' + fmt.num(crmMatch.unmatched) + ' lead(s) pago(s) do CRM no período sem campanha atribuída pelo matching — a soma da tabela é menor que o KPI de propósito (decomposição ≤ KPI).</div>';
  if (DATA.config && DATA.config.cpl_target_meta === 0) campNotes += '<div class="note">Meta de CPL não definida — sem régua verde/vermelha nas campanhas.</div>';

  html += card('Campanhas (agregado do período)',
    campRows.length
      ? '<div class="table-wrap"><table><thead><tr><th>Status</th><th>Campanha</th><th class="r">Gasto</th><th class="r">Impressões</th><th class="r">Cliques</th><th class="r">CTR</th><th class="r">Conversas</th><th class="r">Leads plat.</th><th class="r">Leads CRM</th><th class="r">CPL CRM</th></tr></thead><tbody>' +
      campBody + '</tbody></table></div>' + campNotes
      : emptyBox());

  // ----- tabela CONJUNTOS (adset_daily; chave composta campanha|||conjunto) -----
  const byAdset = {};
  fdays(meta.adset_daily).forEach(r => {
    const k = r.campanha + '|||' + r.conjunto;
    if (!byAdset[k]) byAdset[k] = { campanha: r.campanha, conjunto: r.conjunto, gasto: 0, cliques: 0, conversas: 0, leads_plat: 0 };
    byAdset[k].gasto += r.gasto || 0;
    byAdset[k].cliques += r.cliques || 0;
    byAdset[k].conversas += r.conversas || 0;
    byAdset[k].leads_plat += r.leads_plat || 0;
  });
  const adsetRows = Object.values(byAdset).filter(r => r.gasto > 0).sort((a, b) => b.gasto - a.gasto);
  const adsetBody = adsetRows.map(r =>
    '<tr><td class="name">' + esc(r.conjunto) + '</td><td class="name">' + esc(r.campanha) + '</td>' +
    '<td class="r">' + fmt.currency(r.gasto) + '</td>' +
    '<td class="r">' + fmt.num(r.cliques) + '</td>' +
    '<td class="r">' + fmt.num(r.conversas) + '</td>' +
    '<td class="r">' + fmt.num(r.leads_plat) + '</td></tr>').join('');

  html += card('Conjuntos de anúncio (agregado do período)',
    adsetRows.length
      ? '<div class="table-wrap"><table><thead><tr><th>Conjunto</th><th>Campanha</th><th class="r">Gasto</th><th class="r">Cliques</th><th class="r">Conversas</th><th class="r">Leads plat.</th></tr></thead><tbody>' +
      adsetBody + '</tbody></table></div>' +
      '<div class="note">Sem coluna de Leads CRM: atribuição por conjunto indisponível — o utm_content chega com o nome padrão do conjunto ("Novo conjunto de anúncios de Leads"), não com o anúncio. Parametrizar utm_content={{ad.name}} resolve.</div>'
      : emptyBox());

  // ----- tabela CRIATIVOS (creatives × creatives_daily p/ respeitar o período) -----
  const metaCreat = {};
  (meta.creatives || []).forEach(c => { metaCreat[c.anuncio + '|||' + c.campanha] = c; });
  const byCreat = {};
  fdays(meta.creatives_daily).forEach(r => {
    const k = r.anuncio + '|||' + r.campanha;
    if (!byCreat[k]) byCreat[k] = { anuncio: r.anuncio, campanha: r.campanha, gasto: 0, cliques: 0, conversas: 0, leads_plat: 0 };
    byCreat[k].gasto += r.gasto || 0;
    byCreat[k].cliques += r.cliques || 0;
    byCreat[k].conversas += r.conversas || 0;
    byCreat[k].leads_plat += r.leads_plat || 0;
  });
  const creatRows = Object.entries(byCreat)
    .map(([k, v]) => ({ k, v, agg: metaCreat[k] }))
    .filter(r => r.v.gasto > 0)
    .sort((a, b) => b.v.gasto - a.v.gasto);

  const creatBody = creatRows.map(r => {
    const agg = r.agg || {};
    const thumb = agg.thumbnail
      ? '<img class="thumb" src="' + esc(agg.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
      'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
      '<div class="thumb-fb">▦</div>'
      : '<div class="thumb-fb" style="display:flex">▦</div>';
    const link = agg.permalink ? '<a href="' + esc(agg.permalink) + '" target="_blank" rel="noopener">ver post</a>' : '—';
    return '<tr><td><div class="cell-creative">' + thumb + '<span class="name">' + esc(r.v.anuncio) + '</span></div></td>' +
      '<td class="name">' + esc(r.v.campanha) + '</td>' +
      '<td class="r">' + fmt.currency(r.v.gasto) + '</td>' +
      '<td class="r">' + fmt.num(r.v.cliques) + '</td>' +
      '<td class="r">' + (agg.ctr != null ? fmt.pct(agg.ctr, 2) : '—') + '</td>' +
      '<td class="r">' + fmt.num(r.v.conversas) + '</td>' +
      '<td class="r">' + fmt.num(r.v.leads_plat) + '</td>' +
      '<td>' + link + '</td></tr>';
  }).join('');

  html += card('Criativos (agregado do período)',
    creatRows.length
      ? '<div class="table-wrap"><table><thead><tr><th>Anúncio</th><th>Campanha</th><th class="r">Gasto</th><th class="r">Cliques</th><th class="r">CTR*</th><th class="r">Conversas</th><th class="r">Leads plat.</th><th>Link</th></tr></thead><tbody>' +
      creatBody + '</tbody></table></div>' +
      '<div class="note">*CTR do histórico completo do criativo — impressões diárias por criativo não estão disponíveis, então o CTR não respeita o filtro de período (as demais colunas respeitam).</div>' +
      '<div class="note">Sem Leads CRM por criativo pelo mesmo motivo do conjunto (utm_content com nome padrão).</div>'
      : emptyBox());

  el.innerHTML = html;

  if (sGasto) {
    // leads CRM alinhados ao eixo do gasto; fora da cobertura do CRM => null (buraco honesto)
    const leadsIdx = {};
    let lMin = null, lMax = null;
    if (sLeads) {
      sLeads.days.forEach((d, i) => { leadsIdx[d] = sLeads.data.pagos[i]; });
      lMin = sLeads.days[0]; lMax = sLeads.days[sLeads.days.length - 1];
    }
    const leadLine = sGasto.days.map(d =>
      (lMin && d >= lMin && d <= lMax) ? (leadsIdx[d] || 0) : null);
    makeChart('ch-meta-daily', {
      type: 'bar',
      data: {
        labels: sGasto.labels,
        datasets: [
          { type: 'bar', label: 'Gasto (R$)', data: sGasto.data.gasto, backgroundColor: C.green, borderRadius: 4, borderSkipped: 'bottom', yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Leads CRM (pagos)', data: leadLine, borderColor: C.blue, backgroundColor: C.blue, borderWidth: 2, pointRadius: 2, tension: .3, spanGaps: false, yAxisID: 'y1', order: 1 }
        ]
      },
      options: baseOpts({
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.yAxisID === 'y'
                ? ctx.dataset.label + ': ' + fmt.currency(ctx.parsed.y)
                : ctx.dataset.label + ': ' + (ctx.parsed.y == null ? 'sem cobertura CRM' : fmt.num(ctx.parsed.y))
            }
          }
        },
        scales: {
          y: { position: 'left', title: { display: true, text: 'R$' }, ticks: moneyTicks() },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0 }, title: { display: true, text: 'Leads CRM' } }
        }
      })
    });
  }
}

/* ============================================================
   PÁGINA 5 — Google Ads
   ============================================================ */
function renderGoogle(el) {
  const g = DATA.google_ads || {};
  let html = '<h2 class="page-title">Google Ads</h2>';
  if (g.disponivel === false) {
    html += '<div class="card"><div class="empty-state">' +
      '<div class="icon">🔌</div>' +
      '<h3>Integração ainda não conectada</h3>' +
      '<p>' + esc(g.motivo || 'Aguardando credenciais do Google Ads.') + '</p>' +
      '<p>Conta do cliente: <strong>Terrana — 223-460-7566</strong>.</p>' +
      '<ul class="checklist">' +
      '<li>Criar o OAuth Client (Google Cloud Console) da agência</li>' +
      '<li>Gerar o refresh token com acesso à conta 223-460-7566</li>' +
      '<li>Rodar o ETL — a página passa a espelhar o layout do Meta Ads automaticamente</li>' +
      '</ul>' +
      '</div></div>';
    // TODO: quando google_ads.disponivel === true, replicar aqui o layout da página
    // Meta Ads (KPIs de período, banner de matching, gasto × leads CRM por dia,
    // tabelas de campanhas / grupos de anúncio / criativos) usando as chaves
    // google_ads.daily / campaign_daily / etc. que o ETL passar a publicar.
  } else {
    html += '<div class="banner warn"><strong>Dados do Google Ads recebidos, mas esta página ainda não foi construída.</strong> O layout espelha o Meta Ads — pendência de implementação no front.</div>';
  }
  el.innerHTML = html;
}

/* ============================================================
   PÁGINA 6 — Rastreamento (UTM)
   ============================================================ */
function renderUTM(el) {
  const utm = DATA.utm || {};
  const cob = utm.cobertura || { total: 0, com_utm: 0, pct: 0 };

  const listTable = (rows, colName) => rows && rows.length
    ? '<div class="table-wrap"><table><thead><tr><th>' + colName + '</th><th class="r">Leads</th></tr></thead><tbody>' +
    rows.map(r => '<tr><td class="name">' + esc(r.valor) + '</td><td class="r">' + fmt.num(r.leads) + '</td></tr>').join('') +
    '</tbody></table></div>'
    : emptyBox('Sem valores registrados.');

  let html = '<h2 class="page-title">Rastreamento (UTM)</h2>' +
    '<p class="page-sub">Cobertura de parametrização dos leads do CRM. Esta página é a foto atual da base — não filtra por período.</p>';

  html += card('Cobertura de UTM',
    '<div class="coverage-tile">' +
    '<div class="coverage-num">' + fmt.pct(cob.pct, 1) + '</div>' +
    '<div class="coverage-meta">' +
    '<div>' + fmt.num(cob.com_utm) + ' de ' + fmt.num(cob.total) + ' leads chegam com UTM</div>' +
    '<div class="coverage-bar"><span style="width:' + Math.max(0, Math.min(100, cob.pct)) + '%"></span></div>' +
    '<div class="note" style="margin-top:0">Todo lead sem UTM vira "origem desconhecida" — o CPL por CRM descreve só a fatia rastreada.</div>' +
    '</div></div>',
    TAG_SNAPSHOT);

  html += '<div class="grid-2">' +
    card('utm_source', listTable(utm.sources, 'Source'), TAG_SNAPSHOT) +
    card('utm_campaign', listTable(utm.campaigns, 'Campanha'), TAG_SNAPSHOT) +
    '</div>';
  html += '<div class="grid-2">' +
    card('utm_content', listTable(utm.contents, 'Content'), TAG_SNAPSHOT) +
    card('Performance por campanha (CRM)',
      utm.campaigns_perf && utm.campaigns_perf.length
        ? '<div class="table-wrap"><table><thead><tr><th>Campanha</th><th class="r">Leads</th><th class="r">Ganhos</th><th class="r">Perdidos</th><th class="r">Conversão</th></tr></thead><tbody>' +
        utm.campaigns_perf.map(r =>
          '<tr><td class="name">' + esc(r.campanha) + '</td>' +
          '<td class="r">' + fmt.num(r.leads) + '</td>' +
          '<td class="r">' + fmt.num(r.ganhos) + '</td>' +
          '<td class="r">' + fmt.num(r.perdidos) + '</td>' +
          '<td class="r">' + fmt.pct(r.conversao_pct) + '</td></tr>').join('') +
        '</tbody></table></div>'
        : emptyBox('Sem campanhas rastreadas.'),
      TAG_SNAPSHOT) +
    '</div>';

  html += card('Por que parametrizar 100% dos links?',
    '<p style="font-size:13px;margin-bottom:8px">Hoje só ' + fmt.pct(cob.pct, 0) + ' dos leads chegam identificados. Sem UTM, o lead entra no CRM como "origem desconhecida" — impossível saber qual anúncio pagou por ele, e o CPL real fica invisível.</p>' +
    '<p style="font-size:13px;margin-bottom:8px"><strong>1.</strong> Todo link de anúncio, bio e formulário deve carregar utm_source, utm_medium e utm_campaign.</p>' +
    '<p style="font-size:13px;margin-bottom:8px"><strong>2.</strong> No Meta, usar <code>utm_content={{ad.name}}</code> — hoje o utm_content chega com o nome padrão do conjunto, o que impede atribuir lead a criativo. Com o parâmetro dinâmico, o funil por anúncio passa a existir.</p>' +
    '<p style="font-size:13px">Resultado: CPL por campanha, conjunto e criativo calculados com leads reais do CRM — decisões de verba com base no que converte, não no que a plataforma reporta.</p>');

  el.innerHTML = html;
}

/* ============================================================
   PÁGINA 7 — Relatório
   ============================================================ */
function renderRelatorio(el) {
  const r = DATA.relatorio || {};
  const delta = r.delta_leads_pct;
  const deltaHtml = delta == null ? '' :
    (delta >= 0
      ? '<span class="up">▲ +' + fmt.dec(delta, 0) + '%</span> vs mês anterior (' + fmt.num(r.leads_mes_anterior) + ')'
      : '<span class="down">▼ ' + fmt.dec(delta, 0) + '%</span> vs mês anterior (' + fmt.num(r.leads_mes_anterior) + ')');

  let html = '<h2 class="page-title">Relatório — ' + mesNome(r.mes) + '</h2>' +
    '<p class="page-sub">Resumo executivo do mês corrente. Esta página não usa o filtro de período. ' +
    '<button class="btn no-print" onclick="window.print()" style="margin-left:8px">Imprimir</button></p>';

  html += '<div class="kpis">' +
    kpi('Leads do mês (CRM)', fmt.num(r.leads_mes), deltaHtml) +
    kpi('Investimento Meta', fmt.currency(r.gasto_meta_mes), 'no mês') +
    kpi('Conversas iniciadas', fmt.num(r.conversas_meta_mes), 'Meta — plataforma') +
    kpi('CPL de plataforma', r.cpl_plat_mes == null ? '—' : fmt.currency(r.cpl_plat_mes), 'referência — leads da plataforma, não CRM') +
    kpi('Rastreamento UTM', fmt.pct(r.rastreamento_pct), 'leads identificados') +
    '</div>';

  html += card('Resumo do mês',
    '<ul class="report-list">' +
    '<li><span class="k">Mês de referência</span><span class="v">' + mesNome(r.mes) + '</span></li>' +
    '<li><span class="k">Leads criados no CRM</span><span class="v">' + fmt.num(r.leads_mes) + '</span></li>' +
    '<li><span class="k">Leads no mês anterior</span><span class="v">' + fmt.num(r.leads_mes_anterior) + '</span></li>' +
    '<li><span class="k">Variação de leads</span><span class="v">' + (delta == null ? '—' : (delta >= 0 ? '+' : '') + fmt.dec(delta, 0) + '%') + '</span></li>' +
    '<li><span class="k">Investimento Meta no mês</span><span class="v">' + fmt.currency(r.gasto_meta_mes) + '</span></li>' +
    '<li><span class="k">Conversas iniciadas (Meta)</span><span class="v">' + fmt.num(r.conversas_meta_mes) + '</span></li>' +
    '<li><span class="k">CPL de plataforma (referência)</span><span class="v">' + (r.cpl_plat_mes == null ? '—' : fmt.currency(r.cpl_plat_mes)) + '</span></li>' +
    '<li><span class="k">Cobertura de rastreamento (UTM)</span><span class="v">' + fmt.pct(r.rastreamento_pct) + '</span></li>' +
    '</ul>' +
    '<div class="note">O CPL de plataforma usa leads reportados pelo Meta e serve só de referência — o CPL oficial é sempre calculado com leads do CRM (ver página Meta Ads).</div>');

  const alertas = r.alertas || [];
  html += card('Alertas e ressalvas do mês',
    alertas.length
      ? '<ul class="alert-list">' + alertas.map(a =>
        '<li><span class="alert-tipo">' + esc(a.tipo) + '</span><br>' + esc(a.texto) + '</li>').join('') + '</ul>'
      : emptyBox('Nenhum alerta no momento.'));

  el.innerHTML = html;
}

/* ============================================================
   Carga de dados — dev (fetch direto) × produção (Supabase)
   ============================================================ */
function showFatal(msg) {
  document.getElementById('loading').hidden = false;
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-msg').classList.add('fatal');
  const sp = document.querySelector('#loading .spin');
  if (sp) sp.style.display = 'none';
}

function isDevMode() {
  return location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.protocol === 'file:';
}

async function loadData() {
  if (isDevMode()) {
    // Duplo clique no index.html (file://): o fetch é bloqueado pelo
    // navegador, mas o data/summary.js embutido via <script> funciona.
    if (window.__SUMMARY__) {
      DATA = window.__SUMMARY__;
      startDashboard();
      return;
    }
    try {
      const res = await fetch('data/summary.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      DATA = await res.json();
      startDashboard();
    } catch (e) {
      showFatal('Não foi possível carregar os dados (' + e.message + '). ' +
        'Gere-os com "python scripts/generate_dashboard_data.py" na pasta do ' +
        'projeto — depois disso o index.html abre até com duplo clique.');
    }
    return;
  }
  showLogin();
}

/* --- produção: login + Supabase Storage --- */
function loadSupabaseLib() {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Falha ao carregar supabase-js do CDN'));
    document.head.appendChild(s);
  });
}
async function initSupabase() {
  await loadSupabaseLib();
  sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
async function downloadSummary() {
  const { data, error } = await sbClient.storage.from(SUPABASE_BUCKET).download(SUPABASE_FILE);
  if (error) throw error;
  DATA = JSON.parse(await data.text());
}
function showLogin() {
  document.getElementById('loading').hidden = true;
  document.getElementById('login-screen').hidden = false;
  const notice = document.getElementById('login-notice');
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-err');

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    notice.hidden = false;
    notice.textContent = 'Produção ainda não configurada: preencha SUPABASE_URL e SUPABASE_ANON_KEY em assets/app.js e crie o bucket privado "dashboard-data" com o summary.json.';
    btn.disabled = true;
    return;
  }

  // sessão já existente → pula o login
  initSupabase().then(async () => {
    try {
      const { data } = await sbClient.auth.getSession();
      if (data && data.session) {
        await downloadSummary();
        document.getElementById('login-screen').hidden = true;
        startDashboard();
      }
    } catch (e) { /* segue para o login manual */ }
  }).catch(e => { err.textContent = e.message; });

  document.getElementById('login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      if (!sbClient) await initSupabase();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-pass').value;
      const { error } = await sbClient.auth.signInWithPassword({ email, password });
      if (error) throw new Error('E-mail ou senha incorretos.');
      await downloadSummary();
      document.getElementById('login-screen').hidden = true;
      startDashboard();
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

  document.getElementById('stamp').textContent =
    'Atualizado em ' + (DATA.last_update || '—') + ' · dados: ' + fmt.dateFull(DATA_MIN) + ' a ' + fmt.dateFull(DATA_MAX);

  document.getElementById('nav').innerHTML = PAGES.map(p =>
    '<a href="#/' + p.id + '" data-page="' + p.id + '">' + p.label + '</a>').join('');

  buildFilterUI();
  setPreset('30', false);

  document.getElementById('loading').hidden = true;
  document.body.classList.add('ready');

  window.addEventListener('hashchange', route);
  route();
}

document.addEventListener('DOMContentLoaded', loadData);
