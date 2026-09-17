"""Coletor da Meta (Marketing API): leve, uma consulta por vez e só na hora
deste dashboard na grade da agência.

Todos os dashboards da Agência Delucca usam o mesmo app da Meta ("Delucca
dash criativos", 639332675906356) e o limite de chamadas vale para o app
inteiro: uma rajada aqui derruba a coleta de outro cliente. Por isso a
agência tem uma grade de horários e este dashboard só chama a Meta das
03:10 às 03:59 (Brasília) = 06:10 às 06:59 UTC. Ver README, "Grade da Meta".

- Sem META_COLETA=sim, ou fora da janela, nenhuma chamada é feita: o dado
  vem do cache da última coleta (data_raw/meta_*.json).
- Uma consulta por vez, só os campos que a tela usa, páginas pequenas.
- Toda resposta tem os cabeçalhos de uso lidos (x-app-usage,
  x-business-use-case-usage, x-fb-ads-insights-throttle): acima de 30% a
  rodada para e o resto fica para a próxima noite.
- Erro de limite (#4 e parentes) para a rodada na hora. Só tenta de novo
  depois de 15 minutos e se a nova tentativa ainda couber na janela.
- Não relê o que não muda: o histórico fica em cache e cada noite busca só
  os últimos 8 dias (a atribuição de 7 dias ainda mexe neles), as campanhas,
  os anúncios ativos e o mês corrente dos breakdowns.

Regras de ouro do dashboard mantidas: status vem de effective_status (2) e
cada linha de insight traz sua campanha e seu conjunto reais (4).

Uso:
  python -m collectors.meta_ads_api              coleta (se permitido)
  python -m collectors.meta_ads_api --verificar  diz se o cache está pronto
"""
import calendar
import datetime as dt
import json
import os
import sys
import time

import requests

import config

UTC = dt.timezone.utc
BRT = dt.timezone(dt.timedelta(hours=-3))

# Janelas em UTC (Brasília = UTC − 3).
JANELA_NOTURNA = (dt.time(6, 10), dt.time(6, 59))      # 03:10–03:59
SO_ESSENCIAL_APOS = dt.time(6, 45)                       # 03:45
JANELA_COMERCIAL = (dt.time(12, 10), dt.time(21, 59))  # 09:10–18:59, combinado antes

LIMITE_USO_PCT = 30
ESPERA_APOS_LIMITE_S = 15 * 60
MARGEM_FIM_S = 60                  # não começa chamada no último minuto da janela
FOLGA_PARA_RETENTAR_S = 3 * 60     # tempo mínimo para refazer o essencial após a espera
TIMEOUT_CHAMADA_S = 45
PAUSA_ENTRE_CHAMADAS_S = {"noturna": 1, "comercial": 3}
DIAS_RELEITURA = 8
MAX_DIAS_RELEITURA = 62
PAGINA = 100                 # insights por anúncio×dia (linhas com ações aninhadas)
PAGINA_BREAKDOWN = 200       # linhas campanha×mês, bem menores
PAGINA_ANUNCIOS = 50
IDS_POR_CHAMADA = 50

# Limites da Graph API: app (#4), usuário (#17), página (#32), por hora (#613)
# e os limites por business use case (#80000–#80014).
CODIGOS_LIMITE = {4, 17, 32, 613} | set(range(80000, 80015))

CAMPOS_INSIGHTS = ("campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,"
                   "spend,impressions,clicks,inline_link_clicks,actions,action_values")
CAMPOS_BREAKDOWN = "campaign_name,spend,impressions,clicks,actions"
BREAKDOWNS = (("age_gender", "age,gender"),
              ("placement", "publisher_platform,platform_position"),
              ("region", "region"))

ARQUIVOS = {
    "linhas": "meta_ads.json",
    "status": "meta_status.json",
    "breakdowns": "meta_breakdowns.json",
    "criativos": "meta_creatives.json",
    "campanhas": "meta_campaigns.json",
    "estado": "meta_coleta_estado.json",
}


class PararRodada(Exception):
    """A rodada termina aqui: o que já foi salvo fica, o resto fica para a
    próxima noite."""


class LimiteDaMeta(PararRodada):
    def __init__(self, codigo, mensagem):
        super().__init__(f"#{codigo} {mensagem}")
        self.codigo = codigo
        self.mensagem = mensagem


class ErroDaMeta(Exception):
    """Falha que não é de limite: pula a tarefa, sem tentar de novo."""


def _graph():
    return f"https://graph.facebook.com/{config.META_API_VERSION}"


def _conta():
    return f"act_{config.META_AD_ACCOUNT_ID}"


def janela_atual(agora_utc, comercial=False):
    """Janela aberta agora ({"tipo", "fim"}) ou None."""
    t = agora_utc.time()
    for tipo, (ini, fim), vale in (("noturna", JANELA_NOTURNA, True),
                                   ("comercial", JANELA_COMERCIAL, comercial)):
        if vale and ini <= t < fim:
            return {"tipo": tipo,
                    "fim": dt.datetime.combine(agora_utc.date(), fim, tzinfo=UTC)}
    return None


def _ler_uso(headers):
    """Percentuais de uso dos cabeçalhos da resposta, achatados."""
    def carregar(nome):
        try:
            return json.loads(headers.get(nome) or "{}")
        except ValueError:
            return {}

    uso = {}

    def guardar(chave, valor):
        if isinstance(valor, (int, float)) and not isinstance(valor, bool):
            uso[chave] = max(uso.get(chave, 0), valor)

    app = carregar("x-app-usage")
    if isinstance(app, dict):
        for k in ("call_count", "total_cputime", "total_time"):
            guardar(f"app.{k}", app.get(k))

    por_negocio = carregar("x-business-use-case-usage")
    if isinstance(por_negocio, dict):
        for itens in por_negocio.values():
            for item in itens if isinstance(itens, list) else []:
                tipo = item.get("type", "?") if isinstance(item, dict) else "?"
                for k in ("call_count", "total_cputime", "total_time"):
                    guardar(f"{tipo}.{k}", item.get(k) if isinstance(item, dict) else None)

    insights = carregar("x-fb-ads-insights-throttle")
    if isinstance(insights, dict):
        for k in ("app_id_util_pct", "acc_id_util_pct"):
            guardar(f"insights.{k}", insights.get(k))
    return uso


class ClienteMeta:
    def __init__(self, token, janela, agora, sessao=None, dormir=time.sleep):
        self.token = token
        self.janela = janela
        self.agora = agora
        self.sessao = sessao or requests.Session()
        self.dormir = dormir
        self.chamadas = 0
        self.uso_max = {}
        self.uso_alto = None

    def segundos_restantes(self):
        return (self.janela["fim"] - self.agora()).total_seconds()

    def get(self, caminho, params=None):
        if self.uso_alto:
            raise PararRodada(f"uso do app acima de {LIMITE_USO_PCT}% ({self.uso_alto})")
        if self.segundos_restantes() < MARGEM_FIM_S:
            raise PararRodada("fim da janela da grade")
        if self.chamadas:
            self.dormir(PAUSA_ENTRE_CHAMADAS_S[self.janela["tipo"]])

        url = caminho if caminho.startswith("http") else f"{_graph()}/{caminho}"
        timeout = max(5, min(TIMEOUT_CHAMADA_S, self.segundos_restantes() - 5))
        self.chamadas += 1
        try:
            resp = self.sessao.get(url, params=params, timeout=timeout,
                                   headers={"Authorization": f"Bearer {self.token}"})
        except requests.RequestException as e:
            # só o tipo: a mensagem do requests pode trazer a URL
            raise ErroDaMeta(f"falha de rede ({type(e).__name__})") from None

        uso = _ler_uso(resp.headers)
        for k, v in uso.items():
            self.uso_max[k] = max(self.uso_max.get(k, 0), v)
        altos = [f"{k}={v}%" for k, v in uso.items() if v > LIMITE_USO_PCT]
        if altos:
            self.uso_alto = ", ".join(altos)

        try:
            corpo = resp.json()
        except ValueError:
            corpo = {}
        erro = corpo.get("error") if isinstance(corpo, dict) else None
        if erro or resp.status_code >= 400:
            erro = erro or {}
            codigo = erro.get("code")
            mensagem = str(erro.get("message") or f"HTTP {resp.status_code}")[:200]
            if codigo in CODIGOS_LIMITE:
                raise LimiteDaMeta(codigo, mensagem)
            raise ErroDaMeta(f"#{codigo} {mensagem}")
        return corpo

    def paginar(self, caminho, params):
        linhas = []
        corpo = self.get(caminho, params)
        while True:
            linhas.extend(corpo.get("data", []))
            proxima = (corpo.get("paging") or {}).get("next")
            if not proxima:
                return linhas
            corpo = self.get(proxima)


# ----------------------------------------------------------------------
# Conversão das linhas
# ----------------------------------------------------------------------


def _acao(actions, tipo):
    for a in actions or []:
        if a.get("action_type") == tipo:
            try:
                return int(float(a.get("value", 0)))
            except (TypeError, ValueError):
                return 0
    return 0


def _valor(action_values, tipo):
    for a in action_values or []:
        if a.get("action_type") == tipo:
            try:
                return float(a.get("value", 0) or 0)
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def _linha(r):
    """1 linha de insight anúncio×dia no formato que o ETL lê.

    'leads_plat' e 'conversas' são referência da plataforma; o lead de
    verdade é o do CRM (regra de ouro 1).
    """
    acoes, valores = r.get("actions"), r.get("action_values")
    return {
        "data": r.get("date_start", ""),
        "campaign_id": r.get("campaign_id", ""),
        "campanha": r.get("campaign_name", ""),
        "adset_id": r.get("adset_id", ""),
        "conjunto": r.get("adset_name", ""),
        "ad_id": r.get("ad_id", ""),
        "anuncio": r.get("ad_name", ""),
        "gasto": float(r.get("spend", 0) or 0),
        "impressoes": int(r.get("impressions", 0) or 0),
        "cliques": int(r.get("clicks", 0) or 0),
        "cliques_link": int(r.get("inline_link_clicks", 0) or 0),
        "leads_plat": _acao(acoes, "lead"),
        "conversas": _acao(acoes, "onsite_conversion.messaging_conversation_started_7d"),
        "engajamento": _acao(acoes, "post_engagement"),
        "video_views": _acao(acoes, "video_view"),
        "seguidores": _acao(acoes, "like"),
        "compras": _acao(acoes, "omni_purchase") or _acao(acoes, "purchase"),
        "valor_compras": _valor(valores, "omni_purchase") or _valor(valores, "purchase"),
        "thumbnail": "",
        "permalink": "",
    }


def _item_breakdown(chave, r):
    acoes = r.get("actions")
    item = {
        "mes": (r.get("date_start") or "")[:7],
        "campanha": r.get("campaign_name", ""),
        "gasto": float(r.get("spend", 0) or 0),
        "impressoes": int(r.get("impressions", 0) or 0),
        "cliques": int(r.get("clicks", 0) or 0),
        "conversas": _acao(acoes, "onsite_conversion.messaging_conversation_started_7d"),
        "leads_plat": _acao(acoes, "lead"),
    }
    if chave == "age_gender":
        item["idade"] = r.get("age", "?")
        item["genero"] = r.get("gender", "?")
    elif chave == "placement":
        item["plataforma"] = r.get("publisher_platform", "?")
        item["posicao"] = r.get("platform_position", "?")
    else:
        item["regiao"] = r.get("region", "?")
    return item


def _criativo(anuncio, hoje):
    criativo = anuncio.get("creative") or {}
    story = criativo.get("effective_object_story_id", "")
    return {
        "nome": anuncio.get("name", ""),
        "thumbnail": criativo.get("thumbnail_url", ""),
        "permalink": f"https://www.facebook.com/{story}" if story else "",
        "atualizado_em": hoje.isoformat(),
    }


def _time_range(desde, ate):
    return json.dumps({"since": desde.isoformat(), "until": ate.isoformat()})


def _fim_do_mes(d):
    return dt.date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


# ----------------------------------------------------------------------
# Cache
# ----------------------------------------------------------------------


def _caminho(nome):
    return os.path.join(config.RAW_DIR, ARQUIVOS[nome])


def carregar_cache():
    padroes = {"linhas": [], "status": {}, "breakdowns": {}, "criativos": {},
               "campanhas": {}, "estado": {}}
    cache = {}
    for nome, padrao in padroes.items():
        try:
            with open(_caminho(nome), encoding="utf-8") as f:
                valor = json.load(f)
            cache[nome] = valor if isinstance(valor, type(padrao)) else padrao
        except (OSError, ValueError):
            cache[nome] = padrao
    return cache


def gravar_cache(cache):
    os.makedirs(config.RAW_DIR, exist_ok=True)
    criativos = cache["criativos"]
    for linha in cache["linhas"]:
        cre = criativos.get(linha.get("ad_id")) or {}
        linha["thumbnail"] = cre.get("thumbnail") or linha.get("thumbnail", "")
        linha["permalink"] = cre.get("permalink") or linha.get("permalink", "")
    if cache["campanhas"]:
        status = {}
        for c in cache["campanhas"].values():
            # nomes repetidos: ACTIVE vence (o dashboard agrupa por nome)
            if c["nome"] not in status or c["status"] == "ACTIVE":
                status[c["nome"]] = c["status"]
        cache["status"] = status
    for nome in ARQUIVOS:
        with open(_caminho(nome), "w", encoding="utf-8") as f:
            json.dump(cache[nome], f, ensure_ascii=False, separators=(",", ":"))


def dado_pronto(cache=None):
    """(pronto, motivo): há linhas e o histórico já está completo no cache."""
    cache = cache or carregar_cache()
    estado = cache["estado"]
    if not cache["linhas"]:
        return False, "nenhuma linha da Meta no cache"
    coberto, recente = estado.get("coberto_ate"), estado.get("recente_desde")
    # completo = sem buraco entre o histórico e a última leitura recente
    if not (coberto and recente and dt.date.fromisoformat(coberto)
            >= dt.date.fromisoformat(recente) - dt.timedelta(days=1)):
        return False, "histórico da Meta ainda incompleto (backfill em andamento)"
    return True, f"Meta coberta até {coberto}"


# ----------------------------------------------------------------------
# Tarefas da rodada
# ----------------------------------------------------------------------


def tarefa_campanhas(cli, cache, rodada):
    brutas = cli.paginar(f"{_conta()}/campaigns",
                         {"fields": "id,name,effective_status", "limit": PAGINA})
    campanhas = {c["id"]: {"nome": c.get("name", ""),
                           "status": c.get("effective_status", "")}
                 for c in brutas if c.get("id")}
    if not campanhas:
        print("::error::Meta: nenhuma campanha retornada — token sem ads_read?")
        return
    cache["campanhas"] = campanhas
    # a frente (B2B/e-commerce) é classificada pelo nome: renomear uma
    # campanha precisa valer para o histórico inteiro
    for linha in cache["linhas"]:
        c = campanhas.get(linha.get("campaign_id"))
        if c:
            linha["campanha"] = c["nome"]
    print(f"  Meta: {len(campanhas)} campanhas")


def _periodo_recente(cache, hoje):
    inicio = dt.date.fromisoformat(config.META_SINCE)
    desde = hoje - dt.timedelta(days=DIAS_RELEITURA - 1)
    ultima = cache["estado"].get("ultima_leitura_recente")
    if ultima:
        # noites sem coleta: relê tudo que ainda estava dentro da atribuição
        # na última leitura (em noites seguidas isso é o mesmo período).
        # Buraco maior que MAX_DIAS_RELEITURA não entra aqui: o backfill cobre.
        desde_buraco = dt.date.fromisoformat(ultima) - dt.timedelta(days=DIAS_RELEITURA - 2)
        if (hoje - desde_buraco).days <= MAX_DIAS_RELEITURA:
            desde = min(desde, desde_buraco)
    return max(desde, inicio), hoje


def tarefa_insights_recentes(cli, cache, rodada):
    hoje = rodada["hoje"]
    desde, ate = _periodo_recente(cache, hoje)
    brutas = cli.paginar(f"{_conta()}/insights", {
        "level": "ad", "time_increment": 1, "fields": CAMPOS_INSIGHTS,
        "time_range": _time_range(desde, ate), "limit": PAGINA})
    novas = [_linha(r) for r in brutas]
    d0, d1 = desde.isoformat(), ate.isoformat()
    ficam = [l for l in cache["linhas"] if not (d0 <= l.get("data", "") <= d1)]
    cache["linhas"] = sorted(ficam + novas, key=lambda l: (l["data"], l.get("ad_id", "")))

    estado = cache["estado"]
    coberto = estado.get("coberto_ate")
    if coberto and dt.date.fromisoformat(coberto) >= desde - dt.timedelta(days=1):
        estado["coberto_ate"] = d1
    estado["ultima_leitura_recente"] = d1
    estado["recente_desde"] = d0
    rodada["recente_desde"] = desde
    print(f"  Meta: {len(novas)} linhas anúncio×dia de {d0} a {d1}")


def tarefa_historico(cli, cache, rodada, persistir):
    """Backfill mês a mês do que ainda não está no cache. Só roda enquanto
    houver buraco; depois disso não faz nenhuma chamada."""
    if not rodada.get("recente_desde"):
        return
    estado = cache["estado"]
    inicio = dt.date.fromisoformat(config.META_SINCE)
    coberto = estado.get("coberto_ate")
    faixa_ini = dt.date.fromisoformat(coberto) + dt.timedelta(days=1) if coberto else inicio
    faixa_fim = rodada["recente_desde"] - dt.timedelta(days=1)

    if faixa_ini <= faixa_fim:
        faixa = [faixa_ini.isoformat(), faixa_fim.isoformat()]
        mapa = estado.get("meses_com_gasto")
        if not mapa or mapa.get("faixa") != faixa:
            # 1 chamada leve para não pedir mês a mês os meses sem veiculação
            por_mes = cli.paginar(f"{_conta()}/insights", {
                "level": "account", "time_increment": "monthly", "fields": "spend",
                "time_range": _time_range(faixa_ini, faixa_fim), "limit": PAGINA})
            meses = sorted({(r.get("date_start") or "")[:7] for r in por_mes
                            if float(r.get("spend", 0) or 0) > 0})
            estado["meses_com_gasto"] = {"faixa": faixa, "meses": meses}
            persistir()
        meses = set(estado["meses_com_gasto"]["meses"])

        cursor = faixa_ini
        while cursor <= faixa_fim:
            fim_mes = min(_fim_do_mes(cursor), faixa_fim)
            if cursor.strftime("%Y-%m") in meses:
                brutas = cli.paginar(f"{_conta()}/insights", {
                    "level": "ad", "time_increment": 1, "fields": CAMPOS_INSIGHTS,
                    "time_range": _time_range(cursor, fim_mes), "limit": PAGINA})
                d0, d1 = cursor.isoformat(), fim_mes.isoformat()
                ficam = [l for l in cache["linhas"] if not (d0 <= l.get("data", "") <= d1)]
                cache["linhas"] = sorted(ficam + [_linha(r) for r in brutas],
                                         key=lambda l: (l["data"], l.get("ad_id", "")))
                print(f"  Meta histórico: {len(brutas)} linhas de {d0} a {d1}")
            estado["coberto_ate"] = fim_mes.isoformat()
            persistir()
            cursor = fim_mes + dt.timedelta(days=1)

    # o histórico encosta na leitura recente desta noite: tudo coberto
    estado["coberto_ate"] = estado["ultima_leitura_recente"]
    estado.pop("meses_com_gasto", None)


def tarefa_anuncios_ativos(cli, cache, rodada):
    brutas = cli.paginar(f"{_conta()}/ads", {
        "fields": "id,name,effective_status,creative{thumbnail_url,effective_object_story_id}",
        "filtering": json.dumps([{"field": "effective_status", "operator": "IN",
                                  "value": ["ACTIVE"]}]),
        "limit": PAGINA_ANUNCIOS})
    # o filtro da Meta devolve alguns anúncios a mais
    ativos = [a for a in brutas if a.get("effective_status") == "ACTIVE" and a.get("id")]
    for a in ativos:
        cache["criativos"][a["id"]] = _criativo(a, rodada["hoje"])
    nomes = {a["id"]: a.get("name") for a in ativos if a.get("name")}
    for linha in cache["linhas"]:
        if linha.get("ad_id") in nomes:
            linha["anuncio"] = nomes[linha["ad_id"]]
    print(f"  Meta: {len(ativos)} anúncios ativos "
          f"({len(brutas) - len(ativos)} descartados pelo effective_status)")


def tarefa_criativos_faltantes(cli, cache, rodada):
    """Miniatura e link dos anúncios que aparecem nos insights e ainda não
    estão no cache (anúncio pausado não muda de criativo: lê uma vez só)."""
    faltam = sorted({l["ad_id"] for l in cache["linhas"]
                     if l.get("ad_id") and l["ad_id"] not in cache["criativos"]})
    for i in range(0, len(faltam), IDS_POR_CHAMADA):
        lote = faltam[i:i + IDS_POR_CHAMADA]
        corpo = cli.get("", {"ids": ",".join(lote),
                             "fields": "name,creative{thumbnail_url,effective_object_story_id}"})
        for ad_id in lote:
            cache["criativos"][ad_id] = _criativo(corpo.get(ad_id) or {}, rodada["hoje"])
    if faltam:
        print(f"  Meta: criativos de {len(faltam)} anúncios guardados")


def tarefa_breakdowns(cli, cache, rodada, persistir):
    hoje = rodada["hoje"]
    mes_atual = hoje.strftime("%Y-%m")
    datas = sorted(l["data"] for l in cache["linhas"] if l.get("data"))
    primeiro_mes = datas[0][:7] if datas else config.META_SINCE[:7]

    meses_do_periodo = []
    cursor = dt.date.fromisoformat(primeiro_mes + "-01")
    while cursor.strftime("%Y-%m") <= mes_atual:
        meses_do_periodo.append(cursor.strftime("%Y-%m"))
        cursor = _fim_do_mes(cursor) + dt.timedelta(days=1)

    for chave, breakdown in BREAKDOWNS:
        atuais = cache["breakdowns"].get(chave, [])
        com_dado = {i.get("mes") for i in atuais}
        precisa = {m for m in meses_do_periodo if m not in com_dado} | {mes_atual}
        if hoje.day <= 7:  # atribuição ainda mexe no mês anterior
            precisa.add((hoje.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m"))
        desde = dt.date.fromisoformat(min(precisa) + "-01")
        lidos = {m for m in meses_do_periodo if m >= min(precisa)}
        brutas = cli.paginar(f"{_conta()}/insights", {
            "level": "campaign", "time_increment": "monthly",
            "fields": CAMPOS_BREAKDOWN, "breakdowns": breakdown,
            "time_range": _time_range(desde, hoje), "limit": PAGINA_BREAKDOWN})
        novos = [_item_breakdown(chave, r) for r in brutas]
        cache["breakdowns"][chave] = [i for i in atuais if i.get("mes") not in lidos] + novos
        persistir()
        print(f"  Meta breakdown {chave}: {len(novos)} linhas desde {desde:%Y-%m}")


# ----------------------------------------------------------------------
# Rodada
# ----------------------------------------------------------------------


def _output_do_workflow(chave, valor):
    arquivo = os.getenv("GITHUB_OUTPUT")
    if arquivo:
        with open(arquivo, "a", encoding="utf-8") as f:
            f.write(f"{chave}={valor}\n")


def coletar(agora=None, sessao=None, dormir=time.sleep):
    agora = agora or (lambda: dt.datetime.now(UTC))
    cache = carregar_cache()
    resumo = {"chamou_meta": False, "chamadas": 0, "tarefas_ok": [],
              "puladas": [], "falhas": [], "parou_por": None}

    if config.META_COLETA != "sim":
        print("Meta: coleta desligada nesta execução (META_COLETA≠sim) — "
              "usando o último dado em cache.")
        gravar_cache(cache)
        return resumo
    if not (config.META_ACCESS_TOKEN and config.META_AD_ACCOUNT_ID):
        print("::error::Meta: META_ACCESS_TOKEN/META_AD_ACCOUNT_ID ausentes.")
        gravar_cache(cache)
        return resumo

    janela = janela_atual(agora(), config.META_JANELA_COMERCIAL == "sim")
    if not janela:
        print("::warning::Meta: fora da janela da grade (03:10–03:59 em Brasília) — "
              "nenhuma chamada; usando o último dado em cache.")
        gravar_cache(cache)
        return resumo

    cli = ClienteMeta(config.META_ACCESS_TOKEN, janela, agora, sessao, dormir)
    rodada = {"hoje": agora().astimezone(BRT).date()}
    resumo["chamou_meta"] = True
    _output_do_workflow("chamou_meta", "true")

    def persistir():
        gravar_cache(cache)

    tarefas = [
        ("campanhas", True, lambda: tarefa_campanhas(cli, cache, rodada)),
        ("insights_recentes", True, lambda: tarefa_insights_recentes(cli, cache, rodada)),
        ("historico", False, lambda: tarefa_historico(cli, cache, rodada, persistir)),
        ("anuncios_ativos", False, lambda: tarefa_anuncios_ativos(cli, cache, rodada)),
        ("criativos_faltantes", False, lambda: tarefa_criativos_faltantes(cli, cache, rodada)),
        ("breakdowns", False, lambda: tarefa_breakdowns(cli, cache, rodada, persistir)),
    ]
    esperou = False
    i = 0
    while i < len(tarefas):
        nome, essencial, executar = tarefas[i]
        if (not essencial and janela["tipo"] == "noturna"
                and agora().time() >= SO_ESSENCIAL_APOS):
            resumo["puladas"].append(nome)
            i += 1
            continue
        try:
            executar()
            gravar_cache(cache)
            resumo["tarefas_ok"].append(nome)
            i += 1
        except LimiteDaMeta as e:
            gravar_cache(cache)
            print(f"::warning::Meta: erro de limite #{e.codigo} em '{nome}' — rodada parada.")
            cabe = cli.segundos_restantes() >= ESPERA_APOS_LIMITE_S + FOLGA_PARA_RETENTAR_S
            if esperou or not cabe:
                resumo["parou_por"] = (f"limite #{e.codigo}" +
                                       ("" if cabe else "; nova tentativa não cabe na janela"))
                break
            print("  Meta: aguardando 15 minutos para tentar de novo dentro da janela.")
            dormir(ESPERA_APOS_LIMITE_S)
            esperou = True
            cli.uso_alto = None
        except PararRodada as e:
            gravar_cache(cache)
            print(f"::warning::Meta: rodada parada em '{nome}': {e}")
            resumo["parou_por"] = str(e)
            break
        except ErroDaMeta as e:
            print(f"::warning::Meta: '{nome}' falhou ({e}) — segue sem ela.")
            resumo["falhas"].append(nome)
            i += 1

    resumo["chamadas"] = cli.chamadas
    resumo["uso_max"] = cli.uso_max
    registros = cache["estado"].setdefault("rodadas", [])
    registros.append({"quando": agora().isoformat(timespec="minutes"),
                      "janela": janela["tipo"], **{k: v for k, v in resumo.items()
                                                    if k != "chamou_meta"}})
    del registros[:-20]
    gravar_cache(cache)

    pico = max(cli.uso_max.values(), default=0)
    print(f"  Meta: {cli.chamadas} chamadas · pico de uso {pico}% · "
          f"ok: {', '.join(resumo['tarefas_ok']) or '—'}"
          + (f" · puladas: {', '.join(resumo['puladas'])}" if resumo["puladas"] else "")
          + (f" · parou por: {resumo['parou_por']}" if resumo["parou_por"] else ""))
    return resumo


if __name__ == "__main__":
    if "--verificar" in sys.argv:
        pronto, motivo = dado_pronto()
        print(("Meta pronta: " if pronto else "::warning::Meta não pronta: ") + motivo)
        _output_do_workflow("pronto", "true" if pronto else "false")
    else:
        coletar()
