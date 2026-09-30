// worker.js — Backend do Mike Assist no Cloudflare Workers (versão protegida)
//
// Faz a ponte entre o app e a Anthropic (guardando a chave em segredo) e
// aplica limites para controlar custo quando o app for usado por terceiros.
//
// O que mudou em relação à versão anterior:
//  - /avisos/atualizar exige o cabeçalho X-Admin-Token (segredo ADMIN_TOKEN)
//    e tem intervalo mínimo entre execuções. Sem ADMIN_TOKEN configurado,
//    o endpoint fica desligado.
//  - Tetos no pedido: tamanho do corpo, do prompt e das mensagens, nº de
//    mensagens, maxTokens e ferramentas (só a busca na web, com limite).
//  - Limites por dispositivo, POR IP e GLOBAL por dia. O limite só por
//    dispositivo era contornável, porque o deviceId é criado no navegador.
//  - CORS restrito ao site do app (antes era aberto a qualquer origem).
//  - Mensagens de erro não vazam detalhes internos.
//
// Continua compatível com o app atual: os mesmos campos no POST e a mesma
// forma de resposta.

const LIMITE_DIARIO_PADRAO = 20;   // gerações por dispositivo por dia
const LIMITE_IP_PADRAO = 60;       // gerações por IP por dia (vários aparelhos na mesma rede)
const LIMITE_GLOBAL_PADRAO = 500;  // gerações no total por dia (trava de segurança do custo)

const MODELO_PADRAO = "claude-sonnet-4-6";
const MODELO_RAPIDO = "claude-haiku-4-5-20251001";
// Só modelos desta lista podem ser pedidos pelo front-end.
const MODELOS_PERMITIDOS = [MODELO_PADRAO, MODELO_RAPIDO];

// Tetos do pedido vindo do navegador. O prompt atual do BOPM tem ~27 mil
// caracteres, então há folga para crescer.
const MAX_CORPO_CHARS = 120000;
const MAX_SYSTEM_CHARS = 60000;
const MAX_MENSAGENS = 4;
const MAX_MENSAGEM_CHARS = 8000;
const MAX_TOKENS_TETO = 1500;
const MAX_BUSCAS_POR_PEDIDO = 2;

const INTERVALO_ADMIN_SEGUNDOS = 900; // 15 min entre atualizações manuais
const ORIGENS_PADRAO = ["https://mikeassist.pages.dev"];
const SUFIXO_PREVIEWS = ".mikeassist.pages.dev"; // prévias de branch do Cloudflare Pages

// Mesmas categorias do front-end (o Cron roda sem o app aberto).
const CATEGORIAS_AVISOS = [
  {
    id: "juridico",
    query: "decisões recentes do STF e da ALERJ sobre atuação da polícia militar, segurança pública e uso da força no Rio de Janeiro",
  },
  {
    id: "institucional",
    query: "notícias institucionais recentes da PMERJ: RAS, PROEIS, editais, capacitações, resultados operacionais (fonte: site oficial sepm.rj.gov.br)",
  },
  {
    id: "normas",
    query: "atualizações públicas de boletins internos, Vade Mecum de Ocorrências ou normas de procedimento da PMERJ",
  },
];

// ---------- CORS e respostas ----------

function origemPermitida(origem, env) {
  if (!origem) return false;
  const lista = env.ORIGENS_PERMITIDAS
    ? env.ORIGENS_PERMITIDAS.split(",").map((o) => o.trim()).filter(Boolean)
    : ORIGENS_PADRAO;
  if (lista.includes(origem)) return true;
  return origem.startsWith("https://") && origem.endsWith(SUFIXO_PREVIEWS);
}

function cabecalhos(request, env) {
  const origem = request.headers.get("Origin");
  const h = {
    "Content-Type": "application/json",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  };
  // Sem a permissão de origem, o navegador bloqueia a leitura da resposta.
  // Isso não impede chamadas fora do navegador: por isso existem os limites.
  if (origemPermitida(origem, env)) h["Access-Control-Allow-Origin"] = origem;
  return h;
}

function resposta(request, env, corpo, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: cabecalhos(request, env) });
}

function igualConstante(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

// ---------- Anthropic ----------

async function chamarAnthropic(env, { system, messages, tools, maxTokens, model }) {
  const modeloEscolhido = MODELOS_PERMITIDOS.includes(model) ? model : MODELO_PADRAO;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modeloEscolhido,
      max_tokens: maxTokens || 1000,
      system,
      messages,
      ...(tools ? { tools } : {}),
    }),
  });
  return r.json();
}

function extrairTextoPlano(data) {
  if (!data || data.type === "error" || data.error) {
    const msg = data && (typeof data.error === "string" ? data.error : data.error?.message);
    throw new Error(msg || "erro desconhecido");
  }
  const blocos = (data.content || []).filter((b) => b.type === "text");
  if (blocos.length === 0) throw new Error("resposta sem texto");
  return blocos.map((b) => b.text).join("\n").trim();
}

function extrairJson(data) {
  const texto = extrairTextoPlano(data);
  const limpo = texto.replace(/```json|```/g, "").trim();
  const inicio = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (inicio === -1 || fim === -1 || fim < inicio) throw new Error("sem JSON reconhecível");
  return JSON.parse(limpo.slice(inicio, fim + 1));
}

// ---------- Atualizações (Cron / admin) ----------

// Confere se o link de uma notícia realmente abre. A IA pode devolver
// endereços que não existem (ex.: "www." indevido). Link que não abre vira
// null: a notícia continua, só sem o botão "Ver fonte".
async function linkAbre(bruto) {
  let u;
  try { u = new URL(String(bruto)); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.protocol = "https:";
  const candidatos = [u.toString()];
  if (u.hostname.startsWith("www.")) {
    const semWww = new URL(u.toString());
    semWww.hostname = u.hostname.slice(4);
    candidatos.push(semWww.toString());
  }
  for (const c of candidatos) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(c, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; MikeAssist link check)" } });
      clearTimeout(t);
      if (r.status < 400) return c;
    } catch (e) { /* tenta o próximo */ }
  }
  return null;
}

async function validarLinks(itens) {
  const lista = Array.isArray(itens) ? itens.slice(0, 6) : [];
  return Promise.all(lista.map(async (item) => ({
    ...item,
    url: item && item.url && item.url !== "null" ? await linkAbre(item.url) : null,
  })));
}

async function gerarAvisosCategoria(env, categoria) {
  const systemBusca = `Você pesquisa notícias atuais sobre: ${categoria.query}.

Use a ferramenta de busca disponível para encontrar informações recentes e confiáveis.
Depois de pesquisar, escreva um resumo em texto livre com no máximo 4 itens, cada um com: a fonte/origem, um título curto, um resumo de 1-2 frases em suas PRÓPRIAS PALAVRAS (nunca cite trechos literais), e a URL da matéria quando disponível. Não se preocupe com formato JSON aqui, apenas escreva de forma clara e organizada.

Se não encontrar nada relevante e recente, diga isso claramente.`;

  try {
    const dataBusca = await chamarAnthropic(env, {
      system: systemBusca,
      messages: [{ role: "user", content: "Busque e resuma agora." }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      maxTokens: 1200,
      model: MODELO_PADRAO,
    });
    const textoBruto = extrairTextoPlano(dataBusca);

    const systemFormatar = `Converta o texto abaixo em um JSON válido (sem markdown, sem crases), no formato exato:
{"itens": [{"fonte": "nome curto da fonte/origem", "titulo": "título curto do item", "resumo": "resumo de 1-2 frases", "url": "link da matéria original, ou null"}]}

Se o texto indicar que nada foi encontrado, responda {"itens": []}.

Texto para converter:
"""
${textoBruto}
"""`;

    let itens;
    try {
      const dataFormatada = await chamarAnthropic(env, {
        system: systemFormatar,
        messages: [{ role: "user", content: "Converta agora." }],
        maxTokens: 800,
        model: MODELO_RAPIDO,
      });
      itens = (extrairJson(dataFormatada).itens) || [];
    } catch (e) {
      itens = [{ fonte: categoria.id, titulo: "Resultado da busca", resumo: textoBruto, url: null }];
    }

    itens = await validarLinks(itens);
    return { itens, atualizadoEm: new Date().toISOString() };
  } catch (e) {
    return null;
  }
}

async function atualizarTodasAsCategorias(env, pausaMs = 1500) {
  for (const categoria of CATEGORIAS_AVISOS) {
    const resultado = await gerarAvisosCategoria(env, categoria);
    if (resultado) {
      await env.USO_KV.put(`avisos:${categoria.id}`, JSON.stringify(resultado));
    }
    await new Promise((r) => setTimeout(r, pausaMs));
  }
}

async function responderAvisosCache(request, env) {
  const resultado = {};
  for (const categoria of CATEGORIAS_AVISOS) {
    const bruto = await env.USO_KV.get(`avisos:${categoria.id}`);
    resultado[categoria.id] = bruto ? JSON.parse(bruto) : { itens: [], atualizadoEm: null };
  }
  return resposta(request, env, resultado, 200);
}

// ---------- Validação do pedido vindo do navegador ----------

function validarPedido(body) {
  if (!body || typeof body !== "object") return { erro: "Corpo da requisição inválido" };
  const { system, messages, tools, maxTokens, deviceId, model } = body;

  if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    return { erro: "deviceId ausente ou inválido" };
  }
  if (system !== undefined && (typeof system !== "string" || system.length > MAX_SYSTEM_CHARS)) {
    return { erro: "Instruções do sistema inválidas ou grandes demais", status: 413 };
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MENSAGENS) {
    return { erro: "Mensagens ausentes ou em excesso" };
  }
  const mensagens = [];
  for (const m of messages) {
    const papelOk = m && (m.role === "user" || m.role === "assistant");
    if (!papelOk || typeof m.content !== "string" || m.content.trim() === "") {
      return { erro: "Formato de mensagem inválido" };
    }
    if (m.content.length > MAX_MENSAGEM_CHARS) {
      return { erro: `Texto grande demais (máximo de ${MAX_MENSAGEM_CHARS} caracteres).`, status: 413 };
    }
    mensagens.push({ role: m.role, content: m.content });
  }

  // Única ferramenta aceita: busca na web, com número de buscas limitado.
  let ferramentas;
  if (tools !== undefined && tools !== null) {
    if (!Array.isArray(tools) || tools.length > 1) return { erro: "Ferramentas não permitidas" };
    if (tools.length === 1) {
      const t = tools[0];
      if (!t || t.type !== "web_search_20250305" || t.name !== "web_search") {
        return { erro: "Ferramenta não permitida" };
      }
      const usos = Number.isInteger(t.max_uses) ? t.max_uses : 1;
      ferramentas = [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: Math.min(Math.max(usos, 1), MAX_BUSCAS_POR_PEDIDO),
      }];
    }
  }

  const tokens = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 1000;
  return {
    ok: {
      deviceId,
      system,
      messages: mensagens,
      tools: ferramentas,
      maxTokens: Math.min(Math.max(tokens, 1), MAX_TOKENS_TETO),
      model,
    },
  };
}

function inteiroEnv(valor, padrao) {
  const n = parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

// ---------- Entrada ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      if (!origemPermitida(request.headers.get("Origin"), env)) {
        return new Response(null, { status: 403, headers: cabecalhos(request, env) });
      }
      return new Response(null, { status: 204, headers: cabecalhos(request, env) });
    }

    const url = new URL(request.url);

    // Leitura pública do cache de atualizações. Não chama a Anthropic.
    if (request.method === "GET" && url.pathname === "/avisos") {
      return responderAvisosCache(request, env);
    }

    // Atualização manual: só com token, e com intervalo mínimo entre usos.
    if (request.method === "POST" && url.pathname === "/avisos/atualizar") {
      if (!env.ADMIN_TOKEN) {
        return resposta(request, env, { error: "Endpoint desativado" }, 403);
      }
      const enviado = request.headers.get("X-Admin-Token") || "";
      if (!igualConstante(enviado, env.ADMIN_TOKEN)) {
        return resposta(request, env, { error: "Não autorizado" }, 401);
      }
      if (await env.USO_KV.get("admin:intervalo")) {
        return resposta(request, env, { error: "Aguarde alguns minutos antes de atualizar de novo." }, 429);
      }
      await env.USO_KV.put("admin:intervalo", "1", { expirationTtl: INTERVALO_ADMIN_SEGUNDOS });
      ctx.waitUntil(atualizarTodasAsCategorias(env));
      return resposta(request, env, { ok: true, mensagem: "Atualização disparada em segundo plano." }, 202);
    }

    if (request.method !== "POST") {
      return resposta(request, env, { error: "Método não permitido" }, 405);
    }

    // Tamanho do corpo: confere o cabeçalho e depois o texto recebido.
    const declarado = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (declarado > MAX_CORPO_CHARS * 4) {
      return resposta(request, env, { error: "Requisição grande demais" }, 413);
    }
    const texto = await request.text();
    if (texto.length > MAX_CORPO_CHARS) {
      return resposta(request, env, { error: "Requisição grande demais" }, 413);
    }
    let body;
    try {
      body = JSON.parse(texto);
    } catch (e) {
      return resposta(request, env, { error: "Corpo da requisição inválido" }, 400);
    }

    const v = validarPedido(body);
    if (v.erro) return resposta(request, env, { error: v.erro }, v.status || 400);
    const pedido = v.ok;

    // Limites diários: por dispositivo, por IP e global.
    const hoje = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
    const chaves = {
      dispositivo: { k: `uso:${pedido.deviceId}:${hoje}`, limite: inteiroEnv(env.LIMITE_DIARIO, LIMITE_DIARIO_PADRAO) },
      ip: { k: `uso-ip:${ip}:${hoje}`, limite: inteiroEnv(env.LIMITE_IP_DIARIO, LIMITE_IP_PADRAO) },
      global: { k: `uso-global:${hoje}`, limite: inteiroEnv(env.LIMITE_GLOBAL_DIARIO, LIMITE_GLOBAL_PADRAO) },
    };
    const uso = {};
    for (const [nome, c] of Object.entries(chaves)) {
      const bruto = await env.USO_KV.get(c.k);
      uso[nome] = bruto ? parseInt(bruto, 10) || 0 : 0;
    }
    if (uso.global >= chaves.global.limite) {
      return resposta(request, env, { error: "O serviço atingiu o limite de uso de hoje. Tente novamente amanhã." }, 429);
    }
    if (uso.ip >= chaves.ip.limite) {
      return resposta(request, env, { error: "Limite diário de usos atingido nesta rede. O limite reinicia amanhã." }, 429);
    }
    if (uso.dispositivo >= chaves.dispositivo.limite) {
      return resposta(
        request, env,
        { error: `Limite diário de ${chaves.dispositivo.limite} usos atingido neste aparelho. O limite reinicia amanhã.` },
        429
      );
    }

    let data;
    try {
      data = await chamarAnthropic(env, pedido);
    } catch (e) {
      return resposta(request, env, { error: "Falha ao contatar o serviço de IA" }, 502);
    }

    // Só conta o uso se a chamada teve sucesso.
    // (O KV não é atômico: pedidos simultâneos podem passar um pouco do limite.)
    if (!data.error) {
      for (const [nome, c] of Object.entries(chaves)) {
        await env.USO_KV.put(c.k, String(uso[nome] + 1), { expirationTtl: 60 * 60 * 24 * 2 });
      }
    }

    return resposta(request, env, data, data.error ? 400 : 200);
  },

  // Disparado pelo Cron Trigger (Settings → Triggers → Cron Triggers).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(atualizarTodasAsCategorias(env));
  },
};
