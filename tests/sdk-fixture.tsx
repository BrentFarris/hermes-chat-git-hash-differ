import React from 'react';
export const Button = React.forwardRef<HTMLButtonElement, any>(({ children, ...props }, ref) => <button ref={ref} type="button" {...props}>{children}</button>);
export const Input = React.forwardRef<HTMLInputElement, any>((props, ref) => <input ref={ref} {...props}/>);
export const Switch = ({ checked, onCheckedChange, ...props }: any) => <button {...props} role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)}>{checked ? 'On' : 'Off'}</button>;
export const STATUSBAR_AREAS = { right: 'statusbar.right' };
export function atom(value: any) {
  const listeners = new Set<() => void>();
  return { get: () => value, set(next: any) { value = next; listeners.forEach(fn => fn()); }, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); } };
}
export const host: any = { state: {}, openWorkspace() {}, profileRoutes: async () => [], requestProfile: async () => ({}), paneVisibility: () => ({ get: () => true }) };
