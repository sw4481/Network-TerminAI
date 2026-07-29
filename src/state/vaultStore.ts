import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  vault,
  type EnvelopeDto,
  type SecretDto,
  type SecretKind,
} from "../lib/vault";

const REVEAL_MS = 5_000;

type Store = {
  envelopes: EnvelopeDto[];
  unlockedIds: Set<string>;
  selectedEnvelopeId: string | null;
  secretsByEnvelope: Record<string, SecretDto[]>;
  /** secretId -> expiry epoch ms; while present, secret is "revealed". */
  revealedUntil: Record<string, number>;
  /** secretId -> plaintext while revealed. Cleared on expiry. */
  revealedPlaintext: Record<string, string>;
  loadEnvelopes: () => Promise<void>;
  selectEnvelope: (envelopeId: string | null) => void;
  unlock: (name: string, passphrase: string) => Promise<void>;
  lock: (envelopeId: string) => Promise<void>;
  createEnvelope: (
    name: string,
    description: string | null,
    passphrase: string,
  ) => Promise<EnvelopeDto>;
  addSecret: (
    envelopeId: string,
    kind: SecretKind,
    label: string,
    plaintext: string,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
  loadSecrets: (envelopeId: string) => Promise<void>;
  revealSecret: (secretId: string) => Promise<string>;
  rotateSecret: (secretId: string, newPlaintext: string) => Promise<void>;
  deleteSecret: (envelopeId: string, secretId: string) => Promise<void>;
  deleteEnvelope: (envelopeId: string) => Promise<void>;
  applyAutoLock: (envelopeIds: string[]) => void;
  initListeners: () => Promise<UnlistenFn>;
};

const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useVault = create<Store>((set, get) => ({
  envelopes: [],
  unlockedIds: new Set(),
  selectedEnvelopeId: null,
  secretsByEnvelope: {},
  revealedUntil: {},
  revealedPlaintext: {},

  loadEnvelopes: async () => {
    const envs = await vault.listEnvelopes();
    const unlocked = await vault.unlockedIds();
    set({ envelopes: envs, unlockedIds: new Set(unlocked) });
  },

  selectEnvelope: (envelopeId) => set({ selectedEnvelopeId: envelopeId }),

  unlock: async (name, passphrase) => {
    await vault.unlock(name, passphrase);
    const unlocked = await vault.unlockedIds();
    set({ unlockedIds: new Set(unlocked) });
  },

  lock: async (envelopeId) => {
    await vault.lock(envelopeId);
    set((s) => {
      const next = new Set(s.unlockedIds);
      next.delete(envelopeId);
      const secrets = { ...s.secretsByEnvelope };
      delete secrets[envelopeId];
      return { unlockedIds: next, secretsByEnvelope: secrets };
    });
  },

  createEnvelope: async (name, description, passphrase) => {
    const env = await vault.createEnvelope(name, description, passphrase);
    set((s) => ({ envelopes: [...s.envelopes, env] }));
    return env;
  },

  addSecret: async (envelopeId, kind, label, plaintext, metadata = {}) => {
    await vault.addSecret(envelopeId, kind, label, plaintext, metadata);
    await get().loadSecrets(envelopeId);
  },

  loadSecrets: async (envelopeId) => {
    const list = await vault.listSecrets(envelopeId);
    set((s) => ({
      secretsByEnvelope: { ...s.secretsByEnvelope, [envelopeId]: list },
    }));
  },

  revealSecret: async (secretId) => {
    const plaintext = await vault.revealSecret(secretId);
    const expiresAt = Date.now() + REVEAL_MS;
    set((s) => ({
      revealedUntil: { ...s.revealedUntil, [secretId]: expiresAt },
      revealedPlaintext: { ...s.revealedPlaintext, [secretId]: plaintext },
    }));
    const old = revealTimers.get(secretId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      set((s) => {
        const u = { ...s.revealedUntil };
        const p = { ...s.revealedPlaintext };
        delete u[secretId];
        delete p[secretId];
        return { revealedUntil: u, revealedPlaintext: p };
      });
      revealTimers.delete(secretId);
    }, REVEAL_MS);
    revealTimers.set(secretId, t);
    return plaintext;
  },

  rotateSecret: async (secretId, newPlaintext) => {
    await vault.rotateSecret(secretId, newPlaintext);
  },

  deleteSecret: async (envelopeId, secretId) => {
    await vault.deleteSecret(secretId);
    await get().loadSecrets(envelopeId);
  },

  deleteEnvelope: async (envelopeId) => {
    await vault.deleteEnvelope(envelopeId);
    set((s) => ({
      envelopes: s.envelopes.filter((e) => e.id !== envelopeId),
      selectedEnvelopeId: s.selectedEnvelopeId === envelopeId ? null : s.selectedEnvelopeId,
    }));
    const next = new Set(get().unlockedIds);
    next.delete(envelopeId);
    const secrets = { ...get().secretsByEnvelope };
    delete secrets[envelopeId];
    set({ unlockedIds: next, secretsByEnvelope: secrets });
  },

  applyAutoLock: (envelopeIds) => {
    set((s) => {
      const next = new Set(s.unlockedIds);
      const secrets = { ...s.secretsByEnvelope };
      for (const id of envelopeIds) {
        next.delete(id);
        delete secrets[id];
      }
      return { unlockedIds: next, secretsByEnvelope: secrets };
    });
  },

  initListeners: async () => {
    const unlisten = await listen<string[]>("vault://auto-locked", (e) => {
      const ids = e.payload ?? [];
      get().applyAutoLock(ids);
    });
    return unlisten;
  },
}));
