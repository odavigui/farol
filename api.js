"use strict";
/**
 * Rotas da API.
 *
 * Duas regras percorrem o arquivo inteiro:
 *
 * 1. TODA rota que toca um cliente passa por clienteDaConta(), que só devolve
 *    o registro se ele pertencer à conta logada. Sem isso, trocar o id na URL
 *    daria acesso aos dados de outra agência — a falha mais comum e mais
 *    grave em sistema multiempresa.
 * 2. Limite de plano e liberação de recurso são verificados AQUI, não no
 *    navegador. O front-end esconde o botão; quem impede é este arquivo.
 */

const crypto = require("node:crypto");
const dados = require("./dados");
const auth = require("./auth");
const planos = require("./planos");
const met = require("./metricas");
const email = require("./email");

const id = auth.id;
const agora = auth.agora;
const erro = auth.erro;

const txt = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const int = (v, min = 0, max = 1e9) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : min;
};
const desde = (dias) => new Date(Date.now() - dias * 864e5).toISOString();

/**
 * Faz a resposta demorar pelo menos `alvo` desde `comecou`.
 *
 * Serve contra descoberta de contas pelo relógio: se a rota responde rápido
 * quando o e-mail não existe e devagar quando existe, o tempo entrega o que a
 * mensagem se recusou a dizer. Não é blindagem — um envio muito lento ainda
 * passa do piso. Junto com o limite de 8 pedidos por IP a cada 15 minutos,
 * fecha o suficiente para não valer a pena.
 */
const PISO_ESQUECI = Number(process.env.PISO_ESQUECI_MS || 1200);
const piso = (comecou, alvo) => {
  const falta = alvo - (Date.now() - comecou);
  return falta > 0 ? new Promise((r) => setTimeout(r, falta)) : Promise.resolve();
};

/* ---------------- acesso ---------------- */
async function clienteDaConta(contaId, clienteId) {
  const c = await dados.clienteDaConta(contaId, clienteId);
  if (!c) throw erro(404, "Cliente não encontrado.");
  return c;
}
const publicacoes = (cid, deDias, ateDias = 0) =>
  dados.publicacoes(cid, desde(deDias), desde(ateDias));

/* ---------------- serialização ---------------- */
/**
 * O token do relatório público NÃO sai aqui.
 *
 * Ele saía em toda resposta de painel e de estado, para qualquer plano —
 * inclusive os que nem têm o recurso de acesso do cliente final. Um segredo
 * que circula sem necessidade acaba em cache de navegador, em proxy de
 * empresa e em print de tela. Quem quiser o link pede em
 * GET /api/clientes/:id/link-relatorio, que confere o plano antes.
 */
const clienteJson = (c) => ({
  id: c.id, nome: c.nome, ramo: c.ramo, seguidores: c.seguidores,
  planoTxt: c.plano_txt, contrato: c.contrato,
  metrica: c.metrica, metricaS: c.metrica_s
});
const pubJson = (p) => ({
  id: p.id, titulo: p.titulo, url: p.url, plataforma: p.plataforma, formato: p.formato,
  publicada: p.publicada, dias: met.diasAtras(p.publicada), hora: p.hora,
  alcance: p.alcance, views: p.views, interacoes: p.interacoes,
  salvos: p.salvos, cliques: p.cliques, auto: !!p.auto
});
const resJson = (r) => ({
  competencia: r.competencia, rotulo: r.rotulo, posts: r.posts,
  reels: r.reels, alcance: r.alcance, resultado: r.resultado
});
const contaJson = (c) => ({
  id: c.id, agencia: c.agencia, email: c.email, plano: c.plano,
  status: c.status, testeAte: c.teste_ate, criadaEm: c.criada_em
});
function resumoConexao(x) {
  if (!x) return { ligada: false };
  return { ligada: true, conta: x.conta_rede, ligadaEm: x.ligada_em, expiraEm: x.expira_em, ultimaSinc: x.ultima_sinc };
}

function exigirLogin(req) {
  if (!req.conta) throw erro(401, "Faça login para continuar.");
}

/* ================================================================
   ROTAS
   ================================================================ */
const rotas = {};

/* ---------- saúde ---------- */
/**
 * Diagnóstico da instalação. Aberta de propósito: só responde SIM ou NÃO
 * sobre cada configuração, nunca o valor de nenhuma. Sem esta rota, descobrir
 * por que o sistema não sobe vira adivinhação — foi exatamente o que
 * aconteceu na primeira publicação.
 */
rotas["GET /api/saude"] = async () => {
  const conf = (v) => (v ? "configurada" : "FALTANDO");
  const corpo = {
    ok: true,
    versao: "1.4",
    node: process.version,
    banco: {
      adaptador: dados.nome,
      SUPABASE_URL: conf(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: conf(process.env.SUPABASE_SERVICE_ROLE_KEY),
      responde: null
    },
    email: { modo: email.MODO, SMTP_USUARIO: conf(process.env.SMTP_USUARIO) },
    pagamento: {
      provedor: "Cakto",
      CAKTO_WEBHOOK_SECRET: conf(process.env.CAKTO_WEBHOOK_SECRET),
      ofertas: {
        essencial: conf(process.env.CAKTO_OFERTA_ESSENCIAL),
        agencia: conf(process.env.CAKTO_OFERTA_AGENCIA),
        estudio: conf(process.env.CAKTO_OFERTA_ESTUDIO)
      },
      webhook: "POST " + (process.env.URL_BASE || "https://SEUSITE") + "/api/pagamento/webhook"
    },
    site: { URL_BASE: conf(process.env.URL_BASE), NODE_ENV: process.env.NODE_ENV || "(vazio)" }
  };

  try {
    await dados.testarConexao();
    corpo.banco.responde = "sim";

    // Banco que responde não quer dizer esquema completo. O caso real: o
    // esquema tinha sido rodado antes de `assinaturas` existir, `contas`
    // estava lá, esta rota dizia "tudo certo" — e cadastrar conta devolvia
    // "Erro interno.". Agora a tabela que falta aparece pelo nome.
    if (typeof dados.tabelasFaltando === "function") {
      const faltam = await dados.tabelasFaltando();
      corpo.banco.tabelasFaltando = faltam.length ? faltam : "nenhuma";
      if (faltam.length) {
        corpo.ok = false;
        corpo.banco.comoResolver =
          "Rode o arquivo banco/esquema.sql inteiro no SQL Editor do Supabase. " +
          "Ele usa CREATE TABLE IF NOT EXISTS, então rodar de novo não apaga nada.";
      }
    }
  } catch (e) {
    corpo.ok = false;
    corpo.banco.responde = "não";
    // A rota é anônima de propósito (serve para diagnosticar sem conseguir
    // entrar). Por isso NÃO devolve a mensagem do Postgres: ela traz nome de
    // tabela, texto de RLS e dica de schema. Fica no log do servidor, onde só
    // você lê.
    console.error("[saude] banco:", e);
    corpo.banco.motivo = "falha ao consultar o banco — veja o log do servidor";
  }

  if (corpo.banco.SUPABASE_URL === "FALTANDO") corpo.ok = false;
  const faltamTabelas = Array.isArray(corpo.banco.tabelasFaltando)
    && corpo.banco.tabelasFaltando.length > 0;
  corpo.resumo = corpo.ok
    ? "Tudo certo. O sistema deve entrar normalmente."
    : faltamTabelas
      ? "O banco responde, mas o esquema está incompleto: falta a tabela " +
        corpo.banco.tabelasFaltando.join(", ") + ". Rode banco/esquema.sql no " +
        "SQL Editor do Supabase — ele usa CREATE TABLE IF NOT EXISTS e não apaga " +
        "nada do que já existe. Sem `assinaturas`, um pagamento aprovado não vira " +
        "plano; sem `recuperacoes`, o link de esqueci minha senha não funciona."
      : "Falta configuração. Veja o que está FALTANDO acima, cadastre na Vercel em Settings → Environment Variables e clique em Redeploy.";
  return { corpo };
};

/* ---------- conta ---------- */
rotas["POST /api/conta/criar"] = async (req) => {
  const b = req.body || {};
  const conta = await auth.criarConta({
    agencia: b.agencia, email: b.email, senha: b.senha,
    plano: planos.PLANOS[b.plano] ? b.plano : planos.PADRAO,
    ip: req.ip
  });
  return { corpo: { conta: contaJson(conta) }, sessao: await auth.abrirSessao(conta.id, req.ip) };
};

rotas["POST /api/conta/entrar"] = async (req) => {
  const b = req.body || {};
  const conta = await auth.autenticar({ email: b.email, senha: b.senha, ip: req.ip });
  return { corpo: { conta: contaJson(conta) }, sessao: await auth.abrirSessao(conta.id, req.ip) };
};

/**
 * Esqueci a senha.
 *
 * A resposta é SEMPRE a mesma, exista o e-mail ou não. Se dissesse
 * "não encontramos essa conta", a tela viraria um jeito de descobrir quais
 * e-mails são clientes seus — é a mesma regra do login.
 *
 * O envio também não pode derrubar a resposta: se o Gmail estiver fora do ar,
 * quem pediu não tem nada com isso. O erro vai para o log, o navegador recebe
 * o mesmo ok.
 */
rotas["POST /api/conta/esqueci"] = async (req) => {
  const comecou = Date.now();
  const pedido = await auth.pedirRecuperacao({ email: req.body?.email, ip: req.ip });

  if (pedido) {
    const link = `${req.base}/app?t=${encodeURIComponent(pedido.token)}`;
    const msg = email.emailRecuperacao({
      agencia: pedido.conta.agencia, link, minutos: pedido.minutos
    });
    try {
      await email.enviar({ para: pedido.conta.email, ...msg });
    } catch (e) {
      console.error("[email] falha ao enviar recuperação:", e.message);
    }
  }

  // Texto igual não basta: sem conta a rota devolvia em 2 ms e com conta em
  // 900 ms, porque só uma das duas fala com o servidor de e-mail. Esse tempo
  // responde a mesma pergunta que a mensagem se recusa a responder. O piso
  // fixo cobre a diferença.
  await piso(comecou, PISO_ESQUECI);
  return { corpo: { ok: true, mensagem: "Se existir uma conta com esse e-mail, o link chega em instantes." } };
};

/** Redefinir com o token do e-mail. Não abre sessão de propósito: depois de
 *  trocar a senha, a pessoa entra com ela — e assim confirma que a decorou. */
rotas["POST /api/conta/redefinir"] = async (req) => {
  const conta = await auth.redefinirSenha({ token: req.body?.token, senha: req.body?.senha });
  return { corpo: { ok: true, email: conta.email }, limparSessao: true };
};

rotas["POST /api/conta/sair"] = async (req) => {
  await auth.fecharSessao(req.sessao);
  return { corpo: { ok: true }, limparSessao: true };
};

rotas["GET /api/conta"] = async (req) => {
  exigirLogin(req);
  const usados = await dados.contarClientes(req.conta.id);
  return { corpo: { conta: contaJson(req.conta), plano: planos.paraCliente(req.conta, usados) } };
};

/**
 * Trocar de plano — MOVIDO PARA A CAKTO, de propósito.
 *
 * Aqui existia POST /api/conta/plano, que gravava o plano novo direto. Bastava
 * clicar no cartão do Estúdio para uma conta de R$ 97 virar uma de R$ 397, para
 * sempre. Era o contrário de tudo que este sistema diz sobre quem decide o quê:
 * plano é consequência de pagamento, e pagamento só a Cakto confirma, pelo
 * webhook em pagamento.js.
 *
 * A rota foi removida em vez de corrigida. Uma rota que muda plano é um alvo
 * permanente; não existir é a única versão que não tem bug.
 *
 * A interface agora abre o checkout da Cakto. Quem já tem assinatura ativa não
 * ganha um segundo checkout — isso criaria uma SEGUNDA assinatura e a agência
 * seria cobrada duas vezes. Esse caso vai para o suporte.
 */
rotas["POST /api/conta/plano"] = async (req) => {
  exigirLogin(req);
  throw erro(410,
    "A troca de plano acontece no checkout da Cakto, não aqui. Abra Minha conta " +
    "e escolha o plano desejado.",
    { motivo: "rota_removida" });
};

/* ---------- estado inicial ---------- */
rotas["GET /api/estado"] = async (req) => {
  exigirLogin(req);
  const lista = await dados.clientesDaConta(req.conta.id);
  const dias = int(req.query.dias || 60, 7, 365);

  const clientes = [];
  for (const c of lista) {
    const h = await dados.resultados(c.id);
    clientes.push({
      ...clienteJson(c),
      conexao: resumoConexao(await dados.conexao(c.id)),
      ultimoResultado: h.length ? resJson(h[h.length - 1]) : null,
      resumo: await resumoCliente(c, dias, h)
    });
  }
  return {
    corpo: {
      conta: contaJson(req.conta),
      plano: planos.paraCliente(req.conta, lista.length),
      integracao: { instagram: integracaoLigada() },
      // Com assinatura ativa, um segundo checkout viraria segunda cobrança.
      // Quem decide isso é o servidor, que conhece o status de verdade.
      assinatura: { ativa: req.conta.status === "ativa" },
      clientes
    }
  };
};

/**
 * Resumo de carteira. Existe para a tela de carteira não precisar baixar as
 * publicações de todos os clientes — ela recebe só o que vai desenhar.
 */
async function resumoCliente(c, dias, h) {
  const atuais = await publicacoes(c.id, dias);
  const anteriores = await publicacoes(c.id, dias * 2, dias);
  const ag = met.agregar(atuais);
  const agAnt = met.agregar(anteriores);

  const semanas = 8;
  const serie = new Array(semanas).fill(0);
  for (const p of atuais) {
    const i = semanas - 1 - Math.floor(met.diasAtras(p.publicada) / (dias / semanas));
    if (i >= 0 && i < semanas) serie[i] += p.alcance;
  }

  const variacao = agAnt.alcance > 0 ? (ag.alcance - agAnt.alcance) / agAnt.alcance : null;
  const ultimaPub = atuais.length ? met.diasAtras(atuais[atuais.length - 1].publicada) : 999;
  const semResultado = !h.length || !h[h.length - 1].resultado;

  let alerta = "ok";
  if ((variacao !== null && variacao <= -0.15) || ultimaPub > 21) alerta = "cr";
  else if (semResultado || (anteriores.length && atuais.length < anteriores.length * 0.75)) alerta = "wa";

  return {
    alcance: ag.alcance, posts: ag.posts, interacoes: ag.interacoes,
    variacao, serie, alerta, diasSemPublicar: ultimaPub === 999 ? null : ultimaPub
  };
}

/* ---------- clientes ---------- */
rotas["POST /api/clientes"] = async (req) => {
  exigirLogin(req);
  const usados = await dados.contarClientes(req.conta.id);
  planos.exigirVaga(req.conta, usados);          // <<< o limite vive aqui

  const b = req.body || {};
  const nome = txt(b.nome, 120);
  if (!nome) throw erro(400, "Informe o nome do cliente.");

  const c = await dados.inserirCliente({
    id: id("cl_"), conta_id: req.conta.id, nome,
    ramo: txt(b.ramo, 60), seguidores: int(b.seguidores, 0, 1e8),
    plano_txt: txt(b.planoTxt, 80), contrato: int(b.contrato, 0, 1e6),
    metrica: txt(b.metrica, 30) || "resultados",
    metrica_s: txt(b.metricaS, 30) || "resultado",
    token_rel: crypto.randomBytes(16).toString("base64url"),
    criado_em: agora()
  });
  return { corpo: { cliente: clienteJson(c), plano: planos.paraCliente(req.conta, usados + 1) } };
};

rotas["DELETE /api/clientes/:id"] = async (req) => {
  exigirLogin(req);
  const c = await clienteDaConta(req.conta.id, req.params.id);
  await dados.arquivarCliente(c.id);
  const usados = await dados.contarClientes(req.conta.id);
  return { corpo: { ok: true, plano: planos.paraCliente(req.conta, usados) } };
};

/* ---------- painel de um cliente ---------- */
rotas["GET /api/clientes/:id/painel"] = async (req) => {
  exigirLogin(req);
  const c = await clienteDaConta(req.conta.id, req.params.id);
  const dias = int(req.query.dias || 60, 7, 365);
  const atuais = await publicacoes(c.id, dias);
  const anteriores = await publicacoes(c.id, dias * 2, dias);
  const h = await dados.resultados(c.id);

  return {
    corpo: {
      cliente: clienteJson(c),
      periodo: dias,
      agora: met.agregar(atuais),
      antes: met.agregar(anteriores),
      publicacoes: atuais.map(pubJson).reverse(),
      historico: h.map(resJson),
      conexao: resumoConexao(await dados.conexao(c.id)),
      diagnostico: met.diagnosticar({ cliente: c, publicacoes: atuais, anteriores, historico: h, dias })
    }
  };
};

/* ---------- publicações ---------- */
rotas["POST /api/clientes/:id/publicacoes"] = async (req) => {
  exigirLogin(req);
  planos.exigirEscrita(req.conta);
  const c = await clienteDaConta(req.conta.id, req.params.id);
  const b = req.body || {};

  const link = met.lerLink(b.url);
  const formato = txt(b.formato, 20) || (link.ok ? link.formato : "Reels");
  const alcance = int(b.alcance, 0, 1e9);
  if (!alcance) throw erro(400, "O alcance é obrigatório — é a base de todo o diagnóstico.");

  const p = await dados.inserirPublicacao({
    id: id("pb_"), cliente_id: c.id,
    titulo: txt(b.titulo, 160) || `${formato} ${link.ok ? link.codigo.slice(0, 8) : ""}`.trim(),
    url: link.ok ? link.url : null,
    plataforma: link.ok ? link.plataforma : (txt(b.plataforma, 20) || "Instagram"),
    formato,
    publicada: desde(int(b.dias, 0, 3650)),
    hora: int(b.hora, 0, 23),
    alcance, views: int(b.views, 0, 1e9), interacoes: int(b.interacoes, 0, 1e9),
    salvos: int(b.salvos, 0, 1e9), cliques: int(b.cliques, 0, 1e9),
    auto: false, criada_em: agora()
  });
  return { corpo: { publicacao: pubJson(p) } };
};

rotas["POST /api/link"] = async (req) => {
  exigirLogin(req);
  return { corpo: met.lerLink(req.body?.url) };
};

/* ---------- resultado comercial ---------- */
rotas["POST /api/clientes/:id/resultados"] = async (req) => {
  exigirLogin(req);
  planos.exigirEscrita(req.conta);
  const c = await clienteDaConta(req.conta.id, req.params.id);
  const b = req.body || {};
  const rotulo = txt(b.rotulo, 12);
  if (!rotulo) throw erro(400, "Diga de que mês é esse número.");
  const resultado = int(b.resultado, 0, 1e9);
  if (!resultado) throw erro(400, `Sem o número de ${c.metrica} o lançamento não serve para nada.`);

  const alcanceMes = met.agregar(await publicacoes(c.id, 31)).alcance || resultado * 260;

  await dados.salvarResultado({
    id: id("rs_"), cliente_id: c.id,
    competencia: txt(b.competencia, 7) || new Date().toISOString().slice(0, 7),
    rotulo, posts: int(b.posts, 0, 1000), reels: int(b.reels, 0, 1000),
    alcance: alcanceMes, resultado, criado_em: agora()
  });
  return { corpo: { historico: (await dados.resultados(c.id)).map(resJson) } };
};

/* ---------- conexão com a rede ---------- */

/**
 * A integração com o Instagram está ligada?
 *
 * Enquanto a Meta não aprovar o app, ela NÃO está — e quem tem de saber disso
 * é o servidor, não a tela. Se a decisão morasse no navegador, bastaria mexer
 * no console para o sistema voltar a dizer "conectada" sem estar.
 *
 * Para ligar, um dia: basta existir META_APP_ID nas variáveis de ambiente.
 * Enquanto não existir, o botão fica desativado e este endpoint recusa.
 */
function integracaoLigada() {
  return !!process.env.META_APP_ID;
}

rotas["POST /api/clientes/:id/conexao"] = async (req) => {
  exigirLogin(req);
  planos.exigirEscrita(req.conta);
  const c = await clienteDaConta(req.conta.id, req.params.id);

  // Sem app aprovado na Meta não há conexão possível. Antes daqui existia um
  // atalho que gravava a conexão assim mesmo, com token nulo: a tela dizia
  // "conectada", nenhum número entrava, e a agência só descobriria na véspera
  // da reunião. Recusar é a resposta honesta.
  if (!integracaoLigada())
    throw Object.assign(erro(501,
      "A conexão automática com o Instagram ainda não está disponível — o app " +
      "está em aprovação na Meta. Enquanto isso, lance as publicações pelo " +
      "formulário: o diagnóstico funciona igual.",
      { motivo: "integracao_indisponivel" }), { publico: true });

  // Com o app aprovado, é aqui que o "code" do OAuth vira token de longa duração.
  await dados.salvarConexao({
    cliente_id: c.id, rede: "instagram",
    conta_rede: txt(req.body?.contaRede, 60) || c.nome.toLowerCase().replace(/[^a-z0-9]/g, ""),
    token: null,
    expira_em: new Date(Date.now() + 60 * 864e5).toISOString(),
    ligada_em: agora(), ultima_sinc: null
  });
  return { corpo: { conexao: resumoConexao(await dados.conexao(c.id)) } };
};

rotas["DELETE /api/clientes/:id/conexao"] = async (req) => {
  exigirLogin(req);
  const c = await clienteDaConta(req.conta.id, req.params.id);
  await dados.apagarConexao(c.id);
  return { corpo: { conexao: { ligada: false } } };
};

/* ---------- relatório do cliente final ---------- */
rotas["GET /api/clientes/:id/link-relatorio"] = async (req) => {
  exigirLogin(req);
  planos.exigirRecurso(req.conta, "clienteFinal");   // <<< recurso por plano
  const c = await clienteDaConta(req.conta.id, req.params.id);
  return { corpo: { caminho: "/r/" + c.token_rel } };
};

/** Público, por token — é o link que a agência manda ao cliente.
 *  Só devolve dados se o plano da agência incluir o acesso do cliente final. */
rotas["GET /api/relatorio/:token"] = async (req) => {
  const c = await dados.clientePorToken(req.params.token);
  if (!c) throw erro(404, "Relatório não encontrado.");
  const conta = await auth.buscarConta(c.conta_id);
  planos.exigirRecurso(conta, "clienteFinal");

  const dias = int(req.query.dias || 60, 7, 365);
  const atuais = await publicacoes(c.id, dias);
  const anteriores = await publicacoes(c.id, dias * 2, dias);
  const h = await dados.resultados(c.id);
  const destaques = met
    .diagnosticar({ cliente: c, publicacoes: atuais, anteriores, historico: h, dias })
    .filter((i) => i.tipo === "ok" || i.tipo === "ac")
    .slice(0, 3);

  return {
    corpo: {
      agencia: conta.agencia,
      marca: planos.planoEfetivo(conta).recursos.marcaPdf,
      cliente: { nome: c.nome, metrica: c.metrica, metricaS: c.metrica_s },
      periodo: dias,
      agora: met.agregar(atuais),
      antes: met.agregar(anteriores),
      melhores: atuais.map(pubJson).sort((a, b) => b.alcance - a.alcance).slice(0, 5),
      historico: h.map(resJson),
      destaques
    }
  };
};

module.exports = { rotas };
