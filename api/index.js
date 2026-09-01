"use strict";
/**
 * Ponto de entrada da Vercel.
 *
 * Uma função serverless só, que recebe tudo em /api/* e entrega ao roteador
 * compartilhado. Duas funções em vez de vinte significa menos arranque a frio
 * e a mesma lógica rodando local e em produção.
 *
 * O `vercel.json` manda /api/* para cá; os arquivos de public/ a Vercel serve
 * sozinha, sem passar por aqui.
 */

/* O roteador mora em src/. Mas quando os arquivos são enviados pelo site do
   GitHub um a um, a pasta src/ se perde e tudo fica na raiz — então tentamos
   os dois lugares. Custa nada e evita um erro que só aparece em produção. */
let tratar;
try { ({ tratar } = require("../src/roteador")); }
catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
  ({ tratar } = require("../roteador"));
}

/** Lê o corpo cru. O webhook de pagamento precisa dele exatamente como veio,
 *  porque a assinatura é calculada sobre esses bytes. */
function corpoCru(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
  // A Vercel pode já ter interpretado o JSON; refazemos a string para o
  // webhook. Se a assinatura falhar em produção, veja a nota no LEIA-ME.
  if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));
  return new Promise((ok, falha) => {
    let d = "", tam = 0;
    req.on("data", (c) => {
      tam += c.length;
      if (tam > 256 * 1024) { falha(new Error("Corpo grande demais.")); req.destroy(); return; }
      d += c;
    });
    req.on("end", () => ok(d));
    req.on("error", falha);
  });
}

module.exports = async (req, res) => {
  let url;
  try { url = new URL(req.url, "https://" + (req.headers.host || "local")); }
  catch { res.status(400).json({ erro: "URL inválida." }); return; }

  /* O vercel.json reescreve /api/qualquer/coisa para /api/index?__rota=qualquer/coisa.
     Depois de uma reescrita não dá para confiar no req.url para saber o que foi
     pedido de verdade, então o caminho original viaja em __rota. Antes disso o
     arquivo se chamava [[...rota]].js — nome do Next.js, que a Vercel não
     reconhece em projeto Node puro: nenhuma rota casava e tudo dava 404. */
  const query = Object.fromEntries(url.searchParams);
  let caminho = url.pathname;
  if (typeof query.__rota === "string") {
    caminho = "/api/" + query.__rota.replace(/^\/+/, "");
    delete query.__rota;
  }

  let cru = "";
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    try { cru = await corpoCru(req); }
    catch (e) { res.status(413).json({ erro: e.message }); return; }
  }

  const r = await tratar({
    metodo: req.method,
    caminho,
    query,
    cabecalhos: req.headers,
    corpoCru: cru,
    // x-forwarded-for é confiável aqui porque a Vercel o reescreve na borda.
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?"
  });

  if (r.cookie) res.setHeader("set-cookie", r.cookie);
  res.setHeader("cache-control", "no-store");
  res.status(r.status).json(r.corpo);
};
