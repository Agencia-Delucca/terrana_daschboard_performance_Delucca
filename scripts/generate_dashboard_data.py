"""ETL — lê data_raw/*.json, agrega tudo e gera dashboard/data/summary.json.

Regras de ouro aplicadas (ver README):
- 1: CPL de verdade usa leads do CRM; métrica de plataforma é só referência
     e anda SEMPRE rotulada como `*_plat`.
- 3: toda tabela que aceita filtro de dia tem lista *_daily própria.
- 4: atribuição por dimensão REAL — cada linha bruta da Meta traz sua
     campanha/conjunto; nunca inferir por nome de anúncio.
- 5: leads casados por nome são RATEADOS proporcionalmente ao gasto quando o
     mesmo anúncio roda em N conjuntos no mesmo dia.
- 6: decomposição ≤ KPI (a soma por campanha/anúncio nunca excede o total
     por UTM).
- 7: nunca falhar em silêncio — ::error::/::warning:: no CI, aviso no front.

Uso:  python scripts/generate_dashboard_data.py
"""
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402

BRT = timezone(timedelta(hours=-3))

# Resposta que sai em menos de 30s é o robô de boas-vindas, não a equipe.
LIMITE_RESPOSTA_AUTOMATICA_MIN = 0.5

# Matching utm_content ↔ nome do anúncio (Jaccard) — threshold do projeto-base.
JACCARD_THRESHOLD = 0.4
_TOKEN_STOP = {"anuncio", "ad", "ads", "de", "da", "do", "estatico", "animado",
               "video", "imagem", "post", "v1", "v2", "v3", "v4", "v5"}


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def ler(nome):
    path = os.path.join(config.RAW_DIR, f"{nome}.json")
    if not os.path.exists(path):
        print(f"::warning::{path} não existe — rode main.py antes. Seguindo com vazio.")
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dia(iso):
    """'2026-07-30T12:34:56-03:00' → '2026-07-30'."""
    return (iso or "")[:10]


def mes(iso):
    return (iso or "")[:7]


def rnd(x, casas=2):
    return round(float(x), casas)


def _tokens(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = s.encode("ascii", "ignore").decode()
    return {t for t in re.split(r"[^a-z0-9]+", s)
            if len(t) >= 3 and t not in _TOKEN_STOP}


def resolver_fontes(leads, meta_rows):
    """Marca lead['_fonte'] = 'meta' | 'google' | 'outro' | None.

    Além da utm_source, dois sinais identificam clique pago sem inventar dado:
    - fbclid/gclid presente (a UTM se perdeu mas o clique é rastreado);
    - utm_campaign que casa (Jaccard) com uma campanha REAL do Meta — na
      Terrana 84 leads chegam com utm_campaign="Leads - B2B" e utm_source
      vazio; a campanha só existe no Meta, então a fonte é inequívoca.
    """
    pool = {}
    for r in meta_rows:
        nome = r.get("campanha", "")
        if nome and nome not in pool:
            pool[nome] = _tokens(nome)

    def campanha_meta(camp):
        toks = _tokens(camp)
        if not toks:
            return False
        return any(
            ntoks and len(toks & ntoks) / len(toks | ntoks) >= JACCARD_THRESHOLD
            for ntoks in pool.values())

    for lead in leads:
        src = (lead.get("utm_source") or "").lower().strip()
        if src in config.PAID_SOURCES_META or lead.get("fbclid"):
            fonte = "meta"
        elif src in config.PAID_SOURCES_GOOGLE or lead.get("gclid"):
            fonte = "google"
        elif not src and lead.get("utm_campaign") \
                and campanha_meta(lead["utm_campaign"]):
            fonte = "meta"
        elif src:
            fonte = "outro"
        else:
            fonte = None
        lead["_fonte"] = fonte


def fonte_paga(lead):
    return lead.get("_fonte")


# ----------------------------------------------------------------------
# Matching leads CRM ↔ anúncios Meta (Jaccard por utm_content)
# ----------------------------------------------------------------------


def match_leads_meta(leads, meta_rows):
    """{campanha: {dia: n_leads}} + estatísticas de cobertura.

    Universo: leads pagos de Meta. Na Terrana o elo confiável é o
    utm_campaign × nome da campanha (Jaccard): o utm_content chega com o
    nome PADRÃO do conjunto ("Novo conjunto de anúncios de Leads"), que não
    identifica anúncio nem conjunto — então o matching fica no nível de
    campanha e as tabelas de conjunto/criativo mostram só métricas de
    plataforma, sem inventar granularidade (regra 4).

    Para ganhar CPL por criativo no futuro: configurar os anúncios com
    utm_content={{ad.name}} — o alerta de rastreamento do relatório cobra isso.
    """
    pool = {}
    for r in meta_rows:
        nome = r.get("campanha", "")
        if nome and nome not in pool:
            pool[nome] = _tokens(nome)

    daily = defaultdict(lambda: defaultdict(int))
    pagos = com_campaign = matched = 0
    for lead in leads:
        if fonte_paga(lead) != "meta":
            continue
        pagos += 1
        campanha = lead.get("utm_campaign")
        if not campanha:
            continue
        com_campaign += 1
        toks = _tokens(campanha)
        if not toks:
            continue
        best, best_score = None, 0.0
        for nome, ntoks in pool.items():
            if not ntoks:
                continue
            score = len(toks & ntoks) / len(toks | ntoks)
            if score > best_score:
                best, best_score = nome, score
        if best and best_score >= JACCARD_THRESHOLD:
            daily[best][dia(lead.get("criado_em"))] += 1
            matched += 1

    stats = {
        "nivel": "campanha",
        "leads_pagos_meta": pagos,
        "com_utm_campaign": com_campaign,
        "matched": matched,
        "cobertura_pct": rnd(matched / pagos * 100, 1) if pagos else 0,
    }
    print(f"  Matching Meta (nível campanha): {matched}/{pagos} leads pagos "
          f"casados ({com_campaign} com utm_campaign)")
    return daily, stats


# ----------------------------------------------------------------------
# Agregações
# ----------------------------------------------------------------------


def aggregate_leads(leads):
    monthly = defaultdict(lambda: {"total": 0, "pagos": 0, "organicos": 0,
                                   "sem_utm": 0, "meta": 0, "google": 0})
    daily = defaultdict(lambda: {"total": 0, "pagos": 0, "sem_utm": 0})
    by_source = defaultdict(int)

    pagos = organicos = sem_utm = 0
    for lead in leads:
        f = fonte_paga(lead)
        m, d = mes(lead.get("criado_em")), dia(lead.get("criado_em"))
        monthly[m]["total"] += 1
        daily[d]["total"] += 1
        if f in ("meta", "google"):
            pagos += 1
            monthly[m]["pagos"] += 1
            monthly[m][f] += 1
            daily[d]["pagos"] += 1
        elif f == "outro":
            organicos += 1
            monthly[m]["organicos"] += 1
        else:
            sem_utm += 1
            monthly[m]["sem_utm"] += 1
            daily[d]["sem_utm"] += 1
        if lead.get("utm_source"):
            by_source[lead["utm_source"]] += 1

    return {
        "total": len(leads),
        "pagos": pagos,
        "organicos": organicos,
        "sem_utm": sem_utm,
        "monthly": [{"mes": k, **v} for k, v in sorted(monthly.items())],
        "daily": [{"dia": k, **v} for k, v in sorted(daily.items())],
        "by_source": sorted(
            [{"fonte": k, "leads": v} for k, v in by_source.items()],
            key=lambda x: -x["leads"])[:15],
    }


def aggregate_crm(leads, statuses):
    sort_por_etapa = {s["etapa"]: s.get("sort", 0) for s in statuses}
    funnel = defaultdict(int)
    active = defaultdict(int)
    losses = defaultdict(int)
    losses_daily = []
    by_resp = defaultdict(lambda: {"total": 0, "ganhos": 0, "valor": 0.0})
    monthly_won = defaultdict(lambda: {"ganhos": 0, "valor": 0.0})
    deals_minimal = []
    ciclos = []

    won = lost = 0
    value_won = 0.0
    for lead in leads:
        etapa = lead.get("etapa", "?")
        funnel[etapa] += 1
        deals_minimal.append({
            "etapa": etapa,
            "criado_em": dia(lead.get("criado_em")),
            "ganho": lead.get("ganho", False),
            "perdido": lead.get("perdido", False),
            "utm_source": lead.get("utm_source"),
            "utm_campaign": lead.get("utm_campaign"),
        })
        resp = lead.get("responsavel") or "Sem responsável"
        by_resp[resp]["total"] += 1

        if lead.get("ganho"):
            won += 1
            value_won += lead.get("valor", 0)
            by_resp[resp]["ganhos"] += 1
            by_resp[resp]["valor"] += lead.get("valor", 0)
            m = mes(lead.get("fechado_em") or lead.get("criado_em"))
            monthly_won[m]["ganhos"] += 1
            monthly_won[m]["valor"] += lead.get("valor", 0)
            if lead.get("fechado_em") and lead.get("criado_em"):
                dt_c = datetime.fromisoformat(lead["criado_em"])
                dt_f = datetime.fromisoformat(lead["fechado_em"])
                ciclos.append((dt_f - dt_c).total_seconds() / 86400)
        elif lead.get("perdido"):
            lost += 1
            motivo = lead.get("motivo_perda") or "Não informado"
            losses[motivo] += 1
            losses_daily.append({
                "data": dia(lead.get("fechado_em")) or dia(lead.get("criado_em")),
                "criado": dia(lead.get("criado_em")),
                "motivo": motivo,
                "utm_source": lead.get("utm_source"),
                "utm_campaign": lead.get("utm_campaign"),
                "utm_content": lead.get("utm_content"),
            })
        else:
            active[etapa] += 1

    ciclos.sort()
    n = len(ciclos)
    total = len(leads)
    fechados = won + lost
    return {
        "total_deals": total,
        "total_won": won,
        "total_lost": lost,
        "total_open": total - fechados,
        "total_value_won": rnd(value_won),
        "taxa_fechamento": rnd(won / total * 100, 1) if total else 0,
        "taxa_fechamento_decididos": rnd(won / fechados * 100, 1) if fechados else 0,
        "funnel": sorted(
            [{"etapa": k, "total": v, "sort": sort_por_etapa.get(k, 9999)}
             for k, v in funnel.items()], key=lambda x: x["sort"]),
        "active_funnel": sorted(
            [{"etapa": k, "total": v, "sort": sort_por_etapa.get(k, 9999)}
             for k, v in active.items()], key=lambda x: x["sort"]),
        "deals_minimal": deals_minimal,
        "losses": sorted([{"motivo": k, "total": v} for k, v in losses.items()],
                         key=lambda x: -x["total"]),
        "losses_daily": losses_daily,
        "by_responsavel": sorted(
            [{"responsavel": k, **{kk: rnd(vv) if kk == "valor" else vv
                                   for kk, vv in v.items()}}
             for k, v in by_resp.items()], key=lambda x: -x["total"]),
        "monthly_won": [{"mes": k, "ganhos": v["ganhos"], "valor": rnd(v["valor"])}
                        for k, v in sorted(monthly_won.items())],
        "ciclo": {
            "n": n,
            "mediana_dias": rnd(ciclos[n // 2], 1) if n else None,
            "min_dias": rnd(ciclos[0], 1) if n else None,
            "max_dias": rnd(ciclos[-1], 1) if n else None,
        },
    }


def aggregate_atendimento(events, talks):
    """Métricas de atendimento a partir dos eventos de chat do Kommo.

    O /talks só devolve conversas abertas; o total real vem dos eventos.
    A 1ª resposta é medida por conversa e as instantâneas (<30s) são
    descartadas do indicador humano — medem o robô, não a equipe.
    """
    msgs = [e for e in events
            if e["type"] in ("incoming_chat_message", "outgoing_chat_message")]
    recebidas = sum(1 for e in msgs if e["type"] == "incoming_chat_message")
    enviadas = len(msgs) - recebidas

    msgs_daily = defaultdict(lambda: {"recebidas": 0, "enviadas": 0})
    msgs_hora = defaultdict(int)
    por_talk = defaultdict(list)
    for e in msgs:
        d = dia(e.get("criado_em"))
        if e["type"] == "incoming_chat_message":
            msgs_daily[d]["recebidas"] += 1
            hora = (e.get("criado_em") or "T00")[11:13]
            msgs_hora[int(hora or 0)] += 1
        else:
            msgs_daily[d]["enviadas"] += 1
        if e.get("talk_id"):
            por_talk[e["talk_id"]].append(e)

    respostas = []       # 1ª resposta por conversa, em minutos (inclui robô)
    for _, conversa in por_talk.items():
        conversa.sort(key=lambda e: e["created_at"] or 0)
        primeira_in = next((e for e in conversa
                            if e["type"] == "incoming_chat_message"), None)
        if not primeira_in:
            continue
        resposta = next((e for e in conversa
                         if e["type"] == "outgoing_chat_message"
                         and e["created_at"] >= primeira_in["created_at"]), None)
        if not resposta:
            continue
        minutos = (resposta["created_at"] - primeira_in["created_at"]) / 60
        respostas.append({"dia": dia(primeira_in.get("criado_em")),
                          "minutos": rnd(minutos, 2)})

    automaticas = sum(1 for r in respostas
                      if r["minutos"] < LIMITE_RESPOSTA_AUTOMATICA_MIN)
    conversas_total = len({e["talk_id"] for e in events
                           if e["type"] == "talk_created"} |
                          set(por_talk.keys()))

    return {
        "conversas_total": conversas_total,
        "em_aberto": len(talks),
        "nao_lidas": sum(1 for t in talks if not t.get("is_read")),
        "recebidas": recebidas,
        "enviadas": enviadas,
        "msgs_daily": [{"dia": k, **v} for k, v in sorted(msgs_daily.items())],
        "msgs_hora": [{"hora": h, "mensagens": msgs_hora.get(h, 0)}
                      for h in range(24)],
        # O front filtra por período e calcula mediana/p90/faixas — por isso a
        # lista vai crua (1 linha por conversa respondida, robô incluído e
        # marcado pelo próprio valor < 0.5 min).
        "respostas": sorted(respostas, key=lambda r: r["dia"]),
        "automaticas_pct": rnd(automaticas / len(respostas) * 100, 1)
        if respostas else 0,
    }


def aggregate_meta_ads(rows, leads_daily_map, campaign_status):
    monthly = defaultdict(lambda: defaultdict(float))
    daily = defaultdict(lambda: defaultdict(float))
    camp_day = defaultdict(lambda: defaultdict(float))     # (campanha, dia)
    adset_day = defaultdict(lambda: defaultdict(float))    # (campanha, conjunto, dia)
    cre_day = defaultdict(lambda: defaultdict(float))      # (anuncio, campanha, dia)
    creatives = {}

    for r in rows:
        d, camp, conj, ad = r["data"], r["campanha"], r["conjunto"], r["anuncio"]
        m = d[:7]
        for bucket, key in ((monthly, m), (daily, d)):
            b = bucket[key]
            b["gasto"] += r["gasto"]
            b["impressoes"] += r["impressoes"]
            b["cliques"] += r["cliques"]
            b["leads_plat"] += r["leads_plat"]
            b["conversas"] += r["conversas"]

        cd = camp_day[(camp, d)]
        cd["gasto"] += r["gasto"]
        cd["impressoes"] += r["impressoes"]
        cd["cliques"] += r["cliques"]
        cd["leads_plat"] += r["leads_plat"]
        cd["conversas"] += r["conversas"]

        ad_ = adset_day[(camp, conj, d)]
        ad_["gasto"] += r["gasto"]
        ad_["cliques"] += r["cliques"]
        ad_["leads_plat"] += r["leads_plat"]
        ad_["conversas"] += r["conversas"]

        crd = cre_day[(ad, camp, d)]
        crd["gasto"] += r["gasto"]
        crd["cliques"] += r["cliques"]
        crd["leads_plat"] += r["leads_plat"]
        crd["conversas"] += r["conversas"]

        cre = creatives.setdefault(ad, {
            "anuncio": ad, "campanha": camp, "conjunto": conj,
            "gasto": 0.0, "impressoes": 0, "cliques": 0, "leads_plat": 0,
            "conversas": 0, "thumbnail": r.get("thumbnail", ""),
            "permalink": r.get("permalink", ""), "primeira_data": d,
            "ultima_data": d,
        })
        cre["gasto"] += r["gasto"]
        cre["impressoes"] += r["impressoes"]
        cre["cliques"] += r["cliques"]
        cre["leads_plat"] += r["leads_plat"]
        cre["conversas"] += r["conversas"]
        cre["campanha"] = camp          # nome mais recente vence
        cre["conjunto"] = conj
        cre["ultima_data"] = max(cre["ultima_data"], d)
        cre["primeira_data"] = min(cre["primeira_data"], d)

    # --- Leads do CRM casados no nível campanha (ver match_leads_meta) ---
    # O lead cai no dia em que foi criado, na campanha que o utm_campaign
    # aponta — mesmo que a campanha não tenha tido entrega naquele dia.
    total_matched = 0
    for campanha, dias in leads_daily_map.items():
        for d, n in dias.items():
            camp_day[(campanha, d)]["leads"] = \
                camp_day[(campanha, d)].get("leads", 0) + n
            total_matched += n

    # --- Montagem das saídas -------------------------------------------
    def fecha(bucket, chave):
        out = []
        for k, v in sorted(bucket.items()):
            item = {chave: k} if isinstance(k, str) else None
            row = {kk: rnd(vv) if kk == "gasto" else
                   (rnd(vv, 1) if kk == "leads" else int(vv))
                   for kk, vv in v.items()}
            if row.get("impressoes"):
                row["ctr"] = rnd(row["cliques"] / row["impressoes"] * 100, 2)
            out.append({**(item or {}), **row})
        return out

    campaigns = defaultdict(lambda: defaultdict(float))
    for (camp, d), v in camp_day.items():
        c = campaigns[camp]
        for kk, vv in v.items():
            c[kk] += vv
    campaigns_out = []
    for camp, v in sorted(campaigns.items(), key=lambda x: -x[1]["gasto"])[:30]:
        row = {"campanha": camp,
               "gasto": rnd(v["gasto"]),
               "impressoes": int(v["impressoes"]),
               "cliques": int(v["cliques"]),
               "ctr": rnd(v["cliques"] / v["impressoes"] * 100, 2)
               if v["impressoes"] else 0,
               "leads_plat": int(v["leads_plat"]),
               "conversas": int(v["conversas"]),
               "leads_crm": rnd(v.get("leads", 0), 1),
               "status": campaign_status.get(camp, "")}
        campaigns_out.append(row)

    total_gasto = sum(r["gasto"] for r in rows)
    total_leads_plat = sum(r["leads_plat"] for r in rows)
    total_conversas = sum(r["conversas"] for r in rows)

    return {
        "total_gasto": rnd(total_gasto),
        "total_leads_plat": total_leads_plat,
        "total_conversas": total_conversas,
        "leads_crm_matched": total_matched,
        "monthly": [{"mes": k, **{kk: rnd(vv) if kk == "gasto" else int(vv)
                                  for kk, vv in v.items()},
                     "ctr": rnd(v["cliques"] / v["impressoes"] * 100, 2)
                     if v["impressoes"] else 0}
                    for k, v in sorted(monthly.items())],
        "daily": [{"dia": k, **{kk: rnd(vv) if kk == "gasto" else int(vv)
                                for kk, vv in v.items()}}
                  for k, v in sorted(daily.items())],
        "campaigns": campaigns_out,
        "campaign_daily": [
            {"dia": d, "campanha": c,
             **{kk: rnd(vv) if kk == "gasto" else
                (rnd(vv, 1) if kk == "leads" else int(vv))
                for kk, vv in v.items()}}
            for (c, d), v in sorted(camp_day.items(), key=lambda x: x[0][1])],
        "adset_daily": [
            {"dia": d, "campanha": c, "conjunto": cj,
             **{kk: rnd(vv) if kk == "gasto" else
                (rnd(vv, 1) if kk == "leads" else int(vv))
                for kk, vv in v.items()}}
            for (c, cj, d), v in sorted(adset_day.items(), key=lambda x: x[0][2])],
        "creatives_daily": [
            {"dia": d, "anuncio": a, "campanha": c,
             **{kk: rnd(vv) if kk == "gasto" else
                (rnd(vv, 1) if kk == "leads" else int(vv))
                for kk, vv in v.items()}}
            for (a, c, d), v in sorted(cre_day.items(), key=lambda x: x[0][2])
            if v["gasto"] or v.get("leads") or v["leads_plat"] or v["conversas"]],
        "creatives": sorted(
            [{**c, "gasto": rnd(c["gasto"]),
              "ctr": rnd(c["cliques"] / c["impressoes"] * 100, 2)
              if c["impressoes"] else 0}
             for c in creatives.values()],
            key=lambda x: -x["gasto"])[:300],
        "campaign_names": sorted(campaigns.keys()),
        "campaign_status": campaign_status,
    }


def aggregate_utm(leads):
    total = len(leads)
    com_utm = sum(1 for lead in leads
                  if lead.get("utm_source") or lead.get("utm_campaign")
                  or lead.get("utm_medium"))
    dims = {}
    for campo, chave in (("utm_source", "sources"), ("utm_medium", "mediums"),
                         ("utm_campaign", "campaigns"), ("utm_content", "contents")):
        cont = defaultdict(int)
        for lead in leads:
            if lead.get(campo):
                cont[lead[campo]] += 1
        dims[chave] = sorted([{"valor": k, "leads": v} for k, v in cont.items()],
                             key=lambda x: -x["leads"])[:30]

    perf = defaultdict(lambda: {"leads": 0, "ganhos": 0, "perdidos": 0})
    for lead in leads:
        camp = lead.get("utm_campaign")
        if not camp:
            continue
        p = perf[camp]
        p["leads"] += 1
        if lead.get("ganho"):
            p["ganhos"] += 1
        elif lead.get("perdido"):
            p["perdidos"] += 1

    return {
        "cobertura": {"total": total, "com_utm": com_utm,
                      "pct": rnd(com_utm / total * 100, 1) if total else 0},
        **dims,
        "campaigns_perf": sorted(
            [{"campanha": k, **v,
              "conversao_pct": rnd(v["ganhos"] / v["leads"] * 100, 1)}
             for k, v in perf.items()], key=lambda x: -x["leads"]),
    }


def build_relatorio(leads_agg, crm, meta, atendimento, utm):
    """Snapshot do mês corrente + saúde do rastreamento + alertas."""
    agora = datetime.now(BRT)
    mes_atual = agora.strftime("%Y-%m")
    mes_ant = (agora.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")

    def do_mes(lista, m):
        return next((x for x in lista if x["mes"] == m), {})

    leads_mes = do_mes(leads_agg["monthly"], mes_atual).get("total", 0)
    leads_ant = do_mes(leads_agg["monthly"], mes_ant).get("total", 0)
    meta_mes = do_mes(meta["monthly"], mes_atual) if meta else {}

    alertas = []
    if utm["cobertura"]["pct"] < 50:
        alertas.append({
            "tipo": "rastreamento",
            "texto": f"Só {utm['cobertura']['pct']:.0f}% dos leads chegam com UTM. "
                     "O CPL por CRM descreve essa fatia, não o total — "
                     "parametrizar todos os links de anúncio e formulários.",
        })
    if crm["total_value_won"] == 0 and crm["total_won"] > 0:
        alertas.append({
            "tipo": "valor",
            "texto": "Nenhum lead tem valor preenchido no Kommo — não existe "
                     "receita nem ticket real. Números de dinheiro são estimativa.",
        })
    # Importação em massa (blueprint §4): leads pagos concentrados em
    # pouquíssimos dias enquanto o gasto roda contínuo = a data de criação é a
    # do import, não da captação. Análises diárias de leads pagos distorcem.
    dias_pagos = [d for d in leads_agg["daily"] if d["pagos"] > 0]
    total_pagos = sum(d["pagos"] for d in dias_pagos)
    if total_pagos >= 30 and len(dias_pagos) <= 5:
        alertas.append({
            "tipo": "importacao",
            "texto": f"Os {total_pagos} leads pagos entraram no CRM em apenas "
                     f"{len(dias_pagos)} dias — assinatura de importação em "
                     "massa. A data de criação é a do import, não da captação: "
                     "gráficos diários e filtros curtos distorcem; o CPL do "
                     "período completo continua válido.",
        })
    if (meta.get("matching") or {}).get("nivel") == "campanha":
        alertas.append({
            "tipo": "rastreamento",
            "texto": "O utm_content dos leads traz o nome padrão do conjunto, "
                     "não o anúncio — o CPL por CRM só existe no nível de "
                     "campanha. Para CPL por criativo, configurar "
                     "utm_content={{ad.name}} nos anúncios.",
        })
    if atendimento["automaticas_pct"] >= 20:
        alertas.append({
            "tipo": "atendimento",
            "texto": f"{atendimento['automaticas_pct']:.0f}% das conversas recebem "
                     "resposta automática em <30s. Os tempos do painel excluem o "
                     "robô — medem a espera por uma pessoa.",
        })

    return {
        "mes": mes_atual,
        "leads_mes": leads_mes,
        "leads_mes_anterior": leads_ant,
        "delta_leads_pct": rnd((leads_mes - leads_ant) / leads_ant * 100, 1)
        if leads_ant else None,
        "gasto_meta_mes": meta_mes.get("gasto", 0),
        "conversas_meta_mes": meta_mes.get("conversas", 0),
        "cpl_plat_mes": rnd(meta_mes["gasto"] / meta_mes["leads_plat"])
        if meta_mes.get("leads_plat") else None,
        "rastreamento_pct": utm["cobertura"]["pct"],
        "alertas": alertas,
    }


def upload_to_supabase(path):
    if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY):
        print("::warning::SUPABASE_URL/SERVICE_KEY ausentes — upload pulado "
              "(ok em dev local; em produção o front não verá dado novo).")
        return
    from supabase import create_client
    sb = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    with open(path, "rb") as f:
        sb.storage.from_("dashboard-data").upload(
            "summary.json", f,
            file_options={"content-type": "application/json", "upsert": "true"})
    print("  Upload pro Supabase concluído.")


def main():
    leads = ler("kommo_leads")
    statuses = ler("kommo_statuses")
    talks = ler("kommo_talks")
    events = ler("kommo_events")
    meta_rows = ler("meta_ads")
    meta_status = ler("meta_status") or {}
    google_rows = ler("google_ads")

    if not leads:
        print("::error::Sem leads do Kommo — abortando ETL.")
        sys.exit(1)

    resolver_fontes(leads, meta_rows)
    leads_daily_map, matching_stats = match_leads_meta(leads, meta_rows)

    leads_agg = aggregate_leads(leads)
    crm = aggregate_crm(leads, statuses)
    atendimento = aggregate_atendimento(events, talks)
    meta = aggregate_meta_ads(meta_rows, leads_daily_map, meta_status) \
        if meta_rows else None
    if meta:
        meta["matching"] = matching_stats
    utm = aggregate_utm(leads)

    google = {"disponivel": bool(google_rows), "motivo": ""
              if google_rows else
              "Aguardando credenciais OAuth do Google Ads (conta 223-460-7566). "
              "A página fica neste estado até a integração ser concluída."}

    summary = {
        "last_update": datetime.now(BRT).strftime("%d/%m/%Y %H:%M"),
        "cliente": "Terrana B2B",
        "totals": {
            "leads": len(leads),
            "meta_rows": len(meta_rows),
            "google_rows": len(google_rows),
            "eventos": len(events),
            "conversas_abertas": len(talks),
        },
        "config": {
            "ticket_medio": config.TICKET_MEDIO,
            "cpl_target_meta": config.CPL_TARGET_META,
            "cpl_target_google": config.CPL_TARGET_GOOGLE,
        },
        "leads": leads_agg,
        "crm": crm,
        "atendimento": atendimento,
        "meta_ads": meta,
        "google_ads": google,
        "utm": utm,
    }
    summary["relatorio"] = build_relatorio(
        leads_agg, crm, meta or {"monthly": []}, atendimento, utm)

    # Sanidade (regra 6): decomposição nunca maior que o KPI.
    if meta:
        soma_camp = sum(c["leads_crm"] for c in meta["campaigns"])
        if soma_camp > matching_stats["leads_pagos_meta"] + 0.01:
            print(f"::error::Rateio duplicando leads: soma por campanha "
                  f"{soma_camp} > leads pagos {matching_stats['leads_pagos_meta']}")
            sys.exit(1)

    os.makedirs(os.path.dirname(config.SUMMARY_PATH), exist_ok=True)
    with open(config.SUMMARY_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, separators=(",", ":"))
    kb = os.path.getsize(config.SUMMARY_PATH) / 1024
    print(f"summary.json gerado ({kb:.0f} KB) em {config.SUMMARY_PATH}")

    # Cópia embutível em <script>: faz o dashboard abrir com DUPLO CLIQUE
    # (file:// bloqueia fetch, mas não bloqueia <script src>). Local apenas —
    # não é commitada nem publicada, igual ao summary.json.
    js_path = config.SUMMARY_PATH[:-len(".json")] + ".js"
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("window.__SUMMARY__=")
        json.dump(summary, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";")
    print(f"summary.js gerado (abre com duplo clique) em {js_path}")

    upload_to_supabase(config.SUMMARY_PATH)


if __name__ == "__main__":
    main()
