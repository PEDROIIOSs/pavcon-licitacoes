'use client';

import { useState, useTransition } from 'react';
import { sendMagicLink } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        formData.set('next', next);
        startTransition(() => sendMagicLink(formData));
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
        />
      </label>
      <button
        type="submit"
        disabled={isPending || !email}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {isPending ? 'Enviando…' : 'Enviar link de acesso'}
      </button>
    </form>
  );
}
