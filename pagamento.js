"use strict";
/**
 * Pagamento — webhook.
 *
 * O PONTO INTEIRO deste arquivo: quem define o plano de uma conta é a
 * confirmação de pagamento que chega AQUI, do provedor, com assinatura
 * válida. Nunca um parâmetro de URL, nunca um campo do formulário, nunca
 * uma variável do navegador.
 *
 * Está escrito no formato do Stripe (cabeçalho Stripe-Signature, HMAC-SHA256
 * do corpo cru). Mercado Pago e Pagar.me usam o mesmo desenho, mudando o nome
 * do cabeçalho e o formato do payload — os pontos a trocar estão marcados
 * com AJUSTAR.
 *
 * Três cuidados que quase todo mundo esquece:
 *  - Validar a assinatura sobre o CORPO CRU, antes de qualquer parse.
 *  - Guardar o id do evento e ignorar repetidos. Provedores reenviam.
 *  - Responder 200 rápido. Se demorar, o provedor reenvia e duplica.
 */

const crypto = require("node:crypto");
const dados = require("./dados");
const { PLANOS } = require("./planos");

const SEGREDO = process.env.SEGREDO_WEBHOOK || "";
const TOLERANCIA_S = 300;

/** AJUSTAR: mapeie o id do preço/plano do seu provedor para o plano interno. */
const DE_PARA = {
  [process.env.PRECO_ESSENCIAL || "price_essencial"]: "essencial",
  [process.env.PRECO_AGENCIA   || "price_agencia"]:   "agencia",
  [process.env.PRECO_ESTUDIO   || "price_estudio"]:   "estudio"
};

function assinaturaValida(corpoCru, cabecalho) {
  if (!SEGREDO) return { ok: false, motivo: "SEGREDO_WEBHOOK não configurado" };
  if (!cabecalho) return { ok: false, motivo: "sem cabeçalho de assinatura" };

  // formato Stripe: "t=1699999999,v1=abc..."
  const partes = Object.fromEntries(
    String(cabecalho).split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const t = partes.t, v1 = partes.v1;
  if (!t || !v1) return { ok: false, motivo: "assinatura mal formada" };

  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCIA_S)
    return { ok: false, motivo: "assinatura vencida" };

  const esperado = crypto.createHmac("sha256", SEGREDO)
    .update(`${t}.${corpoCru}`, "utf8").digest("hex");

  const a = Buffer.from(esperado, "utf8"), b = Buffer.from(String(v1), "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ok: false, motivo: "assinatura não confere" };

  return { ok: true };
}

async function registrar(eventoId, contaId, tipo, bruto) {
  await dados.registrarEvento({
    id: eventoId, conta_id: contaId || null, tipo,
    bruto: String(bruto).slice(0, 20000), recebido: new Date().toISOString()
  });
}

async function contaPorReferencia({ contaId, email, clientePag }) {
  if (contaId) { const c = await dados.contaPorId(contaId); if (c) return c; }
  if (clientePag) { const c = await dados.contaPorClientePag(clientePag); if (c) return c; }
  if (email) { const c = await dados.contaPorEmail(String(email).toLowerCase()); if (c) return c; }
  return null;
}

/**
 * @param corpoCru  string exata recebida no corpo, sem parse
 * @param cabecalho valor do cabeçalho de assinatura
 */
async function processar(corpoCru, cabecalho) {
  const v = assinaturaValida(corpoCru, cabecalho);
  if (!v.ok) return { status: 400, corpo: { erro: "Assinatura inválida: " + v.motivo } };

  let ev;
  try { ev = JSON.parse(corpoCru); }
  catch { return { status: 400, corpo: { erro: "JSON inválido." } }; }

  const eventoId = ev.id || crypto.randomUUID();
  if (await dados.eventoExiste(eventoId)) return { status: 200, corpo: { ok: true, repetido: true } };

  const tipo = ev.type || ev.action || "desconhecido";
  const obj = ev.data?.object || ev.data || {};

  // AJUSTAR: onde seu provedor coloca a referência da conta.
  const conta = await contaPorReferencia({
    contaId: obj.metadata?.conta_id,
    email: obj.customer_email || obj.customer_details?.email,
    clientePag: obj.customer
  });

  await registrar(eventoId, conta?.id, tipo, corpoCru);
  if (!conta) return { status: 200, corpo: { ok: true, aviso: "conta não localizada" } };

  // AJUSTAR: nomes de evento do seu provedor.
  const ativa = ["checkout.session.completed", "customer.subscription.created",
                 "customer.subscription.updated", "invoice.paid", "payment.approved"];
  const cancela = ["customer.subscription.deleted", "subscription.cancelled"];
  const falha = ["invoice.payment_failed", "payment.rejected"];

  if (ativa.includes(tipo)) {
    const precoId = obj.items?.data?.[0]?.price?.id || obj.plan?.id || obj.metadata?.plano;
    const novo = DE_PARA[precoId] || (PLANOS[obj.metadata?.plano] ? obj.metadata.plano : null);
    const campos = { status: "ativa" };
    if (novo) campos.plano = novo;
    if (obj.customer) campos.cliente_pag = obj.customer;
    if (obj.subscription || obj.id) campos.assinatura_id = obj.subscription || obj.id;
    await dados.atualizarConta(conta.id, campos);
  } else if (falha.includes(tipo)) {
    // Não cancela na primeira falha: marca inadimplente. planoEfetivo() derruba
    // a conta para o plano mínimo até o pagamento entrar.
    await dados.atualizarConta(conta.id, { status: "inadimplente" });
  } else if (cancela.includes(tipo)) {
    await dados.atualizarConta(conta.id, { status: "cancelada" });
  }

  return { status: 200, corpo: { ok: true } };
}

module.exports = { processar, assinaturaValida };
