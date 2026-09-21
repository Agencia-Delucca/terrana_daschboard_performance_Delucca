# HANDOFF — Dashboard de Performance da Terrana (Agência Delucca)

Documento único de continuidade. Quem ler **só este arquivo**, com a pasta local
em mãos, consegue retomar o projeto e continuar editando sem quebrar nada e sem
precisar do histórico de conversa anterior.

- **Pasta do projeto:** `C:\Users\geova\OneDrive\Área de Trabalho\Claude\Terrana B2B\terrana-performance`
- **Repositório:** `https://github.com/Agencia-Delucca/terrana_daschboard_performance_Delucca` (branch única `main`)
- **Site oficial:** `https://agencia-delucca.github.io/terrana_daschboard_performance_Delucca/`
- **Último commit:** `b53f1b4` — "Coleta da Meta dentro da grade da agencia (03:10-03:59 BRT)"
- **Foto dos dados citada aqui:** `summary.json` **local** gerado em **17/09/2026 12:40 BRT** (brutos em `data_raw/` recoletados em 17/09 entre 12:41 e 12:46) **e** o `summary.json` **publicado** em **18/09/2026 03:39**, que é o que o cliente vê. Quando os dois divergirem, vale o publicado (§11). Documento escrito em **18/09/2026**.
- **Números de linha** são de 18/09/2026 e saem do lugar a cada edição. Use-os como pista e confirme sempre com `grep` pelo nome da função.

---

## 1. Resumo em 30 segundos

| Pergunta | Resposta |
|---|---|
| **O que é** | Dashboard estático de performance de mídia para o cliente Terrana, no padrão de dashboards da Agência Delucca. SPA em HTML/CSS/JS puro, tema escuro, 100 % em português, com **duas frentes** independentes (B2B Atacado e E-commerce) e uma tela seletora de entrada. |
| **Onde está no ar** | GitHub Pages: `https://agencia-delucca.github.io/terrana_daschboard_performance_Delucca/`. Confirmado no ar em 18/09/2026 06:40 UTC (03:40 BRT), servindo `last_update` "18/09/2026 03:39". |
| **Como atualiza** | GitHub Actions, workflow único `.github/workflows/deploy_pages.yml`, cron `10 6 * * *` = **03:10 BRT**. Coleta Meta → confere o gate → coleta Kommo/planilha/Google → roda o ETL → publica no Pages. Push em `main` que toque `dashboard/**` também republica (sem chamar a Meta). |
| **Fontes** | Kommo CRM · Meta Ads API · Google Ads API (GAQL v22, via MCC da agência) · planilha do Google Sheets alimentada pelo formulário nativo da Meta. |
| **Contrato interno** | Tudo vira um único `dashboard/data/summary.json` (~1,1 MB). O front **só** conhece esse arquivo. |
| **Estado atual** | Em produção, **fase-ponte**: dados embutidos no site público, **sem login**. Custo de infra R$ 0. O código de login (Supabase Auth + bucket privado) está escrito nas duas pontas e desligado por constantes vazias. |
| **Meta: já destravou** | A coleta da Meta **voltou a rodar em 18/09/2026 03:10 BRT**, no primeiro disparo do cron novo. O summary publicado (18/09 03:39) traz `totals.meta_rows = 1.067` e séries da Meta até **2026-09-18**; o gate `--verificar` devolveu `pronto=true` e o Pages republicou. |
| **A cópia local está atrasada** | `data_raw/meta_*.json` param em **10/09** e `meta_coleta_estado.json` está vazio **porque o cache incremental da Meta vive no `actions/cache` do runner, não nesta máquina** (§10.6). Isso **não** é sinal de coleta parada. Antes de investigar qualquer coisa, baixe `data/summary.json` do site e compare (§11). |
| **Pendência nº 1** | **A planilha do formulário**, essa sim, continua parada: o summary no ar ainda traz `planilha_total = 444` e último envio em **25/08/2026**. É ela que dá a atribuição por criativo. Ver §14.1. |
| **Riscos que quebram o cliente** | Chamar a Meta fora da janela 03:10–03:59 BRT (derruba a coleta de outros clientes da agência); somar receita Meta + Google; deixar nome/telefone de lead sair por qualquer canal (site, artifact, print, anexo); inventar número onde o dado não existe. Ver §3. |

---

## 2. Comece por aqui

### 2.1 Método obrigatório de leitura (antes de abrir qualquer arquivo)

Alguns arquivos são grandes demais para leitura integral — lê-los inteiros
estoura o contexto e você perde a sessão.

| Arquivo | Tamanho | Como ler |
|---|---|---|
| `dashboard/assets/app.js` | 3.986 linhas · 211 KB | `grep -n` para achar a função, depois leitura com `offset`/`limit` ≤ 200 linhas |
| `dashboard/assets/style.css` | 739 linhas · 108 KB | contém **3 `@font-face` com Montserrat em base64** (~25 KB cada, em linha única). Leia só o `:root` e a regra alvo |
| `dashboard/index.html` | 88 linhas · 75 KB | o logo e o favicon são **PNG base64 inline** (62.798 e 9.542 caracteres, cada um em uma linha só) |
| `scripts/generate_dashboard_data.py` | 1.289 linhas | `grep -n "^def "` e leia só a função alvo |
| `dashboard/data/summary.json` | ~1,12 MB | **nunca** `cat`. Sempre `python` com prints curtos |
| `data_raw/kommo_events.json` | 5,2 MB | idem |

Para inspecionar dados, use Python com saída curta:

```bash
python -c "import json;d=json.load(open('dashboard/data/summary.json',encoding='utf-8'));print(list(d.keys()))"
python -c "import json;d=json.load(open('dashboard/data/summary.json',encoding='utf-8'));print(d['meta_b2b']['matching'])"
```

**Nunca** imprima o conteúdo de `.env`, de tokens, de senhas ou de chaves.
**Nunca** copie nome, telefone ou e-mail de lead para log, chat ou commit.
Editar `app.js` reescrevendo o arquivo inteiro é a forma mais fácil de perder o
data URI da fonte ou do logo — **edite sempre por trecho**.

### 2.2 O que ler primeiro, nesta ordem

1. Este documento, §3 (regras inegociáveis) — é o que protege o cliente e os outros clientes da agência.
2. `README.md` — visão do produto e a grade da Meta. **Atenção:** está desatualizado em quatro pontos (§13.9).
3. `dashboard/assets/app.js`, linhas 1–70 — o cabeçalho declara as regras de dataviz e a paleta.
4. `scripts/generate_dashboard_data.py`, função `main()` (linha 1162) — a ordem exata do pipeline.
5. `collectors/meta_ads_api.py`, linhas 44–114 — as constantes de governo e a função `janela_atual()`.
6. `docs/SPEC_VISUAL_REFERENCIA.md` — estrutura e anatomia dos componentes (as **cores** de lá estão obsoletas, ver §9).

### 2.3 Rodar local

```bash
cd "C:\Users\geova\OneDrive\Área de Trabalho\Claude\Terrana B2B\terrana-performance"
pip install -r requirements.txt                            # requests, python-dotenv, supabase, google-auth

set PYTHONUTF8=1                                           # Windows: obrigatório (cmd);  PowerShell: $env:PYTHONUTF8=1
python main.py                                             # coleta ~3 min; a Meta NÃO é chamada, vem do cache
python scripts/generate_dashboard_data.py                  # gera dashboard/data/summary.{json,js}
python -m http.server 8010 -d dashboard                    # abre em http://localhost:8010
```

Variações úteis:

```bash
python main.py --sem-meta                                  # o que o workflow faz (pula a Meta)
python -m collectors.meta_ads_api                          # NÃO chama a Meta: sai no 1º portão (ver abaixo)
python -m collectors.meta_ads_api --verificar              # o cache está pronto para publicar? (só lê, é seguro)
```

⚠ **`python -m collectors.meta_ads_api` local nunca chama a Meta.** `config.py:32` lê
`META_COLETA` com default `"nao"` e **a variável não existe no `.env` — isso é
proposital**. Sem `META_COLETA=sim` no ambiente, o coletor grava o cache e sai com
"coleta desligada nesta execução", **mesmo às 03:30 BRT**. Não conclua que
"coletou". Quem ligar a variável para valer precisa ler a §3.3 inteira antes: o dado
coletado aqui **não chega ao site** (§14.1) e a rajada é somada à do cron.

- **Mexer só no front dispensa coleta e ETL**: o `summary.json` já está em disco; basta subir o `http.server` e recarregar.
- `dashboard/index.html` também abre com **duplo clique**, porque `data/summary.js` define `window.__SUMMARY__` (em `file://` o `fetch` é bloqueado, o `<script src>` não).
- No Windows, **sempre** `PYTHONUTF8=1` (ou `chcp 65001`): sem isso o console cp1252 quebra no caractere `≠` de `meta_ads_api.py:555`.

**Testar o login do Supabase localmente:** os passos 1 e 2 de `loadData()`
(`window.__SUMMARY__` e `fetch('data/summary.json')`) **sempre vencem** em
localhost, então a tela de login não aparece em dev nem com as constantes
preenchidas. Para exercitar `showLogin()`, mova `dashboard/data/summary.js` e
`summary.json` para fora da pasta temporariamente (a tag `<script src="data/summary.js">`
de `index.html:85` continua lá e **deve** dar 404 — é o esperado). Ver §14.2.

### 2.4 Publicar

| Mudou o quê | O que fazer | O que acontece |
|---|---|---|
| Qualquer coisa em `dashboard/**` | `git pull --rebase` → commit → push em `main` | O filtro `paths` casa, o workflow roda **sem chamar a Meta**, o ETL regenera o summary com o cache da Meta e o Pages republica em ~3–5 min |
| ETL, coletores, `config.py`, `main.py`, `README.md` | commit + push **não publica nada** | Rode manualmente: GitHub → **Actions** → "Deploy Dashboard (GitHub Pages)" → **Run workflow** → branch `main`, **as duas caixas desmarcadas** |
| Precisa de dado novo da Meta | Só o cron das 03:10 BRT, ou dispatch manual com `coletar_meta` marcado **dentro** de 03:10–03:59 BRT | Fora da janela o coletor ignora e sai com `::warning::` |

O `gh` CLI **não está instalado** nesta máquina; use a interface web do GitHub.

### 2.5 Testar

```bash
set PYTHONUTF8=1
python -m unittest discover -s tests -t .        # 24 testes: 16 do coletor da Meta + 8 da origem por DDD, sem rede
```

`tests/test_regioes.py` (8 testes) cobre a tabela de DDDs, os formatos de telefone
(com/sem 55, 0 de longa distância, exterior, inválido) e a agregação `crm_regiao`
(soma = total de leads, formulário pela tag, nenhum dado pessoal no resultado).

Os 16 testes (`tests/test_meta_coleta.py`, 348 linhas) usam sessão HTTP e relógio
falsos e cobrem exatamente as travas da grade: fora da janela não chama, coleta
desligada não chama nem na janela, horário comercial só com liberação, não começa
chamada no último minuto, depois das 03:45 só o essencial, uso > 30 % (de app e de
business use case) para a rodada, erro #4 espera 15 min e tenta de novo, erro #4
sem tempo desiste, segundo erro de limite encerra, primeira noite completa e leve,
segunda noite só lê o que muda, histórico interrompido não fica pronto, renomear
campanha vale para o histórico, paginação segue `next` com token no cabeçalho,
erro comum pula a tarefa sem retentar.

**Qualquer alteração em `collectors/meta_ads_api.py` tem que passar nesses testes
antes de ir para `main`.** Eles são a única rede de proteção contra derrubar a
coleta dos outros clientes da agência.

Não há teste automatizado do ETL nem do front: a conferência é rodar o ETL local e
comparar os totais com a §11, e abrir as duas frentes no navegador.

---

## 3. Regras inegociáveis

### 3.1 Regras de ouro do produto (blueprint da agência)

| # | Regra | O que quebra se violar |
|---|---|---|
| 1 | **CPL = gasto ÷ leads do CRM.** Métrica de plataforma (`leads_plat`) é referência, nunca denominador | Número bonito e falso: a plataforma conta lead que nunca virou negócio |
| 2 | **Status Ativo/Pausado vem da API** (`effective_status`), nunca de heurística. Ausente → `—` | Campanha pausada aparecendo como ativa na reunião com o cliente |
| 3 | **Toda tabela com filtro de dia consome fonte diária** (`*_daily`) | O filtro de período devolve vazio ou números do total |
| 4 | **Atribuição por dimensão real** — sem inventar granularidade (§11.3) | CPL por criativo que não existe |
| 5 | Rateio proporcional ao gasto quando houver ambiguidade — nunca duplicar | Soma das partes maior que o todo |
| 6 | **Decomposição ≤ KPI** — checado automaticamente no ETL (`generate_dashboard_data.py:1262-1267`); violou → `exit 1` | Build falha de propósito, em vez de publicar número inflado |
| 7 | **Nunca falhar em silêncio** — `::error::`/`::warning::` no CI, banner no front, gate de secrets antes de tudo | Workflow verde com dado errado |
| 8 | Perdido = etapa **143**, ganho = **142** (IDs de sistema do Kommo); motivo vazio vira "Não informado" | Ganho/perda inferido por nome de etapa quebra quando renomearem a etapa |
| 9 | **Nada de dado real hardcoded** | — |
| 10 | Preview antes de produção | — |

### 3.2 Regra de atribuição — receita Meta e Google **nunca** se somam

Escrita em três lugares do código (`app.js` 1268, 2354–2357 e 2724):

> Compras e receita da **Meta** vêm do **pixel**. Conversões e valor do **Google**
> vêm da **atribuição da própria plataforma**. São atribuições independentes,
> cada uma reivindicando a mesma venda.
> **O único número agregável entre plataformas é o investimento.**

Por isso o front mostra **"ROAS Meta (pixel)"** e **"ROAS Google (atribuição)"**
lado a lado, jamais um "ROAS total". Somar R$ 17.943,78 + R$ 14.211,17 é **erro de
produto**, não de arredondamento. Se alguém pedir "receita total", a resposta
honesta é: só existe quando a loja mandar o pedido pago real (§14.3).

### 3.3 A GRADE DA META (a regra operacional mais perigosa do projeto)

Todos os dashboards da Agência Delucca usam o **mesmo app da Meta — "Delucca dash
criativos", id `639332675906356`** — e o rate limit da Ads Insights API é **do app
inteiro**, não da conta. Uma rajada aqui derruba a coleta de outro cliente com
`(#4) Application request limit reached`. Por isso cada dashboard tem a sua hora.

**Este dashboard (conta `act_1508321467453573`): 03:10 às 03:59 BRT = 06:10 às
06:59 UTC. Cron `10 6 * * *`.**

| Brasília | UTC | Dashboard |
|---|---|---|
| 19:10 às 23:59 | 22:10 às 02:59 | Cronograma de clientes, um grupo por hora |
| 00:07 | 03:07 | Gallant, reels (leve) |
| 01:10 | 04:10 | Clínica da Cidade B2C |
| 02:10 | 05:10 | Clínica da Cidade Juazeiro |
| **03:10** | **06:10** | **Terrana (este)** |
| 04:10 | 07:10 | Cronograma de clientes, fechamento do dia |
| 05:10 | 08:10 | LDB |
| 06:10 | 09:10 | Orizen |
| 07:10 | 10:10 | Gallant, sincronização diária |
| 08:10 | 11:10 | Najwah |

O minuto `:10` (e não `:00`) é proposital: o GitHub atrasa agendamentos e, sob
carga, **descarta** os marcados na hora cheia. Todo dashboard da agência usa `:10`
(exceção: Gallant reels, `:07`).

**O que NUNCA fazer:**

1. **Nunca chamar a API real da Meta fora de 03:10–03:59 BRT.** Carga pesada,
   backfill ou teste com API real só nessa janela — ou, **combinado antes com quem
   responde pela grade na Agência Delucca** (`confirmar com ___`: nome e canal não
   estão registrados; pergunte à gestora antes de usar a janela comercial), das
   09:10 às 18:59 via dispatch manual com `coletar_meta` **e** `janela_comercial`
   marcados. Nunca na hora de outro dashboard.
2. **Nunca criar outro app na Meta nem trocar de token para fugir do limite.** Em
   16/09/2026 a agência pediu o "Marketing API Access Tier" para este app;
   enquanto a análise estiver aberta, **cada erro #4 conta na taxa de erro
   avaliada, que precisa ficar abaixo de 15 % nas últimas 500 chamadas**.
   Fragmentar em outro app atrapalha a análise.
3. **Nunca mexer no `cron`** sem falar com a agência — o horário é alocado.
4. **Nunca testar lógica do coletor contra a API real**: use `tests/test_meta_coleta.py`.
5. **Nunca rodar a coleta da Meta nesta máquina com `META_COLETA=sim` dentro de
   03:10–03:59.** Seria a **mesma janela e o mesmo app compartilhado** (`639332675906356`)
   que o cron está usando: a rajada dobra e pode estourar o `#4` do dashboard
   seguinte — com a análise do Access Tier aberta (item 2), cada erro conta. E não
   adianta: o bruto coletado aqui **não chega ao site** (`data_raw/` é gitignored e
   a produção monta tudo a partir do `actions/cache` do runner). Ver §14.1.

Kommo e Google Ads **não** entram nessa grade.

### 3.4 Gate de dado pessoal (PII)

| Onde | Regra |
|---|---|
| `data_raw/kommo_contacts.json` (2.006 contatos) e `data_raw/form_sheet.json` (444 envios) | Contêm **nome, telefone e e-mail** de leads reais. Não versionar, não subir para artefato público, não colar em chat, não imprimir em log. Já barrados pelo `.gitignore` |
| `summary.json` | `expor_pessoais = bool(config.SUPABASE_SERVICE_KEY)` (`generate_dashboard_data.py:1185`). É o **único** ponto do summary com PII: decide se `crm.leads_parados` sai com nome/telefone (`:426-439`) ou como `{"disponivel": false, "motivo": "..."}` |
| Cache do GitHub Actions | **Só os 6 arquivos `meta_*.json`** (métrica de anúncio, sem PII) são cacheados. Kommo e planilha são recoletados do zero toda execução, de propósito |
| **Qualquer publicação** — Pages, artifact do claude.ai, anexo, print, planilha ou chat | Enquanto não houver login, **nada de nome/telefone sai daqui por nenhum canal**. Não existe canal "de rascunho" para PII: artifact (§13.8), print e anexo circulam igual ao site. Ligar o Supabase e expor PII são a **mesma** tarefa, feita junto (§14.2) |
| Bucket do Supabase, depois de ligado | O summary passa a ter nome e telefone. Ele só pode viver em **bucket privado com policy por e-mail** e com o cadastro público fechado — senão a anon key versionada num repo **público** vira porta de entrada (§14.2, passos 3 e 4) |

Racional: o site é publicado em GitHub Pages **público**. Nome e telefone só saem
quando a publicação for autenticada.

### 3.5 Dataviz (as regras já implementadas — manter)

1. **Séries só da paleta validada `S`**: mostarda `#BD8A0C`, terracota `#A64114`, oliva `#74A335` (`app.js:54`). Validada para contraste e daltonismo. Os acentos vivos da marca (`P.accent #E0A526`, `P.accent2 #C9622A`) são **só de UI** — nav, gradiente, KPI-destaque. Misturar os dois conjuntos quebra a leitura "cor = dado".
2. **Eixo duplo é proibido.** Todo combo é *small multiples*: dois `<canvas>` empilhados no mesmo eixo X, via `multiChartCard()` (`app.js:202`) + `lockYWidth()` (`:454`).
3. **Nominal = uma cor só** (regiões, motivos de perda, campanhas): terracota, diferenciada por posição e rótulo — nunca arco-íris.
4. **Ordinal = rampa de um matiz**: `AMBER_RAMP` de 6 passos (`app.js:62`), claro→escuro. O extremo antigo `#453107` foi **reprovado** no validador (1,49:1) e removido; não reintroduzir tons mais escuros.
5. **Terracota exige relief.** `#A64114` tem 2,99:1 sobre o fundo: toda série terracota vem com rótulo direto (plugin `directLabels`, `:347`) **ou** com `reliefTable()`/`dailyRelief()` (`:254`/`:258`). Remover o relief é regressão de acessibilidade.
6. **Texto nunca na cor da série** — rótulo direto em `P.soft`, eixos em `P.muted`.
7. **Cores de status são reservadas**: `#10B981` ganho, `#EF4444` perda, `#F59E0B` alerta. Nunca como cor de série.
8. **Todo gráfico nasce em `makeChart()`** (`app.js:414`) e o registry `CHARTS` é destruído a cada `route()` (`destroyAllCharts`, `:408`). `new Chart()` direto vaza memória e duplica canvas.
9. **Formato 100 % pt-BR** em tudo, inclusive tooltips e ticks (`fmt`, `app.js:68-87`). Ausência = `—`, nunca `0`.
10. **Estado honesto**: meta em 0 → "meta não definida"; KPI sem dado → `.kpi-dash`; dado que depende de GA4/loja → `.prep-card`. **Nunca preencher com estimativa disfarçada de número real.**

---

## 4. Mapa dos arquivos

### 4.1 Versionados

| Arquivo | Papel |
|---|---|
| `main.py` (74 l.) | Orquestra a coleta e grava `data_raw/*.json`. Gate de secrets essenciais → `exit 1`. `--sem-meta` pula a Meta (o que o workflow faz) |
| `config.py` (78 l.) | Todas as variáveis de ambiente + constantes não-env (`KOMMO_STATUS_GANHO=142`, `KOMMO_STATUS_PERDIDO=143`), janela da Meta, metas/orçamentos, `PAID_SOURCES_META/GOOGLE`, caminhos |
| `collectors/kommo.py` (284 l.) | CRM Kommo, API v4, somente leitura. 5 req/s, páginas de 50 |
| `collectors/meta_ads_api.py` (646 l.) | Meta Ads com grade de horário e cache incremental. **O arquivo mais delicado do projeto** (§6.2) |
| `collectors/google_ads.py` (150 l.) | Google Ads, GAQL v22 via REST, acesso pela MCC da agência |
| `collectors/form_sheet.py` (96 l.) | Planilha do formulário nativo (Sheets API v4, service account). Fallback para o último snapshot |
| `scripts/generate_dashboard_data.py` (1.289 l.) | **ETL**. Transforma `data_raw/*` em `summary.json` + `summary.js`; upload opcional ao Supabase |
| `dashboard/index.html` (88 l.) | Casca estática: sidebar, login, seletor, topbar com filtro, footer. Chart.js 4 via CDN. **Nenhum conteúdo** — tudo é injetado por `innerHTML` |
| `dashboard/assets/app.js` (3.986 l.) | Todo o front: roteamento, filtros, render de 16 páginas, gráficos, login |
| `dashboard/assets/style.css` (739 l.) | Tokens `:root` + componentes + Montserrat embutida em base64 |
| `docs/SPEC_VISUAL_REFERENCIA.md` (215 l.) | Spec do blueprint visual da agência (origem: dashboard Dr. Move). Vale para estrutura e anatomia; **as cores estão obsoletas** (§9.4) |
| `docs/HANDOFF_CONTINUIDADE.md` | Este documento |
| `tests/test_meta_coleta.py` (348 l.) | 16 testes do coletor da Meta, sem tocar na API |
| `regioes_br.py` | Tabela dos 67 DDDs → UF, cidade-polo e área; nome e região de cada UF; `localizar(telefone)` |
| `tests/test_regioes.py` | 8 testes da origem geográfica (DDD → estado) e da agregação `crm_regiao` |
| `.github/workflows/deploy_pages.yml` (169 l.) | **Único** workflow: coleta + ETL + deploy |
| `requirements.txt` | `requests`, `python-dotenv`, `supabase`, `google-auth` |
| `.env.example` | Nomes das variáveis (sem valores). **Defasado**: faltam `GOOGLE_SA_JSON` e os cinco `ORCAMENTO_*` que existem no `.env` real |
| `.gitignore` | Barra `.env`, `data_raw/`, `dashboard/data/summary.{json,js}`, `__pycache__/`, `.netlify` |

### 4.2 Não versionados (estão na pasta local)

| Arquivo | Conteúdo | Observação |
|---|---|---|
| `.env` | Credenciais reais | **Nunca commitar, nunca imprimir.** 22 variáveis (6 a mais que o `.env.example`) |
| `data_raw/kommo_leads.json` | 1.864 negócios · 798 KB | |
| `data_raw/kommo_contacts.json` | 2.006 contatos · 178 KB | **PII** |
| `data_raw/kommo_events.json` | 25.211 eventos · 5,2 MB | |
| `data_raw/kommo_talks.json` | 50 conversas **abertas** | |
| `data_raw/kommo_statuses.json` | 8 etapas do Funil B2B | |
| `data_raw/form_sheet.json` | 444 envios do formulário · 226 KB | **PII** |
| `data_raw/google_ads.json` / `google_status.json` | 121 linhas campanha×dia / 2 campanhas | |
| `data_raw/meta_ads.json` | 990 linhas anúncio×dia · 1,1 MB | cobre 22/05 → **10/09/2026** |
| `data_raw/meta_breakdowns.json` | 1.259 / 582 / 498 itens | idade-gênero, posicionamento, região |
| `data_raw/meta_status.json` | 53 campanhas com `effective_status` | |
| `data_raw/meta_campaigns.json`, `meta_creatives.json`, `meta_coleta_estado.json` | **vazios (2 bytes)** | ver §13.4 |
| `dashboard/data/summary.{json,js}` | Saída do ETL · 1,12 MB | |
| `.netlify/` | Resíduo da hospedagem abandonada em 05/08/2026 | Sem efeito, ignorar |

---

## 5. Fluxo de dados ponta a ponta

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ FONTES (leitura via API, read-only)                                           │
│  Kommo CRM v4      Meta Ads API      Google Ads API v22     Google Sheets     │
│  (leads, contatos, (insights,        (GAQL, via MCC)        (planilha do       │
│   talks, eventos)   breakdowns)                              formulário)      │
└───────┬───────────────────┬────────────────────┬────────────────┬─────────────┘
        │                   │                    │                │
        ▼                   ▼                    ▼                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ COLETA — main.py + collectors/*.py           (no CI: passos 4 e 7 do workflow)│
│   grava JSON bruto em data_raw/                                               │
│   kommo_{leads,contacts,talks,events,statuses}.json · form_sheet.json         │
│   google_{ads,status}.json · meta_{ads,status,breakdowns,creatives,           │
│                                     campaigns,coleta_estado}.json             │
│   ↑ os 6 meta_* são CACHE INCREMENTAL (viajam pelo actions/cache)             │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │  único contrato entre as camadas:
                                │  nome + formato dos arquivos em data_raw/
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ GATE — python -m collectors.meta_ads_api --verificar                          │
│   pronto = há linhas E coberto_ate >= recente_desde - 1 dia                   │
│   pronto=false  →  NÃO publica (site fica na última versão boa)               │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ ETL — scripts/generate_dashboard_data.py     (puramente local, sem rede)      │
│   enriquecer_com_planilha → resolver_fontes → match_leads_meta →              │
│   aggregate_* → build_otimizacao → build_relatorio → sanidade → grava         │
│   SAÍDA: dashboard/data/summary.json (1,1 MB) + summary.js (window.__SUMMARY__)│
│          (+ upload opcional ao bucket dashboard-data do Supabase)             │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ PUBLICAÇÃO — actions/upload-pages-artifact (path: dashboard/) + deploy-pages  │
│   HOJE (fase-ponte):  summary embutido no site público, sem login             │
│   DEPOIS (autenticada): summary apagado do artefato; front baixa do bucket    │
│                         privado do Supabase após login                        │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ FRONT — dashboard/index.html + assets/app.js                                  │
│   loadData(): 1) window.__SUMMARY__  2) fetch summary.json  3) login Supabase │
│   roteamento por hash → FRONTS.b2b (9 páginas) · FRONTS.ecom (7 páginas)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

Nenhum coletor fala com o front. O front não conhece nenhuma API. **O único
contrato do front é o `summary.json`.**

---

## 6. Coleta

`python main.py` → grava `data_raw/*.json`. Ordem fixa (`main.py:43-64`):
Meta Ads → Kommo (`get_structure` → `get_leads` → `get_contacts` → `get_talks` →
`get_events`) → planilha do formulário → Google Ads.

Dois cortes duros do orquestrador:
- `get_leads` vazio → `sys.exit(1)` **sem salvar nada** (`:51-52`) — não sobrescreve um `kommo_leads.json` bom com lista vazia;
- no fim, cache da Meta vazio → `::error::` + `exit 1` (`:66-68`).

O gate de secrets (`:33-41`) exige `KOMMO_SUBDOMAIN`, `KOMMO_TOKEN`,
`META_ACCESS_TOKEN` e `META_AD_ACCOUNT_ID` — **mesmo com `--sem-meta`** (armadilha
conhecida, §13.5).

### 6.1 Kommo — `collectors/kommo.py` (284 l.)

API v4, somente leitura. Base `https://<subdominio>.kommo.com/api/v4`, header
`Authorization: Bearer`.

- **Vazão:** `MAX_REQUESTS_PER_SECOND = 5` (`_throttle`, `:65-72`). **A API corta acima de 7 req/s e devolve 403 com bloqueio de IP.**
- **Paginação:** `PAGE_SIZE = 50` (acima disso a API devolve 504). Para quando não há `_links.next`.
- **Erros** (`:86-105`): 204 → `None`; 401 → `KommoError` ("token expirou/revogado"); 403 → escopo ou IP; 429/5xx → retry `2**tentativa` respeitando `Retry-After`, até 4 tentativas. Timeout 30 s.

| Função | Endpoint | Arquivo gerado |
|---|---|---|
| `get_structure` (`:155`) | `leads/pipelines` + `paginate("users")` | `kommo_statuses.json` — 8 registros `{id, pipeline_id, pipeline, etapa, sort, type}`; os usuários ficam em memória e viram `responsavel` no lead |
| `get_leads` (`:201`) | `paginate("leads", {"with":"contacts,loss_reason"})` | `kommo_leads.json` — 1 registro por lead (1.864 hoje) com `id, contato_id, nome, etapa, etapa_id, pipeline_id, ganho, perdido, motivo_perda, criado_em, fechado_em, valor, responsavel` + 8 colunas de rastreamento (`utm_*`, `referrer`, `gclid`, `fbclid`). Datas em ISO **BRT (UTC−3)** |
| `get_contacts` (`:182`) | `paginate("contacts", {"with":"leads"})` | `kommo_contacts.json` — **dict** `{contact_id: {nome, telefone, email}}`, chaves string no JSON. **PII** |
| `get_talks` (`:231`) | `paginate("talks")` | `kommo_talks.json` — **só conversas ABERTAS** (50 hoje). O total histórico vem dos eventos `talk_created` |
| `get_events` (`:246`) | `paginate("events")` em 3 grupos: chat (in/out), talks (created/closed/missed), funil (lead_added/status_changed), janela `KOMMO_EVENT_DAYS = 180` | `kommo_events.json` — 25.211 eventos, ~5 MB, ordenado por `created_at` |

Volume por rodada: ~38 páginas de leads + ~41 de contatos + ~505 de eventos ⇒ os
"~3 min" do README a 5 req/s.

### 6.2 Meta Ads — `collectors/meta_ads_api.py` (646 l.)

Leia a §3.3 antes de tocar neste arquivo.

**Portões antes de qualquer chamada** (`coletar()`, `:548-574`): `META_COLETA != "sim"`
→ grava cache e sai; token/conta ausentes → `::error::` e sai; `janela_atual()`
(`:106-114`) devolve `None` fora da grade → `::warning::` e sai. **Em todos esses
caminhos `gravar_cache()` ainda roda.** Quando decide chamar, escreve
`chamou_meta=true` em `$GITHUB_OUTPUT`.

O **primeiro** portão é o que desarma a coleta local: `config.py:32` lê `META_COLETA`
com default `"nao"` e **o `.env` não traz essa variável de propósito** — só o
workflow a liga (§10.1). Rodar o coletor nesta máquina, em qualquer horário, para
no portão 1 (§2.3).

**Constantes de governo** (`:44-63`): `JANELA_NOTURNA = (06:10, 06:59) UTC` ·
`SO_ESSENCIAL_APOS = 06:45 UTC` (03:45 BRT) · `JANELA_COMERCIAL = (12:10, 21:59) UTC`
só com `META_JANELA_COMERCIAL=sim` · `LIMITE_USO_PCT = 30` ·
`ESPERA_APOS_LIMITE_S = 900` · `MARGEM_FIM_S = 60` · `FOLGA_PARA_RETENTAR_S = 180` ·
`TIMEOUT_CHAMADA_S = 45` · pausa entre chamadas 1 s (noturna) / 3 s (comercial) ·
`DIAS_RELEITURA = 8` · `MAX_DIAS_RELEITURA = 62` · `CODIGOS_LIMITE = {4,17,32,613} ∪ 80000..80014`.

**Leitura de uso** (`_ler_uso`, `:117-148`): achata `x-app-usage`,
`x-business-use-case-usage` e `x-fb-ads-insights-throttle` em percentuais. Qualquer
um **acima de 30 %** marca `uso_alto` e a próxima chamada levanta `PararRodada`.

**As 6 tarefas da rodada** (`:579-586`), em ordem:

| # | Tarefa | Essencial | O que faz |
|---|---|---|---|
| 1 | `tarefa_campanhas` | **sim** | `act_<id>/campaigns`. **Renomeia `linha["campanha"]` no histórico inteiro** casando `campaign_id` (`:385-388`) — renomear campanha na Meta vale retroativo |
| 2 | `tarefa_insights_recentes` | **sim** | `act_<id>/insights` `level=ad`, `time_increment=1`. Relê `hoje-7..hoje`; se houve noite sem coleta, estende para trás até caber em 62 dias |
| 3 | `tarefa_historico` | não | Backfill mês a mês. Antes, **1 chamada leve** `level=account, monthly, fields=spend` descobre quais meses tiveram gasto — meses sem veiculação nunca são pedidos. **Persiste `coberto_ate` a cada mês** |
| 4 | `tarefa_anuncios_ativos` | não | `act_<id>/ads` filtrando `effective_status IN [ACTIVE]`, reconferindo linha a linha |
| 5 | `tarefa_criativos_faltantes` | não | GET em lote (até 50 ids) só para `ad_id` novos — anúncio pausado não troca de criativo, lê-se uma vez na vida |
| 6 | `tarefa_breakdowns` | não | `age_gender`, `placement`, `region`, `level=campaign`, `monthly`. Relê só os meses faltantes + o corrente (nos dias 1–7, também o anterior) |

Na janela noturna, **a partir das 03:45 as tarefas não essenciais são puladas**.

**Tratamento de erro** (`:596-621`): `LimiteDaMeta` → salva, `::warning::`, espera
15 min **uma única vez** se ainda couber na janela; `PararRodada` (fim de janela ou
uso > 30 %) → salva e encerra; `ErroDaMeta` (qualquer outra falha, inclusive rede)
→ `::warning::`, pula a tarefa e segue. **Em todo caso o que já foi coletado fica
gravado** — a rodada nunca perde trabalho feito. A mensagem do `requests` é
descartada de propósito: pode conter a URL com o token.

**Os 6 arquivos de cache** (`ARQUIVOS`, `:72-79`):

| Arquivo | Tipo | Conteúdo |
|---|---|---|
| `meta_ads.json` | lista | 1 objeto por **anúncio × dia**: `data, campaign_id, campanha, adset_id, conjunto, ad_id, anuncio, gasto, impressoes, cliques, cliques_link, leads_plat, conversas, engajamento, video_views, seguidores, compras, valor_compras, thumbnail, permalink` |
| `meta_status.json` | dict | `{nome_da_campanha: effective_status}` — **derivado**, não coletado; `ACTIVE` vence em nomes repetidos |
| `meta_breakdowns.json` | dict | `{age_gender|placement|region: [itens]}` |
| `meta_creatives.json` | dict | `{ad_id: {nome, thumbnail, permalink, atualizado_em}}` |
| `meta_campaigns.json` | dict | `{campaign_id: {nome, status}}` |
| `meta_coleta_estado.json` | dict | `coberto_ate`, `recente_desde`, `ultima_leitura_recente`, `meses_com_gasto` (temporário), `rodadas[]` (as 20 últimas) |

**Os três marcos de data:** `coberto_ate` = último dia com histórico completo e
contínuo desde `META_SINCE`; `recente_desde` = primeiro dia da última leitura
recente; `ultima_leitura_recente` = último dia lido. `dado_pronto()` (`:354-365`)
exige linhas **e** `coberto_ate >= recente_desde - 1 dia`.

`gravar_cache()` (`:335-351`) tem efeito colateral: carimba `thumbnail`/`permalink`
em cada linha, redireciona `status` a partir de `campanhas` e **regrava os seis
arquivos sempre**. `carregar_cache()` é à prova de arquivo corrompido: JSON
inválido vira o default, sem exceção.

`CAMPOS_INSIGHTS` não pede **alcance** de propósito: reach não é aditivo (o front
explica isso em `app.js:3456`).

### 6.3 Google Ads — `collectors/google_ads.py` (150 l.)

- `API_VERSION = "v22"` **hardcoded** (`:21`), independente de `META_API_VERSION`.
- `_token()` (`:39-52`): troca o refresh token por access token e guarda num global de módulo — uma obtenção por processo.
- `_search(gaql)` (`:55-89`): POST em `googleAds:search` com headers `Authorization`, `developer-token` e, se configurado, **`login-customer-id` (a MCC da agência)** — a conta da Terrana (223-460-7566) **não é acessível direto** pelo usuário OAuth (descoberto por chamada de API em 31/07/2026). Pagina até 50 páginas; retry 4× em 429/500/503; timeout 90 s.
- `get_campaign_daily(since)` → `google_ads.json`, 1 linha por campanha × dia: `data, campanha, status, gasto, impressoes, cliques, conversoes, valor_conversoes`. **Sem filtro de custo, de propósito** (regra de ouro 2: com filtro, campanha pausada sumiria da tabela). `gasto = cost_micros/1e6`.
- `get_campaign_status()` → `google_status.json`: `{nome: ENABLED|PAUSED|REMOVED}`. Erro → `{}` + `::error::`; o front mostra `—`, nunca chuta.
- Sem as 5 credenciais (`credenciais_completas()`), a coleta é pulada com `::warning::` e listas vazias — **não quebra o pipeline**.
- **O range reusa `META_SINCE`** (`:98`): mudar `META_SINCE` mexe nas duas fontes.

### 6.4 Planilha do formulário — `collectors/form_sheet.py` (96 l.)

Planilha "Banco de dados Formulário CRM" (`FORM_SHEET_ID`, default
`1HobjO8Fun5dX69WXqSX0bdYOFUx6UADoJ3gvMAUqbFI`), range fixo **`A:S`**. É o elo de
atribuição real que as UTMs não dão: traz anúncio/conjunto/campanha/plataforma +
telefone/e-mail de cada envio.

- **Credencial:** `GOOGLE_SA_JSON_B64` (base64 do JSON do service account, usado no CI) **ou** `GOOGLE_SA_JSON` (caminho de arquivo, dev). A planilha precisa estar compartilhada como **Leitor** com o e-mail do service account (`dashboard-sheets@dashboard-marketing-495617.iam.gserviceaccount.com`).
- **Fallback duplo** (`:38-44`, `:57-65`): sem SA → `::warning::` + último snapshot; exceção na chamada → `::error::` + mesmo snapshot; sem snapshot → `[]`. **Consequência: o pipeline fica verde com dado velho** (§13.2).
- **Parsing:** cabeçalho na linha 1; só entram linhas cujo `id` começa com `"l:"`. Coluna ausente → string vazia.
- **Saída** `form_sheet.json`: `lead_form_id, criado_em, anuncio, conjunto, campanha, formulario, organico, plataforma, tipo_negocio, nome, telefone, email`. **PII.**
- **Consumo:** `enriquecer_com_planilha` (ETL `:93-129`) casa CRM × planilha por e-mail ou pelos **últimos 8 dígitos do telefone**.

---

## 7. ETL — `scripts/generate_dashboard_data.py` (1.289 l.)

Entrada: `data_raw/*.json`. Saída: `dashboard/data/summary.json` + `summary.js`
(+ upload opcional ao Supabase). **Sem rede** — é puramente local sobre os brutos.

### 7.1 Ordem de `main()` (linha 1162) — é obrigatória

| # | Linha | Chamada | Efeito |
|---|---|---|---|
| 1 | 1163-1170 | `ler(...)` de 8 brutos | `ler` (`:55`) devolve `[]` com `::warning::` se faltar arquivo — não aborta |
| 2 | 1172-1174 | guarda de leads | `exit(1)` com `::error::Sem leads do Kommo` |
| 3 | 1176-1178 | `enriquecer_com_planilha` | **Muta `leads` in-place**, injetando `lead["form"]` |
| 4 | 1179 | `resolver_fontes` | **Muta `leads`**, gravando `lead["_fonte"]`. Depende do passo 3 |
| 5 | 1180-1182 | `match_leads_meta` | Devolve `leads_daily_map`, `ad_daily_map`, `matching_stats`. Depende de 3 e 4 |
| 6 | 1185 | `expor_pessoais = bool(SUPABASE_SERVICE_KEY)` | Gate de PII |
| 7 | 1187-1189 | `aggregate_leads`, `aggregate_crm`, `aggregate_atendimento` | |
| 8 | 1193-1202 | split por `classificar_frente` → `aggregate_meta_ads` ×2 | `meta_b2b` recebe os mapas de leads; `meta_ecom` recebe `{}` (e-commerce não passa pelo CRM) |
| 9-11 | 1203-1257 | `aggregate_utm`, `aggregate_google` ×2, `build_otimizacao` ×2, `aggregate_institucional`, `aggregate_publico`, `qualidade_por_responsavel` | |
| 12 | 1258 | `build_relatorio` | Atribuído **depois** do dict literal |
| 13 | 1262-1267 | **sanidade** | `exit(1)` se a soma de `leads_crm` por campanha > leads pagos de Meta |
| 14 | 1269-1283 | grava `summary.json` e `summary.js` | |
| 15 | 1285 | `upload_to_supabase` | Sem as chaves → `::warning::` e pula |

**Nunca chame uma agregação antes de `resolver_fontes`**: `_fonte` e `form` são
mutações in-place no mesmo objeto `leads`. Quem rodar antes vê tudo como "sem UTM".

### 7.2 Regras de negócio (funções que decidem tudo)

| Função | Linha | Regra |
|---|---|---|
| `classificar_frente(nome)` | **717** | Decide a frente **só pelo nome da campanha**, em ordem: **b2b** ("formulário/formulario nativo", "geração/geracao de leads b2b", ou "leads" **e** "b2b") → **ecommerce** ("ecommerce", "[venda]", "[compra]", "[vendas]", "[sh]", "shopping", ou começa com "sh "/"sh-") → **inst** ("impulsionamento", "instagram post", "post do instagram") → **outras** silencioso (nome com "permissão" ou "facebook.com/business/help": é a mensagem de erro que o conector às vezes grava) → **outras** com `::warning::` (`:743`) |
| `enriquecer_com_planilha` | 93 | Casa CRM × planilha por **e-mail** (prioridade) ou pelos **últimos 8 dígitos do telefone** (`_fone_norm`, `:84`, tira o `55`). Primeira ocorrência vence. Grava `lead["form"]` |
| `origem_efetiva(lead)` | 135 | `utm_source` → senão `"{plataforma} (formulário)"` / `"(formulário orgânico)"` → senão `None` |
| `resolver_fontes` | 147 | Grava `lead["_fonte"] ∈ {meta, google, outro, None}`. Cadeia: UTM em `PAID_SOURCES_META` ou `fbclid` → `PAID_SOURCES_GOOGLE` ou `gclid` → tem `form` não orgânico → **Jaccard ≥ 0,4** entre `utm_campaign` e campanha real da Meta → tem UTM ou form orgânico → `outro` → `None` |
| `match_leads_meta` | 198 | 1ª via **planilha** (exata, alimenta campanha **e** criativo); 2ª via **Jaccard por `utm_campaign`** (só nível campanha). O pool é filtrado por frente b2b (`:216`). O dia usado é `criado_em` **no CRM**, não a data do clique |
| `aggregate_meta_ads` | 542 | 4 granularidades (mês, dia, campanha×dia, conjunto×dia, criativo×dia) + acumulado por criativo. Injeta `leads_crm` de `leads_daily_map` (`:616-621`) — isso cria pares (campanha, dia) com `gasto = 0`. `campaigns` = top 30 por gasto; `creatives` = top 300. **Alcance deliberadamente não agregado** |
| `aggregate_crm` | 317 | Funil, ativos, perdas, `losses_daily`, `by_responsavel`, `monthly_won`, ciclos, `deals_minimal` (1 linha por lead, **sem PII**, é o que o front usa para refazer o funil sob filtro), tempo parado por etapa (mediana), taxas de fechamento |
| `aggregate_atendimento` | 476 | Primeira resposta por `talk_id`; `respostas[]` vai **crua** (o front calcula mediana/p90 no período); `automaticas_pct` = % abaixo de `LIMITE_RESPOSTA_AUTOMATICA_MIN = 0.5` min |
| `build_otimizacao` | 988 | Ciclo do mês (gasto Meta + Google, ritmo/dia, projeção), histórico mensal mesclado, `criativos_eficientes` e `zero_retorno` (gasto > R$ 10 e resultado 0 e fallback 0) |
| `build_relatorio` | 1076 | Snapshot do mês + `alertas[]` |
| `qualidade_por_responsavel` | 818 | Por responsável: leads, vendas, perdidos, taxa, % sem 1º atendimento, tempo até a 1ª troca, dias parado |

Constantes de topo: `BRT = UTC−3` (`:28`), `LIMITE_RESPOSTA_AUTOMATICA_MIN = 0.5`
(`:31`), `JACCARD_THRESHOLD = 0.4` (`:34`), `FUNIL_ORDER` (`:40`, combinada com a
gestora em 05/08 porque o sort nativo do Kommo põe FOLLOW UP depois da negociação;
etapa desconhecida → 900, vai para o fim).

### 7.3 Chaves de topo do `summary.json`

| Chave | Tipo | Origem | Conteúdo |
|---|---|---|---|
| `last_update` | str | 1220 | `dd/mm/aaaa HH:MM` BRT — data de geração do **ETL**, não da coleta |
| `cliente` | str | 1221 | `"Terrana B2B"` (hardcoded) |
| `totals` | dict | 1222 | `leads, meta_rows, google_rows, eventos, conversas_abertas` |
| `config` | dict(11) | 1229 | Espelho do `config.py`: `ticket_medio`, 4 targets, 5 orçamentos (`0` = não definido) e `area_atendida` (UFs) |
| `leads` | dict(7) | `aggregate_leads` (276) | `total, pagos, organicos, sem_utm, monthly[], daily[], by_source[15]` |
| `crm` | dict(17) | `aggregate_crm` (317) | `funnel, active_funnel, tempo_etapa, leads_parados, deals_minimal, losses, losses_daily, by_responsavel, monthly_won, ciclo, total_*, taxa_fechamento*` |
| `atendimento` | dict(9) | `aggregate_atendimento` (476) | `conversas_total, em_aberto, nao_lidas, recebidas, enviadas, msgs_daily, msgs_hora[24], respostas[] (cruas), automaticas_pct` |
| `meta_b2b` | dict(14) ou `null` | `aggregate_meta_ads` (542) | Campanhas b2b + `leads_crm` do CRM + **`matching`** (só aqui) |
| `meta_ecom` | dict(13) ou `null` | idem | Mesmas chaves **sem** `matching`; `leads_crm` sempre 0 |
| `google_b2b` | dict | `aggregate_google` (886) ou stub | Hoje `{disponivel:false, motivo:"..."}` |
| `google_ecom` | dict(10) | idem | `disponivel, total_gasto, total_conversoes, total_valor_conversoes, monthly, daily, campaign_daily, campaigns, campaign_names, campaign_status` |
| `utm` | dict(7) | `aggregate_utm` (944) | `cobertura, cobertura_efetiva, sources, mediums, campaigns, contents, campaigns_perf` |
| `otimizacao_b2b` / `otimizacao_ecom` | dict(4) | `build_otimizacao` (988) | `ciclo, monthly_hist, criativos_eficientes[≤6], zero_retorno`. `resultado` = `leads_form` (b2b) / `compras` (ecom) |
| `institucional` | dict(3) ou `null` | `aggregate_institucional` (748) | `split_gasto` (todas as frentes), `monthly`, `campaigns` (com thumbnail/permalink do anúncio de maior gasto) |
| `publico` | dict(4) | `aggregate_publico` (799) | `disponivel, age_gender, placement, region` — cada linha com `frente` |
| `qualidade_responsavel` | **list** | (818) | Única chave de topo que é lista |
| `crm_regiao` | dict(7) | `aggregate_regiao` | Origem geográfica dos leads pelo **DDD do telefone** do contato (o Kommo não tem cidade/estado): `metodo, canais, area_atendida, ddds{ddd:{uf,polo,area}}, ufs{uf:{nome,regiao}}, daily[{dia,ddd,form,direto}], cobertura`. `ddd ""` = sem DDD válido (a soma bate com o total de leads — gate no `main()`). `form` = tag `metaform`/`fb<id>` no Kommo; `canais=false` se a coleta não trouxe tags. Tabela DDD → UF em `regioes_br.py`; área atendida em `AREA_ATENDIDA_UFS` (padrão SP,MG,PR,RJ). Só contagens — sem PII |
| `relatorio` | dict(9) | `build_relatorio` (1076) | `mes, leads_mes, leads_mes_anterior, delta_leads_pct, gasto_meta_mes, conversas_meta_mes, cpl_plat_mes, rastreamento_pct, alertas[]` |

**Dentro de `meta_b2b` / `meta_ecom`** (é o que toda página de Meta Ads lê — não
precisa fazer engenharia reversa a cada sessão):

| Chave | Tipo | Campos de cada linha |
|---|---|---|
| `total_gasto`, `total_leads_plat`, `total_conversas`, `leads_crm_matched` | escalares | — (`leads_crm_matched` é sempre 0 no ecom) |
| `monthly` | lista | `mes, gasto, impressoes, cliques, cliques_link, leads_plat, conversas, compras, valor_compras, ctr` |
| `daily` | lista | `dia` + os mesmos campos numéricos, **sem** `ctr` |
| `campaign_daily` | lista | `dia, campanha` + numéricos. **`leads` (do CRM) só existe na linha em que houve casamento** — no b2b, 45 de 77 linhas hoje; no ecom, nenhuma. Sempre use `r.leads \|\| 0` |
| `adset_daily` | lista | `dia, campanha, conjunto, gasto, cliques, cliques_link, leads_plat, conversas, compras, valor_compras` (**sem `impressoes`**) |
| `creatives_daily` | lista | `dia, anuncio, campanha` + os mesmos numéricos do `adset_daily`. Só entra linha com gasto, leads ou conversas |
| `campaigns` | lista | acumulado por campanha: `campanha, gasto, impressoes, cliques, ctr, leads_plat, conversas, leads_crm, status`. **Top 30 por gasto** (`:656`) |
| `creatives` | lista | acumulado por anúncio: `anuncio, campanha, conjunto, gasto, impressoes, cliques, cliques_link, leads_plat, conversas, compras, valor_compras, thumbnail, permalink, primeira_data, ultima_data, leads_form, ctr`. Top 300 por gasto |
| `campaign_names` | lista de str | nomes ordenados |
| `campaign_status` | dict | `{nome: effective_status}` — consuma sempre via `dict()` (`app.js:108`) |
| `matching` | dict(8) | **só em `meta_b2b`**: `nivel, leads_pagos_meta, via_formulario, via_utm, matched, cobertura_pct, planilha_total, casados_no_crm` |

`summary.js` é o mesmo conteúdo como `window.__SUMMARY__={...};` — existe só para o
dashboard abrir com duplo clique. Não é commitado.

### 7.4 Armadilhas do ETL

1. **Métrica de plataforma anda sufixada `_plat`** (`leads_plat`, `cpl_plat_mes`); CPL "de verdade" usa `leads_crm`. **Não misture os dois num mesmo card.**
2. **Toda tabela filtrável por dia tem sua `*_daily` própria** — ao adicionar métrica numa tabela, adicione também na `*_daily`, senão o filtro devolve vazio.
3. **Dívida conhecida:** o docstring do módulo fala em *rateio proporcional ao gasto*; a implementação **não rateia** (incrementa `+= 1` no nível campanha). Os `rnd(..., 1)` aplicados a `leads` são resquício do projeto-base. Se alguém reintroduzir rateio, o gate de sanidade já tolera fração (`+0.01`).
4. **Limitação do gate de sanidade:** `meta_b2b["campaigns"]` é truncado em 30 campanhas por gasto (`:656`), então o gate é mais frouxo do que parece se existirem mais de 30 campanhas b2b.
5. **Alerta morto:** o alerta de rastreamento por criativo (`:1117`) testa `matching["nivel"] == "campanha"`, mas `match_leads_meta` fixa o valor em `"campanha + criativo (formulário)"` — **nunca dispara**. Corrigir para `.startswith("campanha")` se ainda for desejado.
6. **Código morto:** a closure `fecha(bucket, chave)` em `aggregate_meta_ads` (`:638`) nunca é chamada; pode ser removida.
7. **`casados_no_crm` (492) > total da planilha (444)** é esperado: um registro da planilha pode casar com mais de um lead do CRM (telefone repetido).
8. `config.RAW_DIR` e `config.SUMMARY_PATH` são sobrescrevíveis por env (`RAW_DIR`, `SUMMARY_PATH`) — útil para testar contra um snapshot sem estragar o summary bom.
9. **O nome do bucket do Supabase está hardcoded no ETL:** `:1156` usa o literal `from_("dashboard-data")`, enquanto o front usa a constante `SUPABASE_BUCKET` (`app.js:3848`). O objeto é `summary.json` na **raiz** do bucket, enviado com `upsert: "true"`. Renomear o bucket mexendo só no `app.js` **quebra o upload em silêncio** (o ETL não emite `::warning::` — ele simplesmente escreve no lugar errado).
10. **Criativo "casca":** `aggregate_meta_ads` (`:626-634`) cria uma linha de criativo com `gasto = 0` e `conjunto` vazio para todo nome de anúncio que a **planilha** atribui mas que não existe na série coletada — tipicamente um anúncio renomeado na Meta depois de o formulário ter gravado o nome antigo. O `creatives` é indexado **só pelo nome do anúncio** (`:593`), então rodar em dois conjuntos **não** duplica a linha; o que duplica é o renome. É a origem das 13 linhas para 12 anúncios do B2B (§11.2).

---

## 8. Front

### 8.1 Casca e carga de dados

`dashboard/index.html` é **casca**: nenhum conteúdo, tudo injetado por `innerHTML`.
IDs que o JS exige: `#loading` / `#loading-msg`, `#sidebar`, `.brand-mark`,
`#front-name` / `#front-sub`, `#nav`, `#login-screen` / `#login-form` /
`#login-pass` / `#login-btn` / `#login-err`, `#selector`, `#topbar`, `#page-title`,
`#period-filter` (`#f-start`, `#f-end`, `#f-preset`, `#f-compare-wrap`, `#f-compare`),
`#content`, `#footer`, `#foot-front`, `#stamp`.

**Ordem dos scripts importa:** `data/summary.js` vem **antes** de `assets/app.js`.

`loadData()` (`app.js:3859`), nesta ordem:
1. `window.__SUMMARY__` (duplo clique);
2. `fetch('data/summary.json')` (localhost);
3. login Supabase — só se as constantes de `app.js:3845-3848` estiverem preenchidas (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DASH_EMAIL = 'dashboard@terrana.com.br'`, `SUPABASE_BUCKET = 'dashboard-data'`; hoje as duas primeiras são strings vazias);
4. `showFatal()` — mensagem honesta de erro.

Chart.js 4 vem do CDN (`index.html:9`) e `@supabase/supabase-js@2` é carregado sob
demanda (`app.js:3889`). **O site não funciona offline.** Todos os caminhos no HTML
são **relativos** — caminho absoluto com `/` quebra o Pages, que roda em subcaminho.

### 8.2 Roteamento

- `FRONTS` (`app.js:507`): objeto com as duas frentes, cada uma com `key`, `title`, `badge`, `badgeSub` e a lista `pages` (`{id, label, ic, render}`).
- `parseHash()` (`:541`) → `applyFront(frontKey)` (`:550`, monta a sidebar) → `route()` (`:559`, destrói os gráficos e chama o `render` da página).
- Sem hash → `renderSelector()` (`:593`), a tela de escolha de painel.
- Rotas: `#b2b/<pagina>` e `#ecom/<pagina>`.

### 8.3 As 16 páginas

**Frente B2B (`#b2b/...`) — 9 páginas**

| Página | Função | Linha | O que mostra | Lê do summary |
|---|---|---|---|---|
| Visão Geral | `renderVisaoB2B` → `renderOtimizacao(el,'b2b')` | 1430 / 1404 | Dashboard de Otimização: ciclo de orçamento, período, campanhas, "o que fazer agora", evolução, histórico, resultado, ações. No fim, seção **"De onde vêm os leads"** (21/09, pedido da Isabela): KPIs de área atendida + barras empilhadas formulário × direto por estado (top 10 + "Outros") e por área de DDD (top 12), com o filtro de período — `regiaoHtml`/`regiaoCharts`/`regiaoBarras` | `otimizacao_b2b`, `meta_b2b`, `google_b2b`, `config`, `relatorio`, `crm_regiao` |
| Funil CRM | `renderFunilCRM` | 1502 | Funil por etapa, ativos, perdas e motivos, responsáveis, ciclo, tempo parado, leads parados (PII quando liberado) | `crm` |
| Atendimento | `renderAtendimento` | 1688 | Mensagens recebidas/enviadas, conversas, 1ª resposta (mediana/p90/faixas), % automática, mensagens por hora | `atendimento` |
| Meta Ads | `renderMetaB2B` | 1798 | Mensal e diário (gasto × leads), campanhas, conjuntos, criativos com thumbnail | `meta_b2b` |
| Google Ads | `renderGoogleAds(el,'b2b')` | 2007 | Hoje: 6 KPIs vazios + `emptyDashed` com o motivo | `google_b2b` |
| Público | `renderPublico(el,'b2b')` | 3622 | Idade/gênero, posicionamento, região — **mensal**, não diário | `publico` |
| Evolução Mensal | `renderEvolucaoB2B` | 2136 | Série mês a mês de leads, gasto, CPL | `leads`, `meta_b2b`, `crm` |
| Rastreamento (UTM) | `renderUTM` | 2245 | Cobertura, cobertura efetiva, top sources/mediums/campaigns/contents, performance por campanha | `utm` |
| Qualidade dos dados | `renderQualidade(el,'b2b')` | 2303 | Cada alerta do ETL com "o que fazer" | `relatorio.alertas`, `utm`, `meta_b2b.matching` |

**Frente E-commerce (`#ecom/...`) — 7 páginas**

| Página | Função | Linha | O que mostra | Lê do summary |
|---|---|---|---|---|
| Visão Geral | `renderVisaoEcom` | 2906 | Central de análise: xKPIs com delta e sparkline, metas de CPA/ROAS, aquisição por canal, funil da loja (**estado preparado**), 8 análises preparadas, insights fato × hipótese, tabela diária ordenável com busca e CSV | `otimizacao_ecom`, `meta_ecom`, `google_ecom`, `config` |
| Meta Ads | `renderMetaEcom` | 3236 | Gasto × compras (small multiples), campanhas, criativos, ROAS/CPA do pixel | `meta_ecom` |
| Google Ads | `renderGoogleAds(el,'ecom')` | 2007 | Mensal e diário, campanhas de Shopping, conversões e valor atribuído | `google_ecom` |
| Institucional | `renderInstitucional` | 3417 | Impulsionamento: engajamento, video views, seguidores, conversas, preview do post | `institucional` |
| Público | `renderPublico(el,'ecom')` | 3622 | idem B2B, filtrado pela frente | `publico` |
| Evolução Mensal | `renderEvolucaoEcom` | 3771 | Série mensal das duas plataformas, **sem somar receita** | `meta_ecom`, `google_ecom` |
| Qualidade dos dados | `renderQualidade(el,'ecom')` | 2303 | idem B2B | `relatorio.alertas` |

### 8.4 Filtros e comparação

| Peça | Linha | Papel |
|---|---|---|
| `FILTER` / `fstate(front)` | 685 | **Estado separado por frente** (`FILTER.b2b` e `FILTER.ecom`). Trocar de painel preserva o período de cada uma |
| `adoptFilter(front)` | 687 | Copia o estado da frente para o filtro ativo. **Nunca escreva em `FILTER.b2b` direto** |
| `computeDataBounds` / `ecomBounds` / `clampEcom` | 645 / 666 / 681 | Limites reais da série; o e-commerce tem limites próprios |
| `setPreset` / `setPresetEcom` / `presetsEcom` | 692 / 708 / 765 | Presets de período (o e-commerce tem os seus) |
| `ecomCompareRange` | 739 | Período de comparação, classificando a cobertura como total, parcial ou nenhuma — o delta na tela diz qual é o caso |
| `updateFilterBar` / `syncFilterUI` / `onDateInput` / `buildFilterUI` | 777 / 795 / 804 / 829 | Barra de filtro no topbar |
| `fdays` / `fdaysR` / `inPeriod` | 116 / 120 / 115 | Filtram listas `*_daily` pelo período |

### 8.5 Helpers reutilizáveis (use estes, não escreva markup na mão)

| Helper | Linha | Quando usar |
|---|---|---|
| `kpi(label, value, sub, {hero, teal})` | 180 | Card de KPI. Sem dado → passe `null` (vira `.kpi-dash`, um traço, nunca "0") |
| `xkpi(label, valueHtml, delta, sub, spark)` | 2438 | KPI executivo do e-commerce (com delta e sparkline) |
| `xkpiPrep(label, formula, dep)` | 2452 | KPI em **estado preparado** (dado ainda não existe) |
| `deltaHtml(cur, prev, dirKey, hasComp, nota)` | 2419 | Delta verde/vermelho/neutro |
| `card` / `chartCard` / `multiChartCard` | 189 / 198 / 202 | Cartões; `multiChartCard` é o substituto do eixo duplo |
| `secTitle(txt, sub)` | 897 | Título de seção (o subtítulo declara escopo e se usa o filtro) |
| `tableWrap` / `sortableWrap` / `tdNum` / `wireSortables` | 247 / 2527 / 2532 / 2536 | Tabelas; a ordenável precisa de `wireSortables(el)` **depois** do `innerHTML` |
| `reliefTable` / `dailyRelief` | 254 / 258 | O `<details>Ver tabela` sob gráfico terracota — **acessibilidade, não enfeite** |
| `emptyDashed(l1, l2)` | 243 | Caixa tracejada: linha 1 = o que falta, linha 2 = como habilitar |
| `banner(kind, html)` | 208 | Faixa de aviso |
| `dailySeries` / `aggBy` / `dayIdx` / `sum` / `quantile` | 145 / 167 / 911 / 121 / 161 | Séries e agregações no período. **`dailySeries` devolve `null` quando não sobra nenhuma linha no filtro** (`:147`) — por isso **todo** gráfico precisa do ramo `emptyDashed`; o padrão está em `renderMetaEcom` (`:3265-3274`) |
| `makeChart` / `baseOpts` / `barDs` / `lineDs` / `yMoney` / `yCount` / `xDaily` / `lockYWidth` / `moneyTooltip` | 414 / 467 / 490 / 496 / 449 / 441 / 430 / 454 / 458 | Tudo de Chart.js |
| `funnelHtml` / `amberStep` / `amberFg` / `stageKinds` | 310 / 283 / 288 / 291 | Funil com rampa ordinal |
| `statusBadge` / `googleStatusBadge` / `qualityBadge` / `metaBadgeCusto` | 264 / 2000 / 270 / 904 | Badges de status e de meta |
| `esc` / `safeHttpUrl` / `dict` | 94 / 101 / 108 | **Segurança**: escape de nome vindo de dado externo, validação de `https://` antes de virar href, dicionário sem protótipo |
| `fmt` (objeto) | 68 | Formatação pt-BR: milhar com ponto, decimal com vírgula, `R$ 1.478,65`, `dd/mm`, `Jul/26`, `5,4d`, ausência `—` |
| `ecvDaily` / `ecvTotals` / `ecvDailyTable` / `ecvInsights` / `ecvInsightCard` / `ecvMetasHtml` / `ecvEvoChart` | 2371 / 2392 / 2637 / 2752 / 2746 / 2878 / 2571 | Bloco do e-commerce |
| `drawSparks` / `wireSparkResize` | 2460 / 2498 | Sparklines SVG |
| `qualityChip` / `alertMeta` | 236 / 231 | Chip "🩺 N observações de dados" que leva à página Qualidade |

### 8.6 Receitas rápidas

- **KPI novo:** `kpi('LABEL EM CAPS', valorFormatado, 'subtítulo que declara a fonte do dado', {teal:true})` dentro de `<div class="kpis cols-6">`.
- **Gráfico novo:** `chartCard(titulo, sub, 'ch-xxx')` no HTML → `makeChart('ch-xxx', {type, data:{labels, datasets:[barDs(...)]}, options: baseOpts({...})})` **depois** de injetar o HTML. Cor pela entidade (§9.2). Terracota sem rótulo em todo ponto → anexe `dailyRelief()`. **Se a série vier de `dailySeries`, escreva o ramo `null` → `card(..., emptyDashed(...))` antes de testar**: sem ele o gráfico quebra no primeiro filtro vazio.
- **Combo dinheiro × resultado:** `multiChartCard(...)` + dois `makeChart` com o **mesmo array de labels** e `lockYWidth(yMoney(), 64)` / `lockYWidth(yCount(), 64)`.
- **Página nova:** acrescente a entrada em `FRONTS` (`:507`) e escreva `renderX(el)`; o roteamento e a sidebar se montam sozinhos.

---

## 9. Identidade visual e regras de gráfico

### 9.1 Tokens (`dashboard/assets/style.css`, `:root`, linhas 28-51)

| Token | Hex | Uso |
|---|---|---|
| `--bg-page` | `#0D0906` | fundo (preto quente) |
| `--bg-sidebar` | `#140E08` | sidebar (com degradê) |
| `--bg-card` | `#1A120A` | cards, inputs, tabelas, tooltip |
| `--border-card` | `#332415` | hairline 1px |
| `--track` | `#241910` | trilha do funil, divisória |
| `--blue` | `#E0A526` | **mostarda da marca** (nome legado!) |
| `--teal` | `#D4692E` | **terracota da marca** (nome legado!) |
| `--green` / `--red` / `--amber` | `#10B981` / `#EF4444` / `#F59E0B` | **status apenas** |
| `--text` / `--text-muted` / `--text-soft` / `--peri` | `#F7F1E6` / `#A28D74` / `#DECFB8` / `#E8D5B5` | texto |
| `--grad-active` | `linear-gradient(90deg,#E0A526,#C9622A)` | nav ativa, `.f-bar`, `.pbar`, botão de login |
| `--grad-kpi` | `linear-gradient(90deg,#6B4226,#C9622A)` | hairline de 3px no topo de todo `.kpi` |
| `--sidebar-w` | `236px` | casa com `#main { margin-left: var(--sidebar-w) }` |

⚠ **`--blue` e `--teal` são nomes herdados do blueprint azul; os valores são
Terrana.** Não "corrija" o nome sem varrer todos os usos, e nunca suponha que
`--teal` é ciano. Sobre gradiente ativo há **sempre** texto escuro `#241203` — é o
par de contraste validado; trocar para branco quebra a legibilidade.

### 9.2 Paleta de dados × paleta de UI (`app.js:37-63`)

```js
const P  = { bgCard:'#1A120A', border:'#332415', track:'#241910',
             accent:'#E0A526', accent2:'#C9622A',              // UI APENAS
             muted:'#A28D74', soft:'#DECFB8', text:'#F7F1E6' };
const S  = { mostarda:'#BD8A0C', terracota:'#A64114', oliva:'#74A335' };   // SÉRIES
const AMBER_RAMP = ['#F6DC9C','#EEC25B','#E0A526','#B78312','#8E650E','#684A0A'];
const ST = { green:'#10B981', red:'#EF4444', amber:'#F59E0B' };            // STATUS
```

Semântica **fixa por entidade** — um gráfico novo herda a cor pela entidade, não
pela ordem em que foi escrito:

| Cor | Significa |
|---|---|
| terracota `#A64114` | dinheiro, gasto, custo, perda |
| oliva `#74A335` | resultado, compras, conversões, engajamento |
| mostarda `#BD8A0C` | volume de pessoas, leads, receita, ROAS |
| `GOOGLE_INV #C4703C` / `GOOGLE_RES #9DBE6A` | o **mesmo papel** na plataforma Google, em empilhado |
| `AMBER_RAMP` | grandeza **ordinal** (etapas do funil) |
| `ST.*` + `P.muted` | status e "não informado" |

### 9.3 Componentes com anatomia fixa

- **`.kpi`** — hairline `--grad-kpi` de 3px no topo (só em KPI). `.kpi-label` CAPS 11px → `.kpi-value` 25px/700 → `.kpi-sub` 11,5px muted. `.kpi.hero` = 34px com hairline de 4px. Sem dado → `.kpi-dash`.
- **`.xkpi`** — versão executiva do e-commerce, com `.xd` (delta), `.xspark` (sparkline), `.xk-tag` (atribuição) e `.xk-dep` (âmbar, "depende de X").
- **Estado preparado** — `.xkpi.prep`, `.prep-card`, `.funnel-prep`: borda tracejada `#4A3620`, hachura 45°. Padrão para "o dado ainda não existe". **Nunca simular número no lugar disso.**
- **`.plat-band`** — faixa por plataforma na Visão Geral (Meta em mostarda translúcida, Google em terracota). É o único lugar onde cor de série vira fundo de UI, e sempre com o nome da plataforma ao lado.
- **Funil** — `.f-label` 172px · `.f-track` 30px · `.f-bar` proporcional ao máximo, valor **dentro** da barra · `.f-pct` 80px ("NN% da anterior", contra a etapa **de progresso** anterior). Progresso usa `AMBER_RAMP`; terminais usam `.won`/`.lost`.
- **Tabelas** — `th` CAPS 11px muted; `td` 13px, **sem zebra**; `.r` para números (sempre à direita); `td.teal` para a coluna-assinatura; `—` para ausência. Tabela larga rola **dentro** de `.table-wrap`; **nunca** rolagem horizontal da página.
- **`.ins-card`** — insight com borda esquerda 3px (`.pos`/`.neg`/`.alerta`) e duas linhas com tag `.ins-tag.fato` × `.ins-tag.hipo`. **Separar fato de hipótese é regra de conteúdo, não decoração.**
- **`.tbl-relief`** — `<details>Ver tabela</details>` sob o gráfico.

Mapa de seções do CSS (para navegar com `offset/limit`): 1-21 `@font-face` · 28-51
`:root` · 55-74 body · 96-150 sidebar · 152-189 topbar/content/footer · 191-209
banners · 211-248 KPIs · 250-283 cards e chart-box · 285-324 seg-toggle/scope-badge ·
326-372 tabelas, badges, thumbs · 374-393 funil · 395-411 empty-dashed · 413-480
seletor · 482-505 responsividade · 507-541 login · 543-649 Dashboard de Otimização ·
651-739 bloco E-commerce.

Responsividade (desktop-first): ≤1500px reduz colunas · ≤1200px `.grid-3` vira 1 ·
≤1100px `.grid-2` vira 1 · ≤900px a sidebar vira faixa estática no topo · ≤760px
grids em 2 colunas.

### 9.4 O que **não** pode ser quebrado no visual

1. **Os data URIs da marca**: favicon no `<head>` e `img.brand-mark` na sidebar (62.798 caracteres). O mesmo nó é **clonado** para a tela de login (`showLogin`, `:3919`) e reusado no seletor (`:595`) — apagar quebra 3 telas de uma vez. Idem os três `@font-face` Montserrat (pesos 400/600/800): sem eles a tipografia cai para Segoe UI e o painel deixa de abrir corretamente offline.
2. **Cor nova entra como token**, nunca hex solto no meio da regra.
3. **`index.html` continua sendo casca**; conteúdo mora nas funções `render*`.
4. **`docs/SPEC_VISUAL_REFERENCIA.md` perde para `style.css` + cabeçalho do `app.js`** em qualquer conflito: a spec é do blueprint azul (Dr. Move), com eixo duplo e paleta por status — hoje ambos proibidos. Ela vale para **estrutura, anatomia, textos e convenções**.
5. **Resíduos azuis conhecidos** (decidir antes de mexer, não tocar de passagem): `#topbar` com `rgba(5,7,13,.93)` (CSS 157) · `.front-badge` azul-esverdeada (122-123) · `.banner.blue`/`.note-blue` (200/204) — **em uso em 12 + 3 chamadas do `app.js`** · `.badge.blue` (358) **sem uso**, candidato a remoção.

---

## 10. Infra e CI/CD

Arquivo único: `.github/workflows/deploy_pages.yml` (169 linhas). `coletar_dados.yml`
e `etl_rapido.yml` foram **removidos** no commit `b53f1b4` porque chamavam a Meta
sem as travas de grade.

### 10.1 Gatilhos

| Gatilho | Quando | Chama a Meta? | Observação |
|---|---|---|---|
| `push` em `main` | **só** se tocar `dashboard/**` ou o próprio workflow (`paths`, l.17) | Não | Mudança só em ETL/coletores/config/README **não publica nada** |
| `schedule` | `cron: "10 6 * * *"` = 03:10 BRT | **Sim** | Único gatilho que liga a coleta sozinho. Cron só roda na branch padrão |
| `workflow_dispatch` | Manual, 2 inputs booleanos | Só com `coletar_meta` | `janela_comercial` libera 09:10–18:59 BRT — **só com combinado prévio** |

Expressões que decidem tudo (passo 4):
`META_COLETA = (schedule || dispatch+coletar_meta) ? 'sim' : 'nao'` ·
`META_JANELA_COMERCIAL = (dispatch+janela_comercial) ? 'sim' : 'nao'`.

### 10.2 Passos, na ordem

1. `actions/checkout@v4` + `actions/setup-python@v5` (Python 3.12) + `pip install -r requirements.txt` (sem cache de pip).
2. **Gate de secrets** (l.62-70): testa `KOMMO_TOKEN` e `META_ACCESS_TOKEN` **no shell**, não no `if:` do step (o `if:` não enxerga `secrets` de forma confiável — bug corrigido em `628af55`). Vazio → `::error::` + `exit 1`.
3. `actions/cache/restore@v4` (l.74-85): restaura **só** os 6 `data_raw/meta_*.json`. `key: meta-raw-${{ github.run_id }}`, `restore-keys: meta-raw-`. Na prática a `key` nunca casa e sempre cai no prefixo — é o comportamento desejado.
4. **Coleta da Meta** (`id: meta`, l.87-95, `timeout-minutes: 50`): `python -u -m collectors.meta_ads_api`.
5. `actions/cache/save@v4` (l.97-108): `if: always() && steps.meta.outputs.chamou_meta == 'true'`, `key: meta-raw-${{ github.run_id }}-${{ github.run_attempt }}` — **a chave de gravação tem o `run_attempt`, a de restauração não** (é por isso que o restore sempre cai no prefixo). `always()` garante salvar o que já foi coletado mesmo se o passo falhar depois.
6. **Conferir dado da Meta** (`id: pronto`, l.112-114): `--verificar` grava `pronto=true|false`. **É o interruptor de publicação**: os 4 passos seguintes têm `if: steps.pronto.outputs.pronto == 'true'`. `pronto=false` → job **verde sem publicar**, site na última versão boa.
7. **Coleta das demais fontes + ETL** (l.116-145): `python -u main.py --sem-meta` e `python -u scripts/generate_dashboard_data.py`.
8. **Modo autenticado** (l.150-160): se `secrets.SUPABASE_SERVICE_KEY` existir, apaga `summary.json`/`summary.js` antes do upload do artefato.
9. `actions/upload-pages-artifact@v3` com `path: dashboard/` + `actions/deploy-pages@v4`.

Permissões `{contents: read, pages: write, id-token: write}`; `concurrency: {group: pages, cancel-in-progress: false}` — **deliberado**: um push durante a madrugada não pode cancelar a coleta da Meta no meio (a janela não volta). Efeito colateral: o push fica na fila. Job com `timeout-minutes: 60`, `environment: github-pages`.

### 10.3 Secrets (só os nomes — valores vivem no GitHub e no `.env` local)

| Secret | Para que serve |
|---|---|
| `KOMMO_SUBDOMAIN` | subdomínio da conta Kommo (`terrana`; é secret por convenção, não é sensível) |
| `KOMMO_TOKEN` | token de longa duração do Kommo. Entra no gate do passo 2 |
| `META_ACCESS_TOKEN` | token de usuário de sistema do app compartilhado da agência (`ads_read` + `read_insights`). Entra no gate do passo 2 |
| `META_AD_ACCOUNT_ID` | id da conta de anúncios, sem o prefixo `act_` (o código adiciona) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | developer token da API do Google Ads |
| `GOOGLE_ADS_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | OAuth do usuário da agência |
| `GOOGLE_ADS_CUSTOMER_ID` | conta da Terrana, sem hífens (223-460-7566) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC da agência (`3626205833`) — **sem ele a conta da Terrana não é acessível** |
| `GOOGLE_SA_JSON_B64` | JSON do service account em base64, para ler a planilha do formulário |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | projeto Supabase exclusivo da Terrana. **Ainda não preenchidos** |

**Nunca escreva o valor de nenhum desses em documento, log, commit ou chat.**
`FORM_SHEET_ID` não tem secret: vale o default embutido em `collectors/form_sheet.py:18`.

### 10.4 Variables (não são segredo; aparecem no log)

| Variable | Valor em produção | Efeito |
|---|---|---|
| `TICKET_MEDIO` | `0` | 0 esconde todos os indicadores de dinheiro/receita |
| `CPL_TARGET_META` | `0` | 0 = régua desligada; o front mostra "meta não definida" |
| `CPL_TARGET_GOOGLE` | `0` | idem |
| `CPA_TARGET_ECOM` | `0` | idem |
| `ROAS_TARGET_ECOM` | `0` | idem |
| `ORCAMENTO_META_B2B` | **`1080`** | orçamento mensal R$: saldo, projeção, badge "Cabe / Não cabe" |
| `ORCAMENTO_META_ECOM` | **`1530`** | idem |
| `ORCAMENTO_GOOGLE_ECOM` | **`3450`** | idem |
| `ORCAMENTO_GOOGLE_B2B` | `0` | sem orçamento definido — estado honesto |
| `ORCAMENTO_META_INST` | **`1500`** | card de controle da página Institucional |

Total de mídia: **R$ 7.560/mês**. Gravados no commit `8e191ae` (11/09/2026). Todos
lidos com `float(os.getenv(..., "0") or 0)` — **uma Variable vazia ou apagada
equivale a 0 e apaga o indicador silenciosamente**, sem erro no log.

### 10.5 GitHub Pages

- **Settings → Pages → Source: "GitHub Actions"** (não "Deploy from a branch").
- Só o conteúdo de `dashboard/` vai ao ar.
- Sem domínio próprio (nenhum `CNAME`). URL de projeto, com subcaminho — **por isso todos os caminhos no `index.html` são relativos**.

### 10.6 Cache da Meta

Os 6 `meta_*.json` viajam por `actions/cache`: **salva** com
`meta-raw-<run_id>-<run_attempt>` (l.108) e **restaura** com
`key: meta-raw-<run_id>` + `restore-keys: meta-raw-` (l.84) — as duas chaves são
diferentes de propósito, por isso o restore **sempre** cai no prefixo e pega o
cache mais recente. É aqui que mora o histórico da Meta: **não existe cópia local
dele** (§14.1). **Só o dado da Meta é cacheado** (métrica de anúncio, sem
PII); Kommo e planilha são coletados do zero toda execução. Como o restore acontece
em toda execução, o cache não expira pelos 7 dias de inatividade **enquanto o
workflow rodar** — mas se ele parar de rodar, o cache **expira em 7 dias** e a
próxima rodada refaz o backfill mês a mês (§13.1).

### 10.6.1 Linha de base medida (primeira noite no horário novo)

Execução agendada de **18/09/2026** (run `35315575802`), a primeira depois da
mudança de horário — use como régua para comparar as próximas:

| Medida | Valor |
|---|---|
| Início do job | 03:35:57 (o GitHub atrasou 26 min; ainda dentro da janela e antes das 03:45, por isso rodou tudo) |
| Trecho da Meta | 03:36:11 → 03:37:31 = **80 s** |
| Chamadas | **31** (sem cache: backfill de maio a setembro, 1.285+584+502 linhas de breakdown, criativos de 43 anúncios) |
| Pico de uso | **1 %** (limite de parada: 30 %) |
| Resultado | `Meta pronta: coberta até 2026-09-18`, cache salvo, Pages publicado às 03:40 |

Com o cache quente, as noites seguintes devem ficar em **6 a 8 chamadas** e
poucos segundos. Se uma noite passar de ~15 chamadas sem ser a primeira, algo
invalidou o cache (§13.1) — investigue antes de culpar a Meta.

### 10.7 Ler os logs — sinais a procurar, nesta ordem

| Linha no log | Significa |
|---|---|
| `::error::Secrets essenciais ausentes:` | gate do passo 2 ou `main.py:40` |
| `Meta: coleta desligada nesta execução (META_COLETA≠sim)` | normal em push/manual |
| `::warning::Meta: fora da janela da grade` | tentou coletar fora de 03:10–03:59 |
| `Meta: N chamadas · pico de uso X% · ok: … · puladas: … · parou por: …` | resumo da rodada. Pico perto de 30 % ou `parou por: limite #4` = investigar **antes** da próxima noite |
| `Meta pronta: coberta até AAAA-MM-DD` × `::warning::Meta não pronta: …` | decide se publica |
| `summary.json gerado (N KB)` / `summary.js gerado` | ETL concluído |
| `::warning::SUPABASE_URL/SERVICE_KEY ausentes — upload pulado` | esperado na fase atual |
| `::error::Rateio duplicando leads` / `::error::Sem leads do Kommo` | `exit 1`, regras de ouro 6 e 7 |
| `::warning::Campanha sem frente identificável` | alguém renomeou campanha fora da convenção (§7.2) |

---

## 11. Os dados da Terrana na prática

Números do **snapshot local de 17/09/2026 12:40 BRT** — a régua para conferir
alterações feitas sobre ele.
O `summary.json` local está **uma coleta atrasado** (gerado 12:40, brutos
reescritos 12:41–12:46): rodar o ETL já muda os números (Kommo 1.720 → 1.864,
Google 114 → 121 linhas). **Regenerar o summary é o primeiro passo de qualquer sessão.**

⚠ **Esta régua é do snapshot local, e a produção já passou dela.** Para comparar com
o que o cliente vê, baixe o summary publicado:

```bash
curl -s https://agencia-delucca.github.io/terrana_daschboard_performance_Delucca/data/summary.json -o prod.json
python -c "import json;d=json.load(open('prod.json',encoding='utf-8'));print(d['last_update'],d['totals'])"
```

No summary publicado em **18/09/2026 03:39**: `totals` = 1.883 leads · **1.067
linhas da Meta** · 122 do Google · 25.404 eventos; mídia **R$ 24.801,92**
(2.672,81 b2b + 7.461,72 ecom + 4.931,66 institucional + 9.735,73 Google ecom);
cobertura de UTM **7,3 %** (138/1.883); `automaticas_pct` **62,1**; `matching` =
623 pagos / 488 pela planilha / 129 por UTM / 617 casados; `planilha_total`
**ainda 444** (a planilha continua parada). O gate de PII está segurando: o
`crm.leads_parados` publicado traz só `{disponivel: false, motivo}`.

### 11.1 Volumes e período coberto

| Fonte | Volume | Período |
|---|---|---|
| Kommo — negócios | **1.720** no summary (1.864 no bruto) | 02/06 → 10/09 no summary; bruto até 17/09 |
| Kommo — eventos | 23.215 no summary (25.211 no bruto) | 02/06 → 17/09 |
| Kommo — conversas abertas | 50 | — |
| Meta Ads — linhas anúncio×dia | **990** | **22/05 → 10/09/2026** |
| Google Ads — linhas campanha×dia | 114 no summary (121 no bruto) | até **17/09** no bruto |
| Planilha do formulário | **444 envios** | **27/07 → 25/08/2026** (parada) |

### 11.2 Gasto e resultado por frente (22/05 → 10/09)

| Frente | Gasto | Resultado | Indicador |
|---|---|---|---|
| **Meta B2B** | R$ 2.401,81 | 845 leads de plataforma · 614 casados no CRM · 55 conversas | CPL plataforma R$ 2,84 · **CPL por CRM R$ 3,91** |
| **Meta E-commerce** | R$ 7.061,56 | **102 compras** (pixel) · R$ 17.943,78 de receita atribuída | **ROAS 2,54** · CPA R$ 69,23 |
| **Google E-commerce** | R$ 8.844,64 | **104 conversões** · R$ 14.211,17 de valor atribuído | **ROAS 1,61** · CPA R$ 85,04 |
| **Meta Institucional** | R$ 4.530,16 | 50 campanhas de boost · 38 conversas | sem meta de conversão |
| **Google B2B** | — | **indisponível** (não existe campanha B2B na conta) | — |
| **Total de mídia** | **R$ 22.838,17** | — | **as receitas acima NÃO se somam** (§3.2) |

Estrutura da conta Meta: **53 campanhas** (42 ACTIVE), 82 anúncios distintos. B2B é
**uma única campanha** ("AD - Formulário Nativo - Leads - B2B", 5 conjuntos, **12
anúncios distintos** — 19 `ad_id`, porque o mesmo criativo roda em vários
conjuntos); e-commerce, uma ("[ECOMMERCE] [VENDA] [COMPRA] - 22/05", 3 conjuntos,
19 criativos); o resto é **impulsionamento**.

A tabela de criativos do B2B mostra **13 linhas para esses 12 anúncios**: a 13ª é
uma "casca" com gasto 0, criada pelo ETL (`:626-634`) para o nome antigo de um
anúncio que foi renomeado na Meta e que a planilha ainda atribui (337 envios com o
nome sem o sufixo " - HERO"). Não é bug de agregação e **não** é o mesmo criativo
contado duas vezes — `creatives` é indexado só pelo nome do anúncio (§7.4.10).

### 11.3 As particularidades que condicionam qualquer cálculo

| # | Fato | Consequência obrigatória |
|---|---|---|
| 1 | **Lead = negócio.** No Kommo o lead carrega etapa, UTMs, motivo de perda e responsável no mesmo objeto. Pipeline único `14043367` | Não existe join por e-mail no CRM. Ganho/perda **só** pelos IDs 142/143 |
| 2 | **`price = 0` em todos os 1.864 negócios**; `crm.total_value_won = 0,00`; `TICKET_MEDIO = 0` | **Não crie KPI de receita, LTV, ROI ou ticket no B2B** |
| 3 | **`utm_content` não identifica o anúncio**: os 118 leads que o trazem dizem "Novo conjunto de anúncios de Leads" (nome padrão da Meta) | O matching lead↔anúncio só existe no nível de **campanha** (via UTM) e por **criativo só via planilha**. Conjunto e criativo mostram só métricas de plataforma |
| 4 | **Cobertura de UTM 8,0 %** (138/1.720); **cobertura efetiva 31,6 %** (543, contando a planilha); `gclid` e `fbclid` = **0** | Todo CPL por CRM descreve **essa fatia**, não o total — o front diz isso na tela. O README ainda afirma 17,9 %: **está defasado** |
| 5 | **A planilha do formulário é a fonte real de atribuição**: 485 dos 620 leads pagos casam por ela, 129 por UTM ⇒ **614/620 = 99,0 %** | Se a planilha parar, setembro cai no fallback de 8 % (§13.2) |
| 6 | **Leads pagos foram importados em massa.** 03/07: **8** leads na plataforma × **93** no CRM (84 pagos). 06/07: 13 × 59 | `criado_em` nesse intervalo é a **data da importação**. Nunca leia a série diária do CRM como demanda real ali, nem calcule CPL diário do CRM. Depois de 27/07 as séries convergem |
| 7 | **62,2 % das primeiras respostas são automáticas** (<30 s; 826 de 1.327). Mediana da 1ª resposta **humana**: 356,3 min ≈ 5,9 h | O indicador humano descarta as automáticas. O README ainda diz 83 %: **defasado** |
| 8 | **Uma única responsável** (100 % dos leads) e **6 ganhos** no período; ciclo mediano 3,9 dias | A página de responsáveis tem uma linha só — não é bug |
| 9 | **Nome de campanha é chave de junção** e nomes mudam. O coletor da Meta reescreve o histórico por `campaign_id`; **o Google não tem esse mecanismo** | Renome no Google **parte o histórico em dois nomes**. Já aconteceu: `MAX CONV` → `ROAS 300` |
| 10 | **A API do Kommo corta em 7 req/s** (403 com bloqueio de IP) | O coletor segura em 5 req/s e pagina de 50 em 50. Não aumente |
| 11 | **Alcance (reach) nunca é somado** — não é aditivo | Coletado, mas deliberadamente fora das agregações |
| 12 | **Loja e GA4 não existem ainda** | Receita da loja, pedidos, ticket, sessões, MER e CAC ficam em **estado preparado**. MER e CAC são **impossíveis** com atribuição de plataforma |

### 11.4 Alertas que o ETL emite hoje (`relatorio.alertas`)

1. **rastreamento** — "Só 8% dos leads chegam com UTM. O CPL por CRM descreve essa fatia, não o total."
2. **valor** — "Nenhum lead tem valor preenchido no Kommo — não existe receita nem ticket real."
3. **atendimento** — "62% das conversas recebem resposta automática em <30s."

---

## 12. Histórico de decisões

| Data | Decisão | Motivo |
|---|---|---|
| 30/07/2026 | **Abandonar o protótipo Streamlit** e adotar o padrão de dashboards da agência (estático + Actions) | Custo zero, sem servidor, mesmo desenho do CDC e do Dr. Move. O protótipo antigo (`Terrana B2B\app.py`, `terrana.db`) continua na pasta-mãe — **não confundir** |
| 30/07 | `summary.js` além do `summary.json` | Permite abrir o painel com **duplo clique**: `file://` bloqueia `fetch`, não bloqueia `<script src>` |
| 30/07 | Login na **ordem de carga** do `loadData()` | O mesmo código serve dev (embutido) e produção (autenticado) sem branch |
| 30/07 | Netlify como hospedagem (`56c950d`) | Deploy rápido — reavaliado 24 h depois |
| 31/07 | **Identidade visual da Terrana** (`43e3895`) | Sair do azul do blueprint para mostarda/terracota da marca |
| 31/07 | **Dois painéis por frente + redesign guiado por dataviz** (`a53745a`) | B2B e e-commerce têm perguntas diferentes; e o combo com eixo duplo foi substituído por small multiples |
| 31/07 | Google Ads via **OAuth da agência pela MCC** | A conta da Terrana não é acessível direto pelo usuário OAuth (validado por chamada de API) |
| 31/07 | Netlify travada por créditos do time | Gatilho da migração |
| 05/08 | **Netlify removida; GitHub Pages é a hospedagem oficial** (`219950e`) | Um único fornecedor, mesmo lugar do CI, custo zero |
| 05/08 | **Deploy 1×/dia** (`e76d08f`) | O dado de mídia muda uma vez por dia; mais que isso só gasta cota de API |
| 05/08 | `FUNIL_ORDER` explícita | O sort nativo do Kommo põe FOLLOW UP **depois** da negociação |
| 05/08 | **Fase de autenticação preparada e adiada** (`e8baa7c`) | A gestora pediu para liberar o painel antes do login; o código fica pronto e **acende sozinho** quando as chaves forem preenchidas |
| 05/08 | **Planilha do formulário integrada** (`32f4d04`) | As UTMs cobriam pouco; a planilha dá atribuição **exata por criativo** |
| 31/08 | Correção do gate de secrets no shell (`628af55`) | O `if:` do step não enxerga `secrets` de forma confiável |
| 10/09 | **Visão Geral vira "Dashboard de Otimização"** + página "Qualidade dos dados" (`62756ad`) | Padrão do CDC: a home responde "o que fazer agora"; os banners âmbar saíram do topo de todas as páginas e viraram uma página própria |
| 11/09 | **Orçamentos mensais ligados** (`8e191ae`) | R$ 7.560/mês distribuídos; liga saldo, projeção e badge "Cabe / Não cabe" |
| 16/09 | **Painel E-commerce vira central de análise (fase 1)** (`ef6f0a7`) | Entregar o que já existe (mídia) com o lugar de cada número que falta em **estado preparado** |
| 16/09 | Pedido do "Marketing API Access Tier" para o app da Meta | Aumentar o limite compartilhado; **enquanto a análise roda, erro #4 conta contra** |
| 17/09 | **Coleta da Meta dentro da grade da agência** (`b53f1b4`); `coletar_dados.yml` e `etl_rapido.yml` removidos | Eles chamavam a Meta sem trava de horário e derrubavam a coleta de outros clientes |

---

## 13. Incidentes e armadilhas

### 13.1 Repositório privado desliga o GitHub Pages

Deixar o repositório privado (ou torná-lo privado) **derruba o site** no plano
gratuito. Sintoma: o workflow passa verde e a URL dá 404. **O repositório precisa
continuar público** — é justamente por isso que PII não pode entrar no summary
enquanto não houver login (§3.4). Recuperação: voltar o repo a público e
reexecutar o workflow.

### 13.2 A fonte pode parar sem que nada fique vermelho

- **O gate publica ou não publica em silêncio:** sem histórico fechado da Meta, `--verificar` devolve `pronto=false`, os 4 passos finais são pulados e o job fica **verde** com o site na última versão boa. Sintoma real: o `last_update` do site não anda. **Hoje não é o caso** — em 18/09 o gate devolveu `pronto=true` e o Pages republicou com dado até 18/09.
- **A cópia local não serve de diagnóstico:** `data_raw/meta_ads.json` terminar em 10/09 e `meta_coleta_estado.json` estar vazio **não** indica coleta parada — o cache incremental vive no `actions/cache` do runner (§10.6). Antes de concluir qualquer coisa, compare o `last_update` do summary publicado (§11).
- **Planilha parada desde 25/08:** `collectors/form_sheet.py` devolve o último snapshot com `::warning::` em vez de apagar dado bom — **o pipeline fica verde com dado velho**.

Regra prática: **se o painel "congelar", olhe o gate `pronto` primeiro e depois os
`::warning::` do log**, não o código.

### 13.3 Push dispara deploy

Qualquer push em `main` que toque `dashboard/**` republica o site em ~3–5 min, com
o dado da Meta em cache. **Não é um ambiente de rascunho.** Se a mudança não estiver
pronta para o cliente ver, não faça push.

### 13.4 O cache local da Meta é de uma versão anterior do coletor

As 990 linhas de `meta_ads.json` têm a chave legada `alcance` e **não têm
`campaign_id`/`adset_id` no formato atual**. Consequência: `tarefa_campanhas`
renomeia campanhas casando `campaign_id` — em linhas legadas isso **não casa**, e o
renome só vale para linhas recoletadas. O ETL não usa esses IDs (confirmado), então
o dashboard funciona; só não conte com IDs no histórico antigo.
`meta_campaigns.json` e `meta_creatives.json` vazios significam: sem status novo e
sem thumbnail/permalink nas linhas. Os 53 status atuais sobrevivem porque nada os apaga.
Tudo isso descreve a **cópia local** (990 linhas, até 10/09); o cache de produção
seguiu rodando e tem 1.067 linhas — não conclua nada sobre ele a partir daqui.

### 13.5 `main.py` exige os secrets da Meta mesmo com `--sem-meta`

Gate em `main.py:33-41`. Rodar local sem `META_ACCESS_TOKEN` no `.env` falha mesmo
que você não vá chamar a Meta.

### 13.6 Windows: encoding quebra coisas de três formas

1. **`PYTHONUTF8=1` é obrigatório.** Sem ele, `python -m unittest discover` dá `FAILED (errors=1)` por `UnicodeEncodeError` no `≠` de `meta_ads_api.py:555` — não é bug de lógica. Com a variável, os 16 testes passam.
2. **Nunca use `Add-Content` para escrever no `.env`.** O PowerShell grava em ANSI/UTF-16 e o `python-dotenv` passa a ler lixo, derrubando todas as credenciais de uma vez. Edite o `.env` num editor salvando em **UTF-8**.
3. **Here-string do PowerShell com `$` quebra.** Use a forma literal `@'...'@` (aspas simples), nunca `@"..."@`, e a linha de fechamento `'@` precisa estar na **coluna 0**.

### 13.7 Outra sessão pode estar no mesmo repositório

Já aconteceu de duas sessões do Claude editarem o mesmo repositório ao mesmo tempo
e uma sobrescrever a outra. **Sempre `git pull --rebase` antes de editar** e de novo
antes do push. Se um arquivo mudar sozinho no meio do trabalho, é isso — releia
antes de escrever por cima.

### 13.8 Artifact do claude.ai é rascunho; o site oficial é o github.io

Se algum chat publicar uma versão do painel como artifact no claude.ai, isso é
**rascunho**. A versão oficial, a que o cliente vê, é
`https://agencia-delucca.github.io/terrana_daschboard_performance_Delucca/`,
publicada pelo workflow a partir de `dashboard/`.

"Rascunho" vale para o **produto**, nunca para o **dado**: artifact, print e anexo
circulam igual ao site, então a regra de PII da §3.4 se aplica a eles do mesmo jeito.

### 13.9 O `README.md` está defasado em quatro pontos

Diz "17,9 % dos leads com UTM" (hoje **8,0 %**), "83 % das primeiras respostas são
robô" (hoje **62,2 %**), "Google Ads aguardando credenciais OAuth" (**já
integrado**) e mantém o Google Ads no checklist de produção. O comentário no topo
do `app.js` ("Sem login, sem Supabase") também está defasado. **Corrija o README,
não o código.** (Não foi possível confirmar de que data são os 17,9 %/83 % — trate
os números de §11 como os verdadeiros e o README como histórico.)

### 13.10 Outras armadilhas de edição

- **Escrever em `FILTER.b2b` sem `adoptFilter`** deixa a barra de filtro fora de sincronia.
- **Criar `new Chart()` fora de `makeChart()`** vaza memória e duplica canvas na troca de página.
- **`classificar_frente` engole campanha com nome fora da convenção** como `outras` — o `::warning::` no log é o único sinal.
- **A página Público é mensal**, não diária, e usa cliques totais: não a compare com as páginas diárias.
- **Mudar `META_SINCE` mexe também no range do Google Ads** (`google_ads.py:98`).
- **`.netlify/`** na pasta local é resíduo; o site velho `terrana-performance.netlify.app` pode continuar público com dados de 30/07 — ver §14.7.

---

## 14. Pendências e próximos passos

Ordem de prioridade. Cada item diz **onde mexer**.

```
[1] Destravar a planilha do formulário  ──► pré-requisito de TUDO
    (a coleta da Meta já voltou em 18/09; a planilha é que está parada)
        ├─► [3] Metas de custo        (config pura, 10 min, independente)
        ├─► [2] Supabase + login      (independente; libera PII e tira o dado do ar público)
        ├─► [5] Graph v21 → v25       (independente; só dentro da janela da Meta)
        └─► [4] GA4 + API da loja     (bloqueada por credenciais do cliente)
                    └─► [6] QA da Fase 5   ◄── PORTÃO FINAL, antes de mostrar ao cliente
```

### 14.1 URGENTE — destravar a planilha do formulário

| Fonte | Último dado **em produção** | Diagnóstico |
|---|---|---|
| Meta | **2026-09-18** | ✅ voltou a rodar em 18/09 03:10 BRT, no primeiro disparo do cron novo. Nada a fazer |
| Planilha (`planilha_total` = 444) | **2026-08-25** | ⛔ parada há mais de 3 semanas — **é esta a pendência** |
| Google | 2026-09-17/18 | ✅ em dia |

Ignore as datas de `data_raw/` local: os `meta_*.json` daqui param em 10/09 porque o
cache incremental vive no `actions/cache` do runner (§10.6, §13.2).

**O que fazer com a planilha:** procurar o `::warning::` "Planilha do formulário" no
log da última execução; conferir se ela continua compartilhada como **Leitor** com o
service account (`dashboard-sheets@dashboard-marketing-495617.iam.gserviceaccount.com`)
e se o conector Meta → Sheets ainda publica. Enquanto ela estiver parada, o lead novo
só tem a via de UTM (7,3 % de cobertura) e a atribuição por criativo congela
(§11.3.5). Depois de destravar, rodar o ETL e comparar com o summary publicado (§11).

**Se ainda assim for preciso rodar a Meta "hoje"**, existem exatamente três rotas
legítimas — e **nenhuma** delas é rodar o coletor nesta máquina (§3.3.5: a rajada
dobraria a do cron no mesmo app compartilhado e o bruto local não chega ao site):

1. **Esperar o cron** de amanhã, 03:10 BRT. É o caminho normal e o que quase sempre
   resolve.
2. **Actions → "Deploy Dashboard (GitHub Pages)" → Run workflow**, com `coletar_meta`
   marcado, **disparado por alguém acordado entre 03:10 e 03:59 BRT**. Fora da janela
   o coletor sai com `::warning::` e a rodada não coleta nada. O `gh` CLI não está
   instalado aqui — é pela interface web do GitHub.
3. **Dispatch com `coletar_meta` E `janela_comercial`** marcados, das 09:10 às 18:59
   BRT. É a única rota que roda de dia e exige **liberação prévia de quem responde
   pela grade na agência** (`confirmar com ___`: nome e canal não estão registrados;
   pergunte à gestora antes de usar).

Se um dia o gate voltar a travar de verdade (`::warning::Meta não pronta`), leia o
resumo da rodada no log (`parou_por`, `tarefas_ok`, `falhas`) e confira se o cache
`meta-raw-` ainda existe. Se tiver expirado, a próxima rodada agendada refaz o
backfill mês a mês sozinha — pode levar mais de uma noite, e o site só volta a
atualizar quando o histórico fechar.

### 14.2 Login do cliente — Supabase Auth + bucket privado

**Código pronto nas duas pontas**, esperando as chaves do Supabase. Mas o código é
só metade: a outra metade é configuração no painel do Supabase, e **errar a ordem
tira o dashboard do ar**.

1. Criar projeto Supabase **novo e exclusivo da Terrana** (um por cliente é o padrão da agência).
2. Criar bucket **privado** chamado exatamente `dashboard-data` — o nome está
   **hardcoded no ETL** (`generate_dashboard_data.py:1156`, `from_("dashboard-data")`),
   enquanto o front usa a constante `SUPABASE_BUCKET` (`app.js:3848`). Renomear o
   bucket mexendo só no `app.js` quebra o upload **em silêncio** (§7.4.9). O objeto
   é `summary.json` na raiz, enviado com `upsert: "true"`.
3. **Criar a policy de leitura** — sem ela o login "funciona" e o download falha.
   Bucket privado nega `download` até para usuário logado enquanto não houver
   `SELECT` em `storage.objects`; `baixarSummary()` (`app.js:3900-3905`) faz
   `throw error`, o `catch` do submit mostra a mensagem e o cliente **nunca entra**.
   A policy tem que ser por **e-mail**, não por `role = authenticated`:
   `bucket_id = 'dashboard-data' AND auth.email() = 'dashboard@terrana.com.br'`.
4. **Fechar o cadastro público e confirmar o usuário.** Criar o usuário de Auth
   `dashboard@terrana.com.br` (e-mail já fixado no código; a tela pede só a senha)
   **com "Auto Confirm User" ligado**, e **desligar "Allow new users to sign up"**.
   Motivo: a anon key é versionada num repositório **público** (§13.1); com o
   cadastro aberto e uma policy só de `authenticated`, qualquer pessoa cria conta e
   baixa o summary — que a essa altura já sai **com nome e telefone** (§3.4). E
   usuário não confirmado faz `signInWithPassword` devolver "Email not confirmed",
   que o front troca pela mensagem fixa **"Senha incorreta."** (`app.js:3955`) —
   diagnóstico enganoso, você vai caçar senha onde o problema é confirmação.
5. Preencher, **nesta ordem** (§14.2.1 abaixo): **`app.js:3845-3846`**
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY` — a anon key é pública por design e vai
   versionada, **desde que** o passo 3 esteja feito e a RLS das tabelas esteja
   ligada; a **service key nunca entra no front**), depois os secrets
   `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` no CI, e o `.env` local em UTF-8.

#### 14.2.1 A ordem de ativação é obrigatória

Assim que o secret `SUPABASE_SERVICE_KEY` existir, o passo "Modo autenticado"
(`deploy_pages.yml:150-160`) apaga `summary.json`/`summary.js` do artefato **na
publicação seguinte**. Se a versão publicada do `app.js` ainda tiver
`SUPABASE_URL = ''`, o `loadData()` cai no caminho 4 e mostra `showFatal()`: site no
ar, cliente sem painel. Por isso:

1. Supabase pronto: projeto + bucket privado + policy por e-mail + usuário confirmado + cadastro fechado.
2. Commit do `app.js` com URL e anon key preenchidas — **e esperar o deploy terminar**.
3. **Só então** cadastrar `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` nos secrets do repositório.
4. Rodar o workflow manualmente (**sem** `coletar_meta`) para o ETL subir o primeiro `summary.json` ao bucket.
5. Conferir em **aba anônima**: tela de login → senha → painel carrega. Só aí avisar o cliente.

Para exercitar o login **antes** de publicar, veja "Testar o login localmente" em
§2.3 — em localhost a tela de login nunca aparece sozinha.

**O que muda sozinho** (não reescreva o workflow): com o summary fora do artefato, o
404 de `data/summary.js` no console passa a ser **esperado** — não "conserte"
removendo a tag do `index.html`, é ela que permite o duplo clique em dev; e `expor_pessoais`
(`generate_dashboard_data.py:1185`) libera `crm.leads_parados` com nome e telefone
(`:426-439`), consumido em `renderFunilCRM` (`app.js:1582-1598`). **É essa a razão
de o login existir.**

### 14.3 Metas de custo ainda em 0

Zero linha de código: são **Variables** do repositório (`CPL_TARGET_META`,
`CPL_TARGET_GOOGLE`, `CPA_TARGET_ECOM`, `ROAS_TARGET_ECOM`, `TICKET_MEDIO`).
Consumo no front: `otCfg()` (`app.js:874`), `metaBadgeCusto()` (`:904`),
`ecvMetasHtml()` (`:2878`). Falta o cliente cravar os números.

### 14.4 GA4 + API da plataforma da loja (fase 2 do e-commerce)

Bloqueada por credenciais do cliente. Falta: **GA4 Property ID**, acesso de Leitor
no GA4 para o service account que já lê a planilha (**nenhuma credencial nova
precisa ser criada**), **qual é a plataforma da loja** (perguntado em 16/09, sem
resposta) e as credenciais dela.

Onde entra: coletores novos `collectors/ga4.py` e `collectors/loja.py` no molde de
`form_sheet.py` (com fallback para o último snapshot), granularidade **diária**;
`config.py` ganha `GA4_PROPERTY_ID`, `LOJA_API_URL`, `LOJA_API_TOKEN` (replicar os
nomes no `.env.example`); `main.py` chama os dois **fora** do gate de secrets
essenciais; no ETL, `ler("ga4")`/`ler("loja")` perto de `:1163` e duas funções
`aggregate_ga4`/`aggregate_loja` no padrão de `aggregate_google` (`:886`),
registradas no dict `summary` (`:1219`); no front, promover **card a card** dentro
de `renderVisaoEcom` (`app.js:2906-3177`): KPIs preparados em **2985-2995**, linhas
de canal em **3027-3029**, funil em **3040-3048**, as 8 análises em **3050-3064**,
banner de atribuição em **2935**.

### 14.5 Coletor ainda na Graph API v21.0 (a agência usa v25.0)

A versão vive em `config.py:22` e entra na URL em `meta_ads_api.py:98-99` (ponto
único). **Mas também está hardcoded no teste**: `tests/test_meta_coleta.py:154`
(URL da próxima página) e `:167` (`setUp`). Trocando só o `config.py`, o teste de
paginação **continua passando por acidente**. Migrar → rodar os 16 testes →
conferir se algum campo de `CAMPOS_INSIGHTS` mudou entre v21 e v25 → validar contra
a API real **só numa rodada acompanhada dentro da janela**.

### 14.6 Google Ads B2B

**Não é bug e não exige código.** A conta não tem campanha da frente B2B. Basta o
gestor criar campanha com "Geração de leads B2B" (ou "Formulário Nativo", ou
"leads" + "b2b") no nome e ela entra sozinha na rodada seguinte, sem deploy
(`classificar_frente`, ETL `:717-745`). Pendência menor relacionada: a Terrana ter
OAuth próprio em vez de usar o da agência.

### 14.7 Menores, sem bloqueio

- **`utm_content={{ad.name}}` nos anúncios** — destrava CPL por criativo pela via das UTMs (configuração no Gerenciador, não código).
- **Valor dos leads no Kommo** — enquanto todo lead tiver `price=0`, o B2B não tem receita nem ticket.
- **Excluir o site velho da Netlify** (`terrana-performance.netlify.app`) — pode estar público com dados de 30/07/2026.
- **Atualizar o `README.md`** (§13.9) e o comentário do topo do `app.js`.
- **Limpezas seguras:** remover a closure morta `fecha()` (ETL `:638`), corrigir o alerta morto (`:1117`), decidir sobre os resíduos azuis do CSS (§9.4.5).

---

## 15. Checklist de QA antes de mostrar ao cliente

- [ ] **Coleta em dia**: as três fontes com dado recente, conferidas no summary **publicado** (§11) e não no `data_raw/` local, e `summary.json` regenerado depois da última coleta.
- [ ] **Gasto conferido contra o gerenciador**, mês a mês: `#b2b/meta` e `#ecom/meta` contra o Gerenciador de Anúncios; `#ecom/google` contra o Google Ads. Divergência só por fuso — aqui tudo é BRT.
- [ ] **Status Ativo/Pausado** igual ao da plataforma; `—` onde a API não devolveu (regra 2).
- [ ] **Decomposição ≤ KPI** em toda tabela: soma das campanhas ≤ total da frente; soma dos criativos ≤ campanha. O ETL já trava o caso dos leads (`:1262-1267`); o resto é conferência visual.
- [ ] **Filtro de dia sem gasto fantasma**: dia **dentro** da série sem linha = 0; dia **fora** da série = `null`, nunca "R$ 0,00" (`ecvDaily`, `app.js:2371-2390`). Testar nos dois extremos.
- [ ] **CPL = gasto ÷ leads do CRM** na tela, com `leads_plat` rotulado como referência de plataforma.
- [ ] **Nenhuma soma de receita Meta + Google** em nenhum card, tabela ou gráfico.
- [ ] **Nenhum card preparado sem motivo escrito**; nenhum número estimado disfarçado de real.
- [ ] **Página "Qualidade dos dados"** lida inteira nas duas frentes: cada alerta tem um "o que fazer" executável pela gestora.
- [ ] **PII**: com o site público, `crm.leads_parados` **não** pode trazer nome/telefone. Conferir em aba anônima.
- [ ] **Navegação**: as 9 páginas B2B e as 7 do e-commerce sem erro no console; trocar de frente e conferir que o período de cada uma é preservado.
- [ ] **Responsivo**: notebook e celular, sem rolagem horizontal da página.
- [ ] **pt-BR** em 100 % do que aparece, inclusive tooltips e ticks.
- [ ] **Testes do coletor** verdes se `meta_ads_api.py` foi tocado: `PYTHONUTF8=1 python -m unittest discover -s tests -t .`
- [ ] **O que vai aparecer e não é bug**: importação em massa de leads em 03/07 e 06/07 (§11.3.6); cobertura efetiva de 31,6 %; nenhum lead com valor preenchido.

---

## 16. Prompt sugerido para abrir o próximo chat

> Vou continuar o desenvolvimento do **dashboard de performance da Terrana
> (Agência Delucca)**. A pasta local do projeto é
> `C:\Users\geova\OneDrive\Área de Trabalho\Claude\Terrana B2B\terrana-performance`
> (repositório `Agencia-Delucca/terrana_daschboard_performance_Delucca`, publicado
> em `https://agencia-delucca.github.io/terrana_daschboard_performance_Delucca/`).
>
> **Antes de qualquer coisa, leia `docs/HANDOFF_CONTINUIDADE.md` inteiro** — é o
> documento de continuidade do projeto — e depois o `README.md`. Eles contêm a
> arquitetura, as regras inegociáveis, o mapa dos arquivos, o estado dos dados e as
> pendências.
>
> Três regras que você precisa respeitar desde o primeiro comando:
> 1. **Nunca leia `dashboard/assets/app.js`, `dashboard/assets/style.css`,
>    `dashboard/index.html`, `scripts/generate_dashboard_data.py` ou
>    `dashboard/data/summary.json` inteiros** — use `grep` para localizar e leia em
>    fatias de até 200 linhas; edite sempre por trecho.
> 2. **Nunca chame a API real da Meta fora da janela 03:10–03:59 BRT** (grade da
>    agência: o app da Meta é compartilhado entre os dashboards de todos os
>    clientes). Para testar o coletor, use `PYTHONUTF8=1 python -m unittest discover -s tests -t .`
> 3. **Nunca imprima token, senha ou chave, e nunca copie nome, telefone ou e-mail
>    de lead** — `data_raw/kommo_contacts.json` e `data_raw/form_sheet.json` têm
>    dado pessoal real.
>
> No Windows, use sempre `PYTHONUTF8=1` ao rodar Python, e faça `git pull --rebase`
> antes de editar (outra sessão pode estar no mesmo repositório).
>
> Depois de ler o handoff, me diga em poucas linhas o que entendeu do estado atual
> e qual você acha que deve ser o primeiro passo — **sem editar nada ainda**.

---

*Escrito em 18/09/2026 a partir do estado real do repositório (commit `b53f1b4`), do
snapshot local de 17/09/2026 e do summary publicado em 18/09/2026 03:39. Os números
de linha valem para essa versão; confirme com `grep` antes de usar.*
