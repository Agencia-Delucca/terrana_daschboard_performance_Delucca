"""Coletor Google Ads (GAQL) — aguardando credenciais OAuth.

A conta é Terrana (223-460-7566) e o developer token já existe, mas a API
do Google Ads exige também OAuth client + refresh token (+ login_customer_id
se o acesso for via MCC da agência). Sem isso, este coletor devolve vazio
com aviso visível — nunca falha em silêncio (regra de ouro 7) e o front
mostra a página Google Ads com estado honesto de "aguardando credenciais".

Quando as credenciais chegarem, implementar como no projeto-base:
- campanha×dia: SELECT campaign.name, campaign.status, metrics.cost_micros,
  metrics.clicks, metrics.impressions, metrics.conversions, segments.date
  FROM campaign (SEM filtro de custo — senão as pausadas somem; regra 2)
- anúncio×dia: FROM ad_group_ad com cost_micros > 0 (não cobre PMax — o
  total da conta vem do nível campanha, que inclui PMax)
"""
import config


def credenciais_completas():
    return all([
        config.GOOGLE_ADS_DEVELOPER_TOKEN,
        config.GOOGLE_ADS_CLIENT_ID,
        config.GOOGLE_ADS_CLIENT_SECRET,
        config.GOOGLE_ADS_REFRESH_TOKEN,
        config.GOOGLE_ADS_CUSTOMER_ID,
    ])


def get_campaign_daily():
    if not credenciais_completas():
        print("::warning::Google Ads sem credenciais OAuth completas — "
              "coleta pulada, página fica em estado 'aguardando credenciais'.")
        return []
    raise NotImplementedError(
        "Credenciais presentes mas o coletor GAQL ainda não foi implementado — "
        "seguir o esqueleto no docstring deste módulo."
    )


def get_campaign_status():
    if not credenciais_completas():
        return {}
    raise NotImplementedError
