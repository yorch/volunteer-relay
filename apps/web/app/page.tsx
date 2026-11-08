import { FoundationRoot } from "../components/foundation";
import { Brand } from "../components/layout";
import styles from "./home.module.css";

export default function Home() {
  return (
    <FoundationRoot>
      <div className={styles.page}>
        <header className={styles.header}>
          <Brand />
          <nav aria-label="Get started">
            <a href="/sign-in">Sign in</a>
            <a className={styles.headerButton} href="/sign-up">
              Create account
            </a>
          </nav>
        </header>
        <main className={styles.main}>
          <div className={styles.hero}>
            <span className={styles.eyebrow}>FOR THE PEOPLE WHO SHOW UP</span>
            <h1>
              A little clarity.
              <br />
              <em>More care.</em>
            </h1>
            <p>
              Bring volunteer updates, community needs, and contributions
              together in one thoughtful space.
            </p>
            <div className={styles.actions}>
              <a className={styles.primary} href="/sign-in">
                Sign in to your workspace <span aria-hidden="true">↗</span>
              </a>
              <a className={styles.secondary} href="/sign-up">
                Create an account
              </a>
            </div>
          </div>
          <div className={styles.visual} aria-hidden="true">
            <div className={styles.visualTop}>
              <span className={styles.dot} /> YOUR COMMUNITY, CONNECTED
            </div>
            <div className={styles.visualBody}>
              <div className={styles.visualIcon}>✳</div>
              <h2>
                Good work grows
                <br />
                when it’s shared.
              </h2>
              <p>Every update helps your team see the whole picture.</p>
              <div className={styles.visualLine}>
                <span>01</span> Share an update <b>↗</b>
              </div>
              <div className={styles.visualLine}>
                <span>02</span> Coordinate care <b>↗</b>
              </div>
              <div className={styles.visualLine}>
                <span>03</span> See your impact <b>↗</b>
              </div>
            </div>
          </div>
        </main>
        <footer className={styles.footer}>
          Volunteer Relay <span>Made for stronger communities.</span>
        </footer>
      </div>
    </FoundationRoot>
  );
}
