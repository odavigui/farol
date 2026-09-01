"use strict";
/**
 * Envio de e-mail — sem nenhuma biblioteca.
 *
 * Três modos, escolhidos por EMAIL_MODO:
 *
 *   log   (padrão em desenvolvimento) — não envia nada, imprime o link no
 *         terminal. Serve para você testar o fluxo inteiro sem configurar
 *         e-mail nenhum.
 *   smtp  — fala SMTP direto, como o Gmail espera. É o modo que você pediu.
 *   http  — manda por uma API de e-mail (Resend, Brevo). Um `fetch` só.
 *
 * O cliente SMTP abaixo é escrito na mão sobre node:tls porque não há
 * dependências neste projeto. Ele cobre exatamente o que o Gmail exige:
 * TLS na conexão, AUTH LOGIN, e uma mensagem MIME com texto e HTML.
 *
 * SOBRE O GMAIL, e isto importa antes de configurar:
 *  - A senha da sua conta NÃO funciona. É preciso gerar uma "Senha de app",
 *    que só aparece depois de ligar a verificação em duas etapas.
 *  - O limite é de umas 500 mensagens por dia. Serve para recuperação de
 *    senha; não serve para disparo em massa.
 *  - Mensagem saindo de @gmail.com para desconhecido cai em spam com mais
 *    facilidade. Quando tiver domínio próprio, troque para o modo http com
 *    domínio verificado — a entrega melhora muito.
 */

const tls = require("node:tls");
const net = require("node:net");

const MODO = process.env.EMAIL_MODO || (process.env.SMTP_USUARIO ? "smtp" : "log");
const DE = process.env.EMAIL_DE || process.env.SMTP_USUARIO || "farol@localhost";
const NOME_DE = process.env.EMAIL_NOME || "Farol";

/* ============================ SMTP ============================ */

const CRLF = "\r\n";

function conversa(socket, comandos) {
  return new Promise((ok, falha) => {
    let buffer = "";
    let etapa = 0;
    let terminado = false;

    const fim = (e, v) => {
      if (terminado) return;
      terminado = true;
      socket.removeAllListeners("data");
      e ? falha(e) : ok(v);
    };

    socket.setTimeout(20000, () => fim(new Error("O servidor de e-mail não respondeu a tempo.")));
    socket.on("error", (e) => fim(e));
    socket.on("close", () => fim(new Error("A conexão com o servidor de e-mail caiu.")));

    socket.on("data", (pedaco) => {
      buffer += pedaco.toString("utf8");

      // Uma resposta pode vir em várias linhas: "250-..." repete, e a última
      // usa espaço no lugar do hífen. Só aí a resposta terminou.
      const linhas = buffer.split(CRLF).filter(Boolean);
      const ultima = linhas[linhas.length - 1];
      if (!ultima || !/^\d{3} /.test(ultima)) return;

      const codigo = parseInt(ultima.slice(0, 3), 10);
      const passo = comandos[etapa];
      buffer = "";

      if (!passo.espera.includes(codigo)) {
        return fim(new Error(
          `${passo.nome} falhou (${codigo}): ${ultima.slice(4).trim() || "sem detalhe"}`
        ));
      }

      etapa++;
      if (etapa >= comandos.length) return fim(null, true);

      const proximo = comandos[etapa];
      if (proximo.enviar !== null && proximo.enviar !== undefined) {
        socket.write(proximo.enviar + CRLF);
      }
    });
  });
}

/** Assunto com acento precisa ser codificado, senão chega quebrado. */
function assuntoMime(txt) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(txt)) return txt;
  return "=?UTF-8?B?" + Buffer.from(txt, "utf8").toString("base64") + "?=";
}

/** Linha começando com ponto encerraria o DATA cedo demais. */
function protegerPontos(corpo) {
  return corpo.split(CRLF).map((l) => (l.startsWith(".") ? "." + l : l)).join(CRLF);
}

function montarMensagem({ de, nomeDe, para, assunto, texto, html }) {
  const limite = "farol_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cab = [
    `From: ${nomeDe} <${de}>`,
    `To: <${para}>`,
    `Subject: ${assuntoMime(assunto)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${limite}"`,
    ""
  ].join(CRLF);

  const corpo = [
    `--${limite}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(texto, "utf8").toString("base64").replace(/(.{76})/g, "$1" + CRLF),
    `--${limite}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/(.{76})/g, "$1" + CRLF),
    `--${limite}--`,
    ""
  ].join(CRLF);

  return protegerPontos(cab + corpo);
}

async function enviarSmtp({ para, assunto, texto, html }) {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const porta = Number(process.env.SMTP_PORTA || 465);
  const usuario = process.env.SMTP_USUARIO || "";
  const senha = process.env.SMTP_SENHA || "";
  const seguro = process.env.SMTP_SEGURO !== "0";   // 0 só para testar localmente

  if (!usuario || !senha) throw new Error("SMTP_USUARIO e SMTP_SENHA não configurados.");

  const mensagem = montarMensagem({ de: DE, nomeDe: NOME_DE, para, assunto, texto, html });

  const socket = seguro
    ? tls.connect({ host, port: porta, servername: host })
    : net.connect({ host, port: porta });

  const comandos = [
    { nome: "conexão",  enviar: null,                                         espera: [220] },
    { nome: "EHLO",     enviar: "EHLO farol",                                 espera: [250] },
    { nome: "AUTH",     enviar: "AUTH LOGIN",                                 espera: [334] },
    { nome: "usuário",  enviar: Buffer.from(usuario).toString("base64"),      espera: [334] },
    { nome: "senha",    enviar: Buffer.from(senha).toString("base64"),        espera: [235] },
    { nome: "MAIL FROM",enviar: `MAIL FROM:<${DE}>`,                          espera: [250] },
    { nome: "RCPT TO",  enviar: `RCPT TO:<${para}>`,                          espera: [250, 251] },
    { nome: "DATA",     enviar: "DATA",                                       espera: [354] },
    { nome: "mensagem", enviar: mensagem + CRLF + ".",                        espera: [250] },
    { nome: "QUIT",     enviar: "QUIT",                                       espera: [221] }
  ];

  try {
    await conversa(socket, comandos);
  } finally {
    socket.destroy();
  }
  return { ok: true, via: "smtp" };
}

/* ============================ HTTP ============================ */
/** Para quando você tiver domínio próprio. Resend por padrão; a mesma
 *  chamada serve para qualquer serviço que aceite JSON. */
async function enviarHttp({ para, assunto, texto, html }) {
  const url = process.env.EMAIL_API_URL || "https://api.resend.com/emails";
  const chave = process.env.EMAIL_API_CHAVE;
  if (!chave) throw new Error("EMAIL_API_CHAVE não configurada.");

  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer " + chave, "content-type": "application/json" },
    body: JSON.stringify({ from: `${NOME_DE} <${DE}>`, to: [para], subject: assunto, text: texto, html })
  });
  if (!r.ok) throw new Error("API de e-mail respondeu " + r.status + ": " + (await r.text()).slice(0, 200));
  return { ok: true, via: "http" };
}

/* ============================ envio ============================ */
async function enviar({ para, assunto, texto, html }) {
  if (MODO === "log") {
    console.log("\n────────── E-MAIL (modo log, nada foi enviado) ──────────");
    console.log("para:", para);
    console.log("assunto:", assunto);
    console.log(texto);
    console.log("─────────────────────────────────────────────────────────\n");
    return { ok: true, via: "log" };
  }
  if (MODO === "http") return enviarHttp({ para, assunto, texto, html });
  return enviarSmtp({ para, assunto, texto, html });
}

/* ---------------- mensagem de recuperação ---------------- */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

function emailRecuperacao({ agencia, link, minutos }) {
  const texto =
`Olá, ${agencia}.

Alguém pediu para redefinir a senha da sua conta no Farol.

Abra este link para criar uma senha nova:
${link}

O link vale por ${minutos} minutos e só funciona uma vez.

Se não foi você que pediu, ignore esta mensagem — sua senha continua a mesma
e ninguém consegue entrar sem o link.

— Farol`;

  const html =
`<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F4F6FB;padding:32px 16px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:2px solid #0B1020;padding:32px 28px">
    <p style="margin:0 0 6px;font:600 11px/1.4 monospace;letter-spacing:.18em;text-transform:uppercase;color:#1435C8">Farol</p>
    <h1 style="margin:0 0 18px;font:800 26px/1.15 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:-.02em;color:#0B1020">Redefinir sua senha</h1>
    <p style="margin:0 0 14px;font-size:15.5px;line-height:1.6;color:#454C63">Olá, ${esc(agencia)}. Alguém pediu para redefinir a senha da sua conta.</p>
    <p style="margin:0 0 24px;font-size:15.5px;line-height:1.6;color:#454C63">Clique no botão para criar uma senha nova. O link vale por <strong style="color:#0B1020">${minutos} minutos</strong> e só funciona uma vez.</p>
    <a href="${esc(link)}" style="display:inline-block;background:#FF5B45;color:#0B1020;font:700 16px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:15px 26px;text-decoration:none;border:2px solid #FF5B45">Criar senha nova</a>
    <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#767D93">Se o botão não funcionar, copie este endereço:<br><span style="color:#1435C8;word-break:break-all">${esc(link)}</span></p>
    <p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #D8DEEE;font-size:13.5px;line-height:1.6;color:#767D93">Se não foi você que pediu, ignore esta mensagem. Sua senha continua a mesma e ninguém consegue entrar sem o link.</p>
  </div>
</div>`;

  return { assunto: "Redefinir sua senha no Farol", texto, html };
}

module.exports = { enviar, emailRecuperacao, MODO };
