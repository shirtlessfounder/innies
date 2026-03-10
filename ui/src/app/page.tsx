import Image from 'next/image';
import Link from 'next/link';
import { HeaderNav } from '../components/HeaderNav';
import styles from './page.module.css';

function InniesLogo() {
  return (
    <svg className={styles.wordmarkLogo} viewBox="0 0 240 90" aria-hidden="true">
      <ellipse cx="120" cy="45" rx="87" ry="30" fill="#eef2f4" stroke="none" />
      <ellipse cx="120" cy="45" rx="87" ry="30" />
      <path d="M33 45h174" />
      <path d="M120 15c-7 6-11 17-11 30s4 24 11 30" />
      <path d="M120 15c7 6 11 17 11 30s-4 24-11 30" />
      <path d="M120 15c-22 5-37 16-37 30s15 25 37 30" />
      <path d="M120 15c22 5 37 16 37 30s-15 25-37 30" />
      <path d="M120 15c-39 6-62 17-62 30s23 24 62 30" />
      <path d="M120 15c39 6 62 17 62 30s-23 24-62 30" />
      <rect x="74" y="30" width="92" height="26" rx="3" fill="#eef2f4" stroke="none" />
      <text x="120" y="53" textAnchor="middle">INNIES</text>
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className={styles.ctaIcon} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" />
      <path d="M8 6.9 11.3 10 8 13.1" fill="none" />
    </svg>
  );
}

export default function DashboardIndexPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <a href="/" className={styles.wordmark} aria-label="INNIES">
            <InniesLogo />
          </a>

          <HeaderNav />

          <div className={styles.actions}>
            <a href="https://t.me/shirtlessfounder" className={styles.accessLink}>REQUEST ACCESS</a>
          </div>
        </header>

        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <Link href="/analytics" className={styles.frame} aria-label="Open analytics">
              <Image
                className={styles.heroImage}
                src="/images/archive-computer.png"
                alt="Winter lake landscape on archival computer"
                width={2359}
                height={1778}
                priority
              />
            </Link>

            <h1 className={styles.headline}>
              <span>MORE AI CODING.</span>
              <span>NO $200 PLANS.</span>
            </h1>

            <p className={styles.subcopy}>
              <span>Get more Claude Code and Codex usage without buying</span>
              <span>new accounts. Share unused capacity and earn rebates.</span>
            </p>

            <a href="https://t.me/shirtlessfounder" className={styles.primaryCta}>
              <span>REQUEST ACCESS</span>
              <ArrowIcon />
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
