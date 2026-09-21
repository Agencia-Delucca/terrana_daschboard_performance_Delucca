"""DDD brasileiro → estado, cidade-polo e região do país.

O Kommo da Terrana não tem campo de cidade nem de estado, então a origem
geográfica do lead sai do DDD do telefone do contato. Cada um dos 67 DDDs
pertence a um único estado (Anatel), por isso o estado é exato. A cidade é
aproximada: "polo" é a cidade principal da área do DDD e "area" descreve a
área inteira — o painel rotula assim, nunca como cidade exata do lead.
"""
import re

# DDD: (UF, cidade-polo, área do DDD)
DDD = {
    "11": ("SP", "São Paulo", "São Paulo e Grande SP"),
    "12": ("SP", "S. José dos Campos", "S. José dos Campos, Vale do Paraíba e Litoral Norte"),
    "13": ("SP", "Santos", "Santos, Baixada Santista e Vale do Ribeira"),
    "14": ("SP", "Bauru", "Bauru, Marília, Jaú e Botucatu"),
    "15": ("SP", "Sorocaba", "Sorocaba, Itapetininga e região"),
    "16": ("SP", "Ribeirão Preto", "Ribeirão Preto, Franca, São Carlos e Araraquara"),
    "17": ("SP", "S. J. do Rio Preto", "São José do Rio Preto, Barretos e região"),
    "18": ("SP", "Pres. Prudente", "Presidente Prudente, Araçatuba e Assis"),
    "19": ("SP", "Campinas", "Campinas, Piracicaba, Limeira e região"),
    "21": ("RJ", "Rio de Janeiro", "Rio de Janeiro e Grande Rio"),
    "22": ("RJ", "Campos dos Goytacazes", "Campos, Macaé, Região dos Lagos e Nova Friburgo"),
    "24": ("RJ", "Petrópolis", "Petrópolis, Volta Redonda e Sul Fluminense"),
    "27": ("ES", "Vitória", "Vitória e Grande Vitória"),
    "28": ("ES", "Cachoeiro de Itapemirim", "Cachoeiro de Itapemirim e Sul do ES"),
    "31": ("MG", "Belo Horizonte", "Belo Horizonte e região"),
    "32": ("MG", "Juiz de Fora", "Juiz de Fora e Zona da Mata"),
    "33": ("MG", "Gov. Valadares", "Governador Valadares, Teófilo Otoni e Leste de MG"),
    "34": ("MG", "Uberlândia", "Uberlândia, Uberaba e Triângulo Mineiro"),
    "35": ("MG", "Sul de Minas", "Pouso Alegre, Varginha, Poços de Caldas e Sul de Minas"),
    "37": ("MG", "Divinópolis", "Divinópolis e Centro-Oeste de MG"),
    "38": ("MG", "Montes Claros", "Montes Claros e Norte de MG"),
    "41": ("PR", "Curitiba", "Curitiba e região"),
    "42": ("PR", "Ponta Grossa", "Ponta Grossa, Guarapuava e Campos Gerais"),
    "43": ("PR", "Londrina", "Londrina e Norte do PR"),
    "44": ("PR", "Maringá", "Maringá e Noroeste do PR"),
    "45": ("PR", "Cascavel", "Cascavel, Foz do Iguaçu e Oeste do PR"),
    "46": ("PR", "Pato Branco", "Pato Branco, Francisco Beltrão e Sudoeste do PR"),
    "47": ("SC", "Joinville", "Joinville, Blumenau, Itajaí e Norte de SC"),
    "48": ("SC", "Florianópolis", "Florianópolis, Criciúma e Sul de SC"),
    "49": ("SC", "Chapecó", "Chapecó, Lages e Oeste de SC"),
    "51": ("RS", "Porto Alegre", "Porto Alegre e região"),
    "53": ("RS", "Pelotas", "Pelotas, Rio Grande e Sul do RS"),
    "54": ("RS", "Caxias do Sul", "Caxias do Sul, Passo Fundo e Serra Gaúcha"),
    "55": ("RS", "Santa Maria", "Santa Maria, Uruguaiana e Oeste do RS"),
    "61": ("DF", "Brasília", "Brasília e Entorno"),
    "62": ("GO", "Goiânia", "Goiânia, Anápolis e região"),
    "63": ("TO", "Palmas", "Palmas e Tocantins"),
    "64": ("GO", "Rio Verde", "Rio Verde, Itumbiara e Sul de GO"),
    "65": ("MT", "Cuiabá", "Cuiabá e região"),
    "66": ("MT", "Rondonópolis", "Rondonópolis, Sinop e interior do MT"),
    "67": ("MS", "Campo Grande", "Campo Grande e Mato Grosso do Sul"),
    "68": ("AC", "Rio Branco", "Rio Branco e Acre"),
    "69": ("RO", "Porto Velho", "Porto Velho e Rondônia"),
    "71": ("BA", "Salvador", "Salvador e região"),
    "73": ("BA", "Ilhéus", "Ilhéus, Itabuna e Sul da BA"),
    "74": ("BA", "Juazeiro", "Juazeiro e Norte da BA"),
    "75": ("BA", "Feira de Santana", "Feira de Santana e Recôncavo"),
    "77": ("BA", "Vitória da Conquista", "Vitória da Conquista, Barreiras e Oeste da BA"),
    "79": ("SE", "Aracaju", "Aracaju e Sergipe"),
    "81": ("PE", "Recife", "Recife, Caruaru e região"),
    "82": ("AL", "Maceió", "Maceió e Alagoas"),
    "83": ("PB", "João Pessoa", "João Pessoa, Campina Grande e Paraíba"),
    "84": ("RN", "Natal", "Natal e Rio Grande do Norte"),
    "85": ("CE", "Fortaleza", "Fortaleza e região"),
    "86": ("PI", "Teresina", "Teresina e Norte do PI"),
    "87": ("PE", "Petrolina", "Petrolina, Garanhuns e Sertão de PE"),
    "88": ("CE", "Juazeiro do Norte", "Juazeiro do Norte, Sobral e interior do CE"),
    "89": ("PI", "Picos", "Picos, Floriano e Sul do PI"),
    "91": ("PA", "Belém", "Belém e região"),
    "92": ("AM", "Manaus", "Manaus e região"),
    "93": ("PA", "Santarém", "Santarém e Oeste do PA"),
    "94": ("PA", "Marabá", "Marabá e Sudeste do PA"),
    "95": ("RR", "Boa Vista", "Boa Vista e Roraima"),
    "96": ("AP", "Macapá", "Macapá e Amapá"),
    "97": ("AM", "Interior do AM", "Interior do Amazonas"),
    "98": ("MA", "São Luís", "São Luís e Norte do MA"),
    "99": ("MA", "Imperatriz", "Imperatriz e Sul do MA"),
}

NOME_UF = {
    "AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas",
    "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal",
    "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão",
    "MT": "Mato Grosso", "MS": "Mato Grosso do Sul", "MG": "Minas Gerais",
    "PA": "Pará", "PB": "Paraíba", "PR": "Paraná", "PE": "Pernambuco",
    "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte",
    "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima",
    "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe",
    "TO": "Tocantins",
}

REGIAO_UF = {uf: regiao for regiao, ufs in {
    "Sudeste": ("SP", "RJ", "MG", "ES"),
    "Sul": ("PR", "SC", "RS"),
    "Centro-Oeste": ("DF", "GO", "MT", "MS"),
    "Nordeste": ("BA", "SE", "AL", "PE", "PB", "RN", "CE", "PI", "MA"),
    "Norte": ("AM", "PA", "AC", "RO", "RR", "AP", "TO"),
}.items() for uf in ufs}


def ddd_do_telefone(telefone):
    """'+55 (19) 99999-0000' → '19'. None quando não é número brasileiro.

    Aceita com ou sem o 55 do país e com o 0 de longa distância. Número de
    11 dígitos só vale se for celular (terceiro dígito 9) — assim um número
    dos EUA como 1 305 555 1234 não vira DDD 13.
    """
    d = re.sub(r"\D", "", telefone or "")
    if d.startswith("550") and len(d) in (13, 14):
        d = d[3:]
    elif d.startswith("55") and len(d) in (12, 13):
        d = d[2:]
    elif d.startswith("0") and len(d) in (11, 12):
        d = d[1:]
    if len(d) == 11 and d[2] != "9":
        return None
    if len(d) in (10, 11) and d[:2] in DDD:
        return d[:2]
    return None


def localizar(telefone):
    """{tipo: br | exterior | invalido | sem_telefone} + ddd/uf/polo/area."""
    d = re.sub(r"\D", "", telefone or "")
    if not d:
        return {"tipo": "sem_telefone"}
    ddd = ddd_do_telefone(d)
    if ddd:
        uf, polo, area = DDD[ddd]
        return {"tipo": "br", "ddd": ddd, "uf": uf, "polo": polo, "area": area}
    if not d.startswith("55") and len(d) >= 11:
        return {"tipo": "exterior"}
    return {"tipo": "invalido"}
