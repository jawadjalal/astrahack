// Tiny external stores shared by the media hook, toasts, drop zone and lightbox (no context needed, so
// shapes rendered by tldraw can call openLightbox() directly).
import { useSyncExternalStore } from "react";
import type { Editor } from "tldraw";

function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((s: T) => T)) {
      state = typeof next === "function" ? (next as (s: T) => T)(state) : next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}

function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ---- editor handle (set by useMediaIntake) ----
let currentEditor: Editor | null = null;
export const setMediaEditor = (e: Editor | null) => {
  currentEditor = e;
};
export const getMediaEditor = () => currentEditor;

// ---- toasts ----
export type Toast = {
  id: number;
  name: string;
  phase: "preparing" | "uploading" | "placing" | "done" | "error";
  progress: number; // 0..100
  message?: string;
};
const toastStore = createStore<Toast[]>([]);
let toastSeq = 0;
export const useToasts = () => useStore(toastStore);
export const toasts = {
  add(name: string): number {
    const id = ++toastSeq;
    toastStore.set((l) => [...l, { id, name, phase: "preparing", progress: 0 }]);
    return id;
  },
  update(id: number, patch: Partial<Toast>) {
    toastStore.set((l) => l.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  },
  remove(id: number) {
    toastStore.set((l) => l.filter((t) => t.id !== id));
  },
};

// ---- drop zone ----
const dragStore = createStore(false);
export const useDragging = () => useStore(dragStore);
export const setDragging = (v: boolean) => dragStore.set(v);

// ---- lightbox ----
export type LightboxItem = {
  id: string; // tldraw shape id ("shape:xyz")
  kind: "image" | "video";
  src: string;
  label: string;
};
export type LightboxState = { items: LightboxItem[]; index: number; startAt?: number } | null;
export const lightboxStore = createStore<LightboxState>(null);
export const useLightbox = () => useStore(lightboxStore);
