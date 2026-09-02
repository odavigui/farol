"use strict";
/**
 * Repositório — SQLite (desenvolvimento local).
 *
 * Mesma interface do repo-supabase.js, para você programar e testar na sua
 * máquina sem internet e sem gastar cota do Supabase. Em produção a Vercel
 * usa o outro adaptador.
 *
 * Os métodos são assíncronos mesmo sendo síncronos por dentro, para que os
 * dois adaptadores tenham exatamente o mesmo contrato.
 */

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const PASTA = process.env.PASTA_DADOS || path.join(__dirname, "..", "dados");
try {
  fs.mkdirSync(PASTA, { recursive: true });
} catch (e) {
  // Disco somente leitura = servidor de produção. Aqui o SQLite não serve.
  if (e.code === "EROFS" || e.code === "EACCES") {
    throw new Error(
      "Este adaptador grava em disco e o disco aqui é somente leitura. " +
      "Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para usar o Supabase."
    );
  }
  throw e;
}

const db = new DatabaseSync(path.join(PASTA, "prova.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS contas (
  id TEXT PRIMARY KEY, agencia TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL, senha_salt TEXT NOT NULL,
  plano TEXT NOT NULL DEFAULT 'essencial', status TEXT NOT NULL DEFAULT 'teste',
  teste_ate TEXT, cliente_pag TEXT, assinatura_id TEXT, criada_em TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  conta_id TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  criada_em TEXT NOT NULL, expira_em TEXT NOT NULL, ip TEXT);
CREATE INDEX IF NOT EXISTS ix_sessoes_conta ON sessoes(conta_id);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  conta_id TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL, ramo TEXT NOT NULL DEFAULT '',
  seguidores INTEGER NOT NULL DEFAULT 0, plano_txt TEXT NOT NULL DEFAULT '',
  contrato INTEGER NOT NULL DEFAULT 0,
  metrica TEXT NOT NULL DEFAULT 'resultados', metrica_s TEXT NOT NULL DEFAULT 'resultado',
  token_rel TEXT NOT NULL UNIQUE, arquivado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_clientes_conta ON clientes(conta_id, arquivado);

CREATE TABLE IF NOT EXISTS publicacoes (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL, url TEXT, plataforma TEXT NOT NULL, formato TEXT NOT NULL,
  publicada TEXT NOT NULL, hora INTEGER NOT NULL DEFAULT 12,
  alcance INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0,
  interacoes INTEGER NOT NULL DEFAULT 0, salvos INTEGER NOT NULL DEFAULT 0,
  cliques INTEGER NOT NULL DEFAULT 0, auto INTEGER NOT NULL DEFAULT 0,
  criada_em TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_pub_cliente ON publicacoes(cliente_id, publicada);

CREATE TABLE IF NOT EXISTS resultados (
  id TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  competencia TEXT NOT NULL, rotulo TEXT NOT NULL,
  posts INTEGER NOT NULL DEFAULT 0, reels INTEGER NOT NULL DEFAULT 0,
  alcance INTEGER NOT NULL DEFAULT 0, resultado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL, UNIQUE(cliente_id, competencia));

CREATE TABLE IF NOT EXISTS conexoes (
  cliente_id TEXT PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  rede TEXT NOT NULL DEFAULT 'instagram', conta_rede TEXT, token TEXT,
  expira_em TEXT, ligada_em TEXT, ultima_sinc TEXT);

CREATE TABLE IF NOT EXISTS tentativas_login (
  chave TEXT PRIMARY KEY, contagem INTEGER NOT NULL DEFAULT 0, ate TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS recuperacoes (
  id TEXT PRIMARY KEY,
  conta_id TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE, expira_em TEXT NOT NULL, usado_em TEXT,
  criado_em TEXT NOT NULL, ip TEXT);
CREATE INDEX IF NOT EXISTS ix_rec_conta ON recuperacoes(conta_id);

CREATE TABLE IF NOT EXISTS assinaturas (
  email TEXT PRIMARY KEY, plano TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ativa',
  assinatura_id TEXT, pedido_id TEXT, atualizado_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS eventos_pagamento (
  id TEXT PRIMARY KEY, conta_id TEXT, tipo TEXT NOT NULL,
  bruto TEXT NOT NULL, recebido TEXT NOT NULL);
`);

const p = (sql) => db.prepare(sql);
const bool = (v) => (v ? 1 : 0);
const naBool = (r, campo) => (r ? { ...r, [campo]: !!r[campo] } : r);

/* ============================ contas ============================ */
async function contaPorEmail(email) { return p("SELECT * FROM contas WHERE email = ?").get(email) || null; }
async function contaPorId(id) { return p("SELECT * FROM contas WHERE id = ?").get(id) || null; }
async function contaPorClientePag(x) { return p("SELECT * FROM contas WHERE cliente_pag = ?").get(x) || null; }
async function inserirConta(c) {
  p(`INSERT INTO contas (id,agencia,email,senha_hash,senha_salt,plano,status,teste_ate,criada_em)
     VALUES (?,?,?,?,?,?,?,?,?)`)
   .run(c.id, c.agencia, c.email, c.senha_hash, c.senha_salt, c.plano, c.status, c.teste_ate, c.criada_em);
  return contaPorId(c.id);
}
async function atualizarConta(id, campos) {
  const chaves = Object.keys(campos);
  if (!chaves.length) return contaPorId(id);
  p(`UPDATE contas SET ${chaves.map((k) => k + " = ?").join(", ")} WHERE id = ?`)
   .run(...chaves.map((k) => campos[k]), id);
  return contaPorId(id);
}

/* ============================ sessões ============================ */
async function inserirSessao(s) {
  p("INSERT INTO sessoes (token,conta_id,criada_em,expira_em,ip) VALUES (?,?,?,?,?)")
   .run(s.token, s.conta_id, s.criada_em, s.expira_em, s.ip || null);
}
async function sessaoPorToken(t) { return p("SELECT * FROM sessoes WHERE token = ?").get(t) || null; }
async function apagarSessao(t) { p("DELETE FROM sessoes WHERE token = ?").run(t); }
async function limparSessoesVencidas() {
  p("DELETE FROM sessoes WHERE expira_em < ?").run(new Date().toISOString());
}

/* ======================= tentativas de login ======================= */
async function tentativaPorChave(c) { return p("SELECT * FROM tentativas_login WHERE chave = ?").get(c) || null; }
async function salvarTentativa(chave, contagem, ate) {
  p(`INSERT INTO tentativas_login (chave,contagem,ate) VALUES (?,?,?)
     ON CONFLICT(chave) DO UPDATE SET contagem = excluded.contagem, ate = excluded.ate`)
   .run(chave, contagem, ate);
}
async function apagarTentativa(c) { p("DELETE FROM tentativas_login WHERE chave = ?").run(c); }

/* ============================ clientes ============================ */
async function clientesDaConta(contaId) {
  return p("SELECT * FROM clientes WHERE conta_id = ? AND arquivado = 0 ORDER BY nome").all(contaId)
          .map((c) => naBool(c, "arquivado"));
}
async function contarClientes(contaId) {
  return p("SELECT COUNT(*) AS n FROM clientes WHERE conta_id = ? AND arquivado = 0").get(contaId).n;
}
async function clienteDaConta(contaId, id) {
  return p("SELECT * FROM clientes WHERE id = ? AND conta_id = ? AND arquivado = 0").get(id, contaId) || null;
}
async function clientePorToken(t) {
  return p("SELECT * FROM clientes WHERE token_rel = ? AND arquivado = 0").get(t) || null;
}
async function inserirCliente(c) {
  p(`INSERT INTO clientes (id,conta_id,nome,ramo,seguidores,plano_txt,contrato,metrica,metrica_s,token_rel,criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
   .run(c.id, c.conta_id, c.nome, c.ramo, c.seguidores, c.plano_txt, c.contrato,
        c.metrica, c.metrica_s, c.token_rel, c.criado_em);
  return p("SELECT * FROM clientes WHERE id = ?").get(c.id);
}
async function arquivarCliente(id) { p("UPDATE clientes SET arquivado = 1 WHERE id = ?").run(id); }

/* ========================== publicações ========================== */
async function publicacoes(clienteId, desdeISO, ateISO) {
  return p(`SELECT * FROM publicacoes WHERE cliente_id = ? AND publicada >= ? AND publicada <= ?
            ORDER BY publicada ASC`).all(clienteId, desdeISO, ateISO)
          .map((x) => naBool(x, "auto"));
}
async function inserirPublicacao(x) {
  p(`INSERT INTO publicacoes (id,cliente_id,titulo,url,plataforma,formato,publicada,hora,
       alcance,views,interacoes,salvos,cliques,auto,criada_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(x.id, x.cliente_id, x.titulo, x.url || null, x.plataforma, x.formato, x.publicada, x.hora,
        x.alcance, x.views, x.interacoes, x.salvos, x.cliques, bool(x.auto), x.criada_em);
  return naBool(p("SELECT * FROM publicacoes WHERE id = ?").get(x.id), "auto");
}

/* =========================== resultados =========================== */
async function resultados(clienteId) {
  return p("SELECT * FROM resultados WHERE cliente_id = ? ORDER BY competencia ASC").all(clienteId);
}
async function salvarResultado(r) {
  p(`INSERT INTO resultados (id,cliente_id,competencia,rotulo,posts,reels,alcance,resultado,criado_em)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(cliente_id, competencia) DO UPDATE SET
       rotulo = excluded.rotulo, posts = excluded.posts, reels = excluded.reels,
       alcance = excluded.alcance, resultado = excluded.resultado`)
   .run(r.id, r.cliente_id, r.competencia, r.rotulo, r.posts, r.reels, r.alcance, r.resultado, r.criado_em);
}

/* ============================ conexões ============================ */
async function conexao(clienteId) { return p("SELECT * FROM conexoes WHERE cliente_id = ?").get(clienteId) || null; }
async function salvarConexao(x) {
  p(`INSERT INTO conexoes (cliente_id,rede,conta_rede,token,expira_em,ligada_em,ultima_sinc)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(cliente_id) DO UPDATE SET
       conta_rede = excluded.conta_rede, token = excluded.token,
       expira_em = excluded.expira_em, ligada_em = excluded.ligada_em,
       ultima_sinc = excluded.ultima_sinc`)
   .run(x.cliente_id, x.rede || "instagram", x.conta_rede || null, x.token || null,
        x.expira_em || null, x.ligada_em || null, x.ultima_sinc || null);
}
async function apagarConexao(clienteId) { p("DELETE FROM conexoes WHERE cliente_id = ?").run(clienteId); }

/* ======================== eventos de pagamento ======================== */
async function eventoExiste(id) { return !!p("SELECT 1 FROM eventos_pagamento WHERE id = ?").get(id); }
async function registrarEvento(e) {
  p("INSERT OR IGNORE INTO eventos_pagamento (id,conta_id,tipo,bruto,recebido) VALUES (?,?,?,?,?)")
   .run(e.id, e.conta_id || null, e.tipo, e.bruto, e.recebido);
}

/* ---------- assinaturas ---------- */
async function assinaturaPorEmail(email) {
  return p("SELECT * FROM assinaturas WHERE email = ?").get(String(email).toLowerCase()) || null;
}
async function salvarAssinatura(a) {
  p(`INSERT INTO assinaturas (email,plano,status,assinatura_id,pedido_id,atualizado_em)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET
       plano=excluded.plano, status=excluded.status,
       assinatura_id=excluded.assinatura_id, pedido_id=excluded.pedido_id,
       atualizado_em=excluded.atualizado_em`)
   .run(String(a.email).toLowerCase(), a.plano, a.status,
        a.assinatura_id || null, a.pedido_id || null, a.atualizado_em);
}

/* ---------- recuperação de senha ---------- */
async function criarRecuperacao(r) {
  p(`INSERT INTO recuperacoes (id,conta_id,hash,expira_em,criado_em,ip) VALUES (?,?,?,?,?,?)`)
   .run(r.id, r.conta_id, r.hash, r.expira_em, r.criado_em, r.ip || null);
}
async function recuperacaoPorHash(hash) {
  return p("SELECT * FROM recuperacoes WHERE hash = ?").get(hash) || null;
}
async function marcarRecuperacaoUsada(id, quando) {
  p("UPDATE recuperacoes SET usado_em = ? WHERE id = ?").run(quando, id);
}
async function apagarRecuperacoesDaConta(contaId) {
  p("DELETE FROM recuperacoes WHERE conta_id = ?").run(contaId);
}
async function apagarSessoesDaConta(contaId) {
  p("DELETE FROM sessoes WHERE conta_id = ?").run(contaId);
}

const TABELAS = [
  "contas", "sessoes", "clientes", "publicacoes", "resultados",
  "conexoes", "tentativas_login", "recuperacoes", "assinaturas", "eventos_pagamento"
];

async function testarConexao() { p("SELECT 1").get(); return true; }

/** O mesmo diagnóstico do adaptador do Supabase, para o modo local. */
async function tabelasFaltando() {
  const faltam = [];
  for (const t of TABELAS) {
    try { p("SELECT 1 FROM " + t + " LIMIT 1").get(); }
    catch { faltam.push(t); }
  }
  return faltam;
}

module.exports = {
  nome: "sqlite", db,
  contaPorEmail, contaPorId, contaPorClientePag, inserirConta, atualizarConta,
  inserirSessao, sessaoPorToken, apagarSessao, limparSessoesVencidas,
  tentativaPorChave, salvarTentativa, apagarTentativa,
  clientesDaConta, contarClientes, clienteDaConta, clientePorToken, inserirCliente, arquivarCliente,
  publicacoes, inserirPublicacao,
  resultados, salvarResultado,
  conexao, salvarConexao, apagarConexao,
  eventoExiste, registrarEvento,
  assinaturaPorEmail, salvarAssinatura,
  criarRecuperacao, recuperacaoPorHash, marcarRecuperacaoUsada,
  apagarRecuperacoesDaConta, apagarSessoesDaConta,
  testarConexao, tabelasFaltando
};
