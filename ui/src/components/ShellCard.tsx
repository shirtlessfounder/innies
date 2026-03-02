import type { ReactNode } from 'react';

type ShellCardProps = {
  title: string;
  children: ReactNode;
};

export function ShellCard({ title, children }: ShellCardProps) {
  return (
    <section style={{ border: '1px solid #d4d4d8', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}
