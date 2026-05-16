'use client';

import { useState, useTransition } from 'react';
import { setNewPassword } from './actions';

export function ResetForm() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isPending, startTransition] = useTransition();
  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <form
      action={(formData) => startTransition(() => setNewPassword(formData))}
      className="mt-6 space-y-4"
    >
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">Nova senha</span>
        <input
          type="password"
          name="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoComplete="new-password"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">
          Confirme a senha
        </span>
        <input
          type="password"
          name="confirm"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoComplete="new-password"
        />
        {mismatch && (
          <span className="mt-1 block text-xs text-red-600">
            As senhas não coincidem
          </span>
        )}
      </label>
      <button
        type="submit"
        disabled={isPending || password.length < 8 || mismatch}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {isPending ? 'Salvando…' : 'Definir senha'}
      </button>
    </form>
  );
}
