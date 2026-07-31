"""Coletor Google Ads — GAQL via REST (v22), acesso pela MCC da agência.

Regras de ouro aplicadas:
- 2: status Ativo/Pausado vem de campaign.status, e a consulta NÃO filtra
  por custo — senão as campanhas pausadas somem da tabela;
- 7: nunca falhar em silêncio (::error:: e lista vazia em falha).

A conta da Terrana (223-460-7566) não é acessível direto pelo usuário
OAuth da agência — o acesso é via login-customer-id da conta gerenciadora
(MCC). Descoberto e validado por chamada de API em 31/07/2026.
"""
import datetime as dt
import json
import time
import urllib.error
import urllib.parse
import urllib.request

import config

API_VERSION = "v22"
_access_token = None


class GoogleAdsError(RuntimeError):
    pass


def credenciais_completas():
    return all([
        config.GOOGLE_ADS_DEVELOPER_TOKEN,
        config.GOOGLE_ADS_CLIENT_ID,
        config.GOOGLE_ADS_CLIENT_SECRET,
        config.GOOGLE_ADS_REFRESH_TOKEN,
        config.GOOGLE_ADS_CUSTOMER_ID,
    ])


def _token():
    global _access_token
    if _access_token:
        return _access_token
    dados = urllib.parse.urlencode({
        "client_id": config.GOOGLE_ADS_CLIENT_ID,
        "client_secret": config.GOOGLE_ADS_CLIENT_SECRET,
        "refresh_token": config.GOOGLE_ADS_REFRESH_TOKEN,
        "grant_type": "refresh_token",
    }).encode()
    with urllib.request.urlopen("https://oauth2.googleapis.com/token",
                                dados, timeout=30) as r:
        _access_token = json.loads(r.read())["access_token"]
    return _access_token


def _search(gaql):
    """Executa GAQL com paginação. Devolve a lista de results."""
    url = (f"https://googleads.googleapis.com/{API_VERSION}/customers/"
           f"{config.GOOGLE_ADS_CUSTOMER_ID}/googleAds:search")
    headers = {
        "Authorization": "Bearer " + _token(),
        "developer-token": config.GOOGLE_ADS_DEVELOPER_TOKEN,
        "Content-Type": "application/json",
    }
    if config.GOOGLE_ADS_LOGIN_CUSTOMER_ID:
        headers["login-customer-id"] = config.GOOGLE_ADS_LOGIN_CUSTOMER_ID

    out, token_pagina = [], None
    for _ in range(50):
        payload = {"query": gaql}
        if token_pagina:
            payload["pageToken"] = token_pagina
        req = urllib.request.Request(url, headers=headers,
                                     data=json.dumps(payload).encode())
        for tentativa in range(4):
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    body = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                corpo = e.read().decode(errors="replace")[:300]
                if e.code in (429, 500, 503) and tentativa < 3:
                    time.sleep(5 * (tentativa + 1))
                    continue
                raise GoogleAdsError(f"HTTP {e.code}: {corpo}") from e
        out.extend(body.get("results", []))
        token_pagina = body.get("nextPageToken")
        if not token_pagina:
            return out
    return out


def get_campaign_daily(since=None):
    """1 linha por campanha×dia — sem filtro de custo (regra 2)."""
    if not credenciais_completas():
        print("::warning::Google Ads sem credenciais OAuth completas — "
              "coleta pulada.")
        return []
    since = since or config.META_SINCE
    hoje = dt.date.today().isoformat()
    try:
        results = _search(
            "SELECT campaign.name, campaign.status, metrics.cost_micros, "
            "metrics.impressions, metrics.clicks, metrics.conversions, "
            "metrics.conversions_value, segments.date "
            f"FROM campaign WHERE segments.date BETWEEN '{since}' AND '{hoje}'")
    except (GoogleAdsError, urllib.error.URLError) as e:
        print(f"::error::Google Ads get_campaign_daily falhou: {e}")
        return []

    rows = []
    for r in results:
        camp = r.get("campaign", {})
        met = r.get("metrics", {})
        rows.append({
            "data": r.get("segments", {}).get("date", ""),
            "campanha": camp.get("name", ""),
            "status": camp.get("status", ""),
            "gasto": round(int(met.get("costMicros", 0)) / 1e6, 2),
            "impressoes": int(met.get("impressions", 0)),
            "cliques": int(met.get("clicks", 0)),
            "conversoes": round(float(met.get("conversions", 0)), 1),
            "valor_conversoes": round(float(met.get("conversionsValue", 0)), 2),
        })
    rows.sort(key=lambda x: x["data"])
    print(f"  Google Ads: {len(rows)} linhas campanha×dia desde {since}")
    if not rows:
        print("::warning::Google Ads sem linhas no período — conta sem "
              "veiculação ou sem histórico no range.")
    return rows


def get_campaign_status():
    """{nome_campanha: status atual}. Erro → {} + ::error:: (front '—')."""
    if not credenciais_completas():
        return {}
    try:
        results = _search(
            "SELECT campaign.name, campaign.status FROM campaign")
        status = {}
        for r in results:
            camp = r.get("campaign", {})
            nome, st = camp.get("name", ""), camp.get("status", "")
            if nome not in status or st == "ENABLED":
                status[nome] = st
        if not status:
            print("::warning::Google Ads sem campanhas na conta.")
        return status
    except (GoogleAdsError, urllib.error.URLError) as e:
        print(f"::error::Google Ads get_campaign_status falhou: {e}")
        return {}
