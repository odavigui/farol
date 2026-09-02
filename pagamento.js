"use strict";
/**
 * Pagamento — webhook da Cakto.
 *
 * O PONTO INTEIRO deste arquivo: quem define o plano de uma conta é a
 * confirmação que chega AQUI, da Cakto. Nunca um parâmetro de URL, nunca um
 * campo do formulário, nunca uma variável do navegador.
 *
 * COMO A CAKTO AUTENTICA — e por que isso exige cuidado
 *
 * A Cakto não assina o corpo com HMAC e não manda cabeçalho de assinatura.
 * Ela envia um `secret` DENTRO do corpo, que você compara com o seu. É mais
 * frágil do que assinatura: quem descobrir esse segredo consegue forjar um
 * pagamento. Duas consequências práticas:
 *
 *   1. A comparação é feita em tempo constante (timingSafeEqual). Comparar
 *      com === vaza o segredo caractere a caractere pelo tempo de resposta.
 *   2. O segredo é uma credencial: vive em CAKTO_WEBHOOK_SECRET, nunca no
 *      repositório, e a URL do webhook tem que ser https.
 *
 * A ORDEM É INVERTIDA, e é isso que explica a tabela `assinaturas`
 *
 * A agência paga no checkout da Cakto ANTES de existir conta no Farol. Então
 * quando o pagamento chega não há conta para atualizar. Guardamos o direito
 * pelo e-mail da compra; o cadastro consulta essa tabela ao nascer. Se a
 * conta já existir, atualizamos as duas coisas.
 *
 * Retentativas: a Cakto tenta até 5 vezes e desiste em 8 segundos por
 * tentativa. Por isso este arquivo responde rápido e é idempotente — o mesmo
 * evento chegando duas vezes não pode liberar ou derrubar duas vezes.
 */

const crypto = require("node:crypto");
const dados = require("./dados");
const { PLANOS } = require("./planos");

const SEGREDO = process.env.CAKTO_WEBHOOK_SECRET || "";

/**
 * De qual oferta da Cakto veio, para qual plano do Farol.
 *
 * Cada variável aceita VÁRIOS identificadores separados por vírgula. Isso é
 * de propósito: o link de checkout da Cakto tem a forma
 * pay.cakto.com.br/dbwk5yp_1078361, e não dá para saber de fora qual das
 * duas partes ela manda no webhook — nem se manda o id do produto ou o da
 * oferta. Cadastrando as duas, qualquer uma que venha resolve.
 *
 *   CAKTO_OFERTA_AGENCIA=b2p6p4a,1078362,b2p6p4a_1078362
 *
 * Sem nenhuma correspondência o pagamento é registrado e NENHUM plano é
 * liberado — liberar por adivinhação é pior do que não liberar.
 */
function lista(v) {
  const bruto = String(v || "")
    .split(/[,;\s]+/)                 // vírgula, ponto-e-vírgula ou espaço
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  // E as partes de cada pedaço, separadas por "_".
  //
  // O link de checkout tem a forma pay.cakto.com.br/b2p6p4a_1078362, e não dá
  // para saber de fora se a Cakto manda a primeira metade, a segunda, ou as
  // duas juntas. Antes isso obrigava a cadastrar as três formas separadas por
  // vírgula — e cadastrar uma lista num campo de configuração é convite para
  // erro de digitação. Agora basta colar o pedaço do link como ele é:
  //
  //   CAKTO_OFERTA_AGENCIA=b2p6p4a_1078362
  //
  // que as três formas passam a valer. A lista separada por vírgula continua
  // funcionando, para quem já cadastrou assim.
  const todas = new Set();
  for (const item of bruto) {
    todas.add(item);
    for (const parte of item.split("_")) if (parte) todas.add(parte);
  }
  return [...todas];
}
const DE_PARA = [
  { plano: "essencial", ids: lista(process.env.CAKTO_OFERTA_ESSENCIAL) },
  { plano: "agencia",   ids: lista(process.env.CAKTO_OFERTA_AGENCIA) },
  { plano: "estudio",   ids: lista(process.env.CAKTO_OFERTA_ESTUDIO) }
];

/** Tira acento e caixa, para comparar nome de produto sem tropeçar em "Agência". */
const simples = (t) =>
  String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/* ---------------- eventos ---------------- */
/** Liberam ou renovam o acesso. */
const LIBERA = new Set([
  "purchase_approved",
  "subscription_created",
  "subscription_renewed",
  "subscription_resumed"
]);
/** Tiram o acesso na hora — dinheiro devolvido ou contestado. */
const CANCELA = new Set([
  "refund",
  "chargeback",
  "subscription_canceled"
]);
/** Não cancelam: marcam inadimplente. A cobrança ainda pode entrar. */
const SUSPENDE = new Set([
  "subscription_renewal_refused",
  "subscription_paused",
  "purchase_refused"
]);

/** Comparação em tempo constante, tolerante a tamanhos diferentes. */
function segredoConfere(recebido) {
  if (!SEGREDO) return { ok: false, motivo: "CAKTO_WEBHOOK_SECRET não configurado" };
  if (!recebido) return { ok: false, motivo: "corpo sem o campo secret" };
  // O hash iguala o tamanho sem revelar o comprimento real do segredo.
  const ha = crypto.createHash("sha256").update(String(recebido)).digest();
  const hb = crypto.createHash("sha256").update(SEGREDO).digest();
  return crypto.timingSafeEqual(ha, hb)
    ? { ok: true }
    : { ok: false, motivo: "secret não confere" };
}

/**
 * Onde a Cakto pode ter posto a identificação da oferta.
 *
 * Duas passadas, e a ordem importa:
 *   1. Por id cadastrado — exata, é a que vale.
 *   2. Por NOME do produto, como última tentativa. Existe porque o custo dos
 *      dois erros é muito diferente: mapear errado é ruim, mas alguém pagar
 *      R$ 197 e não receber nada é pior. O nome casa só se contiver a palavra
 *      do plano, e o caso fica gritando no log para você conferir e cadastrar
 *      o id direito.
 */
function planoDoEvento(d) {
  const campos = [
    d?.offer?.id, d?.offer?.short_id, d?.offer?.name,
    d?.product?.id, d?.product?.short_id, d?.product?.name
  ].filter(Boolean).map((x) => String(x).toLowerCase());

  for (const { plano, ids } of DE_PARA)
    for (const campo of campos)
      if (ids.includes(campo)) return plano;

  const texto = simples([d?.offer?.name, d?.product?.name].filter(Boolean).join(" "));
  if (texto) {
    for (const [palavra, plano] of [["essencial", "essencial"], ["agencia", "agencia"], ["estudio", "estudio"]]) {
      if (texto.includes(palavra)) {
        console.warn(
          "[pagamento] oferta reconhecida pelo NOME, não pelo id:", JSON.stringify({
            offer: d?.offer, product: d?.product
          }).slice(0, 200),
          "-> plano", plano,
          "| cadastre o id em CAKTO_OFERTA_" + plano.toUpperCase() + " para não depender do nome"
        );
        return plano;
      }
    }
  }
  return null;
}

function emailDoEvento(d) {
  const e = d?.customer?.email || d?.customer_email || d?.email;
  return e ? String(e).trim().toLowerCase() : null;
}

/**
 * Tira o `secret` do corpo antes de guardar.
 *
 * A Cakto autentica pelo campo `secret` DENTRO do corpo. Guardar o corpo cru
 * gravava a credencial em texto puro em toda linha da tabela de eventos — e
 * quem lesse a tabela (um backup, o painel do Supabase, um export de suporte)
 * passaria a poder forjar pagamento e, pior, disparar "chargeback" para
 * cancelar a conta de qualquer cliente. O corpo continua servindo para
 * auditoria; a credencial não faz falta nenhuma ali.
 */
function semSegredo(bruto) {
  try {
    const o = JSON.parse(bruto);
    if (o && typeof o === "object" && "secret" in o) {
      o.secret = "[removido]";
      return JSON.stringify(o);
    }
    return bruto;
  } catch {
    // Não era JSON válido: some com qualquer coisa parecida com o campo.
    return String(bruto).replace(/("secret"\s*:\s*)"[^"]*"/gi, '$1"[removido]"');
  }
}

async function registrar(id, contaId, tipo, bruto) {
  await dados.registrarEvento({
    id, conta_id: contaId || null, tipo,
    bruto: semSegredo(String(bruto)).slice(0, 20000), recebido: new Date().toISOString()
  });
}

/**
 * @param corpoCru string exata recebida no corpo
 * @returns {status, corpo}
 */
async function processar(corpoCru) {
  let ev;
  try { ev = JSON.parse(corpoCru || "{}"); }
  catch { return { status: 400, corpo: { erro: "JSON inválido." } }; }

  const v = segredoConfere(ev.secret);
  if (!v.ok) {
    console.warn("[pagamento] recusado:", v.motivo);
    // 401 e não 400: é falha de autenticação, e a Cakto não deve reenviar.
    return { status: 401, corpo: { erro: "Não autorizado." } };
  }

  const tipo = String(ev.event || "desconhecido");
  const d = ev.data || {};
  const eventoId = String(d.id || ev.id || crypto.randomUUID());

  // Retentativa da Cakto: já tratamos, respondemos 200 e não fazemos de novo.
  if (await dados.eventoExiste(eventoId)) {
    return { status: 200, corpo: { ok: true, repetido: true } };
  }

  const email = emailDoEvento(d);
  const conta = email ? await dados.contaPorEmail(email) : null;
  await registrar(eventoId, conta?.id, tipo, corpoCru);

  if (!email) {
    console.warn("[pagamento]", tipo, "sem e-mail no corpo — nada a fazer");
    return { status: 200, corpo: { ok: true, aviso: "evento sem e-mail" } };
  }

  const agora = new Date().toISOString();
  const assinaturaId = d.subscription?.id || d.subscription_id || null;
  const pedidoId = String(d.id || "") || null;

  /* ---------- liberar ---------- */
  if (LIBERA.has(tipo)) {
    const plano = planoDoEvento(d);
    if (!plano) {
      // Pagou, mas não sei de qual plano. Registro e aviso — não chuto.
      console.error("[pagamento] oferta não mapeada:", JSON.stringify({
        offer: d.offer, product: d.product
      }).slice(0, 300));
      await dados.salvarAssinatura({
        email, plano: "indefinido", status: "sem_mapeamento",
        assinatura_id: assinaturaId, pedido_id: pedidoId, atualizado_em: agora
      });
      return { status: 200, corpo: { ok: true, aviso: "oferta não mapeada" } };
    }

    await dados.salvarAssinatura({
      email, plano, status: "ativa",
      assinatura_id: assinaturaId, pedido_id: pedidoId, atualizado_em: agora
    });

    if (conta) {
      const campos = { plano, status: "ativa" };
      if (assinaturaId) campos.assinatura_id = assinaturaId;
      await dados.atualizarConta(conta.id, campos);
    }
    return { status: 200, corpo: { ok: true, plano, conta: !!conta } };
  }

  /* ---------- suspender ---------- */
  if (SUSPENDE.has(tipo)) {
    const atual = await dados.assinaturaPorEmail(email);
    await dados.salvarAssinatura({
      email, plano: atual?.plano || "essencial", status: "inadimplente",
      assinatura_id: assinaturaId || atual?.assinatura_id,
      pedido_id: pedidoId, atualizado_em: agora
    });
    // Não cancela na primeira falha: planoEfetivo() já derruba a conta
    // inadimplente para o plano mínimo até a cobrança entrar.
    if (conta) await dados.atualizarConta(conta.id, { status: "inadimplente" });
    return { status: 200, corpo: { ok: true, status: "inadimplente" } };
  }

  /* ---------- cancelar ---------- */
  if (CANCELA.has(tipo)) {
    const atual = await dados.assinaturaPorEmail(email);
    await dados.salvarAssinatura({
      email, plano: atual?.plano || "essencial", status: "cancelada",
      assinatura_id: assinaturaId || atual?.assinatura_id,
      pedido_id: pedidoId, atualizado_em: agora
    });
    if (conta) {
      await dados.atualizarConta(conta.id, { status: "cancelada" });
      // Cancelar sem derrubar a sessão deixava a pessoa dentro do sistema com o
      // cookie que já tinha. Estorno e chargeback tiram o acesso na hora.
      await dados.apagarSessoesDaConta(conta.id);
    }
    return { status: 200, corpo: { ok: true, status: "cancelada" } };
  }

  // Evento que não muda acesso (pix_gerado, initiate_checkout, etc.).
  // Fica registrado e responde 200 para a Cakto não reenviar.
  return { status: 200, corpo: { ok: true, ignorado: tipo } };
}

/**
 * Consultada no cadastro: a agência pagou antes de criar a conta?
 * Devolve o plano a aplicar, ou null.
 */
async function planoPago(email) {
  const a = await dados.assinaturaPorEmail(String(email || "").toLowerCase());
  if (!a || a.status !== "ativa") return null;
  return PLANOS[a.plano] ? { plano: a.plano, assinatura_id: a.assinatura_id } : null;
}

module.exports = { processar, planoPago, segredoConfere, semSegredo, planoDoEvento, LIBERA, CANCELA, SUSPENDE };
