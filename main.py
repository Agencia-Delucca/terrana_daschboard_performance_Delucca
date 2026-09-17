"""Orquestrador da coleta — grava dados brutos em data_raw/*.json.

Ordem: Meta Ads → Kommo (CRM, fonte de verdade) → planilha do formulário →
Google Ads. A Meta vem primeiro porque é a única fonte com hora marcada: o
app é da agência inteira e este dashboard só chama a API das 03:10 às 03:59
(Brasília). Fora disso, ou sem META_COLETA=sim, o coletor não chama a Meta e
usa o último dado em cache. Depois rodar scripts/generate_dashboard_data.py.

Falha de fonte essencial = exit 1 com ::error:: (regra de ouro 7):
workflow verde precisa significar dado íntegro.

Uso:
  python main.py             tudo (a Meta respeita a grade)
  python main.py --sem-meta  pula a Meta; o workflow a roda num passo próprio antes
"""
import json
import os
import sys

import config
from collectors import form_sheet, google_ads, kommo, meta_ads_api


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

    if "--sem-meta" not in sys.argv:
        print("Meta Ads...")
        meta_ads_api.coletar()

    print("Kommo (CRM)...")
    client = kommo.KommoClient()
    statuses, users = kommo.get_structure(client)
    leads = kommo.get_leads(client, statuses, users)
    if not leads:
        sys.exit(1)
    salvar("kommo_statuses", statuses)
    salvar("kommo_leads", leads)
    salvar("kommo_contacts", kommo.get_contacts(client))
    salvar("kommo_talks", kommo.get_talks(client))
    salvar("kommo_events", kommo.get_events(client))

    print("Planilha do formulário...")
    salvar("form_sheet", form_sheet.get_leads_formulario())

    print("Google Ads...")
    salvar("google_ads", google_ads.get_campaign_daily())
    salvar("google_status", google_ads.get_campaign_status())

    if not meta_ads_api.carregar_cache()["linhas"]:
        print("::error::Sem dados da Meta — nem coletados agora nem em cache.")
        sys.exit(1)

    print(f"Coleta concluída — brutos em {config.RAW_DIR}/")


if __name__ == "__main__":
    main()
