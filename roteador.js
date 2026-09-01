"use strict";
/**
 * Roteador compartilhado.
 *
 * Existe uma implementação só das rotas, usada pelos dois ambientes:
 *   - api/[[...rota]].js   -> Vercel (serverless)
 *   - servidor.js          -> sua máquina (node servidor.js)
 *
 * Assim não há risco de o comportamento local divergir do de produção, que é
 * o jeito mais comum de um bug passar despercebido até o cliente encontrar.
 */

const { rotas } = require("./api");
const auth = require("./auth");
const pagamento = require("./pagamento");

const DIAS_SESSAO = 14;
const PRODUCAO = process.env.NODE_ENV === "producao" || !!process.env.VERCEL;

/* ---- tabela de rotas com parâmetros (:id) ---- */
const TABELA = Object.keys(rotas).map((chave) => {
  const [metodo, molde] = chave.split(" ");
  const nomes = [];
  const re = new RegExp("^" + molde.replace(/:[a-zA-Z]+/g, (m) => {
    nomes.push(m.slice(1));
    return "([^/]+)";
  }) + "$");
  return { metodo, re, nomes, fn: rotas[chave] };
});

function achar(metodo, caminho) {
  for (const r of TABELA) {
    if (r.metodo !== metodo) continue;
    const m = caminho.match(r.re);
    if (!m) continue;
    const params = {};
    r.nomes.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    return { fn: r.fn, params };
  }
  return null;
}

function lerCookies(cabecalho) {
  const out = {};
  (cabecalho || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieSessao(token, apagar) {
  const partes = [
    `sessao=${apagar ? "" : token}`,
    "Path=/", "HttpOnly",
    // SameSite=Lax já barra o essencial de CSRF: um site terceiro não consegue
    // fazer o navegador enviar este cookie num POST.
    "SameSite=Lax",
    apagar ? "Max-Age=0" : "Max-Age=" + DIAS_SESSAO * 24 * 3600
  ];
  if (PRODUCAO) partes.push("Secure");
  return partes.join("; ");
}

/**
 * Endereço do site, para montar o link que vai no e-mail.
 *
 * URL_BASE manda, e é o que você deve configurar na Vercel — o cabeçalho Host
 * vem de quem chama, então quem soubesse a rota poderia mandar um e-mail seu
 * com link para o site dele. Com URL_BASE definida, isso deixa de existir.
 */
function enderecoBase(cabecalhos) {
  if (process.env.URL_BASE) return String(process.env.URL_BASE).replace(/\/+$/, "");
  const host = cabecalhos.host || "localhost:3000";
  const protocolo = cabecalhos["x-forwarded-proto"] || (PRODUCAO ? "https" : "http");
  return protocolo + "://" + host;
}

/** Segunda barreira de CSRF: em produção, POST só vale se a origem for a nossa. */
function origemOk(origem, host) {
  if (!PRODUCAO) return true;
  if (!origem) return true;              // navegação normal, sem fetch entre sites
  try { return new URL(origem).host === host; } catch { return false; }
}

/**
 * Trata uma requisição de API já normalizada.
 *
 * @param {object} pedido
 *   metodo, caminho, query, cabecalhos, corpoCru, ip
 * @returns {object} { status, corpo, cookie }
 */
async function tratar(pedido) {
  const { metodo, caminho, query, cabecalhos, corpoCru, ip } = pedido;

  /* --- webhook: precisa do corpo cru, antes de qualquer parse --- */
  if (caminho === "/api/pagamento/webhook" && metodo === "POST") {
    const assinatura = cabecalhos["stripe-signature"] || cabecalhos["x-signature"] || "";
    const r = await pagamento.processar(corpoCru || "", assinatura);
    return { status: r.status, corpo: r.corpo };
  }

  if (!origemOk(cabecalhos.origin, cabecalhos.host))
    return { status: 403, corpo: { erro: "Origem não permitida." } };

  const achado = achar(metodo, caminho);
  if (!achado) return { status: 404, corpo: { erro: "Rota não encontrada." } };

  let corpo = null;
  if (corpoCru) {
    try { corpo = JSON.parse(corpoCru); }
    catch { return { status: 400, corpo: { erro: "JSON inválido." } }; }
  }

  const sessao = lerCookies(cabecalhos.cookie).sessao || "";

  try {
    const contexto = {
      params: achado.params,
      query: query || {},
      sessao,
      conta: await auth.contaDaSessao(sessao),
      ip: ip || "?",
      body: corpo,
      base: enderecoBase(cabecalhos)
    };
    const r = await achado.fn(contexto);
    return {
      status: r.status || 200,
      corpo: r.corpo,
      cookie: r.sessao ? cookieSessao(r.sessao, false)
            : r.limparSessao ? cookieSessao("", true)
            : null
    };
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("[erro]", caminho, e);
    return {
      status,
      corpo: {
        erro: status >= 500 ? "Erro interno." : (e.message || "Erro."),
        ...(e.extra ? { detalhe: e.extra } : {})
      }
    };
  }
}

module.exports = { tratar, cookieSessao, lerCookies };
