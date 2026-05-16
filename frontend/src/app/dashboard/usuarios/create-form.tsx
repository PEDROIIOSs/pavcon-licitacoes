'use client';

import { useState, useTransition } from 'react';
import { createUser } from './actions';

export function CreateUserForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          await createUser(formData);
          // Em caso de sucesso, server action faz redirect com revalidatePath.
          setEmail('');
          setPassword('');
        })
      }
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
    >
      <label className="block">
        <span className="text-xs font-medium text-zinc-700">Email</span>
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="novo@pavconconstrutora.com.br"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoComplete="off"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-zinc-700">Senha inicial</span>
        <input
          type="text"
          name="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="mín. 8 caracteres"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoComplete="off"
        />
      </label>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={isPending || !email || password.length < 8}
          className="h-[38px] rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {isPending ? 'Criando…' : 'Criar usuário'}
        </button>
      </div>
    </form>
  );
}
