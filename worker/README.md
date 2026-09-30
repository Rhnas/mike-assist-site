# Worker do Mike Assist (Cloudflare)

`worker.js` é o backend: proxy da IA, limites de uso e cache de notícias.
Ele **não** é publicado automaticamente pelo GitHub — o deploy é manual.

## Publicar

1. Cloudflare → Workers & Pages → `mikeassist` → **Edit code**.
2. Cole o conteúdo de `worker/worker.js` → **Deploy**.
3. **Settings → Variables and Secrets** → adicione o secret `ADMIN_TOKEN`
   (string longa e aleatória, ex.: `openssl rand -hex 24` ou gerador do gerenciador de senhas).
   Nunca coloque no chat, no código nem no repositório (é público).
4. Mantenha o que já existe: binding KV `USO_KV`, secret `ANTHROPIC_API_KEY` e os Cron Triggers.
5. No Console da Anthropic, defina um **limite de gasto mensal**.

## Variáveis opcionais

| Variável | Padrão | Função |
|---|---|---|
| `LIMITE_DIARIO` | 20 | usos de IA por aparelho/dia |
| `LIMITE_IP_DIARIO` | 60 | usos por IP/dia |
| `LIMITE_GLOBAL_DIARIO` | 500 | usos totais/dia (teto de custo) |
| `ORIGENS_PERMITIDAS` | `https://mikeassist.pages.dev` | origens CORS, separadas por vírgula |

## O que mudou

- `/avisos/atualizar` exige o header `X-Admin-Token` (no app: `?admin=1`, o botão pede o token).
- Pedidos são validados: tamanho, modelo, mensagens, única ferramenta permitida (busca web, máx. 2 usos), `max_tokens` limitado.
- Contadores por aparelho, por IP e global.
- Erros genéricos (sem detalhes internos).

## Limites conhecidos

- O Worker ainda aceita `system` vindo do app (proxy parcialmente aberto, contido pelos limites). Correção real: mover os prompts para o Worker.
- Contadores em KV não são atômicos: sob concorrência podem passar um pouco do limite.
- CORS é higiene, não segurança (clientes fora do navegador ignoram).

## Testes

```
node worker/worker.test.mjs
```
56 verificações com KV e Anthropic simulados.
