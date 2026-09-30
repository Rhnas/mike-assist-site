// service-worker.js — Mike Assist
// Só cuida do "app shell" (carregar rápido e abrir mesmo com internet ruim).
// NUNCA armazena respostas da IA nem dados do usuário — cada pedido ao
// Worker (Anthropic) e aos CDNs de terceiros vai sempre direto pra rede.

const CACHE_NAME = "mike-assist-shell-v2";
const SHELL_FILES = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Só intercepta pedidos do próprio site (mesma origem). Tudo que for pra
  // fora (CDN do React/Babel, Worker da Anthropic, fontes do Google) passa
  // direto pela rede, sem cache — são dados dinâmicos ou de terceiros.
  if (url.origin !== self.location.origin || event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
