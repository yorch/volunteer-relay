import { FoundationRoot } from "../components/foundation";
import styles from "../components/product/product.module.css";

export default function Home() {
  return (
    <FoundationRoot>
      <main className={styles.standalone}>
        <h1>Volunteer Relay</h1>
        <p>
          Bring volunteer updates, community needs and contributions together.
        </p>
        <p>
          <a href="/sign-in">Sign in</a> ·{" "}
          <a href="/sign-up">Create an account</a> ·{" "}
          <a href="/workspace">Open your workspace</a>
        </p>
      </main>
    </FoundationRoot>
  );
}
