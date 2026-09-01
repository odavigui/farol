"use strict";
/**
 * Motor de métricas e diagnóstico.
 *
 * Isto roda NO SERVIDOR de propósito. É a parte do produto que tem valor:
 * se ela fosse para o navegador, qualquer concorrente abriria o código-fonte
 * da página e copiaria as regras em dez minutos. O navegador recebe só o
 * resultado pronto.
 *
 * Todas as regras descrevem ASSOCIAÇÃO, nunca causa. O texto é escrito como
 * "andou junto com". Uma ferramenta que promete causalidade coloca a agência
 * numa reunião impossível de defender no primeiro mês em que o número cai.
 */

const DIA = 864e5;

const nl = (n) => Math.round(n).toLocaleString("pt-BR");
const nk = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(".", ",") + "k" : nl(n));
const pc = (v, d = 1) => (v * 100).toFixed(d).replace(".", ",") + "%";
const vg = (n, d = 1) => n.toFixed(d).replace(".", ",");

function diasAtras(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DIA));
}

function engaj(p) {
  return p.alcance > 0 ? p.interacoes / p.alcance : 0;
}

function agregar(lista) {
  const a = { alcance: 0, views: 0, interacoes: 0, salvos: 0, cliques: 0, posts: lista.length, videos: 0 };
  for (const p of lista) {
    a.alcance += p.alcance; a.views += p.views;
    a.interacoes += p.interacoes; a.salvos += p.salvos; a.cliques += p.cliques;
    if (p.formato === "Reels") a.videos++;
  }
  a.engajamento = a.alcance > 0 ? a.interacoes / a.alcance : 0;
  return a;
}

function mediana(arr) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}

const eficiencia = (m) => (m.alcance > 0 ? (m.resultado / m.alcance) * 1000 : 0);

/** Compara os meses de muito esforço com os de pouco, num critério só. */
function contraste(historico, campo) {
  if (historico.length < 4) return null;
  const med = mediana(historico.map((x) => x[campo]));
  const alto = historico.filter((x) => x[campo] >= med);
  const baixo = historico.filter((x) => x[campo] < med);
  if (!alto.length || !baixo.length) return null;
  const ma = alto.reduce((s, x) => s + x.resultado, 0) / alto.length;
  const mb = baixo.reduce((s, x) => s + x.resultado, 0) / baixo.length;
  if (mb <= 0) return null;
  return { med, mediaAlto: ma, mediaBaixo: mb, ganho: (ma - mb) / mb, nAlto: alto.length, nBaixo: baixo.length };
}

/**
 * @param cliente     linha da tabela clientes
 * @param publicacoes publicações do período, mais antigas primeiro
 * @param anteriores  publicações da janela anterior de mesma duração
 * @param historico   resultados mensais, mais antigos primeiro
 */
function diagnosticar({ cliente, publicacoes, anteriores, historico, dias }) {
  const out = [];
  const met = cliente.metrica || "resultados";

  /* ================= entrega ================= */
  if (publicacoes.length < 3) {
    out.push({
      tipo: "wa",
      t: "Dados insuficientes para diagnóstico",
      d: `Este cliente tem ${publicacoes.length} publicação(ões) lançada(s) no período. O sistema precisa de pelo menos 3 para comparar.`,
      a: "Lance os números das publicações anteriores em Lançar publicação."
    });
  } else {
    const ag = agregar(publicacoes);

    // 1. formato que mais entrega — Stories fora, é outra superfície
    const porF = {};
    for (const p of publicacoes.filter((x) => x.formato !== "Stories")) {
      (porF[p.formato] ||= { soma: 0, n: 0 });
      porF[p.formato].soma += p.alcance; porF[p.formato].n++;
    }
    const fmts = Object.entries(porF)
      .map(([f, v]) => ({ f, med: v.soma / v.n, n: v.n }))
      .sort((a, b) => b.med - a.med);
    if (fmts.length >= 2 && fmts.at(-1).med > 0) {
      const mult = fmts[0].med / fmts.at(-1).med;
      if (mult >= 1.8) {
        out.push({
          tipo: "ok",
          t: `${fmts[0].f} entrega ${vg(mult)}× mais que ${fmts.at(-1).f}`,
          d: `Alcance médio de ${nk(fmts[0].med)} por ${fmts[0].f.toLowerCase()} contra ${nk(fmts.at(-1).med)} por ${fmts.at(-1).f.toLowerCase()}, em ${publicacoes.length} publicações do período.`,
          a: `Realoque a produção: troque metade dos ${fmts.at(-1).f.toLowerCase()} por ${fmts[0].f.toLowerCase()} no próximo ciclo e reavalie em 30 dias.`
        });
      }
    }

    // 2. campeão de entrega
    const top = [...publicacoes].sort((a, b) => b.alcance - a.alcance)[0];
    const medPer = ag.alcance / publicacoes.length;
    out.push({
      tipo: "ac",
      t: `Melhor entrega: "${top.titulo}"`,
      d: `${nk(top.alcance)} de alcance em ${top.plataforma}, formato ${top.formato}, publicado às ${top.hora}h. Foi ${vg(top.alcance / (medPer || 1))}× a média do período.`,
      a: "Replique o padrão: mesmo formato, mesma faixa de horário e mesmo tipo de gancho na abertura.",
      url: top.url || null
    });

    // 3. alcance alto ≠ engajamento alto
    const topEng = publicacoes.filter((p) => p.alcance > 1000).sort((a, b) => engaj(b) - engaj(a))[0];
    if (topEng && topEng.id !== top.id) {
      out.push({
        tipo: "ac",
        t: "Quem mais entregou não foi quem mais engajou",
        d: `"${topEng.titulo}" teve ${pc(engaj(topEng))} de engajamento sobre alcance, acima de "${top.titulo}" (${pc(engaj(top))}), mesmo alcançando menos gente.`,
        a: "Use o formato do campeão de alcance para atrair e o do campeão de engajamento para converter. São papéis diferentes."
      });
    }

    // 4. tendência
    const agAnt = agregar(anteriores);
    if (agAnt.alcance > 0) {
      const d = (ag.alcance - agAnt.alcance) / agAnt.alcance;
      if (d <= -0.15) {
        out.push({
          tipo: "cr",
          t: `Alcance caiu ${pc(Math.abs(d), 0)} em relação ao período anterior`,
          d: "É queda relevante e precisa entrar na conversa com o cliente antes que ele pergunte.",
          a: "Verifique frequência de postagem e formato. Queda de alcance quase sempre vem de menos publicações ou de troca de formato."
        });
      } else if (d >= 0.15) {
        out.push({
          tipo: "ok",
          t: `Alcance cresceu ${pc(d, 0)} no período`,
          d: "Crescimento consistente comparado à janela anterior de mesma duração.",
          a: "Documente o que mudou neste ciclo e transforme em processo — é isso que renova contrato."
        });
      }
    }

    // 5. frequência
    const semanas = dias / 7;
    const freq = publicacoes.length / semanas;
    const freqAnt = anteriores.length / semanas;
    if (freqAnt > 0 && freq < freqAnt * 0.75) {
      out.push({
        tipo: "wa",
        t: `Frequência caiu de ${vg(freqAnt)} para ${vg(freq)} posts por semana`,
        d: "Menos publicação é a causa mais comum de queda de alcance — e a mais fácil de corrigir.",
        a: `Volte ao ritmo contratado (${cliente.plano_txt || "o combinado"}) antes de mexer em qualquer outra coisa.`
      });
    }

    // 6. horário
    const manha = publicacoes.filter((p) => p.hora < 15);
    const noite = publicacoes.filter((p) => p.hora >= 17);
    if (manha.length >= 2 && noite.length >= 2) {
      const mm = agregar(manha).alcance / manha.length;
      const mn = agregar(noite).alcance / noite.length;
      if (mn > mm * 1.5) {
        out.push({
          tipo: "ok",
          t: `Publicações a partir das 17h entregam ${vg(mn / mm)}× mais`,
          d: `Média de ${nk(mn)} à noite contra ${nk(mm)} nos horários da manhã e do começo da tarde.`,
          a: "Concentre as publicações principais entre 17h e 21h e deixe a manhã para conteúdo de apoio."
        });
      } else if (mm > mn * 1.5) {
        out.push({
          tipo: "ok",
          t: `Publicações da manhã entregam ${vg(mm / mn)}× mais`,
          d: `Média de ${nk(mm)} pela manhã contra ${nk(mn)} no fim da tarde e à noite.`,
          a: "Mova os posts principais para antes das 15h e teste por 30 dias."
        });
      }
    }

    // 7. salvamentos
    const taxaSal = ag.alcance > 0 ? ag.salvos / ag.alcance : 0;
    if (taxaSal >= 0.05) {
      out.push({
        tipo: "ok",
        t: `Conteúdo com alta taxa de salvamento (${pc(taxaSal)})`,
        d: "Salvamento é o sinal de que o conteúdo é útil, não só bonito. Esse cliente acerta na utilidade.",
        a: "Leve isso para o relatório: salvamento é o argumento mais forte para justificar conteúdo educativo."
      });
    } else if (taxaSal < 0.012 && ag.posts >= 4) {
      out.push({
        tipo: "wa",
        t: `Poucos salvamentos (${pc(taxaSal)} do alcance)`,
        d: "O conteúdo entretém mas não é guardado para depois. Falta material de referência: preço, como fazer, comparação, passo a passo.",
        a: "Inclua um conteúdo salvável por semana — tabela, guia ou lista — e acompanhe a taxa por 30 dias."
      });
    }
  }

  /* ================= esforço x resultado ================= */
  if (historico.length >= 4) {
    const ult = historico.at(-1), pen = historico.at(-2);

    const cr = contraste(historico, "reels");
    if (cr && cr.ganho >= 0.2) {
      out.push({
        tipo: "ok",
        t: `Meses com mais vídeo andaram junto com mais ${met}`,
        d: `Nos ${cr.nAlto} meses com ${cr.med} ou mais Reels, a média foi de ${nl(cr.mediaAlto)} ${met}. Nos ${cr.nBaixo} meses abaixo disso, ${nl(cr.mediaBaixo)}. Diferença de ${pc(cr.ganho, 0)}.`,
        a: `Leve este número para a reunião de renovação e proponha travar o mínimo de ${cr.med} Reels por mês em contrato.`,
        nota: "Associação observada no histórico, não prova de causa. Use como direção, não como promessa ao cliente."
      });
    }

    if (ult.alcance > pen.alcance * 1.1 && ult.resultado < pen.resultado * 1.02) {
      out.push({
        tipo: "cr",
        t: `O alcance subiu e os ${met} não acompanharam`,
        d: `De ${pen.rotulo} para ${ult.rotulo} o alcance cresceu ${pc((ult.alcance - pen.alcance) / pen.alcance, 0)}, mas o resultado ficou praticamente igual. O conteúdo está atraindo gente que não compra.`,
        a: "Troque parte do conteúdo de alcance por conteúdo de decisão: preço, como pedir, prova de cliente, chamada clara para a ação."
      });
    }

    const ef = eficiencia(ult), efP = eficiencia(pen);
    if (efP > 0) {
      const d = (ef - efP) / efP;
      if (Math.abs(d) >= 0.15) {
        out.push({
          tipo: d > 0 ? "ok" : "wa",
          t: `Cada mil pessoas alcançadas viraram ${vg(ef)} ${met} em ${ult.rotulo}`,
          d: `Em ${pen.rotulo} eram ${vg(efP)}. A eficiência ${d > 0 ? "subiu" : "caiu"} ${pc(Math.abs(d), 0)} — este número mostra qualidade da audiência, e não tamanho dela.`,
          a: d > 0
            ? "Identifique o que mudou no conteúdo deste mês e transforme em padrão fixo da produção."
            : "Alcance maior com eficiência menor costuma ser público errado. Revise segmentação e o gancho de abertura."
        });
      }
    }

    const melhor = [...historico].sort((a, b) => b.resultado - a.resultado)[0];
    if (melhor.competencia === ult.competencia) {
      out.push({
        tipo: "ok",
        t: `${ult.rotulo} foi o melhor mês dos últimos ${historico.length}`,
        d: `${nl(ult.resultado)} ${met}, com ${ult.posts} publicações e ${nk(ult.alcance)} de alcance.`,
        a: "Abra a reunião com este número. É a frase que renova contrato antes de qualquer gráfico aparecer."
      });
    }

    if (!ult.resultado) {
      out.push({
        tipo: "wa",
        t: `Falta lançar o resultado de ${ult.rotulo}`,
        d: `Sem o número de ${met} do mês, o sistema mede esforço mas não consegue provar retorno.`,
        a: "Peça o número ao cliente na primeira semana do mês. Uma pergunta no WhatsApp resolve."
      });
    }
  } else {
    out.push({
      tipo: "wa",
      t: "Sem histórico comercial suficiente",
      d: "Com menos de 4 meses de resultado lançado não dá para cruzar esforço e retorno com honestidade.",
      a: "Lance os meses anteriores em Resultado do mês — o cliente costuma ter esses números guardados."
    });
  }

  return out;
}

/* ---------- leitura do link, sem depender de API ---------- */
const PADROES = [
  [/instagram\.com\/reels?\/([A-Za-z0-9_-]+)/i, "Instagram", "Reels", true],
  [/instagram\.com\/tv\/([A-Za-z0-9_-]+)/i, "Instagram", "Reels", true],
  [/instagram\.com\/stories\/[^/]+\/(\d+)/i, "Instagram", "Stories", true],
  [/instagram\.com\/p\/([A-Za-z0-9_-]+)/i, "Instagram", "Carrossel", false],
  [/tiktok\.com\/@[^/]+\/video\/(\d+)/i, "TikTok", "Reels", true],
  [/(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i, "TikTok", "Reels", false],
  [/youtube\.com\/shorts\/([A-Za-z0-9_-]+)/i, "YouTube", "Reels", true],
  [/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]+)/i, "YouTube", "Reels", false],
  [/facebook\.com\/reel\/(\d+)/i, "Facebook", "Reels", true],
  [/facebook\.com\/[^/]+\/videos\/(\d+)/i, "Facebook", "Reels", true],
  [/facebook\.com\/[^/]+\/posts\/([A-Za-z0-9]+)/i, "Facebook", "Foto", false]
];

function lerLink(url) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, motivo: "vazio" };
  for (const [re, p, f, certo] of PADROES) {
    const m = u.match(re);
    if (m) return { ok: true, plataforma: p, formato: f, certo, codigo: m[1], url: u };
  }
  return { ok: false, motivo: /^https?:\/\//i.test(u) ? "nao_reconhecido" : "invalido", url: u };
}

module.exports = { agregar, engaj, eficiencia, contraste, diagnosticar, lerLink, diasAtras, mediana };
