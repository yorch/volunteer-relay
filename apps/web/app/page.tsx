import { FoundationRoot, Icon, type IconName } from "../components/foundation";
import { Brand } from "../components/layout";
import { isSignedIn } from "../lib/auth/server-session.ts";
import styles from "./home.module.css";

const features: readonly {
  icon: IconName;
  title: string;
  body: string;
}[] = [
  {
    icon: "inbox",
    title: "Updates in one inbox",
    body: "Volunteer messages and notes gather in one place, so nothing is lost between shifts.",
  },
  {
    icon: "needs",
    title: "Needs matched to care",
    body: "See which community needs are open and who is ready to help with each one.",
  },
  {
    icon: "reports",
    title: "Impact you can trust",
    body: "Approved contribution minutes add up to a clear record, and unknown stays unknown.",
  },
];

export default async function Home() {
  // Request-time only: a prerendered shell cannot know who is asking, which is
  // why a signed-in visitor used to see the signed-out buttons here.
  const signedIn = await isSignedIn();
  return (
    <FoundationRoot>
      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Brand />
            <nav aria-label="Get started" className={styles.headerNav}>
              {signedIn ? (
                <a className={styles.headerButton} href="/workspace">
                  Open workspace
                </a>
              ) : (
                <>
                  <a href="/sign-in">Sign in</a>
                  <a className={styles.headerButton} href="/sign-up">
                    Create account
                  </a>
                </>
              )}
            </nav>
          </div>
        </header>
        <main className={styles.main}>
          <section className={styles.hero}>
            <div className={styles.heroInner}>
              <div className={styles.heroCopy}>
                <span className={styles.eyebrow}>
                  FOR THE PEOPLE WHO SHOW UP
                </span>
                <h1 className={styles.title}>
                  A little clarity.
                  <br />
                  <em>More care.</em>
                </h1>
                <p className={styles.lead}>
                  Bring volunteer updates, community needs, and contributions
                  together in one thoughtful space.
                </p>
                <div className={styles.actions}>
                  <a
                    className={styles.primary}
                    href={signedIn ? "/workspace" : "/sign-in"}
                  >
                    {signedIn
                      ? "Open your workspace"
                      : "Sign in to your workspace"}{" "}
                    <span aria-hidden="true">↗</span>
                  </a>
                  {signedIn ? null : (
                    <a className={styles.secondary} href="/sign-up">
                      Create an account
                    </a>
                  )}
                </div>
              </div>
              <div className={styles.visual} aria-hidden="true">
                <div className={styles.visualTop}>
                  <span className={styles.dot} /> YOUR COMMUNITY, CONNECTED
                </div>
                <div className={styles.visualBody}>
                  <div className={styles.visualIcon}>✳</div>
                  <h2 className={styles.visualTitle}>
                    Good work grows
                    <br />
                    when it’s shared.
                  </h2>
                  <p className={styles.visualText}>
                    Every update helps your team see the whole picture.
                  </p>
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
            </div>
          </section>
          <div className={styles.features}>
            <ul className={styles.featureGrid}>
              {features.map((feature) => (
                <li key={feature.title} className={styles.featureItem}>
                  <article className={styles.feature}>
                    <span className={styles.featureIcon}>
                      <Icon name={feature.icon} size={24} />
                    </span>
                    <h2 className={styles.featureTitle}>{feature.title}</h2>
                    <p className={styles.featureText}>{feature.body}</p>
                  </article>
                </li>
              ))}
            </ul>
          </div>
        </main>
        <footer className={styles.footer}>
          <div className={styles.footerInner}>
            Volunteer Relay <span>Made for stronger communities.</span>
          </div>
        </footer>
      </div>
    </FoundationRoot>
  );
}
