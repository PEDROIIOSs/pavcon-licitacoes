'use client';

import { useState, useTransition } from 'react';
import { updateUserPassword, deleteUser } from './actions';

export function RowActions({
  userId,
  email,
  isMe,
}: {
  userId: string;
  email: string;
  isMe: boolean;
}) {
  const [mode, setMode] = useState<'idle' | 'changePassword'>('idle');
  const [password, setPassword] = useState('');
  const [isPending, startTransition] = useTransition();

  if (mode === 'changePassword') {
    return (
      <form
        action={(formData) => {
          formData.set('userId', userId);
          startTransition(async () => {
            await updateUserPassword(formData);
            setPassword('');
            setMode('idle');
          });
        }}
        className="flex items-center justify-end gap-2"
      >
        <input
          type="text"
          name="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="nova senha (mín. 8)"
          className="w-44 rounded-md border border-zinc-300 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
          autoFocus
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={isPending || password.length < 8}
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {isPending ? 'Salvando…' : 'Salvar'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPassword('');
            setMode('idle');
          }}
          disabled={isPending}
          className="text-xs text-zinc-500 hover:text-zinc-900"
        >
          Cancelar
        </button>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={() => setMode('changePassword')}
        className="text-xs font-medium text-zinc-700 hover:underline"
      >
        Trocar senha
      </button>
      {!isMe && (
        <form
          action={(formData) => {
            if (!confirm(`Remover o usuário ${email}? Isso é permanente.`)) {
              return;
            }
            startTransition(() => deleteUser(formData));
          }}
        >
          <input type="hidden" name="userId" value={userId} />
          <button
            type="submit"
            className="text-xs font-medium text-red-700 hover:underline"
          >
            Remover
          </button>
        </form>
      )}
    </div>
  );
}
