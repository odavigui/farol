"use strict";
/**
 * Servidor de desenvolvimento — só para rodar na sua máquina.
 *
 *   node servidor.js
 *
 * Em produção quem atende é api/[[...rota]].js, na Vercel. Os dois usam o
 * MESMO roteador (src/roteador.js), então o comportamento é idêntico: é o
 * que impede aquele bug que só aparece depois de publicar.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { tratar } = require("./src/roteador");

const PORTA = Number(process.env.PORTA || 3000);
const PUBLICO = path.join(__dirname, "public");
const LIMITE_CORPO = 256 * 1024;

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon"
};

function corpo(req) {
  return new Promise((ok, falha) => {
    let d = "", tam = 0;
    req.on("data", (c) => {
      tam += c.length;
      if (tam > LIMITE_CORPO) { falha(Object.assign(new Error("Corpo grande demais."), { status: 413 })); req.destroy(); return; }
      d += c;
    });
    req.on("end", () => ok(d));
    req.on("error", falha);
  });
}

function servirArquivo(res, arquivo) {
  fs.readFile(arquivo, (e, dados) => {
    if (e) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"erro":"Não encontrado."}'); return; }
    res.writeHead(200, {
      "content-type": TIPOS[path.extname(arquivo).toLowerCase()] || "application/octet-stream",
      "content-length": dados.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    });
    res.end(dados);
  });
}

const servidor = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://" + (req.headers.host || "local")); }
  catch { res.writeHead(400); res.end(); return; }

  const caminho = url.pathname;

  if (caminho.startsWith("/api/")) {
    let cru = "";
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      try { cru = await corpo(req); }
      catch (e) { res.writeHead(e.status || 400, { "content-type": "application/json" }); res.end(JSON.stringify({ erro: e.message })); return; }
    }
    const r = await tratar({
      metodo: req.method, caminho,
      query: Object.fromEntries(url.searchParams),
      cabecalhos: req.headers, corpoCru: cru,
      ip: req.socket.remoteAddress || "?"
    });
    const cab = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    if (r.cookie) cab["set-cookie"] = r.cookie;
    res.writeHead(r.status, cab);
    res.end(JSON.stringify(r.corpo));
    return;
  }

  if (caminho.startsWith("/r/")) { servirArquivo(res, path.join(PUBLICO, "relatorio.html")); return; }

  const arquivo = caminho === "/" ? "index.html"
                : (caminho === "/app" || caminho === "/entrar") ? "app.html"
                : caminho.replace(/^\//, "");
  const destino = path.join(PUBLICO, arquivo);
  if (!destino.startsWith(PUBLICO)) { res.writeHead(403); res.end(); return; }

  fs.stat(destino, (e, st) => {
    servirArquivo(res, (e || !st.isFile()) ? path.join(PUBLICO, "index.html") : destino);
  });
});

servidor.listen(PORTA, () => {
  console.log(`Farol (desenvolvimento) em http://localhost:${PORTA}`);
  if (!process.env.SEGREDO_WEBHOOK)
    console.log("Aviso: SEGREDO_WEBHOOK não configurado — o webhook de pagamento vai recusar tudo.");
});

module.exports = { servidor };
