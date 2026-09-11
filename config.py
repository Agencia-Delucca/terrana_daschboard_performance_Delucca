"""Configuração central — tudo sensível vem de env var (regra de ouro 9).

Local: python-dotenv lê o .env (não versionado). CI: GitHub Secrets.
"""
import os

from dotenv import load_dotenv

load_dotenv()

# --- CRM Kommo (fonte de verdade dos leads — regra de ouro 1) -----------
KOMMO_SUBDOMAIN = os.getenv("KOMMO_SUBDOMAIN", "")
KOMMO_TOKEN = os.getenv("KOMMO_TOKEN", "")

# IDs de sistema do Kommo — iguais em qualquer conta.
KOMMO_STATUS_GANHO = 142
KOMMO_STATUS_PERDIDO = 143

# --- Meta Ads -----------------------------------------------------------
META_ACCESS_TOKEN = os.getenv("META_ACCESS_TOKEN", "")
META_AD_ACCOUNT_ID = os.getenv("META_AD_ACCOUNT_ID", "")
META_API_VERSION = os.getenv("META_API_VERSION", "v21.0")

# Desde quando coletar insights (a conta começou a rodar mídia em 2026).
META_SINCE = os.getenv("META_SINCE", "2026-01-01")

# --- Google Ads (aguardando credenciais OAuth da agência) ---------------
GOOGLE_ADS_DEVELOPER_TOKEN = os.getenv("GOOGLE_ADS_DEVELOPER_TOKEN", "")
GOOGLE_ADS_CLIENT_ID = os.getenv("GOOGLE_ADS_CLIENT_ID", "")
GOOGLE_ADS_CLIENT_SECRET = os.getenv("GOOGLE_ADS_CLIENT_SECRET", "")
GOOGLE_ADS_REFRESH_TOKEN = os.getenv("GOOGLE_ADS_REFRESH_TOKEN", "")
GOOGLE_ADS_CUSTOMER_ID = os.getenv("GOOGLE_ADS_CUSTOMER_ID", "")  # 223-460-7566 sem hífens
GOOGLE_ADS_LOGIN_CUSTOMER_ID = os.getenv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "")

# --- Supabase (bucket privado do summary.json) --------------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# --- Negócio ------------------------------------------------------------
# O CRM da Terrana não preenche o valor dos leads (todos com price=0).
# Enquanto isso, projeções de receita usam este ticket — e o front rotula
# como estimativa. 0 = esconder indicadores de receita.
TICKET_MEDIO = float(os.getenv("TICKET_MEDIO", "0") or 0)

# Metas de custo (R$). 0 = régua desligada até a meta ser definida com o
# cliente — o front mostra "meta não definida", nunca chuta.
CPL_TARGET_META = float(os.getenv("CPL_TARGET_META", "0") or 0)
CPL_TARGET_GOOGLE = float(os.getenv("CPL_TARGET_GOOGLE", "0") or 0)
CPA_TARGET_ECOM = float(os.getenv("CPA_TARGET_ECOM", "0") or 0)
ROAS_TARGET_ECOM = float(os.getenv("ROAS_TARGET_ECOM", "0") or 0)

# Orçamentos mensais por frente/plataforma (R$/mês). 0 = sem orçamento
# definido — o card de saldo/projeção mostra estado honesto até definirem.
ORCAMENTO_META_B2B = float(os.getenv("ORCAMENTO_META_B2B", "0") or 0)
ORCAMENTO_META_ECOM = float(os.getenv("ORCAMENTO_META_ECOM", "0") or 0)
ORCAMENTO_GOOGLE_ECOM = float(os.getenv("ORCAMENTO_GOOGLE_ECOM", "0") or 0)
ORCAMENTO_GOOGLE_B2B = float(os.getenv("ORCAMENTO_GOOGLE_B2B", "0") or 0)
ORCAMENTO_META_INST = float(os.getenv("ORCAMENTO_META_INST", "0") or 0)

# --- Classificação de origem paga (editar conforme as UTMs reais) -------
# utm_source que conta como tráfego pago de cada plataforma, minúsculo.
PAID_SOURCES_META = {"metaads", "meta", "facebook", "fb", "instagram", "ig", "fbclid"}
PAID_SOURCES_GOOGLE = {"googlecpc", "google", "adwords", "gads", "google-ads"}

# --- Caminhos -----------------------------------------------------------
RAW_DIR = os.getenv("RAW_DIR", "data_raw")
SUMMARY_PATH = os.getenv("SUMMARY_PATH", os.path.join("dashboard", "data", "summary.json"))

# Quantos dias de histórico de eventos de chat puxar do Kommo.
KOMMO_EVENT_DAYS = int(os.getenv("KOMMO_EVENT_DAYS", "180"))
