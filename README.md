# Terrana Performance — Dashboard de Marketing

Dashboard estático autenticado no padrão da Agência Delucca (mesmo desenho do
CDC e do Dr. Move): coleta agendada no GitHub Actions, um único `summary.json`
em bucket privado do Supabase, front HTML/JS puro no GitHub Pages. Custo de
infra: R$ 0.

```
Fontes (Kommo CRM · Meta Ads API · Google Ads API*)
        │ leitura via API (read-only)
        ▼
GitHub Actions — cron 3x/dia (07:30, 13:30, 16:00 BRT)
  1. python main.py                            → data_raw/*.json (brutos)
  2. python scripts/generate_dashboard_data.py → dashboard/data/summary.json
        │                                        + upload pro Supabase
        ▼
Supabase Storage — bucket PRIVADO dashboard-data
        ▲ service_role key (só no CI)     │ download com sessão autenticada
GitHub Pages (só HTML/JS, nenhum dado)    Browser (login Supabase Auth)
```

*Google Ads aguardando credenciais OAuth — a página mostra estado honesto.

## Como rodar local

```bash
pip install -r requirements.txt
python main.py                              # coleta (~3 min)
python scripts/generate_dashboard_data.py   # gera dashboard/data/summary.json
python -m http.server 8010 -d dashboard     # abre em http://localhost:8010
```

Em `localhost` o front lê `data/summary.json` direto, sem login.

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
