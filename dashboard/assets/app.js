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
/* FILTER.start/end/preset = janela ATIVA (é o que inPeriod/fdays leem).
   Cada frente guarda o próprio estado: o B2B mantém os presets originais;
   o e-commerce ganha presets próprios + seletor de comparação. route()
   copia o estado da frente ativa para a janela ativa (adoptFilter). */
const FILTER = {
  start: null, end: null, preset: 'all',
  b2b: { start: null, end: null, preset: 'all' },
  ecom: { start: null, end: null, preset: '30', compare: 'prev' }
};
let DATA_MIN = null, DATA_MAX = null;
let CURRENT_FRONT = null;              // 'b2b' | 'ecom' | null (seletor)
let LAST_ROUTE = null;                 // 'front/página' — p/ só rolar ao topo em troca de página
let ECOM_PUB_VIEW = 'ecommerce';       // toggle da página Público do e-commerce
let ECOM_EVO_METRIC = 'invest';        // métrica ativa do gráfico Evolução (#ecom/visao)

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
  /* Conversões do Google podem ser fracionárias (atribuição baseada em dados:
     2,7 conversões) — inteiro fica sem casas; fração mostra até 2 casas. */
  conv: v => v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
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
/* Variante com janela explícita [a,b] — usada pela comparação do e-commerce
   sem mexer na janela ativa (e sem tocar o comportamento do B2B). */
function inRange(d, a, b) { return !!d && d >= a && d <= b; }
function fdaysR(list, a, b, key = 'dia') { return (list || []).filter(r => inRange(r[key], a, b)); }
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
/* Mesmo dia N meses antes/depois, com clamp no fim do mês (31/03 −1 → 28/02) */
function shiftMonthIso(iso, delta) {
  const y = parseInt(iso.slice(0, 4), 10), m = parseInt(iso.slice(5, 7), 10) - 1, d = parseInt(iso.slice(8, 10), 10);
  const first = new Date(Date.UTC(y, m + delta, 1, 12));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
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
/* ---------- Qualidade dos dados ----------
   Os avisos âmbar (relatorio.alertas) saíram do topo das páginas e moram na
   página "Qualidade dos dados" de cada painel. A Visão Geral mostra só um
   chip discreto linkando pra lá. */
const ALERT_META = {
  rastreamento: {
    titulo: 'Rastreamento (UTM)',
    fazer: 'Parametrizar todos os links de anúncio, bio e formulários com utm_source, utm_medium e utm_campaign — e usar utm_content={{ad.name}} no Meta. O passo a passo está na página Rastreamento (UTM) do painel B2B.'
  },
  valor: {
    titulo: 'Valores no CRM',
    fazer: 'Preencher o campo "Valor" dos negócios no Kommo. Com valor real, o painel passa a mostrar receita, ticket médio e valor em negociação por etapa — hoje qualquer número de dinheiro é estimativa.'
  },
  atendimento: {
    titulo: 'Resposta automática',
    fazer: 'Nada a corrigir nos dados — é um aviso de leitura: os tempos de resposta do painel medem a espera por uma pessoa, com o robô excluído das medianas.'
  }
};
function alertMeta(tipo) {
  return Object.prototype.hasOwnProperty.call(ALERT_META, tipo)
    ? ALERT_META[tipo]
    : { titulo: tipo ? tipo.charAt(0).toUpperCase() + tipo.slice(1) : 'Aviso de qualidade', fazer: 'Verifique a coleta desse dado no ETL e na origem (CRM/plataforma).' };
}
function qualityChip(front) {
  const alertas = (DATA.relatorio && DATA.relatorio.alertas) || [];
  if (!alertas.length) return '';
  return '<div class="q-chip-row"><a class="q-chip" href="#' + front + '/qualidade">🩺 ' +
    fmt.num(alertas.length) + (alertas.length === 1 ? ' observação' : ' observações') +
    ' de dados</a></div>';
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
   da série). options.plugins.directLabels = { mode:'all'|'max'|'total', format, datasets }
   'total' = barras empilhadas: UM rótulo por categoria, com a soma das séries
   visíveis, na ponta da pilha — format(total, índice). */
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
    if (o.mode === 'total') {
      (chart.data.labels || []).forEach((lab, i) => {
        let tot = 0, ponta = null, meio = null;
        chart.data.datasets.forEach((ds, di) => {
          const el = chart.getDatasetMeta(di).data[i];
          if (!chart.isDatasetVisible(di) || ds.data[i] == null || !el) return;
          tot += ds.data[i];
          const p = horizontal ? el.x : el.y;
          if (ponta == null || (horizontal ? p > ponta : p < ponta)) { ponta = p; meio = horizontal ? el.y : el.x; }
        });
        if (ponta == null) return;
        const txt = o.format ? o.format(tot, i) : fmt.num(tot);
        if (horizontal) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, ponta + 6, meio);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(txt, meio, ponta - 5);
        }
      });
      ctx.restore();
      return;
    }
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
      { id: 'utm', label: 'Rastreamento (UTM)', ic: '🧭', render: renderUTM },
      { id: 'qualidade', label: 'Qualidade dos dados', ic: '🩺', render: el => renderQualidade(el, 'b2b') }
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
      { id: 'evolucao', label: 'Evolução Mensal', ic: '📈', render: renderEvolucaoEcom },
      { id: 'qualidade', label: 'Qualidade dos dados', ic: '🩺', render: el => renderQualidade(el, 'ecom') }
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
  adoptFilter(r.front);                // janela ativa = estado da frente
  if (r.front !== CURRENT_FRONT) {
    applyFront(r.front);
    updateFilterBar(r.front);          // presets + comparação por frente
  }
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
/* Limites da série do E-COMMERCE (diário Meta + Google da frente). Presets,
   datas personalizadas e comparação do painel ecom se ancoram aqui — NÃO no
   DATA_MIN/DATA_MAX global, que também conta leads/CRM/atendimento do B2B
   (se o pipeline B2B ficar um dia à frente, "Hoje" não pode sair zerado). */
let ECOM_BOUNDS = null;
function ecomBounds() {
  if (ECOM_BOUNDS && ECOM_BOUNDS.src === DATA) return ECOM_BOUNDS;
  let min = null, max = null;
  const scan = list => (list || []).forEach(r => {
    const d = r && r.dia;
    if (typeof d !== 'string' || !d) return;
    if (min == null || d < min) min = d;
    if (max == null || d > max) max = d;
  });
  scan((DATA.meta_ecom || {}).daily);
  const g = DATA.google_ecom || {};
  if (g.disponivel === true) scan(g.daily);
  ECOM_BOUNDS = { src: DATA, min: min || DATA_MIN, max: max || DATA_MAX };
  return ECOM_BOUNDS;
}
function clampEcom(d) {
  const b = ecomBounds();
  return d < b.min ? b.min : (d > b.max ? b.max : d);
}
function fstate(front) { return front === 'b2b' ? FILTER.b2b : FILTER.ecom; }
/* Copia o estado da frente para a janela ativa (inPeriod/fdays leem dela) */
function adoptFilter(front) {
  const st = fstate(front);
  FILTER.start = st.start; FILTER.end = st.end; FILTER.preset = st.preset;
}
/* Presets do painel B2B — comportamento original, intocado */
function setPreset(p, rerender) {
  FILTER.preset = p;
  if (p === 'all') {
    FILTER.start = DATA_MIN; FILTER.end = DATA_MAX;
  } else if (p !== 'custom') {
    const n = parseInt(p, 10);
    FILTER.end = DATA_MAX;
    FILTER.start = addDays(DATA_MAX, -(n - 1));
  }
  FILTER.b2b.start = FILTER.start; FILTER.b2b.end = FILTER.end; FILTER.b2b.preset = FILTER.preset;
  syncFilterUI();
  if (rerender !== false) route();
}
/* Presets do painel E-COMMERCE — âncora = último dia com dados DO E-COMMERCE
   (ecomBounds().max), não o relógio nem o DATA_MAX global: "Hoje" é o último
   dia coberto pela atualização — e o rótulo do preset mostra a data. */
function setPresetEcom(p, rerender) {
  const st = FILTER.ecom;
  const MX = ecomBounds().max;
  st.preset = p;
  if (p === 'hoje') { st.start = MX; st.end = MX; }
  else if (p === 'ontem') { st.start = st.end = addDays(MX, -1); }
  else if (p === 'mes_atual') { st.start = MX.slice(0, 7) + '-01'; st.end = MX; }
  else if (p === 'mes_ant') {
    const fimAnt = addDays(MX.slice(0, 7) + '-01', -1);
    st.start = fimAnt.slice(0, 7) + '-01'; st.end = fimAnt;
  } else if (p !== 'custom') {
    const n = parseInt(p, 10);
    st.end = MX;
    st.start = addDays(MX, -(n - 1));
  }
  // nunca fora da série: dia sem cobertura não pode virar R$ 0,00
  if (st.start && st.end) {
    const a = clampEcom(st.start), z = clampEcom(st.end);
    st.adjusted = a !== st.start || z !== st.end;
    st.start = a; st.end = z;
  }
  adoptFilter('ecom');
  syncFilterUI();
  if (rerender !== false) route();
}
/* Janela de comparação do e-commerce (null = comparação desligada).
   · "mês anterior" com mês(es) cheio(s) compara com o mês anterior inteiro
     (setembro 01–30 × agosto 01–31, sem perder o dia 31);
   · se a janela passa de um mês, o "mês anterior" se sobreporia a ela →
     cai para o período anterior de mesmo tamanho, avisando no rótulo;
   · cobertura: 'total' | 'parcial' | 'nenhuma' frente ao início da série. */
function ecomCompareRange() {
  const st = FILTER.ecom;
  if (!st.start || !st.end || st.compare === 'none') return null;
  const n = dayRange(st.start, st.end).length;
  const anterior = extra => ({ a: addDays(st.start, -n), b: addDays(st.start, -1), label: 'período anterior de mesmo tamanho' + (extra || '') });
  let r;
  if (st.compare === 'prev_month') {
    const fimDoMes = iso => addDays(shiftMonthIso(iso.slice(0, 7) + '-01', 1), -1);
    const mesesCheios = st.start.slice(8, 10) === '01' && st.end === fimDoMes(st.end);
    r = mesesCheios
      ? { a: shiftMonthIso(st.start, -1), b: addDays(st.end.slice(0, 7) + '-01', -1), label: 'mesmo período do mês anterior' }
      : { a: shiftMonthIso(st.start, -1), b: shiftMonthIso(st.end, -1), label: 'mesmo período do mês anterior' };
    if (r.b >= st.start) r = anterior(' — a janela passa de um mês e o mês anterior se sobreporia a ela');
  } else {
    r = anterior();
  }
  const bd = ecomBounds();
  r.cobertura = r.b < bd.min ? 'nenhuma' : (r.a < bd.min ? 'parcial' : 'total');
  return r;
}
const PRESETS_B2B = [
  ['all', 'Todo período'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'],
  ['90', 'Últimos 90 dias'], ['custom', 'Personalizado', true]
];
/* Presets do e-commerce com a âncora explícita no rótulo ("Hoje" = último
   dia com dados da frente, não o relógio). */
function presetsEcom() {
  const MX = ecomBounds().max;
  const mesAnt = addDays(MX.slice(0, 7) + '-01', -1).slice(0, 7);
  return [
    ['hoje', 'Hoje (último dado: ' + fmt.date(MX) + ')'], ['ontem', 'Ontem (' + fmt.date(addDays(MX, -1)) + ')'],
    ['7', 'Últimos 7 dias'], ['14', 'Últimos 14 dias'], ['30', 'Últimos 30 dias'],
    ['mes_atual', 'Mês atual (' + mesLabel(MX.slice(0, 7)) + ')'], ['mes_ant', 'Mês anterior (' + mesLabel(mesAnt) + ')'],
    ['custom', 'Personalizado']
  ];
}
/* Troca as opções do seletor de período conforme a frente e mostra/esconde
   o seletor de comparação (exclusivo do e-commerce). */
function updateFilterBar(front) {
  const sel = document.getElementById('f-preset');
  const cmpWrap = document.getElementById('f-compare-wrap');
  if (sel) {
    const list = front === 'ecom' ? presetsEcom() : PRESETS_B2B;
    sel.innerHTML = list.map(o =>
      '<option value="' + o[0] + '"' + (o[2] ? ' hidden' : '') + '>' + esc(o[1]) + '</option>').join('');
  }
  if (cmpWrap) cmpWrap.hidden = front !== 'ecom';
  // datas do e-commerce limitadas à série da frente; B2B segue sem limites
  ['f-start', 'f-end'].forEach(id => {
    const inp = document.getElementById(id);
    if (!inp) return;
    if (front === 'ecom') { const bd = ecomBounds(); inp.min = bd.min; inp.max = bd.max; }
    else { inp.removeAttribute('min'); inp.removeAttribute('max'); }
  });
  syncFilterUI();
}
function syncFilterUI() {
  const s = document.getElementById('f-start'), e = document.getElementById('f-end');
  const sel = document.getElementById('f-preset');
  const cmp = document.getElementById('f-compare');
  if (s) s.value = FILTER.start || '';
  if (e) e.value = FILTER.end || '';
  if (sel) sel.value = FILTER.preset;
  if (cmp) cmp.value = FILTER.ecom.compare;
}
function onDateInput() {
  const s = document.getElementById('f-start').value;
  const e = document.getElementById('f-end').value;
  // Campo apagado: restaura a UI para o filtro APLICADO — senão o input
  // ficaria vazio com os dados ainda filtrados pelo valor antigo.
  if (!s || !e) { syncFilterUI(); return; }
  const st = fstate(CURRENT_FRONT || 'b2b');
  if (CURRENT_FRONT === 'ecom') {
    // Ano ainda sendo digitado (0002, 0020, 0202…): espera completar — o
    // blur devolve o filtro aplicado se o campo for abandonado assim.
    if (s < '1900' || e < '1900') return;
    // Datas presas à série do e-commerce: fora dela não há dado (nem zero)
    const a0 = s <= e ? s : e, z0 = s <= e ? e : s;
    const a = clampEcom(a0), z = clampEcom(z0);
    st.adjusted = a !== a0 || z !== z0;
    st.start = a; st.end = z;
  } else {
    st.start = s <= e ? s : e;
    st.end = s <= e ? e : s;
  }
  st.preset = 'custom';
  FILTER.start = st.start; FILTER.end = st.end; FILTER.preset = 'custom';
  syncFilterUI();
  route();
}
function buildFilterUI() {
  document.getElementById('f-start').addEventListener('change', onDateInput);
  document.getElementById('f-end').addEventListener('change', onDateInput);
  // E-commerce: campo abandonado com ano incompleto (0002…) volta ao filtro aplicado
  ['f-start', 'f-end'].forEach(id => {
    const inp = document.getElementById(id);
    inp.addEventListener('blur', () => {
      if (CURRENT_FRONT === 'ecom' && inp.value && inp.value < '1900') syncFilterUI();
    });
  });
  document.getElementById('f-preset').addEventListener('change', ev => {
    const v = ev.target.value;
    if (v === 'custom') {
      // "Personalizado" no e-commerce: marca o preset e leva o foco às datas
      if (CURRENT_FRONT === 'ecom') {
        FILTER.ecom.preset = 'custom';
        const s = document.getElementById('f-start');
        if (s) s.focus();
      }
      return;
    }
    if (CURRENT_FRONT === 'ecom') setPresetEcom(v); else setPreset(v);
  });
  const cmp = document.getElementById('f-compare');
  if (cmp) cmp.addEventListener('change', ev => {
    FILTER.ecom.compare = ev.target.value;
    if (CURRENT_FRONT === 'ecom') route();
  });
}

/* ============================================================
   VISÃO GERAL = DASHBOARD DE OTIMIZAÇÃO (compartilhada B2B/ECOM)
   Estrutura do projeto-base CDC com a identidade Terrana:
   1 controle de investimento (ciclo) · 2 volume e eficiência do
   período · 3 evolução diária · 4 histórico mensal · 5 onde está
   o resultado · 6 ações · conteúdo anterior preservado no fim.
   Orçamentos e metas a 0 = "não definido" — estado honesto SEMPRE.
   ============================================================ */
/* Gasto Google no gráfico empilhado: tom derivado da terracota (Meta fica
   na terracota cheia) — sempre acompanhado de legenda. */
const GOOGLE_INV = '#C4703C';
/* Conversões Google no empilhado de resultados: tom derivado da oliva
   (compras Meta ficam na oliva cheia) — sempre acompanhado de legenda. */
const GOOGLE_RES = '#9DBE6A';

function otCfg(front) {
  const cfg = DATA.config || {};
  if (front === 'b2b') {
    return {
      front, ot: DATA.otimizacao_b2b || {},
      orcMeta: cfg.orcamento_meta_b2b || 0,
      orcGoogle: cfg.orcamento_google_b2b || 0,
      varsOrc: 'ORCAMENTO_META_B2B e ORCAMENTO_GOOGLE_B2B',
      target: cfg.cpl_target_meta || 0,
      varTarget: 'CPL_TARGET_META',
      resNome: 'lead'
    };
  }
  return {
    front, ot: DATA.otimizacao_ecom || {},
    orcMeta: cfg.orcamento_meta_ecom || 0,
    orcGoogle: cfg.orcamento_google_ecom || 0,
    varsOrc: 'ORCAMENTO_META_ECOM e ORCAMENTO_GOOGLE_ECOM',
    target: cfg.cpa_target_ecom || 0,
    varTarget: 'CPA_TARGET_ECOM',
    resNome: 'resultado'
  };
}
function secTitle(txt, sub, id) {
  return '<h2 class="sec-title"' + (id ? ' id="' + id + '"' : '') + '>' + txt + (sub ? ' <span>— ' + sub + '</span>' : '') + '</h2>';
}
/* Atalhos para as seções — a Visão Geral B2B é longa. Botões (não links):
   o hash da URL é a rota da página. */
function secNavHtml(secoes) {
  return '<nav class="sec-nav" aria-label="Ir para a seção">' + secoes.map(s =>
    '<button type="button" data-alvo="' + s[0] + '">' + s[1] + '</button>').join('') + '</nav>';
}
function secNavBind(el) {
  el.querySelectorAll('.sec-nav button').forEach(b => b.addEventListener('click', () => {
    const alvo = document.getElementById(b.dataset.alvo);
    if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
function acaoCard(kind, tag, titulo, corpo) {
  return '<div class="action-card ' + kind + '"><span class="badge ' + (kind === 'crit' ? 'red' : kind === 'ok' ? 'green' : 'gray') + '">' + tag + '</span>' +
    '<div class="ac-tx"><div class="ac-t">' + titulo + '</div><div class="ac-b">' + corpo + '</div></div></div>';
}
function pbar(pct, danger) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return '<div class="pbar' + (danger ? ' danger' : '') + '"><span style="width:' + w + '%"></span></div>';
}
function metaBadgeCusto(custo, target) {
  if (!target) return '<span class="badge gray">meta não definida</span>';
  if (custo == null) return '<span class="badge gray">sem resultados</span>';
  return custo <= target
    ? '<span class="badge green">na meta</span>'
    : '<span class="badge red">acima da meta</span>';
}
function dayIdx(rows, field) {
  const m = Object.create(null);
  (rows || []).forEach(r => { if (r.dia) m[r.dia] = (m[r.dia] || 0) + (r[field] || 0); });
  return m;
}

/* ---------- Cabeçalho da página (período · comparação · atualização) ---------- */
function otHeaderHtml(front) {
  const n = dayRange(FILTER.start, FILTER.end).length;
  const prevStart = addDays(FILTER.start, -n), prevEnd = addDays(FILTER.start, -1);
  return '<div class="page-context">Período: <strong>' + periodLabel() + '</strong> · Comparado com: ' +
    fmt.dateFull(prevStart) + ' a ' + fmt.dateFull(prevEnd) + ' (período anterior de mesmo tamanho) · Atualizado em ' +
    esc(DATA.last_update || '—') + '</div>' + qualityChip(front);
}

/* ---------- 1 · Controle de investimento (ciclo mensal) ---------- */
function otCicloHtml(c) {
  const ci = c.ot.ciclo || {};
  const orcTotal = c.orcMeta + c.orcGoogle;
  const fim = ci.inicio ? addDays(ci.inicio, (ci.dias_no_mes || 30) - 1) : null;
  const diasRest = Math.max(0, (ci.dias_no_mes || 0) - (ci.dias_passados || 0));

  // --- Saldo em conta ---
  let cardSaldo;
  if (orcTotal > 0) {
    const saldo = orcTotal - (ci.gasto_total || 0);
    const pctUso = (ci.gasto_total || 0) / orcTotal * 100;
    const pctMes = (ci.dias_no_mes || 0) > 0 ? (ci.dias_passados || 0) / ci.dias_no_mes * 100 : 0;
    const ok = pctUso <= pctMes + 8;   // uso até ~o ritmo do calendário
    const sub = (plat, gasto, orc) => orc > 0
      ? '<div class="sb-row"><span class="sb-lb">' + plat + '</span>' + pbar(gasto / orc * 100, gasto > orc) +
      '<span class="sb-vl">' + fmt.moneyShort(gasto) + ' / ' + fmt.moneyShort(orc) + '</span></div>'
      : '<div class="sb-row"><span class="sb-lb">' + plat + '</span><span class="sb-vl">orçamento não definido · gasto ' + fmt.moneyShort(gasto) + '</span></div>';
    cardSaldo = card('Saldo em conta', 'orçamento do mês − gasto do ciclo',
      '<div class="big-money">' + fmt.currency(saldo) + '</div>' +
      pbar(pctUso, pctUso > 100) +
      '<div class="ctx-line">' + fmt.currency(ci.gasto_total || 0) + ' gastos de ' + fmt.currency(orcTotal) + ' — ' + fmt.pct(pctUso, 0) + ' usado ' +
      (ok ? '<span class="badge green">na meta</span>' : '<span class="badge red">atenção</span>') + '</div>' +
      sub('Meta Ads', ci.gasto_meta || 0, c.orcMeta) +
      sub('Google Ads', ci.gasto_google || 0, c.orcGoogle));
  } else {
    cardSaldo = card('Saldo em conta', 'orçamento do mês − gasto do ciclo',
      emptyDashed('Orçamento mensal não definido.',
        'Defina ' + c.varsOrc + ' nas Variables do repositório para habilitar este card. ' +
        'Gasto do ciclo até aqui: ' + fmt.currency(ci.gasto_total || 0) + '.'));
  }

  // --- Ritmo de gasto ---
  // Sem ciclo no resumo, nada de zeros fabricados: estado honesto.
  let cardRitmo;
  if (!ci.inicio) {
    cardRitmo = card('Ritmo de gasto', 'ciclo atual · Meta + Google',
      emptyDashed('Sem dados do ciclo atual.',
        'O resumo ainda não trouxe o ciclo do mês — verifique a próxima atualização dos dados.'));
  } else {
    let ritmoBody = '<div class="big-money">' + fmt.currency(ci.ritmo_dia || 0) + '<span class="bm-unit">/dia</span></div>' +
      '<div class="ctx-line">Ciclo ' + fmt.dateFull(ci.inicio) + ' a ' + fmt.dateFull(fim) +
      ' · dia ' + fmt.num(ci.dias_passados) + ' de ' + fmt.num(ci.dias_no_mes) + '</div>' +
      '<div class="ctx-line">Projeção do mês: <strong>' + fmt.currency(ci.projecao_mes || 0) + '</strong></div>';
    if (orcTotal > 0) {
      const restante = Math.max(0, orcTotal - (ci.gasto_total || 0));
      const rd = diasRest > 0 ? restante / diasRest : null;
      const cabe = (ci.projecao_mes || 0) <= orcTotal;
      ritmoBody += '<div class="ctx-line">' +
        (rd == null ? 'Ciclo encerrado' : fmt.currency(rd) + '/dia nos ' + fmt.num(diasRest) + ' dias restantes') + ' ' +
        (cabe ? '<span class="badge green">Cabe</span>' : '<span class="badge red">Não cabe</span>') + '</div>';
    } else {
      ritmoBody += '<div class="ctx-line muted">Defina o orçamento (' + c.varsOrc + ') para ver se a projeção cabe no mês.</div>';
    }
    cardRitmo = card('Ritmo de gasto', 'ciclo atual · Meta + Google', ritmoBody);
  }

  // --- Split da frente ---
  let cardSplit;
  if (c.front === 'b2b' && !ci.inicio) {
    cardSplit = card('Formulário × outras origens', 'leads do ciclo · split pela foto da base',
      emptyDashed('Sem dados do ciclo atual.',
        'O split de leads do ciclo aparece quando o resumo trouxer o ciclo do mês.'));
  } else if (c.front === 'b2b') {
    const dailyC = ((DATA.leads || {}).daily || []).filter(r => r.dia >= ci.inicio);
    const leadsCiclo = sum(dailyC, 'total');
    const bs = (DATA.leads || {}).by_source || [];
    const formTot = bs.filter(r => /formul/i.test(r.fonte || '')).reduce((a, r) => a + (r.leads || 0), 0);
    const allTot = bs.reduce((a, r) => a + (r.leads || 0), 0);
    const pctForm = allTot > 0 ? formTot / allTot * 100 : null;
    cardSplit = card('Formulário × outras origens', 'leads do ciclo · split pela foto da base',
      '<div class="big-money">' + fmt.num(leadsCiclo) + '<span class="bm-unit">leads no ciclo</span></div>' +
      (pctForm == null
        ? '<div class="ctx-line muted">Sem origem efetiva registrada na base ainda.</div>'
        : pbar(pctForm) +
        '<div class="ctx-line">Formulário <strong>' + fmt.pct(pctForm, 0) + '</strong> · outras origens <strong>' + fmt.pct(100 - pctForm, 0) + '</strong></div>' +
        '<div class="ctx-line muted">split sobre a base com atribuição (foto atual) — o export ainda não traz a origem por dia</div>'));
  } else {
    const gt = ci.gasto_total || 0;
    cardSplit = card('Meta × Google', 'distribuição do gasto no ciclo',
      gt > 0
        ? '<div class="big-money">' + fmt.pct((ci.gasto_meta || 0) / gt * 100, 0) + '<span class="bm-unit">Meta</span></div>' +
        pbar((ci.gasto_meta || 0) / gt * 100) +
        '<div class="ctx-line">Meta <strong>' + fmt.currency(ci.gasto_meta || 0) + '</strong> · Google <strong>' + fmt.currency(ci.gasto_google || 0) + '</strong></div>'
        : emptyDashed('Sem gasto no ciclo até aqui.', 'A distribuição Meta × Google aparece assim que houver investimento no mês.'));
  }
  return '<div class="grid-3">' + cardSaldo + cardRitmo + cardSplit + '</div>';
}

/* ---------- 2 · O que está acontecendo (usa o filtro global) ---------- */
function otPeriodo(c) {
  if (c.front === 'b2b') {
    const mb = fdays((DATA.meta_b2b || {}).daily);
    const g = DATA.google_b2b || {};
    const gOk = g.disponivel === true && !!g.daily;
    const gd = gOk ? fdays(g.daily) : [];
    const investMeta = sum(mb, 'gasto'), investGoogle = sum(gd, 'gasto');
    return {
      investMeta, investGoogle, invest: investMeta + investGoogle, gOk,
      gMotivo: g.motivo || 'Google Ads ainda sem campanhas B2B.',
      resultados: sum(fdays((DATA.leads || {}).daily), 'total'),
      resSub: 'leads criados no CRM no período (todas as origens)',
      resMetaPlat: sum(mb, 'leads_plat'), resMetaPlatLabel: 'leads plat.',
      resGooglePlat: gOk ? sum(gd, 'conversoes') : null, resGooglePlatLabel: 'conversões',
      topo: sum(mb, 'conversas'),
      topoSub: 'conversas iniciadas pelo anúncio (Meta) · no período'
    };
  }
  const me = fdays((DATA.meta_ecom || {}).daily);
  const g = DATA.google_ecom || {};
  const gOk = g.disponivel === true && !!g.daily;
  const gd = gOk ? fdays(g.daily) : [];
  const investMeta = sum(me, 'gasto'), investGoogle = sum(gd, 'gasto');
  const compras = sum(me, 'compras'), conv = gOk ? sum(gd, 'conversoes') : 0;
  return {
    investMeta, investGoogle, invest: investMeta + investGoogle, gOk,
    gMotivo: g.motivo || 'Google Ads sem dados para esta frente.',
    resultados: compras + conv,
    resSub: fmt.num(compras) + ' compras (pixel Meta) + ' + fmt.num(conv) + ' conversões (Google)',
    resMetaPlat: compras, resMetaPlatLabel: 'compras',
    resGooglePlat: gOk ? conv : null, resGooglePlatLabel: 'conversões',
    topo: sum(me, 'cliques_link') + (gOk ? sum(gd, 'cliques') : 0),
    topoSub: 'cliques no link (Meta)' + (gOk ? ' + cliques (Google)' : '') + ' · no período'
  };
}
/* Campanhas da frente com custo por resultado × meta.
   B2B: resultado por campanha = leads da plataforma (referência — o CRM não
   quebra leads por campanha no diário). ECOM: compras (Meta) e conversões
   (Google). filtered = respeita o filtro global; senão, toda a série. */
function otCampanhas(c, filtered) {
  const rows = [];
  const collect = (daily, resField, plat) => {
    const src = filtered ? fdays(daily) : (daily || []);
    const by = aggBy(src, r => r.campanha, ['gasto', resField]);
    Object.keys(by).forEach(k => {
      const v = by[k];
      if (v.gasto > 0) {
        rows.push({
          nome: k, plat, gasto: v.gasto, res: v[resField] || 0,
          custo: (v[resField] || 0) > 0 ? v.gasto / v[resField] : null
        });
      }
    });
  };
  if (c.front === 'b2b') {
    collect((DATA.meta_b2b || {}).campaign_daily, 'leads_plat', 'Meta');
    const g = DATA.google_b2b || {};
    if (g.disponivel === true) collect(g.campaign_daily, 'conversoes', 'Google');
  } else {
    collect((DATA.meta_ecom || {}).campaign_daily, 'compras', 'Meta');
    const g = DATA.google_ecom || {};
    if (g.disponivel === true) collect(g.campaign_daily, 'conversoes', 'Google');
  }
  return {
    rows,
    dentro: rows.filter(r => r.custo != null && r.custo <= c.target),
    fora: rows.filter(r => !(r.custo != null && r.custo <= c.target))
  };
}
function otAgoraHtml(c, p) {
  const custo = (p.invest > 0 && p.resultados > 0) ? p.invest / p.resultados : null;
  let campKpi = '—', campSub = 'defina a meta de custo (' + c.varTarget + ') para habilitar';
  if (c.target > 0) {
    const cm = otCampanhas(c, true);
    campKpi = fmt.num(cm.dentro.length) + ' de ' + fmt.num(cm.rows.length);
    campSub = 'campanhas com custo/' + c.resNome + ' ≤ ' + fmt.currency(c.target) + ' no período';
  }
  let html = '<div class="kpis cols-5">' +
    kpi('Investimento no período', fmt.currency(p.invest),
      'Meta ' + fmt.currency(p.investMeta) + (p.gOk ? ' + Google ' + fmt.currency(p.investGoogle) : ' · Google sem dados')) +
    kpi('Resultados', fmt.num(p.resultados), p.resSub) +
    kpi('Custo por resultado', custo == null ? null : fmt.currency(custo),
      (custo != null ? 'investimento ÷ resultados · '
        : p.invest > 0 ? 'sem resultados no período · '
        : p.resultados > 0 ? 'sem investimento no período · '
        : 'sem investimento nem resultados · ') +
      (c.target > 0 ? 'meta: até ' + fmt.currency(c.target) : 'meta não definida'), { teal: true }) +
    kpi('Campanhas na meta', campKpi, campSub) +
    kpi('Topo de funil', fmt.num(p.topo), p.topoSub) +
    '</div>';

  // faixas por plataforma (fundo translúcido: mostarda = Meta, terracota = Google)
  const faixa = (cls, nome, inv, res, resLb, cpr, badge, nota) =>
    '<div class="plat-band ' + cls + '"><div class="pb-name">' + nome + '</div>' +
    '<div class="pb-kpis">' +
    '<div class="pb-kpi"><span class="l">investido</span><span class="v">' + (inv == null ? '—' : fmt.currency(inv)) + '</span></div>' +
    '<div class="pb-kpi"><span class="l">' + resLb + '</span><span class="v">' + (res == null ? '—' : fmt.num(res)) + '</span></div>' +
    '<div class="pb-kpi"><span class="l">custo por resultado</span><span class="v">' + (cpr == null ? '—' : fmt.currency(cpr)) + '</span></div>' +
    '<div class="pb-badge">' + badge + '</div></div>' +
    (nota ? '<div class="pb-note">' + nota + '</div>' : '') + '</div>';
  const cMeta = (p.investMeta > 0 && p.resMetaPlat > 0) ? p.investMeta / p.resMetaPlat : null;
  html += faixa('meta', 'Meta Ads', p.investMeta, p.resMetaPlat, p.resMetaPlatLabel, cMeta,
    metaBadgeCusto(cMeta, c.target),
    c.front === 'b2b' ? 'resultados da faixa = leads reportados pela plataforma (referência)' : 'compras e receita pelo pixel da Meta');
  if (p.gOk) {
    const cG = (p.investGoogle > 0 && p.resGooglePlat > 0) ? p.investGoogle / p.resGooglePlat : null;
    html += faixa('google', 'Google Ads', p.investGoogle, p.resGooglePlat, p.resGooglePlatLabel, cG,
      metaBadgeCusto(cG, c.target), 'conversões e valor: atribuição do Google');
  } else {
    html += faixa('google', 'Google Ads', null, null, p.resGooglePlatLabel, null,
      '<span class="badge gray">sem dados</span>', esc(p.gMotivo));
  }
  return html;
}

/* ---------- 3 · Como está evoluindo (diário, filtro global) ---------- */
function otDailyData(c) {
  let metaRows, gRows = null, resFieldMeta = null, resFromLeads = false;
  if (c.front === 'b2b') {
    metaRows = fdays((DATA.meta_b2b || {}).daily);
    const g = DATA.google_b2b || {};
    if (g.disponivel === true && g.daily) gRows = fdays(g.daily);
    resFromLeads = true;                 // resultados B2B = leads do CRM (não têm plataforma)
  } else {
    metaRows = fdays((DATA.meta_ecom || {}).daily);
    resFieldMeta = 'compras';
    const g = DATA.google_ecom || {};
    if (g.disponivel === true && g.daily) gRows = fdays(g.daily);
  }
  const leadRows = resFromLeads ? fdays((DATA.leads || {}).daily) : [];
  const all = [].concat(metaRows, gRows || [], leadRows).map(r => r.dia).filter(Boolean).sort();
  if (!all.length) return null;
  const days = dayRange(all[0], all[all.length - 1]);
  const invMetaIdx = dayIdx(metaRows, 'gasto');
  const invGIdx = gRows ? dayIdx(gRows, 'gasto') : null;
  const resMetaIdx = resFromLeads ? dayIdx(leadRows, 'total') : dayIdx(metaRows, resFieldMeta);
  const resGIdx = (!resFromLeads && gRows) ? dayIdx(gRows, 'conversoes') : null;
  const invMeta = days.map(d => invMetaIdx[d] || 0);
  const invG = invGIdx ? days.map(d => invGIdx[d] || 0) : null;
  const resMeta = days.map(d => resMetaIdx[d] || 0);
  const resG = resGIdx ? days.map(d => resGIdx[d] || 0) : null;
  const cpr = days.map((d, i) => {
    const inv = invMeta[i] + (invG ? invG[i] : 0);
    const res = resMeta[i] + (resG ? resG[i] : 0);
    return res > 0 ? inv / res : null;
  });
  return { days, labels: days.map(fmt.date), invMeta, invG, resMeta, resG, cpr };
}
function otEvolucaoHtml(c, dd) {
  if (!dd) {
    return card('Como está evoluindo', 'dia a dia do período',
      emptyDashed('Sem dados diários no período selecionado.', 'Ajuste o filtro de período no topo.'));
  }
  const resRelief = reliefTable(
    [{ t: 'Dia' }, { t: c.front === 'b2b' ? 'Leads (CRM)' : 'Compras (Meta)', r: 1 }].concat(dd.resG ? [{ t: 'Conversões (Google)', r: 1 }] : []),
    dd.days.map((d, i) => '<tr><td>' + fmt.dateFull(d) + '</td><td class="r">' + fmt.num(dd.resMeta[i]) + '</td>' +
      (dd.resG ? '<td class="r">' + fmt.num(dd.resG[i]) + '</td>' : '') + '</tr>').join(''));
  const invRelief = reliefTable(
    [{ t: 'Dia' }, { t: 'Meta', r: 1 }].concat(dd.invG ? [{ t: 'Google', r: 1 }] : []),
    dd.days.map((d, i) => '<tr><td>' + fmt.dateFull(d) + '</td><td class="r">' + fmt.currency(dd.invMeta[i]) + '</td>' +
      (dd.invG ? '<td class="r">' + fmt.currency(dd.invG[i]) + '</td>' : '') + '</tr>').join(''));
  const cprRelief = reliefTable([{ t: 'Dia' }, { t: 'Custo/resultado', r: 1 }],
    dd.days.map((d, i) => '<tr><td>' + fmt.dateFull(d) + '</td><td class="r">' + (dd.cpr[i] == null ? '—' : fmt.currency(dd.cpr[i])) + '</td></tr>').join(''));
  const resSub = c.front === 'b2b'
    ? 'leads criados no CRM por dia (todas as origens)'
    : 'compras (pixel Meta)' + (dd.resG ? ' + conversões (Google) — barras empilhadas' : '');
  const invSub = dd.invG ? 'Meta + Google empilhados por dia' : 'gasto Meta por dia' + (c.front === 'b2b' ? ' · Google sem campanhas B2B' : '');
  const cprSub = 'investimento ÷ resultados do dia' +
    (c.target > 0 ? ' · linha tracejada = meta (' + fmt.currency(c.target) + ')' : ' · meta de custo não definida');
  return '<div class="grid-3">' +
    chartCard('Resultados por dia', resSub, 'ch-ot-res', '', resRelief) +
    chartCard('Investimento por dia', invSub, 'ch-ot-inv', '', invRelief) +
    chartCard('Custo por resultado por dia', cprSub, 'ch-ot-cpr', '', cprRelief) +
    '</div>';
}
function otCharts(c, dd) {
  if (!dd) return;
  const stackEx = { stack: 'p', borderColor: P.bgCard, borderWidth: 2, borderRadius: 3 };
  // Paleta por entidade: leads = mostarda (B2B); compras/conversões = oliva
  // (ECOM), com o segmento Google no tom derivado da oliva (GOOGLE_RES).
  const dsRes = [barDs(c.front === 'b2b' ? 'Leads (CRM)' : 'Compras (Meta)', dd.resMeta,
    c.front === 'b2b' ? S.mostarda : S.oliva, dd.resG ? stackEx : {})];
  if (dd.resG) dsRes.push(barDs('Conversões (Google)', dd.resG, GOOGLE_RES, stackEx));
  makeChart('ch-ot-res', {
    type: 'bar', data: { labels: dd.labels, datasets: dsRes },
    options: baseOpts({
      plugins: dd.resG ? { legend: legendTop() } : {},
      scales: { x: deepMerge(xDaily(), { stacked: true }), y: yCount({ stacked: true }) }
    })
  });
  const dsInv = [barDs('Meta (R$)', dd.invMeta, S.terracota, dd.invG ? stackEx : {})];
  if (dd.invG) dsInv.push(barDs('Google (R$)', dd.invG, GOOGLE_INV, stackEx));
  makeChart('ch-ot-inv', {
    type: 'bar', data: { labels: dd.labels, datasets: dsInv },
    options: baseOpts({
      plugins: deepMerge({ tooltip: { callbacks: moneyTooltip() } }, dd.invG ? { legend: legendTop() } : {}),
      scales: { x: deepMerge(xDaily(), { stacked: true }), y: yMoney({ stacked: true }) }
    })
  });
  const dsCpr = [lineDs('Custo por resultado', dd.cpr, S.mostarda, { spanGaps: false, pointRadius: 3 })];
  if (c.target > 0) {
    dsCpr.push({
      label: 'Meta (' + fmt.currency(c.target) + ')', data: dd.days.map(() => c.target),
      borderColor: ST.green, borderDash: [6, 4], borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 0, fill: false
    });
  }
  makeChart('ch-ot-cpr', {
    type: 'line', data: { labels: dd.labels, datasets: dsCpr },
    options: baseOpts({
      plugins: deepMerge({
        tooltip: { callbacks: { label: ctx => ctx.parsed.y == null ? 'sem resultado no dia' : ctx.dataset.label + ': ' + fmt.currency(ctx.parsed.y) } }
      }, c.target > 0 ? { legend: legendTop() } : {}),
      scales: { y: yMoney() }
    })
  });
}

/* ---------- 4 · Histórico mensal (independe do filtro) ---------- */
function otHistHtml(c) {
  const hist = (c.ot.monthly_hist || []).slice().sort((a, b) => (a.mes > b.mes ? 1 : a.mes < b.mes ? -1 : 0));
  if (!hist.length) {
    return card('Histórico mensal', 'mês a mês — independe do filtro de período', emptyDashed('Sem histórico mensal ainda.'));
  }
  const mesCell = h => '<td class="name">' + mesLabel(h.mes) +
    (h.parcial ? ' <span class="badge amber">parcial</span>' : '') + '</td>';
  let head, body, nota;
  if (c.front === 'b2b') {
    const leadsMes = {};
    ((DATA.leads || {}).monthly || []).forEach(r => { leadsMes[r.mes] = r.total || 0; });
    head = '<tr class="tg"><th></th>' +
      '<th colspan="5" class="gh gm">Meta Ads</th><th class="gh gg">Google Ads</th><th class="gh gt">Total</th></tr>' +
      '<tr><th>Mês</th><th class="r">Investimento</th><th class="r">Cliques no link</th><th class="r">Leads plat.</th>' +
      '<th class="r">Leads CRM*</th><th class="r">Custo/lead*</th><th class="r">Investimento</th><th class="r">Investimento</th></tr>';
    body = hist.map(h => {
      const m = h.meta || {};
      const lc = leadsMes[h.mes] || 0;
      const custo = (lc > 0 && (m.gasto || 0) > 0) ? m.gasto / lc : null;
      const gG = (h.google && h.google.gasto != null) ? h.google.gasto : null;
      return '<tr>' + mesCell(h) +
        '<td class="r">' + fmt.currency(m.gasto || 0) + '</td>' +
        '<td class="r">' + fmt.num(m.cliques_link || 0) + '</td>' +
        '<td class="r">' + fmt.num(m.leads_plat || 0) + '</td>' +
        '<td class="r">' + fmt.num(lc) + '</td>' +
        '<td class="r">' + (custo == null ? '—' : fmt.currency(custo)) + '</td>' +
        '<td class="r">' + (gG == null ? '—' : fmt.currency(gG)) + '</td>' +
        '<td class="r">' + fmt.currency((m.gasto || 0) + (gG || 0)) + '</td></tr>';
    }).join('');
    nota = '* <strong>Leads CRM</strong> = todos os leads criados no CRM no mês (todas as origens — a cobertura de atribuição ainda é parcial); ' +
      '<strong>Custo/lead</strong> = investimento Meta ÷ leads CRM do mês — aproximação enquanto o rastreamento não cobre 100% (detalhe na página Qualidade dos dados). ' +
      'Google Ads: "—" até existirem campanhas B2B. <strong>Parcial</strong> = mês corrente em andamento.';
  } else {
    // E-commerce: receitas atribuídas NUNCA somadas entre plataformas —
    // o bloco Total traz só o investimento (único número agregável).
    head = '<tr class="tg"><th></th>' +
      '<th colspan="5" class="gh gm">Meta Ads</th><th colspan="4" class="gh gg">Google Ads</th><th class="gh gt">Total</th></tr>' +
      '<tr><th>Mês</th><th class="r">Investimento</th><th class="r">Compras</th><th class="r">Receita</th><th class="r">ROAS</th><th class="r">CPA</th>' +
      '<th class="r">Investimento</th><th class="r">Conversões</th><th class="r">Valor</th><th class="r">ROAS</th>' +
      '<th class="r">Investimento</th></tr>';
    body = hist.map(h => {
      const m = h.meta || {}, g = h.google || {};
      const gOn = g.gasto != null;
      const roasM = (m.gasto || 0) > 0 ? (m.valor_compras || 0) / m.gasto : null;
      const cpaM = (m.compras || 0) > 0 ? (m.gasto || 0) / m.compras : null;
      const roasG = gOn && (g.gasto || 0) > 0 ? (g.valor_conversoes || 0) / g.gasto : null;
      return '<tr>' + mesCell(h) +
        '<td class="r">' + fmt.currency(m.gasto || 0) + '</td>' +
        '<td class="r">' + fmt.num(m.compras || 0) + '</td>' +
        '<td class="r">' + fmt.currency(m.valor_compras || 0) + '</td>' +
        '<td class="r">' + fmt.roas(roasM) + '</td>' +
        '<td class="r">' + (cpaM == null ? '—' : fmt.currency(cpaM)) + '</td>' +
        '<td class="r">' + (gOn ? fmt.currency(g.gasto || 0) : '—') + '</td>' +
        '<td class="r">' + (gOn ? fmt.conv(g.conversoes || 0) : '—') + '</td>' +
        '<td class="r">' + (gOn ? fmt.currency(g.valor_conversoes || 0) : '—') + '</td>' +
        '<td class="r">' + fmt.roas(roasG) + '</td>' +
        '<td class="r">' + fmt.currency((m.gasto || 0) + (g.gasto || 0)) + '</td></tr>';
    }).join('');
    nota = 'Compras e receita da Meta: <strong>pixel</strong>; conversões e valor do Google: <strong>atribuição da plataforma</strong> — referência, não venda confirmada. ' +
      'As receitas das duas plataformas <strong>não se somam</strong> (atribuições independentes, podem se sobrepor) — o Total traz só o investimento. <strong>Parcial</strong> = mês corrente em andamento.';
  }
  return card('Histórico mensal', 'mês a mês — independe do filtro de período',
    '<div class="table-wrap"><table class="tbl-hist"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
    '<div class="note">' + nota + '</div>');
}

/* ---------- 5 · Onde está o resultado ---------- */
function otResultadoHtml(c) {
  const ce = c.ot.criativos_eficientes || [];
  const zr = c.ot.zero_retorno || { total_gasto: 0, itens: [] };
  const thumb32 = t => t
    ? '<img class="thumb xs" src="' + esc(t) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
    'onerror="this.style.display=&#39;none&#39;;this.nextElementSibling.style.display=&#39;flex&#39;"><div class="thumb-fb xs">▦</div>'
    : '<div class="thumb-fb xs" style="display:flex">▦</div>';
  const item = (i, valHtml) => {
    const plink = safeHttpUrl(i.permalink);
    const nome = plink
      ? '<a href="' + esc(plink) + '" target="_blank" rel="noopener">' + esc(i.anuncio) + '</a>'
      : esc(i.anuncio || '(sem nome)');
    return '<div class="ri">' + thumb32(i.thumbnail) +
      '<div class="ri-tx"><div class="ri-nm">' + nome + '</div>' +
      (i.campanha ? '<div class="ri-cp">' + esc(i.campanha) + '</div>' : '') +
      '<div class="ri-vl">' + valHtml + '</div></div></div>';
  };
  // Sem gasto, o custo por resultado é indefinido (não zero) — item fora do ranking.
  const ceComGasto = ce.filter(i => (i.gasto || 0) > 0);
  const col1 = card('🏆 Criativos mais eficientes', 'menor custo por resultado · toda a série',
    ceComGasto.length
      ? ceComGasto.slice(0, 6).map(i => {
        const res = i.resultado || i.resultado_fallback || 0;
        return item(i, '<span class="ok">' + fmt.currency(i.custo_por_resultado) + '/resultado · ' +
          fmt.num(res) + (res === 1 ? ' resultado' : ' resultados') + '</span>');
      }).join('')
      : emptyDashed('Nenhum criativo com gasto e resultado ainda.'));
  const col2 = card('🔥 Dinheiro sem retorno' + (zr.total_gasto > 0 ? ' — ' + fmt.currency(zr.total_gasto) : ''),
    'anúncios com gasto e zero resultado · toda a série',
    (zr.itens || []).length
      ? zr.itens.slice(0, 6).map(i => item(i, '<span class="bad">' + fmt.currency(i.gasto) + ' · zero resultado</span>')).join('')
      : emptyDashed('Nenhum anúncio com gasto e zero resultado.', 'Bom sinal — todo o gasto está gerando pelo menos um resultado.'));
  let col3;
  if (c.target > 0) {
    const cm = otCampanhas(c, false);
    col3 = card('⚠️ Campanhas fora da meta', 'custo/' + c.resNome + ' acima de ' + fmt.currency(c.target) + ' · toda a série',
      cm.fora.length
        ? cm.fora.slice().sort((a, b) => b.gasto - a.gasto).map(r =>
          '<div class="ri"><div class="ri-tx"><div class="ri-nm">' + esc(r.nome) + ' <span class="muted">(' + r.plat + ')</span></div>' +
          '<div class="ri-vl"><span class="bad">' + (r.custo == null ? 'sem resultados' : fmt.currency(r.custo) + '/' + c.resNome) + '</span>' +
          ' · ' + fmt.currency(r.gasto) + ' em jogo</div></div></div>').join('')
        : '<div class="ri"><div class="ri-tx"><div class="ri-vl"><span class="ok">Todas as campanhas com gasto estão dentro da meta.</span></div></div></div>');
  } else {
    col3 = card('⚠️ Campanhas fora da meta', 'requer meta de custo',
      emptyDashed('Defina a meta de custo para habilitar.',
        'Configure ' + c.varTarget + ' nas Variables do repositório — o painel passa a apontar as campanhas com custo por ' +
        c.resNome + ' acima da meta e o gasto em jogo.'));
  }
  return '<div class="grid-3">' + col1 + col2 + col3 + '</div>';
}

/* ---------- 6 · Qual ação tomar ---------- */
function otAcoesHtml(c) {
  const ci = c.ot.ciclo || {};
  const orcTotal = c.orcMeta + c.orcGoogle;
  const zr = c.ot.zero_retorno || { total_gasto: 0, itens: [] };
  const cards = [];
  const aCard = acaoCard;
  // B2B: o gargalo do atendimento também é dinheiro em jogo (leads pagos parados)
  if (c.front === 'b2b') {
    // Um alerta só (os grupos se sobrepõem): quem nunca falou com uma pessoa.
    const g = atendResumo();
    if (g && g.nuncaPessoa.length) {
      const nf = g.nuncaPessoa.filter(r => r.form).length;
      const din = g.cpl != null && nf ? g.cpl * nf : null;
      const esp24 = g.esperando1.filter(r => (r.idade || 0) > 24).length;
      const rob = g.nuncaPessoa.filter(r => r.s === 'R').length;
      cards.push(aCard('crit', 'Crítico', fmt.num(g.nuncaPessoa.length) + ' leads do período nunca falaram com uma pessoa' +
        (din ? ' — ' + fmt.currency(din) + ' investidos neles' : ''),
        fmt.num(g.esperando1.length) + ' escreveram e esperam a 1ª resposta (' + fmt.num(esp24) + ' há mais de 24 h) e ' +
        fmt.num(rob) + ' só receberam a boas-vindas do robô' +
        (din ? ' · ' + fmt.num(nf) + ' vieram do formulário, a ' + fmt.currency(g.cpl) + ' por lead (CPL do período)' : '') +
        '. Detalhe e próximos passos em Atendimento dos leads.'));
    }
  }
  if (zr.total_gasto > 0) {
    cards.push(aCard('crit', 'Crítico', fmt.currency(zr.total_gasto) + ' gastos sem nenhum resultado',
      fmt.num((zr.itens || []).length) + ' anúncio(s) com gasto e zero resultado em toda a série — pausar ou trocar o criativo. Lista na seção acima.'));
  }
  if (c.target > 0) {
    const cm = otCampanhas(c, false);
    cm.fora.slice().sort((a, b) => b.gasto - a.gasto).forEach(r => {
      cards.push(aCard('crit', 'Crítico', esc(r.nome) + ' (' + r.plat + ') fora da meta de custo',
        (r.custo == null ? 'Gasto sem nenhum resultado' : 'Custo por ' + c.resNome + ' de ' + fmt.currency(r.custo)) +
        ' — meta: até ' + fmt.currency(c.target) + ' · ' + fmt.currency(r.gasto) + ' em jogo.'));
    });
    if (cm.dentro.length) {
      cards.push(aCard('ok', 'Na meta', fmt.num(cm.dentro.length) + ' campanha(s) dentro da meta de custo',
        cm.dentro.map(r => esc(r.nome) + ' (' + fmt.currency(r.custo) + '/' + c.resNome + ')').join(' · ')));
    }
  }
  if (orcTotal > 0) {
    const proj = ci.projecao_mes || 0;
    if (proj > orcTotal) {
      const diasRest = Math.max(0, (ci.dias_no_mes || 0) - (ci.dias_passados || 0));
      const rd = diasRest > 0 ? Math.max(0, orcTotal - (ci.gasto_total || 0)) / diasRest : null;
      cards.push(aCard('crit', 'Crítico', 'Projeção do mês estoura o orçamento',
        'Projeção de ' + fmt.currency(proj) + ' contra ' + fmt.currency(orcTotal) + ' de orçamento' +
        (rd == null ? '.' : ' — reduzir o ritmo para até ' + fmt.currency(rd) + '/dia nos ' + fmt.num(diasRest) + ' dias restantes.')));
    } else {
      cards.push(aCard('ok', 'Na meta', 'Projeção do mês cabe no orçamento',
        'Projeção de ' + fmt.currency(proj) + ' contra ' + fmt.currency(orcTotal) + ' de orçamento do mês.'));
    }
  }
  if (!(c.target > 0) && !(orcTotal > 0)) {
    cards.push(aCard('info', 'Configurar', 'Defina metas e orçamentos para habilitar os alertas',
      'Configure nas Variables do repositório: <strong>' + c.varsOrc + '</strong> (orçamento mensal por plataforma) e <strong>' +
      c.varTarget + '</strong> (meta de custo por ' + c.resNome + '). Com isso o painel prioriza os alertas por dinheiro em jogo — ' +
      'campanhas fora da meta e projeção × orçamento.'));
  }
  if (!cards.length) {
    cards.push(aCard('ok', 'Na meta', 'Nenhum alerta no momento', 'Nada crítico detectado com as metas e orçamentos atuais.'));
  }
  return '<div class="actions">' + cards.join('') + '</div>';
}

/* ---------- Página inteira ---------- */
function renderOtimizacao(el, front) {
  const c = otCfg(front);
  const p = otPeriodo(c);
  const dd = otDailyData(c);
  const b2b = front === 'b2b';
  let html = otHeaderHtml(front);
  if (b2b) html += secNavHtml(OT_SECOES_B2B);
  html += secTitle('Controle de investimento', 'ciclo mensal e distribuição do gasto', 'sec-investimento');
  html += otCicloHtml(c);
  html += secTitle('O que está acontecendo', 'volume e eficiência no período selecionado', 'sec-agora');
  html += otAgoraHtml(c, p);
  html += secTitle('Como está evoluindo', 'dia a dia do período selecionado', 'sec-evolucao');
  html += otEvolucaoHtml(c, dd);
  html += secTitle('Histórico mensal', 'mês a mês — independe do filtro', 'sec-historico');
  html += otHistHtml(c);
  html += secTitle('Onde está o resultado', 'e onde o dinheiro está parado', 'sec-resultado');
  html += otResultadoHtml(c);
  html += secTitle('Qual ação tomar', 'alertas priorizados por dinheiro em jogo', 'sec-acoes');
  html += otAcoesHtml(c);
  html += b2b ? otLegadoB2B() + atendHtml() + regiaoHtml() + tipoHtml() : otLegadoEcom();
  el.innerHTML = html;
  otCharts(c, dd);
  if (b2b) {
    secNavBind(el);
    atendCharts();
    regiaoCharts();
    tipoCharts();
  }
}
const OT_SECOES_B2B = [
  ['sec-investimento', 'Investimento'], ['sec-agora', 'Período'], ['sec-evolucao', 'Evolução'],
  ['sec-historico', 'Histórico'], ['sec-resultado', 'Resultado'], ['sec-acoes', 'Ações'],
  ['sec-detalhe', 'Funil e origens'], ['sec-atendimento', 'Atendimento dos leads'],
  ['sec-regiao', 'Estados e DDDs'], ['sec-tipo', 'Tipo de negócio']
];

/* ============================================================
   B2B · VISÃO GERAL — dashboard de otimização + detalhe da frente
   (funil, origens e qualidade de atendimento preservados abaixo)
   ============================================================ */
function renderVisaoB2B(el) { renderOtimizacao(el, 'b2b'); }

function otLegadoB2B() {
  const L = fdays((DATA.leads || {}).daily);
  const leadsPagos = sum(L, 'pagos');
  const mbDaily = fdays((DATA.meta_b2b || {}).daily);
  const invest = sum(mbDaily, 'gasto');
  const leadsPlat = sum(mbDaily, 'leads_plat');
  const deals = ((DATA.crm || {}).deals_minimal || []).filter(d => inPeriod(d.criado_em));
  const vendas = deals.filter(d => d.ganho).length;
  const perdidos = deals.filter(d => d.perdido).length;
  const cpl = (invest > 0 && leadsPagos > 0) ? invest / leadsPagos : null;
  const cobEf = (DATA.utm || {}).cobertura_efetiva || {};

  let html = secTitle('Detalhe da frente', 'funil e origem dos leads', 'sec-detalhe');
  html += '<div class="kpis cols-4">' +
    kpi('CPL (CRM)', cpl == null ? null : fmt.currency(cpl),
      cpl == null ? 'sem leads pagos no período*' : 'investimento ÷ leads pagos do CRM*', { teal: true }) +
    kpi('Leads plataforma', fmt.num(leadsPlat), 'reportado pela plataforma (referência) · no período') +
    kpi('Vendas', fmt.num(vendas), 'no período') +
    kpi('Perdidos', fmt.num(perdidos), 'no período') +
    '</div>';

  html += '<div class="note-blue">* <strong>CPL (CRM)</strong> = investimento nas campanhas de leads B2B (meta_b2b) ÷ leads do CRM ' +
    'atribuídos ao tráfego pago por <strong>origem efetiva</strong> (UTM, planilha do formulário ou tag do formulário no Kommo). ' +
    'Cobertura efetiva: <strong>' + fmt.pct(cobEf.pct, 0) + '</strong> dos leads têm atribuição — o CPL descreve essa fatia rastreada, não o total. ' +
    'E-commerce e impulsionamento ficam no painel E-commerce.</div>';

  const fp = funnelPeriodStages();
  html += card('Funil B2B — visão do período',
    'leads criados no período, pela etapa ATUAL de cada um · etapas de ganho/perda são terminais',
    fp.total ? funnelHtml(fp) : emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));

  // ----- Leads por origem (efetiva) — vem pronto em leads.by_source -----
  const srcRows = ((DATA.leads || {}).by_source || []).map(r =>
    '<tr><td class="name">' + esc(r.fonte) + '</td>' +
    '<td class="r">' + fmt.num(r.leads) + '</td></tr>').join('');
  html += card('Leads por origem (efetiva)',
    'origem efetiva = UTM do lead, casamento com a planilha do formulário <strong>ou</strong> tag do formulário no Kommo · foto atual da base — não usa o filtro',
    srcRows
      ? tableWrap([{ t: 'Origem (efetiva)' }, { t: 'Leads', r: 1 }], srcRows) +
      '<div class="note">Cobertura efetiva: <strong>' + fmt.pct(cobEf.pct, 0) + '</strong> — ' +
      fmt.num(cobEf.com_atribuicao) + ' de ' + fmt.num(cobEf.total) + ' leads com atribuição ' +
      '(' + esc(cobEf.nota || 'UTM ou planilha do formulário') + '). Detalhe completo na página Rastreamento (UTM).</div>'
      : emptyDashed('Nenhuma origem efetiva registrada na base.'));

  // A antiga "Qualidade de atendimento por responsável" media o 1º atendimento
  // pela troca de etapa — que o Kommo faz sozinho ao criar o lead (dava 0% sem
  // atendimento). Agora a tabela por responsável mede pelas mensagens, na
  // seção "Atendimento dos leads" logo abaixo.
  return html;
}

/* ---------- De onde vêm os leads (DDD do telefone no CRM) ----------
   crm_regiao.daily = [{dia, ddd, form, direto}] · ddd "" = sem DDD válido.
   O estado é exato (cada DDD pertence a um só estado); a "cidade" é a
   cidade-polo da área do DDD — o Kommo não tem campo de cidade.
   form = tag do formulário do anúncio no Kommo · direto = entrou sem ela. */
const REGIAO_TOP_UF = 10;
const REGIAO_TOP_DDD = 12;
function regiaoResumo() {
  const R = DATA.crm_regiao;
  if (!R || !Array.isArray(R.daily)) return null;
  const ddds = dict(R.ddds), ufs = dict(R.ufs);
  const area = R.area_atendida || [];
  const porUf = Object.create(null), porDdd = Object.create(null);
  let total = 0, semDdd = 0, dentro = 0, foraDireto = 0;
  fdays(R.daily).forEach(r => {
    const f = r.form || 0, dr = r.direto || 0, n = f + dr;
    total += n;
    const info = r.ddd ? ddds[r.ddd] : null;
    if (!info) { semDdd += n; return; }
    const u = porUf[info.uf] || (porUf[info.uf] = { form: 0, direto: 0 });
    u.form += f; u.direto += dr;
    const d = porDdd[r.ddd] || (porDdd[r.ddd] = { form: 0, direto: 0 });
    d.form += f; d.direto += dr;
    if (area.indexOf(info.uf) >= 0) dentro += n; else foraDireto += dr;
  });
  const nomeUf = k => (ufs[k] || {}).nome || k;
  const ordena = (m, nome) => Object.keys(m)
    .map(k => ({ k, form: m[k].form, direto: m[k].direto, n: m[k].form + m[k].direto }))
    .sort((a, b) => (b.n - a.n) || nome(a.k).localeCompare(nome(b.k), 'pt-BR'));
  return {
    area, ddds, ufs, nomeUf, total, semDdd, dentro, foraDireto,
    fora: total - semDdd - dentro,
    canais: R.canais !== false,
    naArea: uf => area.indexOf(uf) >= 0,
    ufRows: ordena(porUf, nomeUf),
    dddRows: ordena(porDdd, k => k)
  };
}
function listaPt(arr) {
  return arr.length > 1 ? arr.slice(0, -1).join(', ') + ' e ' + arr[arr.length - 1] : arr.join('');
}
function regiaoHtml() {
  let html = secTitle('De onde vêm os leads', 'estado e área de DDD do telefone · leads criados no período', 'sec-regiao');
  const g = regiaoResumo();
  if (!g) return html + card('', '', emptyDashed('A origem geográfica dos leads ainda não está nesta versão dos dados.', 'Aparece na próxima atualização do painel.'));
  if (!g.total) return html + card('', '', emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));
  const comDdd = g.total - g.semDdd;
  if (!comDdd) return html + card('', '', emptyDashed('Nenhum lead do período tem telefone com DDD brasileiro válido.', 'Sem telefone, número do exterior ou número inválido no Kommo.'));
  const areaTxt = esc(listaPt(g.area));
  html += '<div class="kpis cols-4">' +
    kpi('Leads no período', fmt.num(g.total), g.semDdd ? fmt.num(comDdd) + ' com DDD válido' : 'todos com DDD válido') +
    kpi('Na área atendida', comDdd ? fmt.pct(g.dentro / comDdd * 100) : null, fmt.num(g.dentro) + ' em ' + areaTxt) +
    kpi('Fora da área', fmt.num(g.fora), g.canais && g.fora ? fmt.num(g.foraDireto) + ' entraram direto, sem formulário' : 'outros estados') +
    kpi('Estados de origem', fmt.num(g.ufRows.length), fmt.num(g.dddRows.length) + ' DDDs diferentes') +
    '</div>';

  const canalHead = g.canais ? [{ t: 'Formulário', r: 1 }, { t: 'Direto', r: 1 }] : [];
  const canalCells = r => g.canais ? '<td class="r">' + fmt.num(r.form) + '</td><td class="r">' + fmt.num(r.direto) + '</td>' : '';
  const ufRel = g.ufRows.map(r =>
    '<tr><td class="name">' + esc(g.nomeUf(r.k)) + ' (' + esc(r.k) + ')</td>' +
    '<td class="peri">' + esc((g.ufs[r.k] || {}).regiao || '—') + '</td>' +
    '<td class="r">' + fmt.num(r.n) + '</td><td class="r">' + fmt.pct(r.n / g.total * 100) + '</td>' + canalCells(r) +
    '<td>' + (g.naArea(r.k) ? 'sim' : '<span class="muted">não</span>') + '</td></tr>').join('');
  const dddRel = g.dddRows.map(r => {
    const i = g.ddds[r.k] || {};
    return '<tr><td class="name">' + esc(r.k) + '</td><td>' + esc(i.area || '—') + '</td>' +
      '<td class="peri">' + esc(i.uf || '—') + '</td>' +
      '<td class="r">' + fmt.num(r.n) + '</td><td class="r">' + fmt.pct(r.n / g.total * 100) + '</td>' + canalCells(r) + '</tr>';
  }).join('');
  const canalNota = g.canais
    ? ' <strong>Formulário</strong> = lead com a tag do formulário do anúncio no Kommo · <strong>direto</strong> = entrou sem formulário (WhatsApp).'
    : ' Separação formulário × direto indisponível nesta versão dos dados.';
  const semDddNota = g.semDdd ? ' ' + fmt.num(g.semDdd) + ' lead(s) sem DDD válido (sem telefone, número do exterior ou inválido) ficam fora dos gráficos.' : '';

  html += '<div class="grid-2">' +
    chartCard('Leads por estado', 'top ' + REGIAO_TOP_UF + ' · rótulo = leads · % do período', 'ch-reg-uf', 'xtall',
      '<div class="note">Estados com nome em cinza ficam fora da área atendida no atacado (' + areaTxt + ').' + canalNota + semDddNota + '</div>' +
      reliefTable([{ t: 'Estado' }, { t: 'Região' }, { t: 'Leads', r: 1 }, { t: '% do período', r: 1 }].concat(canalHead).concat([{ t: 'Área atendida' }]), ufRel)) +
    chartCard('Leads por área de DDD', 'top ' + REGIAO_TOP_DDD + ' · cidade-polo do DDD', 'ch-reg-ddd', 'xtall',
      '<div class="note">O Kommo não tem campo de cidade: o DDD mostra a <strong>área</strong> (ex.: 19 = Campinas, Piracicaba, Limeira e região), não a cidade exata do lead. A área completa aparece ao passar o mouse e na tabela.</div>' +
      reliefTable([{ t: 'DDD' }, { t: 'Área do DDD' }, { t: 'UF' }, { t: 'Leads', r: 1 }, { t: '% do período', r: 1 }].concat(canalHead), dddRel)) +
    '</div>';
  return html;
}
function regiaoCharts() {
  const g = regiaoResumo();
  if (!g || !g.total || !g.ufRows.length) return;
  const ufItens = g.ufRows.slice(0, REGIAO_TOP_UF).map(r => ({
    lab: g.nomeUf(r.k), titulo: g.nomeUf(r.k) + ' (' + r.k + ')', ufs: [r.k], form: r.form, direto: r.direto
  }));
  const resto = g.ufRows.slice(REGIAO_TOP_UF);
  if (resto.length) {
    ufItens.push({
      lab: 'Outros ' + resto.length + ' estados',
      titulo: resto.map(r => r.k + ' ' + fmt.num(r.n)).join(' · '),
      ufs: resto.map(r => r.k),
      form: resto.reduce((a, r) => a + r.form, 0),
      direto: resto.reduce((a, r) => a + r.direto, 0)
    });
  }
  const dddItens = g.dddRows.slice(0, REGIAO_TOP_DDD).map(r => {
    const i = g.ddds[r.k] || {};
    return { lab: r.k + ' · ' + (i.polo || '?'), titulo: 'DDD ' + r.k + ' · ' + (i.area || '?') + ' (' + (i.uf || '?') + ')', ufs: [i.uf], form: r.form, direto: r.direto };
  });
  regiaoBarras('ch-reg-uf', ufItens, g, true);
  regiaoBarras('ch-reg-ddd', dddItens, g, false);
}
/* Barras horizontais empilhadas por canal (mostarda = formulário, terracota =
   direto — mesma cor nos dois gráficos) · total rotulado na ponta · eixo com o
   nome em cinza quando a categoria fica fora da área atendida. */
function regiaoBarras(id, itens, g, comPct) {
  // raio numérico em pilha: o Chart.js só arredonda a ponta externa da pilha
  const seg = { stack: 'reg', borderColor: P.bgCard, borderWidth: 2, borderRadius: 3, borderSkipped: 'left', maxBarThickness: 24 };
  const datasets = g.canais
    ? [barDs('Formulário do anúncio', itens.map(i => i.form), S.mostarda, seg),
      barDs('Direto (WhatsApp)', itens.map(i => i.direto), S.terracota, seg)]
    : [barDs('Leads', itens.map(i => i.form + i.direto), S.terracota, seg)];
  const tot = i => itens[i].form + itens[i].direto;
  const dentro = it => it.ufs.every(u => g.naArea(u));
  makeChart(id, {
    type: 'bar',
    data: { labels: itens.map(i => i.lab), datasets },
    options: baseOpts({
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      // folga fixa à direita para o rótulo da ponta (a % de grace sozinha
      // não basta quando o card fica estreito)
      layout: { padding: { right: comPct ? 46 : 22 } },
      plugins: {
        legend: g.canais ? legendTop() : { display: false },
        directLabels: {
          mode: 'total',
          format: (v, i) => fmt.num(v) + (comPct ? ' · ' + fmt.pct(v / g.total * 100, 0) : '')
        },
        tooltip: {
          callbacks: {
            title: items => itens[items[0].dataIndex].titulo,
            footer: items => {
              const i = items[0].dataIndex;
              return ['Total: ' + fmt.num(tot(i)) + ' leads · ' + fmt.pct(tot(i) / g.total * 100) + ' do período']
                .concat(dentro(itens[i]) ? [] : ['fora da área atendida']);
            }
          }
        }
      },
      scales: {
        x: yCount({ position: 'bottom', stacked: true, grace: '8%', ticks: { maxRotation: 0, minRotation: 0, precision: 0 } }),
        y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, color: c => dentro(itens[c.index] || { ufs: [] }) ? P.soft : P.muted } }
      }
    })
  });
}

/* ---------- Atendimento dos leads (DATA.atendimento_leads) ----------
   Uma linha por lead (sem dado pessoal) com a situação da conversa na última
   atualização e os tempos de resposta. O Kommo não grava quem enviou cada
   mensagem do WhatsApp: robô × pessoa sai do tempo (regras no ETL).
   Período = dia de criação do lead. */
/* Situação de exibição: o "E" do ETL (lead escreveu por último) vira E1
   (nunca teve resposta de uma pessoa — pendência certa) ou E2 (já conversou;
   a última mensagem é do lead — pode ser pergunta ou só um "obrigado"). */
const SITUACOES = [
  { k: 'E1', nome: 'Esperando a 1ª resposta', desc: 'o lead escreveu e ninguém da equipe respondeu até agora' },
  { k: 'E2', nome: 'Escreveu de novo, sem retorno', desc: 'já conversou com a equipe e a última mensagem é do lead — pode ser uma pergunta ou só um "obrigado"' },
  { k: 'P', nome: 'Lead parou de responder', desc: 'a equipe falou por último e o lead não voltou' },
  { k: 'R', nome: 'Só o robô falou', desc: 'o lead não respondeu a boas-vindas automática e ninguém da equipe escreveu' },
  { k: 'N', nome: 'Sem conversa', desc: 'nenhuma mensagem registrada no Kommo' }
];
const IDADES_SITUACAO = [
  { nome: 'até 24 h', max: 24 }, { nome: '1 a 3 dias', max: 72 },
  { nome: '3 a 7 dias', max: 168 }, { nome: 'mais de 7 dias', max: Infinity }
];
const FAIXAS_RESPOSTA = [
  { nome: 'até 15 min', max: 0.25 }, { nome: '15 a 60 min', max: 1 }, { nome: '1 a 4 h', max: 4 },
  { nome: '4 a 24 h', max: 24 }, { nome: 'mais de 24 h', max: Infinity }, { nome: 'sem resposta', max: null }
];
function medianaDe(vals) {
  const v = vals.filter(x => x != null).sort((a, b) => a - b);
  return v.length ? quantile(v, 0.5) : null;
}
function fmtHoras(h) { return h == null ? '—' : fmt.mins(h * 60); }
function fmtGerado(iso) {
  return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + ' às ' + iso.slice(11, 16) : '—';
}
function faixaResposta(r) {
  if (r.hr == null) return FAIXAS_RESPOSTA.length - 1;
  return FAIXAS_RESPOSTA.findIndex(f => f.max != null && r.hr <= f.max);
}
function idadeIdx(h) { return IDADES_SITUACAO.findIndex(f => (h || 0) <= f.max); }
function atendResumo() {
  const A = DATA.atendimento_leads;
  if (!A || !Array.isArray(A.linhas) || !Array.isArray(A.colunas)) return null;
  const ix = Object.create(null);
  A.colunas.forEach((c, i) => { ix[c] = i; });
  const tipos = A.tipos || [], etapas = A.etapas || [], resps = A.responsaveis || [];
  const rows = A.linhas.filter(r => inPeriod(r[ix.dia])).map(r => {
    const t = tipos[r[ix.tipo]] || {};
    const s = r[ix.situacao];
    return {
      s: s === 'E' ? (r[ix.h_1o_contato_humano] == null ? 'E1' : 'E2') : s,
      form: r[ix.canal] === 'f', etapa: etapas[r[ix.etapa]] || '?',
      tipo: t.nome || 'Não informado', foraPublico: !!t.fora_do_publico,
      resp: resps[r[ix.responsavel]] || 'Sem responsável',
      h1: r[ix.h_1o_contato_humano], hr: r[ix.h_1a_resposta_humana],
      continuou: r[ix.continuou] === 1, escreveu: r[ix.escreveu] === 1,
      tent: r[ix.tentativas] || 0, idade: r[ix.h_na_situacao], janela: r[ix.janela_aberta] === 1,
      hora: r[ix.hora_chegada], dsem: r[ix.dia_semana_chegada]
    };
  });
  // CPL do período = a mesma conta do KPI "CPL (CRM)": investimento Meta B2B ÷ leads pagos
  const invest = sum(fdays((DATA.meta_b2b || {}).daily), 'gasto');
  const pagos = sum(fdays((DATA.leads || {}).daily), 'pagos');
  const abertos = rows.filter(r => r.s !== 'F');
  return {
    A, rows, abertos,
    cpl: invest > 0 && pagos > 0 ? invest / pagos : null,
    nuncaPessoa: abertos.filter(r => r.h1 == null),
    esperando1: abertos.filter(r => r.s === 'E1'),
    semRetorno: abertos.filter(r => r.s === 'E2'),
    antesDaJanela: !!A.desde && FILTER.start < A.desde
  };
}
function velocidade(rows) {
  const n = FAIXAS_RESPOSTA.map(() => 0), c = FAIXAS_RESPOSTA.map(() => 0);
  rows.filter(r => r.escreveu).forEach(r => { const f = faixaResposta(r); n[f]++; if (r.continuou) c[f]++; });
  return { n, c };
}
function atendHtml() {
  let html = secTitle('Atendimento dos leads', 'como está, quanto custa e quanto dá para melhorar', 'sec-atendimento');
  const g = atendResumo();
  if (!g) return html + card('', '', emptyDashed('O atendimento dos leads ainda não está nesta versão dos dados.', 'Aparece na próxima atualização do painel.'));
  if (!g.rows.length) return html + card('', '', emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));
  const R = g.rows, N = R.length;
  const falou = R.filter(r => r.h1 != null).length;
  const escreveram = R.filter(r => r.escreveu);
  const respondidos = escreveram.filter(r => r.hr != null);
  const medResp = medianaDe(respondidos.map(r => r.hr));
  const ate1h = respondidos.filter(r => r.hr <= 1).length;
  const E = g.esperando1, E2 = g.semRetorno;
  const e24 = E.filter(r => (r.idade || 0) > 24).length;
  const eFech = E.filter(r => !r.janela).length;
  const P = g.abertos.filter(r => r.s === 'P');
  const p1 = P.filter(r => r.tent <= 1);
  const rob = g.abertos.filter(r => r.s === 'R').length;
  const nuncaForm = g.nuncaPessoa.filter(r => r.form).length;
  const dinheiro = g.cpl != null ? g.cpl * nuncaForm : null;
  const conversaram = g.abertos.filter(r => r.escreveu);
  const presos = conversaram.filter(r => /contato inicial/i.test(r.etapa)).length;
  const fechados = N - g.abertos.length;

  html += '<div class="note-blue">Situação das conversas em <strong>' + esc(fmtGerado(g.A.gerado_em)) + '</strong> (última atualização) dos <strong>' +
    fmt.num(N) + ' leads criados no período</strong>. O Kommo não registra quem enviou cada mensagem do WhatsApp: ' +
    'a boas-vindas automática (até 1 min depois da entrada do lead) e as respostas do agente de IA, nos períodos em que ele esteve ligado, não contam como resposta da equipe.' +
    (g.antesDaJanela ? ' Leads criados antes de ' + fmt.dateFull(g.A.desde) + ' ficam de fora: o histórico de mensagens coletado do Kommo cobre os últimos meses.' : '') + '</div>';

  html += '<div class="kpis cols-6">' +
    kpi('Falaram com uma pessoa', fmt.pct(falou / N * 100, 0),
      fmt.num(g.nuncaPessoa.length) + ' leads em aberto nunca receberam mensagem da equipe') +
    kpi('1ª resposta da equipe', medResp == null ? null : fmtHoras(medResp),
      medResp == null ? 'nenhum lead que escreveu foi respondido no período'
        : 'mediana, desde a 1ª mensagem do lead · ' + fmt.pct(ate1h / respondidos.length * 100, 0) + ' respondidos em até 1 h') +
    kpi('Esperando a 1ª resposta', fmt.num(E.length),
      'escreveram e ninguém respondeu · ' + fmt.num(e24) + ' há mais de 24 h · ' + fmt.num(eFech) + ' só aceitam template') +
    kpi('Escreveram de novo, sem retorno', fmt.num(E2.length),
      'já conversaram; a última mensagem é do lead — vale conferir') +
    kpi('Pararam após 1 tentativa', fmt.num(p1.length),
      'de ' + fmt.num(P.length) + ' conversas em que a equipe falou por último') +
    kpi('Investido em leads sem atendimento', dinheiro == null ? null : fmt.currency(dinheiro),
      dinheiro == null ? 'sem CPL no período (sem investimento ou sem leads pagos)'
        : fmt.num(nuncaForm) + ' leads do formulário nunca falaram com uma pessoa · CPL ' + fmt.currency(g.cpl)) +
    '</div>';

  // ----- situação × há quanto tempo + velocidade × conversa -----
  const sits = SITUACOES.filter(s => s.k !== 'N' || g.abertos.some(r => r.s === 'N'));
  const sitRel = sits.map(s => {
    const L = g.abertos.filter(r => r.s === s.k);
    return '<tr><td class="name">' + s.nome + '</td><td class="dim">' + s.desc + '</td><td class="r">' + fmt.num(L.length) + '</td>' +
      IDADES_SITUACAO.map((f, i) => '<td class="r">' + fmt.num(L.filter(r => idadeIdx(r.idade) === i).length) + '</td>').join('') +
      '<td class="r">' + fmt.num(L.filter(r => !r.janela).length) + '</td></tr>';
  }).join('');
  const vel = velocidade(R);
  const velRel = FAIXAS_RESPOSTA.map((f, i) => '<tr><td>' + f.nome + '</td><td class="r">' + fmt.num(vel.n[i]) + '</td>' +
    '<td class="r">' + (f.max == null ? '—' : fmt.num(vel.c[i])) + '</td>' +
    '<td class="r">' + (f.max == null || !vel.n[i] ? '—' : fmt.pct(vel.c[i] / vel.n[i] * 100, 0)) + '</td></tr>').join('');
  html += '<div class="grid-2">' +
    chartCard('Situação das conversas', 'leads em aberto do período · há quanto tempo estão assim', 'ch-at-situacao', 'tall',
      '<div class="note">' + (fechados ? fmt.num(fechados) + ' lead(s) já fechados (ganho ou perdido) ficam fora desta conta. ' : '') +
      '<strong>Só template</strong> = passaram 24 h desde a última mensagem do lead (ou ele nunca escreveu): o WhatsApp só aceita modelo aprovado.</div>' +
      reliefTable([{ t: 'Situação' }, { t: 'O que significa' }, { t: 'Leads', r: 1 }]
        .concat(IDADES_SITUACAO.map(f => ({ t: f.nome, r: 1 }))).concat([{ t: 'Só template', r: 1 }]), sitRel)) +
    multiChartCard('Velocidade da resposta × conversa',
      'leads que escreveram no período · acima: quantos, pela espera até a 1ª resposta da equipe · abaixo: % que voltou a escrever depois dessa resposta',
      'ch-at-vel-n', 'ch-at-vel-taxa',
      '<div class="note">Em terracota, quem escreveu e ainda não teve resposta da equipe.</div>' +
      reliefTable([{ t: 'Espera até a 1ª resposta' }, { t: 'Leads', r: 1 }, { t: 'Continuaram', r: 1 }, { t: '% continuou', r: 1 }], velRel)) +
    '</div>';

  // ----- quanto dá para melhorar (só com dado do próprio período) -----
  const nRap = vel.n[0] + vel.n[1], cRap = vel.c[0] + vel.c[1];
  const taxaRap = nRap >= 10 ? cRap / nRap : null;
  const taxaLen = vel.n[4] >= 10 ? vel.c[4] / vel.n[4] : null;
  const itens = [];
  if (taxaRap != null) {
    let potencial = vel.n[5] * taxaRap, baseLenta = vel.n[5];
    [2, 3, 4].forEach(f => {
      baseLenta += vel.n[f];
      if (vel.n[f]) potencial += vel.n[f] * Math.max(0, taxaRap - vel.c[f] / vel.n[f]);
    });
    itens.push('Quando a equipe responde em <strong>até 1 h</strong>, <strong>' + fmt.pct(taxaRap * 100, 0) + '</strong> dos leads continuam a conversa' +
      (taxaLen != null ? '; quando a resposta passa de <strong>24 h</strong>, só <strong>' + fmt.pct(taxaLen * 100, 0) + '</strong>.' : '.') +
      ' <span class="muted">(' + fmt.num(nRap) + ' leads respondidos em até 1 h' + (taxaLen != null ? ' · ' + fmt.num(vel.n[4]) + ' depois de 24 h' : '') + ')</span>');
    if (baseLenta > 0) {
      itens.push('Se os <strong>' + fmt.num(baseLenta) + ' leads</strong> que esperaram mais de 1 h ou ficaram sem resposta tivessem sido atendidos em até 1 h, ' +
        'seriam cerca de <strong>' + fmt.num(Math.round(potencial)) + ' conversas a mais</strong> no período ' +
        '<span class="muted">(estimativa com a taxa de quem é respondido em até 1 h)</span>.');
    }
  } else {
    itens.push('Ainda não há leads suficientes respondidos em até 1 h no período para medir o efeito da velocidade (mínimo de 10). Amplie o período no topo.');
  }
  if (g.nuncaPessoa.length) {
    itens.push('<strong>' + fmt.num(g.nuncaPessoa.length) + ' leads</strong> em aberto nunca falaram com uma pessoa' +
      (dinheiro != null && nuncaForm ? ' — <strong>' + fmt.currency(dinheiro) + '</strong> investidos nos ' + fmt.num(nuncaForm) + ' que vieram do formulário.' : '.'));
  }
  if (conversaram.length) {
    itens.push('<strong>' + fmt.num(presos) + ' de ' + fmt.num(conversaram.length) + '</strong> leads que já escreveram seguem em <strong>Contato inicial</strong> — sem a etapa atualizada, o funil do CRM não mostra o avanço real.');
  }
  const hor = g.A.horario_atendimento || [6, 18];
  const slotNomes = ['Seg a sex, das ' + hor[0] + 'h às ' + hor[1] + 'h', 'Seg a sex, fora desse horário', 'Sábado e domingo'];
  const slotDe = r => r.dsem >= 5 ? 2 : (r.hora >= hor[0] && r.hora < hor[1] ? 0 : 1);
  const slotRows = slotNomes.map((nome, i) => {
    const L = escreveram.filter(r => slotDe(r) === i);
    const resp = L.filter(r => r.hr != null);
    return '<tr><td class="name">' + nome + '</td><td class="r">' + fmt.num(L.length) + '</td>' +
      '<td class="r">' + fmtHoras(medianaDe(resp.map(r => r.hr))) + '</td>' +
      '<td class="r">' + (L.length ? fmt.pct(resp.filter(r => r.hr <= 1).length / L.length * 100, 0) : '—') + '</td>' +
      '<td class="r">' + fmt.num(L.length - resp.length) + '</td></tr>';
  }).join('');
  html += '<div class="grid-2">' +
    card('Quanto dá para melhorar', 'o que os próprios dados do período mostram',
      '<ul class="lista-leitura">' + itens.map(t => '<li>' + t + '</li>').join('') + '</ul>') +
    card('Quando os leads escrevem', 'hora da 1ª mensagem do lead × espera pela 1ª resposta da equipe',
      tableWrap([{ t: 'Chegada' }, { t: 'Leads', r: 1 }, { t: '1ª resposta (mediana)', r: 1 },
        { t: 'Respondidos em até 1 h', r: 1 }, { t: 'Sem resposta', r: 1 }], slotRows) +
      '<div class="note">Horário da equipe: ' + hor[0] + 'h às ' + hor[1] + 'h em dias úteis, como aparece nas mensagens (ajustável em HORARIO_ATENDIMENTO). A espera é em horas corridas.</div>') +
    '</div>';

  // ----- o que fazer agora -----
  const acoes = [];
  if (E.length) {
    acoes.push(acaoCard('crit', 'Agora', 'Responder os ' + fmt.num(E.length) + ' leads que esperam a 1ª resposta',
      'Escreveram e ninguém da equipe respondeu. ' + fmt.num(e24) + ' esperam há mais de 24 h. ' + fmt.num(eFech) +
      ' já passaram da janela de 24 h do WhatsApp e só podem receber <strong>template aprovado</strong>; ' +
      'os outros ' + fmt.num(E.length - eFech) + ' ainda aceitam mensagem normal.'));
  }
  if (E2.length) {
    acoes.push(acaoCard('info', 'Conferir', 'Abrir as ' + fmt.num(E2.length) + ' conversas em que o lead escreveu por último',
      'Já conversaram com a equipe, mas a última mensagem é do lead e ficou sem retorno. Pode ser uma pergunta pendente ou só um agradecimento — vale abrir no Kommo e responder o que for pergunta.'));
  }
  if (p1.length) {
    acoes.push(acaoCard('info', 'Follow-up', 'Voltar a procurar ' + fmt.num(p1.length) + ' leads que pararam depois de 1 tentativa',
      'A equipe mandou mensagem, o lead não respondeu e ninguém tentou de novo. ' + fmt.num(p1.filter(r => !r.janela).length) + ' deles só aceitam template.'));
  }
  if (rob) {
    acoes.push(acaoCard('info', '1º contato', 'Fazer o 1º contato humano com ' + fmt.num(rob) + ' leads que só receberam a boas-vindas do robô',
      'Não responderam a mensagem automática e ninguém da equipe escreveu depois. Como nunca escreveram, o contato precisa ser por template aprovado.'));
  }
  if (presos) {
    acoes.push(acaoCard('info', 'CRM', 'Atualizar a etapa de ' + fmt.num(presos) + ' leads que já conversaram',
      'Eles escreveram e continuam em Contato inicial. Com a etapa certa, o funil e as taxas do painel passam a mostrar o avanço real.'));
  }
  if (!acoes.length) {
    acoes.push(acaoCard('ok', 'Em dia', 'Nenhuma pendência de atendimento no período', 'Todos os leads do período estão com a conversa em dia.'));
  }
  html += '<div class="sub-sec">O que fazer agora</div><div class="actions">' + acoes.join('') + '</div>';

  // ----- por responsável + lista nominal (só com login) -----
  const porResp = Object.create(null);
  R.forEach(r => { (porResp[r.resp] = porResp[r.resp] || []).push(r); });
  const respRows = Object.keys(porResp).sort((a, b) => porResp[b].length - porResp[a].length).map(k => {
    const L = porResp[k], resp = L.filter(r => r.hr != null), ab = L.filter(r => r.s !== 'F');
    return '<tr><td class="name">' + esc(k) + '</td><td class="r">' + fmt.num(L.length) + '</td>' +
      '<td class="r">' + fmt.pct(L.filter(r => r.h1 != null).length / L.length * 100, 0) + '</td>' +
      '<td class="r">' + fmtHoras(medianaDe(resp.map(r => r.hr))) + '</td>' +
      '<td class="r">' + fmt.num(ab.filter(r => r.s === 'E1').length) + '</td>' +
      '<td class="r">' + fmt.num(ab.filter(r => r.h1 == null).length) + '</td>' +
      '<td class="r">' + fmt.num(L.filter(r => /ganho/i.test(r.etapa)).length) + '</td>' +
      '<td class="r">' + fmt.num(L.filter(r => /perdido/i.test(r.etapa)).length) + '</td></tr>';
  }).join('');
  const lista = g.A.lista_esperando || { disponivel: false };
  const listaRows = lista.disponivel === true ? (lista.itens || []).map(i => {
    const link = safeHttpUrl(i.link);
    return '<tr><td class="name">' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(i.nome) + '</a>' : esc(i.nome)) + '</td>' +
      '<td>' + esc(i.telefone) + '</td><td class="peri">' + esc(i.tipo) + '</td>' +
      '<td>' + (i.nunca_respondido ? '1ª resposta' : '<span class="muted">sem retorno</span>') + '</td>' +
      '<td class="r">' + fmtHoras(i.espera_h) + '</td>' +
      '<td>' + (i.janela_aberta ? 'aberta' : '<span class="muted">só template</span>') + '</td></tr>';
  }).join('') : '';
  html += '<div class="grid-2">' +
    card('Atendimento por responsável', 'leads criados no período · medido pelas mensagens',
      tableWrap([{ t: 'Responsável' }, { t: 'Leads', r: 1 }, { t: 'Falaram com pessoa', r: 1 }, { t: '1ª resposta (mediana)', r: 1 },
        { t: 'Esperando 1ª resposta', r: 1 }, { t: 'Nunca procurados', r: 1 }, { t: 'Ganhos', r: 1 }, { t: 'Perdidos', r: 1 }], respRows) +
      '<div class="note">Responsável = dono do lead no Kommo. A 1ª resposta é medida desde a 1ª mensagem do lead, em horas corridas.</div>') +
    card('Quem está esperando', 'primeiro quem nunca foi respondido, depois quem espera há mais tempo · até 50 · todos os períodos',
      listaRows
        ? tableWrap([{ t: 'Lead' }, { t: 'Telefone' }, { t: 'Tipo de negócio' }, { t: 'Espera' }, { t: 'Há', r: 1 }, { t: 'Janela 24 h' }], listaRows)
        : emptyDashed('Lista nominal indisponível por enquanto.', esc(lista.motivo || 'Nenhum lead esperando a equipe.'))) +
    '</div>';
  return html;
}
function atendCharts() {
  const g = atendResumo();
  if (!g || !g.rows.length) return;
  const sits = SITUACOES.filter(s => s.k !== 'N' || g.abertos.some(r => r.s === 'N'));
  // idade = ordinal → rampa âmbar; no fundo escuro, mais tempo = mais claro (salta mais)
  const cores = [AMBER_RAMP[4], AMBER_RAMP[3], AMBER_RAMP[2], AMBER_RAMP[1]];
  const seg = { stack: 'at', borderColor: P.bgCard, borderWidth: 2, borderRadius: 3, borderSkipped: 'left', maxBarThickness: 26 };
  makeChart('ch-at-situacao', {
    type: 'bar',
    data: {
      labels: sits.map(s => s.nome),
      datasets: IDADES_SITUACAO.map((f, i) => barDs(f.nome,
        sits.map(s => g.abertos.filter(r => r.s === s.k && idadeIdx(r.idade) === i).length), cores[i], seg))
    },
    options: baseOpts({
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      layout: { padding: { right: 22 } },
      plugins: {
        legend: legendTop(),
        directLabels: { mode: 'total', format: v => fmt.num(v) },
        tooltip: { callbacks: { footer: items => 'Total: ' + fmt.num(items.reduce((a, it) => a + (it.raw || 0), 0)) + ' leads' } }
      },
      scales: {
        x: yCount({ position: 'bottom', stacked: true, grace: '8%', ticks: { maxRotation: 0, minRotation: 0, precision: 0 } }),
        y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, color: P.soft } }
      }
    })
  });
  const vel = velocidade(g.rows);
  const labels = FAIXAS_RESPOSTA.map(f => f.nome);
  makeChart('ch-at-vel-n', {
    type: 'bar',
    data: { labels, datasets: [barDs('Leads', vel.n, FAIXAS_RESPOSTA.map(f => f.max == null ? S.terracota : S.mostarda))] },
    options: baseOpts({
      plugins: {
        directLabels: { mode: 'all', format: fmt.num },
        tooltip: { callbacks: { label: it => ' ' + fmt.num(it.raw) + ' leads' } }
      },
      scales: { x: xCat({ ticks: { display: false } }), y: lockYWidth(yCount({ grace: '22%', ticks: { precision: 0 } }), 44) }
    })
  });
  const taxas = FAIXAS_RESPOSTA.map((f, i) => f.max != null && vel.n[i] > 0 ? Math.round(vel.c[i] / vel.n[i] * 1000) / 10 : null);
  makeChart('ch-at-vel-taxa', {
    type: 'bar',
    data: { labels, datasets: [barDs('% continuou a conversa', taxas, S.oliva)] },
    options: baseOpts({
      plugins: {
        directLabels: { mode: 'all', format: v => fmt.pct(v, 0) },
        tooltip: { callbacks: { label: it => ' ' + fmt.pct(it.raw, 0) + ' continuaram · ' + fmt.num(vel.c[it.dataIndex]) + ' de ' + fmt.num(vel.n[it.dataIndex]) } }
      },
      scales: {
        x: xCat(),
        y: lockYWidth(yCount({ min: 0, max: 115, ticks: { stepSize: 25, callback: v => v <= 100 ? v + '%' : '' } }), 44)
      }
    })
  });
}

/* ---------- Quem são os leads (tipo de negócio do formulário) ---------- */
function tipoResumo(g) {
  const por = Object.create(null);
  g.rows.forEach(r => { (por[r.tipo] = por[r.tipo] || { nome: r.tipo, fora: r.foraPublico, L: [] }).L.push(r); });
  const grupo = t => t.nome === 'Não informado' ? 2 : t.fora ? 1 : 0;
  return Object.keys(por).map(k => por[k])
    .sort((a, b) => (grupo(a) - grupo(b)) || (b.L.length - a.L.length) || a.nome.localeCompare(b.nome, 'pt-BR'));
}
function tipoHtml() {
  let html = secTitle('Quem são os leads', 'tipo de negócio informado no formulário · leads criados no período', 'sec-tipo');
  const g = atendResumo();
  if (!g) return html + card('', '', emptyDashed('O tipo de negócio ainda não está nesta versão dos dados.', 'Aparece na próxima atualização do painel.'));
  if (!g.rows.length) return html + card('', '', emptyDashed('Nenhum lead criado no período selecionado.', 'Ajuste o filtro de período no topo.'));
  const tipos = tipoResumo(g), N = g.rows.length;
  const informados = tipos.filter(t => t.nome !== 'Não informado');
  const nInf = informados.reduce((a, t) => a + t.L.length, 0);
  const maior = informados.filter(t => !t.fora).sort((a, b) => b.L.length - a.L.length)[0];
  const nFora = informados.filter(t => t.fora).reduce((a, t) => a + t.L.length, 0);
  html += '<div class="kpis cols-3">' +
    kpi('Com tipo de negócio', fmt.pct(nInf / N * 100, 0), fmt.num(nInf) + ' de ' + fmt.num(N) + ' leads · quem entra direto pelo WhatsApp não informa') +
    kpi('Maior grupo', maior ? fmt.pct(maior.L.length / N * 100, 0) : null,
      maior ? esc(maior.nome) + ' · ' + fmt.num(maior.L.length) + ' leads' : 'nenhum tipo informado no período') +
    kpi('Fora do público do atacado', fmt.num(nFora), 'se declararam consumidor final (ou são leads de teste)') +
    '</div>';
  const linhas = tipos.map(t => {
    const L = t.L, escreveram = L.filter(r => r.escreveu), resp = escreveram.filter(r => r.hr != null);
    return '<tr><td class="name">' + esc(t.nome) + (t.fora ? ' <span class="badge gray">fora do público</span>' : '') + '</td>' +
      '<td class="r">' + fmt.num(L.length) + '</td>' +
      '<td class="r">' + fmt.pct(L.length / N * 100, 0) + '</td>' +
      '<td class="r">' + fmt.pct(escreveram.length / L.length * 100, 0) + '</td>' +
      '<td class="r">' + fmt.pct(L.filter(r => r.h1 != null).length / L.length * 100, 0) + '</td>' +
      '<td class="r">' + fmtHoras(medianaDe(resp.map(r => r.hr))) + '</td>' +
      '<td class="r">' + (resp.length ? fmt.pct(resp.filter(r => r.continuou).length / resp.length * 100, 0) : '—') + '</td>' +
      '<td class="r">' + fmt.num(L.filter(r => /ganho/i.test(r.etapa)).length) + '</td></tr>';
  }).join('');
  html += '<div class="grid-2">' +
    chartCard('Leads por tipo de negócio', 'rótulo = leads · % do período', 'ch-tipo', 'xtall',
      '<div class="note">O tipo vem da resposta do formulário do anúncio (campo "Tipo de Negócio" do contato no Kommo). Quem entra direto pelo WhatsApp aparece como Não informado.</div>') +
    card('Como cada tipo de negócio se comporta', 'leads criados no período',
      tableWrap([{ t: 'Tipo' }, { t: 'Leads', r: 1 }, { t: '% do período', r: 1 }, { t: 'Escreveram', r: 1 }, { t: 'Falaram com pessoa', r: 1 },
        { t: '1ª resposta (mediana)', r: 1 }, { t: 'Continuaram', r: 1 }, { t: 'Ganhos', r: 1 }], linhas) +
      '<div class="note"><strong>Escreveram</strong> = mandaram ao menos uma mensagem · <strong>Continuaram</strong> = voltaram a escrever depois da 1ª resposta da equipe (% dos que foram respondidos).</div>') +
    '</div>';
  return html;
}
function tipoCharts() {
  const g = atendResumo();
  if (!g || !g.rows.length) return;
  const tipos = tipoResumo(g), N = g.rows.length;
  const cinza = t => !!t && (t.fora || t.nome === 'Não informado');
  const seg = { stack: 'tp', borderRadius: 4, borderSkipped: 'left', maxBarThickness: 24 };
  makeChart('ch-tipo', {
    type: 'bar',
    data: {
      labels: tipos.map(t => t.nome),
      datasets: [
        barDs('Público do atacado', tipos.map(t => cinza(t) ? null : t.L.length), S.terracota, seg),
        barDs('Fora do público ou não informado', tipos.map(t => cinza(t) ? t.L.length : null), P.muted, seg)
      ]
    },
    options: baseOpts({
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      layout: { padding: { right: 46 } },
      plugins: {
        legend: legendTop(),
        directLabels: { mode: 'total', format: v => fmt.num(v) + ' · ' + fmt.pct(v / N * 100, 0) },
        tooltip: {
          filter: it => it.raw != null,
          callbacks: { label: it => ' ' + fmt.num(it.raw) + ' leads · ' + fmt.pct(it.raw / N * 100, 0) + ' do período' }
        }
      },
      scales: {
        x: yCount({ position: 'bottom', stacked: true, grace: '8%', ticks: { maxRotation: 0, minRotation: 0, precision: 0 } }),
        y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, color: c => cinza(tipos[c.index]) ? P.muted : P.soft } }
      }
    })
  });
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

  let html = '<div class="kpis cols-5">' +
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

  let html = banner('blue', 'Os tempos de resposta medem a espera por uma <strong>pessoa</strong> — o robô (resposta em &lt; 0,5 min) é contado à parte e excluído das medianas.');

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

  let html = banner('blue', 'Esta página cobre <strong>somente as campanhas de leads B2B</strong> (frente meta_b2b). ' +
    'As campanhas de e-commerce estão no painel E-commerce, e o impulsionamento na página Institucional &amp; Impulsionamento (painel E-commerce). ' +
    'Cliques, CTR e CPC usam <strong>cliques no link</strong> (link clicks) — não o total de cliques do anúncio.');

  // Banner de matching lead ↔ anúncio (planilha do formulário + UTM)
  const mt = meta.matching || null;
  if (mt && mt.leads_pagos_meta != null) {
    html += banner('blue', 'Casamento lead ↔ anúncio no nível <strong>' + esc(mt.nivel || 'campanha + criativo') + '</strong>: ' +
      '<strong>' + fmt.num(mt.leads_pagos_meta) + '</strong> leads pagos identificados no CRM — ' +
      '<strong>' + fmt.num(mt.via_formulario) + '</strong> via planilha do formulário, ' +
      '<strong>' + fmt.num(mt.via_utm) + '</strong> via UTM e ' +
      '<strong>' + fmt.num(mt.via_tag || 0) + '</strong> pela tag do formulário no Kommo (só campanha — a tag não diz o anúncio) · cobertura de ' +
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
  let html = '';

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

  let html = '<div class="note-blue">Visão mensal completa da frente B2B — <strong>não usa o filtro de período do topo</strong>. ' +
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

  let html = banner('blue', 'Cobertura de parametrização dos leads do CRM. Esta página retrata a <strong>foto atual da base</strong> e <strong>não usa o filtro de período</strong>.');

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
   QUALIDADE DOS DADOS (compartilhada) — central dos avisos âmbar
   (relatorio.alertas) + cobertura de rastreamento como tiles.
   ============================================================ */
function renderQualidade(el, front) {
  const alertas = (DATA.relatorio && DATA.relatorio.alertas) || [];
  const utm = DATA.utm || {};
  const cob = utm.cobertura || null;
  const cobEf = utm.cobertura_efetiva || null;

  let html = banner('blue', 'Central de qualidade dos dados: tudo que <strong>limita a leitura</strong> dos números dos painéis mora aqui — ' +
    'com o que fazer para destravar cada ponto. Foto atual da base — <strong>não usa o filtro de período</strong>.' +
    (front === 'ecom'
      ? ' Os avisos descrevem a base compartilhada (CRM, atendimento e rastreamento, coletados na frente B2B) — mas impactam a confiança dos números nos dois painéis.'
      : ''));

  // ----- Tiles de cobertura de rastreamento -----
  const utmLink = front === 'b2b'
    ? 'detalhe na página <a href="#b2b/utm">Rastreamento (UTM)</a>'
    : 'detalhe no painel B2B → <a href="#b2b/utm">Rastreamento (UTM)</a>';
  if (cob || cobEf) {
    html += '<div class="kpis cols-3">' +
      (cob ? kpi('Cobertura de UTM', fmt.pct(cob.pct, 1),
        fmt.num(cob.com_utm) + ' de ' + fmt.num(cob.total) + ' leads chegam com UTM · foto atual da base', { teal: true }) : '') +
      (cobEf ? kpi('Cobertura efetiva', fmt.pct(cobEf.pct, 1),
        fmt.num(cobEf.com_atribuicao) + ' de ' + fmt.num(cobEf.total) + ' leads com atribuição (' +
        esc(cobEf.nota || 'UTM ou planilha do formulário') + ')', { teal: true }) : '') +
      kpi('Observações abertas', fmt.num(alertas.length), 'avisos de qualidade vindos do ETL — lista abaixo') +
      '</div>';
  }

  // ----- Um card por aviso -----
  if (alertas.length) {
    html += alertas.map(a => {
      const m = alertMeta(a.tipo);
      return '<div class="card q-card">' +
        '<div class="q-head"><span class="q-ic">⚠</span><h3>' + esc(m.titulo) + '</h3></div>' +
        '<p class="q-text">' + esc(a.texto) + '</p>' +
        '<div class="q-do"><strong>O que fazer:</strong> ' + esc(m.fazer) + '</div>' +
        '</div>';
    }).join('');
  } else {
    html += card('Avisos de qualidade', 'vindos do ETL a cada atualização',
      emptyDashed('Nenhuma observação de qualidade aberta.', 'Quando o ETL detectar algo que limite a leitura dos números, o aviso aparece aqui.'));
  }

  html += '<div class="note">Cobertura de rastreamento: ' + utmLink + '. Os avisos são gerados automaticamente pelo ETL a cada atualização — somem daqui quando o problema é resolvido na origem.</div>';

  el.innerHTML = html;
}

/* ============================================================
   E-COMMERCE · VISÃO GERAL — CENTRAL DO E-COMMERCE
   Hierarquia: NEGÓCIO → VENDAS → AQUISIÇÃO → FUNIL → PRODUTOS →
   MÍDIA → DIAGNÓSTICOS.
   Regra de atribuição (crítica): compras/receita do pixel Meta e
   conversões/valor do Google são atribuídos POR PLATAFORMA e NUNCA
   somados como "receita total" — o único agregável é o investimento.
   Tudo que depende da loja/GA4 fica em ESTADO PREPARADO, sem simulação.
   ============================================================ */

/* Direção por métrica: 'up' = subir é bom (verde) · 'down' = subir é
   ruim (vermelho) · 'neutral' = sem juízo (investimento). */
const METRIC_DIR = {
  invest: 'neutral', compras: 'up', conversoes: 'up', receita: 'up',
  roas: 'up', cliques: 'up', ctr: 'up', cpa: 'down', cpc: 'down', cpm: 'down'
};

/* ---------- séries diárias da frente numa janela ----------
   Dia DENTRO da série do e-commerce sem linha = 0 (sem veiculação); dia FORA
   da série (antes do 1º / depois do último dado) = null, nunca R$ 0,00.
   Google indisponível = séries do Google null (o total usa só a Meta). */
function ecvDaily(a, b) {
  const g = DATA.google_ecom || {};
  const gOk = g.disponivel === true && !!g.daily;
  const bd = ecomBounds();
  const me = fdaysR((DATA.meta_ecom || {}).daily, a, b);
  const gd = gOk ? fdaysR(g.daily, a, b) : [];
  const days = dayRange(a, b);
  const cov = days.map(d => d >= bd.min && d <= bd.max);
  const ix = (rows, f, ok) => { const m = dayIdx(rows, f); return days.map((d, i) => (ok && cov[i]) ? (m[d] || 0) : null); };
  const gastoM = ix(me, 'gasto', true), comprasM = ix(me, 'compras', true), recM = ix(me, 'valor_compras', true);
  const cliM = ix(me, 'cliques_link', true), impM = ix(me, 'impressoes', true);
  const gastoG = ix(gd, 'gasto', gOk), convG = ix(gd, 'conversoes', gOk), recG = ix(gd, 'valor_conversoes', gOk), cliG = ix(gd, 'cliques', gOk);
  const ratio = (num, den) => days.map((d, i) => (num[i] != null && den[i] > 0) ? num[i] / den[i] : null);
  return {
    days, gOk, gastoM, comprasM, recM, cliM, impM, gastoG, convG, recG, cliG,
    investTot: days.map((d, i) => (gastoM[i] == null && gastoG[i] == null) ? null : (gastoM[i] || 0) + (gastoG[i] || 0)),
    roasM: ratio(recM, gastoM), roasG: ratio(recG, gastoG),
    cpaM: ratio(gastoM, comprasM), cpaG: ratio(gastoG, convG)
  };
}
/* ---------- totais da frente numa janela ---------- */
function ecvTotals(a, b) {
  const g = DATA.google_ecom || {};
  const gOk = g.disponivel === true && !!g.daily;
  const me = fdaysR((DATA.meta_ecom || {}).daily, a, b);
  const gd = gOk ? fdaysR(g.daily, a, b) : [];
  const t = {
    gOk,
    gastoM: sum(me, 'gasto'), comprasM: sum(me, 'compras'), recM: sum(me, 'valor_compras'),
    cliM: sum(me, 'cliques_link'), impM: sum(me, 'impressoes'),
    gastoG: sum(gd, 'gasto'), convG: sum(gd, 'conversoes'), recG: sum(gd, 'valor_conversoes'),
    cliG: sum(gd, 'cliques'), impG: sum(gd, 'impressoes')
  };
  t.invest = t.gastoM + t.gastoG;
  t.roasM = t.gastoM > 0 ? t.recM / t.gastoM : null;
  t.roasG = t.gastoG > 0 ? t.recG / t.gastoG : null;
  t.cpaM = t.comprasM > 0 ? t.gastoM / t.comprasM : null;
  t.cpaG = t.convG > 0 ? t.gastoG / t.convG : null;
  t.ctrM = t.impM > 0 ? t.cliM / t.impM * 100 : null;
  t.ctrG = t.impG > 0 ? t.cliG / t.impG * 100 : null;
  return t;
}
function pctDelta(cur, prev) {
  if (cur == null || prev == null || !(prev > 0)) return null;
  return (cur - prev) / prev * 100;
}
/* Seta/cor com a direção correta por métrica (mapa METRIC_DIR).
   nota = motivo quando não há base (ex.: comparação fora da série). */
function deltaHtml(cur, prev, dirKey, hasComp, nota) {
  if (!hasComp) return '';
  const dir = METRIC_DIR[dirKey] || 'neutral';
  if (cur == null || prev == null) return '<div class="xd nt">' + (nota || 'sem base de comparação') + '</div>';
  if (!(prev > 0)) {
    // base zero (ex.: ROAS 0,00× = gasto sem receita): sem % e sem "novo"
    return cur > 0 ? '<div class="xd nt">saiu de 0 <span>base zero, sem %</span></div>' : '<div class="xd nt">0 nos dois períodos</div>';
  }
  const d = (cur - prev) / prev * 100;
  const flat = Math.abs(d) < 0.05;
  const arrow = flat ? '•' : (d > 0 ? '▲' : '▼');
  let cls = 'nt';
  if (!flat && dir !== 'neutral') cls = ((d > 0) === (dir === 'up')) ? 'gd' : 'bd';
  return '<div class="xd ' + cls + '">' + arrow + ' ' + (d > 0 ? '+' : '') + fmt.dec(d, 1) +
    '% <span>vs comp.</span></div>';
}

/* ---------- cards executivos (valor + variação + sparkline) ---------- */
let ECV_SPARKS = [];
function xkpi(label, valueHtml, delta, sub, spark) {
  let sparkHtml = '';
  // linha precisa de ≥ 2 pontos: com 1 dia (Hoje/Ontem) o canvas ficaria em branco
  if (spark && spark.vals && spark.vals.filter(v => v != null).length >= 2 && spark.vals.some(v => v != null && v !== 0)) {
    const id = 'sp-' + (ECV_SPARKS.length + 1);
    ECV_SPARKS.push({ id, vals: spark.vals, color: spark.color || P.accentLight });
    sparkHtml = '<canvas class="xspark" id="' + id + '"></canvas>';
  }
  return '<div class="xkpi">' +
    '<div class="xk-lb">' + label + '</div>' +
    '<div class="xk-vl">' + (valueHtml == null ? '<span class="xk-null">—</span>' : valueHtml) + '</div>' +
    (delta || '') + sparkHtml +
    (sub ? '<div class="xk-sub">' + sub + '</div>' : '') + '</div>';
}
function xkpiPrep(label, formula, dep) {
  return '<div class="xkpi prep">' +
    '<div class="xk-lb">' + label + '</div>' +
    '<div class="xk-vl"><span class="xk-null">—</span></div>' +
    '<div class="xk-sub">' + formula + '</div>' +
    '<div class="xk-dep">depende de: ' + dep + '</div></div>';
}
/* Sparkline: mini-canvas sem eixos, últimos dias do período filtrado */
function drawSparks() {
  ECV_SPARKS.forEach(s => {
    const c = document.getElementById(s.id);
    if (!c) return;
    const W = c.clientWidth || 160, H = c.clientHeight || 26;
    c.width = W * 2; c.height = H * 2;
    const ctx = c.getContext('2d');
    ctx.scale(2, 2);
    const vals = s.vals;
    const pts = vals.map((v, i) => ({ i, v })).filter(p => p.v != null);
    if (pts.length < 2) return;
    let min = Infinity, max = -Infinity;
    pts.forEach(p => { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
    if (max === min) max = min + 1;
    const x = i => vals.length > 1 ? i / (vals.length - 1) * (W - 4) + 2 : W / 2;
    const y = v => H - 3 - (v - min) / (max - min) * (H - 6);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (v == null) { started = false; return; }
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(x(last.i), y(last.v), 2, 0, Math.PI * 2);
    ctx.fill();
  });
}
/* Redesenha as sparklines quando a largura dos cards muda (rotação no
   celular, janela redimensionada, breakpoint): ResizeObserver com debounce
   na grade de cards. Um observador por render — o anterior é desconectado,
   e ele se desconecta sozinho quando a grade sai da página (anti-leak). */
let ECV_SPARK_RO = null, ECV_SPARK_RESIZE = null;
function wireSparkResize(host) {
  if (ECV_SPARK_RO) { ECV_SPARK_RO.disconnect(); ECV_SPARK_RO = null; }
  if (!host || !ECV_SPARKS.length) return;
  let t = null, lastW = host.clientWidth;
  const redraw = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (host.isConnected && document.querySelector('canvas.xspark')) drawSparks();
    }, 120);
  };
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!host.isConnected) { ro.disconnect(); if (ECV_SPARK_RO === ro) ECV_SPARK_RO = null; return; }
      const w = host.clientWidth;
      if (w === lastW) return;
      lastW = w;
      redraw();
    });
    ro.observe(host);
    ECV_SPARK_RO = ro;
  } else if (!ECV_SPARK_RESIZE) {                 // navegador sem ResizeObserver
    ECV_SPARK_RESIZE = () => { if (CURRENT_FRONT === 'ecom' && ECV_SPARKS.length) drawSparks(); };
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(ECV_SPARK_RESIZE, 150); });
  }
}

/* ---------- tabelas ordenáveis client-side ----------
   th[data-k]="num"|"txt" · células numéricas com data-s ·
   linhas .row-prep (canais preparados) ficam sempre no fim. */
function sortableWrap(headCells, rowsHtml, extraCls) {
  return '<div class="table-wrap"><table class="sortable' + (extraCls ? ' ' + extraCls : '') + '"><thead><tr>' +
    headCells.map(h => '<th' + (h.r ? ' class="r"' : '') + (h.k ? ' data-k="' + h.k + '"' : '') + '>' + h.t + '</th>').join('') +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function tdNum(v, f, cls) {
  return '<td class="r' + (cls ? ' ' + cls : '') + '" data-s="' + (v == null ? '' : v) + '">' +
    (v == null ? '—' : f(v)) + '</td>';
}
function wireSortables(root) {
  root.querySelectorAll('table.sortable').forEach(tbl => {
    tbl.querySelectorAll('th[data-k]').forEach(th => {
      th.addEventListener('click', () => {
        const desc = !th.classList.contains('s-desc');   // 1º clique = desc
        tbl.querySelectorAll('th').forEach(x => x.classList.remove('s-asc', 's-desc'));
        th.classList.add(desc ? 's-desc' : 's-asc');
        const idx = th.cellIndex, kind = th.dataset.k, sign = desc ? -1 : 1;
        const tb = tbl.tBodies[0];
        const rows = Array.from(tb.rows);
        const prep = rows.filter(r => r.classList.contains('row-prep'));
        const data = rows.filter(r => !r.classList.contains('row-prep'));
        const val = r => {
          const cell = r.cells[idx];
          if (!cell) return null;
          if (kind === 'num') {
            const v = cell.dataset.s;
            return (v === '' || v == null) ? null : parseFloat(v);
          }
          return (cell.dataset.s != null ? cell.dataset.s : cell.textContent).trim().toLowerCase();
        };
        data.sort((ra, rb) => {
          const va = val(ra), vb = val(rb);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;                      // nulos sempre no fim
          if (vb == null) return -1;
          return (va < vb ? -1 : va > vb ? 1 : 0) * sign;
        });
        data.concat(prep).forEach(r => tb.appendChild(r));
      });
    });
  });
}

/* ---------- gráfico Evolução (métrica a escolher + comparação) ---------- */
function ecvEvoChart(dd, ddPrev) {
  const M = ECOM_EVO_METRIC;
  // [rótulo, série, cor, indisponível?] por métrica — sempre por plataforma,
  // receitas nunca somadas (atribuição separada).
  const mk = d => {
    if (M === 'invest') return [['Investimento Meta', d.gastoM, S.terracota], ['Investimento Google', d.gastoG, GOOGLE_INV, !d.gOk]];
    if (M === 'compras') return [['Compras (Meta)', d.comprasM, S.oliva], ['Conversões (Google)', d.convG, GOOGLE_RES, !d.gOk]];
    if (M === 'receita') return [['Receita atrib. Meta', d.recM, S.mostarda], ['Receita atrib. Google', d.recG, AMBER_RAMP[1], !d.gOk]];
    if (M === 'roas') return [['ROAS Meta', d.roasM, S.mostarda], ['ROAS Google', d.roasG, GOOGLE_RES, !d.gOk]];
    return [['CPA Meta', d.cpaM, S.terracota], ['Custo/conv. Google', d.cpaG, GOOGLE_INV, !d.gOk]];
  };
  const money = (M === 'invest' || M === 'receita' || M === 'cpa');
  const NEUTRAL = ['#8B7A64', '#5E5142'];               // período comparado — tons neutros
  const datasets = [];
  mk(dd).forEach(s => {
    if (s[3]) return;
    datasets.push(lineDs(s[0], s[1], s[2], { pointRadius: 2, spanGaps: false }));
  });
  let compDays = null;
  if (ddPrev) {
    compDays = ddPrev.days;
    mk(ddPrev).forEach((s, i) => {
      if (s[3]) return;
      // alinhado por índice de dia (1º dia com 1º dia do período comparado)
      const arr = dd.days.map((d2, j) => j < s[1].length ? s[1][j] : null);
      datasets.push({
        label: s[0] + ' — comparado', data: arr,
        borderColor: NEUTRAL[i % NEUTRAL.length], backgroundColor: 'transparent',
        borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4,
        tension: .3, spanGaps: false, __comp: true
      });
    });
  }
  // contagens via fmt.conv: conversões do Google podem ser fracionárias (2,7)
  const fmtVal = v => M === 'roas' ? fmt.dec(v, 2) + '×' : (money ? fmt.currency(v) : fmt.conv(v));
  makeChart('ch-ecv-evo', {
    type: 'line',
    data: { labels: dd.days.map(fmt.date), datasets },
    options: baseOpts({
      plugins: {
        legend: legendTop(),
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return ctx.dataset.label + ': sem dado';
              let t = ctx.dataset.label + ': ' + fmtVal(v);
              if (ctx.dataset.__comp && compDays && compDays[ctx.dataIndex]) {
                t += ' (' + fmt.dateFull(compDays[ctx.dataIndex]) + ')';
              }
              return t;
            }
          }
        }
      },
      scales: {
        x: xDaily(),
        y: money ? yMoney() : (M === 'roas'
          ? yCount({ ticks: { callback: v => fmt.dec(v, 1) + '×' } })
          : yCount())
      }
    })
  });
}

/* ---------- tabela executiva diária (busca + ordenação + paginação + CSV) ---------- */
function ecvDailyTable(dd) {
  // Google indisponível → colunas do Google null ("—" na tela, vazio no CSV),
  // nunca R$ 0,00 inventado; o total passa a ser só a Meta (nota abaixo).
  const rows = dd.days.map((d, i) => {
    const investM = dd.gastoM[i], investG = dd.gastoG[i];
    return {
      d, invest: (investM == null && investG == null) ? null : (investM || 0) + (investG || 0), investM, investG,
      compras: dd.comprasM[i], recM: dd.recM[i],
      conv: dd.convG[i], recG: dd.recG[i],
      cpaM: (investM != null && dd.comprasM[i] > 0) ? investM / dd.comprasM[i] : null,
      roasM: investM > 0 ? dd.recM[i] / investM : null,
      roasG: investG > 0 ? dd.recG[i] / investG : null
    };
  });
  const stt = { page: 0, q: '', k: 'd', dir: -1 };       // padrão: data desc
  const PAGE = 20;
  const cols = [
    { k: 'd', t: 'Data', f: fmt.dateFull },
    { k: 'invest', t: 'Invest. total', f: fmt.currency },
    { k: 'investM', t: 'Invest. Meta', f: fmt.currency },
    { k: 'investG', t: 'Invest. Google', f: fmt.currency },
    { k: 'compras', t: 'Compras (Meta)', f: fmt.num },
    { k: 'recM', t: 'Receita atrib. Meta', f: fmt.currency },
    { k: 'conv', t: 'Conversões (Google)', f: fmt.conv },
    { k: 'recG', t: 'Receita atrib. Google', f: fmt.currency },
    { k: 'cpaM', t: 'CPA Meta', f: fmt.currency },
    { k: 'roasM', t: 'ROAS Meta', f: fmt.roas },
    { k: 'roasG', t: 'ROAS Google', f: fmt.roas }
  ];
  const filtered = () => {
    let out = rows;
    if (stt.q) out = out.filter(r => fmt.dateFull(r.d).indexOf(stt.q) >= 0);
    return out.slice().sort((ra, rb) => {
      const va = ra[stt.k], vb = rb[stt.k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * stt.dir;
    });
  };
  const draw = () => {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (stt.page >= pages) stt.page = pages - 1;
    const slice = list.slice(stt.page * PAGE, stt.page * PAGE + PAGE);
    const head = '<tr>' + cols.map(c2 =>
      '<th class="' + (c2.k === 'd' ? '' : 'r ') + 'th-sort' +
      (stt.k === c2.k ? (stt.dir === 1 ? ' s-asc' : ' s-desc') : '') +
      '" data-dk="' + c2.k + '">' + c2.t + '</th>').join('') + '</tr>';
    const body = slice.map(r => '<tr>' + cols.map(c2 => {
      const v = r[c2.k];
      const txt = c2.k === 'd' ? fmt.dateFull(v) : (v == null ? '—' : c2.f(v));
      return '<td' + (c2.k === 'd' ? '' : ' class="r"') + '>' + txt + '</td>';
    }).join('') + '</tr>').join('');
    const elT = document.getElementById('dt-table');
    const elP = document.getElementById('dt-pag');
    if (!elT || !elP) return;
    elT.innerHTML = '<div class="table-wrap"><table><thead>' + head + '</thead><tbody>' +
      (body || '<tr><td colspan="' + cols.length + '" class="dim">Nenhum dia encontrado para a busca.</td></tr>') +
      '</tbody></table></div>';
    elP.innerHTML =
      '<button type="button" id="dt-prev"' + (stt.page === 0 ? ' disabled' : '') + '>‹ Anterior</button>' +
      '<span>página ' + (stt.page + 1) + ' de ' + pages + ' · ' + fmt.num(list.length) + ' dia(s)</span>' +
      '<button type="button" id="dt-next"' + (stt.page >= pages - 1 ? ' disabled' : '') + '>Próxima ›</button>';
    document.getElementById('dt-prev').addEventListener('click', () => { if (stt.page > 0) { stt.page--; draw(); } });
    document.getElementById('dt-next').addEventListener('click', () => { if (stt.page < pages - 1) { stt.page++; draw(); } });
    elT.querySelectorAll('th[data-dk]').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.dk;
      if (stt.k === k) stt.dir = -stt.dir; else { stt.k = k; stt.dir = -1; }
      draw();
    }));
  };
  const q = document.getElementById('dt-q');
  if (q) q.addEventListener('input', ev2 => { stt.q = ev2.target.value.trim(); stt.page = 0; draw(); });
  const csv = document.getElementById('dt-csv');
  if (csv) csv.addEventListener('click', () => {
    const list = filtered();
    // Padrão do Excel em português: separador ";" e decimal ",". Com "," como
    // separador o Excel pt-BR abre tudo na coluna A; com ";" + ponto decimal
    // ele leria 32.66 como texto/data. Sem separador de milhar.
    const n2 = v => v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ',');
    const busca = stt.q ? stt.q.replace(/[;"\r\n]/g, ' ') : '';
    const lines = [
      '# Terrana E-commerce — tabela executiva diária · período ' +
      fmt.dateFull(FILTER.ecom.start) + ' a ' + fmt.dateFull(FILTER.ecom.end) +
      (busca ? ' · filtrado pela busca "' + busca + '": ' + list.length + ' de ' + rows.length + ' dia(s)' : ''),
      '# Separador: ponto e vírgula · decimais com vírgula (padrão do Excel em português) · datas em dd/mm/aaaa · ' +
      'receitas atribuídas por cada plataforma — NÃO somar Meta + Google' +
      (dd.gOk ? '' : ' · Google Ads sem dados: colunas do Google vazias e investimento total = só Meta'),
      'data;investimento_total;investimento_meta;investimento_google;compras_meta;' +
      'receita_atrib_meta;conversoes_google;receita_atrib_google;cpa_meta;roas_meta;roas_google'
    ];
    list.forEach(r => lines.push([
      fmt.dateFull(r.d), n2(r.invest), n2(r.investM), n2(r.investG), n2(r.compras),
      n2(r.recM), n2(r.conv), n2(r.recG), n2(r.cpaM), n2(r.roasM), n2(r.roasG)
    ].join(';')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'terrana-ecom-diario_' + FILTER.ecom.start + '_' + FILTER.ecom.end + '.csv';
    document.body.appendChild(a);
    a.click();
    // revogar só depois: com 0 ms o Firefox/Safari podem cancelar o download
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  });
  draw();
}

/* ---------- insights matemáticos (FATO sempre · HIPÓTESE prudente) ---------- */
function ecvInsightCard(kind, factHtml, hypoHtml) {
  return '<div class="ins-card ' + kind + '">' +
    '<div class="ins-line"><span class="ins-tag fato">FATO</span><span>' + factHtml + '</span></div>' +
    (hypoHtml ? '<div class="ins-line"><span class="ins-tag hipo">HIPÓTESE</span><span>possível causa a investigar: ' + hypoHtml + '</span></div>' : '') +
    '</div>';
}
function ecvInsights(cur, prev, st, comp) {
  const cards = [];
  const sig = v => (v > 0 ? '+' : '') + fmt.dec(v, 1) + '%';

  if (prev) {
    // investimento × compras (base zero = sem %: "saiu de 0" / "seguiu em 0")
    const dInv = pctDelta(cur.invest, prev.invest);
    const dCom = pctDelta(cur.comprasM, prev.comprasM);
    if (dInv != null || dCom != null) {
      const txtInv = dInv != null
        ? 'variou <strong>' + sig(dInv) + '</strong> (' + fmt.currency(prev.invest) + ' → ' + fmt.currency(cur.invest) + ')'
        : (cur.invest > 0 ? 'saiu de ' + fmt.currency(0) + ' para ' + fmt.currency(cur.invest) : 'seguiu em ' + fmt.currency(0));
      const txtCom = dCom != null
        ? 'variaram <strong>' + sig(dCom) + '</strong> (' + fmt.num(prev.comprasM) + ' → ' + fmt.num(cur.comprasM) + ')'
        : (cur.comprasM > 0 ? 'saíram de 0 para ' + fmt.num(cur.comprasM) : 'seguiram em 0');
      const fato = 'Investimento total ' + txtInv + ' e as compras (pixel Meta) ' + txtCom + '.';
      let kind = 'nt', hypo = null;
      if (dInv != null && dCom != null) {
        if (dInv > 5 && dCom < 0) { kind = 'neg'; hypo = 'fadiga de criativo ou leilão mais caro no período.'; }
        else if (dInv <= 0 && dCom > 0) { kind = 'pos'; }
      }
      cards.push(ecvInsightCard(kind, fato, hypo));
    }
    // ROAS por plataforma — ROAS comparado 0,00× (gasto sem receita) não tem
    // variação %: pctDelta devolve null e isso não pode virar "(0,0%)" verde.
    const roasCard = (nome, c, p, hypoTxt) => {
      if (c == null || p == null) return;
      const d = pctDelta(c, p);
      if (d == null) {
        cards.push(c > p
          ? ecvInsightCard('pos', nome + ' saiu de <strong>' + fmt.roas(p) + '</strong> para <strong>' + fmt.roas(c) + '</strong> (sem % — base zero).', null)
          : ecvInsightCard('nt', nome + ' seguiu em <strong>' + fmt.roas(c) + '</strong> nos dois períodos (gasto sem receita atribuída).', null));
        return;
      }
      const flat = Math.abs(d) < 0.05;
      cards.push(ecvInsightCard(flat ? 'nt' : (d > 0 ? 'pos' : 'neg'),
        nome + ' foi de <strong>' + fmt.roas(p) + '</strong> para <strong>' + fmt.roas(c) + '</strong> (' + sig(d) + ').',
        d < -15 ? hypoTxt : null));
    };
    roasCard('ROAS Meta (pixel)', cur.roasM, prev.roasM, 'mix de campanhas, criativo saturado ou sazonalidade.');
    if (cur.gOk) roasCard('ROAS Google (atribuição da plataforma)', cur.roasG, prev.roasG, 'termos/produtos do Shopping com pior conversão no período.');
    // CPA acima do limiar
    if (cur.cpaM != null && prev.cpaM != null) {
      const d = pctDelta(cur.cpaM, prev.cpaM);
      if (d > 20) {
        cards.push(ecvInsightCard('alerta',
          'CPA Meta subiu <strong>' + sig(d) + '</strong> — de ' + fmt.currency(prev.cpaM) + ' para ' + fmt.currency(cur.cpaM) + ' (acima do limiar de 20%).',
          'queda da taxa de conversão pós-clique ou aumento de CPM.'));
      } else if (d < -20) {
        cards.push(ecvInsightCard('pos',
          'CPA Meta caiu <strong>' + sig(d) + '</strong> — de ' + fmt.currency(prev.cpaM) + ' para ' + fmt.currency(cur.cpaM) + '.', null));
      }
    }
  } else if (comp) {
    // comparação escolhida, mas o período comparado sai da série: sem variações
    const semDados = comp.cobertura === 'nenhuma';
    cards.push(ecvInsightCard('nt',
      'Comparação ' + (semDados ? 'sem dados' : 'parcial') + ': o período comparado (' + fmt.dateFull(comp.a) + ' a ' + fmt.dateFull(comp.b) + ') ' +
      (semDados ? 'fica inteiro antes' : 'começa antes') + ' do início da série do e-commerce (' + fmt.dateFull(ecomBounds().min) +
      ') — variações não calculadas para não comparar com dias sem dado.', null));
  } else {
    cards.push(ecvInsightCard('nt',
      'Comparação desativada — os insights de variação aparecem ao escolher uma comparação no topo.', null));
  }

  // concentração de receita por campanha (por plataforma — nunca somada).
  // Numerador e denominador da MESMA fonte (campaign_daily) e só com ≥ 2
  // campanhas ativas: com uma campanha só o card diria sempre "100%".
  const topShare = (daily, recField, plat) => {
    const by = aggBy(fdaysR(daily, st.start, st.end), r => r.campanha, ['gasto', recField]);
    const keys = Object.keys(by).filter(k => by[k].gasto > 0 || by[k][recField] > 0);
    if (keys.length < 2) return;
    const tot = keys.reduce((a, k) => a + (by[k][recField] || 0), 0);
    if (!(tot > 0)) return;
    let top = null;
    keys.forEach(k => { if (!top || by[k][recField] > top.v) top = { k, v: by[k][recField] }; });
    if (top && top.v > 0) {
      cards.push(ecvInsightCard('nt',
        'A campanha <strong>' + esc(top.k) + '</strong> concentra <strong>' + fmt.pct(Math.min(100, top.v / tot * 100), 0) +
        '</strong> da receita atribuída ' + plat + ' no período (' + fmt.currency(top.v) + ' de ' + fmt.currency(tot) +
        ', entre ' + fmt.num(keys.length) + ' campanhas ativas).', null));
    }
  };
  topShare((DATA.meta_ecom || {}).campaign_daily, 'valor_compras', 'Meta (pixel)');
  if (cur.gOk) topShare((DATA.google_ecom || {}).campaign_daily, 'valor_conversoes', 'Google');

  // criativos com gasto RELEVANTE e zero venda no período (Meta).
  // · só roda se o diário por criativo cobre o gasto Meta do período (±5%) —
  //   sem esse dado, "todos venderam" seria um falso positivo;
  // · gasto mínimo por criativo = 1 CPA Meta do período (piso R$ 20): centavos
  //   de entrega residual não viram alerta de "avaliar pausa".
  const byCreat = aggBy(fdaysR((DATA.meta_ecom || {}).creatives_daily, st.start, st.end),
    r => r.anuncio + '|||' + r.campanha, ['gasto', 'compras']);
  const cKeys = Object.keys(byCreat);
  const gastoCreat = cKeys.reduce((a, k) => a + (byCreat[k].gasto || 0), 0);
  const cobre = cKeys.length > 0 && cur.gastoM > 0 && Math.abs(gastoCreat - cur.gastoM) <= Math.max(1, cur.gastoM * 0.05);
  if (cobre) {
    const minGasto = Math.max(20, cur.cpaM || 0);
    const regra = 'gasto ≥ ' + fmt.currency(minGasto) + ' no período' + (cur.cpaM != null && cur.cpaM > 20 ? ' (1 CPA Meta)' : ' (piso mínimo)');
    let semVenda = 0, nSemVenda = 0, nRelevantes = 0;
    cKeys.forEach(k => {
      const v = byCreat[k];
      if (!(v.gasto >= minGasto)) return;
      nRelevantes++;
      if (!(v.compras > 0)) { semVenda += v.gasto; nSemVenda++; }
    });
    if (nSemVenda > 0) {
      cards.push(ecvInsightCard('neg',
        '<strong>' + fmt.currency(semVenda) + '</strong> gastos em ' + fmt.num(nSemVenda) +
        ' criativo(s) sem nenhuma venda atribuída (pixel Meta) — considerando só criativos com ' + regra + '.',
        'criativo/oferta sem aderência — avaliar pausa ou troca.'));
    } else if (nRelevantes > 0) {
      cards.push(ecvInsightCard('pos', (nRelevantes === 1
        ? 'O único criativo Meta com ' + regra + ' teve ao menos uma venda atribuída (pixel).'
        : 'Todos os ' + fmt.num(nRelevantes) + ' criativos Meta com ' + regra + ' tiveram ao menos uma venda atribuída (pixel).'), null));
    }
  }

  return cards.length
    ? '<div class="ins-grid">' + cards.join('') + '</div>'
    : card('Insights de performance', 'gerados dos dados filtrados', emptyDashed('Sem dados no período para gerar insights.'));
}

/* ---------- metas de CPA e ROAS da frente (config · 0 = não definida) ----------
   Régua aplicada POR PLATAFORMA (atribuição própria de cada uma, nunca somada),
   sobre os números do período filtrado. */
function ecvMetasHtml(cur, gOk) {
  const cfg = DATA.config || {};
  const cpaT = cfg.cpa_target_ecom || 0, roasT = cfg.roas_target_ecom || 0;
  const linha = (nome, valor, badge) => '<div class="ctx-line">' + nome + ': <strong>' + valor + '</strong> ' + badge + '</div>';
  const semGoogle = '<div class="ctx-line muted">Google Ads: sem dados nesta frente</div>';
  const badgeRoas = v => v == null
    ? '<span class="badge gray">sem gasto</span>'
    : (v >= roasT ? '<span class="badge green">na meta</span>' : '<span class="badge red">abaixo da meta</span>');
  const cardCpa = cpaT > 0
    ? card('Meta de CPA', 'custo por compra (Meta) / por conversão (Google) · período filtrado',
      '<div class="big-money">' + fmt.currency(cpaT) + '<span class="bm-unit">teto</span></div>' +
      linha('CPA Meta (pixel)', cur.cpaM == null ? '—' : fmt.currency(cur.cpaM), metaBadgeCusto(cur.cpaM, cpaT)) +
      (gOk ? linha('Custo/conversão Google', cur.cpaG == null ? '—' : fmt.currency(cur.cpaG), metaBadgeCusto(cur.cpaG, cpaT)) : semGoogle))
    : card('Meta de CPA', 'custo por compra (Meta) / por conversão (Google)',
      emptyDashed('Meta de CPA não definida.',
        'Configure CPA_TARGET_ECOM nas Variables do repositório — o painel passa a marcar o CPA Meta e o custo/conversão Google do período como na meta ou acima dela.'));
  const cardRoas = roasT > 0
    ? card('Meta de ROAS', 'retorno atribuído por plataforma — nunca somado · período filtrado',
      '<div class="big-money">' + fmt.roas(roasT) + '<span class="bm-unit">mínimo</span></div>' +
      linha('ROAS Meta (pixel)', fmt.roas(cur.roasM), badgeRoas(cur.roasM)) +
      (gOk ? linha('ROAS Google (atribuição do Google)', fmt.roas(cur.roasG), badgeRoas(cur.roasG)) : semGoogle))
    : card('Meta de ROAS', 'retorno atribuído por plataforma',
      emptyDashed('Meta de ROAS não definida.',
        'Configure ROAS_TARGET_ECOM nas Variables do repositório — o painel passa a marcar o ROAS de cada plataforma (atribuição própria, nunca somada) como na meta ou abaixo dela.'));
  return '<div class="grid-2">' + cardCpa + cardRoas + '</div>';
}

/* ---------- página inteira ---------- */
function renderVisaoEcom(el) {
  ECV_SPARKS = [];
  const st = FILTER.ecom;
  const bd = ecomBounds();
  const comp = ecomCompareRange();
  // Comparação só vale com o período comparado INTEIRO dentro da série:
  // parcial/sem dados → sem variação % (nada de "novo no período" contra
  // dias que a série não cobre); as linhas tracejadas mostram só dias cobertos.
  const compOk = !!comp && comp.cobertura === 'total';
  const compNota = comp && !compOk ? (comp.cobertura === 'nenhuma' ? 'comparação sem dados' : 'comparação parcial · sem %') : null;
  const cur = ecvTotals(st.start, st.end);
  const prev = compOk ? ecvTotals(comp.a, comp.b) : null;
  const dd = ecvDaily(st.start, st.end);
  const ddPrev = comp && comp.cobertura !== 'nenhuma' ? ecvDaily(comp.a, comp.b) : null;
  const hasComp = !!comp;
  const pv = k => prev ? prev[k] : null;
  const gOk = cur.gOk;
  const gMotivo = (DATA.google_ecom || {}).motivo || 'Google Ads sem dados para esta frente.';

  let html = '<div class="page-context">Período: <strong>' + periodLabel() + '</strong>' +
    (st.adjusted ? ' (ajustado ao intervalo com dados: ' + fmt.dateFull(bd.min) + ' a ' + fmt.dateFull(bd.max) + ')' : '') +
    (comp
      ? ' · Comparação: ' + fmt.dateFull(comp.a) + ' a ' + fmt.dateFull(comp.b) + ' (' + comp.label + ')' +
        (compOk ? '' : ' — <strong>' + (comp.cobertura === 'nenhuma' ? 'sem dados' : 'parcial') + '</strong>: a série do e-commerce começa em ' +
          fmt.dateFull(bd.min) + ', variações não calculadas')
      : ' · Sem comparação ativa') +
    ' · "Hoje" = ' + fmt.dateFull(bd.max) + ', último dia com dados do e-commerce · Atualizado em ' +
    esc(DATA.last_update || '—') + '</div>' + qualityChip('ecom');

  html += banner('blue', '<strong>Atribuição:</strong> compras/receita do <strong>pixel da Meta</strong> e conversões/valor do <strong>Google</strong> são atribuídos por cada plataforma e <strong>não se somam</strong> — o único número agregável é o investimento. Receita real da loja, pedidos e sessões dependem da integração GA4/plataforma da loja (cards preparados).');

  /* ===== 1 · VISÃO EXECUTIVA (negócio + vendas) ===== */
  html += secTitle('Visão executiva', 'período filtrado' + (hasComp ? ' · variação vs comparação · sparkline = dia a dia' : ''));
  html += '<div class="xkpis">' +
    xkpi('Investimento total', fmt.currency(cur.invest),
      deltaHtml(cur.invest, pv('invest'), 'invest', hasComp, compNota),
      'Meta ' + fmt.currency(cur.gastoM) + ' + Google ' + (gOk ? fmt.currency(cur.gastoG) : 'sem dados') + ' · único agregável',
      { vals: dd.investTot, color: P.accentLight }) +
    xkpi('Compras <span class="xk-tag">pixel Meta</span>', fmt.num(cur.comprasM),
      deltaHtml(cur.comprasM, pv('comprasM'), 'compras', hasComp, compNota),
      'atribuição da plataforma', { vals: dd.comprasM, color: S.oliva }) +
    (gOk
      ? xkpi('Conversões <span class="xk-tag">Google</span>', fmt.conv(cur.convG),
        deltaHtml(cur.convG, pv('convG'), 'conversoes', hasComp, compNota),
        'atribuição da plataforma', { vals: dd.convG, color: GOOGLE_RES })
      : xkpi('Conversões <span class="xk-tag">Google</span>', null, '', esc(gMotivo))) +
    xkpi('Receita atribuída <span class="xk-tag">Meta</span>', fmt.currency(cur.recM),
      deltaHtml(cur.recM, pv('recM'), 'receita', hasComp, compNota),
      'pixel · não somar com o Google', { vals: dd.recM, color: S.mostarda }) +
    (gOk
      ? xkpi('Receita atribuída <span class="xk-tag">Google</span>', fmt.currency(cur.recG),
        deltaHtml(cur.recG, pv('recG'), 'receita', hasComp, compNota),
        'atribuição do Google · não somar com a Meta', { vals: dd.recG, color: AMBER_RAMP[1] })
      : xkpi('Receita atribuída <span class="xk-tag">Google</span>', null, '', esc(gMotivo))) +
    xkpi('ROAS <span class="xk-tag">Meta</span>', cur.roasM == null ? null : fmt.roas(cur.roasM),
      deltaHtml(cur.roasM, pv('roasM'), 'roas', hasComp, compNota),
      'receita pixel ÷ gasto Meta', { vals: dd.roasM, color: S.mostarda }) +
    (gOk
      ? xkpi('ROAS <span class="xk-tag">Google</span>', cur.roasG == null ? null : fmt.roas(cur.roasG),
        deltaHtml(cur.roasG, pv('roasG'), 'roas', hasComp, compNota),
        'valor conv. ÷ gasto Google', { vals: dd.roasG, color: GOOGLE_RES })
      : xkpi('ROAS <span class="xk-tag">Google</span>', null, '', esc(gMotivo))) +
    xkpi('CPA <span class="xk-tag">Meta</span>', cur.cpaM == null ? null : fmt.currency(cur.cpaM),
      deltaHtml(cur.cpaM, pv('cpaM'), 'cpa', hasComp, compNota),
      'gasto ÷ compras (pixel)', { vals: dd.cpaM, color: S.terracota }) +
    (gOk
      ? xkpi('Custo/conversão <span class="xk-tag">Google</span>', cur.cpaG == null ? null : fmt.currency(cur.cpaG),
        deltaHtml(cur.cpaG, pv('cpaG'), 'cpa', hasComp, compNota),
        'gasto ÷ conversões', { vals: dd.cpaG, color: GOOGLE_INV })
      : xkpi('Custo/conversão <span class="xk-tag">Google</span>', null, '', esc(gMotivo))) +
    xkpi('Cliques no link <span class="xk-tag">Meta</span>', fmt.num(cur.cliM),
      deltaHtml(cur.cliM, pv('cliM'), 'cliques', hasComp, compNota),
      gOk ? 'Google: ' + fmt.num(cur.cliG) + ' cliques (totais)' : 'link clicks das campanhas [ECOMMERCE]',
      { vals: dd.cliM, color: P.soft }) +
    xkpi('CTR <span class="xk-tag">Meta</span>', cur.ctrM == null ? null : fmt.pct(cur.ctrM, 2),
      deltaHtml(cur.ctrM, pv('ctrM'), 'ctr', hasComp, compNota),
      'cliques no link ÷ impressões' + (cur.ctrG == null ? '' : ' · Google: ' + fmt.pct(cur.ctrG, 2)), null) +
    '</div>';

  html += '<div class="xkpis prep-row">' +
    xkpiPrep('Receita da loja', 'soma dos pedidos pagos no período', 'plataforma da loja') +
    xkpiPrep('Pedidos', 'nº de pedidos da loja no período', 'plataforma da loja') +
    xkpiPrep('Ticket médio', 'receita da loja ÷ pedidos', 'plataforma da loja') +
    xkpiPrep('Taxa de conversão', 'pedidos ÷ sessões × 100', 'GA4 + plataforma da loja') +
    xkpiPrep('Sessões', 'visitas ao site no período', 'GA4') +
    xkpiPrep('MER', 'receita da loja ÷ investimento total em mídia', 'plataforma da loja') +
    xkpiPrep('CAC', 'investimento ÷ novos clientes', 'plataforma da loja (novos clientes)') +
    '</div>' +
    '<div class="note">Cards preparados: ficam sem número até a loja/GA4 enviarem dados reais — nada é simulado. ' +
    '<strong>MER</strong> e <strong>CAC</strong> não são calculáveis com atribuição de plataforma: exigem a receita real da loja e a contagem de novos clientes.</div>';

  /* ===== 2 · EVOLUÇÃO ===== */
  html += secTitle('Evolução', 'dia a dia do período · tracejado cinza = período comparado');
  const EVO_OPTS = [['invest', 'Investimento'], ['compras', 'Compras'], ['receita', 'Receita atribuída'], ['roas', 'ROAS'], ['cpa', 'CPA']];
  html += card(null, null,
    '<div class="seg-toggle" id="evo-toggle">' + EVO_OPTS.map(o =>
      '<button type="button" data-v="' + o[0] + '" class="' + (ECOM_EVO_METRIC === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') +
    '</div>' +
    '<div class="chart-box tall"><canvas id="ch-ecv-evo"></canvas></div>' +
    '<div class="note">Sempre por plataforma: compras = pixel Meta · conversões = Google · receitas exibidas separadas (atribuição de cada plataforma — nunca somadas). ' +
    'Com comparação ativa, as linhas tracejadas neutras mostram a mesma métrica no período comparado, alinhada dia a dia (tooltip mostra a data original).</div>');

  /* ===== 3 · AQUISIÇÃO POR CANAL ===== */
  html += secTitle('Aquisição por canal', 'mídia paga hoje · demais canais dependem do GA4');
  const aqBody =
    '<tr><td class="name">Meta Ads<div class="ch-sub">compras e receita: pixel da Meta</div></td>' +
    tdNum(cur.gastoM, fmt.currency) +
    tdNum(cur.cliM, fmt.num) +
    tdNum(cur.comprasM, fmt.num) +
    tdNum(cur.recM, fmt.currency) +
    tdNum(cur.cpaM, fmt.currency) +
    tdNum(cur.roasM, fmt.roas) + '</tr>' +
    (gOk
      ? '<tr><td class="name">Google Ads<div class="ch-sub">conversões e valor: atribuição do Google · cliques totais</div></td>' +
      tdNum(cur.gastoG, fmt.currency) +
      tdNum(cur.cliG, fmt.num) +
      tdNum(cur.convG, fmt.conv) +
      tdNum(cur.recG, fmt.currency) +
      tdNum(cur.cpaG, fmt.currency) +
      tdNum(cur.roasG, fmt.roas) + '</tr>'
      : '<tr><td class="name">Google Ads</td><td colspan="6" class="dim">' + esc(gMotivo) + '</td></tr>') +
    ['Orgânico', 'Direto', 'E-mail', 'Referral'].map(c2 =>
      '<tr class="row-prep"><td class="name">' + c2 + '</td>' +
      '<td colspan="6"><span class="dep-tag">depende de GA4</span></td></tr>').join('');
  html += card('Canais de aquisição', 'clique no cabeçalho para ordenar · período filtrado',
    sortableWrap([
      { t: 'Canal', k: 'txt' }, { t: 'Investimento', r: 1, k: 'num' }, { t: 'Cliques', r: 1, k: 'num' },
      { t: 'Compras/Conversões', r: 1, k: 'num' }, { t: 'Receita atribuída', r: 1, k: 'num' },
      { t: 'CPA', r: 1, k: 'num' }, { t: 'ROAS', r: 1, k: 'num' }
    ], aqBody) +
    '<div class="note"><strong>Atribuição:</strong> cada linha usa a atribuição da própria plataforma — as receitas <strong>não são somáveis</strong> entre linhas. ' +
    'Cliques: Meta = cliques no link; Google = cliques totais. Orgânico, Direto, E-mail e Referral entram quando o GA4 for integrado.</div>');

  /* ===== 4 · FUNIL DO E-COMMERCE (preparado) ===== */
  html += secTitle('Funil do e-commerce', 'estado preparado — eventos vêm do GA4');
  const fpStages = ['Sessões', 'Visualização de produto', 'Carrinho', 'Checkout', 'Compra'];
  const fpW = [100, 78, 56, 38, 22];
  html += card('Funil da loja', 'Sessões → Produto → Carrinho → Checkout → Compra',
    '<div class="funnel-prep">' + fpStages.map((s2, i) =>
      '<div class="fp-row"><div class="fp-lb">' + s2 + '</div>' +
      '<div class="fp-track"><div class="fp-bar" style="width:' + fpW[i] + '%"></div></div>' +
      '<div class="fp-pct">—</div></div>').join('') + '</div>' +
    '<div class="note">Sem números: os eventos do funil vêm do <strong>GA4 — integração pendente</strong>. O desenho acima é só a estrutura; nada é simulado.</div>');

  /* ===== 5 · ANÁLISES DA LOJA (preparadas) ===== */
  html += secTitle('Análises da loja', 'estado preparado — cada card nomeia o dado que falta');
  const prepCards = [
    ['Produtos', 'mais vendidos · receita por produto/categoria', 'plataforma da loja (itens dos pedidos)'],
    ['Clientes: novos × recorrentes', 'participação e receita por tipo de cliente', 'plataforma da loja (histórico de clientes)'],
    ['Geografia de vendas', 'pedidos e receita por estado/cidade', 'plataforma da loja (endereço dos pedidos)'],
    ['Dispositivos', 'sessões e conversão por dispositivo', 'GA4'],
    ['Dias e horários', 'pedidos por dia da semana e hora', 'plataforma da loja (data/hora dos pedidos)'],
    ['Cancelamentos e reembolsos', 'volume, valor e motivos', 'plataforma da loja'],
    ['Receita bruta × líquida', 'descontos, fretes, impostos e reembolsos', 'plataforma da loja'],
    ['Cupons', 'uso e receita por cupom', 'plataforma da loja (promoções)']
  ];
  html += '<div class="prep-grid">' + prepCards.map(p2 =>
    '<div class="prep-card"><div class="pc-t">' + p2[0] + '</div><div class="pc-d">' + p2[1] + '</div>' +
    '<div class="xk-dep">depende de: ' + p2[2] + '</div></div>').join('') + '</div>';
  html += '<div class="note">Os breakdowns de idade, região e posicionamento existentes hoje são de <strong>anúncio</strong> (mídia), não de venda — ' +
    '<a href="#ecom/publico">ver o perfil de quem responde aos anúncios na página Público</a>.</div>';

  /* ===== 6 · MÍDIA PAGA (tabela unificada) ===== */
  html += secTitle('Mídia paga', 'campanhas das duas plataformas · período filtrado');
  const mRows = [];
  const stM = dict((DATA.meta_ecom || {}).campaign_status);
  const byMC = aggBy(fdaysR((DATA.meta_ecom || {}).campaign_daily, st.start, st.end),
    r => r.campanha, ['gasto', 'impressoes', 'cliques_link', 'compras', 'valor_compras']);
  Object.keys(byMC).forEach(k => {
    const v = byMC[k];
    if (!(v.gasto > 0 || v.compras > 0)) return;
    mRows.push({ nome: k, plat: 'Meta', status: statusBadge(stM[k]), gasto: v.gasto, imp: v.impressoes, cli: v.cliques_link, res: v.compras, rec: v.valor_compras });
  });
  if (gOk) {
    const stG = dict((DATA.google_ecom || {}).campaign_status);
    const byGC = aggBy(fdaysR((DATA.google_ecom || {}).campaign_daily, st.start, st.end),
      r => r.campanha, ['gasto', 'impressoes', 'cliques', 'conversoes', 'valor_conversoes']);
    Object.keys(byGC).forEach(k => {
      const v = byGC[k];
      if (!(v.gasto > 0 || v.conversoes > 0)) return;
      mRows.push({ nome: k, plat: 'Google', status: googleStatusBadge(stG[k]), gasto: v.gasto, imp: v.impressoes, cli: v.cliques, res: v.conversoes, rec: v.valor_conversoes });
    });
  }
  mRows.sort((a, b) => b.gasto - a.gasto);
  const mBody = mRows.map(r => {
    const rctr = r.imp > 0 ? r.cli / r.imp * 100 : null;
    const rcpc = r.cli > 0 ? r.gasto / r.cli : null;
    const rcpa = r.res > 0 ? r.gasto / r.res : null;
    const rroas = r.gasto > 0 ? r.rec / r.gasto : null;
    const alerta = r.gasto > 0 && !(r.res > 0);
    return '<tr' + (alerta ? ' class="row-alert" title="gasto sem venda/conversão atribuída no período"' : '') + '>' +
      '<td class="name">' + esc(r.nome) + '</td>' +
      '<td class="peri">' + r.plat + '</td>' +
      '<td>' + r.status + '</td>' +
      tdNum(r.gasto, fmt.currency) +
      tdNum(r.imp, fmt.num) +
      tdNum(r.cli, fmt.num) +
      tdNum(rctr, v => fmt.pct(v, 2)) +
      tdNum(rcpc, fmt.currency) +
      tdNum(r.res, fmt.conv) +
      tdNum(r.rec, fmt.currency) +
      tdNum(rcpa, fmt.currency) +
      tdNum(rroas, fmt.roas) + '</tr>';
  }).join('');
  html += card('Campanhas — Meta + Google', 'clique no cabeçalho para ordenar · linha tingida = gasto sem venda/conversão no período',
    mBody
      ? sortableWrap([
        { t: 'Campanha', k: 'txt' }, { t: 'Plataforma', k: 'txt' }, { t: 'Status' },
        { t: 'Investimento', r: 1, k: 'num' }, { t: 'Impressões', r: 1, k: 'num' },
        { t: 'Cliques-link/Cliques', r: 1, k: 'num' }, { t: 'CTR', r: 1, k: 'num' },
        { t: 'CPC', r: 1, k: 'num' }, { t: 'Compras/Conv.', r: 1, k: 'num' },
        { t: 'Receita atrib.', r: 1, k: 'num' }, { t: 'CPA', r: 1, k: 'num' }, { t: 'ROAS', r: 1, k: 'num' }
      ], mBody) +
      '<div class="note">Cliques: Meta = cliques no link · Google = cliques totais. Compras/receita Meta = pixel; conversões/valor Google = atribuição da plataforma — colunas de receita <strong>não somáveis</strong> entre plataformas. ' +
      'Detalhe por conjunto e criativo nas páginas <a href="#ecom/meta">Meta Ads</a> e <a href="#ecom/google">Google Ads</a>.</div>'
      : emptyDashed('Nenhuma campanha com gasto no período.', 'Ajuste o filtro de período no topo.'));

  /* ===== 6b · CONTROLE DE INVESTIMENTO, METAS, RESULTADO E HISTÓRICO =====
     Conteúdo do dashboard de otimização da frente (otimizacao_ecom + config)
     que a central não pode perder: ciclo × orçamento, metas de CPA/ROAS,
     criativos eficientes × dinheiro sem retorno, alertas e histórico mensal. */
  const oc = otCfg('ecom');
  html += secTitle('Controle de investimento e metas', 'ciclo do mês × orçamento · independe do filtro · metas sobre o período filtrado');
  html += otCicloHtml(oc);
  html += ecvMetasHtml(cur, gOk);
  html += secTitle('Onde está o resultado', 'e onde o dinheiro está parado · toda a série');
  html += otResultadoHtml(oc);
  html += '<div class="note grid-note">No e-commerce, <strong>resultado</strong> = compra atribuída pelo pixel da Meta; ' +
    '"zero resultado" = anúncio com mais de R$ 10 gastos sem compra nem conversa iniciada. Só Meta: o Google não expõe criativos.</div>';
  html += secTitle('Qual ação tomar', 'alertas priorizados por dinheiro em jogo');
  html += otAcoesHtml(oc);
  html += secTitle('Histórico mensal', 'mês a mês por plataforma — independe do filtro');
  html += otHistHtml(oc);

  /* ===== 7 · TABELA EXECUTIVA DIÁRIA ===== */
  html += secTitle('Tabela executiva diária', 'uma linha por dia do período · busca, ordenação, paginação e CSV');
  html += card(null, null,
    '<div class="dt-bar">' +
    '<input type="text" id="dt-q" placeholder="Buscar data (dd/mm/aaaa)" autocomplete="off">' +
    '<button type="button" id="dt-csv" class="btn-sec">Exportar CSV</button>' +
    '</div>' +
    '<div id="dt-table"></div>' +
    '<div class="dt-pag" id="dt-pag"></div>' +
    '<div class="note">Receitas atribuídas por cada plataforma — as colunas Meta e Google <strong>não se somam</strong>. ' +
    (gOk ? '' : 'Google Ads sem dados: colunas do Google em "—" e investimento total = só Meta. ') +
    'CSV no padrão do Excel em português: separador ponto e vírgula, decimais com vírgula e datas em dd/mm/aaaa (documentado no cabeçalho do arquivo).</div>');

  /* ===== 8 · INSIGHTS (diagnósticos) ===== */
  html += secTitle('Insights de performance', 'calculados dos dados filtrados' + (compOk ? ' vs comparação' : '') + ' — sem IA, sem especulação');
  html += ecvInsights(cur, prev, st, comp);

  el.innerHTML = html;

  /* ---------- pós-render ---------- */
  drawSparks();
  wireSparkResize(el.querySelector('.xkpis'));
  ecvEvoChart(dd, ddPrev);
  wireSortables(el);
  ecvDailyTable(dd);
  // Troca de métrica redesenha SÓ o gráfico: busca, ordenação e página da
  // tabela diária (e das tabelas ordenáveis) ficam como o usuário deixou.
  const tg = document.getElementById('evo-toggle');
  if (tg) tg.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      if (ECOM_EVO_METRIC === b.dataset.v) return;
      ECOM_EVO_METRIC = b.dataset.v;
      tg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      ecvEvoChart(dd, ddPrev);
    });
  });
}

function otLegadoEcom() {
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

  let html = secTitle('Detalhe da frente', 'receita e ROAS por plataforma');
  html += banner('blue', 'Compras e receita vêm do <strong>pixel da Meta</strong> (atribuição da plataforma) — ' +
    'a loja ainda não envia venda confirmada para cá. Sem CRM nesta frente: a loja não usa o Kommo. ' +
    'Conversões e valor do <strong>Google</strong> são atribuição do Google e <strong>não somam</strong> com o pixel — só o investimento total soma as duas plataformas.');

  html += '<div class="kpis cols-hero-6">' +
    kpi('ROAS', roas == null ? null : fmt.dec(roas, 2) + '×',
      roas == null ? 'sem gasto no período' : 'receita ÷ gasto · pixel da Meta (só Meta)', { teal: true, hero: true }) +
    kpi('Investimento (Meta)', fmt.currency(gasto), 'campanhas [ECOMMERCE] no período') +
    kpi('Compras', fmt.num(compras), 'pixel da Meta (só Meta) · no período') +
    kpi('Receita', fmt.currency(receita), 'pixel da Meta (só Meta) · no período') +
    kpi('CPA', cpa == null ? null : fmt.currency(cpa), 'gasto ÷ compras · só Meta') +
    kpi('Cliques no link', fmt.num(cli), ctr == null ? 'no período' : 'CTR ' + fmt.pct(ctr, 1)) +
    '</div>';

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

  return html;
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

  // Controle de investimento do impulsionamento (orçamento mensal via
  // Variables; granularidade mensal — usa o mês corrente como ciclo)
  const orcInst = ((DATA.config || {}).orcamento_meta_inst) || 0;
  const mesAtual = (DATA.last_update || '').slice(6, 10) + '-' +
    (DATA.last_update || '').slice(3, 5);
  const rowAtual = (inst.monthly || []).find(r => r.mes === mesAtual);
  const gastoCiclo = rowAtual ? (rowAtual.gasto || 0) : 0;
  if (orcInst > 0) {
    const pct = Math.min(100, gastoCiclo / orcInst * 100);
    const ok = gastoCiclo <= orcInst;
    html += '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-t">Controle de investimento — impulsionamento' +
      '<span class="card-s">orçamento mensal R$ ' + fmt.dec(orcInst, 2) +
      ' · gasto do mês corrente (granularidade mensal)</span></div>' +
      '<div class="big-money">' + fmt.currency(orcInst - gastoCiclo) +
      ' <span class="badge ' + (ok ? 'green' : 'amber') + '">' +
      (ok ? 'No orçamento' : 'Estourado') + '</span></div>' +
      '<div class="pbar"><span style="width:' + pct.toFixed(0) +
      '%"></span></div>' +
      '<div class="note">' + fmt.currency(gastoCiclo) + ' gastos de ' +
      fmt.currency(orcInst) + ' — ' + pct.toFixed(0) + '% usado</div>' +
      '</div>';
  }
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
  setPresetEcom('30', false);          // estado inicial da frente e-commerce
  setPreset('all', false);             // estado inicial B2B (comportamento original)

  document.getElementById('loading').hidden = true;

  window.addEventListener('hashchange', route);
  route();
}

document.addEventListener('DOMContentLoaded', loadData);
