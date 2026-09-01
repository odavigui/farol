"use strict";
/**
 * Repositório — Supabase (produção, roda na Vercel).
 *
 * Fala com o Supabase pela API REST (PostgREST), usando só `fetch`. Nenhuma
 * biblioteca instalada. Isso importa na Vercel: função serverless com zero
 * dependências sobe rápido e não quebra por atualização de pacote.
 *
 * Usa a SERVICE ROLE KEY, que ignora Row Level Security. Ela só pode existir
 * no servidor — se aparecer no navegador, qualquer pessoa lê o banco inteiro.
 * Por isso a variável não tem prefixo NEXT_PUBLIC_ nem nada parecido.
 *
 * A separação entre agências é feita em src/api.js, que filtra por conta_id
 * em toda consulta. O RLS ligado sem policy é a segunda camada.
 */

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const CHAVE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!URL_BASE || !CHAVE) {
  console.warn("[dados] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes.");
}

const REST = URL_BASE + "/rest/v1/";

async function chamar(caminho, opcoes = {}) {
  const r = await fetch(REST + caminho, {
    ...opcoes,
    headers: {
      apikey: CHAVE,
      authorization: "Bearer " + CHAVE,
      "content-type": "application/json",
      ...(opcoes.headers || {})
    }
  });
  const texto = await r.text();
  let corpo = null;
  if (texto) { try { corpo = JSON.parse(texto); } catch { corpo = texto; } }
  if (!r.ok) {
    const e = new Error(
      "Supabase " + r.status + ": " + (corpo?.message || corpo?.hint || texto || "erro")
    );
    e.status = 500;
    e.supabase = corpo;
    throw e;
  }
  return corpo;
}

const um = (linhas) => (Array.isArray(linhas) && linhas.length ? linhas[0] : null);
const q = (v) => encodeURIComponent(v);

/* Postgres devolve timestamptz; o resto do código trabalha com string ISO. */
const iso = (v) => (v ? new Date(v).toISOString() : v);

function normalizarConta(c) {
  if (!c) return null;
  return { ...c, teste_ate: iso(c.teste_ate), criada_em: iso(c.criada_em) };
}
function normalizarPub(p) {
  return { ...p, publicada: iso(p.publicada), criada_em: iso(p.criada_em), auto: !!p.auto };
}

/* ============================ contas ============================ */
async function contaPorEmail(email) {
  return normalizarConta(um(await chamar(`contas?email=eq.${q(email)}&limit=1`)));
}
async function contaPorId(id) {
  return normalizarConta(um(await chamar(`contas?id=eq.${q(id)}&limit=1`)));
}
async function contaPorClientePag(clientePag) {
  return normalizarConta(um(await chamar(`contas?cliente_pag=eq.${q(clientePag)}&limit=1`)));
}
async function inserirConta(c) {
  await chamar("contas", { method: "POST", body: JSON.stringify(c) });
  return contaPorId(c.id);
}
async function atualizarConta(id, campos) {
  await chamar(`contas?id=eq.${q(id)}`, { method: "PATCH", body: JSON.stringify(campos) });
  return contaPorId(id);
}

/* ============================ sessões ============================ */
async function inserirSessao(s) {
  await chamar("sessoes", { method: "POST", body: JSON.stringify(s) });
}
async function sessaoPorToken(token) {
  const s = um(await chamar(`sessoes?token=eq.${q(token)}&limit=1`));
  return s ? { ...s, expira_em: iso(s.expira_em) } : null;
}
async function apagarSessao(token) {
  await chamar(`sessoes?token=eq.${q(token)}`, { method: "DELETE" });
}
async function limparSessoesVencidas() {
  await chamar(`sessoes?expira_em=lt.${q(new Date().toISOString())}`, { method: "DELETE" });
}

/* ======================= tentativas de login ======================= */
async function tentativaPorChave(chave) {
  const t = um(await chamar(`tentativas_login?chave=eq.${q(chave)}&limit=1`));
  return t ? { ...t, ate: iso(t.ate) } : null;
}
async function salvarTentativa(chave, contagem, ate) {
  await chamar("tentativas_login", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ chave, contagem, ate })
  });
}
async function apagarTentativa(chave) {
  await chamar(`tentativas_login?chave=eq.${q(chave)}`, { method: "DELETE" });
}

/* ============================ clientes ============================ */
async function clientesDaConta(contaId) {
  return (await chamar(
    `clientes?conta_id=eq.${q(contaId)}&arquivado=is.false&order=nome.asc`
  )) || [];
}
async function contarClientes(contaId) {
  // count=exact devolve o total no cabeçalho content-range; aqui a lista já
  // é pequena (dezenas), então contar direto é mais simples e igualmente rápido.
  return (await clientesDaConta(contaId)).length;
}
async function clienteDaConta(contaId, id) {
  return um(await chamar(
    `clientes?id=eq.${q(id)}&conta_id=eq.${q(contaId)}&arquivado=is.false&limit=1`
  ));
}
async function clientePorToken(token) {
  return um(await chamar(`clientes?token_rel=eq.${q(token)}&arquivado=is.false&limit=1`));
}
async function inserirCliente(c) {
  await chamar("clientes", { method: "POST", body: JSON.stringify(c) });
  return um(await chamar(`clientes?id=eq.${q(c.id)}&limit=1`));
}
async function arquivarCliente(id) {
  await chamar(`clientes?id=eq.${q(id)}`, {
    method: "PATCH", body: JSON.stringify({ arquivado: true })
  });
}

/* ========================== publicações ========================== */
async function publicacoes(clienteId, desdeISO, ateISO) {
  const linhas = await chamar(
    `publicacoes?cliente_id=eq.${q(clienteId)}` +
    `&publicada=gte.${q(desdeISO)}&publicada=lte.${q(ateISO)}&order=publicada.asc`
  );
  return (linhas || []).map(normalizarPub);
}
async function inserirPublicacao(p) {
  await chamar("publicacoes", { method: "POST", body: JSON.stringify(p) });
  return normalizarPub(um(await chamar(`publicacoes?id=eq.${q(p.id)}&limit=1`)));
}

/* =========================== resultados =========================== */
async function resultados(clienteId) {
  return (await chamar(
    `resultados?cliente_id=eq.${q(clienteId)}&order=competencia.asc`
  )) || [];
}
async function salvarResultado(r) {
  // on_conflict + merge-duplicates = o upsert do PostgREST, equivalente ao
  // ON CONFLICT DO UPDATE do Postgres. Sem isso, relançar o mesmo mês
  // estouraria a restrição de unicidade.
  await chamar("resultados?on_conflict=cliente_id,competencia", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(r)
  });
}

/* ============================ conexões ============================ */
async function conexao(clienteId) {
  const c = um(await chamar(`conexoes?cliente_id=eq.${q(clienteId)}&limit=1`));
  return c ? { ...c, expira_em: iso(c.expira_em), ligada_em: iso(c.ligada_em), ultima_sinc: iso(c.ultima_sinc) } : null;
}
async function salvarConexao(x) {
  await chamar("conexoes?on_conflict=cliente_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(x)
  });
}
async function apagarConexao(clienteId) {
  await chamar(`conexoes?cliente_id=eq.${q(clienteId)}`, { method: "DELETE" });
}

/* ======================== eventos de pagamento ======================== */
async function eventoExiste(id) {
  return !!um(await chamar(`eventos_pagamento?id=eq.${q(id)}&limit=1`));
}
async function registrarEvento(e) {
  await chamar("eventos_pagamento", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify(e)
  });
}

/* ====================== recuperação de senha ====================== */
async function criarRecuperacao(r) {
  await chamar("recuperacoes", { method: "POST", body: JSON.stringify(r) });
}
async function recuperacaoPorHash(hash) {
  const r = um(await chamar(`recuperacoes?hash=eq.${q(hash)}&limit=1`));
  return r ? { ...r, expira_em: iso(r.expira_em), usado_em: iso(r.usado_em) } : null;
}
async function marcarRecuperacaoUsada(id, quando) {
  await chamar(`recuperacoes?id=eq.${q(id)}`, { method: "PATCH", body: JSON.stringify({ usado_em: quando }) });
}
async function apagarRecuperacoesDaConta(contaId) {
  await chamar(`recuperacoes?conta_id=eq.${q(contaId)}`, { method: "DELETE" });
}
async function apagarSessoesDaConta(contaId) {
  await chamar(`sessoes?conta_id=eq.${q(contaId)}`, { method: "DELETE" });
}

/* ============================ diagnóstico ============================ */
async function testarConexao() {
  await chamar("contas?limit=1");
  return true;
}

module.exports = {
  nome: "supabase",
  contaPorEmail, contaPorId, contaPorClientePag, inserirConta, atualizarConta,
  inserirSessao, sessaoPorToken, apagarSessao, limparSessoesVencidas,
  tentativaPorChave, salvarTentativa, apagarTentativa,
  clientesDaConta, contarClientes, clienteDaConta, clientePorToken, inserirCliente, arquivarCliente,
  publicacoes, inserirPublicacao,
  resultados, salvarResultado,
  conexao, salvarConexao, apagarConexao,
  eventoExiste, registrarEvento,
  criarRecuperacao, recuperacaoPorHash, marcarRecuperacaoUsada,
  apagarRecuperacoesDaConta, apagarSessoesDaConta,
  testarConexao
};
