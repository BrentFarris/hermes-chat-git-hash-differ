import React from 'react';
export const Button = React.forwardRef<HTMLButtonElement, any>(({ children, ...props }, ref) => <button ref={ref} type="button" {...props}>{children}</button>);
export const Input = React.forwardRef<HTMLInputElement, any>((props, ref) => <input ref={ref} {...props}/>);
export const Switch = ({ checked, onCheckedChange, ...props }: any) => <button {...props} role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)}>{checked ? 'On' : 'Off'}</button>;
export const STATUSBAR_AREAS = { right: 'statusbar.right' };
export const COMPOSER_AREAS = { underside: 'composer.underside' };
export const PALETTE_AREA = 'palette';
const PopoverContext = React.createContext<any>(null);
export function Popover({ children, open, onOpenChange }: any) { return <PopoverContext.Provider value={{ open, onOpenChange }}>{children}</PopoverContext.Provider>; }
export function PopoverTrigger({ children }: any) {
  const state = React.useContext(PopoverContext);
  return React.cloneElement(children, { onClick: () => state.onOpenChange(!state.open), 'aria-expanded': state.open });
}
export function PopoverContent({ children, side, align, collisionPadding, onCloseAutoFocus, ...props }: any) {
  const state = React.useContext(PopoverContext);
  return state.open ? <div role="dialog" {...props} onKeyDown={event => { if (event.key === 'Escape') state.onOpenChange(false); }}>{children}</div> : null;
}
export function atom(value: any) {
  const listeners = new Set<() => void>();
  return { get: () => value, set(next: any) { value = next; listeners.forEach(fn => fn()); }, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); } };
}
export const host: any = { state: {}, openWorkspace() {}, profileRoutes: async () => [], requestProfile: async () => ({}), paneVisibility: () => ({ get: () => true }) };
