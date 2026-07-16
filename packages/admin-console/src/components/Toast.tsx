import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ToastMsg {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

const ToastContext = createContext<{ toast: (text: string, kind?: 'info' | 'error') => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = nextId.current++;
    setItems((cur) => [...cur, { id, text, kind }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'error' ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx.toast;
}
