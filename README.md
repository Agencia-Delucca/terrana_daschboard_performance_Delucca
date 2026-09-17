# Terrana Performance — Dashboard de Marketing

Dashboard estático autenticado no padrão da Agência Delucca (mesmo desenho do
CDC e do Dr. Move): coleta agendada no GitHub Actions, um único `summary.json`
em bucket privado do Supabase, front HTML/JS puro no GitHub Pages. Custo de
infra: R$ 0.

```
Fontes (Kommo CRM · Meta Ads API · Google Ads API*)
        │ leitura via API (read-only)
        ▼
GitHub Actions — diário às 03:10 (Brasília); a Meta só é chamada nessa hora
  1. python -m collectors.meta_ads_api         → data_raw/meta_*.json (cache)
  2. python main.py --sem-meta                 → Kommo, planilha, Google
  3. python scripts/generate_dashboard_data.py → dashboard/data/summary.json
        │                                        + upload pro Supabase
        ▼
Supabase Storage — bucket PRIVADO dashboard-data
        ▲ service_role key (só no CI)     │ download com sessão autenticada
GitHub Pages (só HTML/JS, nenhum dado)    Browser (login Supabase Auth)
```

*Google Ads aguardando credenciais OAuth — a página mostra estado honesto.

## Grade da Meta — cada dashboard na sua hora

Todos os dashboards da Agência Delucca usam o mesmo app da Meta,
**"Delucca dash criativos" (id `639332675906356`)**, e o limite de chamadas
vale para o **app inteiro** — a própria Meta: *"Rate limiting is at the
application level. When your app is rate limited, all Ads Insights API calls
for the app are limited."* Uma rajada de um dashboard faz os outros receberem
`(#4) Application request limit reached`. Por isso a agência tem uma grade:
**cada dashboard tem a sua hora e ninguém coleta na hora de outro.**

**Este dashboard (conta `act_1508321467453573`): 03:10 às 03:59 em Brasília
(06:10 às 06:59 UTC). Cron: `10 6 * * *`.**

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

Em 16/09/2026 a agência pediu à Meta o nível "Marketing API Access Tier" para
este app. A grade continua valendo depois da aprovação. Enquanto a análise
estiver aberta, cada erro 4 conta na taxa de erro avaliada (precisa ficar
abaixo de 15% nas últimas 500 chamadas).

Como o projeto cumpre a grade:

- **Só a execução agendada chama a Meta.** O workflow liga `META_COLETA=sim`
  apenas no `schedule`. Pushes e execuções manuais publicam com o último dado
  da Meta guardado em cache; localmente a coleta fica desligada.
- **O coletor olha o relógio** (`collectors/meta_ads_api.py`): fora da janela
  não chama nada; depois das 03:45 faz só o essencial (campanhas e últimos
  8 dias); não começa chamada no último minuto e para às 03:59.
- **Uma consulta por vez**, só os campos que a tela usa, páginas de 100
  (breakdowns, 200). Anúncios ativos via filtro de `effective_status`,
  conferido linha a linha.
- **Não relê o que não muda.** O histórico fica em cache; cada noite relê só
  os últimos 8 dias (a atribuição de 7 dias ainda mexe neles), as campanhas,
  os anúncios ativos e o mês corrente dos breakdowns. Criativo de anúncio
  pausado é lido uma vez só. A primeira noite sem cache faz o backfill mês a
  mês; se não couber, continua na noite seguinte e o site só é republicado
  com o histórico completo.
- **Lê os cabeçalhos de uso em toda resposta** (`x-app-usage`,
  `x-business-use-case-usage`, `x-fb-ads-insights-throttle`): acima de 30%
  a rodada para e o resto fica para a próxima noite.
- **Erro de limite para a rodada na hora** (#4, #17, #32, #613,
  #80000–#80014), mesmo com os números de uso baixos. Nova tentativa só
  depois de 15 minutos e se ainda couber na janela; senão fica para a noite
  seguinte. Nenhuma tentativa entra na hora de outro dashboard.
- O resumo de cada rodada (chamadas, pico de uso, onde parou) fica em
  `data_raw/meta_coleta_estado.json` e no log do Actions.

Regras para quem mexer no projeto:

- **Carga pesada e testes com a API real** (histórico, backfill, rajadas) só
  dentro desta hora ou, com pausas e **combinado antes com a agência**, no
  horário comercial das 09:10 às 18:59 — execução manual do workflow com
  `coletar_meta` e `janela_comercial` marcados. Nunca na hora de outro
  dashboard.
- Para testar a lógica do coletor sem chamar a Meta:
  `python -m unittest discover -s tests -t .`
- **Não criar outro app na Meta nem trocar de token** para fugir do limite sem
  combinar com a agência — o pedido de nível de acesso foi feito para este
  app.
- Chamadas ao Google Ads e ao Kommo não entram nesta grade.

## Como rodar local

```bash
pip install -r requirements.txt
python main.py                              # coleta (~3 min) — a Meta vem do cache
python scripts/generate_dashboard_data.py   # gera dashboard/data/summary.json
python -m http.server 8010 -d dashboard     # abre em http://localhost:8010
```

Localmente a Meta não é chamada (`META_COLETA` desligado): o coletor usa o
cache em `data_raw/meta_*.json`. Em `localhost` o front lê
`data/summary.json` direto, sem login.

## Regras de ouro (herdadas do blueprint da agência — inegociáveis)

1. **CPL = gasto ÷ leads do CRM.** Métrica de plataforma é referência
   (`leads_plat`), nunca denominador.
2. **Status Ativo/Pausado vem da API** (`effective_status`), nunca de
   heurística. Ausente → "—" no front.
3. **Toda tabela com filtro de dia consome fonte diária** (`*_daily`).
4. **Atribuição por dimensão real.** Na Terrana o elo confiável é
   `utm_campaign` × nome da campanha — o matching fica no nível de campanha
   (ver abaixo) e conjunto/criativo não recebem leads inventados.
5. Rateio proporcional ao gasto quando houver ambiguidade — nunca duplicar.
6. **Decomposição ≤ KPI** (checagem automática no ETL; violou → exit 1).
7. **Nunca falhar em silêncio** — `::error::`/`::warning::` no CI, banner no
   front, gate de secrets antes de qualquer coisa.
8. Perdido = etapa terminal 143 do Kommo (ganho = 142), com motivo
   "Não informado" quando vazio.
9. Nada de dado real hardcoded.
10. Preview antes de produção (a configurar junto com o Pages).

## O que os dados da Terrana têm de específico

- **Lead = negócio.** No Kommo o lead carrega etapa, UTMs e motivo de perda —
  não há join por e-mail.
- **Rastreamento: 17,9% dos leads com UTM.** Desses, 100% casam com a
  campanha "AD - Formulário Nativo - Leads - B2B". 84 leads chegam com
  `utm_campaign` mas sem `utm_source` — o ETL os reconhece como pagos do Meta
  porque a campanha só existe lá (`resolver_fontes`).
- **`utm_content` não identifica o anúncio**: chega "Novo conjunto de anúncios
  de Leads" (nome padrão). Por isso o CPL por CRM existe só no nível de
  campanha. Para ganhar CPL por criativo: configurar `utm_content={{ad.name}}`
  nos anúncios.
- **Nenhum lead tem valor preenchido** (`price = 0` em todos) — não existe
  receita nem ticket real. `TICKET_MEDIO=0` esconde números de dinheiro.
- **83% das primeiras respostas são robô** (<30 s). O indicador de resposta
  humana descarta essas — mede a espera por uma pessoa.
- **A API do Kommo corta em 7 req/s** (403 com bloqueio de IP). O coletor
  segura em 5 req/s e pagina de 50 em 50.
- A conta Meta é majoritariamente **impulsionamento** (alcance/tráfego);
  a captação de leads é uma campanha de formulário nativo.

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Origem |
|---|---|
| `KOMMO_SUBDOMAIN` | `terrana` |
| `KOMMO_TOKEN` | Kommo → Configurações → Integrações → token de longa duração |
| `META_ACCESS_TOKEN` | token de usuário de sistema (Delucca API Connector) |
| `META_AD_ACCOUNT_ID` | `1508321467453573` |
| `GOOGLE_ADS_*` | aguardando OAuth (conta 223-460-7566) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | projeto novo exclusivo da Terrana |

Variables (não sensíveis): `TICKET_MEDIO`, `CPL_TARGET_META`,
`CPL_TARGET_GOOGLE` — 0 = indicador desligado com aviso honesto.

## Checklist de produção (pendente)

- [ ] Repositório GitHub + Secrets acima
- [ ] Supabase: projeto novo → bucket privado `dashboard-data` → usuário de
      Auth do front → preencher `SUPABASE_URL`/`SUPABASE_ANON_KEY` no
      `dashboard/assets/app.js`
- [ ] GitHub Pages (source: GitHub Actions)
- [ ] Credenciais OAuth do Google Ads → implementar coletor GAQL
      (esqueleto documentado em `collectors/google_ads.py`)
- [ ] Metas de negócio com o cliente: CPL alvo e ticket médio
- [ ] QA da Fase 5 do blueprint antes de liberar ao cliente: status e gasto
      conferidos contra o gerenciador, decomposição ≤ KPI, filtro de dia sem
      gasto fantasma
