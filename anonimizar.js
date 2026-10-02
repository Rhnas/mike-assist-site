// anonimizar.js — Esconde dados pessoais do relato ANTES de enviar à IA.
//
// Roda só no aparelho: o texto original nunca sai do celular. Troca CPF,
// RG, telefone, placa, e-mail e CEP por marcadores ([CPF], [placa] etc.).
// A IA é instruída a manter o marcador no histórico, e o policial preenche
// o dado verdadeiro depois, direto no sistema oficial.
//
// Nomes de pessoas não são detectados (não dá para fazer isso com segurança
// sem errar nomes de ruas e lugares): o aviso na tela continua valendo.
//
// JavaScript puro, carregado antes do app. Também funciona no Node, para
// os testes: node testes/anonimizar.test.mjs

(function () {
  // A ordem importa: CPF e RG antes de telefone, e-mail antes de tudo.
  const REGRAS = [
    { tipo: "e-mail", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
    { tipo: "CPF", re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
    // RG/identidade só quando a palavra aparece antes, para não pegar outros números.
    { tipo: "RG", re: /\b(rg|identidade)(\s*(n[º°o.]?|numero|número))?\s*[:\-]?\s*[\dxX][\d.\-\/xX]{4,}[\dxX]/gi, manterPrefixo: true },
    { tipo: "CEP", re: /\b\d{5}-\d{3}\b/g },
    // Telefone: com DDD opcional, 8 ou 9 dígitos, com ou sem separador.
    { tipo: "telefone", re: /(\(?\b\d{2}\)?[\s.-]?)?\b9?\d{4}[\s.-]?\d{4}\b/g },
    // Placa antiga (ABC-1234) e Mercosul (ABC1D23).
    { tipo: "placa", re: /\b[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}\b/g },
  ];

  function anonimizar(texto) {
    let resultado = String(texto || "");
    const contagem = {};
    for (const regra of REGRAS) {
      resultado = resultado.replace(regra.re, (achado, prefixo) => {
        // Telefone precisa de pelo menos 8 dígitos (evita pegar quantidades).
        if (regra.tipo === "telefone" && achado.replace(/\D/g, "").length < 8) return achado;
        contagem[regra.tipo] = (contagem[regra.tipo] || 0) + 1;
        if (regra.manterPrefixo) return `${prefixo.toUpperCase()} [${regra.tipo}]`;
        return `[${regra.tipo}]`;
      });
    }
    return { texto: resultado, contagem };
  }

  // "1 CPF e 2 telefones" — para avisar o policial do que foi escondido.
  function resumoAnonimizacao(contagem) {
    const partes = Object.entries(contagem).map(([tipo, n]) => {
      return `${n} ${n > 1 ? tipo + "s" : tipo}`;
    });
    if (partes.length === 0) return "";
    if (partes.length === 1) return partes[0];
    return partes.slice(0, -1).join(", ") + " e " + partes[partes.length - 1];
  }

  const api = { anonimizar, resumoAnonimizacao };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.MikeAnonimizar = api;
})();
