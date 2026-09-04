import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.hero}>
        <h1 className={styles.title}>Quake 2</h1>
        <p className={styles.subtitle}>
          Unofficial WebAssembly port of the id Tech 2 engine
        </p>
        <a className={styles.launch} href="qwasm2/index.html">
          Launch game
        </a>
      </div>

      <section className={styles.controls}>
        <h2 className={styles.heading}>Keyboard controls</h2>
        <ul className={styles.list}>
          <li>
            <span className={styles.key}>WASD</span> Move
          </li>
          <li>
            <span className={styles.key}>Mouse</span> Look / fire
          </li>
          <li>
            <span className={styles.key}>Space</span> Jump
          </li>
          <li>
            <span className={styles.key}>Esc</span> Menu
          </li>
        </ul>
      </section>
    </main>
  );
}
