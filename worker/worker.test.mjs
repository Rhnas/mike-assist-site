// Testes do Worker — rodam localmente, sem Cloudflare e sem gastar crédito.
// KV e a API da Anthropic são simulados.
//
// Como rodar (Node 18+ ou Bun), a partir da raiz do repositório:
//     node worker/worker.test.mjs
//
// O teste do botão de atualização espera ~5 s (pausas entre categorias).

import worker from "./worker.js";

let falhas = 0;
let total = 0;
function confere(descricao, condicao, detalhe = "") {
  total++;
  if (condicao) {
    console.log(`  ✓ ${descricao}`);
  } else {
    falhas++;
    console.log(`  ✗ ${descricao} ${detalhe}`);
  }
}

class KV {
  constructor() { this.m = new Map(); this.puts = []; }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v, o) { this.m.set(k, String(v)); this.puts.push([k, o]); }
}

const CHAVE_SECRETA = "sk-ant-CHAVE-DE-TESTE-NAO-VAZAR";
const ORIGEM_OK = "https://mikeassist.pages.dev";
let chamadas = [];
let modoFetch = "ok"; // "ok" | "erro-api" | "rede" | "noticias"
const linksTestados = [];

globalThis.fetch = async (url, init) => {
  if (init && init.method === "GET") { // verificação de links das notícias
    linksTestados.push(String(url));
    if (String(url).startsWith("https://portal.stf.jus.br/") || String(url) === "https://ok.example/a") return new Response("ok", { status: 200 });
    throw new Error("ENOTFOUND");
  }
  if (modoFetch === "noticias" && init.body.includes("Converta agora")) {
    const itens = [
      { fonte: "STF", titulo: "a", resumo: "r", url: "https://www.portal.stf.jus.br/x" },
      { fonte: "X", titulo: "b", resumo: "r", url: "https://ok.example/a" },
      { fonte: "Y", titulo: "c", resumo: "r", url: "https://morto.example/z" },
      { fonte: "Z", titulo: "d", resumo: "r", url: "javascript:alert(1)" },
    ];
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ itens }) }] }), { status: 200 });
  }
  chamadas.push({ url, init, corpo: JSON.parse(init.body) });
  if (modoFetch === "rede") throw new Error("ECONNRESET interno secreto");
  if (modoFetch === "erro-api") {
    return new Response(JSON.stringify({ type: "error", error: { message: "overloaded" } }), { status: 529 });
  }
  return new Response(JSON.stringify({ content: [{ type: "text", text: "texto de teste" }] }), { status: 200 });
};

function novoAmbiente(extra = {}) {
  return { USO_KV: new KV(), ANTHROPIC_API_KEY: CHAVE_SECRETA, ...extra };
}

async function chamar(env, caminho, { metodo = "POST", corpo, cabecalhos = {}, ip = "203.0.113.1", origem = ORIGEM_OK } = {}) {
  const esperas = [];
  const ctx = { waitUntil: (p) => esperas.push(p) };
  const headers = { "CF-Connecting-IP": ip, ...cabecalhos };
  if (origem) headers["Origin"] = origem;
  if (corpo !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request("https://worker.test" + caminho, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
  });
  const res = await worker.fetch(req, env, ctx);
  await Promise.all(esperas);
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch {}
  return { status: res.status, headers: res.headers, texto, json };
}

const pedidoOk = (extra = {}) => ({
  deviceId: "aparelho-de-teste-001",
  system: "Você é um assistente.",
  messages: [{ role: "user", content: "relato de teste" }],
  ...extra,
});

async function main() {
  console.log("\nAdmin: /avisos/atualizar");
  {
    let env = novoAmbiente();
    chamadas = [];
    let r = await chamar(env, "/avisos/atualizar", { corpo: "" });
    confere("sem ADMIN_TOKEN configurado: endpoint desligado (403)", r.status === 403);
    confere("  e nenhuma chamada à Anthropic", chamadas.length === 0);

    env = novoAmbiente({ ADMIN_TOKEN: "token-correto-123" });
    chamadas = [];
    r = await chamar(env, "/avisos/atualizar", { corpo: "", cabecalhos: { "X-Admin-Token": "errado" } });
    confere("token errado: 401", r.status === 401);
    r = await chamar(env, "/avisos/atualizar", { corpo: "" });
    confere("sem token: 401", r.status === 401);
    confere("  e nenhuma chamada à Anthropic", chamadas.length === 0);

    r = await chamar(env, "/avisos/atualizar", { corpo: "", cabecalhos: { "X-Admin-Token": "token-correto-123" } });
    confere("token certo: 202 e atualização disparada", r.status === 202);
    confere("  busca + formatação nas 3 categorias (6 chamadas)", chamadas.length === 6, `(foram ${chamadas.length})`);
    confere("  resultado guardado no KV para as 3 categorias", ["juridico", "institucional", "normas"].every((c) => env.USO_KV.m.has(`avisos:${c}`)));
    const antes = chamadas.length;
    r = await chamar(env, "/avisos/atualizar", { corpo: "", cabecalhos: { "X-Admin-Token": "token-correto-123" } });
    confere("segunda tentativa logo em seguida: 429 (intervalo mínimo)", r.status === 429);
    confere("  sem novas chamadas à Anthropic", chamadas.length === antes);
    confere("  intervalo gravado com validade de 900 s", env.USO_KV.puts.some(([k, o]) => k === "admin:intervalo" && o?.expirationTtl === 900));
  }

  console.log("\nPedido normal e tetos");
  {
    const env = novoAmbiente();
    chamadas = [];
    let r = await chamar(env, "/", { corpo: pedidoOk() });
    confere("pedido válido: 200", r.status === 200);
    confere("  chave enviada à Anthropic no cabeçalho", chamadas[0]?.init.headers["x-api-key"] === CHAVE_SECRETA);
    confere("  chave NÃO aparece na resposta ao navegador", !r.texto.includes(CHAVE_SECRETA));
    confere("  modelo padrão usado", chamadas[0]?.corpo.model === "claude-sonnet-4-6");
    confere("  uso contado (dispositivo, IP e global)", ["uso:aparelho-de-teste-001:", "uso-ip:203.0.113.1:", "uso-global:"].every((p) => [...env.USO_KV.m.keys()].some((k) => k.startsWith(p))));

    chamadas = [];
    r = await chamar(env, "/", { corpo: pedidoOk({ maxTokens: 100000 }) });
    confere("maxTokens 100000 é reduzido ao teto de 1500", chamadas[0]?.corpo.max_tokens === 1500, `(foi ${chamadas[0]?.corpo.max_tokens})`);

    chamadas = [];
    r = await chamar(env, "/", { corpo: pedidoOk({ model: "claude-opus-caro" }) });
    confere("modelo fora da lista volta ao padrão", chamadas[0]?.corpo.model === "claude-sonnet-4-6");

    chamadas = [];
    r = await chamar(env, "/", { corpo: pedidoOk({ tools: [{ type: "bash_20250124", name: "bash" }] }) });
    confere("ferramenta não permitida: 400 sem chamar a Anthropic", r.status === 400 && chamadas.length === 0);

    chamadas = [];
    r = await chamar(env, "/", { corpo: pedidoOk({ tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 50 }] }) });
    confere("busca na web com max_uses 50 é reduzida a 2", chamadas[0]?.corpo.tools?.[0]?.max_uses === 2, `(foi ${chamadas[0]?.corpo.tools?.[0]?.max_uses})`);

    chamadas = [];
    r = await chamar(env, "/", { corpo: pedidoOk({ tools: [{ type: "web_search_20250305", name: "web_search" }, { type: "web_search_20250305", name: "web_search" }] }) });
    confere("mais de uma ferramenta: 400", r.status === 400 && chamadas.length === 0);

    chamadas = [];
    r = await chamar(env, "/", { corpo: "x".repeat(130000) });
    confere("corpo acima de 120 mil caracteres: 413", r.status === 413 && chamadas.length === 0);

    r = await chamar(env, "/", { corpo: pedidoOk({ messages: [{ role: "user", content: "a".repeat(8001) }] }) });
    confere("mensagem acima de 8000 caracteres: 413", r.status === 413);
    r = await chamar(env, "/", { corpo: pedidoOk({ system: "s".repeat(60001) }) });
    confere("prompt do sistema acima de 60 mil caracteres: 413", r.status === 413);
    r = await chamar(env, "/", { corpo: pedidoOk({ messages: Array(5).fill({ role: "user", content: "oi" }) }) });
    confere("mais de 4 mensagens: 400", r.status === 400);
    r = await chamar(env, "/", { corpo: pedidoOk({ messages: [{ role: "system", content: "oi" }] }) });
    confere("papel inválido ('system'): 400", r.status === 400);
    r = await chamar(env, "/", { corpo: pedidoOk({ messages: [{ role: "user", content: [{ type: "text", text: "oi" }] }] }) });
    confere("conteúdo em lista (não texto): 400", r.status === 400);
    r = await chamar(env, "/", { corpo: { ...pedidoOk(), deviceId: undefined } });
    confere("sem deviceId: 400", r.status === 400);
    r = await chamar(env, "/", { corpo: pedidoOk({ deviceId: "curto" }) });
    confere("deviceId curto demais: 400", r.status === 400);
    r = await chamar(env, "/", { corpo: pedidoOk({ deviceId: "../../etc/passwd-xxxxxxxx" }) });
    confere("deviceId com caracteres estranhos: 400", r.status === 400);
    r = await chamar(env, "/", { corpo: "{isso nao e json" });
    confere("JSON quebrado: 400", r.status === 400);
  }

  console.log("\nLimites diários");
  {
    let env = novoAmbiente({ LIMITE_DIARIO: "3" });
    chamadas = [];
    const res = [];
    for (let i = 0; i < 5; i++) res.push(await chamar(env, "/", { corpo: pedidoOk() }));
    confere("por dispositivo (limite 3): 3 passam e a 4ª é bloqueada", res.slice(0, 3).every((x) => x.status === 200) && res[3].status === 429);
    confere("  mensagem menciona o aparelho", /aparelho/.test(res[3].json?.error || ""));
    confere("  só 3 chamadas chegaram à Anthropic", chamadas.length === 3, `(foram ${chamadas.length})`);

    env = novoAmbiente({ LIMITE_DIARIO: "100", LIMITE_IP_DIARIO: "3" });
    chamadas = [];
    const r2 = [];
    for (let i = 0; i < 5; i++) r2.push(await chamar(env, "/", { corpo: pedidoOk({ deviceId: `aparelho-novo-${i}-abcdef` }) }));
    confere("trocar o deviceId a cada pedido NÃO burla o limite por IP", r2.slice(0, 3).every((x) => x.status === 200) && r2[3].status === 429 && r2[4].status === 429);
    confere("  mensagem menciona a rede", /rede/.test(r2[3].json?.error || ""));
    const outroIp = await chamar(env, "/", { corpo: pedidoOk({ deviceId: "aparelho-outro-ip-abcdef" }), ip: "198.51.100.7" });
    confere("  outro IP continua passando", outroIp.status === 200);

    env = novoAmbiente({ LIMITE_DIARIO: "100", LIMITE_IP_DIARIO: "100", LIMITE_GLOBAL_DIARIO: "2" });
    chamadas = [];
    const r3 = [];
    for (let i = 0; i < 4; i++) r3.push(await chamar(env, "/", { corpo: pedidoOk({ deviceId: `disp-${i}-abcdefghij` }), ip: `192.0.2.${i + 10}` }));
    confere("limite global (2): mesmo com IPs e aparelhos diferentes, a 3ª é bloqueada", r3[0].status === 200 && r3[1].status === 200 && r3[2].status === 429 && r3[3].status === 429);
    confere("  mensagem de limite do serviço", /serviço/.test(r3[2].json?.error || ""));
    confere("  só 2 chamadas chegaram à Anthropic", chamadas.length === 2, `(foram ${chamadas.length})`);
  }

  console.log("\nErros da Anthropic");
  {
    let env = novoAmbiente();
    modoFetch = "erro-api";
    let r = await chamar(env, "/", { corpo: pedidoOk() });
    confere("erro da API: 400 e o uso NÃO é contado", r.status === 400 && ![...env.USO_KV.m.keys()].some((k) => k.startsWith("uso")));
    modoFetch = "rede";
    r = await chamar(env, "/", { corpo: pedidoOk() });
    confere("falha de rede: 502", r.status === 502);
    confere("  sem detalhes internos na resposta", !r.texto.includes("ECONNRESET") && !r.texto.includes("detalhe"));
    modoFetch = "ok";
  }

  console.log("\nCORS e leitura pública");
  {
    const env = novoAmbiente();
    chamadas = [];
    let r = await chamar(env, "/avisos", { metodo: "GET" });
    confere("GET /avisos funciona e devolve as 3 categorias", r.status === 200 && ["juridico", "institucional", "normas"].every((c) => c in (r.json || {})));
    confere("  sem chamar a Anthropic", chamadas.length === 0);
    confere("  origem do app recebe permissão", r.headers.get("access-control-allow-origin") === ORIGEM_OK);

    r = await chamar(env, "/avisos", { metodo: "GET", origem: "https://site-malicioso.com" });
    confere("origem desconhecida NÃO recebe permissão CORS", r.headers.get("access-control-allow-origin") === null);
    r = await chamar(env, "/avisos", { metodo: "GET", origem: "https://meu-branch.mikeassist.pages.dev" });
    confere("prévia do Cloudflare Pages é permitida", r.headers.get("access-control-allow-origin") === "https://meu-branch.mikeassist.pages.dev");
    r = await chamar(env, "/avisos", { metodo: "GET", origem: "https://mikeassist.pages.dev.atacante.com" });
    confere("domínio que só 'parece' o do app é recusado", r.headers.get("access-control-allow-origin") === null);
    r = await chamar(env, "/", { metodo: "OPTIONS", origem: "https://site-malicioso.com" });
    confere("pré-verificação de origem ruim: 403", r.status === 403);
    r = await chamar(env, "/", { metodo: "OPTIONS" });
    confere("pré-verificação do app: 204 e cabeçalho do token liberado", r.status === 204 && /X-Admin-Token/i.test(r.headers.get("access-control-allow-headers") || ""));
    r = await chamar(env, "/", { metodo: "GET" });
    confere("GET em outro caminho: 405", r.status === 405);
  }

  {
    console.log("\nLinks das notícias");
    modoFetch = "noticias";
    const env = novoAmbiente({ ADMIN_TOKEN: "t-123456" });
    await chamar(env, "/avisos/atualizar", { corpo: "", cabecalhos: { "X-Admin-Token": "t-123456" } });
    const salvo = JSON.parse(env.USO_KV.m.get("avisos:juridico").valor ?? env.USO_KV.m.get("avisos:juridico"));
    const urls = salvo.itens.map((i) => i.url);
    confere("link com 'www.portal.' é corrigido e mantido", urls[0] === "https://portal.stf.jus.br/x", JSON.stringify(urls[0]));
    confere("link que abre é mantido", urls[1] === "https://ok.example/a");
    confere("link que não abre vira null (notícia permanece)", urls[2] === null && salvo.itens.length === 4);
    confere("link não-http (javascript:) vira null", urls[3] === null);
    modoFetch = "ok";
  }

  console.log(`\n${total - falhas}/${total} verificações passaram.`);
  if (falhas > 0) process.exit(1);
}

main().catch((e) => { console.error("ERRO NO TESTE:", e); process.exit(1); });
