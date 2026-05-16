'use client';

import { useState, useTransition } from 'react';
import { signIn, requestPasswordReset } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');
  const [isPending, startTransition] = useTransition();

  if (mode === 'forgot') {
    return (
      <form
        action={(formData) =>
          startTransition(() => requestPasswordReset(formData))
        }
        className="mt-6 space-y-4"
      >
        <p className="text-sm text-zinc-600">
          Informe seu email — vamos enviar um link pra redefinir sua senha.
        </p>
        <label className="block">
          <span className="text-sm font-medium text-zinc-700">Email</span>
          <input
            type="email"
            name="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@pavconconstrutora.com.br"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            disabled={isPending}
          />
        </label>
        <button
          type="submit"
          disabled={isPending || !email}
          className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {isPending ? 'Enviando…' : 'Enviar link de redefinição'}
        </button>
        <button
          type="button"
          onClick={() => setMode('signin')}
          className="block w-full text-center text-sm text-zinc-500 hover:text-zinc-900"
          disabled={isPending}
        >
          Voltar pro login
        </button>
      </form>
    );
  }

  return (
    <form
      action={(formData) => {
        formData.set('next', next);
        startTransition(() => signIn(formData));
      }}
      className="mt-6 space-y-4"
    >
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">Email</span>
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@pavconconstrutora.com.br"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoComplete="email"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">Senha</span>
        <input
          type="password"
          name="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoComplete="current-password"
        />
      </label>
      <button
        type="submit"
        disabled={isPending || !email || !password}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {isPending ? 'Entrando…' : 'Entrar'}
      </button>
      <button
        type="button"
        onClick={() => setMode('forgot')}
        className="block w-full text-center text-sm text-zinc-500 hover:text-zinc-900"
        disabled={isPending}
      >
        Esqueci minha senha
      </button>
    </form>
  );
}
