"""Orquestrador da coleta — grava dados brutos em data_raw/*.json.

Ordem: Kommo (CRM, fonte de verdade) → Meta Ads → Google Ads.
Depois rodar scripts/generate_dashboard_data.py (ETL → summary.json).

Falha de fonte essencial = exit 1 com ::error:: (regra de ouro 7):
workflow verde precisa significar dado íntegro.
"""
import json
import os
import sys

import config
from collectors import google_ads, kommo, meta_ads_api


def salvar(nome, payload):
    os.makedirs(config.RAW_DIR, exist_ok=True)
    path = os.path.join(config.RAW_DIR, f"{nome}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    return path


def main():
    faltando = [nome for nome, valor in [
        ("KOMMO_SUBDOMAIN", config.KOMMO_SUBDOMAIN),
        ("KOMMO_TOKEN", config.KOMMO_TOKEN),
        ("META_ACCESS_TOKEN", config.META_ACCESS_TOKEN),
        ("META_AD_ACCOUNT_ID", config.META_AD_ACCOUNT_ID),
    ] if not valor]
    if faltando:
        print(f"::error::Secrets essenciais ausentes: {', '.join(faltando)}")
        sys.exit(1)

    print("Kommo (CRM)...")
    client = kommo.KommoClient()
    statuses, users = kommo.get_structure(client)
    leads = kommo.get_leads(client, statuses, users)
    if not leads:
        sys.exit(1)
    salvar("kommo_statuses", statuses)
    salvar("kommo_leads", leads)
    salvar("kommo_talks", kommo.get_talks(client))
    salvar("kommo_events", kommo.get_events(client))

    print("Meta Ads...")
    meta_rows = meta_ads_api.get_ad_insights_daily()
    if not meta_rows:
        sys.exit(1)
    salvar("meta_ads", meta_rows)
    salvar("meta_status", meta_ads_api.get_campaign_status())
    salvar("meta_breakdowns", meta_ads_api.get_insights_breakdowns())

    print("Google Ads...")
    salvar("google_ads", google_ads.get_campaign_daily())
    salvar("google_status", google_ads.get_campaign_status())

    print(f"Coleta concluída — brutos em {config.RAW_DIR}/")


if __name__ == "__main__":
    main()
