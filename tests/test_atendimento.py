"""Testes do atendimento dos leads (situação da conversa, tempos, tipo de
negócio) e da atribuição pela tag do formulário — sem rede.

    python -m unittest discover -s tests -t .
"""
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from scripts import generate_dashboard_data as etl

BRT = timezone(timedelta(hours=-3))
T0 = datetime(2026, 9, 10, 10, 0, tzinfo=BRT).timestamp()   # quinta, 10h
H = 3600


def iso(ts):
    return datetime.fromtimestamp(ts, BRT).isoformat()


def ev(lead_id, ts, do_lead, entidade="lead"):
    return {"type": "incoming_chat_message" if do_lead else "outgoing_chat_message",
            "entity_id": lead_id, "entity_type": entidade, "created_at": ts}


def lead(lead_id, criado, contato=None, tags=("metaform",), **extra):
    base = {"id": lead_id, "criado_em": iso(criado), "contato_id": contato,
            "tags": list(tags), "etapa": "Contato inicial", "responsavel": "Luciane",
            "ganho": False, "perdido": False}
    base.update(extra)
    return base


class Autoria(unittest.TestCase):
    def test_boas_vindas_do_robo_nao_conta_como_equipe(self):
        entradas, equipe = etl.classificar_conversa(
            T0, [(T0 + 2, False), (T0 + 600, True), (T0 + 2 * H, False)])
        self.assertEqual(entradas, [T0 + 600])
        self.assertEqual(equipe, [T0 + 2 * H])

    def test_agente_de_ia_so_dentro_da_janela(self):
        janela = [(T0, T0 + 3 * H)]
        msgs = [(T0 + 100, True), (T0 + 130, False), (T0 + 140, False), (T0 + 5 * H, True), (T0 + 5 * H + 20, False)]
        entradas, equipe = etl.classificar_conversa(T0, msgs, janela)
        # 130 s = IA (30 s depois do lead), 140 s = IA em cadeia; fora da janela vale equipe
        self.assertEqual(equipe, [T0 + 5 * H + 20])
        self.assertEqual(len(entradas), 2)


class Situacoes(unittest.TestCase):
    def setUp(self):
        self.agora = T0 + 10 * 24 * H
        self.contatos = {
            "1": {"nome": "Fulana", "telefone": "+5519998765432", "tipo_negocio": "distribuidor_ou_revenda"},
            "2": {"nome": "Beltrano", "telefone": "+5511987654321", "tipo_negocio": "sou_consumidor_final"},
        }
        self.leads = [
            lead(1, T0, 1),                                   # E: escreveu, ninguém respondeu
            lead(2, T0, 2),                                   # P: equipe respondeu, lead parou
            lead(3, T0),                                      # R: só a boas-vindas
            lead(4, T0, tags=()),                             # N: nenhuma mensagem
            lead(5, T0, ganho=True, etapa="Fechado - ganho"),  # F
            lead(6, self.agora - 30 * 24 * H * 7),            # fora da janela de eventos
        ]
        self.eventos = [
            ev(1, T0 + 1, False), ev(1, T0 + 300, True),
            ev(2, T0 + 1, False), ev(2, T0 + 200, True), ev(2, T0 + 2 * H, False),
            ev(2, T0 + 2 * H + 100, True), ev(2, T0 + 3 * H, False), ev(2, T0 + 3 * H + 600, False),
            ev(2, T0 + 30 * H, False),
            ev(3, T0 + 2, False),
            ev(99, T0, True, entidade="contact"),
        ]

    def rodar(self, **kw):
        return etl.aggregate_atendimento_leads(self.leads, self.eventos, self.contatos,
                                               agora=self.agora, **kw)

    def test_situacoes_e_tempos(self):
        r = self.rodar()
        col = {c: i for i, c in enumerate(r["colunas"])}
        linhas = {i + 1: l for i, l in enumerate(r["linhas"])}
        self.assertEqual(r["fora_da_janela"], 1)
        self.assertEqual([linhas[i][col["situacao"]] for i in range(1, 6)], ["E", "P", "R", "N", "F"])
        # lead 1: escreveu 5 min depois de entrar e ninguém respondeu
        self.assertIsNone(linhas[1][col["h_1o_contato_humano"]])
        self.assertEqual(linhas[1][col["janela_aberta"]], 0)
        # lead 2: 1ª resposta humana 2 h depois da 1ª msg do lead, e ele continuou
        self.assertAlmostEqual(linhas[2][col["h_1a_resposta_humana"]], round((2 * H - 200) / H, 2))
        self.assertEqual(linhas[2][col["continuou"]], 1)
        # depois da última msg do lead: 3 h e 3 h 10 (mesma tentativa) + 30 h (outra) = 2
        self.assertEqual(linhas[2][col["tentativas"]], 2)
        self.assertEqual(linhas[3][col["escreveu"]], 0)
        self.assertEqual(linhas[1][col["hora_chegada"]], 10)
        self.assertEqual(linhas[1][col["dia_semana_chegada"]], 3)

    def test_tipo_de_negocio_e_canal(self):
        r = self.rodar()
        col = {c: i for i, c in enumerate(r["colunas"])}
        nomes = [t["nome"] for t in r["tipos"]]
        self.assertEqual(nomes[r["linhas"][0][col["tipo"]]], "Distribuidor ou revenda")
        consumidor = next(t for t in r["tipos"] if t["nome"] == "Consumidor final")
        self.assertTrue(consumidor["fora_do_publico"])
        self.assertEqual(r["linhas"][3][col["canal"]], "d")   # sem tag = entrada direta
        self.assertEqual(r["linhas"][0][col["canal"]], "f")

    def test_sem_dado_pessoal_sem_login(self):
        r = self.rodar()
        self.assertFalse(r["lista_esperando"]["disponivel"])
        texto = json.dumps(r, ensure_ascii=False)
        for proibido in ("Fulana", "Beltrano", "998765432", "987654321"):
            self.assertNotIn(proibido, texto)

    def test_lista_nominal_so_com_login(self):
        with mock.patch.object(etl.config, "KOMMO_SUBDOMAIN", "conta"):
            r = self.rodar(expor_pessoais=True)
        itens = r["lista_esperando"]["itens"]
        self.assertEqual([i["nome"] for i in itens], ["Fulana"])   # só o lead esperando a equipe
        self.assertEqual(itens[0]["link"], "https://conta.kommo.com/leads/detail/1")
        self.assertFalse(itens[0]["janela_aberta"])
        self.assertTrue(itens[0]["nunca_respondido"])


class TipoDeNegocio(unittest.TestCase):
    def test_rotulos(self):
        self.assertEqual(etl.rotulo_tipo_negocio("mercado_ou_varejo_alimentar"), "Mercado ou varejo alimentar")
        self.assertEqual(etl.rotulo_tipo_negocio(""), "Não informado")
        self.assertEqual(etl.rotulo_tipo_negocio("<test lead: dummy data for x>"), "Lead de teste (Meta)")
        self.assertEqual(etl.rotulo_tipo_negocio("loja_de_suplementos"), "Loja de suplementos")


class AtribuicaoPelaTag(unittest.TestCase):
    def test_tag_do_formulario_vira_meta_e_casa_com_a_campanha_do_dia(self):
        leads = [lead(1, T0), lead(2, T0, tags=())]
        linhas_meta = [{"data": "2026-09-10", "campanha": "AD - Formulário Nativo - Leads - B2B", "gasto": 30.0}]
        etl.resolver_fontes(leads, linhas_meta)
        self.assertEqual(leads[0]["_fonte"], "meta")
        self.assertIsNone(leads[1]["_fonte"])
        self.assertEqual(etl.origem_efetiva(leads[0]), "meta (formulário · tag do Kommo)")
        daily, _, stats = etl.match_leads_meta(leads, linhas_meta)
        self.assertEqual(stats["via_tag"], 1)
        self.assertEqual(daily["AD - Formulário Nativo - Leads - B2B"]["2026-09-10"], 1)

    def test_duas_campanhas_no_dia_nao_chuta(self):
        leads = [lead(1, T0)]
        linhas_meta = [{"data": "2026-09-10", "campanha": "AD - Formulário Nativo - Leads - B2B", "gasto": 30.0},
                       {"data": "2026-09-10", "campanha": "Geração de leads B2B - SP", "gasto": 10.0}]
        etl.resolver_fontes(leads, linhas_meta)
        _, _, stats = etl.match_leads_meta(leads, linhas_meta)
        self.assertEqual(stats["leads_pagos_meta"], 1)
        self.assertEqual(stats["via_tag"], 0)


if __name__ == "__main__":
    unittest.main()
