"""Coletor da planilha do formulário de leads (Meta → Google Sheets).

A planilha "Banco de dados Formulário CRM" recebe cada lead do formulário
nativo com a atribuição REAL (anúncio, conjunto, campanha, plataforma
fb/ig) + telefone/e-mail — o elo que as UTMs da Terrana não davam.

Produção (CI): Google Sheets API v4 com service account (a planilha deve
estar compartilhada como Leitor com o e-mail do SA). Sem SA configurado,
mantém o último snapshot em data_raw/form_sheet.json com aviso — nunca
apaga dado bom por falta de credencial (regra 7).
"""
import base64
import json
import os

import config

SHEET_ID = os.getenv("FORM_SHEET_ID",
                     "1HobjO8Fun5dX69WXqSX0bdYOFUx6UADoJ3gvMAUqbFI")
RANGE = "A:S"


def _credenciais():
    """Service account do arquivo (dev) ou de env base64 (CI)."""
    b64 = os.getenv("GOOGLE_SA_JSON_B64", "")
    caminho = os.getenv("GOOGLE_SA_JSON", "")
    if b64:
        return json.loads(base64.b64decode(b64))
    if caminho and os.path.exists(caminho):
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    return None


def get_leads_formulario():
    info = _credenciais()
    if not info:
        print("::warning::Planilha do formulário sem service account "
              "(GOOGLE_SA_JSON/_B64) — usando o último snapshot local.")
        snap = os.path.join(config.RAW_DIR, "form_sheet.json")
        if os.path.exists(snap):
            with open(snap, encoding="utf-8") as f:
                return json.load(f)
        return []

    try:
        from google.auth.transport.requests import AuthorizedSession
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
        sessao = AuthorizedSession(creds)
        r = sessao.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}"
            f"/values/{RANGE}", timeout=60)
        r.raise_for_status()
        valores = r.json().get("values", [])
    except Exception as e:
        print(f"::error::Planilha do formulário falhou: {e} — "
              "verificar se está compartilhada com o service account.")
        snap = os.path.join(config.RAW_DIR, "form_sheet.json")
        if os.path.exists(snap):
            print("::warning::Usando o último snapshot local.")
            with open(snap, encoding="utf-8") as f:
                return json.load(f)
        return []

    if not valores:
        return []
    headers = [h.strip() for h in valores[0]]

    def campo(row, nome):
        try:
            return (row[headers.index(nome)] or "").strip()
        except (ValueError, IndexError):
            return ""

    rows = []
    for v in valores[1:]:
        if not campo(v, "id").startswith("l:"):
            continue
        rows.append({
            "lead_form_id": campo(v, "id"),
            "criado_em": campo(v, "created_time"),
            "anuncio": campo(v, "ad_name"),
            "conjunto": campo(v, "adset_name"),
            "campanha": campo(v, "campaign_name"),
            "formulario": campo(v, "form_name"),
            "organico": campo(v, "is_organic").lower() == "true",
            "plataforma": campo(v, "platform"),
            "tipo_negocio": campo(v, "qual_o_seu_tipo_de_negócio?"),
            "nome": campo(v, "full_name"),
            "telefone": campo(v, "número_do_whatsapp"),
            "email": campo(v, "email").lower(),
        })
    print(f"  Planilha do formulário: {len(rows)} leads")
    return rows
