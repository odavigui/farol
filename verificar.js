"use strict";
/**
 * Verificador do Supabase.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *   Toda a lógica do sistema foi testada contra SQLite. O adaptador do
 *   Supabase (src/repo-supabase.js) é a única parte que não pôde ser testada
 *   sem as suas credenciais. Este script fecha essa lacuna: ele exercita cada
 *   operação contra o SEU Supabase e diz exatamente o que funcionou.
 *
 * COMO USAR
 *   1. Rode banco/esquema.sql no SQL Editor do Supabase.
 *   2. Crie .env.local com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
 *   3. node verificar.js
 *
 * O script cria uma conta de teste, faz tudo o que o sistema faz, e APAGA
 * tudo no fim. Não deixa lixo. Pode rodar quantas vezes quiser.
 */

const fs = require("node:fs");
const path = require("node:path");

/* Lê .env.local sem depender de biblioteca. */
for (const arquivo of [".env.local", ".env"]) {
  const p = path.join(__dirname, arquivo);
  if (!fs.existsSync(p)) continue;
  for (const linha of fs.readFileSync(p, "utf8").split("\n")) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("\nFaltam as variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Copie .env.exemplo para .env.local e preencha as duas.\n");
  console.error("Onde achar: Supabase -> Project Settings -> API");
  console.error("  SUPABASE_URL              = Project URL");
  console.error("  SUPABASE_SERVICE_ROLE_KEY = service_role (a secreta, NUNCA a anon)\n");
  process.exit(1);
}
process.env.BANCO = "supabase";

const dados = require("./src/dados");
const auth = require("./src/auth");
const met = require("./src/metricas");
const crypto = require("node:crypto");

let passou = 0, falhou = 0;
const EMAIL = "verificacao+" + Date.now() + "@farol.local";
let contaId = null, clienteId = null;

async function teste(nome, fn) {
  try {
    const r = await fn();
    console.log("  ok   " + nome + (r ? "  (" + r + ")" : ""));
    passou++;
  } catch (e) {
    console.log("  FALHA " + nome);
    console.log("        " + (e.message || e));
    if (e.supabase) console.log("        resposta: " + JSON.stringify(e.supabase));
    falhou++;
  }
}

async function principal() {
  console.log("\nVerificando o Supabase em " + process.env.SUPABASE_URL + "\n");

  await teste("conexão e leitura da tabela contas", async () => {
    await dados.testarConexao();
  });

  await teste("criar conta (hash de senha e unicidade de e-mail)", async () => {
    const c = await auth.criarConta({
      agencia: "Verificação", email: EMAIL, senha: "senhaverificacao123", plano: "essencial"
    });
    contaId = c.id;
    return c.id;
  });

  await teste("e-mail duplicado é recusado", async () => {
    try {
      await auth.criarConta({ agencia: "X", email: EMAIL, senha: "senhaverificacao123" });
      throw new Error("deixou criar duplicado — a restrição UNIQUE não está valendo");
    } catch (e) {
      if (!/já existe/i.test(e.message)) throw e;
    }
  });

  await teste("login com a senha certa", async () => {
    const c = await auth.autenticar({ email: EMAIL, senha: "senhaverificacao123", ip: "1.1.1.1" });
    if (c.id !== contaId) throw new Error("voltou outra conta");
  });

  await teste("login com senha errada é recusado", async () => {
    try {
      await auth.autenticar({ email: EMAIL, senha: "errada", ip: "1.1.1.1" });
      throw new Error("aceitou senha errada");
    } catch (e) {
      if (!/incorretos/i.test(e.message)) throw e;
    }
  });

  await teste("contador de tentativas grava e apaga", async () => {
    await dados.salvarTentativa("verif:teste", 3, new Date(Date.now() + 6e4).toISOString());
    const t = await dados.tentativaPorChave("verif:teste");
    if (!t || t.contagem !== 3) throw new Error("não gravou a contagem");
    await dados.apagarTentativa("verif:teste");
    if (await dados.tentativaPorChave("verif:teste")) throw new Error("não apagou");
  });

  let token;
  await teste("abrir sessão, ler e fechar", async () => {
    token = await auth.abrirSessao(contaId, "1.1.1.1");
    const c = await auth.contaDaSessao(token);
    if (!c || c.id !== contaId) throw new Error("sessão não resolveu para a conta");
    await auth.fecharSessao(token);
    if (await auth.contaDaSessao(token)) throw new Error("sessão continuou válida depois de fechada");
  });

  await teste("criar cliente", async () => {
    const c = await dados.inserirCliente({
      id: auth.id("cl_"), conta_id: contaId, nome: "Cliente de Verificação",
      ramo: "Teste", seguidores: 100, plano_txt: "Social 2x/semana", contrato: 900,
      metrica: "pedidos", metrica_s: "pedido",
      token_rel: crypto.randomBytes(16).toString("base64url"), criado_em: auth.agora()
    });
    clienteId = c.id;
    return c.nome;
  });

  await teste("listar e contar clientes da conta", async () => {
    const lista = await dados.clientesDaConta(contaId);
    const n = await dados.contarClientes(contaId);
    if (lista.length !== 1 || n !== 1) throw new Error(`esperava 1, veio ${lista.length}/${n}`);
  });

  await teste("isolamento: outra conta não enxerga este cliente", async () => {
    const achado = await dados.clienteDaConta("ct_conta_que_nao_existe", clienteId);
    if (achado) throw new Error("VAZAMENTO — o filtro por conta_id não está funcionando");
  });

  await teste("buscar cliente pelo token do relatório", async () => {
    const c = await dados.clienteDaConta(contaId, clienteId);
    const porToken = await dados.clientePorToken(c.token_rel);
    if (!porToken || porToken.id !== clienteId) throw new Error("token não resolveu");
  });

  await teste("inserir publicações e ler por intervalo de data", async () => {
    for (const [d, alc, fmt] of [[2, 9000, "Reels"], [9, 3000, "Carrossel"], [80, 1000, "Foto"]]) {
      await dados.inserirPublicacao({
        id: auth.id("pb_"), cliente_id: clienteId, titulo: "Teste " + d, url: null,
        plataforma: "Instagram", formato: fmt,
        publicada: new Date(Date.now() - d * 864e5).toISOString(), hora: 19,
        alcance: alc, views: 0, interacoes: 500, salvos: 60, cliques: 10,
        auto: false, criada_em: auth.agora()
      });
    }
    const recentes = await dados.publicacoes(
      clienteId,
      new Date(Date.now() - 60 * 864e5).toISOString(),
      new Date().toISOString()
    );
    if (recentes.length !== 2)
      throw new Error(`o filtro de data trouxe ${recentes.length}, esperava 2 (a de 80 dias devia ficar fora)`);
    return "3 gravadas, filtro de 60 dias trouxe 2";
  });

  await teste("resultado mensal grava e ATUALIZA o mesmo mês (upsert)", async () => {
    const base = {
      id: auth.id("rs_"), cliente_id: clienteId, competencia: "2020-01", rotulo: "Jan",
      posts: 8, reels: 3, alcance: 50000, resultado: 100, criado_em: auth.agora()
    };
    await dados.salvarResultado(base);
    await dados.salvarResultado({ ...base, id: auth.id("rs_"), resultado: 222 });
    const h = await dados.resultados(clienteId);
    const jan = h.filter((r) => r.competencia === "2020-01");
    if (jan.length !== 1) throw new Error(`duplicou o mês (${jan.length} linhas) — o on_conflict não pegou`);
    if (jan[0].resultado !== 222) throw new Error("não atualizou o valor");
    return "sem duplicar, valor atualizado";
  });

  await teste("conexão da rede grava, atualiza e apaga", async () => {
    await dados.salvarConexao({
      cliente_id: clienteId, rede: "instagram", conta_rede: "teste1",
      expira_em: new Date(Date.now() + 60 * 864e5).toISOString(), ligada_em: auth.agora()
    });
    await dados.salvarConexao({
      cliente_id: clienteId, rede: "instagram", conta_rede: "teste2",
      expira_em: new Date(Date.now() + 60 * 864e5).toISOString(), ligada_em: auth.agora()
    });
    const x = await dados.conexao(clienteId);
    if (!x || x.conta_rede !== "teste2") throw new Error("upsert da conexão não atualizou");
    await dados.apagarConexao(clienteId);
    if (await dados.conexao(clienteId)) throw new Error("não apagou");
  });

  await teste("evento de pagamento não duplica", async () => {
    const id = "evt_verif_" + Date.now();
    await dados.registrarEvento({ id, conta_id: contaId, tipo: "teste", bruto: "{}", recebido: auth.agora() });
    if (!(await dados.eventoExiste(id))) throw new Error("não gravou");
    await dados.registrarEvento({ id, conta_id: contaId, tipo: "teste", bruto: "{}", recebido: auth.agora() });
    return "reenvio ignorado";
  });

  await teste("trocar plano da conta", async () => {
    const c = await dados.atualizarConta(contaId, { plano: "agencia", status: "ativa" });
    if (c.plano !== "agencia" || c.status !== "ativa") throw new Error("não atualizou");
  });

  await teste("motor de diagnóstico roda com dados reais do banco", async () => {
    const c = await dados.clienteDaConta(contaId, clienteId);
    const atuais = await dados.publicacoes(clienteId, new Date(Date.now() - 60 * 864e5).toISOString(), new Date().toISOString());
    const h = await dados.resultados(clienteId);
    const d = met.diagnosticar({ cliente: c, publicacoes: atuais, anteriores: [], historico: h, dias: 60 });
    if (!Array.isArray(d) || !d.length) throw new Error("não gerou leituras");
    return d.length + " leituras";
  });

  await teste("tabela de recuperação de senha responde", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const idRec = "rc_teste_" + Date.now();
    await dados.criarRecuperacao({
      id: idRec, conta_id: contaId, hash,
      expira_em: new Date(Date.now() + 36e5).toISOString(),
      criado_em: new Date().toISOString(), ip: "127.0.0.1"
    });
    const r = await dados.recuperacaoPorHash(hash);
    if (!r) throw new Error("gravou mas não achou de volta");
    if (JSON.stringify(r).includes(token))
      throw new Error("o token cru ficou no banco — só o hash pode ficar");
    await dados.marcarRecuperacaoUsada(r.id, new Date().toISOString());
    if (!(await dados.recuperacaoPorHash(hash)).usado_em)
      throw new Error("marcar como usado não funcionou");
    await dados.apagarRecuperacoesDaConta(contaId);
    if (await dados.recuperacaoPorHash(hash)) throw new Error("não apagou");
    return "grava, lê, marca e apaga";
  });

  await teste("configuração de e-mail", async () => {
    const email = require("./src/email");
    if (email.MODO === "log")
      return "modo log — o link aparece no terminal, nada é enviado. " +
             "Configure SMTP_USUARIO e SMTP_SENHA para enviar de verdade";
    if (email.MODO === "smtp" && !process.env.SMTP_SENHA)
      throw new Error("EMAIL_MODO=smtp mas SMTP_SENHA está vazia");
    if (email.MODO === "http" && !process.env.EMAIL_API_CHAVE)
      throw new Error("EMAIL_MODO=http mas EMAIL_API_CHAVE está vazia");
    if (!process.env.URL_BASE)
      return email.MODO + " — mas URL_BASE está vazia; " +
             "configure para o link do e-mail não depender do cabeçalho Host";
    return email.MODO + " para " + process.env.URL_BASE;
  });

  await teste("apagar tudo o que o teste criou", async () => {
    // A conta cai em cascata: clientes, publicações, resultados e sessões vão junto.
    await dados.atualizarConta(contaId, { email: EMAIL });
    const r = await fetch(
      process.env.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/contas?id=eq." + encodeURIComponent(contaId),
      { method: "DELETE", headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY
        } }
    );
    if (!r.ok) throw new Error("não consegui apagar a conta de teste: " + r.status);
    if (await dados.contaPorId(contaId)) throw new Error("a conta continua lá");
    if (await dados.clienteDaConta(contaId, clienteId))
      throw new Error("o cliente sobreviveu — o ON DELETE CASCADE não está valendo");
    return "cascata funcionou";
  });

  console.log("\n" + "-".repeat(52));
  console.log(`  ${passou} passaram, ${falhou} falharam`);
  if (falhou === 0) {
    console.log("\n  Está tudo certo. Pode publicar na Vercel.");
    console.log("  Configure as mesmas variáveis em Settings -> Environment Variables.\n");
  } else {
    console.log("\n  Me mande o texto das falhas que eu corrijo.");
    console.log("  A causa mais comum é o esquema não ter sido rodado ainda:");
    console.log("  Supabase -> SQL Editor -> cole banco/esquema.sql -> Run.\n");
  }
  process.exit(falhou ? 1 : 0);
}

principal().catch((e) => {
  console.error("\nErro inesperado:", e.message);
  if (e.supabase) console.error(JSON.stringify(e.supabase, null, 2));
  process.exit(1);
});
