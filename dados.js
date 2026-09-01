"use strict";
/**
 * Escolhe onde os dados ficam.
 *
 *   BANCO=supabase   -> produção na Vercel (padrão quando SUPABASE_URL existe)
 *   BANCO=sqlite     -> desenvolvimento na sua máquina
 *
 * Os dois adaptadores expõem exatamente os mesmos métodos, todos assíncronos.
 * O resto do sistema não sabe qual está em uso — é o que permite programar
 * offline e publicar no Supabase sem mudar uma linha da lógica.
 */

const escolha =
  process.env.BANCO ||
  (process.env.SUPABASE_URL ? "supabase" : "sqlite");

const repo = escolha === "supabase"
  ? require("./repo-supabase")
  : require("./repo-sqlite");

if (process.env.NODE_ENV !== "teste") {
  console.log("[dados] usando:", repo.nome);
}

module.exports = repo;
