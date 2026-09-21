"""Testes da origem geográfica dos leads (DDD → estado) — sem rede.

    python -m unittest discover -s tests -t .
"""
import json
import unittest

import regioes_br as rb
from scripts import generate_dashboard_data as etl


class TabelaDDD(unittest.TestCase):
    def test_67_ddds_e_27_estados(self):
        self.assertEqual(len(rb.DDD), 67)
        ufs = {uf for uf, _, _ in rb.DDD.values()}
        self.assertEqual(ufs, set(rb.NOME_UF))
        self.assertEqual(set(rb.REGIAO_UF), set(rb.NOME_UF))
        self.assertEqual(set(rb.REGIAO_UF.values()),
                         {"Sudeste", "Sul", "Centro-Oeste", "Nordeste", "Norte"})


class Telefone(unittest.TestCase):
    def test_formatos_brasileiros(self):
        casos = {
            "+55 (19) 99876-5432": "19",   # celular com país
            "5511987654321": "11",
            "551932345678": "19",          # fixo com país
            "11987654321": "11",           # celular sem país
            "1932345678": "19",            # fixo sem país
            "019987654321": "19",          # 0 de longa distância
            "5501998765432": "19",         # 55 + 0 + DDD
            "55999999999": "55",           # DDD 55 (RS) sem o país
        }
        for tel, ddd in casos.items():
            with self.subTest(tel=tel):
                self.assertEqual(rb.ddd_do_telefone(tel), ddd)

    def test_nao_brasileiros(self):
        self.assertEqual(rb.localizar("+1 305 555 1234")["tipo"], "exterior")
        self.assertEqual(rb.localizar("+351 912 345 678")["tipo"], "exterior")
        self.assertEqual(rb.localizar("5520987654321")["tipo"], "invalido")  # DDD 20 não existe
        self.assertEqual(rb.localizar("123")["tipo"], "invalido")
        self.assertEqual(rb.localizar("")["tipo"], "sem_telefone")
        self.assertEqual(rb.localizar(None)["tipo"], "sem_telefone")

    def test_localizar_devolve_estado_e_area(self):
        loc = rb.localizar("+55 19 99876-5432")
        self.assertEqual((loc["tipo"], loc["uf"], loc["polo"]), ("br", "SP", "Campinas"))


class AgregacaoRegiao(unittest.TestCase):
    def setUp(self):
        self.contatos = {
            "1": {"nome": "Fulana", "telefone": "+5519998765432", "email": "a@x.com"},
            "2": {"nome": "Beltrano", "telefone": "5521987654321", "email": ""},
            "3": {"nome": "Ciclano", "telefone": "+5571987654321", "email": ""},
            "4": {"nome": "Exterior", "telefone": "+13055551234", "email": ""},
        }
        self.leads = [
            {"id": 1, "contato_id": 1, "criado_em": "2026-09-01T10:00:00-03:00", "tags": ["metaform", "fb1491255852808537"]},
            {"id": 2, "contato_id": 1, "criado_em": "2026-09-01T11:00:00-03:00", "tags": []},
            {"id": 3, "contato_id": 2, "criado_em": "2026-09-02T09:00:00-03:00", "tags": ["fb1761044191698247"]},
            {"id": 4, "contato_id": 3, "criado_em": "2026-09-02T09:30:00-03:00", "tags": ["qualificado"]},
            {"id": 5, "contato_id": 4, "criado_em": "2026-09-03T09:30:00-03:00", "tags": []},
            {"id": 6, "contato_id": None, "criado_em": "2026-09-03T12:00:00-03:00", "tags": []},
        ]

    def test_formulario_pela_tag(self):
        self.assertTrue(etl.lead_do_formulario({"tags": ["metaform"]}))
        self.assertTrue(etl.lead_do_formulario({"tags": ["fb1635069614265370"]}))
        self.assertFalse(etl.lead_do_formulario({"tags": ["fbx", "Tabela Enviada"]}))
        self.assertFalse(etl.lead_do_formulario({}))

    def test_contagens_batem_com_o_total(self):
        r = etl.aggregate_regiao(self.leads, self.contatos)
        self.assertTrue(r["canais"])
        soma = sum(d["form"] + d["direto"] for d in r["daily"])
        self.assertEqual(soma, len(self.leads))
        por = {(d["dia"], d["ddd"]): (d["form"], d["direto"]) for d in r["daily"]}
        self.assertEqual(por[("2026-09-01", "19")], (1, 1))
        self.assertEqual(por[("2026-09-02", "21")], (1, 0))
        self.assertEqual(por[("2026-09-02", "71")], (0, 1))
        self.assertEqual(por[("2026-09-03", "")], (0, 2))   # exterior + sem contato
        self.assertEqual(r["ufs"]["BA"], {"nome": "Bahia", "regiao": "Nordeste"})
        self.assertEqual(r["cobertura"], {"total": 6, "com_ddd": 4, "sem_telefone": 1,
                                          "exterior": 1, "invalido": 0})

    def test_sem_dado_pessoal(self):
        texto = json.dumps(etl.aggregate_regiao(self.leads, self.contatos), ensure_ascii=False)
        for proibido in ("Fulana", "Beltrano", "998765432", "a@x.com"):
            self.assertNotIn(proibido, texto)

    def test_coleta_antiga_sem_tags(self):
        antigos = [{k: v for k, v in lead.items() if k != "tags"} for lead in self.leads]
        r = etl.aggregate_regiao(antigos, self.contatos)
        self.assertFalse(r["canais"])
        self.assertEqual(sum(d["form"] for d in r["daily"]), 0)


if __name__ == "__main__":
    unittest.main()
