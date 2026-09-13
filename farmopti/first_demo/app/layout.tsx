import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'FarmOpti | Harvest Control',
  description: 'Replan harvest operations when conditions change. A working simulation of fields, equipment, logistics and economic decisions.',
};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
