// service-worker.js — Mike Assist
// Guarda os arquivos do próprio app para ele abrir mesmo sem internet.
// NUNCA armazena respostas da IA nem dados do usuário: pedidos ao Worker
// (outro domínio) e qualquer POST vão sempre direto para a rede.
//
// Estratégia "rede primeiro": com internet, sempre pega a versão mais nova
// (o policial nunca fica preso numa versão antiga); sem internet, ou se a
// rede demorar mais de 4 s, usa a cópia guardada.

const CACHE_NAME = "mike-assist-v5";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./anonimizar.js",
  "./mikeassist-manifest.json",
  "./mikeassist-icon-192.png",
  "./mikeassist-icon-512.png",
  "./qr-pix.svg",
  "./vendor/react.production.min.js",
  "./vendor/react-dom.production.min.js",
];
const TEMPO_REDE_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function redeComTempo(request) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("rede lenta")), TEMPO_REDE_MS);
    fetch(request).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  // Os textos de conhecimento/ são lidos pelo Worker, não pelo app.
  if (url.pathname.startsWith("/conhecimento/")) return;

  event.respondWith(
    redeComTempo(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copia = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
