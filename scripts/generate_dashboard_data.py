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

# Ordem do funil combinada com a gestora (05/08) — o sort do Kommo põe o
# FOLLOW UP depois da negociação e isso confundia a leitura das taxas.
FUNIL_ORDER = ["etapa de leads de entrada", "contato inicial", "em atendimento",
               "follow up", "qualificados", "em negociação",
               "fechado - ganho", "fechado - perdido"]


def ordem_funil(etapa):
    e = (etapa or "").strip().lower()
    return FUNIL_ORDER.index(e) if e in FUNIL_ORDER else 900


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


def _fone_norm(telefone):
    """Só dígitos, sem o 55 do país — compara pelos últimos 8 (miolo do
    número sobrevive a formatos com/sem 9º dígito)."""
    d = re.sub(r"\D", "", telefone or "")
    if d.startswith("55") and len(d) > 10:
        d = d[2:]
    return d[-8:] if len(d) >= 8 else ""


def enriquecer_com_planilha(leads, contatos, planilha):
    """Casa lead do CRM ↔ lead do formulário por e-mail/telefone e grava a
    atribuição REAL (anúncio, conjunto, campanha, plataforma) no lead.

    É o backfill de rastreamento que as UTMs não davam: a planilha recebe
    cada envio do formulário com o criativo exato. Leads antigos (antes da
    integração, 05/08) só casam se estiverem na planilha.
    """
    por_email = {}
    por_fone = {}
    for p in planilha:
        if p.get("email"):
            por_email.setdefault(p["email"], p)
        f = _fone_norm(p.get("telefone"))
        if f:
            por_fone.setdefault(f, p)

    casados = 0
    for lead in leads:
        contato = contatos.get(str(lead.get("contato_id") or "")) \
            or contatos.get(lead.get("contato_id")) or {}
        email = (contato.get("email") or "").lower()
        fone = _fone_norm(contato.get("telefone"))
        p = (email and por_email.get(email)) or (fone and por_fone.get(fone))
        if not p:
            continue
        lead["form"] = {
            "anuncio": p["anuncio"],
            "conjunto": p["conjunto"],
            "campanha": p["campanha"],
            "plataforma": p["plataforma"],
            "organico": p["organico"],
            "tipo_negocio": p["tipo_negocio"],
        }
        casados += 1

    stats = {"planilha_total": len(planilha), "casados_no_crm": casados}
    print(f"  Planilha↔CRM: {casados} leads casados "
          f"({len(planilha)} na planilha)")
    return stats


def origem_efetiva(lead):
    """Origem mais confiável disponível: UTM > formulário > nada."""
    if lead.get("utm_source"):
        return lead["utm_source"]
    form = lead.get("form")
    if form:
        plat = form.get("plataforma") or "meta"
        return f"{plat} (formulário)" if not form.get("organico") \
            else f"{plat} (formulário orgânico)"
    return None


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
        form = lead.get("form")
        if src in config.PAID_SOURCES_META or lead.get("fbclid"):
            fonte = "meta"
        elif src in config.PAID_SOURCES_GOOGLE or lead.get("gclid"):
            fonte = "google"
        elif form and not form.get("organico"):
            fonte = "meta"          # formulário de anúncio = pago Meta
        elif not src and lead.get("utm_campaign") \
                and campanha_meta(lead["utm_campaign"]):
            fonte = "meta"
        elif src or form:
            fonte = "outro"         # form orgânico conta como origem própria
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
        # Só campanhas da frente B2B: lead de CRM não pode cair em campanha
        # de e-commerce por semelhança de nome.
        if nome and nome not in pool and classificar_frente(nome) == "b2b":
            pool[nome] = _tokens(nome)

    daily = defaultdict(lambda: defaultdict(int))
    ad_daily = defaultdict(lambda: defaultdict(int))
    pagos = via_form = via_utm = 0
    for lead in leads:
        if fonte_paga(lead) != "meta":
            continue
        pagos += 1
        d = dia(lead.get("criado_em"))
        form = lead.get("form")

        # 1º) atribuição EXATA da planilha do formulário (campanha e
        #     anúncio reais do lead — não precisa de matching por nome)
        if form and form.get("campanha") \
                and classificar_frente(form["campanha"]) == "b2b":
            daily[form["campanha"]][d] += 1
            if form.get("anuncio"):
                ad_daily[form["anuncio"]][d] += 1
            via_form += 1
            continue

        # 2º) fallback: utm_campaign × nome da campanha (Jaccard)
        campanha = lead.get("utm_campaign")
        if not campanha:
            continue
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
            daily[best][d] += 1
            via_utm += 1

    matched = via_form + via_utm
    stats = {
        "nivel": "campanha + criativo (formulário)",
        "leads_pagos_meta": pagos,
        "via_formulario": via_form,
        "via_utm": via_utm,
        "matched": matched,
        "cobertura_pct": rnd(matched / pagos * 100, 1) if pagos else 0,
    }
    print(f"  Matching Meta: {matched}/{pagos} pagos casados "
          f"({via_form} pelo formulário, {via_utm} por UTM)")
    return daily, ad_daily, stats


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
        origem = origem_efetiva(lead)
        if origem:
            by_source[origem] += 1

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


def aggregate_crm(leads, statuses, events=None, contatos=None,
                  expor_pessoais=False):
    events = events or []
    contatos = contatos or {}
    etapa_por_id = {s["id"]: s["etapa"] for s in statuses}

    # Histórico de etapas (lead_status_changed, janela de 180 dias):
    # - última troca por lead → tempo parado na etapa atual;
    # - troca PARA perdido (143) → etapa em que o lead estava ao ser perdido.
    ultima_troca = {}
    etapa_da_perda = {}
    for ev in events:
        if ev.get("type") != "lead_status_changed" or not ev.get("entity_id"):
            continue
        lid = ev["entity_id"]
        ultima_troca[lid] = max(ultima_troca.get(lid, 0),
                                ev.get("created_at") or 0)
        if ev.get("status_after") == config.KOMMO_STATUS_PERDIDO \
                and ev.get("status_before"):
            etapa_da_perda[lid] = etapa_por_id.get(ev["status_before"])
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
                "etapa": etapa_da_perda.get(lead["id"]),
                "origem": origem_efetiva(lead),
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

    # --- Tempo parado por etapa (leads vivos) + leads parados individuais --
    agora_ts = datetime.now(BRT).timestamp()
    dias_por_etapa = defaultdict(list)
    parados = []
    for lead in leads:
        if lead.get("ganho") or lead.get("perdido") or not lead.get("criado_em"):
            continue
        criado_ts = datetime.fromisoformat(lead["criado_em"]).timestamp()
        ref = ultima_troca.get(lead["id"]) or criado_ts
        dias = (agora_ts - ref) / 86400
        dias_por_etapa[lead.get("etapa", "?")].append(dias)
        contato = contatos.get(str(lead.get("contato_id") or "")) \
            or contatos.get(lead.get("contato_id")) or {}
        parados.append({
            "nome": lead.get("nome") or contato.get("nome") or "(sem nome)",
            "telefone": contato.get("telefone") or "—",
            "etapa": lead.get("etapa", "?"),
            "dias": rnd(dias, 1),
            "responsavel": lead.get("responsavel") or "—",
        })

    def _mediana(vals):
        vals = sorted(vals)
        return rnd(vals[len(vals) // 2], 1) if vals else None

    tempo_etapa = sorted(
        [{"etapa": k, "dias_mediana": _mediana(v), "leads": len(v),
          "sort": ordem_funil(k)}
         for k, v in dias_por_etapa.items()], key=lambda x: x["sort"])

    # Nome e telefone são dados pessoais: só vão para o summary quando a
    # publicação for autenticada (Supabase configurado). Antes disso o site
    # é público e isso seria expor PII na internet.
    if expor_pessoais:
        leads_parados = {"disponivel": True,
                         "itens": sorted(parados, key=lambda x: -x["dias"])[:30]}
    else:
        leads_parados = {
            "disponivel": False,
            "motivo": "Nome e telefone de leads são dados pessoais — esta "
                      "lista só é publicada quando o dashboard estiver com "
                      "login ativo (Supabase). Os tempos por etapa acima já "
                      "estão habilitados.",
        }

    return {
        "tempo_etapa": tempo_etapa,
        "leads_parados": leads_parados,
        "total_deals": total,
        "total_won": won,
        "total_lost": lost,
        "total_open": total - fechados,
        "total_value_won": rnd(value_won),
        "taxa_fechamento": rnd(won / total * 100, 1) if total else 0,
        "taxa_fechamento_decididos": rnd(won / fechados * 100, 1) if fechados else 0,
        "funnel": sorted(
            [{"etapa": k, "total": v, "sort": ordem_funil(k)}
             for k, v in funnel.items()], key=lambda x: x["sort"]),
        "active_funnel": sorted(
            [{"etapa": k, "total": v, "sort": ordem_funil(k)}
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


def aggregate_meta_ads(rows, leads_daily_map, campaign_status,
                       ad_daily_map=None):
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
            b["cliques_link"] += r.get("cliques_link", 0)
            b["leads_plat"] += r["leads_plat"]
            b["conversas"] += r["conversas"]
            b["compras"] += r.get("compras", 0)
            b["valor_compras"] += r.get("valor_compras", 0)

        cd = camp_day[(camp, d)]
        cd["gasto"] += r["gasto"]
        cd["impressoes"] += r["impressoes"]
        cd["cliques"] += r["cliques"]
        cd["cliques_link"] += r.get("cliques_link", 0)
        cd["leads_plat"] += r["leads_plat"]
        cd["conversas"] += r["conversas"]
        cd["compras"] += r.get("compras", 0)
        cd["valor_compras"] += r.get("valor_compras", 0)

        ad_ = adset_day[(camp, conj, d)]
        ad_["gasto"] += r["gasto"]
        ad_["cliques"] += r["cliques"]
        ad_["cliques_link"] += r.get("cliques_link", 0)
        ad_["leads_plat"] += r["leads_plat"]
        ad_["conversas"] += r["conversas"]
        ad_["compras"] += r.get("compras", 0)
        ad_["valor_compras"] += r.get("valor_compras", 0)

        crd = cre_day[(ad, camp, d)]
        crd["gasto"] += r["gasto"]
        crd["cliques"] += r["cliques"]
        crd["cliques_link"] += r.get("cliques_link", 0)
        crd["leads_plat"] += r["leads_plat"]
        crd["conversas"] += r["conversas"]
        crd["compras"] += r.get("compras", 0)
        crd["valor_compras"] += r.get("valor_compras", 0)

        cre = creatives.setdefault(ad, {
            "anuncio": ad, "campanha": camp, "conjunto": conj,
            "gasto": 0.0, "impressoes": 0, "cliques": 0, "cliques_link": 0, "leads_plat": 0,
            "conversas": 0, "compras": 0, "valor_compras": 0.0, "thumbnail": r.get("thumbnail", ""),
            "permalink": r.get("permalink", ""), "primeira_data": d,
            "ultima_data": d,
        })
        cre["gasto"] += r["gasto"]
        cre["impressoes"] += r["impressoes"]
        cre["cliques"] += r["cliques"]
        cre["cliques_link"] += r.get("cliques_link", 0)
        cre["leads_plat"] += r["leads_plat"]
        cre["conversas"] += r["conversas"]
        cre["compras"] += r.get("compras", 0)
        cre["valor_compras"] += r.get("valor_compras", 0)
        cre["campanha"] = camp          # nome mais recente vence
        cre["conjunto"] = conj
        cre["ultima_data"] = max(cre["ultima_data"], d)
        cre["primeira_data"] = min(cre["primeira_data"], d)

    # --- Leads do CRM casados no nível campanha (ver match_leads_meta) ---
    # O lead cai no dia em que foi criado, na campanha que a atribuição
    # aponta — mesmo que a campanha não tenha tido entrega naquele dia.
    total_matched = 0
    for campanha, dias in leads_daily_map.items():
        for d, n in dias.items():
            camp_day[(campanha, d)]["leads"] = \
                camp_day[(campanha, d)].get("leads", 0) + n
            total_matched += n

    # --- Leads por CRIATIVO (atribuição exata da planilha do formulário) --
    for anuncio, dias in (ad_daily_map or {}).items():
        cre = creatives.get(anuncio)
        if cre is None:
            # anúncio ainda sem entrega na série coletada — cria casca
            cre = creatives.setdefault(anuncio, {
                "anuncio": anuncio, "campanha": "", "conjunto": "",
                "gasto": 0.0, "impressoes": 0, "cliques": 0, "cliques_link": 0, "leads_plat": 0,
                "conversas": 0, "compras": 0, "valor_compras": 0.0,
                "thumbnail": "", "permalink": "",
                "primeira_data": "", "ultima_data": "",
            })
        cre["leads_form"] = cre.get("leads_form", 0) + sum(dias.values())

    # --- Montagem das saídas -------------------------------------------
    def fecha(bucket, chave):
        out = []
        for k, v in sorted(bucket.items()):
            item = {chave: k} if isinstance(k, str) else None
            row = {kk: rnd(vv) if kk in ("gasto", "valor_compras") else
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
        "monthly": [{"mes": k, **{kk: rnd(vv) if kk in ("gasto", "valor_compras") else int(vv)
                                  for kk, vv in v.items()},
                     "ctr": rnd(v["cliques"] / v["impressoes"] * 100, 2)
                     if v["impressoes"] else 0}
                    for k, v in sorted(monthly.items())],
        "daily": [{"dia": k, **{kk: rnd(vv) if kk in ("gasto", "valor_compras") else int(vv)
                                for kk, vv in v.items()}}
                  for k, v in sorted(daily.items())],
        "campaigns": campaigns_out,
        "campaign_daily": [
            {"dia": d, "campanha": c,
             **{kk: rnd(vv) if kk in ("gasto", "valor_compras") else
                (rnd(vv, 1) if kk == "leads" else int(vv))
                for kk, vv in v.items()}}
            for (c, d), v in sorted(camp_day.items(), key=lambda x: x[0][1])],
        "adset_daily": [
            {"dia": d, "campanha": c, "conjunto": cj,
             **{kk: rnd(vv) if kk in ("gasto", "valor_compras") else
                (rnd(vv, 1) if kk == "leads" else int(vv))
                for kk, vv in v.items()}}
            for (c, cj, d), v in sorted(adset_day.items(), key=lambda x: x[0][2])],
        "creatives_daily": [
            {"dia": d, "anuncio": a, "campanha": c,
             **{kk: rnd(vv) if kk in ("gasto", "valor_compras") else
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


def classificar_frente(nome):
    """Frente da campanha pelo NOME (convenção combinada com a gestora):
    - b2b: "AD - Formulário Nativo - Leads - B2B" hoje; futuras contendo
      "Geração de leads B2B" (a landing page está a caminho);
    - ecommerce: [ECOMMERCE] [VENDA] [COMPRA];
    - inst: impulsionamento/posts da conta inteira (não é de uma frente).
    O que não casar vira 'outras' com aviso — nunca é descartado em silêncio.
    """
    n = (nome or "").lower()
    if ("formulário nativo" in n or "formulario nativo" in n
            or "geração de leads b2b" in n or "geracao de leads b2b" in n
            or ("leads" in n and "b2b" in n)):
        return "b2b"
    # Meta: [ECOMMERCE]/[VENDA]/[COMPRA] · Google: campanhas de Shopping
    # ("SH"/"[SH]") e de vendas — tudo loja online.
    if ("ecommerce" in n or "[venda]" in n or "[compra]" in n
            or "[vendas]" in n or "[sh]" in n or n.startswith("sh ")
            or n.startswith("sh-") or "shopping" in n):
        return "ecommerce"
    if n.startswith("impulsionamento") or "instagram post" in n:
        return "inst"
    print(f"::warning::Campanha sem frente identificável no nome: '{nome}' — "
          "classificada como 'outras'. Combinar a nomenclatura com o gestor.")
    return "outras"


def aggregate_institucional(meta_rows, campaign_status):
    """Página Institucional & Impulsionamento: só campanhas de boost (inst).

    Alcance fica de fora de propósito: reach não é aditivo — somar
    anúncio×dia inflaria o número (regra 9: não inventar dado).
    """
    monthly = defaultdict(lambda: defaultdict(float))
    campanhas = defaultdict(lambda: defaultdict(float))
    split = defaultdict(float)
    # thumbnail/permalink do anúncio de maior gasto de cada campanha —
    # habilita o preview do criativo com link pro post no Instagram
    midia = {}
    midia_gasto = defaultdict(float)

    for r in meta_rows:
        frente = classificar_frente(r["campanha"])
        split[frente] += r["gasto"]
        if frente != "inst":
            continue
        if r.get("thumbnail") and r["gasto"] >= midia_gasto[r["campanha"]]:
            midia_gasto[r["campanha"]] = r["gasto"]
            midia[r["campanha"]] = {"thumbnail": r.get("thumbnail", ""),
                                    "permalink": r.get("permalink", "")}
        m = r["data"][:7]
        for bucket, key in ((monthly, m), (campanhas, r["campanha"])):
            b = bucket[key]
            b["gasto"] += r["gasto"]
            b["impressoes"] += r["impressoes"]
            b["cliques"] += r["cliques"]
            b["cliques_link"] += r.get("cliques_link", 0)
            b["engajamento"] += r.get("engajamento", 0)
            b["video_views"] += r.get("video_views", 0)
            b["seguidores"] += r.get("seguidores", 0)
            b["conversas"] += r["conversas"]

    def fecha(v):
        return {kk: rnd(vv) if kk in ("gasto", "valor_compras") else int(vv) for kk, vv in v.items()}

    return {
        "split_gasto": {k: rnd(v) for k, v in sorted(split.items())},
        "monthly": [{"mes": k, **fecha(v)} for k, v in sorted(monthly.items())],
        "campaigns": sorted(
            [{"campanha": k, **fecha(v),
              "status": campaign_status.get(k, ""),
              "thumbnail": midia.get(k, {}).get("thumbnail", ""),
              "permalink": midia.get(k, {}).get("permalink", "")}
             for k, v in campanhas.items()],
            key=lambda x: -x["gasto"]),
    }


def aggregate_publico(breakdowns):
    """Página Público — repassa os breakdowns mensais com números fechados."""
    if not breakdowns:
        return {"disponivel": False}

    def fecha(rows):
        return [{**r, "gasto": rnd(r.get("gasto", 0)),
                 "frente": classificar_frente(r.get("campanha"))}
                for r in rows]

    return {
        "disponivel": any(breakdowns.get(k) for k in
                          ("age_gender", "placement", "region")),
        "age_gender": fecha(breakdowns.get("age_gender", [])),
        "placement": fecha(breakdowns.get("placement", [])),
        "region": fecha(breakdowns.get("region", [])),
    }


def qualidade_por_responsavel(leads, statuses, events):
    """Tabela 'Qualidade de atendimento por responsável' (referência Dr. Move).

    - sem_1o_atend: % dos leads do responsável ainda na etapa de entrada;
    - tempo_1o_atend_dias: mediana entre a criação e a 1ª troca de etapa
      (eventos lead_status_changed, janela de 180 dias);
    - parado_dias: mediana, nos leads vivos, do tempo desde a última troca.
    """
    abertas = [s for s in statuses
               if s["id"] not in (config.KOMMO_STATUS_GANHO,
                                  config.KOMMO_STATUS_PERDIDO)]
    entrada_id = min(abertas, key=lambda s: s.get("sort", 0))["id"] \
        if abertas else None

    primeira_troca = {}
    ultima_troca = {}
    for ev in events:
        if ev["type"] != "lead_status_changed" or not ev.get("entity_id"):
            continue
        lid = ev["entity_id"]
        ts = ev.get("created_at") or 0
        if lid not in primeira_troca:
            primeira_troca[lid] = ts
        ultima_troca[lid] = max(ultima_troca.get(lid, 0), ts)

    agora = datetime.now(BRT).timestamp()
    por_resp = defaultdict(lambda: {"leads": 0, "vendas": 0, "perdidos": 0,
                                    "sem_atend": 0, "t1": [], "parado": []})
    for lead in leads:
        r = por_resp[lead.get("responsavel") or "sem responsável"]
        r["leads"] += 1
        if lead.get("ganho"):
            r["vendas"] += 1
        elif lead.get("perdido"):
            r["perdidos"] += 1
        else:
            criado_ts = datetime.fromisoformat(lead["criado_em"]).timestamp() \
                if lead.get("criado_em") else None
            ref = ultima_troca.get(lead["id"]) or criado_ts
            if ref:
                r["parado"].append((agora - ref) / 86400)
        if entrada_id is not None and lead.get("etapa_id") == entrada_id:
            r["sem_atend"] += 1
        t = primeira_troca.get(lead["id"])
        if t and lead.get("criado_em"):
            criado_ts = datetime.fromisoformat(lead["criado_em"]).timestamp()
            if t >= criado_ts:
                r["t1"].append((t - criado_ts) / 86400)

    def mediana(vals):
        if not vals:
            return None
        vals = sorted(vals)
        return rnd(vals[len(vals) // 2], 1)

    return sorted([{
        "responsavel": nome,
        "leads": v["leads"],
        "vendas": v["vendas"],
        "perdidos": v["perdidos"],
        "taxa_conv": rnd(v["vendas"] / v["leads"] * 100, 1) if v["leads"] else 0,
        "sem_1o_atend_pct": rnd(v["sem_atend"] / v["leads"] * 100, 1)
        if v["leads"] else 0,
        "tempo_1o_atend_dias": mediana(v["t1"]),
        "parado_dias": mediana(v["parado"]),
    } for nome, v in por_resp.items()], key=lambda x: -x["leads"])


def aggregate_google(rows, campaign_status):
    """Google Ads nível campanha×dia (uma frente por chamada).

    'conversoes'/'valor_conversoes' são da plataforma (rotular como
    referência no front — regra 1); nas campanhas de Shopping equivalem a
    compras e receita atribuídas pelo Google.
    """
    monthly = defaultdict(lambda: defaultdict(float))
    daily = defaultdict(lambda: defaultdict(float))
    camp_day = defaultdict(lambda: defaultdict(float))
    campanhas = defaultdict(lambda: defaultdict(float))

    for r in rows:
        d, m, camp = r["data"], r["data"][:7], r["campanha"]
        for bucket, key in ((monthly, m), (daily, d),
                            (camp_day, (camp, d)), (campanhas, camp)):
            b = bucket[key]
            b["gasto"] += r["gasto"]
            b["impressoes"] += r["impressoes"]
            b["cliques"] += r["cliques"]
            b["conversoes"] += r["conversoes"]
            b["valor_conversoes"] += r["valor_conversoes"]

    def fecha(v):
        out = {}
        for kk, vv in v.items():
            if kk in ("gasto", "valor_conversoes"):
                out[kk] = rnd(vv)
            elif kk == "conversoes":
                out[kk] = rnd(vv, 1)
            else:
                out[kk] = int(vv)
        if out.get("impressoes"):
            out["ctr"] = rnd(out["cliques"] / out["impressoes"] * 100, 2)
        return out

    total_gasto = sum(r["gasto"] for r in rows)
    total_conv = sum(r["conversoes"] for r in rows)
    total_valor = sum(r["valor_conversoes"] for r in rows)
    return {
        "disponivel": True,
        "total_gasto": rnd(total_gasto),
        "total_conversoes": rnd(total_conv, 1),
        "total_valor_conversoes": rnd(total_valor),
        "monthly": [{"mes": k, **fecha(v)} for k, v in sorted(monthly.items())],
        "daily": [{"dia": k, **fecha(v)} for k, v in sorted(daily.items())],
        "campaign_daily": [{"dia": d, "campanha": c, **fecha(v)}
                           for (c, d), v in sorted(camp_day.items(),
                                                   key=lambda x: x[0][1])],
        "campaigns": sorted(
            [{"campanha": k, **fecha(v),
              "status": campaign_status.get(k, "")}
             for k, v in campanhas.items()], key=lambda x: -x["gasto"]),
        "campaign_names": sorted(campanhas.keys()),
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

    com_atrib = sum(1 for lead in leads if origem_efetiva(lead))
    return {
        "cobertura": {"total": total, "com_utm": com_utm,
                      "pct": rnd(com_utm / total * 100, 1) if total else 0},
        "cobertura_efetiva": {
            "total": total, "com_atribuicao": com_atrib,
            "pct": rnd(com_atrib / total * 100, 1) if total else 0,
            "nota": "UTM ou casamento com a planilha do formulário",
        },
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
    meta_breakdowns = ler("meta_breakdowns") or {}
    google_rows = ler("google_ads")

    if not leads:
        print("::error::Sem leads do Kommo — abortando ETL.")
        sys.exit(1)

    contatos = ler("kommo_contacts") or {}
    planilha = ler("form_sheet") or []
    form_stats = enriquecer_com_planilha(leads, contatos, planilha)
    resolver_fontes(leads, meta_rows)
    leads_daily_map, ad_daily_map, matching_stats = \
        match_leads_meta(leads, meta_rows)
    matching_stats.update(form_stats)

    # PII (nome/telefone dos leads parados) só sai com publicação autenticada
    expor_pessoais = bool(config.SUPABASE_SERVICE_KEY)

    leads_agg = aggregate_leads(leads)
    crm = aggregate_crm(leads, statuses, events, contatos, expor_pessoais)
    atendimento = aggregate_atendimento(events, talks)

    # Duas frentes: B2B Atacado (leads via CRM) e E-commerce (venda direta).
    # Impulsionamento (inst) é da conta inteira e tem seção própria.
    rows_b2b = [r for r in meta_rows
                if classificar_frente(r["campanha"]) == "b2b"]
    rows_ecom = [r for r in meta_rows
                 if classificar_frente(r["campanha"]) == "ecommerce"]
    meta_b2b = aggregate_meta_ads(rows_b2b, leads_daily_map, meta_status,
                                  ad_daily_map) if rows_b2b else None
    if meta_b2b:
        meta_b2b["matching"] = matching_stats
    meta_ecom = aggregate_meta_ads(rows_ecom, {}, meta_status) \
        if rows_ecom else None
    utm = aggregate_utm(leads)

    google_status = ler("google_status") or {}
    g_b2b = [r for r in google_rows
             if classificar_frente(r["campanha"]) == "b2b"]
    g_ecom = [r for r in google_rows
              if classificar_frente(r["campanha"]) == "ecommerce"]
    google_b2b = aggregate_google(g_b2b, google_status) if g_b2b else {
        "disponivel": False,
        "motivo": "A conta Google Ads da Terrana ainda não tem campanhas da "
                  "frente B2B — as futuras campanhas com \"Geração de leads "
                  "B2B\" no nome entram aqui sozinhas."}
    google_ecom = aggregate_google(g_ecom, google_status) if g_ecom else {
        "disponivel": False,
        "motivo": "Sem campanhas de Shopping/vendas no período."}

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
        "meta_b2b": meta_b2b,
        "meta_ecom": meta_ecom,
        "google_b2b": google_b2b,
        "google_ecom": google_ecom,
        "utm": utm,
        "institucional": aggregate_institucional(meta_rows, meta_status)
        if meta_rows else None,
        "publico": aggregate_publico(meta_breakdowns),
        "qualidade_responsavel": qualidade_por_responsavel(
            leads, statuses, events),
    }
    summary["relatorio"] = build_relatorio(
        leads_agg, crm, meta_b2b or {"monthly": []}, atendimento, utm)

    # Sanidade (regra 6): decomposição nunca maior que o KPI.
    if meta_b2b:
        soma_camp = sum(c["leads_crm"] for c in meta_b2b["campaigns"])
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
