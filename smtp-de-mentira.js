"use strict";
/**
 * Servidor SMTP de mentira — só para testar.
 *
 * Fala o mínimo que o cliente de e-mail espera e guarda a mensagem recebida
 * em testes/caixa-de-entrada.txt. Não envia nada para lugar nenhum.
 *
 *   node testes/smtp-de-mentira.js
 *   SMTP_SEGURO=0 SMTP_HOST=127.0.0.1 SMTP_PORTA=2525 \
 *   SMTP_USUARIO=teste SMTP_SENHA=teste node servidor.js
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const PORTA = Number(process.env.PORTA_FALSA || 2525);
const CAIXA = path.join(__dirname, "caixa-de-entrada.txt");

net.createServer((s) => {
  let emDados = false;
  let mensagem = "";
  let passoAuth = 0;   // 0 = fora, 1 = esperando usuário, 2 = esperando senha

  s.write("220 mentira.local pronto\r\n");

  s.on("data", (b) => {
    const bruto = b.toString("utf8");

    if (emDados) {
      mensagem += bruto;
      if (/\r\n\.\r\n$|^\.\r\n$/.test(mensagem)) {
        emDados = false;
        const corpo = mensagem.replace(/\r\n\.\r\n$/, "");
        fs.appendFileSync(CAIXA, "\n===== " + new Date().toISOString() + " =====\n" + corpo + "\n");
        console.log("[smtp-mentira] mensagem guardada (" + corpo.length + " bytes)");
        s.write("250 2.0.0 aceita\r\n");
      }
      return;
    }

    for (const linha of bruto.split("\r\n").filter(Boolean)) {
      const cmd = linha.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") {
        // Resposta de várias linhas de propósito: é aqui que um cliente mal
        // escrito quebra, então o teste precisa passar por isso.
        s.write("250-mentira.local\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n");
      } else if (linha.toUpperCase().startsWith("AUTH LOGIN")) {
        passoAuth = 1;
        s.write("334 VXNlcm5hbWU6\r\n");        // "Username:"
      } else if (passoAuth === 1) {
        passoAuth = 2;
        console.log("[smtp-mentira] usuário:", Buffer.from(linha.trim(), "base64").toString());
        s.write("334 UGFzc3dvcmQ6\r\n");        // "Password:"
      } else if (passoAuth === 2) {
        passoAuth = 0;
        s.write("235 2.7.0 autenticado\r\n");
      } else if (cmd === "MAIL") {
        s.write("250 2.1.0 ok\r\n");
      } else if (cmd === "RCPT") {
        s.write("250 2.1.5 ok\r\n");
      } else if (cmd === "DATA") {
        emDados = true; mensagem = "";
        s.write("354 manda\r\n");
      } else if (cmd === "QUIT") {
        s.write("221 2.0.0 tchau\r\n"); s.end();
      } else {
        s.write("250 ok\r\n");
      }
    }
  });

  s.on("error", () => {});
}).listen(PORTA, "127.0.0.1", () => {
  console.log("[smtp-mentira] escutando em 127.0.0.1:" + PORTA);
  console.log("[smtp-mentira] guardando em " + CAIXA);
});
