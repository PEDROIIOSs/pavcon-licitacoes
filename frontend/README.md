This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy na Vercel

Variáveis obrigatórias em **Production**, **Preview** e **Development** (Project → Settings → Environment Variables):

| Variável                       | Onde pegar                                                      | Pública? |
|--------------------------------|-----------------------------------------------------------------|----------|
| NEXT_PUBLIC_SUPABASE_URL       | Supabase Dashboard → Settings → API → Project URL               | sim      |
| NEXT_PUBLIC_SUPABASE_ANON_KEY  | Supabase Dashboard → Settings → API → anon public key           | sim      |
| SUPABASE_SERVICE_ROLE_KEY      | Supabase Dashboard → Settings → API → service_role secret       | **NÃO**  |
| NEXT_PUBLIC_SITE_URL           | URL do deploy na Vercel (ex: https://pavcon.vercel.app)         | sim      |

Confira também o **Root Directory** do projeto na Vercel = `frontend` (Project → Settings → General).

Após cadastrar as envs, faça redeploy pra elas serem injetadas no runtime.

Verifique a configuração com o health check:

```
curl https://<dominio>/api/health
```

Resposta `200` com `ok: true` ⇒ todas as envs estão setadas. Resposta `500` mostra quais estão faltando, sem expor os valores.

### Sintoma comum

`500: INTERNAL_SERVER_ERROR — MIDDLEWARE_INVOCATION_FAILED`: alguma env acima está faltando em runtime na Vercel. O `proxy.ts` agora faz fail-fast com mensagem útil em `vercel logs`; cheque `/api/health` pra ver qual é.
