"use strict";
/**
 * Cria uma conta de demonstração com carteira cheia, para você mostrar o
 * sistema funcionando sem ter que cadastrar tudo na mão.
 *
 *   node semear.js
 *
 * Entra com:  demo@farol.app  /  demonstracao123
 *
 * Rode isto num banco de teste, nunca em produção com clientes reais.
 */

const dados = require("./src/dados");
const auth = require("./src/auth");
const crypto = require("node:crypto");

const EMAIL = "demo@farol.app";
const SENHA = "demonstracao123";

const iso = (diasAtras) => new Date(Date.now() - diasAtras * 864e5).toISOString();
const comp = (mesesAtras) => {
  // O dia 1 antes de voltar meses: em dia 31, setMonth pula para o mês
  // seguinte quando o mês de destino tem 30 dias, e duplica a competência.
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - mesesAtras);
  return { c: d.toISOString().slice(0, 7), r: ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][d.getMonth()] };
};

async function principal() {

const antiga = await dados.contaPorEmail(EMAIL);
if (antiga) {
  console.log("já existe uma conta de demonstração — apague-a antes de semear de novo.");
  console.log("  e-mail:", EMAIL, "\n  senha :", SENHA);
  return;
}

const conta = await auth.criarConta({ agencia: "Agência Demonstração", email: EMAIL, senha: SENHA, plano: "agencia" });
await dados.atualizarConta(conta.id, { status: "ativa" });

const CLIENTES = [
  { nome:"Sabor da Praça",    ramo:"Lanchonete", seg:4820, plano:"Social 3x/semana", val:1200, met:["pedidos","pedido"],
    pubs:[["Corte do X-Tudo em câmera lenta","https://www.instagram.com/reel/DxK92mQsAbC/","Instagram","Reels",3,19,31400,28900,3036,412,143],
          ["Preço do combo em 3 segundos",null,"Instagram","Reels",6,12,24800,22600,2305,361,187],
          ["Cardápio completo em 8 fotos",null,"Instagram","Carrossel",9,15,4100,0,296,64,31],
          ["Bastidor: chapa às 18h",null,"Instagram","Reels",12,19,18600,16900,1658,203,76],
          ["Foto do balcão novo",null,"Instagram","Foto",15,11,3200,0,221,22,12],
          ["Montagem do lanche em 15s","https://www.tiktok.com/@sabordapraca/video/7412998801234567890","TikTok","Reels",18,20,41200,38700,4771,508,88],
          ["Antes e depois da reforma",null,"Instagram","Carrossel",22,14,5300,0,424,88,22],
          ["Cliente reagindo ao molho",null,"Instagram","Reels",26,18,22100,20400,2084,288,104],
          ["Enquete: qual combo volta?",null,"Instagram","Stories",31,13,2900,2700,0,0,214],
          ["Tour pelo delivery",null,"Instagram","Reels",35,19,16800,15100,1356,171,69],
          ["Cinco motivos para pedir hoje",null,"Instagram","Carrossel",41,16,3900,0,232,41,18],
          ["Desafio do lanche duplo",null,"Instagram","Reels",48,20,27600,25300,2574,334,118],
          ["Equipe da manhã",null,"Instagram","Foto",55,10,2600,0,171,14,7]],
    hist:[[5,8,3,96000,412],[4,12,6,158000,587],[3,13,7,171000,634],[2,7,2,78000,388],[1,11,6,149000,561],[0,13,7,204000,690]] },

  { nome:"Pet Aconchego",     ramo:"Pet shop",   seg:2140, plano:"Social 2x/semana", val:890, met:["atendimentos","atendimento"],
    pubs:[["7 sinais de que seu cão está com dor","https://www.instagram.com/p/DwR41pLtZqX/","Instagram","Carrossel",4,9,9800,0,1820,948,64],
          ["Banho e tosa acelerado",null,"Instagram","Reels",8,17,6100,5400,492,88,19],
          ["Como escolher a ração certa",null,"Instagram","Carrossel",13,10,8400,0,1485,772,57],
          ["Cliente da semana: a Nina",null,"Instagram","Foto",19,15,3100,0,375,41,8],
          ["Transformação do poodle",null,"Instagram","Reels",24,18,7300,6600,694,126,24],
          ["Vacinas por idade do filhote",null,"Instagram","Carrossel",30,9,7900,0,1308,684,49],
          ["Promoção de banho relâmpago",null,"Instagram","Stories",38,12,1900,1800,0,0,97],
          ["Mitos sobre castração",null,"Instagram","Carrossel",46,11,6800,0,1143,596,41]],
    hist:[[5,6,1,22000,96],[4,8,2,31000,118],[3,7,1,26000,104],[2,9,2,38000,141],[1,8,2,34000,132],[0,8,2,36000,138]] },

  { nome:"Studio Belle",      ramo:"Estética",   seg:7630, plano:"Social + tráfego", val:2400, met:["agendamentos","agendamento"],
    pubs:[["Resultado de 3 sessões","https://www.instagram.com/reel/DyB07nWsKmT/","Instagram","Reels",2,20,38200,35100,3704,498,241],
          ["Tabela de preços atualizada",null,"Instagram","Carrossel",5,19,11400,0,1184,412,198],
          ["Cliente contando o antes",null,"Instagram","Reels",9,21,29800,27200,2701,361,172],
          ["Sala nova do studio",null,"Instagram","Foto",14,16,6200,0,509,64,34],
          ["Mitos sobre o procedimento",null,"Instagram","Reels",20,14,18400,16800,1605,246,96],
          ["Rotina de cuidados em casa",null,"Instagram","Reels",27,20,31600,29400,3263,594,214],
          ["Perguntas frequentes",null,"Instagram","Carrossel",34,18,9800,0,930,298,118],
          ["Depoimento em vídeo",null,"Instagram","Reels",43,21,34100,31800,3404,471,226],
          ["Agenda da semana aberta",null,"Instagram","Stories",52,13,5400,5100,0,0,341]],
    hist:[[5,9,5,168000,84],[4,10,6,198000,97],[3,8,4,152000,79],[2,11,7,236000,118],[1,9,5,189000,92],[0,9,6,221000,109]] },

  { nome:"Villa Nova Odonto", ramo:"Clínica",    seg:1580, plano:"Social 2x/semana", val:950, met:["consultas","consulta"],
    pubs:[["Equipe da clínica",null,"Instagram","Foto",11,10,1400,0,78,8,3],
          ["Como funciona o clareamento",null,"Instagram","Carrossel",23,11,2600,0,365,184,19],
          ["Horário de atendimento",null,"Instagram","Foto",39,14,1100,0,57,6,4],
          ["Tour pelo consultório",null,"Instagram","Reels",51,19,5900,5300,539,76,28]],
    hist:[[5,5,1,18000,22],[4,4,1,14000,19],[3,3,0,9000,14],[2,4,1,12000,16],[1,3,1,8000,12],[0,4,1,17000,21]] }
];

for (const c of CLIENTES) {
  const cid = auth.id("cl_");
  await dados.inserirCliente({
    id: cid, conta_id: conta.id, nome: c.nome, ramo: c.ramo, seguidores: c.seg,
    plano_txt: c.plano, contrato: c.val, metrica: c.met[0], metrica_s: c.met[1],
    token_rel: crypto.randomBytes(16).toString("base64url"), criado_em: auth.agora()
  });

  for (const [t, u, plat, fmt, d, h, alc, vis, inter, sal, cli] of c.pubs)
    await dados.inserirPublicacao({
      id: auth.id("pb_"), cliente_id: cid, titulo: t, url: u, plataforma: plat, formato: fmt,
      publicada: iso(d), hora: h, alcance: alc, views: vis, interacoes: inter,
      salvos: sal, cliques: cli, auto: false, criada_em: auth.agora()
    });

  for (const [mAtras, posts, reels, alc, res] of c.hist) {
    const m = comp(mAtras);
    await dados.salvarResultado({
      id: auth.id("rs_"), cliente_id: cid, competencia: m.c, rotulo: m.r,
      posts, reels, alcance: alc, resultado: res, criado_em: auth.agora()
    });
  }
  console.log("cliente criado:", c.nome, "—", c.pubs.length, "publicações,", c.hist.length, "meses");
}

console.log("\nConta de demonstração pronta.");
console.log("  e-mail:", EMAIL);
console.log("  senha :", SENHA);

}

principal().catch((e) => { console.error("falhou:", e.message); process.exit(1); });
