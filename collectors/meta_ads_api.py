"""Coletor Meta Graph API — insights diários level=ad, status real, criativos.

Regras de ouro aplicadas:
- 2: status Ativo/Pausado vem de effective_status da API, nunca de heurística;
- 11: insights diários level=ad dão erro 500 em ranges longos → coleta mês a
  mês em paralelo (máx. 4 workers).

A Terrana tem uma frente só (B2B) — não há dimensão de frente aqui.
"""
import calendar
import datetime as dt
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

import config


def _graph():
    return f"https://graph.facebook.com/{config.META_API_VERSION}"


def _acct():
    return f"act_{config.META_AD_ACCOUNT_ID}"


def _paginated(url, params):
    """Segue paging.next (a URL do next já vem completa com os params)."""
    out = []
    while url:
        r = requests.get(url, params=params, timeout=90)
        r.raise_for_status()
        data = r.json()
        out.extend(data.get("data", []))
        url = (data.get("paging") or {}).get("next")
        params = None
    return out


def get_campaign_status():
    """{nome_campanha: effective_status}. Erro → {} + ::error:: (front mostra '—')."""
    try:
        rows = _paginated(f"{_graph()}/{_acct()}/campaigns", {
            "fields": "name,effective_status",
            "limit": 200,
            "access_token": config.META_ACCESS_TOKEN,
        })
        status = {}
        for c in rows:
            nome, st = c.get("name", ""), c.get("effective_status", "")
            # nomes repetidos: ACTIVE vence (o dashboard agrupa por nome)
            if nome not in status or st == "ACTIVE":
                status[nome] = st
        if not status:
            print("::error::Meta campaign_status vazio — token inválido ou sem ads_read?")
        return status
    except Exception as e:
        print(f"::error::Meta get_campaign_status falhou: {e}")
        return {}


def _month_ranges(since_str, until=None):
    since = dt.date.fromisoformat(since_str)
    until = until or dt.date.today()
    ranges, cur = [], since
    while cur <= until:
        last = dt.date(cur.year, cur.month, calendar.monthrange(cur.year, cur.month)[1])
        ranges.append((cur.isoformat(), min(last, until).isoformat()))
        cur = last + dt.timedelta(days=1)
    return ranges


def _actions_value(actions, action_type):
    for a in actions or []:
        if a.get("action_type") == action_type:
            try:
                return int(float(a.get("value", 0)))
            except (TypeError, ValueError):
                return 0
    return 0


def _fetch_month(since, until):
    params = {
        "level": "ad",
        "time_increment": 1,
        "fields": "campaign_name,adset_name,ad_name,ad_id,spend,impressions,"
                  "clicks,inline_link_clicks,reach,actions",
        "time_range": f'{{"since":"{since}","until":"{until}"}}',
        "limit": 500,
        "access_token": config.META_ACCESS_TOKEN,
    }
    for attempt in range(4):
        try:
            return _paginated(f"{_graph()}/{_acct()}/insights", params)
        except Exception as e:
            if attempt == 3:
                raise
            wait = 5 * (attempt + 1)
            print(f"  Meta insights {since} erro: {e} — retry em {wait}s")
            time.sleep(wait)


def get_ads_creatives():
    """{ad_id: {thumbnail, permalink}} para as tabelas de criativos."""
    try:
        rows = _paginated(f"{_graph()}/{_acct()}/ads", {
            "fields": "id,creative{thumbnail_url,effective_object_story_id}",
            "limit": 200,
            "access_token": config.META_ACCESS_TOKEN,
        })
        out = {}
        for ad in rows:
            cre = ad.get("creative") or {}
            story = cre.get("effective_object_story_id", "")
            out[ad.get("id")] = {
                "thumbnail": cre.get("thumbnail_url", ""),
                "permalink": f"https://www.facebook.com/{story}" if story else "",
            }
        return out
    except Exception as e:
        print(f"::warning::Meta creatives indisponíveis (tabelas sem thumbnail): {e}")
        return {}


def get_ad_insights_daily(since=None):
    """1 linha por anúncio×dia — cada linha traz SUA campanha e SEU conjunto
    (regra de ouro 4: atribuição por dimensão real, nunca por nome).

    'leads_plat' = action 'lead'; 'conversas' = conversas de WhatsApp/Direct
    iniciadas. Ambos são REFERÊNCIA de plataforma; o lead de verdade é o do
    CRM (regra 1).
    """
    since = since or config.META_SINCE
    creatives = get_ads_creatives()
    rows = []
    ranges = _month_ranges(since)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(_fetch_month, s, u): (s, u) for s, u in ranges}
        for fut in as_completed(futs):
            for r in fut.result():
                ad_id = r.get("ad_id", "")
                cre = creatives.get(ad_id, {})
                rows.append({
                    "data": r.get("date_start", ""),
                    "campanha": r.get("campaign_name", ""),
                    "conjunto": r.get("adset_name", ""),
                    "anuncio": r.get("ad_name", ""),
                    "ad_id": ad_id,
                    "gasto": float(r.get("spend", 0) or 0),
                    "impressoes": int(r.get("impressions", 0) or 0),
                    "cliques": int(r.get("clicks", 0) or 0),
                    "cliques_link": int(r.get("inline_link_clicks", 0) or 0),
                    "alcance": int(r.get("reach", 0) or 0),
                    "leads_plat": _actions_value(r.get("actions"), "lead"),
                    "conversas": _actions_value(
                        r.get("actions"),
                        "onsite_conversion.messaging_conversation_started_7d"),
                    "thumbnail": cre.get("thumbnail", ""),
                    "permalink": cre.get("permalink", ""),
                })
    rows.sort(key=lambda x: x["data"])
    print(f"  Meta: {len(rows)} linhas anúncio×dia desde {since}")
    if not rows:
        print("::error::Meta insights vazio — verificar token/conta")
    return rows
