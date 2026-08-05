"""Coletor do CRM Kommo (API v4) — entrega o Contrato de dados 1.1.

No Kommo lead e negócio são o mesmo objeto e as UTMs vêm em custom fields
do próprio lead — não há join por e-mail. Perdido/ganho é etapa terminal:
status_id 142 (ganho) e 143 (perdido), iguais em qualquer conta.

Regras operacionais (regra de ouro 11): a API corta acima de 7 req/s e
devolve 403 com bloqueio de IP se insistir — o cliente segura em 5 req/s e
pagina de 50 em 50 (acima disso a API devolve 504).
"""
import time
from collections import deque
from datetime import datetime, timedelta, timezone

import requests

import config

MAX_REQUESTS_PER_SECOND = 5
PAGE_SIZE = 50

BRT = timezone(timedelta(hours=-3))

# Campos de rastreamento que viram coluna no registro do lead.
TRACKING_FIELDS = {
    "utm_source": "utm_source",
    "utm_medium": "utm_medium",
    "utm_campaign": "utm_campaign",
    "utm_content": "utm_content",
    "utm_term": "utm_term",
    "referrer": "referrer",
    "gclid": "gclid",
    "fbclid": "fbclid",
}

CHAT_EVENTS = ["incoming_chat_message", "outgoing_chat_message"]
TALK_EVENTS = ["talk_created", "talk_closed", "talk_missed_event"]
FUNNEL_EVENTS = ["lead_added", "lead_status_changed"]


class KommoError(RuntimeError):
    pass


class KommoClient:
    """Acesso somente-leitura à API v4, com vazão controlada e retry."""

    def __init__(self, subdomain=None, token=None, timeout=30, max_retries=4):
        subdomain = subdomain or config.KOMMO_SUBDOMAIN
        token = token or config.KOMMO_TOKEN
        if not subdomain or not token:
            raise KommoError("KOMMO_SUBDOMAIN e KOMMO_TOKEN são obrigatórios.")

        self.base_url = f"https://{subdomain}.kommo.com/api/v4"
        self.timeout = timeout
        self.max_retries = max_retries
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "terrana-performance/1.0",
        })
        self._recent = deque()

    def _throttle(self):
        now = time.monotonic()
        while self._recent and now - self._recent[0] >= 1.0:
            self._recent.popleft()
        if len(self._recent) >= MAX_REQUESTS_PER_SECOND:
            time.sleep(1.0 - (now - self._recent[0]))
            return self._throttle()
        self._recent.append(now)

    def get(self, path, params=None):
        url = path if path.startswith("http") else f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(self.max_retries + 1):
            self._throttle()
            try:
                resp = self._session.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as exc:
                if attempt == self.max_retries:
                    raise KommoError(f"Falha de rede em {url}: {exc}") from exc
                time.sleep(2 ** attempt)
                continue

            if resp.status_code == 204:
                return None
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 401:
                raise KommoError(
                    "Token do Kommo recusado (401) — expirou ou foi revogado. "
                    "Gerar outro em Configurações > Integrações > Chaves e escopos."
                )
            if resp.status_code == 403:
                raise KommoError(f"Acesso negado (403) em {url} — escopo ou IP bloqueado.")
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == self.max_retries:
                    raise KommoError(f"{resp.status_code} persistente em {url}.")
                retry_after = resp.headers.get("Retry-After", "")
                delay = max(2 ** attempt, int(retry_after) if retry_after.isdigit() else 0)
                time.sleep(delay)
                continue
            raise KommoError(f"HTTP {resp.status_code} em {url}: {resp.text[:300]}")
        raise KommoError(f"Requisição a {url} esgotou as tentativas.")

    def paginate(self, path, params=None, collection=None):
        key = collection or path.strip("/").split("/")[-1].split("?")[0]
        query = dict(params or {})
        query["limit"] = PAGE_SIZE
        page = 1
        while True:
            query["page"] = page
            payload = self.get(path, query)
            if not payload:
                return
            items = payload.get("_embedded", {}).get(key, [])
            if not items:
                return
            yield from items
            if not payload.get("_links", {}).get("next"):
                return
            page += 1


# ----------------------------------------------------------------------
# Extração para o contrato de dados
# ----------------------------------------------------------------------


def _iso(ts):
    """Unix UTC → ISO no fuso do negócio (BRT). None se vazio."""
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=BRT).isoformat()


def _tracking(lead):
    found = {col: None for col in TRACKING_FIELDS.values()}
    for field in lead.get("custom_fields_values") or []:
        col = TRACKING_FIELDS.get(field.get("field_name", ""))
        if not col:
            continue
        values = field.get("values") or []
        if values and values[0].get("value") is not None:
            found[col] = str(values[0]["value"]).strip() or None
    return found


def _loss_reason(lead):
    reasons = (lead.get("_embedded") or {}).get("loss_reason") or []
    return reasons[0].get("name") if reasons else None


def get_structure(client):
    """Funis/etapas (ordenadas) e usuários."""
    payload = client.get("leads/pipelines") or {}
    pipelines = payload.get("_embedded", {}).get("pipelines", [])
    statuses = []
    for p in pipelines:
        for s in (p.get("_embedded") or {}).get("statuses", []):
            statuses.append({
                "id": s["id"],
                "pipeline_id": p["id"],
                "pipeline": p.get("name", ""),
                "etapa": s.get("name", ""),
                "sort": s.get("sort", 0),
                "type": s.get("type", 0),
            })
    users = {u["id"]: u.get("name", "") for u in client.paginate("users")}
    return statuses, users


def _contato_principal(lead):
    contatos = (lead.get("_embedded") or {}).get("contacts") or []
    for c in contatos:
        if c.get("is_main"):
            return c["id"]
    return contatos[0]["id"] if contatos else None


def get_contacts(client):
    """{contact_id: {nome, telefone, email}} — chave do matching com a
    planilha do formulário (telefone/e-mail ficam em custom fields)."""
    out = {}
    for c in client.paginate("contacts", {"with": "leads"}):
        telefone = email = ""
        for f in c.get("custom_fields_values") or []:
            code = (f.get("field_code") or "").upper()
            valores = f.get("values") or []
            if code == "PHONE" and valores:
                telefone = str(valores[0].get("value") or "")
            elif code == "EMAIL" and valores:
                email = str(valores[0].get("value") or "").lower()
        out[c["id"]] = {"nome": c.get("name", ""),
                        "telefone": telefone, "email": email}
    print(f"  Kommo: {len(out)} contatos (telefone/e-mail)")
    return out


def get_leads(client, statuses, users):
    """1 registro por lead, já no contrato 1.1 (lead=deal no Kommo)."""
    etapa_por_id = {s["id"]: s["etapa"] for s in statuses}
    rows = []
    for lead in client.paginate("leads", {"with": "contacts,loss_reason"}):
        status_id = lead.get("status_id")
        ganho = status_id == config.KOMMO_STATUS_GANHO
        perdido = status_id == config.KOMMO_STATUS_PERDIDO
        rows.append({
            "id": lead["id"],
            "contato_id": _contato_principal(lead),
            "nome": lead.get("name", ""),
            "etapa": etapa_por_id.get(status_id, f"status {status_id}"),
            "etapa_id": status_id,
            "pipeline_id": lead.get("pipeline_id"),
            "ganho": ganho,
            "perdido": perdido,
            "motivo_perda": _loss_reason(lead),
            "criado_em": _iso(lead.get("created_at")),
            "fechado_em": _iso(lead.get("closed_at")),
            "valor": float(lead.get("price") or 0),
            "responsavel": users.get(lead.get("responsible_user_id"), ""),
            **_tracking(lead),
        })
    print(f"  Kommo: {len(rows)} leads")
    if not rows:
        print("::error::Kommo devolveu 0 leads — verificar token/conta")
    return rows


def get_talks(client):
    """Conversas ABERTAS (o endpoint /talks não devolve histórico — o total
    real de conversas vem dos eventos talk_created)."""
    rows = []
    for t in client.paginate("talks", collection="talks"):
        rows.append({
            "talk_id": t["talk_id"],
            "origin": t.get("origin", ""),
            "is_read": bool(t.get("is_read", False)),
            "criado_em": _iso(t.get("created_at")),
        })
    print(f"  Kommo: {len(rows)} conversas abertas")
    return rows


def get_events(client, days=None):
    """Eventos de chat, conversa e funil dos últimos N dias.

    Os de chat/conversa alimentam o Atendimento; os de funil
    (lead_status_changed) dão o tempo até o 1º atendimento e o tempo
    parado por etapa — cada um traz lead (entity_id) e etapas antes/depois.
    """
    days = days or config.KOMMO_EVENT_DAYS
    since = int(time.time()) - days * 86400
    rows = []
    for group in (CHAT_EVENTS, TALK_EVENTS, FUNNEL_EVENTS):
        params = {"filter[type][]": group, "filter[created_at][from]": since}
        for ev in client.paginate("events", params, collection="events"):
            talk_id = None
            status_before = status_after = None
            for entry in ev.get("value_after") or []:
                msg = entry.get("message")
                if msg:
                    talk_id = msg.get("talk_id")
                status = entry.get("lead_status")
                if status:
                    status_after = status.get("id")
            for entry in ev.get("value_before") or []:
                status = entry.get("lead_status")
                if status:
                    status_before = status.get("id")
            rows.append({
                "id": ev["id"],
                "type": ev.get("type", ""),
                "entity_id": ev.get("entity_id"),
                "talk_id": talk_id,
                "status_before": status_before,
                "status_after": status_after,
                "created_at": ev.get("created_at"),
                "criado_em": _iso(ev.get("created_at")),
            })
    rows.sort(key=lambda r: r["created_at"] or 0)
    print(f"  Kommo: {len(rows)} eventos ({days} dias)")
    return rows
