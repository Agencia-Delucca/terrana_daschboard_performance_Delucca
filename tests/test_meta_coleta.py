"""Testes do coletor da Meta contra uma API falsa — nenhuma chamada real.

Cobrem as regras da grade da agência: janela de horário, uma consulta por
vez, token só no cabeçalho, parada com uso acima de 30%, erro de limite com
espera de 15 minutos, só o essencial depois das 03:45 e leitura incremental.

    python -m unittest discover -s tests -t .
"""
import datetime as dt
import json
import os
import tempfile
import unittest
from unittest import mock

import config
from collectors import meta_ads_api as meta

UTC = dt.timezone.utc
TOKEN = "TOKEN-SECRETO-DE-TESTE"


class Relogio:
    def __init__(self, inicio):
        self.t = inicio
        self.dormidas = []

    def agora(self):
        return self.t

    def dormir(self, segundos):
        self.dormidas.append(segundos)
        self.t += dt.timedelta(seconds=segundos)


class Resposta:
    def __init__(self, corpo, status=200, headers=None):
        self._corpo = corpo
        self.status_code = status
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}

    def json(self):
        return self._corpo


def erro_limite(codigo=4):
    return Resposta({"error": {"code": codigo,
                               "message": "(#4) Application request limit reached"}},
                    status=400)


class MetaFalsa:
    """Responde como a Graph API para uma conta pequena e registra as chamadas."""

    DIAS = [dt.date(2026, 8, 20) + dt.timedelta(days=i) for i in range(30)]  # até 18/09

    def __init__(self, relogio):
        self.relogio = relogio
        self.chamadas = []
        self.falhas = {}
        self.uso = {}
        self.proximas = {}
        self.nomes = {"C1": "[ECOMMERCE] Loja", "C2": "AD - Formulário Nativo - Leads - B2B"}

    def _linhas_ad(self):
        linhas = []
        for d in self.DIAS:
            for ad, camp, conj in (("A1", "C1", "S1"), ("A2", "C2", "S2")):
                linhas.append({
                    "date_start": d.isoformat(), "campaign_id": camp,
                    "campaign_name": self.nomes[camp], "adset_id": conj,
                    "adset_name": f"Conjunto {conj}", "ad_id": ad, "ad_name": f"Anúncio {ad}",
                    "spend": "10.00", "impressions": "1000", "clicks": "30",
                    "inline_link_clicks": "20",
                    "actions": [{"action_type": "lead", "value": "2"}],
                    "action_values": []})
        return linhas

    @staticmethod
    def _no_periodo(params, data):
        faixa = json.loads(params["time_range"])
        return faixa["since"] <= data <= faixa["until"]

    def _rota(self, url, params):
        if url.endswith("/campaigns"):
            return "campaigns"
        if url.endswith("/ads"):
            return "ads"
        if url.endswith("/insights"):
            return {"account": "insights_conta", "ad": "insights_ad",
                    "campaign": "breakdown"}[params["level"]]
        if "ids" in params:
            return "ids"
        raise AssertionError(f"rota inesperada: {url}")

    def _dados(self, rota, params):
        if rota == "campaigns":
            return [{"id": "C1", "name": self.nomes["C1"], "effective_status": "ACTIVE"},
                    {"id": "C2", "name": self.nomes["C2"], "effective_status": "PAUSED"}]
        if rota == "ads":
            # o filtro da Meta devolve um anúncio pausado a mais
            return [{"id": "A1", "name": "Anúncio A1", "effective_status": "ACTIVE",
                     "creative": {"thumbnail_url": "https://cdn/a1.jpg",
                                  "effective_object_story_id": "1_11"}},
                    {"id": "A3", "name": "Anúncio A3", "effective_status": "PAUSED",
                     "creative": {"thumbnail_url": "https://cdn/a3.jpg"}}]
        if rota == "insights_ad":
            return [l for l in self._linhas_ad() if self._no_periodo(params, l["date_start"])]
        if rota == "insights_conta":
            meses = sorted({l["date_start"][:7] for l in self._linhas_ad()
                            if self._no_periodo(params, l["date_start"])})
            return [{"date_start": f"{m}-01", "spend": "100.00"} for m in meses]
        if rota == "breakdown":
            faixa = json.loads(params["time_range"])
            meses = sorted({d.strftime("%Y-%m") for d in self.DIAS
                            if faixa["since"] <= d.isoformat() <= faixa["until"]})
            return [{"date_start": f"{m}-01", "campaign_name": self.nomes["C1"],
                     "spend": "5", "impressions": "100", "clicks": "3", "actions": [],
                     "age": "25-34", "gender": "female", "publisher_platform": "instagram",
                     "platform_position": "feed", "region": "São Paulo"} for m in meses]
        if rota == "ids":
            return {i: {"name": f"Anúncio {i}",
                        "creative": {"thumbnail_url": f"https://cdn/{i}.jpg"}}
                    for i in params["ids"].split(",")}
        raise AssertionError(rota)

    def get(self, url, params=None, timeout=None, headers=None):
        self.relogio.t += dt.timedelta(seconds=1)
        params = dict(params or {})
        if url in self.proximas:
            rota, pendentes, limite = self.proximas.pop(url)
        else:
            rota, pendentes, limite = self._rota(url, params), None, None
        self.chamadas.append({"url": url, "params": params,
                              "headers": dict(headers or {}), "rota": rota})
        if self.falhas.get(rota):
            return self.falhas[rota].pop(0)

        cabecalhos = {"x-app-usage": json.dumps(
            {"call_count": 1, "total_cputime": 1, "total_time": 1})}
        if rota.startswith("insights") or rota == "breakdown":
            cabecalhos["x-fb-ads-insights-throttle"] = json.dumps(
                {"app_id_util_pct": 1, "acc_id_util_pct": 1})
        cabecalhos.update(self.uso.get(rota, {}))

        if pendentes is None:
            dados = self._dados(rota, params)
            if rota == "ids":
                return Resposta(dados, headers=cabecalhos)
            pendentes, limite = dados, int(params.get("limit", 1000))
        pagina, resto = pendentes[:limite], pendentes[limite:]
        corpo = {"data": pagina}
        if resto:
            proxima = f"https://graph.facebook.com/v21.0/pagina/{len(self.chamadas)}"
            self.proximas[proxima] = (rota, resto, limite)
            corpo["paging"] = {"next": proxima}
        return Resposta(corpo, headers=cabecalhos)


class TestColetaMeta(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for nome, valor in {"RAW_DIR": self.tmp.name, "META_COLETA": "sim",
                            "META_JANELA_COMERCIAL": "nao", "META_ACCESS_TOKEN": TOKEN,
                            "META_AD_ACCOUNT_ID": "1", "META_SINCE": "2026-08-01",
                            "META_API_VERSION": "v21.0"}.items():
            patcher = mock.patch.object(config, nome, valor)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.relogio = Relogio(dt.datetime(2026, 9, 18, 6, 10, tzinfo=UTC))
        self.api = MetaFalsa(self.relogio)

    def rodar(self):
        return meta.coletar(agora=self.relogio.agora, sessao=self.api,
                            dormir=self.relogio.dormir)

    def ler(self, arquivo):
        with open(os.path.join(self.tmp.name, arquivo), encoding="utf-8") as f:
            return json.load(f)

    def rotas(self):
        return [c["rota"] for c in self.api.chamadas]

    # --- grade ------------------------------------------------------------

    def test_fora_da_janela_nao_chama(self):
        self.relogio.t = dt.datetime(2026, 9, 18, 9, 12, tzinfo=UTC)  # hora do Orizen
        resumo = self.rodar()
        self.assertFalse(resumo["chamou_meta"])
        self.assertEqual(self.api.chamadas, [])

    def test_coleta_desligada_nao_chama_nem_na_janela(self):
        with mock.patch.object(config, "META_COLETA", "nao"):
            self.rodar()
        self.assertEqual(self.api.chamadas, [])

    def test_horario_comercial_so_com_liberacao(self):
        self.relogio.t = dt.datetime(2026, 9, 18, 13, 0, tzinfo=UTC)  # 10:00 Brasília
        self.rodar()
        self.assertEqual(self.api.chamadas, [])
        with mock.patch.object(config, "META_JANELA_COMERCIAL", "sim"):
            resumo = self.rodar()
        self.assertTrue(resumo["chamou_meta"])
        self.assertIn(3, self.relogio.dormidas)  # pausa maior entre chamadas

    def test_nao_comeca_chamada_no_ultimo_minuto(self):
        self.relogio.t = dt.datetime(2026, 9, 18, 6, 58, 10, tzinfo=UTC)
        resumo = self.rodar()
        self.assertEqual(self.api.chamadas, [])
        self.assertIn("fim da janela", resumo["parou_por"])

    # --- primeira noite e noites seguintes ----------------------------------

    def test_primeira_noite_completa_e_leve(self):
        resumo = self.rodar()
        self.assertEqual(resumo["tarefas_ok"],
                         ["campanhas", "insights_recentes", "historico",
                          "anuncios_ativos", "criativos_faltantes", "breakdowns"])
        self.assertEqual(self.rotas(),
                         ["campaigns", "insights_ad", "insights_conta", "insights_ad",
                          "insights_ad", "ads", "ids", "breakdown", "breakdown", "breakdown"])
        for c in self.api.chamadas:
            self.assertEqual(c["headers"].get("Authorization"), f"Bearer {TOKEN}")
            self.assertNotIn(TOKEN, c["url"])
            self.assertNotIn(TOKEN, json.dumps(c["params"]))
            self.assertNotIn("reach", c["params"].get("fields", ""))
            self.assertLessEqual(int(c["params"].get("limit", 0)), 200)

        ads = next(c for c in self.api.chamadas if c["rota"] == "ads")
        self.assertIn("ACTIVE", ads["params"]["filtering"])

        linhas = self.ler("meta_ads.json")
        self.assertEqual(len(linhas), 60)
        self.assertEqual(len({(l["data"], l["ad_id"]) for l in linhas}), 60)
        self.assertEqual(self.ler("meta_status.json"),
                         {"[ECOMMERCE] Loja": "ACTIVE",
                          "AD - Formulário Nativo - Leads - B2B": "PAUSED"})
        criativos = self.ler("meta_creatives.json")
        self.assertIn("A2", criativos)          # pausado com entrega: lido pelos ids
        self.assertNotIn("A3", criativos)       # devolvido a mais pelo filtro
        self.assertTrue(all(l["thumbnail"] for l in linhas))
        self.assertEqual(meta.dado_pronto(meta.carregar_cache()),
                         (True, "Meta coberta até 2026-09-18"))

    def test_segunda_noite_so_le_o_que_muda(self):
        self.rodar()
        self.api.chamadas.clear()
        self.relogio.t = dt.datetime(2026, 9, 19, 6, 10, tzinfo=UTC)
        self.rodar()
        self.assertEqual(self.rotas(),
                         ["campaigns", "insights_ad", "ads", "breakdown", "breakdown", "breakdown"])
        recente = json.loads(self.api.chamadas[1]["params"]["time_range"])
        self.assertEqual(recente, {"since": "2026-09-12", "until": "2026-09-19"})
        brk = json.loads(self.api.chamadas[3]["params"]["time_range"])
        self.assertEqual(brk["since"], "2026-09-01")
        self.assertEqual(len(self.ler("meta_ads.json")), 60)

    def test_renomear_campanha_vale_para_o_historico(self):
        self.rodar()
        self.api.nomes["C1"] = "[ECOMMERCE] Loja Nova"
        self.relogio.t = dt.datetime(2026, 9, 19, 6, 10, tzinfo=UTC)
        self.rodar()
        nomes = {l["campanha"] for l in self.ler("meta_ads.json") if l["campaign_id"] == "C1"}
        self.assertEqual(nomes, {"[ECOMMERCE] Loja Nova"})

    def test_paginacao_segue_next_com_token_no_cabecalho(self):
        with mock.patch.object(meta, "PAGINA", 10):
            self.rodar()
        self.assertEqual(len(self.ler("meta_ads.json")), 60)
        paginas = [c for c in self.api.chamadas if "/pagina/" in c["url"]]
        self.assertTrue(paginas)
        self.assertTrue(all(c["headers"]["Authorization"] == f"Bearer {TOKEN}" for c in paginas))

    # --- limites -------------------------------------------------------------

    def test_uso_acima_de_30_para_a_rodada(self):
        self.api.uso["campaigns"] = {"x-app-usage": json.dumps(
            {"call_count": 5, "total_cputime": 12, "total_time": 35})}
        resumo = self.rodar()
        self.assertEqual(self.rotas(), ["campaigns"])
        self.assertIn("30%", resumo["parou_por"])
        self.assertIn("app.total_time=35%", resumo["parou_por"])
        self.assertEqual(len(self.ler("meta_campaigns.json")), 2)  # o que veio fica salvo

    def test_uso_de_negocio_acima_de_30_tambem_para(self):
        self.api.uso["campaigns"] = {"x-business-use-case-usage": json.dumps(
            {"1": [{"type": "ads_insights", "call_count": 40, "total_cputime": 1,
                    "total_time": 1}]})}
        resumo = self.rodar()
        self.assertEqual(self.rotas(), ["campaigns"])
        self.assertIn("ads_insights.call_count=40%", resumo["parou_por"])

    def test_erro_4_espera_15_minutos_e_tenta_de_novo(self):
        self.api.falhas["insights_ad"] = [erro_limite(4)]
        resumo = self.rodar()
        self.assertIn(15 * 60, self.relogio.dormidas)
        self.assertEqual(self.rotas()[:3], ["campaigns", "insights_ad", "insights_ad"])
        self.assertIn("insights_recentes", resumo["tarefas_ok"])
        self.assertIsNone(resumo["parou_por"])

    def test_erro_4_sem_tempo_na_janela_desiste(self):
        self.relogio.t = dt.datetime(2026, 9, 18, 6, 44, tzinfo=UTC)
        self.api.falhas["campaigns"] = [erro_limite(4)]
        resumo = self.rodar()
        self.assertNotIn(15 * 60, self.relogio.dormidas)
        self.assertEqual(self.rotas(), ["campaigns"])
        self.assertIn("não cabe na janela", resumo["parou_por"])

    def test_segundo_erro_de_limite_encerra(self):
        self.api.falhas["campaigns"] = [erro_limite(4), erro_limite(80000)]
        resumo = self.rodar()
        self.assertEqual(self.relogio.dormidas.count(15 * 60), 1)
        self.assertEqual(self.rotas(), ["campaigns", "campaigns"])
        self.assertIn("#80000", resumo["parou_por"])

    def test_depois_das_0345_so_o_essencial(self):
        self.relogio.t = dt.datetime(2026, 9, 18, 6, 46, tzinfo=UTC)
        resumo = self.rodar()
        self.assertEqual(resumo["tarefas_ok"], ["campanhas", "insights_recentes"])
        self.assertEqual(resumo["puladas"],
                         ["historico", "anuncios_ativos", "criativos_faltantes", "breakdowns"])
        pronto, motivo = meta.dado_pronto(meta.carregar_cache())
        self.assertFalse(pronto)          # sem histórico não publica
        self.assertIn("incompleto", motivo)

    def test_historico_interrompido_nao_fica_pronto_e_continua_na_noite_seguinte(self):
        self.api.uso["insights_conta"] = {"x-app-usage": json.dumps(
            {"call_count": 31, "total_cputime": 1, "total_time": 1})}
        self.rodar()
        self.assertFalse(meta.dado_pronto(meta.carregar_cache())[0])
        self.api.uso.clear()
        self.relogio.t = dt.datetime(2026, 9, 19, 6, 10, tzinfo=UTC)
        self.rodar()
        self.assertTrue(meta.dado_pronto(meta.carregar_cache())[0])
        self.assertEqual(len(self.ler("meta_ads.json")), 60)

    def test_erro_comum_pula_a_tarefa_sem_retentar(self):
        self.api.falhas["breakdown"] = [Resposta(
            {"error": {"code": 100, "message": "Invalid parameter"}}, status=400)]
        resumo = self.rodar()
        self.assertIn("breakdowns", resumo["falhas"])
        self.assertNotIn(15 * 60, self.relogio.dormidas)
        self.assertEqual(self.rotas().count("breakdown"), 1)


if __name__ == "__main__":
    unittest.main()
