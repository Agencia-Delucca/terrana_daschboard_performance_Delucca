# SPEC VISUAL DE REFERÊNCIA — Dashboard padrão Agência Delucca

Fonte: 8 capturas do dashboard **Dr. Move · B2B — Performance** (drmove-performance.pages.dev, 1920px, tema dark).
Objetivo: reconstruir o mesmo design para **Terrana B2B** (CRM **Kommo** + **Meta Ads**).
Mapeamento de adaptação: "Syncro" → **Kommo**; frente "B2B — Parcerias" → frente Terrana; página Google Ads é opcional (Terrana usa só Meta); textos de banner são dinâmicos por cliente. Todo o resto (tokens, componentes, layout) é idêntico.

---

## Tokens globais

### Cores — superfícies
| Token | Hex | Uso |
|---|---|---|
| `--bg-page` | `#05070D` | fundo da página e do topbar (quase preto azulado; variações medidas #05090F–#060A14) |
| `--bg-sidebar` | `#080C16` | sidebar (algumas páginas com degradê sutil #0A101C → #090E19) |
| `--bg-card` | `#0D1524` | cards, inputs, selects, tabelas |
| `--border-card` | `#1B2942` | borda 1px de cards/inputs (algumas páginas quase invisível, rgba(255,255,255,.05)) |
| `--track` | `#131D30` | trilha do funil, divisórias de linha de tabela (~#141F33) |

### Cores — marca e dados
| Token | Hex | Uso |
|---|---|---|
| `--blue` | `#2874FC` | azul primário: barras de gráfico, séries "Gasto/Leads" |
| `--grad-active` | `linear-gradient(90deg, #2C6BFC, #4429FB)` | item ativo da sidebar e barras do funil (azul → índigo) |
| `--grad-kpi-top` | `linear-gradient(90deg, #2A3CBA, #3128BA)` | hairline de 2–3px no TOPO dos KPI cards (versão atenuada do gradiente ativo) |
| `--teal` | `#31CDCF` | accent da marca: "PERFORMANCE", badge da frente, KPI-destaque, eixo Y direito, série "Leads CRM" (variações #2DD4BF/#31CDAE) |
| `--green` | `#10B981` | sucesso: badge "Ativo"/"Orgânico"/"Bom", série "Vendas"; barra verde do funil `#0FAB84` |
| `--red` | `#EF4444` | perda: badge "Pausado"/"Ruim", donut/colunas de perda, série "Perdas"; barra vermelha do funil `#DC3636` |
| `--amber` | `#F59E0B` | barras de tempo, dot de CPL, laranja de dados; texto de aviso `#FBBF24` |
| `--blue-light` | `#93C5FD` | texto de banner info, links de criativo/anúncio (#60A5FA/#7EA6F4) |

### Cores — semânticas de banner
| Variante | Fundo | Borda | Texto |
|---|---|---|---|
| Aviso (âmbar) | `#18120D` | `#65430C` (1px) | `#FBBF24`, ícone ⚠ |
| Info (azul) | `#080F20` | `#13326D` (1px) | `#93C5FD`, trechos-chave em bold branco |

### Cores — texto
| Token | Hex | Uso |
|---|---|---|
| `--text` | `#F4F7FD` | títulos, valores, células |
| `--text-muted` | `#6D7C96` | subtítulos, labels de eixo, cabeçalhos de tabela (variações #94A3B8/#8CA3C0) |
| `--text-soft` | `#CBD5E1` | itens inativos da sidebar |
| `--text-periwinkle` | `#C7D2FE` | valores secundários de tabela (ETAPA/ORIGEM) |

### Tipografia
- Família: sans-serif tipo **Inter** / system-ui (Segoe UI).
- Título de página (topbar): bold ~17–20px, branco, formato `"Frente · Página"`.
- Título de card: bold ~15–16px branco; **sempre** seguido de subtítulo ~12px `--text-muted` explicando a fonte do dado ("via utm_campaign", "status real via API · período filtrado").
- Valor de KPI: bold 26–30px.
- Labels de KPI e cabeçalhos de tabela: **CAIXA ALTA + letter-spacing ~0.05em**, ~11px, weight 600, `--text-muted`.
- Células de tabela: 13–14px; números **sempre alinhados à direita**, texto à esquerda; cabeçalho acompanha o alinhamento da coluna.
- Formato **100% pt-BR**: milhar com ponto (`47.701`), decimal com vírgula (`3,4%`, `0,0%`), moeda `R$ 1.478,65`, datas `dd/mm` e `dd/mm/aaaa`, mês de eixo `Jul/26`, dias `5,4d`. Placeholder de dado ausente: travessão `—`.

### Raios
- Cards: 12–14px · Banners/inputs/badge da frente: 8–10px · Pill ativo da sidebar: 10–12px · Badges/pills de status: 999px · Barras do funil: 6–8px · Topo de barras verticais: 3–4px · Thumbnails: 8px (4px nas mini de 20px).

### Sombras/efeitos
- Sem box-shadows fortes; profundidade vem de superfícies + hairlines. Único "glow": a linha-gradiente no topo dos KPI cards. Glow radial teal decorativo muito sutil no canto inferior-esquerdo da página (opcional).

### Espaçamento
- Padding lateral do conteúdo: ~24px após a sidebar · gap entre cards: 16–24px · gap entre banners: ~12px · padding interno de card: 20–24px · altura de linha de tabela: 38–45px · gap vertical entre seções: ~24px.

---

## Componentes reutilizáveis

### 1. Sidebar (fixa, ~225–240px, `--bg-sidebar`)
1. **Logo**: logomark + wordmark do cliente em branco bold; abaixo, `PERFORMANCE` em caps teal, letter-spacing largo, ~10–11px.
2. **Badge da frente** (switcher): caixa raio ~10px, fundo `#0D1F29`, borda 1px teal `#164A53`; linha 1 = nome da frente em teal bold centralizado (`B2B — Parcerias`); linha 2 = link de troca menor (`Ir para B2C →`). *Terrana: manter o badge como identificador da frente mesmo com uma frente só; link de troca opcional.*
3. **Nav**: itens com **emoji nativo** como ícone + label ~14px `--text-soft`. Ordem de referência: 📊 Visão Geral · 🎯 Funil CRM · ⭐ Qualificação · 📱 Meta Ads · 🔍 Google Ads · 📣 Institucional & Impulsionamento (quebra em 2 linhas) · 👥 Público · 📈 Evolução Mensal.
4. **Item ativo**: pill de largura total, altura ~36px, `--grad-active`, texto branco bold.

### 2. Topbar (sticky, `--bg-page`, divisor 1px `--border-card` embaixo)
- Esquerda: título `"Frente · Página"` bold branco.
- Direita (filtro global de período, presente em todas as páginas): label `De` + `<input type="date">` nativo (placeholder `dd/mm/aaaa`, fundo `--bg-card`, borda `--border-card`, raio 8px, ícone calendário) · label `Até` + input idêntico · `<select>` **"Todo período"** (mesmo estilo, chevron). Páginas que ignoram o filtro declaram isso em banner/subtítulo.

### 3. KPI card
- Fundo `--bg-card`, raio 12–14px, borda sutil, **hairline `--grad-kpi-top` de 2–3px colada no topo** (só em KPI/stat cards — nunca em cards de tabela/gráfico).
- Anatomia: label CAPS `--text-muted` 11px → valor bold branco 26–30px → subtítulo 11–12px `--text-muted`.
- **KPI-destaque** (métrica-chave de custo: CPL, custo/lead, custo/engajamento): valor em `--teal`; subtítulo pode carregar meta ("meta provisória: até R$ 60,00") ou asterisco metodológico.
- KPI sem dado: traço curto grosso em teal no lugar do número.
- Grids: 6 colunas (Visão Geral, Meta Ads, Google Ads, Institucional) ou 5 (Funil CRM) ou 3 (stat cards).

### 4. Banner de aviso / info (largura total, raio ~10px, empilháveis)
- **Âmbar (aviso de qualidade de dado)**: ícone ⚠ à esquerda, 1–2 linhas, posicionado ANTES dos KPIs. Padrão da agência: transparência sobre limitações de atribuição.
- **Azul (info metodológica)**: com ou sem ícone, termos-chave em bold, explica definições ("Qualificado = …", "não usa o filtro de período").
- **Nota de rodapé metodológica**: card fino full-width com borda/texto azul ligado a `*` de um KPI.
- Pode aparecer também como banner-rodapé com breakdown detalhado.

### 5. Chart-card
- Fundo `--bg-card`, sem hairline no topo; título bold + subtítulo cinza descritivo ("barras = gasto Meta · linha = leads do pipeline no CRM").
- Estilo Chart.js: gridlines horizontais muito sutis (`--track` / rgba(255,255,255,.04)); labels de eixo `--text-muted` ~11px; legenda **centralizada no topo** com retângulos ~28×14px + label.
- Combos com **2 eixos Y**: eixo direito com labels na COR da série secundária (teal).
- Eixos monetários com prefixo `R$ ` (sem milhar nos ticks: "R$ 2500"); datas do eixo X rotacionadas ~45° em séries diárias.

### 6. Tabela
- Dentro de card com título + subtítulo. Cabeçalhos CAPS `--text-muted` 11px letter-spacing; linhas com divisor 1px `--track` (sem zebra); altura 38–45px.
- Coluna de texto principal em branco; coluna de contexto secundário (campanha-mãe, grupo) em `--text-muted`; valores relacionais em `--blue-light` ou `--text-periwinkle`; coluna QUALIFICADOS sempre em **teal bold** (cor-assinatura).
- Thumbnails de criativo: 40–48px raio 8px na coluna principal; 20px raio 4px em listas "top criativos"; nomes clicáveis em azul-claro, sufixo cinza `(NL/NQ)`; ícone 🔗 após nomes de anúncio.
- `—` para métrica sem dado; "(sem nome)" / "(sem UTM)" como fallbacks.

### 7. Funil (etapa-a-etapa)
- Linhas horizontais: rótulo da etapa à ESQUERDA (alinhado à direita), trilha full-width `--track`, barra pill com `--grad-active` de largura proporcional, **valor bold branco DENTRO da barra alinhado à direita**.
- À DIREITA da trilha, a partir da 2ª etapa: percentual em 2 linhas, cinza ~11px — `"NN% da / anterior"`.
- Etapas terminais fora do gradiente azul: ganho = barra VERDE (gradiente teal→verde ~`#0FAB84`), perda = barra VERMELHA (~`#DC3636`, gradiente escurecendo).
- Valor zero ainda renderiza pill mínima colorida com o "0".
- *Terrana/Kommo: usar os nomes reais das etapas do pipeline Kommo.*

### 8. Badges (pills raio 999px, padrão "texto saturado + fundo da mesma cor a ~12–15% de opacidade + borda da cor")
| Badge | Texto | Contexto |
|---|---|---|
| `Ativo` | `#10B981` | status de campanha via API |
| `Pausado` | `#EF4444` | status de campanha via API |
| `Pago` | `#47A5FD` | tipo de origem |
| `Orgânico` | `#10B981` | tipo de origem |
| `Bom` / `Ruim` / `Dados insuf.` | verde / vermelho / cinza | régua de qualidade por custo/lead |

### 9. Empty state (padrão orientado a ação)
- Caixa interna com **borda tracejada 1px**, raio ~10px, texto centralizado em 2 linhas: linha 1 = o que falta ("Nenhum lead vivo com valor preenchido no Kommo."); linha 2 menor cinza = instrução de correção para habilitar a visão.

---

## Páginas

Estrutura comum a todas: Sidebar + Topbar + **Banner(s) âmbar de qualidade de dado** (os mesmos 2 em todas as páginas, texto dinâmico) → conteúdo.

### P1 · Visão Geral
1. 2 banners âmbar.
2. **6 KPI cards**: `LEADS NO CRM` (sub "criados no período · Pipeline de venda B2B") · `INVESTIMENTO` (sub com breakdown por plataforma) · `CPL (CRM)` **teal** (sub "investimento ÷ leads do CRM*") · `LEADS PLATAFORMA` (sub "reportado pela plataforma") · `VENDAS` (sub "no período") · `PERDIDOS` (sub "no período").
3. **Nota de rodapé azul** com `*` explicando a metodologia do CPL.
4. **2 chart-cards 50/50**: "Leads por dia" (sub "entradas no pipeline (CRM)") e "Investimento por dia" (sub "gasto Meta Ads da frente").
5. **Card do Funil**: "Funil B2B — visão do período" (sub "leads criados no período, pela etapa ATUAL de cada um"). Etapas de referência: Lead Novo (Bot) → Em Atendimento → Pré-Qualificado → Qualificado → Reunião agendada → Proposta enviada → Negociação Fechada (verde) → Não Fechou (vermelho).
6. **Tabela "Leads por origem (utm_source)"** (sub: origem gravada no lead; fallback "(sem UTM)"): `UTM_SOURCE | LEADS | VENDAS | PERDIDOS` — valores de utm em minúsculas como gravados.
7. **Tabela "Qualidade de atendimento por responsável"** (sub: estado atual do funil, não usa filtro de período · "1º atendimento" = lead saiu da etapa de entrada · resolução diária): `RESPONSÁVEL | LEADS | VENDAS | PERDIDOS | TAXA CONV. | SEM 1º ATEND. | TEMPO 1º ATEND. | PARADO (MÉDIO)` — tempos em formato `5,4d`; fallback "sem responsável".

### P2 · Funil CRM
1. 2 banners âmbar.
2. **5 KPI cards**: `LEADS NO PERÍODO` (sub "Pipeline de venda B2B") · `EM ANDAMENTO` (sub "leads vivos no funil") · `VENDAS` · `PERDIDOS` · `TAXA DE CONVERSÃO` **teal** (sub "vendas ÷ leads").
3. **Card "Funil completo"** (sub "etapa atual dos leads criados no período — etapas de ganho/perda são terminais, não progresso") — mesmo componente-funil da P1.
4. **Linha 50/50**: chart-card **"Motivos de perda"** (sub "leads perdidos no período", donut) + tabela **"Leads perdidos"** (sub "detalhe (data de criação do lead)"): `CRIADO | ETAPA | MOTIVO | ORIGEM` — ETAPA/ORIGEM em `--text-periwinkle`, "não informado" em cinza apagado.
5. **3 stat cards** (hairline no topo): `TEMPO MÉDIO ATÉ VENDA` (sub "da criação ao fechamento", `—` quando vazio) · `TEMPO MÉDIO ATÉ PERDA` (sub "da criação à perda") · `HISTÓRICO DE ETAPAS` (sub "precisão do tempo em etapa cresce com o histórico").
6. **Linha 50/50**: chart-card **"Tempo médio na etapa atual"** (sub "dias parados por etapa (leads vivos) · **estimativa inicial** — fica preciso conforme o histórico diário acumula") + tabela **"Leads parados há mais dias"** (sub "quem precisa de atenção do atendimento"): `LEAD | ETAPA | DIAS PARADO | RESPONSÁVEL` (DIAS PARADO à direita, ~12 linhas).
7. **Linha 50/50**: **"Valor em negociação por etapa"** (sub: campo "valor" dos leads vivos no CRM — empty state tracejado com instrução) + chart-card **"Perdas por mês × motivo"** (legenda topo-centro).
8. **Banner-rodapé âmbar** com breakdown detalhado dos leads fora de pipeline por origem.

### P3 · Qualificação
Sem KPI cards, funis ou gráficos — 3 banners + 5 cards de tabela.
1. 2 banners âmbar + **banner azul metodológico**: define "**Qualificado** = alcançou **Pré-Qualificado ou além (inclui vendas)**", cobertura de UTM em bold, e "Esta página retrata o estado atual do funil e não usa o filtro de período."
2. **Card "LPs & Origens de captação"** (sub: "LP identificada pelo utm_medium (landing.page-*) · Formulário nativo = Lead Ads pago · Instagram/Facebook sem tráfego pago = orgânico"): `ORIGEM | TIPO | LEADS | QUALIFICADOS | TAXA QUALIF. | VENDAS` — TIPO com badges Pago/Orgânico; QUALIFICADOS em teal bold.
3. **Card "Campanhas"** (sub: "via utm_campaign · detalhe = top criativos da campanha (Leads/Qualificados) · clique na foto para ver o anúncio"): `CAMPANHA | LEADS | QUALIFICADOS | TAXA QUALIF. | VENDAS | TOP CRIATIVOS` — TOP CRIATIVOS = lista de até 3: thumb 20px + nome azul clicável + `(NL/NQ)` cinza; `—` quando vazio.
4. **Card "Criativos"** (sub: "via utm_content · detalhe = campanha de onde vieram · clique na foto para ver o anúncio"): `[thumb sem cabeçalho] | CRIATIVO | LEADS | QUALIFICADOS | TAXA QUALIF. | VENDAS | CAMPANHA` — thumbs 40px; CAMPANHA azul + `(NL/NQ)`.
5. **Card "Públicos"** (sub: "via utm_term (nomenclatura do gestor de tráfego) · detalhe = top criativos do público · clique na foto para ver o anúncio"): `PÚBLICO | LEADS | QUALIFICADOS | TAXA QUALIF. | VENDAS | TOP CRIATIVOS`.
6. **Card "Capital de investimento"** (sub "faixa de capital declarada pelo lead"): empty state tracejado com instrução de ativação via **campo personalizado** no CRM.

### P4 · Meta Ads
1. 2 banners âmbar.
2. **6 KPI cards**: `GASTO` (sub "no período") · `IMPRESSÕES` · `CLIQUES` (sub "CTR 3,4%") · `CPC` · `LEADS PLATAFORMA` (sub "plataforma (referência)") · `CUSTO/LEAD PLAT.` **teal** (sub "meta provisória: até R$ 60,00").
3. **Tabela "Campanhas"** (sub "status real via API · métricas do período filtrado"): `STATUS | CAMPANHA | GASTO | IMPRESSÕES | CLIQUES | CTR | CPC | LEADS PLATAFORMA | CUSTO/LEAD PLAT.` — STATUS com badges Ativo/Pausado.
4. **Tabela "Conjuntos de anúncios"** (sub "agrupado por campanha + conjunto (dimensão real da linha da API)"): `CONJUNTO | CAMPANHA | GASTO | IMPRESSÕES | CLIQUES | LEADS PLATAFORMA | CUSTO/LEAD PLAT. | QUALIDADE` — CAMPANHA em cinza; QUALIDADE com badges Bom/Ruim/Dados insuf.
5. **Tabela "Anúncios"** (sub "criativo × campanha × conjunto · régua provisória de custo/lead plat."): `ANÚNCIO | CONJUNTO | GASTO | CLIQUES | LEADS PLATAFORMA | CUSTO/LEAD PLAT. | QUALIDADE` — ANÚNCIO com thumbnail 48px + nome.
6. **Chart-card "Investimento × Leads CRM (mensal)"** (sub "barras = gasto Meta · linha = leads do pipeline no CRM") — combo com 2 eixos Y.

### P5 · Google Ads *(opcional para Terrana — espelho da P4)*
1. 2 banners âmbar.
2. **6 KPI cards**: `GASTO` (sub "no período") · `IMPRESSÕES` · `CLIQUES` (sub "CTR 1,5%") · `CPC` · `CONVERSÕES` (sub "plataforma (referência)") · `CUSTO/CONVERSÃO` (traço teal quando sem dado).
3. **Tabela "Campanhas"** (sub "status real via API · inclui Performance Max"): `STATUS | CAMPANHA | GASTO | IMPRESSÕES | CLIQUES | CTR | CPC | CONVERSÕES | CUSTO/CONV.`
4. **Tabela "Grupos de anúncios"** (sub "campanhas Performance Max não têm grupos — o total da conta fecha pela tabela de campanhas"): `GRUPO | CAMPANHA | GASTO | IMPRESSÕES | CLIQUES | CTR | CPC | CONVERSÕES | CUSTO/CONV.`
5. **Tabela "Anúncios"** (sub "anúncio × campanha × grupo (Search/Display)"): `ANÚNCIO | GRUPO | GASTO | IMPRESSÕES | CLIQUES | CTR | CPC | CONVERSÕES | CUSTO/CONV.` — nomes em azul-claro + 🔗; fallback "(sem nome)".
6. **Chart-card "Investimento × Leads CRM (mensal)"** (sub "barras = gasto Google · linha = leads do pipeline no CRM") — barras LARANJA nesta página.

### P6 · Institucional & Impulsionamento
1. 2 banners âmbar + **banner azul**: campanhas de impulsionamento são da conta inteira, "Esta página é igual nas duas frentes".
2. **6 KPI cards**: `INVESTIMENTO` (sub "no período") · `ALCANCE` (sub "soma dos alcances diários") · `ENGAJAMENTO` (sub "interações com posts") · `VIEWS DE VÍDEO` · `CUSTO / 1.000 ALCANÇADOS` **teal** · `CUSTO / ENGAJAMENTO` **teal**.
3. **Tabela "Campanhas institucionais"** (sub "status real via API · período filtrado"): `STATUS | CAMPANHA | GASTO | ALCANCE | ENGAJAMENTO | VIEWS | CUSTO/ENGAJ.` — nomes com prefixo `[Engajamento]` / `[Alcance]` / `[Seguidores]`, ordenadas por GASTO desc.
4. **Chart-card "Investimento × Engajamento (mensal)"** — combo com 2 eixos Y.

### P7 · Público
Sem KPI cards nem funis.
1. 2 banners âmbar + **banner azul**: "Dados da Meta com granularidade **mensal** — o filtro de período considera os meses selecionados inteiros."
2. **Grid 2 colunas**:
   - Chart-card **"Investimento por idade e gênero"** (sub "onde o orçamento está sendo gasto") — barras empilhadas.
   - Chart-card **"Leads Plataforma por idade e gênero"** (sub "quem responde aos anúncios") — barras empilhadas.
   - Tabela **"Posicionamentos"** (sub "feed, stories, reels — onde os anúncios rodam"): `POSICIONAMENTO | GASTO | IMPRESSÕES | CLIQUES | CTR | LEADS PLATAFORMA` — 1ª coluna minúsculas no formato "plataforma · posicionamento" (ex.: `instagram · instagram stories`).
   - Chart-card **"Regiões"** (sub "top 12 por investimento") — barras horizontais.

### P8 · Evolução Mensal
Sem KPI cards, tabelas ou funis.
1. 2 banners âmbar + **nota azul** (sem ícone): "Visão mensal completa — não usa o filtro de período do topo."
2. **Grid 2×2 de chart-cards**: "Leads por mês (CRM)" · "Investimento por mês (Meta)" · "Vendas × Perdas por mês" · "Custo/Lead Plat. por mês".

---

## Gráficos

| Página | Gráfico | Tipo | Série(s) e cores | Eixos / formato |
|---|---|---|---|---|
| P1 | Leads por dia | barras verticais | azul `#2874FC`, topo arredondado | Y: 0–18 passo 2; X: datas `dd/mm` rotacionadas ~45°; gridlines horizontais sutis |
| P1 | Investimento por dia | barras verticais | teal `#31CDCF` | Y: `R$ 0`–`R$ 180` passo R$ 20; X: `dd/mm` ~45° |
| P1/P2 | Funil B2B | barras horizontais pill sobre trilha | etapas: gradiente `#2C6BFC→#4429FB`; ganho verde `#0FAB84`; perda vermelha `#DC3636` | valor dentro da barra; `% da anterior` na margem direita |
| P2 | Motivos de perda | donut | vermelho `#EF4444`, traço separador branco ~2px | legenda à direita: swatch + rótulo |
| P2 | Tempo médio na etapa atual | barras horizontais | âmbar `#F59E0B` | Y: categorias `0d…5d`; X: 0–20 passo 2; gridlines verticais sutis |
| P2 | Perdas por mês × motivo | colunas | vermelho `#EF4444` | Y: 0–5,0 passo 0,5 (vírgula decimal); X: `Jul/26`; legenda topo-centro |
| P4 | Investimento × Leads CRM (mensal) | combo barra + linha, 2 eixos Y | barra azul `#2874FC` "Gasto (R$)"; linha teal `#31CDCF` "Leads CRM" | Y-esq: `R$ 0`–`R$ 2500` passo 500; **Y-dir labels em teal**; X: `Mmm/aa`; legenda topo-centro |
| P5 | Investimento × Leads CRM (mensal) | combo barra + linha, 2 eixos Y | barra **laranja** `#F59E0B` "Gasto (R$)"; linha teal "Leads CRM" | Y-esq: `R$ 0`–`R$ 1400` passo 200; Y-dir teal; X: `Mmm/aa` |
| P6 | Investimento × Engajamento (mensal) | combo barra + linha, 2 eixos Y | barra azul `#2874FC` "Gasto (R$)"; linha teal `#31CDCF` "Engajamento" com pontos | Y-esq: `R$ 0`–`R$ 1400` passo 200; Y-dir: 40.000–180.000 passo 20.000 em teal |
| P7 | Investimento por idade e gênero | barras verticais **empilhadas** | Feminino teal `#31CDCF` (base) · Masculino azul `#2874FC` · Não informado cinza `#6D7C96` | Y: 0–1.200 passo 200 (milhar pt-BR); X: `25-34, 35-44, 45-54, 55-64, 65+, Unknown`; gridlines H+V sutis; legenda topo-centro |
| P7 | Leads Plataforma por idade e gênero | barras verticais empilhadas | Feminino teal · Masculino azul | Y: 0–40 passo 5; mesmo X |
| P7 | Regiões | barras horizontais | azul `#2874FC`, canto direito ~4px | X: 0–2.000 passo 200; top 12 por investimento |
| P8 | Leads por mês (CRM) | barras verticais | azul `#2874FC` | Y: 0–160 passo 20; X: `Mmm/aa`; barra larga (~65%) |
| P8 | Investimento por mês (Meta) | barras verticais | teal `#31CDCF` | Y: `R$ 0`–`R$ 2500` passo 500 (sem milhar nos ticks) |
| P8 | Vendas × Perdas por mês | barras verticais agrupadas | Vendas verde `#10B981` · Perdas vermelho `#EF4444` | Y: 0–5,0 passo 0,5 (vírgula); legenda topo-centro |
| P8 | Custo/Lead Plat. por mês | linha com pontos | âmbar `#F59E0B` (1 mês = só o dot) | Y: `R$ 0`–`R$ 35` passo R$ 5 |

Regras gerais de gráfico: fundo transparente sobre o card; gridlines rgba(255,255,255,.04)–`#131D30`; sem gridlines verticais em séries temporais (exceto empilhadas da P7); labels de eixo `#6D7C96` ~11px; legendas com retângulos ~28×14px centralizadas no topo do plot; tooltips e eixos em pt-BR.
