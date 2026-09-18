import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "RESCUE Circular Logistics", description: "AI-assisted exception and circular logistics for Bremen businesses." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <header className="nav"><div className="shell nav-inner"><Link className="brand" href="/"><span className="mark" aria-hidden="true"/><span>RESCUE</span></Link><nav className="nav-links" aria-label="Primary"><Link href="/dashboard">Dashboard</Link><Link href="/request">How it works</Link><Link className="button" href="/request">Create request</Link></nav></div></header>
    {children}
    <footer className="footer"><div className="shell">RESCUE Circular Logistics · Bremen pilot · Human-approved AI recommendations</div></footer>
  </body></html>;
}
