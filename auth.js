"use strict";
/**
 * Autenticação.
 *
 * Regras que não se negociam, e o motivo de cada uma:
 *
 * 1. A senha nunca é guardada. Guardamos scrypt(senha, salt). Se o banco
 *    vazar, ninguém descobre a senha de ninguém.
 * 2. A comparação é em tempo constante (timingSafeEqual). Comparar com ===
 *    vaza informação pelo tempo de resposta.
 * 3. A sessão é um token aleatório de 32 bytes guardado no banco, entregue
 *    num cookie HttpOnly — JavaScript da página não lê, então um XSS não
 *    rouba a sessão.
 * 4. Login errado tem limite por e-mail e por IP. Sem isso, força bruta.
 * 5. A resposta de login errado é sempre a mesma, tenha o e-mail existido
 *    ou não. Mensagem diferente entrega quais e-mails têm conta.
 */

const crypto = require("node:crypto");
const dados = require("./dados");
const { DIAS_TESTE } = require("./planos");

const CUSTO = { N: 16384, r: 8, p: 1 };
const TAM_HASH = 64;
const DIAS_SESSAO = 14;
const MAX_TENTATIVAS = 8;
const JANELA_MIN = 15;
const MIN_RECUPERACAO = 60;   // quanto vale o link do e-mail

const agora = () => new Date().toISOString();
const maisDias = (d) => new Date(Date.now() + d * 864e5).toISOString();
const maisMin = (m) => new Date(Date.now() + m * 6e4).toISOString();
const id = (p) => p + crypto.randomBytes(9).toString("base64url");

function erro(status, msg, extra) {
  const e = new Error(msg);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  return {
    hash: crypto.scryptSync(senha, salt, TAM_HASH, CUSTO).toString("base64"),
    salt: salt.toString("base64")
  };
}

function conferirSenha(senha, hashB64, saltB64) {
  let guardado;
  try { guardado = Buffer.from(hashB64, "base64"); } catch { return false; }
  if (guardado.length !== TAM_HASH) return false;
  const calc = crypto.scryptSync(senha, Buffer.from(saltB64, "base64"), TAM_HASH, CUSTO);
  return crypto.timingSafeEqual(guardado, calc);
}

/* ---------- limite de tentativas ---------- */
async function bloqueado(chave) {
  const r = await dados.tentativaPorChave(chave);
  if (!r) return false;
  if (r.ate < agora()) { await dados.apagarTentativa(chave); return false; }
  return r.contagem >= MAX_TENTATIVAS;
}
async function registrarFalha(chave) {
  const r = await dados.tentativaPorChave(chave);
  await dados.salvarTentativa(chave, (r ? r.contagem : 0) + 1, maisMin(JANELA_MIN));
}

/* ---------- contas ---------- */
async function criarConta({ agencia, email, senha, plano }) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erro(400, "E-mail inválido.");
  if (String(senha || "").length < 8) throw erro(400, "A senha precisa ter ao menos 8 caracteres.");
  if (!String(agencia || "").trim()) throw erro(400, "Informe o nome da agência.");

  if (await dados.contaPorEmail(email)) throw erro(409, "Já existe uma conta com esse e-mail.");

  /* A agência PAGA antes de criar a conta. Se já houver
     pagamento aprovado para este e-mail, o plano vem de lá — e não do que veio
     no formulário, que qualquer pessoa poderia forjar. */
  const pago = await require("./pagamento").planoPago(email);

  const { hash, salt } = hashSenha(senha);
  const conta = await dados.inserirConta({
    id: id("ct_"),
    agencia: String(agencia).trim().slice(0, 120),
    email, senha_hash: hash, senha_salt: salt,
    plano: pago ? pago.plano : (plano || "essencial"),
    status: pago ? "ativa" : "teste",
    teste_ate: pago ? null : maisDias(DIAS_TESTE),
    assinatura_id: pago ? pago.assinatura_id || null : null,
    criada_em: agora()
  });
  return publica(conta);
}

async function autenticar({ email, senha, ip }) {
  email = String(email || "").trim().toLowerCase();
  const chaveEmail = "e:" + email;
  const chaveIp = "i:" + (ip || "?");
  if (await bloqueado(chaveEmail) || await bloqueado(chaveIp))
    throw erro(429, "Muitas tentativas. Tente de novo em 15 minutos.");

  const c = await dados.contaPorEmail(email);

  // Mesmo sem conta, gastamos o tempo de um scrypt. Sem isso, a diferença de
  // tempo entre "e-mail não existe" e "senha errada" entrega quem tem conta.
  const ok = c
    ? conferirSenha(senha, c.senha_hash, c.senha_salt)
    : (crypto.scryptSync(String(senha || ""), Buffer.alloc(16), TAM_HASH, CUSTO), false);

  if (!ok) {
    await registrarFalha(chaveEmail);
    await registrarFalha(chaveIp);
    throw erro(401, "E-mail ou senha incorretos.");
  }
  if (c.status === "cancelada") throw erro(403, "Esta conta está cancelada.");

  await dados.apagarTentativa(chaveEmail);
  await dados.apagarTentativa(chaveIp);
  return publica(c);
}

/** Nunca deixa hash e salt saírem daqui. */
function publica(c) {
  if (!c) return null;
  return {
    id: c.id, agencia: c.agencia, email: c.email, plano: c.plano,
    status: c.status, teste_ate: c.teste_ate, criada_em: c.criada_em
  };
}

async function buscarConta(cid) { return publica(await dados.contaPorId(cid)); }

/* ---------- sessões ---------- */
async function abrirSessao(contaId, ip) {
  const token = crypto.randomBytes(32).toString("base64url");
  await dados.inserirSessao({
    token, conta_id: contaId, criada_em: agora(), expira_em: maisDias(DIAS_SESSAO), ip: ip || null
  });
  return token;
}

async function contaDaSessao(token) {
  if (!token) return null;
  const s = await dados.sessaoPorToken(token);
  if (!s) return null;
  if (s.expira_em < agora()) { await dados.apagarSessao(token); return null; }
  return buscarConta(s.conta_id);
}

async function fecharSessao(token) { if (token) await dados.apagarSessao(token); }

/* ---------- recuperação de senha ---------- */
/**
 * O token vai por e-mail em texto puro, mas no banco guardamos só o SHA-256
 * dele. Se o banco vazar, os links que estiverem valendo naquele momento
 * continuam inúteis para quem leu a tabela — o mesmo raciocínio da senha.
 */
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * Cria o pedido e devolve o token — ou null quando não existe conta com esse
 * e-mail. Quem chama NÃO pode transformar esse null em mensagem diferente:
 * a resposta ao navegador é sempre a mesma, senão a tela vira um jeito de
 * descobrir quais e-mails têm conta aqui.
 */
async function pedirRecuperacao({ email, ip }) {
  email = String(email || "").trim().toLowerCase();

  // Limite também aqui. Sem ele, alguém dispara mil e-mails para a mesma
  // pessoa e ainda queima a cota diária do Gmail.
  const chave = "r:" + (ip || "?");
  if (await bloqueado(chave)) throw erro(429, "Muitos pedidos. Tente de novo em 15 minutos.");
  await registrarFalha(chave);

  const c = await dados.contaPorEmail(email);
  if (!c) return null;

  // Um pedido novo invalida os anteriores: dois links válidos ao mesmo tempo
  // só aumentam a janela de quem interceptar um e-mail antigo.
  await dados.apagarRecuperacoesDaConta(c.id);

  const token = crypto.randomBytes(32).toString("base64url");
  await dados.criarRecuperacao({
    id: id("rc_"),
    conta_id: c.id,
    hash: hashToken(token),
    expira_em: maisMin(MIN_RECUPERACAO),
    criado_em: agora(),
    ip: ip || null
  });
  return { token, conta: publica(c), minutos: MIN_RECUPERACAO };
}

/**
 * Troca a senha a partir do token. Erra igual em todos os casos ruins —
 * token inventado, vencido ou já usado devolvem a mesma frase, porque a
 * diferença entre eles não ajuda quem é dono da conta e ajuda quem não é.
 */
async function redefinirSenha({ token, senha }) {
  if (String(senha || "").length < 8) throw erro(400, "A senha precisa ter ao menos 8 caracteres.");
  const t = String(token || "");
  if (!t) throw erro(400, "Link inválido ou vencido. Peça um novo.");

  const r = await dados.recuperacaoPorHash(hashToken(t));
  if (!r || r.usado_em || r.expira_em < agora())
    throw erro(400, "Link inválido ou vencido. Peça um novo.");

  const c = await dados.contaPorId(r.conta_id);
  if (!c) throw erro(400, "Link inválido ou vencido. Peça um novo.");

  const { hash, salt } = hashSenha(senha);
  await dados.atualizarConta(c.id, { senha_hash: hash, senha_salt: salt });
  await dados.marcarRecuperacaoUsada(r.id, agora());

  // Se a senha foi trocada porque alguém invadiu, esse alguém pode estar com
  // uma sessão aberta. Derrubamos todas — inclusive a de quem está trocando.
  await dados.apagarSessoesDaConta(c.id);
  await dados.apagarRecuperacoesDaConta(c.id);

  return publica(c);
}

module.exports = {
  criarConta, autenticar, buscarConta,
  abrirSessao, contaDaSessao, fecharSessao,
  pedirRecuperacao, redefinirSenha,
  hashSenha, conferirSenha, erro, id, agora, publica
};
