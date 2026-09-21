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

# Grade da Meta (ver README): o app é da agência inteira e este dashboard só
# chama a API das 03:10 às 03:59 em Brasília. A chamada só acontece com
# META_COLETA=sim — o workflow liga isso na execução agendada; localmente e
# em pushes fica desligado e o dado vem do cache. META_JANELA_COMERCIAL=sim
# libera 09:10–18:59, só com combinado prévio com a agência.
META_COLETA = os.getenv("META_COLETA", "nao").strip().lower()
META_JANELA_COMERCIAL = os.getenv("META_JANELA_COMERCIAL", "nao").strip().lower()

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

# Estados atendidos no atacado (a Terrana entrega só em SP, MG, PR e RJ).
# Separa, na origem geográfica dos leads, quem está fora da área.
AREA_ATENDIDA_UFS = [uf.strip().upper() for uf in
                     (os.getenv("AREA_ATENDIDA_UFS") or "SP,MG,PR,RJ").split(",")
                     if uf.strip()]

# Atendimento dos leads — o Kommo grava toda mensagem do WhatsApp sem autor
# (created_by=0), então robô × pessoa sai do tempo. Nas janelas em que um
# agente de IA respondeu sozinho, respostas rápidas dele não contam como da
# equipe. Formato: "AAAA-MM-DDTHH:MM/AAAA-MM-DDTHH:MM" (Brasília), separadas
# por vírgula; fim vazio = agente ligado até hoje. 14/09 = teste do agente.
AGENTE_IA_JANELAS = (os.getenv("AGENTE_IA_JANELAS")
                     or "2026-09-14T09:30/2026-09-14T11:20")
# Horário em que a equipe atende em dias úteis (observado nas mensagens de
# set/2026: 6h–18h). Só separa "chegou no horário × fora dele" no painel.
HORARIO_ATENDIMENTO = os.getenv("HORARIO_ATENDIMENTO") or "06-18"

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
