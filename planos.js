"use strict";
/**
 * Planos e o que cada um libera.
 *
 * Este arquivo é a ÚNICA fonte da verdade sobre limites. O navegador recebe
 * uma cópia só para desenhar a interface (esconder botão, mostrar aviso), mas
 * quem decide é sempre o servidor, nas funções exigirVaga e exigirRecurso.
 *
 * A regra prática: se uma checagem existe só no front-end, ela não existe.
 */

const PLANOS = {
  essencial: {
    id: "essencial", nome: "Essencial", preco: 97, maxClientes: 5,
    recursos: { clienteFinal: false, marcaPdf: false, alertas: false, multiUsuario: false }
  },
  agencia: {
    id: "agencia", nome: "Agência", preco: 197, maxClientes: 15,
    recursos: { clienteFinal: true, marcaPdf: true, alertas: true, multiUsuario: false }
  },
  estudio: {
    id: "estudio", nome: "Estúdio", preco: 397, maxClientes: 40,
    recursos: { clienteFinal: true, marcaPdf: true, alertas: true, multiUsuario: true }
  }
};

const PADRAO = "essencial";

function plano(idPlano) {
  return PLANOS[idPlano] || PLANOS[PADRAO];
}

const DIAS_TESTE = 14;

/**
 * O teste acabou?
 *
 * Vale só para conta ainda em "teste": assim que um pagamento entra, o status
 * vira "ativa" e o prazo deixa de importar. Sem esta função o teste nunca
 * terminava — quem criasse conta usava o Farol de graça para sempre, e foi
 * exatamente o que aconteceu até aqui.
 */
function testeVencido(conta) {
  return !!(conta && conta.status === "teste" && conta.teste_ate
            && conta.teste_ate < new Date().toISOString());
}

/** Quantos dias ainda faltam. Negativo quando já passou; null se não é teste. */
function diasDeTeste(conta) {
  if (!conta || conta.status !== "teste" || !conta.teste_ate) return null;
  return Math.max(0, Math.ceil((new Date(conta.teste_ate) - Date.now()) / 864e5));
}

/** Conta em teste ou ativa usa o plano dela. Inadimplente cai para o mínimo. */
function planoEfetivo(conta) {
  if (!conta) return PLANOS[PADRAO];
  if (conta.status === "inadimplente" || conta.status === "cancelada") return PLANOS[PADRAO];
  return plano(conta.plano);
}

/**
 * Portão de escrita.
 *
 * Teste vencido NÃO derruba o login e NÃO apaga nada: a agência continua
 * entrando, vendo a carteira e exportando os relatórios. O que trava é
 * cadastrar coisa nova. Bloquear a entrada seria pior para os dois lados —
 * ela não conseguiria nem assinar, nem levar os dados embora, e a lei lhe
 * garante acesso ao que é dela.
 */
function exigirEscrita(conta) {
  if (testeVencido(conta)) {
    throw erro(402,
      `Seus ${DIAS_TESTE} dias de teste terminaram. Escolha um plano para voltar a cadastrar — ` +
      "seus dados continuam aqui, intactos.",
      { motivo: "teste_vencido", testeAte: conta.teste_ate });
  }
}

function erro(status, msg, extra) {
  const e = new Error(msg);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

/** Barra o cadastro de mais um cliente quando a carteira está cheia. */
function exigirVaga(conta, usados) {
  exigirEscrita(conta);
  const p = planoEfetivo(conta);
  if (usados >= p.maxClientes) {
    throw erro(402,
      `O plano ${p.nome} comporta ${p.maxClientes} clientes e você já está usando todos.`,
      { motivo: "limite_clientes", plano: p.id, max: p.maxClientes, usados });
  }
}

/** Barra o uso de um recurso que o plano não inclui. */
function exigirRecurso(conta, recurso) {
  exigirEscrita(conta);
  const p = planoEfetivo(conta);
  if (!p.recursos[recurso]) {
    throw erro(402,
      `Este recurso não está incluído no plano ${p.nome}.`,
      { motivo: "recurso_bloqueado", recurso, plano: p.id });
  }
}

function paraCliente(conta, usados) {
  const p = planoEfetivo(conta);
  return {
    id: p.id, nome: p.nome, preco: p.preco, maxClientes: p.maxClientes,
    recursos: p.recursos, usados,
    status: conta ? conta.status : "teste",
    testeAte: conta ? conta.teste_ate : null,
    testeVencido: testeVencido(conta),
    diasDeTeste: diasDeTeste(conta),
    diasTeste: DIAS_TESTE,
    catalogo: Object.values(PLANOS).map((x) => ({
      id: x.id, nome: x.nome, preco: x.preco, maxClientes: x.maxClientes, recursos: x.recursos
    }))
  };
}

module.exports = {
  PLANOS, PADRAO, DIAS_TESTE, plano, planoEfetivo,
  testeVencido, diasDeTeste, exigirEscrita,
  exigirVaga, exigirRecurso, paraCliente
};
