declare module '*.css' { const css: string; export default css; }
declare module '@hermes/plugin-sdk' {
  import type { ComponentType, ReactNode } from 'react';
  export const Button: ComponentType<any>;
  export const Input: ComponentType<any>;
  export const Switch: ComponentType<any>;
  export const Popover: ComponentType<any>;
  export const PopoverTrigger: ComponentType<any>;
  export const PopoverContent: ComponentType<any>;
  export const COMPOSER_AREAS: { underside: string };
  export const PALETTE_AREA: string;
  export const STATUSBAR_AREAS: { right: string; left: string };
  export const host: {
    state: Record<string, { get(): any; subscribe(callback: (...args: any[]) => void): () => void }>;
    profileRoutes(): Promise<import('./types').Route[]>;
    requestProfile<T>(route: unknown, method: string, params?: unknown): Promise<T>;
    openWorkspace(id: string, options: { title: string; render(): ReactNode; minWidth?: string; dock?: { pane: string; pos: 'right' | 'center' }; onClose?(): void }): () => void;
    paneVisibility(id: string): { get(): boolean };
    revealPane?(id: string): void;
  };
  export interface PluginContext {
    storage: import('./types').Storage;
    register(contribution: { id: string; area: string; render?(): ReactNode; data?: unknown }): () => void;
    registerSettingsPage(page: { id: string; title: string; render(): ReactNode }): () => void;
    onDispose(fn: () => void): void;
    onEvent(type: string, fn: (event: any) => void): () => void;
    setInterval(fn: () => void, ms: number): () => void;
    setTimeout(fn: () => void, ms: number): () => void;
    addEventListener(target: EventTarget, type: string, fn: EventListener): () => void;
  }
}
